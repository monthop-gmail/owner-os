import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fixtureJson from "../fixtures/demo-seed.json";
import type { Env } from "../src/env";
import { app } from "../src/index";
import { planDemoSeed, seedDemo, tinyJpeg, type DemoFixture, type SeedSummary } from "../src/seed/demo";
import { createTestEnv, TEST_API_TOKEN, type TestEnv } from "./d1";

const fixture = fixtureJson as DemoFixture;

let testEnv: TestEnv;
let env: Env;

beforeAll(async () => {
  testEnv = await createTestEnv();
  env = testEnv.env;
});

afterAll(async () => {
  await testEnv?.dispose();
});

const fetchFn = (path: string, init: RequestInit) => app.request(path, init, env);

async function countRows(table: string, where = "1 = 1"): Promise<number> {
  const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`).first<{ n: number }>();
  return row?.n ?? 0;
}

describe("planDemoSeed (--dry-run)", () => {
  it("plans every request without writing anything", async () => {
    const steps = planDemoSeed(fixture);
    expect(steps.filter((s) => s.path === "/api/assets")).toHaveLength(4);
    expect(steps.filter((s) => s.path.endsWith("/contracts"))).toHaveLength(4);
    expect(steps.filter((s) => s.path.endsWith("/units"))).toHaveLength(4);
    expect(steps.filter((s) => s.path.endsWith("/work-orders"))).toHaveLength(5);
    expect(steps.filter((s) => s.path.endsWith("/complete"))).toHaveLength(3);
    expect(await countRows("assets")).toBe(0);
    expect(await countRows("work_orders")).toBe(0);
  });
});

describe("seedDemo through the API on local D1/R2", () => {
  let summary: SeedSummary;

  beforeAll(async () => {
    summary = await seedDemo(fetchFn, { token: TEST_API_TOKEN, fixture, now: new Date() });
  }, 30_000);

  it("reports a clean summary", () => {
    expect(summary).toEqual({ assets: 4, contracts: 4, units: 4, work_orders: 5, submitted: 3, failures: [] });
  });

  it("creates 4 assets and 4 units with server-computed area", async () => {
    expect(await countRows("assets")).toBe(4);
    expect(await countRows("asset_units")).toBe(4);
    const durian = await env.DB.prepare("SELECT area_m2 FROM asset_units WHERE name = ?")
      .bind("แปลงหมอนทอง โซน A")
      .first<{ area_m2: number }>();
    expect(Math.abs((durian?.area_m2 ?? 0) - 47_435) / 47_435).toBeLessThan(0.01);
  });

  it("creates 5 work orders: 3 submitted with in-fence evidence, 2 open", async () => {
    expect(await countRows("work_orders")).toBe(5);
    expect(await countRows("work_orders", "status = 'submitted'")).toBe(3);
    expect(await countRows("work_orders", "status = 'open'")).toBe(2);
    expect(await countRows("work_order_evidence")).toBe(3);
    expect(await countRows("work_order_evidence", "inside_geofence = 1 AND uploaded_at IS NOT NULL")).toBe(3);

    const keys = await env.DB.prepare("SELECT r2_key FROM work_order_evidence").all<{ r2_key: string }>();
    for (const { r2_key } of keys.results) {
      const obj = await env.BUCKET.get(r2_key);
      expect(new Uint8Array(await obj!.arrayBuffer())).toEqual(tinyJpeg());
    }
  });

  it("creates one active draft contract per asset with the team's terms", async () => {
    expect(await countRows("asset_contracts", "is_active = 1 AND rules_status = 'draft_unconfirmed'")).toBe(4);
    const rows = await env.DB.prepare(
      "SELECT a.name, c.contract_type, c.partner_label, c.terms_json FROM asset_contracts c JOIN assets a ON a.id = c.asset_id",
    ).all<{ name: string; contract_type: string; partner_label: string; terms_json: string }>();
    const byType = Object.fromEntries(rows.results.map((r) => [r.contract_type, { ...r, terms: JSON.parse(r.terms_json) }]));
    expect(Object.keys(byType).sort()).toEqual(["fixed_target_bonus", "pay_per_job", "property_management", "turnkey_profit_share"]);
    expect(byType.fixed_target_bonus!.terms).toMatchObject({ owner_target_revenue_satang: 35_000_000, excess_operator_bps: 10_000, opex_borne_by: "operator_reimbursed" });
    expect(byType.pay_per_job!.terms.rates.map((r: { job_key: string; rate_satang: number }) => [r.job_key, r.rate_satang])).toEqual([
      ["drone_spray", 12_000],
      ["harvester", 45_000],
    ]);
    expect(byType.turnkey_profit_share!.terms).toMatchObject({ owner_share_bps: 7000, operator_share_bps: 3000, management_retainer_monthly_satang: 500_000 });
    expect(byType.property_management!.terms).toEqual({
      contract_type: "property_management",
      revenue_commission_bps: 1500,
      cleaning_fee_per_turnover_satang: 80_000,
    });
    for (const r of rows.results) expect(r.partner_label).toMatch(/\(demo\)$/);
  });

  it("does not load the milestone 4 reference data", async () => {
    expect(await countRows("farm_crop_cycles")).toBe(0);
  });
});

describe("seedDemo failure handling", () => {
  it("stops at the first non-2xx response and reports it", async () => {
    let calls = 0;
    const result = await seedDemo(
      (path, init) => {
        calls++;
        return app.request(path, init, env);
      },
      { token: "wrong-token", fixture },
    );
    expect(calls).toBe(1);
    expect(result).toMatchObject({ assets: 0, contracts: 0, units: 0, work_orders: 0, submitted: 0 });
    expect(result.failures).toEqual([{ path: "/api/assets", status: 401, error: "unauthorized" }]);
  });

  it("starts with an SOI marker and ends with EOI for the generated JPEG", () => {
    const jpeg = tinyJpeg();
    expect(Array.from(jpeg.slice(0, 2))).toEqual([0xff, 0xd8]);
    expect(Array.from(jpeg.slice(-2))).toEqual([0xff, 0xd9]);
  });
});
