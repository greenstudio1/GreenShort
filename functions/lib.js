// functions/lib.js

export const RESERVED_SLUGS = new Set([
  "favicon.ico", "favicon.svg", "robots.txt", "sitemap.xml"
]);

export function isReservedSlug(slug) {
  if (slug === null || slug === undefined) return true;
  if (slug === "") return false; // raíz del shortener = válida
  const first = slug.split("/")[0].toLowerCase();
  if (RESERVED_SLUGS.has(first)) return true;
  if (first.startsWith("_")) return true;
  return false;
}

export function folderSlug(name) {
  return String(name || "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function parseDomains(raw) {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
  } catch {}
  return {};
}

export function getAdminHost(domains) {
  for (const host in domains) {
    if (domains[host] === "admin") return host;
  }
  return null;
}

export function getFirstShortenerHost(domains) {
  for (const host in domains) {
    if (domains[host] === "shortener") return host;
  }
  return null;
}

export function listShortenerHosts(domains) {
  const out = [];
  for (const host in domains) {
    if (domains[host] === "shortener") out.push(host);
  }
  return out;
}

export const SVG_FAVICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <rect width="100" height="100" rx="24" fill="#0c110e"/>
  <rect x="2" y="2" width="96" height="96" rx="22" fill="none" stroke="#1f2d24" stroke-width="4"/>
  <path d="M70 32H54C42 32 32 42 32 54C32 66 42 76 54 76H70" fill="none" stroke="#10b981" stroke-width="12" stroke-linecap="round"/>
  <circle cx="68" cy="54" r="7" fill="#34d399"/>
</svg>`;

const MIGRATIONS = [
  { version: 1, sql: `CREATE TABLE IF NOT EXISTS links (slug TEXT PRIMARY KEY, type TEXT DEFAULT 'direct', target_url TEXT, splat INTEGER DEFAULT 1, password TEXT, expires_at INTEGER, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)` },
  { version: 2, sql: `CREATE TABLE IF NOT EXISTS hub_configs (slug TEXT PRIMARY KEY, mode TEXT DEFAULT 'builder', title TEXT, bio TEXT, theme_palette TEXT, btn_style TEXT, bg_type TEXT, bg_val TEXT, custom_html TEXT, lang_mode TEXT DEFAULT 'auto', items_json TEXT)` },
  { version: 3, sql: `ALTER TABLE links ADD COLUMN captcha INTEGER DEFAULT 0` },
  { version: 4, sql: `ALTER TABLE links ADD COLUMN captcha_secret TEXT` },
  { version: 5, sql: `ALTER TABLE links ADD COLUMN link_id TEXT` },
  { version: 6, sql: `ALTER TABLE links ADD COLUMN created_at_ms INTEGER` },
  { version: 7, sql: `ALTER TABLE hub_configs ADD COLUMN avatar_url TEXT` },
  { version: 8, sql: `ALTER TABLE links ADD COLUMN folder_id TEXT` },
  { version: 9, sql: `CREATE TABLE IF NOT EXISTS folders (id TEXT PRIMARY KEY, name TEXT NOT NULL, parent_id TEXT, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)` }
];

let dbReady = false;

export async function initDB(db, env) {
  await db.prepare(`CREATE TABLE IF NOT EXISTS _migrations (version INTEGER PRIMARY KEY, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`).run();
  const applied = await db.prepare("SELECT version FROM _migrations").all();
  const appliedVersions = new Set((applied.results || []).map(r => r.version));

  if (!dbReady) {
    for (const m of MIGRATIONS) {
      if (!appliedVersions.has(m.version)) {
        try {
          await db.prepare(m.sql).run();
          await db.prepare("INSERT INTO _migrations (version) VALUES (?)").bind(m.version).run();
          console.log("✅ Migración " + m.version + " aplicada");
        } catch (e) {
          if (e.message && e.message.includes("duplicate column")) {
            await db.prepare("INSERT INTO _migrations (version) VALUES (?)").bind(m.version).run();
          } else {
            console.error("❌ Error en migración " + m.version + ":", e.message);
            throw e;
          }
        }
      }
    }
    dbReady = true;
  }

  if (!appliedVersions.has(10)) {
    const linksInfo = await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='links'").first();
    if (linksInfo) {
      const cols = await db.prepare("PRAGMA table_info(links)").all();
      const hasDomain = (cols.results || []).some(c => c.name === "domain");
      if (!hasDomain) {
        const domains = parseDomains(env.DOMAINS);
        const firstShortener = getFirstShortenerHost(domains);
        const domainValue = firstShortener || null;

        await db.prepare(`CREATE TABLE links_new (
          domain TEXT NOT NULL DEFAULT '',
          slug TEXT NOT NULL,
          type TEXT DEFAULT 'direct',
          target_url TEXT,
          splat INTEGER DEFAULT 1,
          password TEXT,
          expires_at INTEGER,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          captcha INTEGER DEFAULT 0,
          captcha_secret TEXT,
          link_id TEXT,
          created_at_ms INTEGER,
          folder_id TEXT,
          PRIMARY KEY (domain, slug)
        )`).run();

        if (domainValue) {
          await db.prepare(`INSERT INTO links_new (domain, slug, type, target_url, splat, password, expires_at, created_at, captcha, captcha_secret, link_id, created_at_ms, folder_id)
            SELECT ?, slug, type, target_url, splat, password, expires_at, created_at, captcha, captcha_secret, link_id, created_at_ms, folder_id FROM links`).bind(domainValue).run();
        } else {
          await db.prepare(`INSERT INTO links_new (domain, slug, type, target_url, splat, password, expires_at, created_at, captcha, captcha_secret, link_id, created_at_ms, folder_id)
            SELECT '', slug, type, target_url, splat, password, expires_at, created_at, captcha, captcha_secret, link_id, created_at_ms, folder_id FROM links`).run();
        }

        await db.prepare("DROP TABLE links").run();
        await db.prepare("ALTER TABLE links_new RENAME TO links").run();
        console.log("✅ Migración 10 (links) aplicada → " + (domainValue || "legacy"));

        const hubCols = await db.prepare("PRAGMA table_info(hub_configs)").all();
        const hubHasDomain = (hubCols.results || []).some(c => c.name === "domain");
        if (!hubHasDomain) {
          await db.prepare(`CREATE TABLE hub_configs_new (
            domain TEXT NOT NULL DEFAULT '',
            slug TEXT NOT NULL,
            mode TEXT DEFAULT 'builder',
            title TEXT,
            bio TEXT,
            theme_palette TEXT,
            btn_style TEXT,
            bg_type TEXT,
            bg_val TEXT,
            custom_html TEXT,
            lang_mode TEXT DEFAULT 'auto',
            items_json TEXT,
            avatar_url TEXT,
            PRIMARY KEY (domain, slug)
          )`).run();

          if (domainValue) {
            await db.prepare(`INSERT INTO hub_configs_new (domain, slug, mode, title, bio, theme_palette, btn_style, bg_type, bg_val, custom_html, lang_mode, items_json, avatar_url)
              SELECT ?, slug, mode, title, bio, theme_palette, btn_style, bg_type, bg_val, custom_html, lang_mode, items_json, avatar_url FROM hub_configs`).bind(domainValue).run();
          } else {
            await db.prepare(`INSERT INTO hub_configs_new (domain, slug, mode, title, bio, theme_palette, btn_style, bg_type, bg_val, custom_html, lang_mode, items_json, avatar_url)
              SELECT '', slug, mode, title, bio, theme_palette, btn_style, bg_type, bg_val, custom_html, lang_mode, items_json, avatar_url FROM hub_configs`).run();
          }

          await db.prepare("DROP TABLE hub_configs").run();
          await db.prepare("ALTER TABLE hub_configs_new RENAME TO hub_configs").run();
          console.log("✅ Migración 10 (hub_configs) aplicada");
        }

        await db.prepare("INSERT INTO _migrations (version) VALUES (10)").run();
      }
    }
  }
}

export function authCheck(req, env) {
  if (!env.SITE_TOKEN || env.SITE_TOKEN.trim() === "") return false;
  const authHeader = req.headers.get("Authorization");
  if (!authHeader || !authHeader.startsWith("Bearer ")) return false;
  const token = authHeader.replace("Bearer ", "").trim();
  if (!token) return false;
  return token === env.SITE_TOKEN;
}

export function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}

export function genRandomSlug(len = 6, mode = "alphanumeric") {
  let chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  if (mode === "alpha") chars = "abcdefghijklmnopqrstuvwxyz";
  if (mode === "numeric") chars = "0123456789";
  let res = "";
  for (let i = 0; i < len; i++) res += chars.charAt(Math.floor(Math.random() * chars.length));
  return res;
}

export function genLinkId() {
  return crypto.randomUUID().replace(/-/g, "") + genRandomSlug(8);
}

export function validateSlugFormat(slug) {
  if (slug === null || slug === undefined) return false;
  if (slug === "") return true; // raíz del shortener
  if (!/^[a-z0-9_\/-]+$/.test(slug.replace(/\./g, ""))) return false;
  if (slug.startsWith("/") || slug.endsWith("/")) return false;
  if (slug.includes("//")) return false;
  if (slug.split("/").some(s => s.length === 0)) return false;
  if (slug.startsWith(".") || slug.endsWith(".")) return false;
  if (slug.includes("..")) return false;
  if (slug.split("/").some(s => s.startsWith(".") || s.endsWith("."))) return false;
  return true;
}

export function genCaptchaText(len = 5) {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let res = "";
  for (let i = 0; i < len; i++) res += chars.charAt(Math.floor(Math.random() * chars.length));
  return res;
}

export async function hmacSign(secret, message) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(message));
  return Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, "0")).join("");
}

export async function verifyCaptchaCookie(req, env, domain, slug) {
  const cookieHeader = req.headers.get("Cookie") || "";
  const cookieName = "gs_captcha_" + domain.replace(/[^a-z0-9_]/gi, "_") + "_" + slug.replace(/[^a-z0-9_]/gi, "_");
  const match = cookieHeader.match(new RegExp(cookieName + "=([^;]+)"));
  if (!match) return false;
  const link = await env.DB.prepare("SELECT captcha_secret FROM links WHERE domain = ? AND slug = ?").bind(domain, slug).first();
  if (!link || !link.captcha_secret) return false;
  const expected = await hmacSign(link.captcha_secret, "captcha_ok_" + domain + "_" + slug);
  return match[1] === expected;
}

export async function makeCaptchaCookie(env, domain, slug) {
  const link = await env.DB.prepare("SELECT captcha_secret FROM links WHERE domain = ? AND slug = ?").bind(domain, slug).first();
  if (!link || !link.captcha_secret) return null;
  const value = await hmacSign(link.captcha_secret, "captcha_ok_" + domain + "_" + slug);
  const cookieName = "gs_captcha_" + domain.replace(/[^a-z0-9_]/gi, "_") + "_" + slug.replace(/[^a-z0-9_]/gi, "_");
  return cookieName + "=" + value + "; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=86400";
}

export function recordAnalytics(ctx, env, domain, slug, req, linkId) {
  const country = req.cf?.country || "XX";
  const ua = req.headers.get("user-agent") || "N/A";
  const referrer = req.headers.get("referer") || "—";
  const ip = req.headers.get("cf-connecting-ip") || req.headers.get("x-real-ip") || "—";
  if (env.ANALYTICS) {
    ctx.waitUntil(env.ANALYTICS.writeDataPoint({
      blobs: [slug, country, ua, referrer, ip, linkId || "", domain],
      doubles: [0],
      indexes: [slug]
    }));
  }
}
