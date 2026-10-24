import { describe, expect, it } from "vitest";
import { bpsToPct, CONTRACT_TYPE_LABELS, ContractTermsSchema, ContractType, CreateContractInput, pctToBps } from "../src/index";

const turnkey = { contract_type: "turnkey_profit_share", owner_share_pct: 70, operator_share_pct: 30, management_retainer_monthly_thb: 5000 };
const payPerJob = {
  contract_type: "pay_per_job",
  rates: [
    { job_key: "drone_spray", label: "โดรนพ่นสาร", unit: "rai", rate_thb: 120 },
    { job_key: "harvester", label: "รถเกี่ยวเก็บเกี่ยว", unit: "rai", rate_thb: 450 },
  ],
};
const property = { contract_type: "property_management", revenue_commission_pct: 15, cleaning_fee_per_turnover_thb: 800 };
const fixed = { contract_type: "fixed_target_bonus", owner_target_revenue_thb: 350_000 };

const ok = (terms: unknown) => ContractTermsSchema.safeParse(terms).success;

describe("ContractTermsSchema", () => {
  it("accepts the team's four example contracts and fills defaults", () => {
    expect(ContractTermsSchema.parse(turnkey)).toEqual({
      ...turnkey,
      retainer_timing: "before_split",
      loss_policy: "owner_absorbs",
    });
    expect(ContractTermsSchema.parse(payPerJob)).toEqual(payPerJob);
    expect(ContractTermsSchema.parse(property)).toEqual(property);
    expect(ContractTermsSchema.parse(fixed)).toEqual({
      ...fixed,
      excess_operator_pct: 100,
      opex_borne_by: "operator",
      shortfall_policy: "owner_absorbs",
    });
    expect(ContractTermsSchema.parse({ ...turnkey, management_retainer_monthly_thb: undefined })).toMatchObject({
      management_retainer_monthly_thb: 0,
    });
  });

  it("requires owner + operator shares to total exactly 100", () => {
    expect(ok({ ...turnkey, owner_share_pct: 60 })).toBe(false);
    expect(ok({ ...turnkey, owner_share_pct: 66.67, operator_share_pct: 33.33 })).toBe(true);
    expect(ok({ ...turnkey, owner_share_pct: 66.66, operator_share_pct: 33.33 })).toBe(false);
  });

  it("rejects empty rates, duplicate job keys, bad slugs and non-positive rates", () => {
    expect(ok({ ...payPerJob, rates: [] })).toBe(false);
    expect(ok({ ...payPerJob, rates: [payPerJob.rates[0], payPerJob.rates[0]] })).toBe(false);
    expect(ok({ ...payPerJob, rates: [{ ...payPerJob.rates[0], job_key: "Drone Spray" }] })).toBe(false);
    expect(ok({ ...payPerJob, rates: [{ ...payPerJob.rates[0], rate_thb: 0 }] })).toBe(false);
    expect(ok({ ...payPerJob, rates: [{ ...payPerJob.rates[0], unit: "acre" }] })).toBe(false);
  });

  it("bounds percentages and money", () => {
    expect(ok({ ...property, revenue_commission_pct: 100.01 })).toBe(false);
    expect(ok({ ...property, revenue_commission_pct: -1 })).toBe(false);
    expect(ok({ ...property, revenue_commission_pct: 15.555 })).toBe(false);
    expect(ok({ ...property, cleaning_fee_per_turnover_thb: 800.005 })).toBe(false);
    expect(ok({ ...fixed, owner_target_revenue_thb: 0 })).toBe(false);
  });

  it("rejects unknown types and unknown fields (strict)", () => {
    expect(ok({ contract_type: "barter" })).toBe(false);
    expect(ok({ ...property, bonus_pct: 5 })).toBe(false);
    expect(ok({ ...payPerJob, rates: [{ ...payPerJob.rates[0], discount: 1 }] })).toBe(false);
  });
});

describe("CreateContractInput", () => {
  const base = { partner_label: "ผู้ดูแลสวน (demo)", starts_at: "2026-10-01T00:00:00.000+07:00", terms: fixed };

  it("accepts a valid contract and rejects server-owned fields", () => {
    expect(CreateContractInput.safeParse(base).success).toBe(true);
    expect(CreateContractInput.safeParse({ ...base, ends_at: "2027-09-30T00:00:00.000+07:00" }).success).toBe(true);
    for (const extra of [{ id: "x" }, { rules_status: "confirmed" }, { is_active: false }]) {
      expect(CreateContractInput.safeParse({ ...base, ...extra }).success).toBe(false);
    }
  });

  it("validates the label and the date range", () => {
    expect(CreateContractInput.safeParse({ ...base, partner_label: "" }).success).toBe(false);
    expect(CreateContractInput.safeParse({ ...base, partner_label: "x".repeat(101) }).success).toBe(false);
    expect(CreateContractInput.safeParse({ ...base, ends_at: "2026-09-01T00:00:00.000Z" }).success).toBe(false);
  });
});

describe("helpers", () => {
  it("converts percent ↔ basis points exactly", () => {
    for (const pct of [0, 0.01, 15, 33.33, 66.67, 70, 100]) expect(bpsToPct(pctToBps(pct))).toBe(pct);
    expect(pctToBps(33.33)).toBe(3333);
  });

  it("has a Thai label for every contract type", () => {
    for (const t of ContractType.options) expect(CONTRACT_TYPE_LABELS[t].length).toBeGreaterThan(0);
  });
});
