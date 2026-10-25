import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { resetAccessCertsCache } from "../src/mcp/access-jwt";
import { authHeader } from "./d1";
import {
  authorizeQuery,
  call,
  csrfFrom,
  env,
  getConsent,
  obtainToken,
  otherKey,
  pkce,
  postConsent,
  register,
  REDIRECT,
  setupOAuthHarness,
  signJwt,
  teardownOAuthHarness,
} from "./mcp-helpers";

beforeAll(async () => {
  await setupOAuthHarness();
});

beforeEach(() => resetAccessCertsCache());

afterAll(teardownOAuthHarness);

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
  it("register → consent → token (PKCE S256) → /mcp answers JSON-RPC with a valid token", async () => {
    const token = await obtainToken("read offline_access admin write");
    expect(token.scope?.split(" ").sort()).toEqual(["offline_access", "read"]);
    expect(token.refresh_token).toBeTruthy();
    const res = await call("/mcp", {
      method: "POST",
      headers: { authorization: `Bearer ${token.access_token}`, "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ jsonrpc: "2.0", id: 1, result: {} });
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
