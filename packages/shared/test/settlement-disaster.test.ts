import { describe, expect, it } from "vitest";
import {
  ContractTermsSchema,
  computeSettlement,
  type DisasterInput,
  type SatangContractTerms,
  type SettlementResult,
} from "../src/index";

const THB = 100;
type Terms<K extends SatangContractTerms["contract_type"]> = Extract<SatangContractTerms, { contract_type: K }>;

const baht = (r: SettlementResult) => ({ owner: r.owner_payout_satang / THB, operator: r.operator_payout_satang / THB });
const disaster = (damage_pct: number, insurance_thb = 0, aid_thb = 0): DisasterInput => ({
  damage_bps: damage_pct * 100,
  insurance_satang: insurance_thb * THB,
  government_aid_satang: aid_thb * THB,
});
const sum = (xs: { amount_satang: number }[]) => xs.reduce((s, x) => s + x.amount_satang, 0);

const nayhua = (clause?: Terms<"fixed_target_bonus">["disaster_clause"]): Terms<"fixed_target_bonus"> => ({
  contract_type: "fixed_target_bonus",
  owner_target_revenue_satang: 350_000 * THB,
  excess_operator_bps: 10_000,
  opex_borne_by: "operator_reimbursed",
  shortfall_policy: "owner_absorbs",
  ...(clause ? { disaster_clause: clause } : {}),
});
const melon = (clause?: Terms<"turnkey_profit_share">["disaster_clause"]): Terms<"turnkey_profit_share"> => ({
  contract_type: "turnkey_profit_share",
  owner_share_bps: 7000,
  operator_share_bps: 3000,
  management_retainer_monthly_satang: 0,
  retainer_timing: "before_split",
  loss_policy: "owner_absorbs",
  ...(clause ? { disaster_clause: clause } : {}),
});
const machinery = (feeBps?: number): Terms<"pay_per_job"> => ({
  contract_type: "pay_per_job",
  rates: [
    { job_key: "drone_spray", label: "โดรนพ่นสาร", unit: "rai", rate_satang: 120 * THB },
    { job_key: "harvester", label: "รถเกี่ยวเก็บเกี่ยว", unit: "rai", rate_satang: 450 * THB },
  ],
  ...(feeBps === undefined ? {} : { disaster_clause: { min_damage_bps: 2000, cancellation_fee_bps_on_disaster: feeBps } }),
});
const villa = (repairOwnerBps?: number): Terms<"property_management"> => ({
  contract_type: "property_management",
  revenue_commission_bps: 1500,
  cleaning_fee_per_turnover_satang: 800 * THB,
  ...(repairOwnerBps === undefined ? {} : { disaster_clause: { min_damage_bps: 2000, repair_cost_owner_bps: repairOwnerBps } }),
});

const fixedRun = (t: Terms<"fixed_target_bonus">, revenue: number, opex: number, d?: DisasterInput) =>
  computeSettlement(t, { contract_type: "fixed_target_bonus", revenue_satang: revenue * THB, opex_satang: opex * THB, ...(d ? { disaster: d } : {}) });
const turnkeyRun = (t: Terms<"turnkey_profit_share">, revenue: number, opex: number, d?: DisasterInput) =>
  computeSettlement(t, {
    contract_type: "turnkey_profit_share",
    revenue_satang: revenue * THB,
    opex_satang: opex * THB,
    period_months: 0,
    ...(d ? { disaster: d } : {}),
  });

describe("นายหัว (operator_reimbursed · target 350,000 · opex 40,000) with the default disaster clause", () => {
  it("sales 180,000 + insurance 60,000 (pool), damage 50% → target 175,000, net 200,000 → owner 175,000 · operator 25,000", () => {
    const r = fixedRun(nayhua(), 180_000, 40_000, disaster(50, 60_000));
    expect(baht(r)).toEqual({ owner: 175_000, operator: 25_000 });
    expect(r.disaster_clause_applied).toBe(true);
    expect(r.inflows.map((i) => [i.key, i.amount_satang / THB])).toEqual([
      ["revenue", 180_000],
      ["insurance_payout", 60_000],
    ]);
    expect(sum(r.lines)).toBe(sum(r.inflows));
    expect(r.assumptions.some((a) => a.includes("ลดเป้า"))).toBe(true);
  });

  it("target_adjustment none → owner 200,000 · operator 0", () => {
    const r = fixedRun(
      nayhua({ min_damage_bps: 2000, target_adjustment: "none", insurance_recipient: "pool" }),
      180_000,
      40_000,
      disaster(50, 60_000),
    );
    expect(baht(r)).toEqual({ owner: 200_000, operator: 0 });
  });

  it("damage 10% (below the 20% threshold), sales 300,000, no insurance → normal rules: owner 260,000 · operator 0", () => {
    const r = fixedRun(nayhua(), 300_000, 40_000, disaster(10));
    expect(baht(r)).toEqual({ owner: 260_000, operator: 0 });
    expect(r.disaster_clause_applied).toBe(false);
    expect(r.assumptions.some((a) => a.includes("ต่ำกว่าเกณฑ์"))).toBe(true);
  });

  it("insurance_recipient owner adds the payout to the owner after the split", () => {
    // pooled would be 175,000 / 25,000; to the owner: net 140,000 < 175,000 → owner 140,000 + 60,000, operator 0
    const r = fixedRun(nayhua({ min_damage_bps: 2000, target_adjustment: "scale_by_damage", insurance_recipient: "owner" }), 180_000, 40_000, disaster(50, 60_000));
    expect(baht(r)).toEqual({ owner: 200_000, operator: 0 });
    expect(r.lines.find((l) => l.key === "insurance_payout")).toMatchObject({ party: "owner", amount_satang: 60_000 * THB });
  });
});

describe("turnkey 70/30, no retainer, sales 20,000 · opex 32,000 · damage 60%", () => {
  it("no insurance → owner −12,000 · operator 0", () => {
    expect(baht(turnkeyRun(melon(), 20_000, 32_000, disaster(60)))).toEqual({ owner: -12_000, operator: 0 });
  });

  it("insurance 15,000 (pool) → profit 3,000 → owner 2,100 · operator 900", () => {
    const r = turnkeyRun(melon(), 20_000, 32_000, disaster(60, 15_000));
    expect(baht(r)).toEqual({ owner: 2100, operator: 900 });
    expect(sum(r.lines)).toBe(35_000 * THB);
  });

  it("loss_policy_on_disaster split_by_share, no insurance → −8,400 / −3,600", () => {
    const r = turnkeyRun(
      melon({ min_damage_bps: 2000, loss_policy_on_disaster: "split_by_share", insurance_recipient: "pool" }),
      20_000,
      32_000,
      disaster(60),
    );
    expect(baht(r)).toEqual({ owner: -8400, operator: -3600 });
  });

  it("government aid counts like insurance", () => {
    expect(baht(turnkeyRun(melon(), 20_000, 32_000, disaster(60, 10_000, 5000)))).toEqual({ owner: 2100, operator: 900 });
  });
});

describe("pay_per_job: drone 20 rai done, harvester 20 rai cancelled by the disaster", () => {
  const run = (feeBps?: number) =>
    computeSettlement(machinery(feeBps), {
      contract_type: "pay_per_job",
      jobs: [{ job_key: "drone_spray", quantity_hundredths: 2000 }],
      cancelled_jobs: [{ job_key: "harvester", quantity_hundredths: 2000 }],
      disaster: disaster(60),
    });
  const contractor = (r: SettlementResult) => sum(r.lines.filter((l) => l.party === "contractor")) / THB;

  it("default fee 0 → contractor 2,400", () => {
    const r = run();
    expect(contractor(r)).toBe(2400);
    expect(baht(r)).toEqual({ owner: -2400, operator: 0 });
  });

  it("fee 10% → contractor 3,300 (2,400 + 900)", () => {
    const r = run(1000);
    expect(contractor(r)).toBe(3300);
    expect(r.lines.find((l) => l.key === "cancelled:harvester")!.amount_satang).toBe(900 * THB);
    expect(baht(r).owner).toBe(-3300);
  });

  it("below the threshold cancelled jobs earn no fee", () => {
    const r = computeSettlement(machinery(1000), {
      contract_type: "pay_per_job",
      jobs: [{ job_key: "drone_spray", quantity_hundredths: 2000 }],
      cancelled_jobs: [{ job_key: "harvester", quantity_hundredths: 2000 }],
      disaster: disaster(10),
    });
    expect(contractor(r)).toBe(2400);
  });
});

describe("property_management 15% + 800/turnover: rent 20,000 · 2 turnovers · repair 30,000 · insurance 30,000", () => {
  const run = (repairOwnerBps?: number) =>
    computeSettlement(villa(repairOwnerBps), {
      contract_type: "property_management",
      revenue_satang: 20_000 * THB,
      turnovers: 2,
      repair_cost_satang: 30_000 * THB,
      disaster: disaster(40, 30_000),
    });

  it("default (owner pays repairs) → manager 4,600 · owner 15,400", () => {
    const r = run();
    expect(baht(r)).toEqual({ owner: 15_400, operator: 4600 });
    expect(sum(r.lines)).toBe(50_000 * THB); // rent + insurance
  });

  it("repair_cost_owner_pct 50 → manager −10,400 · owner 30,400", () => {
    expect(baht(run(5000))).toEqual({ owner: 30_400, operator: -10_400 });
  });
});

describe("contracts without a disaster_clause use the defaults", () => {
  it("parses clauses with defaults and keeps them optional", () => {
    const base = { contract_type: "fixed_target_bonus", owner_target_revenue_thb: 350_000 };
    expect(ContractTermsSchema.parse(base)).not.toHaveProperty("disaster_clause");
    expect(ContractTermsSchema.parse({ ...base, disaster_clause: {} })).toMatchObject({
      disaster_clause: { min_damage_pct: 20, target_adjustment: "scale_by_damage", insurance_recipient: "pool" },
    });
    expect(ContractTermsSchema.parse({ contract_type: "pay_per_job", rates: [{ job_key: "a", label: "a", unit: "job", rate_thb: 1 }], disaster_clause: {} })).toMatchObject({
      disaster_clause: { min_damage_pct: 20, cancellation_fee_pct_on_disaster: 0 },
    });
    expect(ContractTermsSchema.safeParse({ ...base, disaster_clause: { min_damage_pct: 120 } }).success).toBe(false);
    expect(ContractTermsSchema.safeParse({ ...base, disaster_clause: { payout: 1 } }).success).toBe(false);
  });
});

// ---- Randomized invariants with the default disaster clause (fixed seed) ----

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(0x44b);
const int = (max: number) => Math.floor(rand() * (max + 1));
const pick = <T,>(xs: readonly T[]): T => xs[int(xs.length - 1)]!;
const CASES = 600;
const randomDisaster = (): DisasterInput => ({ damage_bps: int(10_000), insurance_satang: int(2_000_000_000), government_aid_satang: pick([0, int(500_000_000)]) });

function expectReconciled(r: SettlementResult) {
  for (const l of r.lines) expect(Number.isSafeInteger(l.amount_satang)).toBe(true);
  expect(sum(r.lines)).toBe(sum(r.inflows));
  const party = (p: string) => sum(r.lines.filter((l) => l.party === p));
  expect(r.owner_payout_satang).toBe(party("owner"));
  expect(r.operator_payout_satang).toBe(party("operator"));
}

describe("invariants with default clauses (randomized)", () => {
  it(`fixed_target_bonus (operator_reimbursed defaults): operator ≥ 0, owner + operator = revenue + aid − opex, ${CASES} cases`, () => {
    for (let i = 0; i < CASES; i++) {
      const t = { ...nayhua(), owner_target_revenue_satang: 1 + int(5_000_000_000), excess_operator_bps: int(10_000) };
      const revenue = int(6_000_000_000);
      const opex = int(3_000_000_000);
      const d = randomDisaster();
      const r = computeSettlement(t, { contract_type: "fixed_target_bonus", revenue_satang: revenue, opex_satang: opex, disaster: d });
      expect(r.operator_payout_satang).toBeGreaterThanOrEqual(0);
      expect(r.owner_payout_satang + r.operator_payout_satang).toBe(revenue + d.insurance_satang + d.government_aid_satang - opex);
      expectReconciled(r);
    }
  });

  it(`turnkey (default loss policies): operator ≥ 0, owner + operator = revenue + aid − opex, ${CASES} cases`, () => {
    for (let i = 0; i < CASES; i++) {
      const ownerBps = int(10_000);
      const t = {
        ...melon(),
        owner_share_bps: ownerBps,
        operator_share_bps: 10_000 - ownerBps,
        management_retainer_monthly_satang: int(2_000_000),
        retainer_timing: "before_split" as const,
      };
      const revenue = int(5_000_000_000);
      const opex = int(5_000_000_000);
      const d = randomDisaster();
      const r = computeSettlement(t, {
        contract_type: "turnkey_profit_share",
        revenue_satang: revenue,
        opex_satang: opex,
        period_months: int(24),
        disaster: d,
      });
      expect(r.operator_payout_satang).toBeGreaterThanOrEqual(0);
      expect(r.owner_payout_satang + r.operator_payout_satang).toBe(revenue + d.insurance_satang + d.government_aid_satang - opex);
      expectReconciled(r);
    }
  });

  it(`pay_per_job: contractor ≥ 0, owner = aid − contractor, ${CASES} cases`, () => {
    for (let i = 0; i < CASES; i++) {
      const rates = Array.from({ length: 1 + int(3) }, (_, k) => ({ job_key: `j${k}`, label: `งาน ${k}`, unit: "rai" as const, rate_satang: 1 + int(5_000_000) }));
      const qty = () => ({ job_key: pick(rates).job_key, quantity_hundredths: 1 + int(500_000) });
      const t: Terms<"pay_per_job"> = { contract_type: "pay_per_job", rates, disaster_clause: { min_damage_bps: 2000, cancellation_fee_bps_on_disaster: int(10_000) } };
      const d = randomDisaster();
      const r = computeSettlement(t, {
        contract_type: "pay_per_job",
        jobs: Array.from({ length: 1 + int(3) }, qty),
        cancelled_jobs: Array.from({ length: int(3) }, qty),
        disaster: d,
      });
      const contractor = sum(r.lines.filter((l) => l.party === "contractor"));
      expect(contractor).toBeGreaterThanOrEqual(0);
      expect(r.operator_payout_satang).toBe(0);
      expect(r.owner_payout_satang).toBe(d.insurance_satang + d.government_aid_satang - contractor);
      expectReconciled(r);
    }
  });

  it(`property_management (owner pays repairs by default): operator ≥ 0, totals reconcile, ${CASES} cases`, () => {
    for (let i = 0; i < CASES; i++) {
      const t: Terms<"property_management"> = { ...villa(), revenue_commission_bps: int(10_000), cleaning_fee_per_turnover_satang: int(300_000) };
      const revenue = int(3_000_000_000);
      const repair = int(3_000_000_000);
      const d = randomDisaster();
      const r = computeSettlement(t, { contract_type: "property_management", revenue_satang: revenue, turnovers: int(40), repair_cost_satang: repair, disaster: d });
      expect(r.operator_payout_satang).toBeGreaterThanOrEqual(0);
      expect(r.owner_payout_satang + r.operator_payout_satang).toBe(revenue + d.insurance_satang + d.government_aid_satang - repair);
      expectReconciled(r);
    }
  });
});
