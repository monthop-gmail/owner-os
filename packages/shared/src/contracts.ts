import { z } from "zod";
import { hasAtMostDecimals } from "./money";
import { IdSchema, IsoDateTimeSchema } from "./schemas";

// Owner ↔ operator agreements. API values are baht (≤ 2 decimals) and percent (0–100, ≤ 2 decimals);
// storage uses satang and basis points. All rules are draft until confirmed with the real owner.

export const ContractType = z.enum(["turnkey_profit_share", "pay_per_job", "property_management", "fixed_target_bonus"]);
export type ContractType = z.infer<typeof ContractType>;

export const RulesStatus = z.enum(["draft_unconfirmed", "confirmed"]);
export type RulesStatus = z.infer<typeof RulesStatus>;

export const CONTRACT_TYPE_LABELS: Readonly<Record<ContractType, string>> = {
  turnkey_profit_share: "เหมาบริหาร แบ่งกำไร",
  pay_per_job: "จ้างรายงาน",
  property_management: "บริหารอสังหาฯ (คอมมิชชัน)",
  fixed_target_bonus: "เป้ารายได้เจ้าของ + โบนัสส่วนเกิน",
};

/** Baht amount ≥ 0 with at most 2 decimals. */
const Thb = z.number().min(0).refine((v) => hasAtMostDecimals(v, 2), "at most 2 decimal places");
/** Percentage 0–100 with at most 2 decimals. */
const Pct = z
  .number()
  .min(0)
  .max(100)
  .refine((v) => hasAtMostDecimals(v, 2), "at most 2 decimal places");

export const pctToBps = (pct: number): number => Math.round(pct * 100);

// What changes when the asset is hit by a disaster (settlement only). Optional on every contract type: when
// absent — including contracts saved before this existed — the defaults below apply at calculation time.
// The defaults are chosen so that the operator / contractor does not end below zero.
const MinDamagePct = Pct.default(20);
const InsuranceRecipient = z.enum(["pool", "owner"]).default("pool");

export const TurnkeyDisasterClause = z.strictObject({
  min_damage_pct: MinDamagePct,
  loss_policy_on_disaster: z.enum(["owner_absorbs", "split_by_share"]).default("owner_absorbs"),
  insurance_recipient: InsuranceRecipient,
});
export const PayPerJobDisasterClause = z.strictObject({
  min_damage_pct: MinDamagePct,
  cancellation_fee_pct_on_disaster: Pct.default(0),
});
export const PropertyDisasterClause = z.strictObject({
  min_damage_pct: MinDamagePct,
  repair_cost_owner_pct: Pct.default(100),
});
export const FixedTargetDisasterClause = z.strictObject({
  min_damage_pct: MinDamagePct,
  target_adjustment: z.enum(["scale_by_damage", "none"]).default("scale_by_damage"),
  insurance_recipient: InsuranceRecipient,
});
export const bpsToPct = (bps: number): number => bps / 100;

export const TurnkeyProfitShareTerms = z
  .strictObject({
    contract_type: z.literal("turnkey_profit_share"),
    owner_share_pct: Pct,
    operator_share_pct: Pct,
    management_retainer_monthly_thb: Thb.default(0),
    retainer_timing: z.enum(["before_split", "after_split"]).default("before_split"),
    loss_policy: z.enum(["owner_absorbs", "split_by_share"]).default("owner_absorbs"),
    disaster_clause: TurnkeyDisasterClause.optional(),
  })
  .refine((t) => pctToBps(t.owner_share_pct) + pctToBps(t.operator_share_pct) === 10_000, {
    message: "owner_share_pct + operator_share_pct must equal 100",
    path: ["operator_share_pct"],
  });

export const JobRate = z.strictObject({
  job_key: z.string().regex(/^[a-z0-9]+(?:[_-][a-z0-9]+)*$/, "job_key must be a lowercase slug").max(50),
  label: z.string().min(1).max(100),
  unit: z.enum(["rai", "job", "hour"]),
  rate_thb: Thb.refine((v) => v > 0, "rate_thb must be > 0"),
});

export const PayPerJobTerms = z.strictObject({
  contract_type: z.literal("pay_per_job"),
  rates: z
    .array(JobRate)
    .min(1, "at least one rate")
    .refine((rates) => new Set(rates.map((r) => r.job_key)).size === rates.length, "job_key must be unique"),
  disaster_clause: PayPerJobDisasterClause.optional(),
});

export const PropertyManagementTerms = z.strictObject({
  contract_type: z.literal("property_management"),
  revenue_commission_pct: Pct,
  cleaning_fee_per_turnover_thb: Thb,
  disaster_clause: PropertyDisasterClause.optional(),
});

export const FixedTargetBonusTerms = z.strictObject({
  contract_type: z.literal("fixed_target_bonus"),
  owner_target_revenue_thb: Thb.refine((v) => v > 0, "owner_target_revenue_thb must be > 0"),
  excess_operator_pct: Pct.default(100),
  // operator_reimbursed (default): the operator gets opex back from revenue before the target comparison,
  // so the operator never ends below zero (unless shortfall_policy is operator_covers).
  opex_borne_by: z.enum(["operator_reimbursed", "operator", "owner"]).default("operator_reimbursed"),
  shortfall_policy: z.enum(["owner_absorbs", "operator_covers"]).default("owner_absorbs"),
  disaster_clause: FixedTargetDisasterClause.optional(),
});

export const ContractTermsSchema = z.discriminatedUnion("contract_type", [
  TurnkeyProfitShareTerms,
  PayPerJobTerms,
  PropertyManagementTerms,
  FixedTargetBonusTerms,
]);
/** Terms with defaults applied (API responses, storage mapping). */
export type ContractTerms = z.output<typeof ContractTermsSchema>;
/** Terms as a client may send them (defaults optional). */
export type ContractTermsInput = z.input<typeof ContractTermsSchema>;

/** id / rules_status / is_active are set by the server (strict). */
export const CreateContractInput = z
  .strictObject({
    partner_label: z.string().trim().min(1).max(100),
    starts_at: IsoDateTimeSchema,
    ends_at: IsoDateTimeSchema.optional(),
    terms: ContractTermsSchema,
  })
  .refine((c) => c.ends_at === undefined || Date.parse(c.ends_at) > Date.parse(c.starts_at), {
    message: "ends_at must be after starts_at",
    path: ["ends_at"],
  });
export type CreateContractInput = z.input<typeof CreateContractInput>;

export const ContractSchema = z.object({
  id: IdSchema,
  asset_id: IdSchema,
  contract_type: ContractType,
  partner_label: z.string(),
  terms: ContractTermsSchema,
  is_active: z.boolean(),
  rules_status: RulesStatus,
  starts_at: IsoDateTimeSchema,
  ends_at: IsoDateTimeSchema.nullable(),
  created_at: IsoDateTimeSchema,
});
export type Contract = z.output<typeof ContractSchema>;
