// functions/[[path]].js

import { RESERVED_SLUGS, isReservedSlug, SVG_FAVICON, initDB, authCheck, json, genRandomSlug, genLinkId, validateSlugFormat, genCaptchaText, hmacSign, verifyCaptchaCookie, makeCaptchaCookie, recordAnalytics } from './lib.js';

export async function onRequest(context) {
  try {
    const { request, env, next } = context;
    const url = new URL(request.url);
    const segments = url.pathname.split("/").filter(Boolean);
    const prefix = segments[0]?.toLowerCase() || "";

    const MAX_SLUG_LENGTH = parseInt(env.MAX_SLUG_LENGTH) || 20;
    const MAX_EXPIRATION_DAYS = parseInt(env.MAX_EXPIRATION_DAYS) || 365;
    const MAX_EXPIRATION_MS = MAX_EXPIRATION_DAYS * 24 * 60 * 60 * 1000;

    if (url.pathname === "/favicon.svg" || url.pathname === "/favicon.ico") {
      return new Response(SVG_FAVICON, { headers: { "Content-Type": "image/svg+xml" } });
    }

    if (prefix === "gs") return next();
    if (prefix === "gs-files") return next();

    if (prefix === "api") {
      await initDB(env.DB);
      const action = segments[1];

      if (action === "captcha-challenge" && request.method === "GET") {
        const slug = url.searchParams.get("slug");
        if (!slug) return json({ error: "Falta slug" }, 400);
        const link = await env.DB.prepare("SELECT captcha, captcha_secret FROM links WHERE slug = ?").bind(slug).first();
        if (!link || !link.captcha || !link.captcha_secret) return json({ error: "Captcha no configurado" }, 404);

        const text = genCaptchaText(5);
        const sig = await hmacSign(link.captcha_secret, "challenge_" + slug + "_" + text);
        const payload = btoa(slug + "|" + text);
        const challengeId = sig + "." + payload;

        const w = 200;
        const h = 70;
        const charWidth = (w - 20) / (text.length + 1);
        const layout = [];
        for (let i = 0; i < text.length; i++) {
          layout.push({
            char: text[i],
            x: 10 + charWidth * (i + 0.8) + (Math.random() - 0.5) * 14,
            y: h / 2 + (Math.random() - 0.5) * 16,
            rotate: (Math.random() - 0.5) * 1.2,
            scaleX: 0.85 + Math.random() * 0.5,
            scaleY: 0.85 + Math.random() * 0.5,
            fontSize: 24 + Math.random() * 14,
            hue: 150 + Math.random() * 40,
            light: 50 + Math.random() * 25,
            shadowX: (Math.random() - 0.5) * 4,
            shadowY: (Math.random() - 0.5) * 4
          });
        }

        const points = [];
        for (let i = 0; i < 120; i++) {
          points.push({ x: Math.random() * w, y: Math.random() * h, r: Math.random() * 2, alpha: 0.1 + Math.random() * 0.5 });
        }
        const lines = [];
        for (let i = 0; i < 4; i++) {
          lines.push({
            x1: Math.random() * w, y1: Math.random() * h,
            cx1: Math.random() * w, cy1: Math.random() * h,
            cx2: Math.random() * w, cy2: Math.random() * h,
            x2: Math.random() * w, y2: Math.random() * h,
            alpha: 0.25 + Math.random() * 0.3,
            width: 1 + Math.random() * 2
          });
        }
        const blobs = [];
        for (let i = 0; i < 5; i++) {
          blobs.push({ x: Math.random() * w, y: Math.random() * h, r: 10 + Math.random() * 20, alpha: 0.05 + Math.random() * 0.1 });
        }
        const shortLines = [];
        for (let i = 0; i < 40; i++) {
          const x1 = Math.random() * w;
          const y1 = Math.random() * h;
          shortLines.push({ x1, y1, x2: x1 + (Math.random() - 0.5) * 20, y2: y1 + (Math.random() - 0.5) * 20, alpha: 0.15 + Math.random() * 0.4 });
        }

        return json({
          challengeId,
          width: w,
          height: h,
          layout,
          noise: { points, lines, blobs, shortLines }
        });
      }

      if (!authCheck(request, env)) return json({ error: "Unauthorized" }, 401);

      if (action === "config" && request.method === "GET") {
        return json({
          maxSlugLength: MAX_SLUG_LENGTH,
          maxExpirationDays: MAX_EXPIRATION_DAYS,
          reservedSlugs: Array.from(RESERVED_SLUGS)
        });
      }

      if (action === "storage" && request.method === "GET") {
        if (!env.CF_ACCOUNT_ID || !env.CF_D1_ID || !env.CF_API_TOKEN) {
          return json({ error: "Variables CF_ACCOUNT_ID, CF_D1_ID y CF_API_TOKEN requeridas" }, 400);
        }
        try {
          const cfRes = await fetch(
            `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/d1/database/${env.CF_D1_ID}`,
            { headers: { "Authorization": `Bearer ${env.CF_API_TOKEN}`, "Content-Type": "application/json" } }
          );
          const cfData = await cfRes.json();
          if (!cfRes.ok || !cfData.success) return json({ error: cfData.errors?.[0]?.message || "Error" }, 500);
          const sizeBytes = cfData.result?.file_size || 0;
          const usedMB = (sizeBytes / (1024 * 1024)).toFixed(2);
          const freeMB = Math.max(0, 5120 - parseFloat(usedMB)).toFixed(2);
          return json({ usedMB, freeMB, totalMB: 5120 });
        } catch {
          return json({ error: "Fallo de conexión" }, 500);
        }
      }

      if (action === "links" && request.method === "GET") {
        const { results } = await env.DB.prepare(
          "SELECT slug, type, target_url, splat, password, captcha, expires_at, created_at, link_id, created_at_ms FROM links ORDER BY created_at DESC"
        ).all();

        let clicksMap = {};
        if (env.ANALYTICS && env.CF_ACCOUNT_ID && env.CF_API_TOKEN) {
          try {
            const linkBySlug = {};
            for (const l of results) linkBySlug[l.slug] = l;

            const query = `SELECT blob1 AS slug, blob6 AS link_id, timestamp FROM greenshort ORDER BY timestamp DESC LIMIT 10000`;
            const aeRes = await fetch(
              `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/analytics_engine/sql`,
              { method: "POST", headers: { "Authorization": `Bearer ${env.CF_API_TOKEN}` }, body: query }
            );
            const aeData = await aeRes.json();
            if (aeRes.ok && aeData.data) {
              for (const row of aeData.data) {
                const link = linkBySlug[row.slug];
                if (!link) continue;
                if (link.link_id && row.link_id && row.link_id !== link.link_id) continue;
                if (link.created_at_ms) {
                  const eventTs = new Date(row.timestamp).getTime();
                  if (!isNaN(eventTs) && eventTs < link.created_at_ms) continue;
                }
                const key = link.link_id || row.slug;
                clicksMap[key] = (clicksMap[key] || 0) + 1;
              }
            }
          } catch (e) {
            console.error("Error obteniendo clics:", e);
          }
        }

        const enriched = results.map(l => ({
          ...l,
          clicks: clicksMap[l.link_id] || clicksMap[l.slug] || 0
        }));
        return json(enriched);
      }

      if (action === "hub-config" && request.method === "GET") {
        const hubSlug = url.searchParams.get("slug");
        const config = await env.DB.prepare(`
          SELECT h.slug, h.mode, h.title, h.bio, h.theme_palette, h.btn_style,
                 h.bg_type, h.bg_val, h.custom_html, h.lang_mode, h.items_json,
                 l.password, l.captcha
          FROM hub_configs h
          LEFT JOIN links l ON l.slug = h.slug
          WHERE h.slug = ?
        `).bind(hubSlug).first();
        return json(config || {});
      }

      if (action === "ai-slug" && request.method === "POST") {
        const { targetUrl, desiredLength } = await request.json();
        if (!targetUrl) return json({ error: "Falta URL" }, 400);
        if (!env.AI) return json({ error: "Binding 'AI' no encontrado" }, 400);

        const slugLength = Math.max(3, Math.min(parseInt(desiredLength) || 6, MAX_SLUG_LENGTH));
        const minLen = Math.max(3, slugLength - 2);

        let contextText = "";
        try {
          const targetObj = new URL(targetUrl);
          contextText = `Domain: ${targetObj.hostname} Path: ${targetObj.pathname.replace(/[\/-]/g, " ")}`;
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), 3000);
          const res = await fetch(targetUrl, {
            headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/122.0.0.0 Safari/537.36" },
            signal: controller.signal
          });
          clearTimeout(timeoutId);
          if (res.ok) {
            const html = await res.text();
            const title = html.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1] || "";
            const desc = html.match(/<meta[^>]*name=["']description["'][^>]*content=["']([^"']*)["']/i)?.[1] || "";
            if (title || desc) contextText = `Title: ${title}. Description: ${desc}`;
          }
        } catch {}

        const model = env.AI_MODEL || "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
        const messages = [
          {
            role: "system",
            content: `You are a URL slug generator. Given content, output ONE slug.\n\nSTRICT RULES:\n- Do NOT repeat or echo the input\n- Do NOT include the domain name in the slug\n- Output ONLY lowercase ASCII letters (a-z), numbers (0-9) and underscores (_)\n- Length between ${minLen} and ${slugLength} characters\n- No spaces, no accents, no special characters, no quotes, no punctuation\n- If the content is about a well-known brand or topic, use its common English name\n- Respond ONLY with the slug, nothing else. No explanations, no greetings, no markdown.\n\nExample:\nInput: "Title: GitHub - Build software better, together"\nOutput: github`
          },
          { role: "user", content: contextText.slice(0, 400) || targetUrl }
        ];

        let aiRes;
        try {
          aiRes = await env.AI.run(model, { messages });
        } catch (err) {
          const fallback = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
          if (model !== fallback) {
            try {
              aiRes = await env.AI.run(fallback, { messages });
            } catch (e2) {
              return json({ error: "Error en Workers AI: " + (e2.message || "Fallo interno") }, 500);
            }
          } else {
            return json({ error: "Error en Workers AI: " + (err.message || "Fallo interno") }, 500);
          }
        }

        let cleanSlug = (aiRes.response || "")
          .trim()
          .toLowerCase()
          .replace(/["'`\n\r]/g, "")
          .replace(/[^a-z0-9_]/g, "_")
          .replace(/_+/g, "_")
          .replace(/^_+|_+$/g, "");

        try {
          const hostname = new URL(targetUrl).hostname.replace(/^www\./, "").split(".")[0];
          if (hostname.length > 3 && cleanSlug.includes(hostname)) {
            cleanSlug = cleanSlug.replace(new RegExp(hostname, "g"), "").replace(/_+/g, "_").replace(/^_+|_+$/g, "");
          }
        } catch {}

        if (!cleanSlug || cleanSlug.length < 3) cleanSlug = genRandomSlug(slugLength, "alphanumeric");

        if (cleanSlug.length > slugLength) {
          cleanSlug = cleanSlug.slice(0, slugLength).replace(/_+$/g, "");
        }
        if (cleanSlug.length < slugLength) {
          cleanSlug = cleanSlug + genRandomSlug(slugLength - cleanSlug.length, "alphanumeric");
        }

        return json({ slug: cleanSlug.slice(0, MAX_SLUG_LENGTH) });
      }

      if (action === "create" && request.method === "POST") {
        const body = await request.json();
        let { slug, targetUrl, splat, length, mode, password, captcha, expAmount, expUnit } = body;
        if (!slug) slug = genRandomSlug(parseInt(length) || 6, mode || "alphanumeric");
        slug = slug.trim().toLowerCase().replace(/^\/+|\/+$/g, "").replace(/\/+/g, "/");
        if (slug.length > MAX_SLUG_LENGTH) return json({ error: `Slug máximo ${MAX_SLUG_LENGTH} caracteres` }, 400);
        if (!validateSlugFormat(slug)) return json({ error: "Slug inválido" }, 400);
        if (isReservedSlug(slug)) return json({ error: "Ruta reservada" }, 400);
        if (!targetUrl) return json({ error: "Falta la URL de destino" }, 400);
        try { new URL(targetUrl); } catch { return json({ error: "URL inválida" }, 400); }

        const existing = await env.DB.prepare(
          "SELECT target_url, link_id, created_at_ms FROM links WHERE slug = ?"
        ).bind(slug).first();

        const targetChanged = !existing || existing.target_url !== targetUrl;
        const now = Date.now();
        const finalLinkId = targetChanged ? genLinkId() : (existing.link_id || genLinkId());
        const finalCreatedAtMs = targetChanged ? now : (existing.created_at_ms || now);

        let expiresAtTimestamp = null;
        if (expUnit !== 'never' && expAmount && parseInt(expAmount) > 0) {
          const mult = { minutes: 60000, hours: 3600000, days: 86400000 };
          const requestedMs = parseInt(expAmount) * (mult[expUnit] || 60000);
          expiresAtTimestamp = Date.now() + Math.min(requestedMs, MAX_EXPIRATION_MS);
        }

        const captchaFlag = captcha ? 1 : 0;
        let captchaSecret = null;
        if (captchaFlag) {
          captchaSecret = crypto.randomUUID().replace(/-/g, "") + genRandomSlug(16);
        }

        await env.DB.prepare(`
          INSERT INTO links (slug, type, target_url, splat, password, captcha, captcha_secret, expires_at, link_id, created_at_ms)
          VALUES (?, 'direct', ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(slug) DO UPDATE SET
            type='direct',
            target_url=excluded.target_url,
            splat=excluded.splat,
            password=excluded.password,
            captcha=excluded.captcha,
            captcha_secret=CASE WHEN excluded.captcha = 1 AND excluded.captcha_secret IS NOT NULL THEN excluded.captcha_secret ELSE links.captcha_secret END,
            expires_at=CASE WHEN excluded.expires_at IS NOT NULL THEN excluded.expires_at ELSE links.expires_at END,
            link_id=excluded.link_id,
            created_at_ms=excluded.created_at_ms
        `).bind(slug, targetUrl, splat ? 1 : 0, password?.trim() || null, captchaFlag, captchaSecret, expiresAtTimestamp, finalLinkId, finalCreatedAtMs).run();

        return json({ success: true, slug, link_id: finalLinkId });
      }

      if (action === "save-hub" && request.method === "POST") {
        const body = await request.json();
        let { slug, mode, title, bio, theme_palette, btn_style, bg_type, bg_val, custom_html, lang_mode, items, password, captcha } = body;
        slug = (slug || "").trim().toLowerCase().replace(/^\/+|\/+$/g, "").replace(/\/+/g, "/");
        if (!slug) return json({ error: "Slug requerido" }, 400);
        if (slug.length > MAX_SLUG_LENGTH) return json({ error: `Slug máximo ${MAX_SLUG_LENGTH} caracteres` }, 400);
        if (!validateSlugFormat(slug)) return json({ error: "Slug inválido" }, 400);
        if (isReservedSlug(slug)) return json({ error: "Ruta reservada" }, 400);

        const existing = await env.DB.prepare(
          "SELECT link_id, created_at_ms FROM links WHERE slug = ?"
        ).bind(slug).first();

        const now = Date.now();
        const finalLinkId = existing && existing.link_id ? existing.link_id : genLinkId();
        const finalCreatedAtMs = existing && existing.created_at_ms ? existing.created_at_ms : now;

        const captchaFlag = captcha ? 1 : 0;
        let captchaSecret = null;
        if (captchaFlag) {
          captchaSecret = crypto.randomUUID().replace(/-/g, "") + genRandomSlug(16);
        }

        await env.DB.batch([
          env.DB.prepare(`
            INSERT INTO links (slug, type, target_url, splat, password, captcha, captcha_secret, link_id, created_at_ms)
            VALUES (?, 'group', '', 0, ?, ?, ?, ?, ?)
            ON CONFLICT(slug) DO UPDATE SET
              type='group',
              password=excluded.password,
              captcha=excluded.captcha,
              captcha_secret=CASE WHEN excluded.captcha = 1 AND excluded.captcha_secret IS NOT NULL THEN excluded.captcha_secret ELSE links.captcha_secret END,
              link_id=excluded.link_id,
              created_at_ms=excluded.created_at_ms
          `).bind(slug, password?.trim() || null, captchaFlag, captchaSecret, finalLinkId, finalCreatedAtMs),
          env.DB.prepare(`INSERT INTO hub_configs (slug, mode, title, bio, theme_palette, btn_style, bg_type, bg_val, custom_html, lang_mode, items_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(slug) DO UPDATE SET mode=excluded.mode, title=excluded.title, bio=excluded.bio, theme_palette=excluded.theme_palette, btn_style=excluded.btn_style, bg_type=excluded.bg_type, bg_val=excluded.bg_val, custom_html=excluded.custom_html, lang_mode=excluded.lang_mode, items_json=excluded.items_json`).bind(
            slug, mode || "builder", title || slug, bio || "", theme_palette || "emerald",
            btn_style || "rounded", bg_type || "palette", bg_val || "",
            custom_html || "", lang_mode || "auto", JSON.stringify(items || [])
          )
        ]);
        return json({ success: true, slug, link_id: finalLinkId });
      }

      if (action === "delete" && request.method === "POST") {
        const body = await request.json();
        const slugs = Array.isArray(body.slugs) ? body.slugs : (body.slug ? [body.slug] : []);
        if (slugs.length === 0) return json({ error: "No hay slugs" }, 400);
        const statements = [];
        for (const slug of slugs) {
          statements.push(env.DB.prepare("DELETE FROM links WHERE slug = ?").bind(slug));
          statements.push(env.DB.prepare("DELETE FROM hub_configs WHERE slug = ?").bind(slug));
        }
        await env.DB.batch(statements);
        return json({ success: true, count: slugs.length });
      }

      if (action === "analytics" && request.method === "GET") {
        if (!env.ANALYTICS) return json({ error: "Analytics Engine binding 'ANALYTICS' no configurado" }, 400);
        if (!env.CF_ACCOUNT_ID || !env.CF_API_TOKEN) return json({ error: "Variables CF_ACCOUNT_ID y CF_API_TOKEN requeridas" }, 400);
        try {
          const { results: currentLinks } = await env.DB.prepare("SELECT slug, link_id, created_at_ms FROM links").all();
          const linkBySlug = {};
          for (const l of currentLinks) linkBySlug[l.slug] = l;

          const query = `SELECT blob1 AS slug, blob2 AS country, blob3 AS user_agent, blob4 AS referrer, blob5 AS ip, blob6 AS link_id, timestamp FROM greenshort ORDER BY timestamp DESC LIMIT 1000`;
          const aeRes = await fetch(
            `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/analytics_engine/sql`,
            { method: "POST", headers: { "Authorization": `Bearer ${env.CF_API_TOKEN}` }, body: query }
          );
          const aeData = await aeRes.json();
          if (!aeRes.ok) return json({ error: aeData.errors?.[0]?.message || "Error" }, 500);
          const rows = (aeData.data || [])
            .filter(r => {
              const link = linkBySlug[r.slug];
              if (!link) return false;
              if (link.link_id && r.link_id && r.link_id !== link.link_id) return false;
              if (link.created_at_ms) {
                const eventTs = new Date(r.timestamp).getTime();
                if (!isNaN(eventTs) && eventTs < link.created_at_ms) return false;
              }
              return true;
            })
            .slice(0, 150)
            .map(r => ({
              slug: r.slug, country: r.country, user_agent: r.user_agent, referrer: r.referrer, ip: r.ip, created_at: r.timestamp
            }));
          return json(rows);
        } catch (e) {
          return json({ error: "Fallo: " + (e.message || "Error") }, 500);
        }
      }

      return json({ error: "Not found" }, 404);
    }

    if (!prefix) return Response.redirect(`${url.origin}/gs/dashboard`, 302);

    await initDB(env.DB);

    let link = null;
    let matchedSlug = "";
    let remainingSegments = [];

    for (let i = segments.length; i >= 1; i--) {
      const candidateSlug = segments.slice(0, i).join("/").toLowerCase();
      const found = await env.DB.prepare("SELECT * FROM links WHERE slug = ?").bind(candidateSlug).first();
      if (found) {
        link = found;
        matchedSlug = candidateSlug;
        remainingSegments = segments.slice(i);
        break;
      }
    }

    if (!link) return new Response("Enlace no encontrado", { status: 404 });

    if (link.expires_at && Date.now() > Number(link.expires_at)) {
      return new Response("Este enlace ha expirado.", { status: 410 });
    }

    if (link.password) {
      let userPass = "";
      if (request.method === "POST") {
        const contentType = request.headers.get("Content-Type") || "";
        if (contentType.includes("application/x-www-form-urlencoded") || contentType.includes("multipart/form-data")) {
          const formData = await request.formData();
          userPass = formData.get("password") || "";
        }
      } else {
        userPass = url.searchParams.get("pwd") || "";
      }
      if (userPass !== link.password) {
        const htmlRes = await fetch(new URL("/gs/password.html", url.origin));
        let html = await htmlRes.text();
        html = html.replace(/{{slug}}/g, matchedSlug);
        html = html.replace(/{{hasError}}/g, userPass ? 'true' : 'false');
        html = html.replace(/{{[a-z_]+}}/gi, '');
        return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
      }
    }

    if (link.captcha && link.captcha_secret) {
      const isOk = await verifyCaptchaCookie(request, env, matchedSlug);
      if (!isOk) {
        let userAnswer = "";
        let challengeId = "";
        if (request.method === "POST") {
          const contentType = request.headers.get("Content-Type") || "";
          if (contentType.includes("application/json")) {
            const body = await request.json();
            userAnswer = body.answer || "";
            challengeId = body.challengeId || "";
          } else if (contentType.includes("application/x-www-form-urlencoded") || contentType.includes("multipart/form-data")) {
            const formData = await request.formData();
            userAnswer = formData.get("captcha_answer") || "";
            challengeId = formData.get("captcha_id") || "";
          }
        }

        if (userAnswer && challengeId) {
          const parts = challengeId.split(".");
          if (parts.length === 2) {
            const [expectedSig, _] = parts;
            let decoded = "";
            try { decoded = atob(parts[1]); } catch {}
            const [chalSlug, text] = decoded.split("|");
            const expected = await hmacSign(link.captcha_secret, "challenge_" + chalSlug + "_" + text);
            if (expected === expectedSig && chalSlug === matchedSlug && userAnswer.trim().toUpperCase() === text.toUpperCase()) {
              const cookie = await makeCaptchaCookie(env, matchedSlug);
              const headers = {
                "Location": request.url,
                "Content-Type": "text/html; charset=utf-8"
              };
              if (cookie) headers["Set-Cookie"] = cookie;
              return new Response("", { status: 302, headers });
            }
          }
        }

        const htmlRes = await fetch(new URL("/gs/captcha.html", url.origin));
        let html = await htmlRes.text();
        html = html.replace(/{{slug}}/g, matchedSlug);
        const hasError = (userAnswer && challengeId) ? 'true' : 'false';
        html = html.replace(/{{hasError}}/g, hasError);
        html = html.replace(/{{[a-z_]+}}/gi, '');
        return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
      }
    }

    recordAnalytics(context, env, matchedSlug, request, link.link_id);

    if (link.type === "group") {
      const hub = await env.DB.prepare("SELECT * FROM hub_configs WHERE slug = ?").bind(matchedSlug).first();

      if (hub && hub.mode === "custom_html" && hub.custom_html && hub.custom_html.trim() !== "") {
        let custom = hub.custom_html;
        custom = custom.replace(/{{slug}}/g, matchedSlug);
        custom = custom.replace(/{{title}}/g, hub.title || matchedSlug);
        custom = custom.replace(/{{bio}}/g, hub.bio || '');
        custom = custom.replace(/{{origin}}/g, url.origin);
        return new Response(custom, {
          headers: {
            "Content-Type": "text/html; charset=utf-8",
            "Cache-Control": "no-store"
          }
        });
      }

      const htmlRes = await fetch(new URL("/gs/hub.html", url.origin));
      let html = await htmlRes.text();
      let items = [];
      try { items = JSON.parse(hub?.items_json || "[]"); } catch {}
      const palettes = {
        emerald: { bg: "#090d0b", card: "#131c17", border: "#1f2e26", text: "#f9fafb", btn: "#10b981", btnText: "#062419" },
        midnight: { bg: "#0b0f19", card: "#111827", border: "#1f2937", text: "#f3f4f6", btn: "#3b82f6", btnText: "#ffffff" },
        cyberpunk: { bg: "#18052e", card: "#2b094f", border: "#491088", text: "#fdf4ff", btn: "#f43f5e", btnText: "#ffffff" },
        minimal_light: { bg: "#f8fafc", card: "#ffffff", border: "#e2e8f0", text: "#0f172a", btn: "#0f172a", btnText: "#ffffff" }
      };
      const pal = palettes[hub?.theme_palette] || palettes.emerald;
      const bgStyle = hub?.bg_type === "custom" && hub?.bg_val ? hub.bg_val : pal.bg;
      let btnRadius = "10px";
      if (hub?.btn_style === "pill") btnRadius = "999px";
      if (hub?.btn_style === "sharp") btnRadius = "2px";
      const linksHtml = items.map(it => {
        const href = it.is_gs ? `${url.origin}/${it.url}` : it.url;
        return `<a href="${href}" target="_blank" rel="noopener noreferrer" class="hub-btn"><span>${it.title}</span><span>&rarr;</span></a>`;
      }).join("");
      html = html.replace(/{{slug}}/g, matchedSlug);
      html = html.replace(/{{title}}/g, hub?.title || matchedSlug);
      html = html.replace(/{{bgStyle}}/g, bgStyle);
      html = html.replace(/{{textColor}}/g, pal.text);
      html = html.replace(/{{btnColor}}/g, pal.btn);
      html = html.replace(/{{btnTextColor}}/g, pal.btnText);
      html = html.replace(/{{cardBg}}/g, pal.card);
      html = html.replace(/{{borderColor}}/g, pal.border);
      html = html.replace(/{{btnRadius}}/g, btnRadius);
      html = html.replace(/{{linksHtml}}/g, linksHtml);
      html = html.replace(/{{lang}}/g, hub?.lang_mode !== 'auto' ? hub?.lang_mode : 'es');
      html = html.replace(/{{bioHtml}}/g, hub?.bio ? `<p class="bio">${hub.bio}</p>` : '');
      html = html.replace(/{{[a-z_]+}}/gi, '');
      return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
    }

    let target = link.target_url.replace(/\/+$/, "");
    if (link.splat && remainingSegments.length > 0) {
      target += "/" + remainingSegments.join("/");
    }
    if (url.search) {
      const cleanParams = new URLSearchParams(url.search);
      cleanParams.delete("pwd");
      const qs = cleanParams.toString();
      if (qs) target += (target.includes("?") ? "&" : "?") + qs;
    }
    return Response.redirect(target, 302);

  } catch (error) {
    console.error('Error en Worker:', error);
    return new Response(JSON.stringify({ error: 'Internal Server Error', message: error.message }), { status: 500, headers: { "Content-Type": "application/json" } });
  }
}
