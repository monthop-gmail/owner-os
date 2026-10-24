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
      disaster_clause?: {
        min_damage_bps: number;
        loss_policy_on_disaster: "owner_absorbs" | "split_by_share";
        insurance_recipient: "pool" | "owner";
      };
    }
  | {
      contract_type: "pay_per_job";
      rates: { job_key: string; label: string; unit: "rai" | "job" | "hour"; rate_satang: number }[];
      disaster_clause?: { min_damage_bps: number; cancellation_fee_bps_on_disaster: number };
    }
  | {
      contract_type: "property_management";
      revenue_commission_bps: number;
      cleaning_fee_per_turnover_satang: number;
      disaster_clause?: { min_damage_bps: number; repair_cost_owner_bps: number };
    }
  | {
      contract_type: "fixed_target_bonus";
      owner_target_revenue_satang: number;
      excess_operator_bps: number;
      opex_borne_by: "operator_reimbursed" | "operator" | "owner";
      shortfall_policy: "owner_absorbs" | "operator_covers";
      disaster_clause?: {
        min_damage_bps: number;
        target_adjustment: "scale_by_damage" | "none";
        insurance_recipient: "pool" | "owner";
      };
    };

export type SettlementParty = "owner" | "operator" | "contractor" | "cost";
export type SettlementLine = { key: string; label_th: string; amount_satang: number; party: SettlementParty };

export type SettlementInflow = { key: "revenue" | "insurance_payout" | "government_aid"; label_th: string; amount_satang: number };

export type SettlementResult = {
  contract_type: SatangContractTerms["contract_type"];
  /** Money coming in: revenue plus any insurance payout / government aid (each a separate entry). */
  inflows: SettlementInflow[];
  /** Signed allocation lines; they always add up to the inflows (revenue only, or 0 for pay_per_job without aid). */
  lines: SettlementLine[];
  owner_payout_satang: number;
  operator_payout_satang: number;
  rules_status: "draft_unconfirmed";
  /** True when the damage reached the contract's disaster threshold and the disaster clause was used. */
  disaster_clause_applied: boolean;
  assumptions: string[];
};

/** Disaster context for a period: combined damage (bps) and money received because of it. */
export type DisasterInput = { damage_bps: number; insurance_satang: number; government_aid_satang: number };
export type JobQuantity = { job_key: string; quantity_hundredths: number };

export type SettlementInput =
  | { contract_type: "turnkey_profit_share"; revenue_satang: number; opex_satang: number; period_months: number; disaster?: DisasterInput }
  | { contract_type: "fixed_target_bonus"; revenue_satang: number; opex_satang: number; disaster?: DisasterInput }
  | { contract_type: "pay_per_job"; jobs: JobQuantity[]; cancelled_jobs?: JobQuantity[]; disaster?: DisasterInput }
  | {
      contract_type: "property_management";
      revenue_satang: number;
      turnovers: number;
      repair_cost_satang?: number;
      disaster?: DisasterInput;
    };

/** Defaults used when a contract has no disaster_clause (or omits a field). */
export const DISASTER_CLAUSE_DEFAULTS = {
  min_damage_bps: 2000,
  loss_policy_on_disaster: "owner_absorbs",
  insurance_recipient: "pool",
  target_adjustment: "scale_by_damage",
  cancellation_fee_bps_on_disaster: 0,
  repair_cost_owner_bps: 10_000,
} as const;

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
  return roundDiv(BigInt(value) * BigInt(numerator), denominator);
}

/** round(numerator / denominator), half up (toward +∞), as a safe integer. */
function roundDiv(numerator: bigint, denominator: bigint): number {
  const result = floorDiv(numerator * 2n + denominator, denominator * 2n);
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
    inflows: [],
    lines,
    owner_payout_satang: total("owner"),
    operator_payout_satang: total("operator"),
    rules_status: "draft_unconfirmed",
    disaster_clause_applied: false,
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

const pct = (bps: number) => `${bps / 100}%`;

/** Adds lines / assumptions to a result and recomputes payouts. */
function extend(
  r: SettlementResult,
  more: { lines?: SettlementLine[]; assumptions?: string[]; inflows: SettlementInflow[]; applied: boolean },
): SettlementResult {
  const lines = [...r.lines, ...(more.lines ?? [])];
  const total = (party: SettlementParty) => lines.filter((l) => l.party === party).reduce((s, l) => s + l.amount_satang, 0);
  return {
    ...r,
    inflows: more.inflows,
    lines,
    owner_payout_satang: total("owner"),
    operator_payout_satang: total("operator"),
    disaster_clause_applied: more.applied,
    assumptions: [...r.assumptions, ...(more.assumptions ?? [])],
  };
}

function inflowsOf(revenue: number | null, d: DisasterInput | undefined): SettlementInflow[] {
  const out: SettlementInflow[] = [];
  if (revenue !== null) out.push({ key: "revenue", label_th: "รายได้จากการขาย/ค่าเช่า", amount_satang: revenue });
  if (d && d.insurance_satang > 0) out.push({ key: "insurance_payout", label_th: "เงินประกัน", amount_satang: d.insurance_satang });
  if (d && d.government_aid_satang > 0) out.push({ key: "government_aid", label_th: "เงินช่วยเหลือจากรัฐ", amount_satang: d.government_aid_satang });
  return out;
}

/** Insurance payout / aid paid straight to the owner (as separate owner lines). */
function ownerReceipts(d: DisasterInput | undefined): SettlementLine[] {
  const lines: SettlementLine[] = [];
  if (d && d.insurance_satang > 0) {
    lines.push({ key: "insurance_payout", label_th: "เงินประกัน (เป็นของเจ้าของ)", amount_satang: d.insurance_satang, party: "owner" });
  }
  if (d && d.government_aid_satang > 0) {
    lines.push({ key: "government_aid", label_th: "เงินช่วยเหลือจากรัฐ (เป็นของเจ้าของ)", amount_satang: d.government_aid_satang, party: "owner" });
  }
  return lines;
}

function validateDisaster(d: DisasterInput | undefined): void {
  if (!d) return;
  requireInt("damage_bps", d.damage_bps);
  if (d.damage_bps > 10_000) throw new SettlementError("invalid_input", "damage_bps must be ≤ 10000");
  requireInt("insurance_satang", d.insurance_satang);
  requireInt("government_aid_satang", d.government_aid_satang);
}

/** Whether the disaster clause applies, with a Thai explanation either way. */
function disasterGate(d: DisasterInput | undefined, minBps: number): { applies: boolean; note: string[] } {
  if (!d) return { applies: false, note: [] };
  if (d.damage_bps >= minBps) {
    return { applies: true, note: [`ใช้ข้อตกลงกรณีภัย: ความเสียหายรวม ${pct(d.damage_bps)} ถึงเกณฑ์ ${pct(minBps)}`] };
  }
  const note = [`ความเสียหายรวม ${pct(d.damage_bps)} ต่ำกว่าเกณฑ์ ${pct(minBps)}: ใช้กติกาปกติ`];
  if (d.insurance_satang + d.government_aid_satang > 0) note.push("เงินประกัน/เงินช่วยเหลือยังนำมาคิดตามผู้รับที่กำหนดในสัญญา");
  return { applies: false, note };
}

const recipientNote = (recipient: "pool" | "owner") =>
  recipient === "pool"
    ? "เงินประกัน/เงินช่วยเหลือรวมเข้ากับรายได้ก่อนคิดส่วนแบ่ง (insurance_recipient = pool)"
    : "เงินประกัน/เงินช่วยเหลือเป็นของเจ้าของ บวกให้หลังคิดส่วนแบ่ง (insurance_recipient = owner)";

/** Draft split of one period under `terms`. Throws SettlementError for inputs the contract cannot price. */
export function computeSettlement(terms: SatangContractTerms, input: SettlementInput): SettlementResult {
  if (terms.contract_type !== input.contract_type) {
    throw new SettlementError("type_mismatch", `input is for ${input.contract_type}, contract is ${terms.contract_type}`);
  }
  const d = input.disaster;
  validateDisaster(d);
  const aid = d ? d.insurance_satang + d.government_aid_satang : 0;

  switch (input.contract_type) {
    case "turnkey_profit_share": {
      const t = terms as Extract<SatangContractTerms, { contract_type: "turnkey_profit_share" }>;
      requireInt("revenue_satang", input.revenue_satang);
      requireInt("opex_satang", input.opex_satang);
      requireInt("period_months", input.period_months);
      const clause = { ...DISASTER_CLAUSE_DEFAULTS, ...t.disaster_clause };
      const gate = disasterGate(d, clause.min_damage_bps);
      const effective = gate.applies ? { ...t, loss_policy: clause.loss_policy_on_disaster } : t;
      const pooled = clause.insurance_recipient === "pool" ? aid : 0;
      const base = turnkey(effective, input.revenue_satang + pooled, input.opex_satang, input.period_months);
      const notes = [...gate.note];
      if (gate.applies) notes.push(`ขาดทุนช่วงมีภัยใช้ loss_policy_on_disaster = ${clause.loss_policy_on_disaster}`);
      if (aid > 0) notes.push(recipientNote(clause.insurance_recipient));
      return extend(base, {
        lines: clause.insurance_recipient === "owner" ? ownerReceipts(d) : [],
        assumptions: notes,
        inflows: inflowsOf(input.revenue_satang, d),
        applied: gate.applies,
      });
    }
    case "fixed_target_bonus": {
      const t = terms as Extract<SatangContractTerms, { contract_type: "fixed_target_bonus" }>;
      requireInt("revenue_satang", input.revenue_satang);
      requireInt("opex_satang", input.opex_satang);
      const clause = { ...DISASTER_CLAUSE_DEFAULTS, ...t.disaster_clause };
      const gate = disasterGate(d, clause.min_damage_bps);
      const scale = gate.applies && clause.target_adjustment === "scale_by_damage" && d !== undefined;
      const target = scale ? applyBps(t.owner_target_revenue_satang, 10_000 - d.damage_bps) : t.owner_target_revenue_satang;
      const pooled = clause.insurance_recipient === "pool" ? aid : 0;
      const base = fixedTarget({ ...t, owner_target_revenue_satang: target }, input.revenue_satang + pooled, input.opex_satang);
      const notes = [...gate.note];
      if (scale) notes.push(`ลดเป้ารายได้เจ้าของตามความเสียหาย: ${t.owner_target_revenue_satang} × (1 − ${pct(d.damage_bps)}) = ${target} สตางค์`);
      else if (gate.applies) notes.push("ไม่ปรับเป้าตามความเสียหาย (target_adjustment = none)");
      if (aid > 0) notes.push(recipientNote(clause.insurance_recipient));
      return extend(base, {
        lines: clause.insurance_recipient === "owner" ? ownerReceipts(d) : [],
        assumptions: notes,
        inflows: inflowsOf(input.revenue_satang, d),
        applied: gate.applies,
      });
    }
    case "pay_per_job": {
      const t = terms as Extract<SatangContractTerms, { contract_type: "pay_per_job" }>;
      const clause = { ...DISASTER_CLAUSE_DEFAULTS, ...t.disaster_clause };
      const gate = disasterGate(d, clause.min_damage_bps);
      const base = payPerJob(t, input.jobs);
      const lines: SettlementLine[] = [];
      const notes = [...gate.note];
      const cancelled = input.cancelled_jobs ?? [];
      if (cancelled.length > 0) {
        let fees = 0;
        for (const job of cancelled) {
          requireInt(`cancelled quantity of ${job.job_key}`, job.quantity_hundredths, 1);
          const rate = t.rates.find((r) => r.job_key === job.job_key);
          if (!rate) throw new SettlementError("unknown_job_key", `job_key "${job.job_key}" is not in the contract rates`);
          const feeBps = gate.applies ? clause.cancellation_fee_bps_on_disaster : 0;
          // rate × quantity × fee, rounded once.
          const amount = roundDiv(BigInt(rate.rate_satang) * BigInt(job.quantity_hundredths) * BigInt(feeBps), 100n * BPS);
          fees += amount;
          lines.push({
            key: `cancelled:${job.job_key}`,
            label_th: `ค่าชดเชยงานยกเลิกเพราะภัย: ${rate.label} × ${job.quantity_hundredths / 100} ${rate.unit} × ${pct(feeBps)}`,
            amount_satang: amount,
            party: "contractor",
          });
        }
        lines.push({ key: "owner_pays_cancellation", label_th: "เจ้าของจ่ายค่าชดเชยงานยกเลิก", amount_satang: -fees, party: "owner" });
        notes.push(
          gate.applies
            ? `งานที่ยกเลิกเพราะภัยได้ค่าชดเชย ${pct(clause.cancellation_fee_bps_on_disaster)} ของค่างาน`
            : "งานที่ยกเลิกไม่มีค่าชดเชย เพราะไม่ได้ใช้ข้อตกลงกรณีภัย",
        );
      }
      if (aid > 0) notes.push("เงินประกัน/เงินช่วยเหลือเป็นของเจ้าของ (จ้างรายงานไม่มีการแบ่งรายได้)");
      return extend(base, { lines: [...lines, ...ownerReceipts(d)], assumptions: notes, inflows: inflowsOf(null, d), applied: gate.applies });
    }
    case "property_management": {
      const t = terms as Extract<SatangContractTerms, { contract_type: "property_management" }>;
      requireInt("revenue_satang", input.revenue_satang);
      const clause = { ...DISASTER_CLAUSE_DEFAULTS, ...t.disaster_clause };
      const gate = disasterGate(d, clause.min_damage_bps);
      const base = property(t, input.revenue_satang, input.turnovers);
      const lines: SettlementLine[] = [];
      const notes = [...gate.note];
      const repair = input.repair_cost_satang ?? 0;
      requireInt("repair_cost_satang", repair);
      if (repair > 0) {
        const ownerBps = gate.applies ? clause.repair_cost_owner_bps : 10_000;
        const ownerPart = applyBps(repair, ownerBps);
        lines.push(
          { key: "repair_cost", label_th: "ค่าซ่อมแซม", amount_satang: repair, party: "cost" },
          { key: "repair_owner", label_th: "ค่าซ่อม (เจ้าของรับ)", amount_satang: -ownerPart, party: "owner" },
        );
        if (repair - ownerPart !== 0) {
          lines.push({ key: "repair_operator", label_th: "ค่าซ่อม (ผู้บริหารรับ)", amount_satang: -(repair - ownerPart), party: "operator" });
          notes.push(`ผู้บริหารรับค่าซ่อม ${pct(10_000 - ownerBps)} ตามข้อตกลงกรณีภัย — ยอดผู้บริหารติดลบได้`);
        } else {
          notes.push("เจ้าของรับค่าซ่อมทั้งหมด");
        }
      }
      if (aid > 0) notes.push("เงินประกันทรัพย์สิน/เงินช่วยเหลือเป็นของเจ้าของเสมอ");
      return extend(base, {
        lines: [...lines, ...ownerReceipts(d)],
        assumptions: notes,
        inflows: inflowsOf(input.revenue_satang, d),
        applied: gate.applies,
      });
    }
  }
}

// ---- API input (baht) for POST /api/contracts/:id/settlement-preview, chosen by the contract's type ----

const Thb = z.number().min(0).max(1e11).refine((v) => hasAtMostDecimals(v, 2), "at most 2 decimal places");

const DamagePctInput = z
  .number()
  .min(0)
  .max(100)
  .refine((v) => hasAtMostDecimals(v, 2), "at most 2 decimal places");
/** Optional disaster context accepted by every preview body (baht / percent). */
const disasterFields = {
  damage_pct: DamagePctInput.optional(),
  insurance_thb: Thb.optional(),
  government_aid_thb: Thb.optional(),
};

const revenueSource = <T extends { crop_cycle_id?: string | undefined; revenue_thb?: number | undefined }>(v: T) =>
  (v.crop_cycle_id === undefined) !== (v.revenue_thb === undefined);
const REVENUE_SOURCE_MESSAGE = { message: "send exactly one of crop_cycle_id or revenue_thb", path: ["revenue_thb"] };

export const TurnkeyPreviewInput = z
  .strictObject({
    crop_cycle_id: IdSchema.optional(),
    revenue_thb: Thb.optional(),
    opex_thb: Thb,
    period_months: z.number().int().min(0).max(1200).optional(),
    ...disasterFields,
  })
  .refine(revenueSource, REVENUE_SOURCE_MESSAGE);

export const FixedTargetPreviewInput = z
  .strictObject({ crop_cycle_id: IdSchema.optional(), revenue_thb: Thb.optional(), opex_thb: Thb, ...disasterFields })
  .refine(revenueSource, REVENUE_SOURCE_MESSAGE);

const JobQuantityInput = z.strictObject({
  job_key: z.string().min(1).max(50),
  quantity: z
    .number()
    .positive()
    .max(1e7)
    .refine((v) => hasAtMostDecimals(v, 2), "at most 2 decimal places"),
});

export const PayPerJobPreviewInput = z.strictObject({
  jobs: z.array(JobQuantityInput).min(1),
  cancelled_jobs: z.array(JobQuantityInput).optional(),
  ...disasterFields,
});

export const PropertyPreviewInput = z.strictObject({
  revenue_thb: Thb,
  turnovers: z.number().int().min(0).max(100_000),
  repair_cost_thb: Thb.optional(),
  ...disasterFields,
});
