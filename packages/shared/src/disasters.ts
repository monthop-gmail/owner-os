import { z } from "zod";
import { hasAtMostDecimals } from "./money";
import { EvidenceSchema, IdSchema, IsoDateTimeSchema } from "./schemas";

// Disaster / accident records with the affected units and their damage, used as claim evidence and
// (later) as an input to settlement. Nothing here files a claim or talks to an external system.

export const DisasterType = z.enum(["flood", "drought", "storm", "pest_disease", "fire", "other"]);
export type DisasterType = z.infer<typeof DisasterType>;

export const DISASTER_TYPE_LABELS: Readonly<Record<DisasterType, string>> = {
  flood: "น้ำท่วม",
  drought: "ภัยแล้ง",
  storm: "พายุ/ลมแรง",
  pest_disease: "ศัตรูพืช/โรคระบาด",
  fire: "ไฟไหม้",
  other: "อื่น ๆ",
};

export const MAX_EVENT_FUTURE_MS = 5 * 60 * 1000;

const DamagePct = z
  .number()
  .min(0)
  .max(100)
  .refine((v) => hasAtMostDecimals(v, 2), "at most 2 decimal places");

export const CreateDisasterEventInput = z
  .strictObject({
    event_type: DisasterType,
    occurred_at: IsoDateTimeSchema.refine((v) => Date.parse(v) <= Date.now() + MAX_EVENT_FUTURE_MS, "occurred_at is in the future"),
    ended_at: IsoDateTimeSchema.optional(),
    description: z.string().min(1).max(1000).optional(),
    units: z
      .array(z.strictObject({ unit_id: IdSchema, damage_pct: DamagePct, note: z.string().min(1).max(500).optional() }))
      .min(1)
      .max(200)
      .refine((units) => new Set(units.map((u) => u.unit_id)).size === units.length, "unit_id must be unique"),
  })
  .refine((e) => e.ended_at === undefined || Date.parse(e.ended_at) >= Date.parse(e.occurred_at), {
    message: "ended_at must not be before occurred_at",
    path: ["ended_at"],
  });
export type CreateDisasterEventInput = z.infer<typeof CreateDisasterEventInput>;

export const LinkDisasterEvidenceInput = z.strictObject({ evidence_id: IdSchema });

export const DisasterEventUnitSchema = z.object({
  unit_id: IdSchema,
  unit_name: z.string(),
  area_m2: z.number().nullable(),
  damage_pct: z.number(),
  damaged_area_m2: z.number().nullable(),
  note: z.string().nullable(),
});

export const DisasterEventSchema = z.object({
  id: IdSchema,
  asset_id: IdSchema,
  event_type: DisasterType,
  occurred_at: IsoDateTimeSchema,
  ended_at: IsoDateTimeSchema.nullable(),
  description: z.string().nullable(),
  created_at: IsoDateTimeSchema,
  units: z.array(DisasterEventUnitSchema),
  weighted_damage_pct: z.number(),
  evidence: z.array(EvidenceSchema),
});
export type DisasterEventUnit = z.infer<typeof DisasterEventUnitSchema>;
export type DisasterEvent = z.infer<typeof DisasterEventSchema>;

const BPS = 10_000n;

/**
 * Area-weighted damage: Σ(area × bps) / Σarea, half up, exact via BigInt. Areas are rounded to whole m²
 * first; null or zero total area → 0.
 */
export function weightedDamageBps(units: readonly { area_m2: number | null; damage_bps: number }[]): number {
  let weighted = 0n;
  let total = 0n;
  for (const u of units) {
    const area = BigInt(Math.max(0, Math.round(u.area_m2 ?? 0)));
    weighted += area * BigInt(u.damage_bps);
    total += area;
  }
  if (total === 0n) return 0;
  return Number((weighted * 2n + total) / (total * 2n));
}

/**
 * Damage from several events on the same unit, compounded so it never exceeds 100%:
 * 1 − Π(1 − dᵢ), in basis points, half up.
 */
export function combinedDamageBps(damages_bps: readonly number[]): number {
  // undamaged / scale = Π(1 − dᵢ), kept exact as a fraction of BPS^n.
  let undamaged = 1n;
  let scale = 1n;
  for (const d of damages_bps) {
    undamaged *= BPS - BigInt(Math.min(10_000, Math.max(0, Math.round(d))));
    scale *= BPS;
  }
  const damaged = (scale - undamaged) * BPS; // combined damage in bps, scaled by `scale`
  return Number((damaged * 2n + scale) / (scale * 2n));
}
