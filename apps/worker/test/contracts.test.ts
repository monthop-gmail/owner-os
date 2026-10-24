import type { Asset, Contract, ContractTermsInput } from "@owner-os/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Env } from "../src/env";
import { app } from "../src/index";
import { contractTermsFromStored, contractTermsToStored } from "../src/mappers";
import { applyMigrations, authHeader, createTestEnv, type TestEnv } from "./d1";

let testEnv: TestEnv;
let env: Env;

beforeAll(async () => {
  testEnv = await createTestEnv();
  env = testEnv.env;
});

afterAll(async () => {
  await testEnv?.dispose();
});

function send(method: "GET" | "POST", path: string, body?: unknown, targetEnv: Env = env) {
  return app.request(
    path,
    {
      method,
      headers: { ...authHeader, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
    targetEnv,
  );
}

async function json<T>(res: Response, status: number): Promise<T> {
  expect(res.status).toBe(status);
  return (await res.json()) as T;
}

async function newAsset(): Promise<Asset> {
  return json<Asset>(await send("POST", "/api/assets", { name: "สินทรัพย์ทดสอบ (demo)", kind: "farm" }), 201);
}

const STARTS = "2026-10-01T00:00:00.000Z";

// The team's four example contracts, expressed in the API's terms (baht / percent).
const EXAMPLES: Record<string, { partner_label: string; terms: ContractTermsInput; expected: Record<string, unknown> }> = {
  fixed_target_bonus: {
    partner_label: "ผู้ดูแลสวน (demo)",
    terms: { contract_type: "fixed_target_bonus", owner_target_revenue_thb: 350_000, excess_operator_pct: 100, opex_borne_by: "operator" },
    expected: { owner_target_revenue_satang: 35_000_000, excess_operator_bps: 10_000, opex_borne_by: "operator", shortfall_policy: "owner_absorbs" },
  },
  pay_per_job: {
    partner_label: "ผู้รับจ้างงานเครื่องจักร (demo)",
    terms: {
      contract_type: "pay_per_job",
      rates: [
        { job_key: "drone_spray", label: "โดรนพ่นสาร", unit: "rai", rate_thb: 120 },
        { job_key: "harvester", label: "รถเกี่ยวเก็บเกี่ยว", unit: "rai", rate_thb: 450 },
      ],
    },
    expected: {
      rates: [
        { job_key: "drone_spray", label: "โดรนพ่นสาร", unit: "rai", rate_satang: 12_000 },
        { job_key: "harvester", label: "รถเกี่ยวเก็บเกี่ยว", unit: "rai", rate_satang: 45_000 },
      ],
    },
  },
  turnkey_profit_share: {
    partner_label: "ผู้บริหารโรงเรือน (demo)",
    terms: { contract_type: "turnkey_profit_share", owner_share_pct: 70, operator_share_pct: 30, management_retainer_monthly_thb: 5000 },
    expected: {
      owner_share_bps: 7000,
      operator_share_bps: 3000,
      management_retainer_monthly_satang: 500_000,
      retainer_timing: "before_split",
      loss_policy: "owner_absorbs",
    },
  },
  property_management: {
    partner_label: "บริษัทบริหารที่พัก (demo)",
    terms: { contract_type: "property_management", revenue_commission_pct: 15, cleaning_fee_per_turnover_thb: 800 },
    expected: { revenue_commission_bps: 1500, cleaning_fee_per_turnover_satang: 80_000 },
  },
};

describe("POST /api/assets/:id/contracts", () => {
  it.each(Object.entries(EXAMPLES))("creates a %s contract; stored as satang/bps and returned as baht/%", async (type, ex) => {
    const asset = await newAsset();
    const contract = await json<Contract>(
      await send("POST", `/api/assets/${asset.id}/contracts`, { partner_label: ex.partner_label, starts_at: STARTS, terms: ex.terms }),
      201,
    );
    expect(contract).toMatchObject({
      asset_id: asset.id,
      contract_type: type,
      partner_label: ex.partner_label,
      is_active: true,
      rules_status: "draft_unconfirmed",
      starts_at: STARTS,
      ends_at: null,
    });
    expect(contract.terms).toMatchObject(ex.terms as Record<string, unknown>);

    const row = await env.DB.prepare("SELECT contract_type, terms_json, is_active, rules_status FROM asset_contracts WHERE id = ?")
      .bind(contract.id)
      .first<{ contract_type: string; terms_json: string; is_active: number; rules_status: string }>();
    expect(row).toMatchObject({ contract_type: type, is_active: 1, rules_status: "draft_unconfirmed" });
    expect(JSON.parse(row!.terms_json)).toEqual({ contract_type: type, ...ex.expected });

    expect(await json<Contract>(await send("GET", `/api/contracts/${contract.id}`), 200)).toEqual(contract);
  });

  it("round-trips odd decimals exactly through satang / basis points", () => {
    const cases: ContractTermsInput[] = [
      { contract_type: "turnkey_profit_share", owner_share_pct: 66.67, operator_share_pct: 33.33, management_retainer_monthly_thb: 1234.56 },
      { contract_type: "property_management", revenue_commission_pct: 12.34, cleaning_fee_per_turnover_thb: 0.29 },
      { contract_type: "fixed_target_bonus", owner_target_revenue_thb: 99_999.99, excess_operator_pct: 0.01, opex_borne_by: "owner", shortfall_policy: "operator_covers" },
      { contract_type: "pay_per_job", rates: [{ job_key: "spray-2", label: "พ่นยา", unit: "hour", rate_thb: 0.01 }] },
    ];
    for (const t of cases) {
      const full = { retainer_timing: "before_split", loss_policy: "owner_absorbs", ...t };
      const stored = contractTermsToStored(full as never);
      expect(JSON.parse(JSON.stringify(stored))).toEqual(stored);
      for (const v of Object.values(stored)) if (typeof v === "number") expect(Number.isInteger(v)).toBe(true);
      expect(contractTermsFromStored(stored)).toEqual(t.contract_type === "turnkey_profit_share" ? full : t);
    }
  });

  it("rejects invalid terms and server-owned fields with 400", async () => {
    const asset = await newAsset();
    const base = { partner_label: "ผู้ดูแล (demo)", starts_at: STARTS };
    const post = (body: unknown) => send("POST", `/api/assets/${asset.id}/contracts`, body);
    const bad: unknown[] = [
      { ...base, terms: { contract_type: "turnkey_profit_share", owner_share_pct: 70, operator_share_pct: 20 } },
      { ...base, terms: { contract_type: "pay_per_job", rates: [] } },
      {
        ...base,
        terms: {
          contract_type: "pay_per_job",
          rates: [
            { job_key: "drone_spray", label: "a", unit: "rai", rate_thb: 1 },
            { job_key: "drone_spray", label: "b", unit: "rai", rate_thb: 2 },
          ],
        },
      },
      { ...base, terms: { contract_type: "property_management", revenue_commission_pct: 101, cleaning_fee_per_turnover_thb: 0 } },
      { ...base, terms: { contract_type: "barter" } },
      { ...base, terms: EXAMPLES.property_management!.terms, rules_status: "confirmed" },
      { ...base, terms: EXAMPLES.property_management!.terms, is_active: false },
      { ...base, terms: EXAMPLES.property_management!.terms, id: "mine" },
      { ...base, terms: { ...EXAMPLES.property_management!.terms, bonus_pct: 5 } },
      { ...base, terms: EXAMPLES.property_management!.terms, owner_name: "x" },
    ];
    for (const body of bad) expect((await post(body)).status, JSON.stringify(body)).toBe(400);
    expect(await env.DB.prepare("SELECT COUNT(*) n FROM asset_contracts WHERE asset_id = ?").bind(asset.id).first()).toEqual({ n: 0 });
  });

  it("returns 404 for an unknown asset", async () => {
    const res = await send("POST", "/api/assets/nope/contracts", { partner_label: "x", starts_at: STARTS, terms: EXAMPLES.property_management!.terms });
    expect(res.status).toBe(404);
  });
});

describe("one active contract per asset", () => {
  const body = { partner_label: "บริษัทบริหารที่พัก (demo)", starts_at: STARTS, terms: EXAMPLES.property_management!.terms };

  it("rejects a second active contract with 409 and allows a new one after deactivation", async () => {
    const asset = await newAsset();
    const first = await json<Contract>(await send("POST", `/api/assets/${asset.id}/contracts`, body), 201);
    expect((await json<{ error: string }>(await send("POST", `/api/assets/${asset.id}/contracts`, body), 409)).error).toBe(
      "active_contract_exists",
    );

    const deactivated = await json<Contract>(await send("POST", `/api/contracts/${first.id}/deactivate`), 200);
    expect(deactivated.is_active).toBe(false);
    const row = await env.DB.prepare("SELECT deactivated_at FROM asset_contracts WHERE id = ?").bind(first.id).first<{ deactivated_at: number }>();
    expect(row!.deactivated_at).toBeGreaterThan(0);
    expect((await json<{ error: string }>(await send("POST", `/api/contracts/${first.id}/deactivate`), 409)).error).toBe("contract_not_active");

    const second = await json<Contract>(await send("POST", `/api/assets/${asset.id}/contracts`, body), 201);
    const list = await json<{ contracts: Contract[] }>(await send("GET", `/api/assets/${asset.id}/contracts`), 200);
    expect(list.contracts.map((c) => [c.id, c.is_active])).toEqual([
      [second.id, true],
      [first.id, false],
    ]);
  });

  it("lets only one of two concurrent creates win", async () => {
    const asset = await newAsset();
    const [a, b] = await Promise.all([
      send("POST", `/api/assets/${asset.id}/contracts`, body),
      send("POST", `/api/assets/${asset.id}/contracts`, body),
    ]);
    expect([a.status, b.status].sort()).toEqual([201, 409]);
    expect(
      await env.DB.prepare("SELECT COUNT(*) n FROM asset_contracts WHERE asset_id = ? AND is_active = 1").bind(asset.id).first(),
    ).toEqual({ n: 1 });
  });

  it("is also enforced by the partial unique index", async () => {
    const asset = await newAsset();
    await json(await send("POST", `/api/assets/${asset.id}/contracts`, body), 201);
    const raw = env.DB.prepare(
      "INSERT INTO asset_contracts (id, asset_id, contract_type, partner_label, terms_json, is_active, starts_at, created_at) VALUES (?, ?, 'pay_per_job', 'x', '{}', 1, 0, 0)",
    ).bind(crypto.randomUUID(), asset.id);
    await expect(raw.run()).rejects.toThrow(/UNIQUE constraint/);
  });

  it("returns 404 for unknown contracts / assets and 401 without a token", async () => {
    expect((await send("GET", "/api/contracts/nope")).status).toBe(404);
    expect((await send("POST", "/api/contracts/nope/deactivate")).status).toBe(404);
    expect((await send("GET", "/api/assets/nope/contracts")).status).toBe(404);
    for (const [method, path] of [
      ["POST", "/api/assets/any/contracts"],
      ["GET", "/api/assets/any/contracts"],
      ["GET", "/api/contracts/any"],
      ["POST", "/api/contracts/any/deactivate"],
    ] as const) {
      expect((await app.request(path, { method }, env)).status, `${method} ${path}`).toBe(401);
    }
  });
});

describe("migration 0004 on a database with existing data", () => {
  it("creates asset_contracts without touching earlier rows", async () => {
    const legacy = await createTestEnv({ migrations: (f) => !f.startsWith("0004_") });
    try {
      const db = legacy.env.DB;
      const now = Date.now();
      await db.batch([
        db.prepare("INSERT INTO assets (id, name, kind, created_at) VALUES ('a', 'สวนเดิม', 'farm', ?)").bind(now),
        db
          .prepare(
            "INSERT INTO asset_units (id, asset_id, name, unit_type, boundary_geojson, area_m2, created_at) VALUES ('u', 'a', 'แปลงเดิม', 'plot', '{}', 1, ?)",
          )
          .bind(now),
        db.prepare("INSERT INTO farm_crop_cycles (id, unit_id, crop, status, created_at) VALUES ('c', 'u', 'เมล่อน', 'harvesting', ?)").bind(now),
        db
          .prepare(
            "INSERT INTO farm_harvest_logs (id, crop_cycle_id, harvested_at, weight_g, unit_price_satang, revenue_satang, slip_r2_key, created_at) VALUES ('h', 'c', ?, 1200000, 8500, 10200000, 'k', ?)",
          )
          .bind(now, now),
      ]);

      expect(await applyMigrations(db, (f) => f.startsWith("0004_"))).toEqual(["0004_asset_contracts.sql"]);
      expect(
        await db
          .prepare(
            "SELECT (SELECT COUNT(*) FROM assets) a, (SELECT COUNT(*) FROM farm_crop_cycles) c, (SELECT revenue_satang FROM farm_harvest_logs) r, (SELECT COUNT(*) FROM asset_contracts) k",
          )
          .first(),
      ).toEqual({ a: 1, c: 1, r: 10_200_000, k: 0 });

      const created = await send(
        "POST",
        "/api/assets/a/contracts",
        { partner_label: "ผู้บริหารโรงเรือน (demo)", starts_at: STARTS, terms: EXAMPLES.turnkey_profit_share!.terms },
        legacy.env,
      );
      expect(created.status).toBe(201);
    } finally {
      await legacy.dispose();
    }
  });
});
