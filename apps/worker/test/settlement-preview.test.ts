import type { Asset, AssetUnit, Contract, ContractTermsInput, CropCycle, Polygon } from "@owner-os/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Env } from "../src/env";
import { app } from "../src/index";
import { authHeader, createTestEnv, type TestEnv } from "./d1";

type Preview = {
  contract_id: string;
  contract_type: string;
  rules_status: string;
  lines: { key: string; label_th: string; amount_thb: number; party: string }[];
  owner_payout_thb: number;
  operator_payout_thb: number;
  assumptions: string[];
  source: { revenue_from: string; crop_cycle_id?: string; damage_from: string | null; damage_pct?: number; disaster_event_ids?: string[] };
  disaster_clause_applied: boolean;
  inflows: { key: string; amount_thb: number }[];
};

let testEnv: TestEnv;
let env: Env;

beforeAll(async () => {
  testEnv = await createTestEnv();
  env = testEnv.env;
});

afterAll(async () => {
  await testEnv?.dispose();
});

// Fictional ~100 m square at the equator.
const D = 100 / 111_319.49;
const square: Polygon = { type: "Polygon", coordinates: [[[0, 0], [D, 0], [D, D], [0, D], [0, 0]]] };
const DAY_MS = 24 * 60 * 60 * 1000;

function send(method: "GET" | "POST", path: string, body?: unknown) {
  return app.request(
    path,
    { method, headers: { ...authHeader, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) },
    env,
  );
}

async function json<T>(res: Response, status: number): Promise<T> {
  expect(res.status).toBe(status);
  return (await res.json()) as T;
}

async function assetWithContract(terms: ContractTermsInput) {
  const asset = await json<Asset>(await send("POST", "/api/assets", { name: "สินทรัพย์ทดสอบ (demo)", kind: "farm" }), 201);
  const unit = await json<AssetUnit>(
    await send("POST", `/api/assets/${asset.id}/units`, { name: "โรงเรือน 1", unit_type: "building", boundary: square }),
    201,
  );
  const contract = await json<Contract>(
    await send("POST", `/api/assets/${asset.id}/contracts`, { partner_label: "ผู้บริหาร (demo)", starts_at: "2026-10-01T00:00:00.000Z", terms }),
    201,
  );
  return { asset, unit, contract };
}

/** Cycle on `unitId` moved to harvesting with the given harvest logs (kg, THB/kg). */
async function harvestedCycle(unitId: string, logs: [number, number][]): Promise<CropCycle> {
  const cycle = await json<CropCycle>(await send("POST", `/api/units/${unitId}/crop-cycles`, { crop: "เมล่อน" }), 201);
  for (const to of ["growing", "harvesting"] as const) await json(await send("POST", `/api/crop-cycles/${cycle.id}/transition`, { to }), 200);
  for (const [weight_kg, unit_price_thb] of logs) {
    await json(
      await send("POST", `/api/crop-cycles/${cycle.id}/harvest-logs`, {
        harvested_at: new Date(Date.now() - 60_000).toISOString(),
        weight_kg,
        unit_price_thb,
      }),
      201,
    );
  }
  return cycle;
}

const preview = (contractId: string, body: unknown) => send("POST", `/api/contracts/${contractId}/settlement-preview`, body);

const MELON: ContractTermsInput = { contract_type: "turnkey_profit_share", owner_share_pct: 70, operator_share_pct: 30 };
const NAYHUA: ContractTermsInput = { contract_type: "fixed_target_bonus", owner_target_revenue_thb: 350_000 };

const TABLES = [
  "assets",
  "asset_units",
  "work_orders",
  "work_order_evidence",
  "farm_crop_cycles",
  "farm_harvest_logs",
  "asset_contracts",
  "disaster_events",
  "disaster_event_units",
  "disaster_event_evidence",
];
async function rowCounts(): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const t of TABLES) out[t] = (await env.DB.prepare(`SELECT COUNT(*) n FROM ${t}`).first<{ n: number }>())!.n;
  return out;
}

describe("turnkey preview from harvest logs", () => {
  it("sums the cycle's 2 harvest logs: 1,000 kg + 200 kg × 85 = 102,000 → owner 49,000 · operator 21,000", async () => {
    const { unit, contract } = await assetWithContract(MELON);
    const cycle = await harvestedCycle(unit.id, [
      [1000, 85],
      [200, 85],
    ]);
    const body = await json<Preview>(await preview(contract.id, { crop_cycle_id: cycle.id, opex_thb: 32_000, period_months: 3 }), 200);
    expect(body).toMatchObject({
      contract_id: contract.id,
      contract_type: "turnkey_profit_share",
      rules_status: "draft_unconfirmed",
      owner_payout_thb: 49_000,
      operator_payout_thb: 21_000,
      source: { revenue_from: "harvest_logs", crop_cycle_id: cycle.id },
    });
    expect(body.lines.reduce((s, l) => s + Math.round(l.amount_thb * 100), 0)).toBe(102_000 * 100);
    expect(body.assumptions[0]).toMatch(/draft_unconfirmed/);
  });

  it("derives period_months from started_at → ended_at (30-day months, rounded up)", async () => {
    const { unit, contract } = await assetWithContract({ ...MELON, management_retainer_monthly_thb: 5000 });
    const cycle = await harvestedCycle(unit.id, [[1200, 85]]);
    await json(await send("POST", `/api/crop-cycles/${cycle.id}/transition`, { to: "closed" }), 200);
    // 61 days → 3 months of retainer (test-only adjustment of the cycle dates).
    await env.DB.prepare("UPDATE farm_crop_cycles SET started_at = ended_at - ? WHERE id = ?").bind(61 * DAY_MS, cycle.id).run();
    const body = await json<Preview>(await preview(contract.id, { crop_cycle_id: cycle.id, opex_thb: 32_000 }), 200);
    expect(body.lines.find((l) => l.key === "retainer")!.amount_thb).toBe(15_000);
    expect([body.owner_payout_thb, body.operator_payout_thb]).toEqual([38_500, 31_500]);
  });

  it("requires period_months when the cycle has no end date or revenue is given directly", async () => {
    const { unit, contract } = await assetWithContract(MELON);
    const cycle = await harvestedCycle(unit.id, [[10, 10]]);
    const res = await preview(contract.id, { crop_cycle_id: cycle.id, opex_thb: 0 });
    expect((await json<{ error: string }>(res, 400)).error).toBe("period_months_required");
    expect((await json<{ error: string }>(await preview(contract.id, { revenue_thb: 1000, opex_thb: 0 }), 400)).error).toBe(
      "period_months_required",
    );
    const ok = await json<Preview>(await preview(contract.id, { revenue_thb: 102_000, opex_thb: 32_000, period_months: 0 }), 200);
    expect(ok.source).toEqual({ revenue_from: "input", damage_from: null });
  });

  it("rejects both or neither revenue source, and a cycle of another asset", async () => {
    const { unit, contract } = await assetWithContract(MELON);
    const cycle = await harvestedCycle(unit.id, [[10, 10]]);
    expect((await preview(contract.id, { crop_cycle_id: cycle.id, revenue_thb: 1, opex_thb: 0, period_months: 1 })).status).toBe(400);
    expect((await preview(contract.id, { opex_thb: 0, period_months: 1 })).status).toBe(400);

    const other = await assetWithContract(MELON);
    const foreign = await harvestedCycle(other.unit.id, [[10, 10]]);
    const res = await preview(contract.id, { crop_cycle_id: foreign.id, opex_thb: 0, period_months: 1 });
    expect((await json<{ error: string }>(res, 400)).error).toBe("crop_cycle_not_in_asset");
  });
});

describe("other contract types", () => {
  it("fixed_target_bonus from revenue_thb: 420,000 − opex 40,000 → owner 350,000 · operator 30,000", async () => {
    const { contract } = await assetWithContract(NAYHUA);
    const body = await json<Preview>(await preview(contract.id, { revenue_thb: 420_000, opex_thb: 40_000 }), 200);
    expect([body.owner_payout_thb, body.operator_payout_thb]).toEqual([350_000, 30_000]);
    expect(body.rules_status).toBe("draft_unconfirmed");
    expect((await preview(contract.id, { revenue_thb: 1, opex_thb: 0, period_months: 1 })).status).toBe(400); // strict
  });

  it("pay_per_job: drone 20 rai + harvester 20 rai = 11,400; unknown job_key → 400", async () => {
    const { contract } = await assetWithContract({
      contract_type: "pay_per_job",
      rates: [
        { job_key: "drone_spray", label: "โดรนพ่นสาร", unit: "rai", rate_thb: 120 },
        { job_key: "harvester", label: "รถเกี่ยวเก็บเกี่ยว", unit: "rai", rate_thb: 450 },
      ],
    });
    const body = await json<Preview>(
      await preview(contract.id, {
        jobs: [
          { job_key: "drone_spray", quantity: 20 },
          { job_key: "harvester", quantity: 20 },
        ],
      }),
      200,
    );
    expect(body.lines.filter((l) => l.party === "contractor").map((l) => l.amount_thb)).toEqual([2400, 9000]);
    expect([body.owner_payout_thb, body.operator_payout_thb]).toEqual([-11_400, 0]);
    const bad = await json<{ error: string }>(await preview(contract.id, { jobs: [{ job_key: "ploughing", quantity: 1 }] }), 400);
    expect(bad.error).toBe("unknown_job_key");
    expect((await preview(contract.id, { jobs: [{ job_key: "drone_spray", quantity: 1.234 }] })).status).toBe(400);
  });

  it("property_management: 60,000 with 3 turnovers → operator 11,400 · owner 48,600", async () => {
    const { contract } = await assetWithContract({ contract_type: "property_management", revenue_commission_pct: 15, cleaning_fee_per_turnover_thb: 800 });
    const body = await json<Preview>(await preview(contract.id, { revenue_thb: 60_000, turnovers: 3 }), 200);
    expect([body.owner_payout_thb, body.operator_payout_thb]).toEqual([48_600, 11_400]);
    expect((await preview(contract.id, { revenue_thb: 60_000, turnovers: 1.5 })).status).toBe(400);
  });
});

describe("guards and side effects", () => {
  it("returns 409 for an inactive contract, 404 for an unknown one and 401 without a token", async () => {
    const { contract } = await assetWithContract(NAYHUA);
    await json(await send("POST", `/api/contracts/${contract.id}/deactivate`), 200);
    expect((await json<{ error: string }>(await preview(contract.id, { revenue_thb: 1, opex_thb: 0 }), 409)).error).toBe("contract_not_active");
    expect((await preview("nope", { revenue_thb: 1, opex_thb: 0 })).status).toBe(404);
    expect((await app.request("/api/contracts/any/settlement-preview", { method: "POST" }, env)).status).toBe(401);
  });

  it("writes nothing: row counts are identical before and after previews", async () => {
    const { unit, contract } = await assetWithContract(MELON);
    const cycle = await harvestedCycle(unit.id, [[500, 40]]);
    const before = await rowCounts();
    for (let i = 0; i < 3; i++) {
      await json(await preview(contract.id, { crop_cycle_id: cycle.id, opex_thb: 1000, period_months: 2 }), 200);
    }
    await preview(contract.id, { crop_cycle_id: cycle.id, revenue_thb: 1, opex_thb: 0 }); // 400
    expect(await rowCounts()).toEqual(before);
  });
});

describe("disaster-aware preview", () => {
  const NAYHUA_REIMBURSED: ContractTermsInput = { contract_type: "fixed_target_bonus", owner_target_revenue_thb: 350_000 }; // defaults: operator_reimbursed + default disaster clause

  async function disasterEvent(assetId: string, unitId: string, damage_pct: number) {
    const res = await send("POST", `/api/assets/${assetId}/disaster-events`, {
      event_type: "flood",
      occurred_at: new Date().toISOString(),
      units: [{ unit_id: unitId, damage_pct }],
    });
    expect(res.status).toBe(201);
    return ((await res.json()) as { id: string }).id;
  }

  it("uses the cycle's disaster events automatically: 40% + 50% → 70%, target 350,000 → 105,000", async () => {
    const { asset, unit, contract } = await assetWithContract(NAYHUA_REIMBURSED);
    const cycle = await harvestedCycle(unit.id, [[1000, 180]]); // revenue 180,000
    await new Promise((r) => setTimeout(r, 5));
    const e1 = await disasterEvent(asset.id, unit.id, 40);
    const e2 = await disasterEvent(asset.id, unit.id, 50);

    const before = await rowCounts();
    const body = await json<Preview>(await preview(contract.id, { crop_cycle_id: cycle.id, opex_thb: 40_000 }), 200);
    // net = 180,000 − 40,000 = 140,000; target' = 350,000 × 30% = 105,000; bonus 35,000
    expect([body.owner_payout_thb, body.operator_payout_thb]).toEqual([105_000, 35_000]);
    expect(body.disaster_clause_applied).toBe(true);
    expect(body.source).toEqual({
      revenue_from: "harvest_logs",
      crop_cycle_id: cycle.id,
      damage_from: "events",
      damage_pct: 70,
      disaster_event_ids: [e1, e2],
    });
    expect(body.rules_status).toBe("draft_unconfirmed");

    // damage_pct in the body overrides the events: 50% → target 175,000 > net 140,000
    const overridden = await json<Preview>(await preview(contract.id, { crop_cycle_id: cycle.id, opex_thb: 40_000, damage_pct: 50 }), 200);
    expect([overridden.owner_payout_thb, overridden.operator_payout_thb]).toEqual([140_000, 0]);
    expect(overridden.source).toMatchObject({ damage_from: "input", damage_pct: 50 });

    // insurance into the pool, plus the team example: 180,000 + 60,000 at 50% → 175,000 / 25,000
    const insured = await json<Preview>(
      await preview(contract.id, { crop_cycle_id: cycle.id, opex_thb: 40_000, damage_pct: 50, insurance_thb: 60_000 }),
      200,
    );
    expect([insured.owner_payout_thb, insured.operator_payout_thb]).toEqual([175_000, 25_000]);
    expect(insured.inflows.map((i) => [i.key, i.amount_thb])).toEqual([
      ["revenue", 180_000],
      ["insurance_payout", 60_000],
    ]);
    expect(await rowCounts()).toEqual(before);
  });

  it("without disaster events the normal rules apply", async () => {
    const { unit, contract } = await assetWithContract(NAYHUA_REIMBURSED);
    const cycle = await harvestedCycle(unit.id, [[1000, 180]]);
    const body = await json<Preview>(await preview(contract.id, { crop_cycle_id: cycle.id, opex_thb: 40_000 }), 200);
    expect([body.owner_payout_thb, body.operator_payout_thb]).toEqual([140_000, 0]);
    expect(body.disaster_clause_applied).toBe(false);
    expect(body.source.damage_from).toBeNull();
  });

  it("pay_per_job cancelled jobs and property repairs come through the API", async () => {
    const ppj = await assetWithContract({
      contract_type: "pay_per_job",
      rates: [
        { job_key: "drone_spray", label: "โดรนพ่นสาร", unit: "rai", rate_thb: 120 },
        { job_key: "harvester", label: "รถเกี่ยวเก็บเกี่ยว", unit: "rai", rate_thb: 450 },
      ],
      disaster_clause: { cancellation_fee_pct_on_disaster: 10 },
    });
    const jobs = await json<Preview>(
      await preview(ppj.contract.id, {
        jobs: [{ job_key: "drone_spray", quantity: 20 }],
        cancelled_jobs: [{ job_key: "harvester", quantity: 20 }],
        damage_pct: 60,
      }),
      200,
    );
    expect(jobs.lines.filter((l) => l.party === "contractor").reduce((s, l) => s + l.amount_thb, 0)).toBe(3300);

    const villa = await assetWithContract({ contract_type: "property_management", revenue_commission_pct: 15, cleaning_fee_per_turnover_thb: 800 });
    const repaired = await json<Preview>(
      await preview(villa.contract.id, { revenue_thb: 20_000, turnovers: 2, repair_cost_thb: 30_000, insurance_thb: 30_000, damage_pct: 40 }),
      200,
    );
    expect([repaired.owner_payout_thb, repaired.operator_payout_thb]).toEqual([15_400, 4600]);
    expect((await preview(villa.contract.id, { revenue_thb: 1, turnovers: 0, damage_pct: 101 })).status).toBe(400);
  });

  it("stores and returns a disaster_clause on the contract", async () => {
    const { contract } = await assetWithContract({
      contract_type: "turnkey_profit_share",
      owner_share_pct: 70,
      operator_share_pct: 30,
      disaster_clause: { min_damage_pct: 25.5, loss_policy_on_disaster: "split_by_share" },
    });
    expect(contract.terms).toMatchObject({
      disaster_clause: { min_damage_pct: 25.5, loss_policy_on_disaster: "split_by_share", insurance_recipient: "pool" },
    });
    const row = await env.DB.prepare("SELECT terms_json FROM asset_contracts WHERE id = ?").bind(contract.id).first<{ terms_json: string }>();
    expect(JSON.parse(row!.terms_json).disaster_clause).toEqual({
      min_damage_bps: 2550,
      loss_policy_on_disaster: "split_by_share",
      insurance_recipient: "pool",
    });
  });
});
