import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import worker from "../src/index";
import { resetAccessCertsCache } from "../src/mcp/access-jwt";
import { NEW_CLIENT_APPROVAL_WINDOW_SECONDS } from "../src/mcp/oauth";
import { call, csrfFrom, ctx, env, pkce, postConsent, REDIRECT, setupOAuthHarness, signJwt, teardownOAuthHarness } from "./mcp-helpers";

beforeAll(async () => {
  await setupOAuthHarness();
}, 60_000);
beforeEach(() => resetAccessCertsCache());
afterAll(teardownOAuthHarness);

const registrationBody = (name = "Claude (test)") =>
  JSON.stringify({
    client_name: name,
    redirect_uris: [REDIRECT],
    token_endpoint_auth_method: "none",
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
  });

/** Registers a client on `origin`; the provider is cached per origin, so each DCR setting gets its own origin. */
function registerOn(origin: string, dcr: string | undefined, name?: string): Promise<Response> {
  return worker.fetch(
    new Request(`${origin}/oauth/register`, { method: "POST", headers: { "content-type": "application/json" }, body: registrationBody(name) }),
    { ...env, MCP_DCR_ENABLED: dcr },
    ctx,
  );
}

async function newClient(name?: string): Promise<string> {
  const res = await call("/oauth/register", { method: "POST", headers: { "content-type": "application/json" }, body: registrationBody(name) });
  expect(res.status).toBe(201);
  return ((await res.json()) as { client_id: string }).client_id;
}

/** Moves the client's DCR registrationDate (Unix seconds, stored by workers-oauth-provider in OAUTH_KV). */
async function registeredAgo(clientId: string, seconds: number): Promise<void> {
  const key = `client:${clientId}`;
  const record = (await env.OAUTH_KV.get(key, { type: "json" })) as Record<string, unknown>;
  await env.OAUTH_KV.put(key, JSON.stringify({ ...record, registrationDate: Math.floor(Date.now() / 1000) - seconds }));
}

async function consentGet(clientId: string): Promise<Response> {
  const { challenge } = await pkce();
  const query = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT,
    scope: "read",
    state: "s",
    code_challenge: challenge,
    code_challenge_method: "S256",
  });
  return call(`/oauth/authorize?${query.toString()}`, { headers: { "cf-access-jwt-assertion": await signJwt({}) } });
}

async function approve(csrf: string): Promise<Response> {
  return postConsent({ csrf, decision: "approve" }, await signJwt({}));
}

const clientRow = (clientId: string) =>
  env.DB.prepare("SELECT scopes, revoked_at FROM ai_clients WHERE client_id = ?").bind(clientId).first<{ scopes: string; revoked_at: number | null }>();

describe("DCR is off unless MCP_DCR_ENABLED is exactly \"true\"", () => {
  it.each([
    ["unset", undefined, "http://localhost:1001"],
    ["false", "false", "http://localhost:1002"],
    ["TRUE with a space", "TRUE ", "http://localhost:1003"],
    ["True", "True", "http://localhost:1004"],
  ])("%s → registration_disabled", async (_name, dcr, origin) => {
    const res = await registerOn(origin, dcr);
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: "registration_disabled" });
  });

  it('"true" → registration succeeds', async () => {
    const res = await registerOn("http://localhost:1005", "true");
    expect(res.status).toBe(201);
  });

  it('wrangler.toml ships MCP_DCR_ENABLED = "false"', async () => {
    const fs = (await import("node:fs" as string)) as { readFileSync(p: URL, e: "utf8"): string };
    const toml = fs.readFileSync(new URL("../wrangler.toml", (import.meta as ImportMeta & { url: string }).url), "utf8");
    expect(toml).toMatch(/^MCP_DCR_ENABLED = "false"$/m);
  });
});

describe("only recently registered clients may be approved for the first time", () => {
  it("no row, registered 16 minutes ago → GET and POST 403 client_not_approved, no row created", async () => {
    const id = await newClient();
    const page = await consentGet(id); // still fresh: get a CSRF token for the POST check
    expect(page.status).toBe(200);
    const csrf = csrfFrom(await page.text());

    await registeredAgo(id, 16 * 60);
    expect(16 * 60).toBeGreaterThan(NEW_CLIENT_APPROVAL_WINDOW_SECONDS);
    const get = await consentGet(id);
    expect(get.status).toBe(403);
    expect(await get.json()).toEqual({ error: "client_not_approved" });
    const post = await approve(csrf);
    expect(post.status).toBe(403);
    expect(await post.json()).toEqual({ error: "client_not_approved" });
    expect(await clientRow(id)).toBeNull();
  });

  it("no row, registered 1 minute ago → consent page marked as a new client", async () => {
    const id = await newClient();
    await registeredAgo(id, 60);
    const res = await consentGet(id);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("client ใหม่ ยังไม่เคยอนุญาต");
  });

  it("no registrationDate → client_not_approved", async () => {
    const id = await newClient();
    const key = `client:${id}`;
    const { registrationDate: _drop, ...record } = (await env.OAUTH_KV.get(key, { type: "json" })) as Record<string, unknown>;
    await env.OAUTH_KV.put(key, JSON.stringify(record));
    expect((await consentGet(id)).status).toBe(403);
  });

  it("approved client (row) registered long ago → consent page marked as already approved", async () => {
    const id = await newClient();
    const page = await consentGet(id);
    expect((await approve(csrfFrom(await page.text()))).status).toBe(302);
    expect(await clientRow(id)).toEqual({ scopes: "read", revoked_at: null });

    await registeredAgo(id, 30 * 24 * 3600);
    const again = await consentGet(id);
    expect(again.status).toBe(200);
    expect(await again.text()).toContain("เคยอนุญาตแล้ว");
  });

  it("revoked client → GET and POST 403 client_revoked, and the row stays revoked", async () => {
    const id = await newClient();
    expect((await approve(csrfFrom(await (await consentGet(id)).text()))).status).toBe(302);
    const csrf = csrfFrom(await (await consentGet(id)).text());
    const revokedAt = Date.now();
    await env.DB.prepare("UPDATE ai_clients SET revoked_at = ? WHERE client_id = ?").bind(revokedAt, id).run();

    const get = await consentGet(id);
    expect(get.status).toBe(403);
    expect(await get.json()).toEqual({ error: "client_revoked" });
    const post = await approve(csrf);
    expect(post.status).toBe(403);
    expect(await post.json()).toEqual({ error: "client_revoked" });
    expect(await clientRow(id)).toEqual({ scopes: "read", revoked_at: revokedAt });
  });
});

describe("consent page lets the owner tell clients apart", () => {
  it("shows client_id, registration time, the full redirect_uri and the warning; escapes the client name", async () => {
    const id = await newClient('<script>alert("x")</script>');
    const res = await consentGet(id);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-security-policy")).toContain("default-src 'none'");
    const html = await res.text();
    expect(html).toContain(id);
    expect(html).toContain(REDIRECT); // includes the path, not just the host
    expect(new URL(REDIRECT).pathname.length).toBeGreaterThan(1);
    expect(html).toContain("กดอนุญาตเฉพาะเมื่อคุณเพิ่งกดเชื่อมต่อเองเมื่อสักครู่ ถ้าได้ลิงก์นี้จากคนอื่น ให้กดปฏิเสธ");
    expect(html).toContain("(เวลาไทย)");
    expect(html).toMatch(/ลงทะเบียนเมื่อ: <strong>[^<]*25[0-9]{2}/); // Thai Buddhist-era year
    expect(html).not.toContain("<script>alert");
    expect(html).toContain("&#60;script&#62;");
  });
});
