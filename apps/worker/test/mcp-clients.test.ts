import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { resetAccessCertsCache } from "../src/mcp/access-jwt";
import { mcpApiHandler } from "../src/mcp/server";
import { clientId, ctx, env, flushWaitUntil, obtainToken, setupOAuthHarness, teardownOAuthHarness } from "./mcp-helpers";

// Per-DCR-client rows in ai_clients: effective scopes = token ∩ global `mcp-default` ∩ client row.
const A = "client-a";
const B = "client-b";
const ALL = ["read", "draft", "offline_access"];

beforeAll(async () => {
  await setupOAuthHarness();
}, 60_000);
beforeEach(async () => {
  resetAccessCertsCache();
  await flushWaitUntil();
  await env.DB.prepare("DELETE FROM mcp_audit").run();
  await env.DB.prepare("DELETE FROM ai_clients WHERE client_id IN (?, ?)").bind(A, B).run();
  const insert = env.DB.prepare(
    "INSERT INTO ai_clients (name, scopes, client_id, rate_per_minute, rate_per_day, created_at) VALUES (?, ?, ?, 1000, 1000, 0)",
  );
  await env.DB.batch([insert.bind(`client:${A}`, "read,draft", A), insert.bind(`client:${B}`, "read", B)]);
  await env.DB.prepare("UPDATE ai_clients SET scopes = 'read,draft', revoked_at = NULL WHERE name = 'mcp-default'").run();
});
afterAll(async () => {
  await env.DB.prepare("UPDATE ai_clients SET scopes = 'read', revoked_at = NULL WHERE name = 'mcp-default'").run();
  await teardownOAuthHarness();
});

async function callAs(client: string | undefined, name: string, args: unknown = {}): Promise<{ status: number; error?: string }> {
  const res = await mcpApiHandler.fetch(
    new Request("http://localhost/mcp", {
      method: "POST",
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
    }),
    env,
    Object.assign(Object.create(ctx) as ExecutionContext, { auth: { scope: ALL, clientId: client, userId: "u" } }),
  );
  await flushWaitUntil();
  if (res.status !== 200) return { status: res.status };
  const body = (await res.json()) as { result: { isError?: boolean; content: { text: string }[] } };
  return { status: 200, error: body.result.isError ? (JSON.parse(body.result.content[0]!.text) as { error: string }).error : undefined };
}

// A propose_* call that passes the scope check fails later on the unknown asset: that proves scope was granted.
const propose = (client: string | undefined) =>
  callAs(client, "propose_disaster_prep", { asset_id: "no-such-asset", event_type: "flood" });

const revoke = (where: string, ...binds: unknown[]) =>
  env.DB.prepare(`UPDATE ai_clients SET revoked_at = ? WHERE ${where}`).bind(Date.now(), ...binds).run();

describe("per-client ceilings", () => {
  it("A (read,draft) may propose; B (read) gets insufficient_scope; both may read", async () => {
    expect(await propose(A)).toEqual({ status: 200, error: "asset_not_found" });
    expect(await propose(B)).toEqual({ status: 200, error: "insufficient_scope" });
    expect(await callAs(A, "list_assets")).toEqual({ status: 200 });
    expect(await callAs(B, "list_assets")).toEqual({ status: 200 });
  });

  it("the global ceiling still applies: global read + A read,draft → A cannot propose", async () => {
    await env.DB.prepare("UPDATE ai_clients SET scopes = 'read' WHERE name = 'mcp-default'").run();
    expect(await propose(A)).toEqual({ status: 200, error: "insufficient_scope" });
  });

  it("revoking A refuses A only", async () => {
    await revoke("client_id = ?", A);
    expect(await callAs(A, "list_assets")).toEqual({ status: 401 });
    expect(await callAs(B, "list_assets")).toEqual({ status: 200 });
  });

  it("revoking the global row refuses every client", async () => {
    await revoke("name = 'mcp-default'");
    expect(await callAs(A, "list_assets")).toEqual({ status: 401 });
    expect(await callAs(B, "list_assets")).toEqual({ status: 401 });
  });

  it("a client without a row (or without a client id) is refused — no fallback to the global row", async () => {
    expect(await callAs("client-unknown", "list_assets")).toEqual({ status: 401 });
    expect(await callAs(undefined, "list_assets")).toEqual({ status: 401 });
  });

  it("rate limits come from the client row: A at 1/min is limited on the 2nd call, B is not", async () => {
    await env.DB.prepare("UPDATE ai_clients SET rate_per_minute = 1 WHERE client_id = ?").bind(A).run();
    expect(await callAs(A, "list_assets")).toEqual({ status: 200 });
    expect(await callAs(A, "list_assets")).toEqual({ status: 200, error: "rate_limited" });
    for (let i = 0; i < 3; i++) expect(await callAs(B, "list_assets")).toEqual({ status: 200 });
  });
});

describe("client row created on consent approval", () => {
  const row = () =>
    env.DB.prepare("SELECT name, scopes, client_id, revoked_at FROM ai_clients WHERE client_id = ?").bind(clientId).first();

  it("approve creates client:<id> with scope read, and never overwrites an existing row", async () => {
    await env.DB.prepare("DELETE FROM ai_clients WHERE client_id = ?").bind(clientId).run();
    await obtainToken("read offline_access draft");
    expect(await row()).toEqual({ name: `client:${clientId}`, scopes: "read", client_id: clientId, revoked_at: null });

    await env.DB.prepare("UPDATE ai_clients SET scopes = 'read,draft' WHERE client_id = ?").bind(clientId).run();
    await obtainToken("read offline_access draft"); // approve again
    expect(await row()).toMatchObject({ scopes: "read,draft" });
  });
});
