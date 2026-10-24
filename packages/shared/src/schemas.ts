import { z } from "zod";
import { LatSchema, LngSchema, PolygonSchema } from "./geo";

// Field names are snake_case to match the D1 columns (Task 1.4).

export const IdSchema = z.string().min(1);
export const IsoDateTimeSchema = z.iso.datetime({ offset: true });

export const AssetKind = z.enum(["farm", "property", "equipment", "other"]);
export const AssetUnitType = z.enum(["plot", "zone", "building", "other"]);
export const WorkOrderStatus = z.enum(["open", "in_progress", "submitted", "verified", "rejected"]);
export const CropCycleStatus = z.enum(["planned", "growing", "harvesting", "closed"]);

const NameSchema = z.string().min(1).max(200);

export const AssetSchema = z.object({
  id: IdSchema,
  name: NameSchema,
  kind: AssetKind,
  boundary: PolygonSchema.nullable(),
  created_at: IsoDateTimeSchema,
});

export const AssetUnitSchema = z.object({
  id: IdSchema,
  asset_id: IdSchema,
  name: NameSchema,
  unit_type: AssetUnitType,
  boundary: PolygonSchema,
  area_m2: z.number().min(0).nullable(),
  created_at: IsoDateTimeSchema,
});

export const WorkOrderSchema = z.object({
  id: IdSchema,
  asset_id: IdSchema,
  unit_id: IdSchema.nullable(),
  crop_cycle_id: IdSchema.nullable(),
  title: z.string().min(1).max(200),
  status: WorkOrderStatus,
  due_at: IsoDateTimeSchema.nullable(),
  created_at: IsoDateTimeSchema,
});

export const CropCycleSchema = z.object({
  id: IdSchema,
  unit_id: IdSchema,
  crop: z.string().min(1).max(100),
  variety: z.string().nullable(),
  status: CropCycleStatus,
  started_at: IsoDateTimeSchema.nullable(),
  expected_harvest_at: IsoDateTimeSchema.nullable(),
  ended_at: IsoDateTimeSchema.nullable(),
  created_at: IsoDateTimeSchema,
});

/**
 * Allowed crop cycle moves; there is no way back. Closing early is allowed from planned (cancelled)
 * and growing (ended before harvest).
 */
export const CROP_CYCLE_TRANSITIONS: Readonly<Record<CropCycleStatus, readonly CropCycleStatus[]>> = {
  planned: ["growing", "closed"],
  growing: ["harvesting", "closed"],
  harvesting: ["closed"],
  closed: [],
};

export function canTransition(from: CropCycleStatus, to: CropCycleStatus): boolean {
  return CROP_CYCLE_TRANSITIONS[from].includes(to);
}

export const EvidenceSchema = z.object({
  id: IdSchema,
  work_order_id: IdSchema,
  r2_key: z.string().min(1),
  lat: LatSchema,
  lng: LngSchema,
  accuracy_m: z.number().min(0),
  captured_at: IsoDateTimeSchema,
  inside_geofence: z.boolean(),
  distance_outside_m: z.number().min(0).nullable(),
});

// Input schemas are strict: unknown keys (id, created_at, server-computed fields) are rejected.

export const CreateAssetInput = z.strictObject({
  name: NameSchema,
  kind: AssetKind,
  boundary: PolygonSchema.optional(),
});

export const CreateAssetUnitInput = z.strictObject({
  name: NameSchema,
  unit_type: AssetUnitType,
  boundary: PolygonSchema,
});

export const CompleteWorkOrderInput = z.strictObject({
  evidence_id: IdSchema,
  lat: LatSchema,
  lng: LngSchema,
  accuracy_m: z.number().min(0),
  captured_at: IsoDateTimeSchema,
});

export const CreateWorkOrderInput = z.strictObject({
  title: z.string().min(1).max(200),
  unit_id: IdSchema.optional(),
  crop_cycle_id: IdSchema.optional(),
  due_at: IsoDateTimeSchema.optional(),
});

export const CreateCropCycleInput = z.strictObject({
  crop: z.string().min(1).max(100),
  variety: z.string().min(1).max(100).optional(),
  expected_harvest_at: IsoDateTimeSchema.optional(),
});

export const TransitionCropCycleInput = z.strictObject({
  to: CropCycleStatus,
});

export type AssetKind = z.infer<typeof AssetKind>;
export type AssetUnitType = z.infer<typeof AssetUnitType>;
export type WorkOrderStatus = z.infer<typeof WorkOrderStatus>;
export type CropCycleStatus = z.infer<typeof CropCycleStatus>;
export type Asset = z.infer<typeof AssetSchema>;
export type AssetUnit = z.infer<typeof AssetUnitSchema>;
export type WorkOrder = z.infer<typeof WorkOrderSchema>;
export type Evidence = z.infer<typeof EvidenceSchema>;
export type CreateAssetInput = z.infer<typeof CreateAssetInput>;
export type CreateAssetUnitInput = z.infer<typeof CreateAssetUnitInput>;
export type CompleteWorkOrderInput = z.infer<typeof CompleteWorkOrderInput>;
export type CreateWorkOrderInput = z.infer<typeof CreateWorkOrderInput>;
export type CropCycle = z.infer<typeof CropCycleSchema>;
export type CreateCropCycleInput = z.infer<typeof CreateCropCycleInput>;
export type TransitionCropCycleInput = z.infer<typeof TransitionCropCycleInput>;
