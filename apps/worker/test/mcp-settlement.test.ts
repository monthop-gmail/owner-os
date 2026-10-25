import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import fixtureJson from "../fixtures/demo-seed.json";
import { app } from "../src/index";
import { resetAccessCertsCache } from "../src/mcp/access-jwt";
import { internalPreviewPost } from "../src/mcp/server";
import { seedDemo, type DemoFixture } from "../src/seed/demo";
import { authHeader, TEST_API_TOKEN } from "./d1";
import { call, env, flushWaitUntil, obtainToken, setupOAuthHarness, teardownOAuthHarness } from "./mcp-helpers";

type ToolResult = { content: { type: string; text: string }[]; structuredContent?: Record<string, unknown>; isError?: boolean };
type Scenario = {
  label: string;
  inputs_used?: Record<string, unknown>;
  owner_payout_thb?: number;
  operator_payout_thb?: number;
  disaster_clause_applied?: boolean;
  error?: string;
};
type WhatIf = { base: Record<string, unknown>; scenarios: Scenario[]; rules_status: string; note: string };

let accessToken: string;
let durianAssetId: string;
let durianContractId: string;

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
  await env.DB.prepare("UPDATE ai_clients SET rate_per_minute = 100000, rate_per_day = 100000 WHERE client_id IS NOT NULL").run();

  const { assets } = (await apiGet("/api/assets")) as { assets: { id: string; name: string }[] };
  durianAssetId = assets.find((a) => a.name.includes("ทุเรียน"))!.id;
  const { contracts } = (await apiGet(`/api/assets/${durianAssetId}/contracts`)) as {
    contracts: { id: string; contract_type: string; terms: { opex_borne_by?: string } }[];
  };
  const durian = contracts.find((c) => c.contract_type === "fixed_target_bonus")!;
  expect(durian.terms.opex_borne_by).toBe("operator_reimbursed");
  durianContractId = durian.id;
}, 60_000);

beforeEach(() => resetAccessCertsCache());

afterAll(teardownOAuthHarness);

async function apiGet(path: string): Promise<unknown> {
  const res = await app.request(path, { headers: authHeader }, env);
  expect(res.status).toBe(200);
  return res.json();
}

async function apiPost(path: string, body: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await app.request(
    path,
    { method: "POST", headers: { ...authHeader, "content-type": "application/json" }, body: JSON.stringify(body) },
    env,
  );
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function callTool(name: string, args: unknown): Promise<ToolResult> {
  const res = await call("/mcp", {
    method: "POST",
    headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
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

const whatIf = (r: ToolResult) => r.structuredContent as unknown as WhatIf;

describe("settlement_preview", () => {
  it("durian (fixed target · operator_reimbursed): 300,000 / 40,000 equals REST → owner 260,000 · operator 0", async () => {
    const input = { revenue_thb: 300_000, opex_thb: 40_000 };
    const result = await callTool("settlement_preview", { contract_id: durianContractId, ...input });
    expect(result.isError).toBeUndefined();
    const rest = await apiPost(`/api/contracts/${durianContractId}/settlement-preview`, input);
    expect(rest.status).toBe(200);
    expect(result.structuredContent).toEqual(rest.body);
    expect(result.structuredContent).toMatchObject({
      owner_payout_thb: 260_000,
      operator_payout_thb: 0,
      rules_status: "draft_unconfirmed",
    });
  });

  it.each(["..", "../assets", "a/b", "x?y=1", "", "a".repeat(65)])(
    "malformed contract_id %j → validation_error without an internal request",
    async (contractId) => {
      const spy = vi.spyOn(app, "request");
      try {
        expect(errorCode(await callTool("settlement_preview", { contract_id: contractId, revenue_thb: 1, opex_thb: 0 }))).toBe(
          "validation_error",
        );
        expect(spy).not.toHaveBeenCalled();
      } finally {
        spy.mockRestore();
      }
    },
  );

  it.each([
    ["unknown key", { revenue_thb: 1, opex_thb: 0, owner_payout_thb: 999 }],
    ["string number", { revenue_thb: "300000", opex_thb: 0 }],
    ["bad crop_cycle_id", { crop_cycle_id: "../x", opex_thb: 0 }],
    ["bad jobs", { jobs: [{ job_key: "x", quantity: 1, price: 5 }] }],
  ])("%s → validation_error without an internal request", async (_name, extra) => {
    const spy = vi.spyOn(app, "request");
    try {
      expect(errorCode(await callTool("settlement_preview", { contract_id: durianContractId, ...extra }))).toBe("validation_error");
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it("route errors come back as isError with the API's code", async () => {
    expect(errorCode(await callTool("settlement_preview", { contract_id: "no-such-contract", revenue_thb: 1, opex_thb: 0 }))).toBe(
      "contract_not_found",
    );
    // Missing opex_thb is rejected by the route's own schema for this contract type.
    expect(errorCode(await callTool("settlement_preview", { contract_id: durianContractId, revenue_thb: 1 }))).toBe(
      "validation_error",
    );
  });
});

describe("settlement_what_if", () => {
  it("durian price drops −10/−20/−30% from 420,000 (opex 40,000)", async () => {
    const result = await callTool("settlement_what_if", {
      contract_id: durianContractId,
      base: { revenue_thb: 420_000, opex_thb: 40_000 },
      scenarios: [
        { label: "ราคาตก 10%", revenue_change_pct: -10 },
        { label: "ราคาตก 20%", revenue_change_pct: -20 },
        { label: "ราคาตก 30%", revenue_change_pct: -30 },
      ],
    });
    expect(result.isError).toBeUndefined();
    const out = whatIf(result);
    expect(out.rules_status).toBe("draft_unconfirmed");
    expect(out.note).toContain("draft_unconfirmed");
    expect(out.base).toMatchObject({ owner_payout_thb: 350_000, operator_payout_thb: 30_000, rules_status: "draft_unconfirmed" });
    expect(out.scenarios.map((s) => [s.label, s.inputs_used?.revenue_thb, s.owner_payout_thb, s.operator_payout_thb])).toEqual([
      ["ราคาตก 10%", 378_000, 338_000, 0],
      ["ราคาตก 20%", 336_000, 296_000, 0],
      ["ราคาตก 30%", 294_000, 254_000, 0],
    ]);
    expect(out.scenarios.every((s) => s.disaster_clause_applied === false)).toBe(true);
  });

  it("rounds a scaled amount to satang once", async () => {
    const out = whatIf(
      await callTool("settlement_what_if", {
        contract_id: durianContractId,
        base: { revenue_thb: 100_000.01, opex_thb: 33_333.33 },
        scenarios: [{ label: "odd", revenue_change_pct: -33.333, opex_change_pct: 7.5 }],
      }),
    );
    // 10,000,001 satang × 0.66667 = 6,666,700.67 → 6,666,701; 3,333,333 × 1.075 = 3,583,332.975 → 3,583,333.
    expect(out.scenarios[0]?.inputs_used).toMatchObject({ revenue_thb: 66_667.01, opex_thb: 35_833.33 });
  });

  it("damage 50% + insurance uses the disaster clause", async () => {
    const out = whatIf(
      await callTool("settlement_what_if", {
        contract_id: durianContractId,
        base: { revenue_thb: 420_000, opex_thb: 40_000 },
        scenarios: [
          { label: "พายุ 50% + ประกัน", revenue_change_pct: -50, damage_pct: 50, insurance_thb: 100_000 },
          { label: "ปกติ" },
        ],
      }),
    );
    expect(out.scenarios[0]).toMatchObject({ disaster_clause_applied: true, inputs_used: { damage_pct: 50, insurance_thb: 100_000 } });
    expect(out.scenarios[1]).toMatchObject({ disaster_clause_applied: false, owner_payout_thb: 350_000 });
  });

  it("a bad scenario carries its own error; the others still compute", async () => {
    const out = whatIf(
      await callTool("settlement_what_if", {
        contract_id: durianContractId,
        base: { revenue_thb: 420_000, opex_thb: 40_000 },
        scenarios: [{ label: "ประกันเกินเพดาน", insurance_thb: 1e12 }, { label: "ราคาตก 10%", revenue_change_pct: -10 }],
      }),
    );
    expect(out.scenarios[0]).toMatchObject({ label: "ประกันเกินเพดาน", error: "validation_error" });
    expect(out.scenarios[1]).toMatchObject({ owner_payout_thb: 338_000, operator_payout_thb: 0 });
  });

  it("base with crop_cycle_id: revenue scenarios send the cycle's real revenue as revenue_thb (never both)", async () => {
    const asset = (await apiGet(`/api/assets/${durianAssetId}`)) as { units: { id: string }[] };
    const created = await apiPost(`/api/units/${asset.units[0]!.id}/crop-cycles`, { crop: "ทุเรียน" });
    expect(created.status).toBe(201);
    const cycleId = ((created.body.crop_cycle as { id?: string } | undefined)?.id ?? created.body.id) as string;
    for (const to of ["growing", "harvesting"]) {
      expect((await apiPost(`/api/crop-cycles/${cycleId}/transition`, { to })).status).toBe(200);
    }
    const log = await apiPost(`/api/crop-cycles/${cycleId}/harvest-logs`, {
      harvested_at: new Date().toISOString(),
      weight_kg: 4000,
      unit_price_thb: 105,
    });
    expect(log.status).toBe(201);

    const spy = vi.spyOn(app, "request");
    let out: WhatIf;
    try {
      out = whatIf(
        await callTool("settlement_what_if", {
          contract_id: durianContractId,
          base: { crop_cycle_id: cycleId, opex_thb: 40_000 },
          scenarios: [{ label: "ราคาตก 10%", revenue_change_pct: -10 }, { label: "opex +10%", opex_change_pct: 10 }],
        }),
      );
      const bodies = spy.mock.calls
        .filter((c) => (c[1] as RequestInit | undefined)?.method === "POST")
        .map((c) => JSON.parse((c[1] as RequestInit).body as string) as Record<string, unknown>);
      expect(bodies.length).toBe(3);
      for (const body of bodies) expect("crop_cycle_id" in body && "revenue_thb" in body).toBe(false);
    } finally {
      spy.mockRestore();
    }
    expect(out.base).toMatchObject({ owner_payout_thb: 350_000, operator_payout_thb: 30_000 });
    expect((out.base.source as { revenue_from: string }).revenue_from).toBe("harvest_logs");
    expect(out.scenarios[0]?.inputs_used).toEqual({ opex_thb: 40_000, revenue_thb: 378_000 });
    expect(out.scenarios[0]).toMatchObject({ owner_payout_thb: 338_000, operator_payout_thb: 0 });
    // Only opex changes: the cycle id stays and the route keeps using the harvest logs.
    expect(out.scenarios[1]?.inputs_used).toEqual({ crop_cycle_id: cycleId, opex_thb: 44_000 });
    expect(out.scenarios[1]).toMatchObject({ owner_payout_thb: 350_000, operator_payout_thb: 26_000 });
  });

  it.each([
    ["no scenarios", { scenarios: [] }],
    ["11 scenarios", { scenarios: Array.from({ length: 11 }, (_, i) => ({ label: `s${i}` })) }],
    ["label too long", { scenarios: [{ label: "x".repeat(61) }] }],
    ["revenue change below −100", { scenarios: [{ label: "x", revenue_change_pct: -101 }] }],
    ["revenue change above 300", { scenarios: [{ label: "x", revenue_change_pct: 301 }] }],
    ["damage above 100", { scenarios: [{ label: "x", damage_pct: 101 }] }],
    ["unknown scenario key", { scenarios: [{ label: "x", owner_payout_thb: 1 }] }],
    ["contract_id inside base", { base: { revenue_thb: 1, opex_thb: 0, contract_id: "x" }, scenarios: [{ label: "x" }] }],
  ])("%s → validation_error without an internal request", async (_name, override) => {
    const spy = vi.spyOn(app, "request");
    try {
      const args = { contract_id: durianContractId, base: { revenue_thb: 420_000, opex_thb: 40_000 }, ...override };
      expect(errorCode(await callTool("settlement_what_if", args))).toBe("validation_error");
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});

describe("internalPreviewPost", () => {
  it.each([
    "/api/assets",
    `/api/contracts/x/settlement-preview/../../assets`,
    "/api/contracts/x/settlement-preview?y=1",
    "/api/contracts/../settlement-preview",
    "/api/contracts/x/settlement",
    "/api/tasks/x/complete",
  ])("refuses %s before sending", async (path) => {
    const spy = vi.spyOn(app, "request");
    try {
      expect(await internalPreviewPost(path, {}, { ...env, API_TOKEN: TEST_API_TOKEN })).toBeNull();
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});

describe("no side effects, audit and rate limit", () => {
  async function tableCounts(): Promise<Record<string, number>> {
    const { results } = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name",
    ).all<{ name: string }>();
    const counts: Record<string, number> = {};
    for (const { name } of results) {
      const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM "${name}"`).first<{ n: number }>();
      counts[name] = row?.n ?? 0;
    }
    return counts;
  }

  it("both tools change no table except one mcp_audit row per call", async () => {
    const before = await tableCounts();
    expect(Object.keys(before)).toEqual(expect.arrayContaining(["asset_contracts", "work_orders", "mcp_audit"]));
    await callTool("settlement_preview", { contract_id: durianContractId, revenue_thb: 300_000, opex_thb: 40_000 });
    await callTool("settlement_what_if", {
      contract_id: durianContractId,
      base: { revenue_thb: 420_000, opex_thb: 40_000 },
      scenarios: [{ label: "a", revenue_change_pct: -10 }, { label: "b", damage_pct: 50, insurance_thb: 1 }],
    });
    const after = await tableCounts();
    expect(after).toEqual({ ...before, mcp_audit: (before.mcp_audit ?? 0) + 2 });
  });

  it("one what-if (11 internal previews) is one audit row and one rate-limit unit", async () => {
    await env.DB.prepare("DELETE FROM mcp_audit").run();
    await env.DB.prepare("UPDATE ai_clients SET rate_per_minute = 2 WHERE client_id IS NOT NULL").run();
    try {
      const args = {
        contract_id: durianContractId,
        base: { revenue_thb: 420_000, opex_thb: 40_000 },
        scenarios: Array.from({ length: 10 }, (_, i) => ({ label: `−${i + 1}%`, revenue_change_pct: -(i + 1) })),
      };
      const spy = vi.spyOn(app, "request");
      let first: ToolResult;
      try {
        first = await callTool("settlement_what_if", args);
        expect(spy).toHaveBeenCalledTimes(11);
      } finally {
        spy.mockRestore();
      }
      expect(first.isError).toBeUndefined();
      expect(whatIf(first).scenarios).toHaveLength(10);
      const rows = await env.DB.prepare("SELECT tool, ok FROM mcp_audit").all();
      expect(rows.results).toEqual([{ tool: "settlement_what_if", ok: 1 }]);

      expect((await callTool("settlement_what_if", args)).isError).toBeUndefined(); // 2nd call: still within 2/min
      expect(errorCode(await callTool("settlement_what_if", args))).toBe("rate_limited"); // 3rd call
    } finally {
      await env.DB.prepare("UPDATE ai_clients SET rate_per_minute = 100000 WHERE client_id IS NOT NULL").run();
    }
  });
});
