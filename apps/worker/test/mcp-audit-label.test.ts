import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { resetAccessCertsCache } from "../src/mcp/access-jwt";
import { CLIENT_LABEL_MAX, clientLabel, mcpApiHandler } from "../src/mcp/server";
import { ctx, env, flushWaitUntil, setupOAuthHarness, teardownOAuthHarness } from "./mcp-helpers";

// mcp_audit.client_label: client-declared, display only — never changes scopes or rate limits.
const C = "client-label";

beforeAll(async () => {
  await setupOAuthHarness();
}, 60_000);
beforeEach(async () => {
  resetAccessCertsCache();
  await flushWaitUntil();
  await env.DB.prepare("DELETE FROM mcp_audit").run();
  await env.DB.prepare("DELETE FROM ai_clients WHERE client_id = ?").bind(C).run();
  await env.DB.prepare(
    "INSERT INTO ai_clients (name, scopes, client_id, rate_per_minute, rate_per_day, created_at) VALUES (?, 'read', ?, 1, 1000, 0)",
  )
    .bind(`client:${C}`, C)
    .run();
  await env.DB.prepare("UPDATE ai_clients SET scopes = 'read,draft', revoked_at = NULL WHERE name = 'mcp-default'").run();
});
afterAll(async () => {
  await env.DB.prepare("UPDATE ai_clients SET scopes = 'read', revoked_at = NULL WHERE name = 'mcp-default'").run();
  await teardownOAuthHarness();
});

async function callWith(headers: Record<string, string>, name: string, args: unknown = {}): Promise<string | undefined> {
  const res = await mcpApiHandler.fetch(
    new Request("http://localhost/mcp", {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
    }),
    env,
    Object.assign(Object.create(ctx) as ExecutionContext, {
      auth: { scope: ["read", "draft", "offline_access"], clientId: C, userId: "u" },
    }),
  );
  await flushWaitUntil();
  expect(res.status).toBe(200);
  const body = (await res.json()) as { result: { isError?: boolean; content: { text: string }[] } };
  return body.result.isError ? (JSON.parse(body.result.content[0]!.text) as { error: string }).error : undefined;
}

async function labels(): Promise<(string | null)[]> {
  const { results } = await env.DB.prepare("SELECT client_label FROM mcp_audit ORDER BY at, rowid").all<{
    client_label: string | null;
  }>();
  return results.map((r) => r.client_label);
}

const fake = (h: Record<string, string>) => ({ get: (k: string) => h[k.toLowerCase()] ?? null });

describe("clientLabel()", () => {
  it("prefers X-Forwarded-User-Agent (fwd:), falls back to User-Agent (ua:), else null", () => {
    expect(clientLabel(fake({ "x-forwarded-user-agent": "claude.ai", "user-agent": "Cloudflare-Portal" }))).toBe("fwd:claude.ai");
    expect(clientLabel(fake({ "user-agent": "Codex/1.0" }))).toBe("ua:Codex/1.0");
    expect(clientLabel(fake({}))).toBeNull();
    expect(clientLabel(fake({ "x-forwarded-user-agent": "", "user-agent": "" }))).toBeNull();
    expect(clientLabel(fake({ "x-forwarded-user-agent": "   ", "user-agent": "bot" }))).toBe("ua:bot");
  });

  it("cuts a 500-char value to 120 chars", () => {
    const label = clientLabel(fake({ "user-agent": "a".repeat(500) }));
    expect(CLIENT_LABEL_MAX).toBe(120);
    expect(label).toBe(`ua:${"a".repeat(120)}`);
  });

  it("replaces newlines, control chars and non-ASCII (Thai) with ?", () => {
    expect(clientLabel(fake({ "x-forwarded-user-agent": "a\nb\tc\x00d\x7fe" }))).toBe("fwd:a?b?c?d?e");
    expect(clientLabel(fake({ "user-agent": "แอป-x" }))).toBe("ua:???-x");
  });
});

describe("mcp_audit.client_label", () => {
  it("records fwd:/ua:/NULL from the request headers", async () => {
    await env.DB.prepare("UPDATE ai_clients SET rate_per_minute = 1000 WHERE client_id = ?").bind(C).run();
    await callWith({ "x-forwarded-user-agent": "chatgpt.com", "user-agent": "Cloudflare-MCP-Portal" }, "list_assets");
    await callWith({ "user-agent": "claude.ai" }, "list_assets");
    await callWith({}, "list_assets");
    await callWith({ "user-agent": "x".repeat(500) }, "list_assets");
    expect(await labels()).toEqual(["fwd:chatgpt.com", "ua:claude.ai", null, `ua:${"x".repeat(120)}`]);
  });

  it("a ChatGPT-looking label grants no extra scope and no extra rate (display only)", async () => {
    const claimed = { "x-forwarded-user-agent": "ChatGPT", "user-agent": "openai-mcp/1.0 ChatGPT" };
    // Client row is read-only: propose_* stays insufficient_scope with or without the label.
    const propose = { asset_id: "no-such-asset", event_type: "flood" };
    expect(await callWith(claimed, "propose_disaster_prep", propose)).toBe("insufficient_scope");
    // rate_per_minute = 1 (already used by the call above): the next call is limited, label or not.
    expect(await callWith(claimed, "list_assets")).toBe("rate_limited");
    expect(await callWith({}, "list_assets")).toBe("rate_limited");
    await env.DB.prepare("DELETE FROM mcp_audit").run();
    expect(await callWith({}, "propose_disaster_prep", propose)).toBe("insufficient_scope");
    expect(await callWith({}, "list_assets")).toBe("rate_limited");
    expect(await callWith(claimed, "list_assets")).toBe("rate_limited");
  });
});
