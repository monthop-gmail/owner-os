import { expect, vi } from "vitest";
import type { Env } from "../src/env";
import worker from "../src/index";
import { createTestEnv, type TestEnv } from "./d1";

// Shared OAuth test harness for /mcp (moved from mcp-oauth.test.ts): Access JWT signing, DCR, consent and PKCE token flow.

// Fictional Access team / audience / owner; the RSA keys are generated per run (never real credentials).
export const TEAM = "test-team.cloudflareaccess.com";
export const AUD = "test-access-aud";
export const OWNER = "owner@example.com";
export const CERTS_URL = `https://${TEAM}/cdn-cgi/access/certs`;
export const REDIRECT = "https://claude.ai/api/mcp/auth_callback";

export let testEnv: TestEnv;
export let env: Env;
export let signingKey: CryptoKey;
export let otherKey: CryptoKey;
export let publicJwk: JsonWebKey;
export let clientId: string;

/** Promises handed to ctx.waitUntil (e.g. MCP audit writes); await with flushWaitUntil(). */
const pendingWaitUntil: Promise<unknown>[] = [];
export const ctx = {
  waitUntil(p: Promise<unknown>) {
    pendingWaitUntil.push(p);
  },
  passThroughOnException() {},
  props: {},
} as unknown as ExecutionContext;

export async function flushWaitUntil(): Promise<void> {
  await Promise.all(pendingWaitUntil.splice(0));
}
const encoder = new TextEncoder();

export function b64url(data: Uint8Array | string): string {
  const bytes = typeof data === "string" ? encoder.encode(data) : data;
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function signJwt(claims: Record<string, unknown>, key: CryptoKey = signingKey): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const payload = { iss: `https://${TEAM}`, aud: [AUD], email: OWNER, iat: now, nbf: now - 5, exp: now + 300, ...claims };
  const input = `${b64url(JSON.stringify({ alg: "RS256", kid: "test-kid", typ: "JWT" }))}.${b64url(JSON.stringify(payload))}`;
  const sig = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, encoder.encode(input)));
  return `${input}.${b64url(sig)}`;
}

export function call(path: string, init: RequestInit = {}, e: Env = env): Promise<Response> {
  return worker.fetch(new Request(`http://localhost${path}`, init), e, ctx);
}

export async function pkce(): Promise<{ verifier: string; challenge: string }> {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(verifier))));
  return { verifier, challenge };
}

export function authorizeQuery(challenge: string, scope = "read offline_access"): string {
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

export async function getConsent(query: string, jwt?: string, e: Env = env): Promise<Response> {
  return call(`/oauth/authorize?${query}`, { headers: jwt ? { "cf-access-jwt-assertion": jwt } : {} }, e);
}

export async function postConsent(fields: Record<string, string>, jwt?: string): Promise<Response> {
  return call("/oauth/authorize", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", ...(jwt ? { "cf-access-jwt-assertion": jwt } : {}) },
    body: new URLSearchParams(fields).toString(),
    redirect: "manual",
  });
}

export function csrfFrom(html: string): string {
  const m = /name="csrf" value="([^"]+)"/.exec(html);
  if (!m?.[1]) throw new Error("csrf not found");
  return m[1];
}

export async function register(redirectUris: string[]): Promise<Response> {
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
export async function obtainToken(scope?: string): Promise<{ access_token: string; scope?: string; refresh_token?: string }> {
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


/** Real local D1/KV, fictional Access config, generated RSA keys, stubbed Access certs and one registered client. */
export async function setupOAuthHarness(): Promise<Env> {
  testEnv = await createTestEnv();
  env = {
    ...testEnv.env,
    ACCESS_TEAM_DOMAIN: TEAM,
    ACCESS_AUD: AUD,
    OWNER_EMAILS: `${OWNER}, other-owner@example.com`,
    MCP_ALLOWED_REDIRECT_HOSTS: "chatgpt.com,claude.ai",
    MCP_DCR_ENABLED: "true",
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
  return env;
}

export async function teardownOAuthHarness(): Promise<void> {
  vi.restoreAllMocks();
  await testEnv?.dispose();
}
