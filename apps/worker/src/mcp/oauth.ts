import OAuthProvider, { type AuthRequest, type ClientInfo, type OAuthProviderOptions } from "@cloudflare/workers-oauth-provider";
import { Hono } from "hono";
import { tokensEqual } from "../auth";
import type { Env } from "../env";
import { AccessJwtError, verifyAccessJwt } from "./access-jwt";
import { mcpApiHandler } from "./server";

// `draft` lets an AI propose drafts the owner must confirm; it only works once the owner also adds it
// to the ai_clients row (the default row's ceiling stays `read`).
export const SUPPORTED_SCOPES = ["read", "offline_access", "draft"] as const;
export const DEFAULT_REDIRECT_HOSTS = "chatgpt.com,claude.ai";

const CSRF_TTL_SECONDS = 600;
/** A client with no ai_clients row (never approved) can only be approved this soon after DCR registration. */
export const NEW_CLIENT_APPROVAL_WINDOW_SECONDS = 15 * 60;
const CSRF_KV_PREFIX = "consent_csrf:";
const encoder = new TextEncoder();

function splitList(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((v) => v.trim().toLowerCase())
    .filter((v) => v.length > 0);
}

export function allowedRedirectHosts(env: Env): string[] {
  const hosts = splitList(env.MCP_ALLOWED_REDIRECT_HOSTS);
  return hosts.length > 0 ? hosts : splitList(DEFAULT_REDIRECT_HOSTS);
}

/** redirect_uri must be https and its host exactly one of the allowlisted hosts. */
export function isAllowedRedirectUri(uri: unknown, env: Env): boolean {
  if (typeof uri !== "string") return false;
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return false;
  }
  return url.protocol === "https:" && !url.username && !url.password && allowedRedirectHosts(env).includes(url.hostname.toLowerCase());
}

/** Keeps only supported scopes; `read` is always granted (it is the only resource capability). */
export function filterScopes(requested: string[]): string[] {
  const kept = SUPPORTED_SCOPES.filter((s) => requested.includes(s));
  return kept.includes("read") ? kept : ["read", ...kept];
}

function toHex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Opaque, stable user id: the grant never stores the email as its key. */
export async function opaqueUserId(email: string): Promise<string> {
  return toHex(await crypto.subtle.digest("SHA-256", encoder.encode(`owner-os-user:${email}`))).slice(0, 32);
}

async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  return toHex(await crypto.subtle.sign("HMAC", key, encoder.encode(message)));
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
}

type ConsentConfig = { teamDomain: string; aud: string; owners: string[]; csrfSecret: string; kv: KVNamespace };

function consentConfig(env: Env): ConsentConfig | null {
  const owners = splitList(env.OWNER_EMAILS);
  if (!env.ACCESS_TEAM_DOMAIN?.trim() || !env.ACCESS_AUD?.trim() || !env.CONSENT_CSRF_SECRET || !env.OAUTH_KV) return null;
  if (owners.length === 0 || !env.OAUTH_PROVIDER) return null;
  return {
    teamDomain: env.ACCESS_TEAM_DOMAIN,
    aud: env.ACCESS_AUD.trim(),
    owners,
    csrfSecret: env.CONSENT_CSRF_SECRET,
    kv: env.OAUTH_KV,
  };
}

type Ctx = { Bindings: Env; Variables: { cfg: ConsentConfig; email: string } };

const SECURITY_HEADERS = {
  "cache-control": "no-store",
  "x-frame-options": "DENY",
  "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'",
  "referrer-policy": "no-referrer",
};

type ClientStatus = "pinned" | "new";

/**
 * Consent phishing guard. An approved client (ai_clients row with its client_id) may re-consent; a revoked
 * one may not (re-consent must not restore access); an unknown one only within NEW_CLIENT_APPROVAL_WINDOW_SECONDS
 * of its DCR registration, so a link prepared earlier by someone else cannot be approved later.
 */
async function clientStatus(env: Env, client: ClientInfo): Promise<ClientStatus | "client_revoked" | "client_not_approved"> {
  const row = await env.DB.prepare("SELECT revoked_at FROM ai_clients WHERE client_id = ?")
    .bind(client.clientId)
    .first<{ revoked_at: number | null }>();
  if (row) return row.revoked_at === null ? "pinned" : "client_revoked";
  const registered = client.registrationDate; // Unix seconds (workers-oauth-provider)
  const now = Math.floor(Date.now() / 1000);
  if (typeof registered === "number" && registered <= now && now - registered <= NEW_CLIENT_APPROVAL_WINDOW_SECONDS) return "new";
  return "client_not_approved";
}

function registeredAtTh(client: ClientInfo): string {
  if (typeof client.registrationDate !== "number") return "ไม่ทราบ";
  return new Date(client.registrationDate * 1000).toLocaleString("th-TH", {
    dateStyle: "medium",
    timeStyle: "medium",
    timeZone: "Asia/Bangkok",
  });
}

function consentPage(client: ClientInfo, status: ClientStatus, redirectUri: string, scopes: string[], csrf: string): string {
  const badge = status === "new" ? "client ใหม่ ยังไม่เคยอนุญาต" : "เคยอนุญาตแล้ว";
  return `<!doctype html>
<html lang="th"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>อนุญาตการเข้าถึง · owner-os</title>
<style>body{font-family:system-ui,sans-serif;max-width:36rem;margin:3rem auto;padding:0 1rem}button{font-size:1rem;padding:.5rem 1.25rem;margin-right:.5rem}code{word-break:break-all}.warn{border:2px solid #b45309;background:#fffbeb;padding:.75rem;border-radius:.5rem}</style>
</head><body>
<h1>อนุญาตให้แอปเข้าถึง owner-os?</h1>
<p class="warn"><strong>กดอนุญาตเฉพาะเมื่อคุณเพิ่งกดเชื่อมต่อเองเมื่อสักครู่ ถ้าได้ลิงก์นี้จากคนอื่น ให้กดปฏิเสธ</strong></p>
<p>สถานะ: <strong>${escapeHtml(badge)}</strong></p>
<p>แอป (ชื่อที่แอปตั้งเอง): <strong>${escapeHtml(client.clientName || "-")}</strong></p>
<p>client_id: <code>${escapeHtml(client.clientId)}</code></p>
<p>ลงทะเบียนเมื่อ: <strong>${escapeHtml(registeredAtTh(client))}</strong> (เวลาไทย)</p>
<p>จะส่งกลับไปที่ (redirect_uri): <code>${escapeHtml(redirectUri)}</code></p>
<p>สิทธิ์ที่ขอ:</p>
<ul>
<li><strong>อ่านข้อมูลอย่างเดียว</strong></li>
${scopes.includes("draft") ? "<li><strong>เสนอร่างให้เจ้าของยืนยัน (ไม่มีผลจนกว่าจะยืนยัน)</strong></li>\n" : ""}</ul>
<form method="post" action="/oauth/authorize">
<input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
<button type="submit" name="decision" value="approve">อนุญาต</button>
<button type="submit" name="decision" value="deny">ปฏิเสธ</button>
</form>
</body></html>`;
}

export const oauthRoutes = new Hono<Ctx>();

// Fail closed: missing config → 503; Access JWT invalid or not an owner → 403.
oauthRoutes.use("/authorize", async (c, next) => {
  const cfg = consentConfig(c.env);
  if (!cfg) return c.json({ error: "oauth_not_configured" }, 503);
  const assertion = c.req.header("cf-access-jwt-assertion");
  if (!assertion) return c.json({ error: "forbidden" }, 403);
  let email: string;
  try {
    email = await verifyAccessJwt(assertion, cfg.teamDomain, cfg.aud);
  } catch (err) {
    if (err instanceof AccessJwtError) return c.json({ error: "forbidden" }, 403);
    throw err;
  }
  if (!cfg.owners.includes(email)) return c.json({ error: "forbidden" }, 403);
  c.set("cfg", cfg);
  c.set("email", email);
  await next();
});

oauthRoutes.get("/authorize", async (c) => {
  const cfg = c.get("cfg");
  const helpers = c.env.OAUTH_PROVIDER!;
  let authRequest: AuthRequest;
  try {
    authRequest = await helpers.parseAuthRequest(c.req.raw);
  } catch {
    return c.json({ error: "invalid_request" }, 400);
  }
  const client = await helpers.lookupClient(authRequest.clientId);
  if (!client) return c.json({ error: "invalid_client" }, 400);
  if (!isAllowedRedirectUri(authRequest.redirectUri, c.env)) return c.json({ error: "invalid_redirect_uri" }, 400);
  const status = await clientStatus(c.env, client);
  if (status === "client_revoked" || status === "client_not_approved") return c.json({ error: status }, 403);

  const request: AuthRequest = { ...authRequest, scope: filterScopes(authRequest.scope) };
  const nonce = crypto.randomUUID();
  await cfg.kv.put(`${CSRF_KV_PREFIX}${nonce}`, JSON.stringify({ email: c.get("email"), request }), {
    expirationTtl: CSRF_TTL_SECONDS,
  });
  const csrf = `${nonce}.${await hmacHex(cfg.csrfSecret, `${nonce}.${c.get("email")}`)}`;
  const html = consentPage(client, status, request.redirectUri, request.scope, csrf);
  return c.html(html, 200, SECURITY_HEADERS);
});

oauthRoutes.post("/authorize", async (c) => {
  const cfg = c.get("cfg");
  const email = c.get("email");
  const form = await c.req.parseBody();
  const csrf = typeof form.csrf === "string" ? form.csrf : "";
  const [nonce, mac, extra] = csrf.split(".");
  if (!nonce || !mac || extra !== undefined) return c.json({ error: "invalid_csrf" }, 403);
  if (!(await tokensEqual(mac, await hmacHex(cfg.csrfSecret, `${nonce}.${email}`)))) {
    return c.json({ error: "invalid_csrf" }, 403);
  }
  const kvKey = `${CSRF_KV_PREFIX}${nonce}`;
  const stored = await cfg.kv.get(kvKey);
  if (!stored) return c.json({ error: "invalid_csrf" }, 403);
  await cfg.kv.delete(kvKey); // one-time use
  const { email: boundEmail, request } = JSON.parse(stored) as { email: string; request: AuthRequest };
  if (boundEmail !== email) return c.json({ error: "invalid_csrf" }, 403);
  // Re-check in case the allowlist changed between GET and POST.
  if (!isAllowedRedirectUri(request.redirectUri, c.env)) return c.json({ error: "invalid_redirect_uri" }, 400);
  const helpers = c.env.OAUTH_PROVIDER!;
  const client = await helpers.lookupClient(request.clientId);
  if (!client) return c.json({ error: "invalid_client" }, 400);
  // Checked again on POST: the client may have been revoked, or its approval window passed, since the GET.
  const status = await clientStatus(c.env, client);
  if (status === "client_revoked" || status === "client_not_approved") return c.json({ error: status }, 403);

  if (form.decision !== "approve") {
    const url = new URL(request.redirectUri);
    url.searchParams.set("error", "access_denied");
    if (request.state) url.searchParams.set("state", request.state);
    return c.redirect(url.toString(), 302);
  }

  // Per-client row (ceiling, revocation, rate limits). Created read-only on first approval; an existing row is
  // never upgraded or overwritten (opening `draft` stays an owner action on both the global and client rows).
  await c.env.DB.prepare(
    "INSERT OR IGNORE INTO ai_clients (name, scopes, client_id, created_at) VALUES ('client:' || ?1, 'read', ?1, ?2)",
  )
    .bind(request.clientId, Date.now())
    .run();

  const { redirectTo } = await helpers.completeAuthorization({
    request,
    userId: await opaqueUserId(email),
    metadata: { clientName: client.clientName ?? request.clientId },
    scope: request.scope,
    props: { email },
  });
  return c.redirect(redirectTo, 302);
});

/**
 * Builds the OAuth provider for this request's origin (the resource URL must be absolute).
 * DCR rejects redirect_uris that are not https on an allowlisted host.
 */
export function createOAuthProvider(
  env: Env,
  origin: string,
  defaultHandler: OAuthProviderOptions<Env>["defaultHandler"],
): OAuthProvider<Env> {
  return new OAuthProvider<Env>({
    apiRoute: "/mcp",
    apiHandler: mcpApiHandler,
    defaultHandler,
    authorizeEndpoint: "/oauth/authorize",
    tokenEndpoint: "/oauth/token",
    clientRegistrationEndpoint: "/oauth/register",
    scopesSupported: [...SUPPORTED_SCOPES],
    requiredScopes: ["read"],
    resourceMetadata: { resource: `${origin}/mcp`, authorization_servers: [origin], resource_name: "owner-os" },
    clientRegistrationCallback: ({ clientMetadata }) => {
      // DCR is off unless the owner sets MCP_DCR_ENABLED to exactly "true" while connecting a connector.
      if (env.MCP_DCR_ENABLED !== "true") {
        return { code: "registration_disabled", description: "client registration is disabled", status: 403 };
      }
      const uris = clientMetadata.redirect_uris;
      if (!Array.isArray(uris) || uris.length === 0 || !uris.every((u) => isAllowedRedirectUri(u, env))) {
        return { code: "invalid_redirect_uri", description: "redirect_uris must be https on an allowed host" };
      }
    },
  });
}
