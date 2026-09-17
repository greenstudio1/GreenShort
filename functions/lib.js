// functions/lib.js

export const RESERVED_SLUGS = new Set([
  "favicon.ico",
  "favicon.svg",
  "robots.txt",
  "sitemap.xml",
  "gs",
  "gs-files",
  "api"
]);

export function isReservedSlug(slug) {
  if (!slug) return true;
  const first = slug.split("/")[0].toLowerCase();
  if (RESERVED_SLUGS.has(first)) return true;
  if (first.startsWith("_")) return true;
  return false;
}

export const SVG_FAVICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <rect width="100" height="100" rx="24" fill="#0c110e"/>
  <rect x="2" y="2" width="96" height="96" rx="22" fill="none" stroke="#1f2d24" stroke-width="4"/>
  <path d="M70 32H54C42 32 32 42 32 54C32 66 42 76 54 76H70" fill="none" stroke="#10b981" stroke-width="12" stroke-linecap="round"/>
  <circle cx="68" cy="54" r="7" fill="#34d399"/>
</svg>`;

const MIGRATIONS = [
  {
    version: 1,
    sql: `CREATE TABLE IF NOT EXISTS links (
      slug TEXT PRIMARY KEY,
      type TEXT DEFAULT 'direct',
      target_url TEXT,
      splat INTEGER DEFAULT 1,
      password TEXT,
      expires_at INTEGER,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`
  },
  {
    version: 2,
    sql: `CREATE TABLE IF NOT EXISTS hub_configs (
      slug TEXT PRIMARY KEY,
      mode TEXT DEFAULT 'builder',
      title TEXT,
      bio TEXT,
      theme_palette TEXT,
      btn_style TEXT,
      bg_type TEXT,
      bg_val TEXT,
      custom_html TEXT,
      lang_mode TEXT DEFAULT 'auto',
      items_json TEXT
    )`
  },
  {
    version: 3,
    sql: `ALTER TABLE links ADD COLUMN captcha INTEGER DEFAULT 0`
  },
  {
    version: 4,
    sql: `ALTER TABLE links ADD COLUMN captcha_secret TEXT`
  },
  {
    version: 5,
    sql: `ALTER TABLE links ADD COLUMN link_id TEXT`
  },
  {
    version: 6,
    sql: `ALTER TABLE links ADD COLUMN created_at_ms INTEGER`
  }
];

let dbReady = false;

export async function initDB(db) {
  if (dbReady) return;

  await db.prepare(`
    CREATE TABLE IF NOT EXISTS _migrations (
      version INTEGER PRIMARY KEY,
      applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `).run();

  const applied = await db.prepare("SELECT version FROM _migrations").all();
  const appliedVersions = new Set((applied.results || []).map(r => r.version));

  for (const m of MIGRATIONS) {
    if (!appliedVersions.has(m.version)) {
      try {
        await db.prepare(m.sql).run();
        await db.prepare("INSERT INTO _migrations (version) VALUES (?)").bind(m.version).run();
        console.log("✅ Migración " + m.version + " aplicada");
      } catch (e) {
        if (e.message && e.message.includes("duplicate column")) {
          await db.prepare("INSERT INTO _migrations (version) VALUES (?)").bind(m.version).run();
          console.log("ℹ️ Migración " + m.version + " ya existía (marcada como aplicada)");
        } else {
          console.error("❌ Error en migración " + m.version + ":", e.message);
          throw e;
        }
      }
    }
  }

  dbReady = true;
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
  if (!slug) return false;
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
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(message));
  return Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, "0")).join("");
}

export async function verifyCaptchaCookie(req, env, slug) {
  const cookieHeader = req.headers.get("Cookie") || "";
  const cookieName = "gs_captcha_" + slug.replace(/[^a-z0-9_]/gi, "_");
  const match = cookieHeader.match(new RegExp(cookieName + "=([^;]+)"));
  if (!match) return false;
  const link = await env.DB.prepare("SELECT captcha_secret FROM links WHERE slug = ?").bind(slug).first();
  if (!link || !link.captcha_secret) return false;
  const expected = await hmacSign(link.captcha_secret, "captcha_ok_" + slug);
  return match[1] === expected;
}

export async function makeCaptchaCookie(env, slug) {
  const link = await env.DB.prepare("SELECT captcha_secret FROM links WHERE slug = ?").bind(slug).first();
  if (!link || !link.captcha_secret) return null;
  const value = await hmacSign(link.captcha_secret, "captcha_ok_" + slug);
  const cookieName = "gs_captcha_" + slug.replace(/[^a-z0-9_]/gi, "_");
  return cookieName + "=" + value + "; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=86400";
}

export function recordAnalytics(ctx, env, slug, req, linkId) {
  const country = req.cf?.country || "XX";
  const ua = req.headers.get("user-agent") || "N/A";
  const referrer = req.headers.get("referer") || "—";
  const ip = req.headers.get("cf-connecting-ip") || req.headers.get("x-real-ip") || "—";

  if (env.ANALYTICS) {
    ctx.waitUntil(
      env.ANALYTICS.writeDataPoint({
        blobs: [slug, country, ua, referrer, ip, linkId || ""],
        doubles: [0],
        indexes: [slug]
      })
    );
  }
}
