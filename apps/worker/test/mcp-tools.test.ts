import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import fixtureJson from "../fixtures/demo-seed.json";
import { app } from "../src/index";
import { resetAccessCertsCache } from "../src/mcp/access-jwt";
import { apiPath, DEFAULT_PROTOCOL_VERSION, INSTRUCTIONS, isSafeInternalPath, mcpApiHandler } from "../src/mcp/server";
import { seedDemo, type DemoFixture } from "../src/seed/demo";
import { authHeader, TEST_API_TOKEN } from "./d1";
import { opaqueUserId } from "../src/mcp/oauth";
import { call, clientId, ctx, env, flushWaitUntil, obtainToken, OWNER, setupOAuthHarness, teardownOAuthHarness } from "./mcp-helpers";

type RpcBody = { jsonrpc: string; id: unknown; result?: Record<string, unknown>; error?: { code: number; message: string } };
type ToolResult = { content: { type: string; text: string }[]; structuredContent?: unknown; isError?: boolean };

let accessToken: string;
/** Every raw response body seen; checked for API_TOKEN leaks at the end. */
const seenBodies: string[] = [];

beforeAll(async () => {
  await setupOAuthHarness();
  resetAccessCertsCache();
  const summary = await seedDemo((path, init) => app.request(path, init, env), {
    token: TEST_API_TOKEN,
    fixture: fixtureJson as DemoFixture,
    now: new Date(),
  });
  expect(summary.failures).toEqual([]);
  accessToken = (await obtainToken()).access_token;
});

beforeEach(() => resetAccessCertsCache());

afterAll(async () => {
  // No response, of any kind, may carry the internal API token.
  expect(seenBodies.length).toBeGreaterThan(10);
  for (const body of seenBodies) expect(body).not.toContain(TEST_API_TOKEN);
  await teardownOAuthHarness();
});

async function mcpRaw(body: string, token = accessToken): Promise<Response> {
  const res = await call("/mcp", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
    body,
  });
  seenBodies.push(await res.clone().text());
  return res;
}

async function rpc(method: string, params?: unknown, id: number | string = 1): Promise<RpcBody> {
  const res = await mcpRaw(JSON.stringify({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) }));
  expect(res.headers.get("content-type")).toMatch(/^application\/json/);
  return res.json();
}

async function callTool(name: string, args?: unknown): Promise<ToolResult> {
  const body = await rpc("tools/call", { name, ...(args === undefined ? {} : { arguments: args }) });
  expect(body.error).toBeUndefined();
  return body.result as unknown as ToolResult;
}

function errorCode(result: ToolResult): string {
  expect(result.isError).toBe(true);
  expect(result.structuredContent).toBeUndefined();
  return (JSON.parse(result.content[0]?.text ?? "{}") as { error: string }).error;
}

async function apiGet(path: string): Promise<unknown> {
  const res = await app.request(path, { headers: authHeader }, env);
  expect(res.status).toBe(200);
  return res.json();
}

describe("JSON-RPC lifecycle", () => {
  it("initialize echoes a supported protocolVersion", async () => {
    const body = await rpc("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "0" } });
    expect(body).toMatchObject({ jsonrpc: "2.0", id: 1 });
    expect(body.result).toEqual({
      protocolVersion: "2025-03-26",
      capabilities: { tools: {} },
      serverInfo: { name: "owner-os", version: expect.any(String) },
      instructions: INSTRUCTIONS,
    });
    expect(INSTRUCTIONS).toContain("draft_unconfirmed");
  });

  it("initialize falls back to 2025-06-18 for an unsupported version", async () => {
    const body = await rpc("initialize", { protocolVersion: "1999-01-01" });
    expect(DEFAULT_PROTOCOL_VERSION).toBe("2025-06-18");
    expect(body.result?.protocolVersion).toBe("2025-06-18");
  });

  it("notifications/initialized → 202 with no body", async () => {
    const res = await mcpRaw(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }));
    expect(res.status).toBe(202);
    expect(await res.text()).toBe("");
  });

  it("ping → {}", async () => {
    expect(await rpc("ping", undefined, "p-1")).toEqual({ jsonrpc: "2.0", id: "p-1", result: {} });
  });

  it("unknown method → -32601", async () => {
    expect((await rpc("resources/list")).error?.code).toBe(-32601);
  });

  it("invalid JSON → -32700", async () => {
    const res = await mcpRaw("{not json");
    expect(((await res.json()) as RpcBody).error?.code).toBe(-32700);
  });

  it("batch → -32600", async () => {
    const res = await mcpRaw(JSON.stringify([{ jsonrpc: "2.0", id: 1, method: "ping" }]));
    expect(((await res.json()) as RpcBody).error?.code).toBe(-32600);
  });

  it.each([
    ["wrong jsonrpc", { jsonrpc: "1.0", id: 1, method: "ping" }],
    ["missing method", { jsonrpc: "2.0", id: 1 }],
    ["null id", { jsonrpc: "2.0", id: null, method: "ping" }],
    ["non-object", "ping"],
  ])("invalid request (%s) → -32600", async (_name, body) => {
    const res = await mcpRaw(JSON.stringify(body));
    expect(((await res.json()) as RpcBody).error?.code).toBe(-32600);
  });
});

describe("tools", () => {
  it("tools/list has the five read-only tools", async () => {
    const tools = (await rpc("tools/list")).result?.tools as { name: string; annotations: unknown; inputSchema: Record<string, unknown> }[];
    expect(tools.map((t) => t.name)).toEqual(["list_assets", "get_asset", "list_work_orders", "get_work_order", "list_evidence"]);
    for (const t of tools) {
      expect(t.annotations).toEqual({ readOnlyHint: true });
      expect(t.inputSchema).toMatchObject({ type: "object", additionalProperties: false });
    }
    expect(tools[1]?.inputSchema.required).toEqual(["asset_id"]);
  });

  it("list_assets equals GET /api/assets field for field", async () => {
    const result = await callTool("list_assets", {});
    expect(result.isError).toBeUndefined();
    const expected = await apiGet("/api/assets");
    expect(result.structuredContent).toEqual(expected);
    expect(JSON.parse(result.content[0]?.text ?? "")).toEqual(expected);
    expect((expected as { assets: unknown[] }).assets).toHaveLength(4);
  });

  it("get_asset (durian) equals GET /api/assets/:id", async () => {
    const { assets: list } = (await apiGet("/api/assets")) as { assets: { id: string; name: string }[] };
    const durian = list.find((a) => a.name.includes("ทุเรียน"));
    expect(durian).toBeDefined();
    const result = await callTool("get_asset", { asset_id: durian!.id });
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toEqual(await apiGet(`/api/assets/${durian!.id}`));
  });

  it("get_asset with an unknown id → isError asset_not_found", async () => {
    expect(errorCode(await callTool("get_asset", { asset_id: "no-such-asset" }))).toBe("asset_not_found");
  });

  it.each([
    ["get_asset", undefined],
    ["get_asset", {}],
    ["get_asset", { asset_id: 42 }],
    ["get_asset", { asset_id: "" }],
    ["get_asset", { asset_id: "x", extra: true }],
    ["get_asset", ["x"]],
    ["list_assets", { unexpected: 1 }],
  ])("%s with bad arguments %j → isError validation_error", async (name, args) => {
    expect(errorCode(await callTool(name, args))).toBe("validation_error");
  });

  it("unknown tool → -32602", async () => {
    expect((await rpc("tools/call", { name: "delete_asset", arguments: {} })).error?.code).toBe(-32602);
  });

  it("API_TOKEN not set → isError server_not_configured", async () => {
    const res = await mcpApiHandler.fetch(
      new Request("http://localhost/mcp", {
        method: "POST",
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "list_assets" } }),
      }),
      { ...env, API_TOKEN: undefined },
      Object.assign(Object.create(ctx) as ExecutionContext, { auth: { scope: ["read"] } }),
    );
    const body = (await res.json()) as RpcBody;
    expect(errorCode(body.result as unknown as ToolResult)).toBe("server_not_configured");
  });
});

describe("scope and revocation", () => {
  it("a token without read → isError insufficient_scope", async () => {
    const res = await mcpApiHandler.fetch(
      new Request("http://localhost/mcp", {
        method: "POST",
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "list_assets" } }),
      }),
      env,
      Object.assign(Object.create(ctx) as ExecutionContext, { auth: { scope: ["offline_access"] } }),
    );
    const text = await res.clone().text();
    seenBodies.push(text);
    expect(errorCode((JSON.parse(text) as RpcBody).result as unknown as ToolResult)).toBe("insufficient_scope");
  });

  it("read removed from the mcp-default row → isError insufficient_scope (token ∩ row)", async () => {
    await env.DB.prepare("UPDATE ai_clients SET scopes = '' WHERE name = 'mcp-default'").run();
    try {
      expect(errorCode(await callTool("list_assets"))).toBe("insufficient_scope");
    } finally {
      await env.DB.prepare("UPDATE ai_clients SET scopes = 'read' WHERE name = 'mcp-default'").run();
    }
  });

  it("revoked mcp-default → 401 for every method", async () => {
    await env.DB.prepare("UPDATE ai_clients SET revoked_at = ? WHERE name = 'mcp-default'").bind(Date.now()).run();
    try {
      for (const body of ['{"jsonrpc":"2.0","id":1,"method":"tools/list"}', "{bad json"]) {
        const res = await mcpRaw(body);
        expect(res.status).toBe(401);
        expect(res.headers.get("www-authenticate")).toMatch(/^Bearer/);
      }
    } finally {
      await env.DB.prepare("UPDATE ai_clients SET revoked_at = NULL WHERE name = 'mcp-default'").run();
    }
  });
});

describe("P2: tool arguments cannot steer the internal path", () => {
  it.each([".", "..", "../tasks/x", "a/b", "x?y=1", "", "%2e%2e", "a".repeat(65), " a", "a#b"])(
    "get_asset %j → validation_error without any internal request",
    async (assetId) => {
      const spy = vi.spyOn(app, "request");
      try {
        expect(errorCode(await callTool("get_asset", { asset_id: assetId }))).toBe("validation_error");
        expect(spy).not.toHaveBeenCalled();
      } finally {
        spy.mockRestore();
      }
    },
  );

  it("a valid id makes exactly one internal GET", async () => {
    const spy = vi.spyOn(app, "request");
    try {
      await callTool("get_asset", { asset_id: "A".repeat(64) });
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0]?.[0]).toBe(`/api/assets/${"A".repeat(64)}`);
      expect((spy.mock.calls[0]?.[1] as RequestInit).method).toBe("GET");
    } finally {
      spy.mockRestore();
    }
  });

  it("apiPath / isSafeInternalPath reject traversal and prefix escapes", () => {
    expect(apiPath("api", "assets")).toBe("/api/assets");
    expect(isSafeInternalPath("/api/assets/abc", "/api/assets")).toBe(true);
    expect(isSafeInternalPath("/api/assets/../tasks", "/api/assets")).toBe(false);
    expect(isSafeInternalPath("/api/assets/./x", "/api/assets")).toBe(false);
    expect(isSafeInternalPath("/api/assetsX", "/api/assets")).toBe(false);
    expect(isSafeInternalPath("//evil.example/api/assets", "/api/assets")).toBe(false);
    expect(isSafeInternalPath("/api/tasks/x", "/api/assets")).toBe(false);
  });
});

describe("work order and evidence tools", () => {
  async function durianId(): Promise<string> {
    const { assets } = (await apiGet("/api/assets")) as { assets: { id: string; name: string }[] };
    return assets.find((a) => a.name.includes("ทุเรียน"))!.id;
  }

  it("list_work_orders equals REST, with and without status", async () => {
    const id = await durianId();
    const all = await callTool("list_work_orders", { asset_id: id });
    const expected = (await apiGet(`/api/assets/${id}/work-orders`)) as { work_orders: unknown[] };
    expect(all.structuredContent).toEqual(expected);
    expect(expected.work_orders.length).toBeGreaterThan(0);
    const submitted = await callTool("list_work_orders", { asset_id: id, status: "submitted" });
    expect(submitted.structuredContent).toEqual(await apiGet(`/api/assets/${id}/work-orders?status=submitted`));
  });

  it("list_work_orders rejects bad status / unknown asset", async () => {
    expect(errorCode(await callTool("list_work_orders", { asset_id: "x", status: "done" }))).toBe("validation_error");
    expect(errorCode(await callTool("list_work_orders", { asset_id: "x", status: "open&a=b" }))).toBe("validation_error");
    expect(errorCode(await callTool("list_work_orders", { status: "open" }))).toBe("validation_error");
    expect(errorCode(await callTool("list_work_orders", { asset_id: "nope" }))).toBe("asset_not_found");
  });

  it("get_work_order equals GET /api/tasks/:id (evidence metadata only)", async () => {
    const id = await durianId();
    const { work_orders } = (await apiGet(`/api/assets/${id}/work-orders?status=submitted`)) as {
      work_orders: { id: string }[];
    };
    const woId = work_orders[0]!.id;
    const result = await callTool("get_work_order", { work_order_id: woId });
    const expected = (await apiGet(`/api/tasks/${woId}`)) as { evidence: unknown[] };
    expect(result.structuredContent).toEqual(expected);
    expect(expected.evidence.length).toBeGreaterThan(0);
    expect(errorCode(await callTool("get_work_order", { work_order_id: "../assets" }))).toBe("validation_error");
  });

  it("list_evidence equals REST for default, asset filter and limit", async () => {
    const id = await durianId();
    expect((await callTool("list_evidence")).structuredContent).toEqual(await apiGet("/api/evidence?limit=50"));
    expect((await callTool("list_evidence", { asset_id: id, limit: 1 })).structuredContent).toEqual(
      await apiGet(`/api/evidence?asset_id=${id}&limit=1`),
    );
    const all = (await apiGet("/api/evidence")) as { evidence: unknown[] };
    expect(all.evidence.length).toBe(3);
    for (const limit of [0, 101, 1.5, "10"]) {
      expect(errorCode(await callTool("list_evidence", { limit }))).toBe("validation_error");
    }
    expect(errorCode(await callTool("list_evidence", { asset_id: "a/b" }))).toBe("validation_error");
  });

  it("list_evidence description says coordinates are field-reported", async () => {
    const tools = (await rpc("tools/list")).result?.tools as { name: string; description: string }[];
    expect(tools.find((t) => t.name === "list_evidence")?.description).toContain("ค่าที่ภาคสนามแจ้ง");
    expect(tools.some((t) => /image|slip/i.test(t.name))).toBe(false);
  });
});

describe("mcp_audit", () => {
  it("writes one row per tools/call with ok/error_code and no arguments or emails", async () => {
    await flushWaitUntil();
    await env.DB.prepare("DELETE FROM mcp_audit").run();
    const id = (await apiGet("/api/assets")) as { assets: { id: string }[] };
    const assetId = id.assets[0]!.id;
    await callTool("list_assets");
    await callTool("get_asset", { asset_id: assetId });
    await callTool("get_asset", { asset_id: "../tasks" });
    await flushWaitUntil();

    const { results } = await env.DB.prepare("SELECT * FROM mcp_audit ORDER BY at, rowid").all<Record<string, unknown>>();
    expect(results.map((r) => [r.tool, r.ok, r.error_code])).toEqual([
      ["list_assets", 1, null],
      ["get_asset", 1, null],
      ["get_asset", 0, "validation_error"],
    ]);
    const userHash = await opaqueUserId(OWNER);
    for (const row of results) {
      expect(row.user_hash).toBe(userHash);
      expect(row.client_id).toBe(clientId);
      expect(typeof row.ms).toBe("number");
      const text = JSON.stringify(row);
      expect(text).not.toContain(OWNER);
      expect(text).not.toContain("@");
      expect(text).not.toContain(assetId);
      expect(text).not.toContain("../tasks");
    }
  });

  it("an audit write failure does not fail the tool", async () => {
    await env.DB.prepare("ALTER TABLE mcp_audit RENAME TO mcp_audit_off").run();
    try {
      const result = await callTool("list_assets");
      await flushWaitUntil();
      expect(result.isError).toBeUndefined();
    } finally {
      await env.DB.prepare("ALTER TABLE mcp_audit_off RENAME TO mcp_audit").run();
    }
  });
});
