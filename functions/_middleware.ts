// Capa OAuth 2.0 para el MCP de Centro de Proyectos.
//
// claude.ai (web, móvil, Cowork) solo sabe autenticar conectores MCP vía
// OAuth con Dynamic Client Registration. Este middleware envuelve el auth
// Bearer estático existente (MCP_SECRET) con un flujo OAuth mínimo y
// SIN ESTADO: codes y tokens son blobs firmados con HMAC derivado del
// propio MCP_SECRET, así que rotar el secret invalida todos los tokens.
//
// Endpoints que sirve:
//   GET  /.well-known/oauth-protected-resource[/mcp]   (RFC 9728)
//   GET  /.well-known/oauth-authorization-server[/mcp] (RFC 8414)
//   POST /oauth/register                               (RFC 7591, DCR)
//   GET  /oauth/authorize  → página que pide el MCP_SECRET
//   POST /oauth/authorize  → valida secret y redirige con code
//   POST /oauth/token      → code/refresh → access_token firmado
//
// Además, para /mcp:
//   - Si llega un access_token firmado válido, reescribe Authorization
//     a `Bearer ${MCP_SECRET}` antes de pasar a mcp.ts (que no cambia).
//   - Si mcp.ts devuelve 401, añade WWW-Authenticate apuntando al
//     resource metadata para que el cliente descubra el flujo OAuth.
//
// El resto de rutas (web estática) pasan sin tocar.

interface Env {
  MCP_SECRET: string;
}

const ACCESS_TTL = 180 * 24 * 3600; // 180 días
const REFRESH_TTL = 365 * 24 * 3600; // 1 año
const CODE_TTL = 600; // 10 min

// ---------- base64url ----------

function b64urlEncode(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function b64urlEncodeStr(s: string): string {
  return b64urlEncode(new TextEncoder().encode(s));
}

function b64urlDecode(s: string): Uint8Array {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// ---------- HMAC firmado/verificado (sin estado) ----------

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode("cdp-oauth-v1:" + secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"]
  );
}

async function signPayload(obj: object, secret: string): Promise<string> {
  const payload = b64urlEncodeStr(JSON.stringify(obj));
  const key = await hmacKey(secret);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return payload + "." + b64urlEncode(new Uint8Array(sig));
}

async function verifyPayload(token: string, secret: string): Promise<any | null> {
  const dot = token.lastIndexOf(".");
  if (dot < 0) return null;
  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  try {
    const key = await hmacKey(secret);
    const ok = await crypto.subtle.verify(
      "HMAC",
      key,
      b64urlDecode(sig).buffer as ArrayBuffer,
      new TextEncoder().encode(payload)
    );
    if (!ok) return null;
    const obj = JSON.parse(new TextDecoder().decode(b64urlDecode(payload)));
    if (typeof obj.exp !== "number" || obj.exp < Math.floor(Date.now() / 1000)) return null;
    return obj;
  } catch {
    return null;
  }
}

async function sha256b64url(s: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return b64urlEncode(new Uint8Array(digest));
}

// ---------- helpers de respuesta ----------

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type",
  "Access-Control-Max-Age": "86400"
};

function json(obj: any, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: { "Content-Type": "application/json", ...CORS, ...extra }
  });
}

function oauthError(error: string, description: string, status = 400): Response {
  return json({ error, error_description: description }, status);
}

// ---------- página de autorización ----------

function authorizePage(params: URLSearchParams, errorMsg = ""): Response {
  const esc = (s: string) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
  const hidden = ["response_type", "client_id", "redirect_uri", "state", "code_challenge", "code_challenge_method", "scope"]
    .map(k => `<input type="hidden" name="${k}" value="${esc(params.get(k) ?? "")}">`)
    .join("\n      ");
  const html = `<!doctype html>
<html lang="es"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Autorizar — Centro de Proyectos</title>
<style>
  body{background:#0f1115;color:#e6e6e6;font-family:system-ui,sans-serif;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0}
  .card{background:#1a1d24;border:1px solid #2a2e38;border-radius:12px;padding:2rem;max-width:380px;width:90%}
  h1{font-size:1.1rem;margin:0 0 .5rem}
  p{font-size:.85rem;color:#9aa0ab;margin:.25rem 0 1rem}
  input[type=password]{width:100%;box-sizing:border-box;padding:.6rem;border-radius:8px;border:1px solid #2a2e38;background:#0f1115;color:#e6e6e6;font-size:1rem}
  button{margin-top:1rem;width:100%;padding:.6rem;border:0;border-radius:8px;background:#6d3fc0;color:#fff;font-size:1rem;cursor:pointer}
  .err{color:#ff6b6b;font-size:.85rem;margin-top:.5rem}
</style></head><body>
  <div class="card">
    <h1>Centro de Proyectos</h1>
    <p>Un cliente MCP (claude.ai / Cowork) pide acceso. Introduce el secret del CdP para autorizarlo.</p>
    <form method="POST">
      ${hidden}
      <input type="password" name="secret" placeholder="MCP_SECRET" autofocus required>
      ${errorMsg ? `<div class="err">${esc(errorMsg)}</div>` : ""}
      <button type="submit">Autorizar</button>
    </form>
  </div>
</body></html>`;
  return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
}

// ---------- middleware ----------

export const onRequest: PagesFunction<Env> = async (ctx) => {
  const { request, env, next } = ctx;
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const origin = url.origin;

  const isOauthPath =
    path.startsWith("/.well-known/oauth-") || path.startsWith("/oauth/");

  if (isOauthPath && request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS });
  }

  // --- metadata RFC 9728 (con o sin sufijo /mcp) ---
  if (path.startsWith("/.well-known/oauth-protected-resource")) {
    return json({
      resource: origin + "/mcp",
      authorization_servers: [origin],
      bearer_methods_supported: ["header"],
      resource_name: "Centro de Proyectos MCP"
    });
  }

  // --- metadata RFC 8414 (con o sin sufijo /mcp) ---
  if (path.startsWith("/.well-known/oauth-authorization-server")) {
    return json({
      issuer: origin,
      authorization_endpoint: origin + "/oauth/authorize",
      token_endpoint: origin + "/oauth/token",
      registration_endpoint: origin + "/oauth/register",
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"]
    });
  }

  // --- DCR: registro sin estado, aceptamos cualquier cliente ---
  if (path === "/oauth/register" && request.method === "POST") {
    let body: any = {};
    try {
      body = await request.json();
    } catch { /* cuerpo vacío o inválido: defaults */ }
    return json(
      {
        client_id: "cdp-public-client",
        client_name: body.client_name ?? "MCP client",
        redirect_uris: body.redirect_uris ?? [],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none"
      },
      201
    );
  }

  // --- authorize: GET muestra formulario, POST valida secret ---
  if (path === "/oauth/authorize") {
    if (request.method === "GET") {
      const redirect = url.searchParams.get("redirect_uri") ?? "";
      if (!/^https:\/\//.test(redirect) && !/^http:\/\/localhost[:/]/.test(redirect)) {
        return oauthError("invalid_request", "redirect_uri debe ser https o http://localhost");
      }
      return authorizePage(url.searchParams);
    }
    if (request.method === "POST") {
      const form = await request.formData();
      const params = new URLSearchParams();
      for (const [k, v] of form.entries()) if (typeof v === "string") params.set(k, v);
      const secret = params.get("secret") ?? "";
      if (!env.MCP_SECRET || secret !== env.MCP_SECRET) {
        return authorizePage(params, "Secret incorrecto.");
      }
      const redirect = params.get("redirect_uri") ?? "";
      if (!/^https:\/\//.test(redirect) && !/^http:\/\/localhost[:/]/.test(redirect)) {
        return oauthError("invalid_request", "redirect_uri inválida");
      }
      const code = await signPayload(
        {
          t: "code",
          ru: redirect,
          ch: params.get("code_challenge") ?? "",
          exp: Math.floor(Date.now() / 1000) + CODE_TTL
        },
        env.MCP_SECRET
      );
      const dest = new URL(redirect);
      dest.searchParams.set("code", code);
      const state = params.get("state");
      if (state) dest.searchParams.set("state", state);
      return Response.redirect(dest.toString(), 302);
    }
  }

  // --- token: code o refresh_token → access_token firmado ---
  if (path === "/oauth/token" && request.method === "POST") {
    if (!env.MCP_SECRET) return oauthError("server_error", "MCP_SECRET no configurado", 500);
    const form = await request.formData();
    const grant = form.get("grant_type");
    const now = Math.floor(Date.now() / 1000);

    if (grant === "authorization_code") {
      const payload = await verifyPayload(String(form.get("code") ?? ""), env.MCP_SECRET);
      if (!payload || payload.t !== "code") {
        return oauthError("invalid_grant", "code inválido o caducado");
      }
      if (payload.ch) {
        const verifier = String(form.get("code_verifier") ?? "");
        if ((await sha256b64url(verifier)) !== payload.ch) {
          return oauthError("invalid_grant", "PKCE code_verifier no coincide");
        }
      }
      const redirect = String(form.get("redirect_uri") ?? "");
      if (redirect && redirect !== payload.ru) {
        return oauthError("invalid_grant", "redirect_uri no coincide");
      }
    } else if (grant === "refresh_token") {
      const payload = await verifyPayload(String(form.get("refresh_token") ?? ""), env.MCP_SECRET);
      if (!payload || payload.t !== "refresh") {
        return oauthError("invalid_grant", "refresh_token inválido o caducado");
      }
    } else {
      return oauthError("unsupported_grant_type", "usa authorization_code o refresh_token");
    }

    return json({
      access_token: await signPayload({ t: "access", exp: now + ACCESS_TTL }, env.MCP_SECRET),
      token_type: "bearer",
      expires_in: ACCESS_TTL,
      refresh_token: await signPayload({ t: "refresh", exp: now + REFRESH_TTL }, env.MCP_SECRET)
    });
  }

  // --- /mcp: traducir access_token firmado → Bearer MCP_SECRET ---
  if (path === "/mcp" && env.MCP_SECRET) {
    const auth = request.headers.get("Authorization") ?? "";
    const m = auth.match(/^Bearer (.+)$/);
    if (m && m[1] !== env.MCP_SECRET && m[1].includes(".")) {
      const payload = await verifyPayload(m[1], env.MCP_SECRET);
      if (payload && payload.t === "access") {
        const headers = new Headers(request.headers);
        headers.set("Authorization", `Bearer ${env.MCP_SECRET}`);
        const res = await next(new Request(request, { headers }));
        return res;
      }
    }
    const res = await next();
    if (res.status === 401) {
      const out = new Response(res.body, res);
      out.headers.set(
        "WWW-Authenticate",
        `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`
      );
      return out;
    }
    return res;
  }

  return next();
};
