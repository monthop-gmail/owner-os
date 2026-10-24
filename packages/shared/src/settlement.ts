// Settlement *preview* engine. Pure: no I/O, money in integer satang, percentages in basis points.
// The rules are not yet confirmed with the real owner, so every result is draft_unconfirmed and lists
// the interpretation it used in `assumptions`. Nothing here records or pays a settlement.
import { z } from "zod";
import { hasAtMostDecimals } from "./money";
import { IdSchema } from "./schemas";

/** Contract terms in storage units (satang / basis points), as kept in asset_contracts.terms_json. */
export type SatangContractTerms =
  | {
      contract_type: "turnkey_profit_share";
      owner_share_bps: number;
      operator_share_bps: number;
      management_retainer_monthly_satang: number;
      retainer_timing: "before_split" | "after_split";
      loss_policy: "owner_absorbs" | "split_by_share";
    }
  | {
      contract_type: "pay_per_job";
      rates: { job_key: string; label: string; unit: "rai" | "job" | "hour"; rate_satang: number }[];
    }
  | {
      contract_type: "property_management";
      revenue_commission_bps: number;
      cleaning_fee_per_turnover_satang: number;
    }
  | {
      contract_type: "fixed_target_bonus";
      owner_target_revenue_satang: number;
      excess_operator_bps: number;
      opex_borne_by: "operator_reimbursed" | "operator" | "owner";
      shortfall_policy: "owner_absorbs" | "operator_covers";
    };

export type SettlementParty = "owner" | "operator" | "contractor" | "cost";
export type SettlementLine = { key: string; label_th: string; amount_satang: number; party: SettlementParty };

export type SettlementResult = {
  contract_type: SatangContractTerms["contract_type"];
  /** Signed lines; they always add up to the revenue (0 for pay_per_job). */
  lines: SettlementLine[];
  owner_payout_satang: number;
  operator_payout_satang: number;
  rules_status: "draft_unconfirmed";
  assumptions: string[];
};

export type SettlementInput =
  | { contract_type: "turnkey_profit_share"; revenue_satang: number; opex_satang: number; period_months: number }
  | { contract_type: "fixed_target_bonus"; revenue_satang: number; opex_satang: number }
  | { contract_type: "pay_per_job"; jobs: { job_key: string; quantity_hundredths: number }[] }
  | { contract_type: "property_management"; revenue_satang: number; turnovers: number };

export class SettlementError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const BPS = 10_000n;

/** floor(a / b) for BigInt (BigInt division truncates toward zero). */
function floorDiv(a: bigint, b: bigint): bigint {
  const q = a / b;
  return (a % b !== 0n && (a < 0n) !== (b < 0n)) ? q - 1n : q;
}

/** round(value × numerator / denominator), half up (toward +∞), exact via BigInt. */
function mulRound(value: number, numerator: number, denominator: bigint): number {
  const result = floorDiv(BigInt(value) * BigInt(numerator) * 2n + denominator, denominator * 2n);
  if (result > BigInt(Number.MAX_SAFE_INTEGER) || result < BigInt(Number.MIN_SAFE_INTEGER)) {
    throw new SettlementError("out_of_range", "amount exceeds the safe integer range");
  }
  return Number(result);
}

/** One percentage applied once: round(amount × bps / 10000), half up. */
export const applyBps = (amount_satang: number, bps: number): number => mulRound(amount_satang, bps, BPS);

function requireInt(name: string, v: number, min = 0): void {
  if (!Number.isSafeInteger(v) || v < min) throw new SettlementError("invalid_input", `${name} must be a safe integer ≥ ${min}`);
}

const DRAFT = "กติกายังไม่ยืนยันกับเจ้าของจริง (draft_unconfirmed) — เป็นตัวเลขร่างเพื่อพิจารณาเท่านั้น ไม่ใช่การจ่ายเงิน";
const ROUNDING = "คูณเปอร์เซ็นต์ครั้งเดียวแล้วปัดครึ่งขึ้นเป็นสตางค์ · ส่วนของอีกฝ่ายคิดจากยอดรวมลบส่วนแรก จึงกระทบกันทุกสตางค์";

function finish(contract_type: SettlementResult["contract_type"], lines: SettlementLine[], assumptions: string[]): SettlementResult {
  const total = (party: SettlementParty) => lines.filter((l) => l.party === party).reduce((s, l) => s + l.amount_satang, 0);
  return {
    contract_type,
    lines,
    owner_payout_satang: total("owner"),
    operator_payout_satang: total("operator"),
    rules_status: "draft_unconfirmed",
    assumptions: [DRAFT, ...assumptions],
  };
}

function turnkey(t: Extract<SatangContractTerms, { contract_type: "turnkey_profit_share" }>, revenue: number, opex: number, months: number) {
  const retainer = t.management_retainer_monthly_satang * months;
  requireInt("retainer", retainer);
  const lines: SettlementLine[] = [{ key: "opex", label_th: "ค่าใช้จ่ายดำเนินงาน", amount_satang: opex, party: "cost" }];
  const assumptions = [
    ROUNDING,
    `ค่าบริหารรายเดือนคิด ${months} เดือน (${t.management_retainer_monthly_satang} สตางค์/เดือน)`,
  ];

  // Split `pool` by the owner share; the operator gets the remainder (never a second percentage).
  const split = (pool: number) => {
    if (pool < 0 && t.loss_policy === "owner_absorbs") {
      lines.push({ key: "owner_loss", label_th: "ขาดทุน (เจ้าของรับ)", amount_satang: pool, party: "owner" });
      assumptions.push("ขาดทุน: เจ้าของรับผลขาดทุนทั้งหมด ผู้ดูแลไม่ร่วมรับ (owner_absorbs)");
      return;
    }
    const owner = applyBps(pool, t.owner_share_bps);
    lines.push(
      { key: "owner_share", label_th: "ส่วนแบ่งเจ้าของ", amount_satang: owner, party: "owner" },
      { key: "operator_share", label_th: "ส่วนแบ่งผู้ดูแล", amount_satang: pool - owner, party: "operator" },
    );
    if (pool < 0) assumptions.push("ขาดทุน: แบ่งผลขาดทุนตามสัดส่วนเดียวกับกำไร (split_by_share)");
  };

  if (t.retainer_timing === "before_split") {
    lines.push({ key: "retainer", label_th: "ค่าบริหารรายเดือน (หักก่อนแบ่ง)", amount_satang: retainer, party: "operator" });
    split(revenue - opex - retainer);
    assumptions.push("ค่าบริหารหักจากกำไรก่อนแบ่ง (before_split)");
  } else {
    split(revenue - opex);
    lines.push(
      { key: "retainer_from_owner", label_th: "ค่าบริหารรายเดือน (เจ้าของจ่ายจากส่วนของตน)", amount_satang: -retainer, party: "owner" },
      { key: "retainer", label_th: "ค่าบริหารรายเดือน", amount_satang: retainer, party: "operator" },
    );
    assumptions.push("ค่าบริหารจ่ายจากส่วนของเจ้าของหลังแบ่งกำไร (after_split)");
  }
  return finish(t.contract_type, lines, assumptions);
}

type FixedTargetTerms = Extract<SatangContractTerms, { contract_type: "fixed_target_bonus" }>;

/** Shortfall handling shared by both fixed-target variants; `compared` is what was measured against the target. */
function applyShortfall(t: FixedTargetTerms, compared: number, lines: SettlementLine[], assumptions: string[], what: string) {
  const target = t.owner_target_revenue_satang;
  if (compared >= target) return;
  if (t.shortfall_policy === "operator_covers") {
    const shortfall = target - compared;
    lines.push(
      { key: "shortfall_cover", label_th: `ชดเชย${what}ไม่ถึงเป้า (ผู้ดูแลจ่าย)`, amount_satang: -shortfall, party: "operator" },
      { key: "shortfall_to_owner", label_th: "รับชดเชยให้ถึงเป้า", amount_satang: shortfall, party: "owner" },
    );
    assumptions.push(`${what}ไม่ถึงเป้า: ผู้ดูแลชดเชยส่วนที่ขาดให้เจ้าของ (operator_covers)`);
  } else {
    assumptions.push(`${what}ไม่ถึงเป้า: เจ้าของรับตามจริง ไม่มีโบนัส (owner_absorbs)`);
  }
}

/**
 * operator_reimbursed: opex is paid back to the operator from revenue first, and only the rest
 * (net = revenue − opex) is compared with the owner's target. The operator's result is the bonus (≥ 0).
 */
function fixedTargetReimbursed(t: FixedTargetTerms, revenue: number, opex: number) {
  const target = t.owner_target_revenue_satang;
  const net = revenue - opex;
  const excess = Math.max(0, net - target);
  const bonus = applyBps(excess, t.excess_operator_bps);
  const lines: SettlementLine[] = [
    { key: "opex", label_th: "ค่าใช้จ่ายดำเนินงาน", amount_satang: opex, party: "cost" },
    { key: "opex_reimbursement", label_th: "คืนค่าใช้จ่ายให้ผู้ดูแลจากยอดขาย", amount_satang: opex, party: "operator" },
    { key: "opex_paid_by_operator", label_th: "ค่าใช้จ่ายที่ผู้ดูแลออกไปก่อน", amount_satang: -opex, party: "operator" },
    {
      key: "owner_net",
      label_th: net < target ? "ยอดหลังคืนค่าใช้จ่าย (ไม่ถึงเป้า · เป็นของเจ้าของ)" : "รายได้ถึงเป้าของเจ้าของ",
      amount_satang: Math.min(net, target),
      party: "owner",
    },
  ];
  if (excess - bonus !== 0) {
    lines.push({ key: "excess_to_owner", label_th: "ส่วนเกินเป้าที่เป็นของเจ้าของ", amount_satang: excess - bonus, party: "owner" });
  }
  lines.push({ key: "operator_bonus", label_th: "โบนัสส่วนเกินเป้า (ผู้ดูแล)", amount_satang: bonus, party: "operator" });
  const assumptions = [
    ROUNDING,
    "คืนค่าใช้จ่ายให้ผู้ดูแลจากยอดขายก่อน แล้วจึงเทียบยอดที่เหลือกับเป้า (operator_reimbursed) — ผู้ดูแลได้โบนัสส่วนเกินเป้าเท่านั้นและไม่ติดลบ",
  ];
  if (net < 0) assumptions.push("ยอดขายไม่พอคืนค่าใช้จ่าย: เจ้าของรับส่วนที่ขาด (ยอดเจ้าของติดลบ)");
  if (t.shortfall_policy === "operator_covers") {
    assumptions.push("เลือก operator_covers ร่วมกับ operator_reimbursed: ตัวเลือกนี้ทำให้ผู้ดูแลติดลบได้เมื่อไม่ถึงเป้า");
  }
  applyShortfall(t, net, lines, assumptions, "ยอดหลังคืนค่าใช้จ่าย");
  return finish(t.contract_type, lines, assumptions);
}

function fixedTarget(t: FixedTargetTerms, revenue: number, opex: number) {
  if (t.opex_borne_by === "operator_reimbursed") return fixedTargetReimbursed(t, revenue, opex);
  const target = t.owner_target_revenue_satang;
  const excess = Math.max(0, revenue - target);
  const bonus = applyBps(excess, t.excess_operator_bps);
  const lines: SettlementLine[] = [
    { key: "opex", label_th: "ค่าใช้จ่ายดำเนินงาน", amount_satang: opex, party: "cost" },
    { key: "owner_target", label_th: "รายได้ถึงเป้าของเจ้าของ", amount_satang: Math.min(revenue, target), party: "owner" },
  ];
  const assumptions = [ROUNDING];
  if (excess - bonus !== 0) {
    lines.push({ key: "excess_to_owner", label_th: "ส่วนเกินเป้าที่เป็นของเจ้าของ", amount_satang: excess - bonus, party: "owner" });
  }
  lines.push({ key: "operator_bonus", label_th: "โบนัสส่วนเกินเป้า (ผู้ดูแล)", amount_satang: bonus, party: "operator" });
  lines.push({
    key: "opex_borne",
    label_th: t.opex_borne_by === "operator" ? "ค่าใช้จ่าย (ผู้ดูแลรับ)" : "ค่าใช้จ่าย (เจ้าของรับ)",
    amount_satang: -opex,
    party: t.opex_borne_by,
  });
  assumptions.push(t.opex_borne_by === "operator" ? "ผู้ดูแลรับค่าใช้จ่ายเอง ยอดผู้ดูแลติดลบได้" : "เจ้าของรับค่าใช้จ่าย");
  applyShortfall(t, revenue, lines, assumptions, "รายได้");
  return finish(t.contract_type, lines, assumptions);
}

function payPerJob(t: Extract<SatangContractTerms, { contract_type: "pay_per_job" }>, jobs: { job_key: string; quantity_hundredths: number }[]) {
  const lines: SettlementLine[] = [];
  let total = 0;
  for (const job of jobs) {
    requireInt(`quantity of ${job.job_key}`, job.quantity_hundredths, 1);
    const rate = t.rates.find((r) => r.job_key === job.job_key);
    if (!rate) throw new SettlementError("unknown_job_key", `job_key "${job.job_key}" is not in the contract rates`);
    const amount = mulRound(rate.rate_satang, job.quantity_hundredths, 100n);
    total += amount;
    lines.push({
      key: `job:${job.job_key}`,
      label_th: `${rate.label} × ${job.quantity_hundredths / 100} ${rate.unit}`,
      amount_satang: amount,
      party: "contractor",
    });
  }
  lines.push({ key: "owner_pays", label_th: "เจ้าของจ่ายค่าจ้าง", amount_satang: -total, party: "owner" });
  return finish(t.contract_type, lines, ["ค่าจ้างต่องาน = อัตรา × ปริมาณ ปัดครึ่งขึ้นเป็นสตางค์ต่อบรรทัด", "จ้างรายงานไม่มีส่วนแบ่งของผู้ดูแล (operator = 0)"]);
}

function property(t: Extract<SatangContractTerms, { contract_type: "property_management" }>, revenue: number, turnovers: number) {
  requireInt("turnovers", turnovers);
  const commission = applyBps(revenue, t.revenue_commission_bps);
  const cleaning = t.cleaning_fee_per_turnover_satang * turnovers;
  requireInt("cleaning", cleaning);
  const ownerNet = revenue - commission - cleaning;
  const lines: SettlementLine[] = [
    { key: "commission", label_th: "ค่าคอมมิชชันบริหาร", amount_satang: commission, party: "operator" },
    { key: "cleaning", label_th: `ค่าแม่บ้าน ${turnovers} รอบ`, amount_satang: cleaning, party: "operator" },
    { key: "owner_net", label_th: "รายได้สุทธิเจ้าของ", amount_satang: ownerNet, party: "owner" },
  ];
  const assumptions = [ROUNDING, "ค่าคอมมิชชันคิดจากรายได้รวม ค่าแม่บ้านคิดตามจำนวนรอบ"];
  if (ownerNet < 0) assumptions.push("ค่าคอมมิชชันและค่าแม่บ้านเกินรายได้: ยอดเจ้าของติดลบ (เจ้าของต้องจ่ายเพิ่ม)");
  return finish(t.contract_type, lines, assumptions);
}

/** Draft split of one period under `terms`. Throws SettlementError for inputs the contract cannot price. */
export function computeSettlement(terms: SatangContractTerms, input: SettlementInput): SettlementResult {
  if (terms.contract_type !== input.contract_type) {
    throw new SettlementError("type_mismatch", `input is for ${input.contract_type}, contract is ${terms.contract_type}`);
  }
  switch (input.contract_type) {
    case "turnkey_profit_share":
      requireInt("revenue_satang", input.revenue_satang);
      requireInt("opex_satang", input.opex_satang);
      requireInt("period_months", input.period_months);
      return turnkey(terms as Extract<SatangContractTerms, { contract_type: "turnkey_profit_share" }>, input.revenue_satang, input.opex_satang, input.period_months);
    case "fixed_target_bonus":
      requireInt("revenue_satang", input.revenue_satang);
      requireInt("opex_satang", input.opex_satang);
      return fixedTarget(terms as Extract<SatangContractTerms, { contract_type: "fixed_target_bonus" }>, input.revenue_satang, input.opex_satang);
    case "pay_per_job":
      return payPerJob(terms as Extract<SatangContractTerms, { contract_type: "pay_per_job" }>, input.jobs);
    case "property_management":
      requireInt("revenue_satang", input.revenue_satang);
      return property(terms as Extract<SatangContractTerms, { contract_type: "property_management" }>, input.revenue_satang, input.turnovers);
  }
}

// ---- API input (baht) for POST /api/contracts/:id/settlement-preview, chosen by the contract's type ----

const Thb = z.number().min(0).max(1e11).refine((v) => hasAtMostDecimals(v, 2), "at most 2 decimal places");

const revenueSource = <T extends { crop_cycle_id?: string | undefined; revenue_thb?: number | undefined }>(v: T) =>
  (v.crop_cycle_id === undefined) !== (v.revenue_thb === undefined);
const REVENUE_SOURCE_MESSAGE = { message: "send exactly one of crop_cycle_id or revenue_thb", path: ["revenue_thb"] };

export const TurnkeyPreviewInput = z
  .strictObject({
    crop_cycle_id: IdSchema.optional(),
    revenue_thb: Thb.optional(),
    opex_thb: Thb,
    period_months: z.number().int().min(0).max(1200).optional(),
  })
  .refine(revenueSource, REVENUE_SOURCE_MESSAGE);

export const FixedTargetPreviewInput = z
  .strictObject({ crop_cycle_id: IdSchema.optional(), revenue_thb: Thb.optional(), opex_thb: Thb })
  .refine(revenueSource, REVENUE_SOURCE_MESSAGE);

export const PayPerJobPreviewInput = z.strictObject({
  jobs: z
    .array(
      z.strictObject({
        job_key: z.string().min(1).max(50),
        quantity: z
          .number()
          .positive()
          .max(1e7)
          .refine((v) => hasAtMostDecimals(v, 2), "at most 2 decimal places"),
      }),
    )
    .min(1),
});

export const PropertyPreviewInput = z.strictObject({
  revenue_thb: Thb,
  turnovers: z.number().int().min(0).max(100_000),
});
