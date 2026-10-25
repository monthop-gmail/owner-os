import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import fixtureJson from "../fixtures/demo-seed.json";
import { app } from "../src/index";
import { resetAccessCertsCache } from "../src/mcp/access-jwt";
import { MAX_PENDING_DRAFTS_PER_ASSET } from "../src/mcp/server";
import { seedDemo, type DemoFixture } from "../src/seed/demo";
import { authHeader, TEST_API_TOKEN } from "./d1";
import {
  authorizeQuery,
  call,
  env,
  flushWaitUntil,
  getConsent,
  obtainToken,
  OWNER,
  pkce,
  setupOAuthHarness,
  signJwt,
  teardownOAuthHarness,
} from "./mcp-helpers";

type ToolResult = { content: { type: string; text: string }[]; structuredContent?: Record<string, unknown>; isError?: boolean };
type Draft = { id: string; kind: string; asset_id: string; payload: Record<string, unknown>; status: string; result_ref: string | null };

let draftToken: string;
let durianId: string;
let durianUnits: string[];
let otherAssetId: string;

beforeAll(async () => {
  await setupOAuthHarness();
  resetAccessCertsCache();
  const summary = await seedDemo((path, init) => app.request(path, init, env), {
    token: TEST_API_TOKEN,
    fixture: fixtureJson as DemoFixture,
    now: new Date(),
  });
  expect(summary.failures).toEqual([]);
  draftToken = (await obtainToken("read offline_access draft")).access_token;
  await env.DB.prepare("UPDATE ai_clients SET rate_per_minute = 100000, rate_per_day = 100000 WHERE name = 'mcp-default'").run();

  const { assets } = (await api("GET", "/api/assets")).body as { assets: { id: string; name: string }[] };
  durianId = assets.find((a) => a.name.includes("ทุเรียน"))!.id;
  otherAssetId = assets.find((a) => a.id !== durianId)!.id;
  const durian = (await api("GET", `/api/assets/${durianId}`)).body as { units: { id: string }[] };
  durianUnits = durian.units.map((u) => u.id);
}, 60_000);

beforeEach(() => resetAccessCertsCache());

afterAll(teardownOAuthHarness);

/** Owner API (API_TOKEN). */
async function api(method: string, path: string, body?: unknown, headers: Record<string, string> = authHeader) {
  const res = await call(path, {
    method,
    headers: { ...headers, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, body: (await res.json().catch(() => null)) as Record<string, unknown> };
}

async function tool(name: string, args: unknown, token = draftToken): Promise<ToolResult> {
  const res = await call("/mcp", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  const body = (await res.json()) as { result?: ToolResult; error?: unknown };
  expect(body.error).toBeUndefined();
  await flushWaitUntil();
  return body.result!;
}

function errorCode(result: ToolResult): string {
  expect(result.isError).toBe(true);
  return (JSON.parse(result.content[0]!.text) as { error: string }).error;
}

async function count(table: string, where = "1 = 1", ...binds: unknown[]): Promise<number> {
  const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`)
    .bind(...binds)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

async function setCeiling(scopes: string): Promise<void> {
  await env.DB.prepare("UPDATE ai_clients SET scopes = ? WHERE name = 'mcp-default'").bind(scopes).run();
}

const eventArgs = (damage = 40) => ({
  asset_id: durianId,
  event_type: "storm",
  occurred_at: new Date(Date.now() - 6 * 3600_000).toISOString(),
  description: "พายุฤดูร้อน (ร่างจาก AI)",
  units: [{ unit_id: durianUnits[0]!, damage_pct: damage }],
});

async function proposeEvent(): Promise<string> {
  const result = await tool("propose_disaster_event", eventArgs());
  expect(result.isError).toBeUndefined();
  expect(result.structuredContent).toMatchObject({ status: "pending", message: "ร่างรอเจ้าของยืนยันในระบบ ยังไม่มีผลกับข้อมูลจริง" });
  return result.structuredContent!.draft_id as string;
}

describe("scope ceiling", () => {
  it("consent page explains the draft scope in Thai only when it is requested", async () => {
    const { challenge } = await pkce();
    const withDraft = await (await getConsent(authorizeQuery(challenge, "read draft"), await signJwt({}))).text();
    expect(withDraft).toContain("เสนอร่างให้เจ้าของยืนยัน (ไม่มีผลจนกว่าจะยืนยัน)");
    const readOnly = await (await getConsent(authorizeQuery(challenge, "read"), await signJwt({}))).text();
    expect(readOnly).toContain("อ่านข้อมูลอย่างเดียว");
    expect(readOnly).not.toContain("เสนอร่าง");
  });

  it("the default ceiling stays read: draft tools → insufficient_scope", async () => {
    const row = await env.DB.prepare("SELECT scopes FROM ai_clients WHERE name = 'mcp-default'").first<{ scopes: string }>();
    expect(row?.scopes).toBe("read");
    expect(errorCode(await tool("propose_disaster_event", eventArgs()))).toBe("insufficient_scope");
    expect(await count("ai_drafts")).toBe(0);
  });

  it("owner opens read,draft → draft tools work; a token without draft is still refused", async () => {
    await setCeiling("read,draft");
    // A new grant for the same user + client replaces the previous one, so the draft token is re-issued after.
    const readOnlyToken = (await obtainToken("read")).access_token;
    expect(errorCode(await tool("propose_disaster_event", eventArgs(), readOnlyToken))).toBe("insufficient_scope");
    draftToken = (await obtainToken("read offline_access draft")).access_token;
    await proposeEvent();
    expect(await count("ai_drafts", "status = 'pending'")).toBe(1);
  });

  it("draft tools are advertised as non-read-only, non-destructive", async () => {
    const res = await call("/mcp", {
      method: "POST",
      headers: { authorization: `Bearer ${draftToken}`, "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    const { tools } = ((await res.json()) as { result: { tools: { name: string; annotations: unknown }[] } }).result;
    for (const name of ["propose_disaster_event", "propose_disaster_prep", "propose_recovery_tasks"]) {
      expect(tools.find((t) => t.name === name)?.annotations).toEqual({ readOnlyHint: false, destructiveHint: false });
    }
  });
});

describe("disaster event drafts", () => {
  beforeAll(() => setCeiling("read,draft"));

  it("no disaster event until confirm; confirm creates exactly one and stores result_ref", async () => {
    const before = await count("disaster_events");
    const draftId = await proposeEvent();
    expect(await count("disaster_events")).toBe(before);

    const confirmed = await api("POST", `/api/ai-drafts/${draftId}/confirm`);
    expect(confirmed.status).toBe(200);
    const draft = confirmed.body.draft as Draft;
    expect(draft).toMatchObject({ status: "confirmed", kind: "disaster_event" });
    expect(await count("disaster_events")).toBe(before + 1);
    expect(draft.result_ref).toBe((confirmed.body.result as { id: string }).id);
    expect(await count("disaster_events", "id = ? AND asset_id = ?", draft.result_ref, durianId)).toBe(1);
    expect(await count("disaster_event_units", "event_id = ?", draft.result_ref)).toBe(1);

    expect((await api("POST", `/api/ai-drafts/${draftId}/confirm`)).status).toBe(409);
    expect(await count("disaster_events")).toBe(before + 1);
  });

  it("two concurrent confirms: one 200, one 409, one event", async () => {
    const draftId = await proposeEvent();
    const before = await count("disaster_events");
    const results = await Promise.all([
      api("POST", `/api/ai-drafts/${draftId}/confirm`),
      api("POST", `/api/ai-drafts/${draftId}/confirm`),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(await count("disaster_events")).toBe(before + 1);
  });

  it("reject has no effect; confirm or reject afterwards → 409", async () => {
    const draftId = await proposeEvent();
    const before = await count("disaster_events");
    const rejected = await api("POST", `/api/ai-drafts/${draftId}/reject`, { note: "ไม่ใช่พายุ แค่ลมแรง" });
    expect(rejected.status).toBe(200);
    expect(rejected.body.draft).toMatchObject({ status: "rejected", decision_note: "ไม่ใช่พายุ แค่ลมแรง" });
    expect((await api("POST", `/api/ai-drafts/${draftId}/confirm`)).status).toBe(409);
    expect((await api("POST", `/api/ai-drafts/${draftId}/reject`)).status).toBe(409);
    expect(await count("disaster_events")).toBe(before);
    expect((await api("POST", "/api/ai-drafts/no-such-draft/confirm")).status).toBe(404);
  });

  it("invalid proposals store nothing", async () => {
    const before = await count("ai_drafts");
    expect(errorCode(await tool("propose_disaster_event", eventArgs(150)))).toBe("validation_error");
    expect(errorCode(await tool("propose_disaster_event", { ...eventArgs(), extra: 1 }))).toBe("validation_error");
    expect(errorCode(await tool("propose_disaster_event", { ...eventArgs(), asset_id: "../x" }))).toBe("validation_error");
    const otherUnits = ((await api("GET", `/api/assets/${otherAssetId}`)).body as { units: { id: string }[] }).units;
    expect(
      errorCode(await tool("propose_disaster_event", { ...eventArgs(), units: [{ unit_id: otherUnits[0]!.id, damage_pct: 10 }] })),
    ).toBe("unit_not_in_asset");
    expect(errorCode(await tool("propose_disaster_event", { ...eventArgs(), asset_id: "no-such-asset" }))).toBe("asset_not_found");
    expect(await count("ai_drafts")).toBe(before);
  });
});

describe("prep and recovery drafts", () => {
  beforeAll(() => setCeiling("read,draft"));

  it("propose_disaster_prep → confirm creates prep work orders; result_ref lists them", async () => {
    const before = await count("work_orders", "asset_id = ?", durianId);
    const result = await tool("propose_disaster_prep", { asset_id: durianId, event_type: "storm" });
    expect(result.isError).toBeUndefined();
    expect(await count("work_orders", "asset_id = ?", durianId)).toBe(before);
    const confirmed = await api("POST", `/api/ai-drafts/${result.structuredContent!.draft_id as string}/confirm`);
    expect(confirmed.status).toBe(200);
    const created = (confirmed.body.result as { created_work_orders: { id: string }[] }).created_work_orders;
    expect(created.length).toBeGreaterThan(0);
    expect(await count("work_orders", "asset_id = ?", durianId)).toBe(before + created.length);
    expect(JSON.parse((confirmed.body.draft as Draft).result_ref!)).toEqual(created.map((w) => w.id));
    expect(errorCode(await tool("propose_disaster_prep", { asset_id: durianId, event_type: "meteor" }))).toBe("validation_error");
  });

  it("recovery: stale draft fails with the route's error and returns to pending; re-proposing is refused", async () => {
    const confirmed = await api("POST", `/api/ai-drafts/${await proposeEvent()}/confirm`);
    const eventId = (confirmed.body.draft as Draft).result_ref!;

    const first = await tool("propose_recovery_tasks", { disaster_event_id: eventId });
    const second = await tool("propose_recovery_tasks", { disaster_event_id: eventId });
    expect(first.isError).toBeUndefined();
    expect(second.isError).toBeUndefined();
    const workOrdersBefore = await count("work_orders", "disaster_event_id = ?", eventId);
    expect(workOrdersBefore).toBe(0);

    const ok = await api("POST", `/api/ai-drafts/${first.structuredContent!.draft_id as string}/confirm`);
    expect(ok.status).toBe(200);
    expect((ok.body.draft as Draft).result_ref).toBe(eventId);
    const created = await count("work_orders", "disaster_event_id = ?", eventId);
    expect(created).toBeGreaterThan(0);

    // Tasks now exist: proposing again is refused …
    expect(errorCode(await tool("propose_recovery_tasks", { disaster_event_id: eventId }))).toBe("recovery_tasks_already_created");
    // … and confirming the stale draft returns the existing route's error, and the draft is pending again.
    const staleId = second.structuredContent!.draft_id as string;
    const stale = await api("POST", `/api/ai-drafts/${staleId}/confirm`);
    expect(stale.status).toBe(409);
    expect(stale.body).toMatchObject({ error: "recovery_tasks_already_created" });
    const row = await env.DB.prepare("SELECT status, decided_at, result_ref FROM ai_drafts WHERE id = ?").bind(staleId).first();
    expect(row).toEqual({ status: "pending", decided_at: null, result_ref: null });
    expect(await count("work_orders", "disaster_event_id = ?", eventId)).toBe(created);
    expect(errorCode(await tool("propose_recovery_tasks", { disaster_event_id: "no-such-event" }))).toBe("disaster_event_not_found");
  });
});

describe("owner API", () => {
  beforeAll(() => setCeiling("read,draft"));

  it("MCP tokens cannot reach /api/ai-drafts", async () => {
    const draftId = await proposeEvent();
    const mcpAuth = { authorization: `Bearer ${draftToken}` };
    expect((await api("GET", "/api/ai-drafts", undefined, mcpAuth)).status).toBe(401);
    expect((await api("POST", `/api/ai-drafts/${draftId}/confirm`, undefined, mcpAuth)).status).toBe(401);
    expect((await api("POST", `/api/ai-drafts/${draftId}/reject`, {}, mcpAuth)).status).toBe(401);
    expect(await count("ai_drafts", "id = ? AND status = 'pending'", draftId)).toBe(1);
  });

  it("lists drafts by status and asset without emails or user hashes", async () => {
    const { status, body } = await api("GET", `/api/ai-drafts?status=pending&asset_id=${durianId}`);
    expect(status).toBe(200);
    const drafts = body.drafts as Draft[];
    expect(drafts.length).toBe(await count("ai_drafts", "status = 'pending' AND asset_id = ?", durianId));
    expect(drafts.every((d) => d.status === "pending" && d.asset_id === durianId)).toBe(true);
    expect(drafts[0]?.payload).toBeTypeOf("object");
    const text = JSON.stringify(body);
    expect(text).not.toContain(OWNER);
    expect(text).not.toContain("created_by_user_hash");
    expect((await api("GET", "/api/ai-drafts?status=maybe")).status).toBe(400);
    expect((await api("POST", `/api/ai-drafts/${drafts[0]!.id}/reject`, { note: "", x: 1 })).status).toBe(400);
  });
});

describe("limits", () => {
  beforeAll(() => setCeiling("read,draft"));

  it("draft tools fail closed when the rate check fails; read tools keep working", async () => {
    const before = await count("ai_drafts");
    await env.DB.prepare("ALTER TABLE mcp_audit RENAME TO mcp_audit_off").run();
    try {
      expect(errorCode(await tool("propose_disaster_event", eventArgs()))).toBe("rate_check_unavailable");
      expect(errorCode(await tool("propose_disaster_prep", { asset_id: durianId, event_type: "flood" }))).toBe("rate_check_unavailable");
      expect((await tool("list_assets", {})).isError).toBeUndefined();
    } finally {
      await env.DB.prepare("ALTER TABLE mcp_audit_off RENAME TO mcp_audit").run();
    }
    expect(await count("ai_drafts")).toBe(before);
  });

  it(`more than ${MAX_PENDING_DRAFTS_PER_ASSET} pending drafts per asset → too_many_pending_drafts`, async () => {
    // Pre-fill up to one below the cap directly (fast); the last allowed draft and the refused one go through the tool.
    const existing = await count("ai_drafts", "asset_id = ? AND status = 'pending'", otherAssetId);
    const fill = env.DB.prepare(
      "INSERT INTO ai_drafts (id, kind, asset_id, payload_json, status, created_at, created_by_user_hash, created_by_client_id) VALUES (?, 'disaster_prep', ?, '{\"event_type\":\"flood\"}', 'pending', ?, 'h', 'c')",
    );
    const missing = MAX_PENDING_DRAFTS_PER_ASSET - 1 - existing;
    if (missing > 0) await env.DB.batch(Array.from({ length: missing }, () => fill.bind(crypto.randomUUID(), otherAssetId, Date.now())));
    expect((await tool("propose_disaster_prep", { asset_id: otherAssetId, event_type: "flood" })).isError).toBeUndefined();
    expect(await count("ai_drafts", "asset_id = ? AND status = 'pending'", otherAssetId)).toBe(MAX_PENDING_DRAFTS_PER_ASSET);
    expect(errorCode(await tool("propose_disaster_prep", { asset_id: otherAssetId, event_type: "flood" }))).toBe(
      "too_many_pending_drafts",
    );
    expect(await count("ai_drafts", "asset_id = ? AND status = 'pending'", otherAssetId)).toBe(MAX_PENDING_DRAFTS_PER_ASSET);
    // Other assets are not affected.
    expect((await tool("propose_disaster_prep", { asset_id: durianId, event_type: "flood" })).isError).toBeUndefined();
  }, 30_000);

  afterAll(() => setCeiling("read"));
});
