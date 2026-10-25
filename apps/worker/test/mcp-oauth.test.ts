import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import worker from "../src/index";
import { resetAccessCertsCache } from "../src/mcp/access-jwt";
import { authHeader, createTestEnv, type TestEnv } from "./d1";

// Fictional Access team / audience / owner; the RSA keys are generated per run (never real credentials).
const TEAM = "test-team.cloudflareaccess.com";
const AUD = "test-access-aud";
const OWNER = "owner@example.com";
const CERTS_URL = `https://${TEAM}/cdn-cgi/access/certs`;
const REDIRECT = "https://claude.ai/api/mcp/auth_callback";

let testEnv: TestEnv;
let env: Env;
let signingKey: CryptoKey;
let otherKey: CryptoKey;
let publicJwk: JsonWebKey;
let clientId: string;

const ctx = { waitUntil() {}, passThroughOnException() {}, props: {} } as unknown as ExecutionContext;
const encoder = new TextEncoder();

function b64url(data: Uint8Array | string): string {
  const bytes = typeof data === "string" ? encoder.encode(data) : data;
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function signJwt(claims: Record<string, unknown>, key: CryptoKey = signingKey): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const payload = { iss: `https://${TEAM}`, aud: [AUD], email: OWNER, iat: now, nbf: now - 5, exp: now + 300, ...claims };
  const input = `${b64url(JSON.stringify({ alg: "RS256", kid: "test-kid", typ: "JWT" }))}.${b64url(JSON.stringify(payload))}`;
  const sig = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, encoder.encode(input)));
  return `${input}.${b64url(sig)}`;
}

function call(path: string, init: RequestInit = {}, e: Env = env): Promise<Response> {
  return worker.fetch(new Request(`http://localhost${path}`, init), e, ctx);
}

async function pkce(): Promise<{ verifier: string; challenge: string }> {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(verifier))));
  return { verifier, challenge };
}

function authorizeQuery(challenge: string, scope = "read offline_access"): string {
  return new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT,
    scope,
    state: "state-123",
    code_challenge: challenge,
    code_challenge_method: "S256",
  }).toString();
}

async function getConsent(query: string, jwt?: string, e: Env = env): Promise<Response> {
  return call(`/oauth/authorize?${query}`, { headers: jwt ? { "cf-access-jwt-assertion": jwt } : {} }, e);
}

async function postConsent(fields: Record<string, string>, jwt?: string): Promise<Response> {
  return call("/oauth/authorize", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", ...(jwt ? { "cf-access-jwt-assertion": jwt } : {}) },
    body: new URLSearchParams(fields).toString(),
    redirect: "manual",
  });
}

function csrfFrom(html: string): string {
  const m = /name="csrf" value="([^"]+)"/.exec(html);
  if (!m?.[1]) throw new Error("csrf not found");
  return m[1];
}

async function register(redirectUris: string[]): Promise<Response> {
  return call("/oauth/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "Claude (test)",
      redirect_uris: redirectUris,
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    }),
  });
}

/** Full consent → token flow; returns the token response body. */
async function obtainToken(scope?: string): Promise<{ access_token: string; scope?: string; refresh_token?: string }> {
  const { verifier, challenge } = await pkce();
  const jwt = await signJwt({});
  const page = await getConsent(authorizeQuery(challenge, scope), jwt);
  expect(page.status).toBe(200);
  const approve = await postConsent({ csrf: csrfFrom(await page.text()), decision: "approve" }, jwt);
  expect(approve.status).toBe(302);
  const location = new URL(approve.headers.get("location") ?? "");
  expect(`${location.origin}${location.pathname}`).toBe(REDIRECT);
  expect(location.searchParams.get("state")).toBe("state-123");
  const code = location.searchParams.get("code") ?? "";
  const res = await call("/oauth/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT,
      client_id: clientId,
      code_verifier: verifier,
    }).toString(),
  });
  expect(res.status).toBe(200);
  return res.json();
}

beforeAll(async () => {
  testEnv = await createTestEnv();
  env = {
    ...testEnv.env,
    ACCESS_TEAM_DOMAIN: TEAM,
    ACCESS_AUD: AUD,
    OWNER_EMAILS: `${OWNER}, other-owner@example.com`,
    MCP_ALLOWED_REDIRECT_HOSTS: "chatgpt.com,claude.ai",
    CONSENT_CSRF_SECRET: "test-csrf-secret-not-real",
  };
  const params = { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" };
  const pair = (await crypto.subtle.generateKey(params, true, ["sign", "verify"])) as CryptoKeyPair;
  const other = (await crypto.subtle.generateKey(params, true, ["sign", "verify"])) as CryptoKeyPair;
  signingKey = pair.privateKey;
  otherKey = other.privateKey;
  publicJwk = { ...((await crypto.subtle.exportKey("jwk", pair.publicKey)) as JsonWebKey), kid: "test-kid" } as JsonWebKey;

  const realFetch = globalThis.fetch;
  vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url === CERTS_URL) return Promise.resolve(Response.json({ keys: [publicJwk] }));
    return realFetch(input, init);
  });

  const res = await register([REDIRECT]);
  expect(res.status).toBe(201);
  clientId = ((await res.json()) as { client_id: string }).client_id;
});

beforeEach(() => resetAccessCertsCache());

afterAll(async () => {
  vi.restoreAllMocks();
  await testEnv?.dispose();
});

describe("Access JWT on /oauth/authorize", () => {
  it("accepts a valid JWT from an owner and renders the Thai consent page", async () => {
    const { challenge } = await pkce();
    const res = await getConsent(authorizeQuery(challenge), await signJwt({ email: "Owner@Example.com" }));
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Claude (test)");
    expect(html).toContain("claude.ai");
    expect(html).toContain("อ่านข้อมูลอย่างเดียว");
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it.each([
    ["missing header", async () => undefined],
    ["wrong aud", () => signJwt({ aud: ["someone-else"] })],
    ["wrong iss", () => signJwt({ iss: "https://evil.cloudflareaccess.com" })],
    ["expired", () => signJwt({ exp: Math.floor(Date.now() / 1000) - 60 })],
    ["not yet valid", () => signJwt({ nbf: Math.floor(Date.now() / 1000) + 600 })],
    ["bad signature", () => signJwt({}, otherKey)],
    ["email not an owner", () => signJwt({ email: "stranger@example.com" })],
    ["garbage", async () => "not.a.jwt"],
  ])("rejects %s with 403", async (_name, make) => {
    const { challenge } = await pkce();
    const res = await getConsent(authorizeQuery(challenge), await make());
    expect(res.status).toBe(403);
  });

  it.each(["ACCESS_AUD", "CONSENT_CSRF_SECRET", "ACCESS_TEAM_DOMAIN", "OWNER_EMAILS"] as const)(
    "fails closed with 503 when %s is missing",
    async (key) => {
      const { challenge } = await pkce();
      const res = await getConsent(authorizeQuery(challenge), await signJwt({}), { ...env, [key]: undefined });
      expect(res.status).toBe(503);
    },
  );
});

describe("consent CSRF", () => {
  it("rejects a POST without a CSRF token", async () => {
    const res = await postConsent({ decision: "approve" }, await signJwt({}));
    expect(res.status).toBe(403);
  });

  it("rejects a forged CSRF token", async () => {
    const res = await postConsent({ csrf: `${crypto.randomUUID()}.${"0".repeat(64)}`, decision: "approve" }, await signJwt({}));
    expect(res.status).toBe(403);
  });

  it("rejects a CSRF token bound to another owner", async () => {
    const { challenge } = await pkce();
    const page = await getConsent(authorizeQuery(challenge), await signJwt({}));
    const csrf = csrfFrom(await page.text());
    const res = await postConsent({ csrf, decision: "approve" }, await signJwt({ email: "other-owner@example.com" }));
    expect(res.status).toBe(403);
  });

  it("accepts a CSRF token once and rejects reuse", async () => {
    const jwt = await signJwt({});
    const { challenge } = await pkce();
    const csrf = csrfFrom(await (await getConsent(authorizeQuery(challenge), jwt)).text());
    const first = await postConsent({ csrf, decision: "approve" }, jwt);
    expect(first.status).toBe(302);
    const again = await postConsent({ csrf, decision: "approve" }, jwt);
    expect(again.status).toBe(403);
  });

  it("deny redirects back with access_denied", async () => {
    const jwt = await signJwt({});
    const { challenge } = await pkce();
    const csrf = csrfFrom(await (await getConsent(authorizeQuery(challenge), jwt)).text());
    const res = await postConsent({ csrf, decision: "deny" }, jwt);
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get("location") ?? "");
    expect(location.searchParams.get("error")).toBe("access_denied");
    expect(location.searchParams.get("code")).toBeNull();
  });

  it("POST also requires a valid Access JWT", async () => {
    const res = await postConsent({ csrf: "x.y", decision: "approve" });
    expect(res.status).toBe(403);
  });
});

describe("dynamic client registration", () => {
  it("rejects a redirect host outside the allowlist", async () => {
    const res = await register(["https://evil.example.com/callback"]);
    expect(res.status).toBe(400);
  });

  it("rejects http redirect_uris even on an allowed host", async () => {
    const res = await register(["http://claude.ai/api/mcp/auth_callback"]);
    expect(res.status).toBe(400);
  });

  it("rejects a mix of allowed and disallowed redirect_uris", async () => {
    const res = await register([REDIRECT, "https://claude.ai.evil.example.com/cb"]);
    expect(res.status).toBe(400);
  });

  it("re-checks the allowlist at authorize time", async () => {
    const { challenge } = await pkce();
    const narrowed = { ...env, MCP_ALLOWED_REDIRECT_HOSTS: "chatgpt.com" };
    const res = await getConsent(authorizeQuery(challenge), await signJwt({}), narrowed);
    expect(res.status).toBe(400);
  });
});

describe("OAuth flow → /mcp", () => {
  it("register → consent → token (PKCE S256) → /mcp answers 501 with a valid token", async () => {
    const token = await obtainToken("read offline_access admin write");
    expect(token.scope?.split(" ").sort()).toEqual(["offline_access", "read"]);
    expect(token.refresh_token).toBeTruthy();
    const res = await call("/mcp", { method: "POST", headers: { authorization: `Bearer ${token.access_token}` } });
    expect(res.status).toBe(501);
    expect(await res.json()).toEqual({ error: "not_implemented" });
  });

  it("/mcp without a token → 401 with WWW-Authenticate", async () => {
    const res = await call("/mcp", { method: "POST" });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toMatch(/^Bearer/);
  });

  it("revoking mcp-default → 401", async () => {
    const { access_token } = await obtainToken();
    await env.DB.prepare("UPDATE ai_clients SET revoked_at = ? WHERE name = 'mcp-default'").bind(Date.now()).run();
    try {
      const res = await call("/mcp", { method: "POST", headers: { authorization: `Bearer ${access_token}` } });
      expect(res.status).toBe(401);
      expect(res.headers.get("www-authenticate")).toMatch(/^Bearer/);
    } finally {
      await env.DB.prepare("UPDATE ai_clients SET revoked_at = NULL WHERE name = 'mcp-default'").run();
    }
  });

  it("seeds mcp-default with read scope", async () => {
    const row = await env.DB.prepare("SELECT scopes, revoked_at FROM ai_clients WHERE name = 'mcp-default'").first();
    expect(row).toEqual({ scopes: "read", revoked_at: null });
  });
});

describe("/api/* stays on API_TOKEN", () => {
  it("accepts API_TOKEN and rejects an OAuth access token", async () => {
    const ok = await call("/api/assets", { headers: authHeader });
    expect(ok.status).toBe(200);
    const { access_token } = await obtainToken();
    const res = await call("/api/assets", { headers: { authorization: `Bearer ${access_token}` } });
    expect(res.status).toBe(401);
  });
});
