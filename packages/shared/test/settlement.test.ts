import { describe, expect, it } from "vitest";
import { applyBps, computeSettlement, SettlementError, type SatangContractTerms, type SettlementResult } from "../src/index";

const THB = 100; // satang per baht

type Turnkey = Extract<SatangContractTerms, { contract_type: "turnkey_profit_share" }>;
type Fixed = Extract<SatangContractTerms, { contract_type: "fixed_target_bonus" }>;
type PayPerJob = Extract<SatangContractTerms, { contract_type: "pay_per_job" }>;
type Property = Extract<SatangContractTerms, { contract_type: "property_management" }>;

const melon = (over: Partial<Turnkey> = {}): Turnkey => ({
  contract_type: "turnkey_profit_share",
  owner_share_bps: 7000,
  operator_share_bps: 3000,
  management_retainer_monthly_satang: 0,
  retainer_timing: "before_split",
  loss_policy: "owner_absorbs",
  ...over,
});
const nayhua = (over: Partial<Fixed> = {}): Fixed => ({
  contract_type: "fixed_target_bonus",
  owner_target_revenue_satang: 350_000 * THB,
  excess_operator_bps: 10_000,
  opex_borne_by: "operator",
  shortfall_policy: "owner_absorbs",
  ...over,
});
const machinery: PayPerJob = {
  contract_type: "pay_per_job",
  rates: [
    { job_key: "drone_spray", label: "โดรนพ่นสาร", unit: "rai", rate_satang: 120 * THB },
    { job_key: "harvester", label: "รถเกี่ยวเก็บเกี่ยว", unit: "rai", rate_satang: 450 * THB },
  ],
};
const villa: Property = { contract_type: "property_management", revenue_commission_bps: 1500, cleaning_fee_per_turnover_satang: 800 * THB };

const turnkeyRun = (t: Turnkey, revenue: number, opex: number, months: number) =>
  computeSettlement(t, { contract_type: "turnkey_profit_share", revenue_satang: revenue * THB, opex_satang: opex * THB, period_months: months });
const fixedRun = (t: Fixed, revenue: number, opex: number) =>
  computeSettlement(t, { contract_type: "fixed_target_bonus", revenue_satang: revenue * THB, opex_satang: opex * THB });
const baht = (r: SettlementResult) => ({ owner: r.owner_payout_satang / THB, operator: r.operator_payout_satang / THB });
const lineSum = (r: SettlementResult) => r.lines.reduce((s, l) => s + l.amount_satang, 0);

describe("turnkey_profit_share — the team's melon example (70/30, revenue 102,000, opex 32,000)", () => {
  it("without retainer: owner 49,000 · operator 21,000 (matches the team)", () => {
    expect(baht(turnkeyRun(melon(), 102_000, 32_000, 3))).toEqual({ owner: 49_000, operator: 21_000 });
  });

  it("retainer 5,000 × 3 months before_split: profit 55,000 → owner 38,500 · operator 31,500", () => {
    const r = turnkeyRun(melon({ management_retainer_monthly_satang: 5000 * THB }), 102_000, 32_000, 3);
    expect(baht(r)).toEqual({ owner: 38_500, operator: 31_500 });
    const share = (key: string) => r.lines.find((l) => l.key === key)!.amount_satang;
    expect(share("owner_share") + share("operator_share")).toBe(55_000 * THB);
  });

  it("retainer 5,000 × 3 months after_split: owner 34,000 · operator 36,000", () => {
    const r = turnkeyRun(melon({ management_retainer_monthly_satang: 5000 * THB, retainer_timing: "after_split" }), 102_000, 32_000, 3);
    expect(baht(r)).toEqual({ owner: 34_000, operator: 36_000 });
  });

  it("loss (revenue 20,000, retainer 15,000): owner_absorbs vs split_by_share", () => {
    const withRetainer = { management_retainer_monthly_satang: 5000 * THB };
    // profit = 20,000 − 32,000 − 15,000 = −27,000
    expect(baht(turnkeyRun(melon(withRetainer), 20_000, 32_000, 3))).toEqual({ owner: -27_000, operator: 15_000 });
    // owner = round(−27,000 × 70%) = −18,900 · operator = −8,100 + 15,000 = 6,900
    expect(baht(turnkeyRun(melon({ ...withRetainer, loss_policy: "split_by_share" }), 20_000, 32_000, 3))).toEqual({
      owner: -18_900,
      operator: 6_900,
    });
    // after_split + owner_absorbs: owner −12,000 − 15,000 = −27,000 · operator 15,000
    expect(baht(turnkeyRun(melon({ ...withRetainer, retainer_timing: "after_split" }), 20_000, 32_000, 3))).toEqual({
      owner: -27_000,
      operator: 15_000,
    });
  });

  it("is always draft_unconfirmed and explains its assumptions", () => {
    const r = turnkeyRun(melon(), 102_000, 32_000, 3);
    expect(r.rules_status).toBe("draft_unconfirmed");
    expect(r.assumptions.length).toBeGreaterThanOrEqual(2);
    expect(r.assumptions[0]).toMatch(/draft_unconfirmed/);
  });
});

describe("fixed_target_bonus — นายหัว (target 350,000 · excess 100% · opex 40,000 borne by operator)", () => {
  it("revenue 420,000 → owner 350,000 · operator 30,000", () => {
    expect(baht(fixedRun(nayhua(), 420_000, 40_000))).toEqual({ owner: 350_000, operator: 30_000 });
  });

  it("revenue 300,000 owner_absorbs → owner 300,000 · operator −40,000", () => {
    expect(baht(fixedRun(nayhua(), 300_000, 40_000))).toEqual({ owner: 300_000, operator: -40_000 });
  });

  it("revenue 300,000 operator_covers → owner 350,000 · operator −90,000", () => {
    expect(baht(fixedRun(nayhua({ shortfall_policy: "operator_covers" }), 300_000, 40_000))).toEqual({ owner: 350_000, operator: -90_000 });
  });

  it("opex borne by the owner, partial excess share", () => {
    // excess 70,000 × 60% = 42,000 bonus; owner = 350,000 + 28,000 − 40,000
    expect(baht(fixedRun(nayhua({ opex_borne_by: "owner", excess_operator_bps: 6000 }), 420_000, 40_000))).toEqual({
      owner: 338_000,
      operator: 42_000,
    });
  });
});

describe("pay_per_job — the team's machinery rates", () => {
  it("drone 120 THB/rai × 20 rai = 2,400 and harvester 450 × 20 = 9,000", () => {
    const r = computeSettlement(machinery, {
      contract_type: "pay_per_job",
      jobs: [
        { job_key: "drone_spray", quantity_hundredths: 2000 },
        { job_key: "harvester", quantity_hundredths: 2000 },
      ],
    });
    expect(r.lines.filter((l) => l.party === "contractor").map((l) => [l.key, l.amount_satang / THB])).toEqual([
      ["job:drone_spray", 2400],
      ["job:harvester", 9000],
    ]);
    expect(baht(r)).toEqual({ owner: -11_400, operator: 0 });
  });

  it("prices fractional quantities per line with half-up rounding", () => {
    // 120.00 THB × 0.33 rai = 39.60 THB; 1 satang × 0.5 = 0.5 → 1 satang
    const r = computeSettlement(
      { ...machinery, rates: [...machinery.rates, { job_key: "tiny", label: "x", unit: "job", rate_satang: 1 }] },
      {
        contract_type: "pay_per_job",
        jobs: [
          { job_key: "drone_spray", quantity_hundredths: 33 },
          { job_key: "tiny", quantity_hundredths: 50 },
        ],
      },
    );
    expect(r.lines.map((l) => l.amount_satang)).toEqual([3960, 1, -3961]);
  });

  it("rejects a job_key that is not in the rates", () => {
    expect(() =>
      computeSettlement(machinery, { contract_type: "pay_per_job", jobs: [{ job_key: "ploughing", quantity_hundredths: 100 }] }),
    ).toThrow(SettlementError);
  });
});

describe("property_management — villa (15% + 800 per turnover)", () => {
  it("revenue 60,000 with 3 turnovers → operator 11,400 · owner 48,600", () => {
    const r = computeSettlement(villa, { contract_type: "property_management", revenue_satang: 60_000 * THB, turnovers: 3 });
    expect(baht(r)).toEqual({ owner: 48_600, operator: 11_400 });
  });

  it("owner goes negative when cleaning exceeds revenue, and says so", () => {
    const r = computeSettlement(villa, { contract_type: "property_management", revenue_satang: 1000 * THB, turnovers: 3 });
    expect(baht(r)).toEqual({ owner: -1550, operator: 2550 });
    expect(r.assumptions.some((a) => a.includes("ติดลบ"))).toBe(true);
  });
});

describe("rounding and guards", () => {
  it("applies a percentage once, half up", () => {
    expect(applyBps(1, 5000)).toBe(1); // 0.5 → 1
    expect(applyBps(1, 4999)).toBe(0);
    expect(applyBps(-1, 5000)).toBe(0); // −0.5 → 0 (half up toward +∞)
    expect(applyBps(-2_700_000, 7000)).toBe(-1_890_000);
  });

  it("rejects mismatched types and non-integer money", () => {
    expect(() => computeSettlement(villa, { contract_type: "fixed_target_bonus", revenue_satang: 1, opex_satang: 0 })).toThrow(SettlementError);
    expect(() => computeSettlement(villa, { contract_type: "property_management", revenue_satang: 1.5, turnovers: 0 })).toThrow(SettlementError);
    expect(() => turnkeyRun(melon(), 1, -1, 1)).toThrow(SettlementError);
  });
});

// ---- Property-based invariants (deterministic PRNG, ≥ 500 cases per type) ----

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
const rand = mulberry32(0x0e2e05);
const int = (max: number) => Math.floor(rand() * (max + 1));
const pick = <T,>(xs: readonly T[]): T => xs[int(xs.length - 1)]!;
const CASES = 600;

function expectWellFormed(r: SettlementResult, expectedLineTotal: number) {
  for (const l of r.lines) expect(Number.isSafeInteger(l.amount_satang), l.key).toBe(true);
  expect(Number.isSafeInteger(r.owner_payout_satang)).toBe(true);
  expect(Number.isSafeInteger(r.operator_payout_satang)).toBe(true);
  expect(lineSum(r)).toBe(expectedLineTotal);
  const party = (p: string) => r.lines.filter((l) => l.party === p).reduce((s, l) => s + l.amount_satang, 0);
  expect(r.owner_payout_satang).toBe(party("owner"));
  expect(r.operator_payout_satang).toBe(party("operator"));
  expect(r.rules_status).toBe("draft_unconfirmed");
}

describe("invariants (randomized, fixed seed)", () => {
  it(`turnkey: owner + operator = revenue − opex in ${CASES} cases`, () => {
    for (let i = 0; i < CASES; i++) {
      const ownerBps = int(10_000);
      const t = melon({
        owner_share_bps: ownerBps,
        operator_share_bps: 10_000 - ownerBps,
        management_retainer_monthly_satang: int(2_000_000),
        retainer_timing: pick(["before_split", "after_split"] as const),
        loss_policy: pick(["owner_absorbs", "split_by_share"] as const),
      });
      const revenue = int(5_000_000_000);
      const opex = int(5_000_000_000);
      const r = computeSettlement(t, { contract_type: "turnkey_profit_share", revenue_satang: revenue, opex_satang: opex, period_months: int(36) });
      expect(r.owner_payout_satang + r.operator_payout_satang).toBe(revenue - opex);
      expectWellFormed(r, revenue);
    }
  });

  it(`fixed_target_bonus: owner + operator = revenue − opex in ${CASES} cases`, () => {
    for (let i = 0; i < CASES; i++) {
      const t = nayhua({
        owner_target_revenue_satang: 1 + int(5_000_000_000),
        excess_operator_bps: int(10_000),
        opex_borne_by: pick(["operator", "owner"] as const),
        shortfall_policy: pick(["owner_absorbs", "operator_covers"] as const),
      });
      const revenue = int(8_000_000_000);
      const opex = int(2_000_000_000);
      const r = computeSettlement(t, { contract_type: "fixed_target_bonus", revenue_satang: revenue, opex_satang: opex });
      expect(r.owner_payout_satang + r.operator_payout_satang).toBe(revenue - opex);
      if (t.shortfall_policy === "operator_covers" && revenue < t.owner_target_revenue_satang) {
        const ownerOpex = t.opex_borne_by === "owner" ? opex : 0;
        expect(r.owner_payout_satang).toBe(t.owner_target_revenue_satang - ownerOpex);
      }
      expectWellFormed(r, revenue);
    }
  });

  it(`pay_per_job: owner = −contractor total, operator = 0 in ${CASES} cases`, () => {
    for (let i = 0; i < CASES; i++) {
      const rates = Array.from({ length: 1 + int(4) }, (_, k) => ({
        job_key: `job_${k}`,
        label: `งาน ${k}`,
        unit: "rai" as const,
        rate_satang: 1 + int(10_000_000),
      }));
      const jobs = Array.from({ length: 1 + int(5) }, () => ({ job_key: pick(rates).job_key, quantity_hundredths: 1 + int(1_000_000) }));
      const r = computeSettlement({ contract_type: "pay_per_job", rates }, { contract_type: "pay_per_job", jobs });
      const contractor = r.lines.filter((l) => l.party === "contractor").reduce((s, l) => s + l.amount_satang, 0);
      expect(r.owner_payout_satang).toBe(-contractor);
      expect(r.operator_payout_satang).toBe(0);
      jobs.forEach((j, k) => {
        const rate = rates.find((x) => x.job_key === j.job_key)!.rate_satang;
        // Independent check with exact integer arithmetic.
        const exact = (BigInt(rate) * BigInt(j.quantity_hundredths) * 2n + 100n) / 200n;
        expect(r.lines[k]!.amount_satang).toBe(Number(exact));
      });
      expectWellFormed(r, 0);
    }
  });

  it(`property_management: owner + operator = revenue in ${CASES} cases`, () => {
    for (let i = 0; i < CASES; i++) {
      const t: Property = { contract_type: "property_management", revenue_commission_bps: int(10_000), cleaning_fee_per_turnover_satang: int(500_000) };
      const revenue = int(5_000_000_000);
      const r = computeSettlement(t, { contract_type: "property_management", revenue_satang: revenue, turnovers: int(60) });
      expect(r.owner_payout_satang + r.operator_payout_satang).toBe(revenue);
      expectWellFormed(r, revenue);
    }
  });
});
