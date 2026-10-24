// Row -> API mappers, one per entity. API layer: ISO-8601 strings, GeoJSON objects, snake_case.
// Add future fields (owner, assignee, cost, …) here so every route picks them up.
import type { Asset, AssetUnit, Evidence, Polygon, WorkOrder } from "@owner-os/shared";
import type { asset_units, assets, work_order_evidence, work_orders } from "./db/schema";

export type AssetRow = typeof assets.$inferSelect;
export type AssetUnitRow = typeof asset_units.$inferSelect;
export type WorkOrderRow = typeof work_orders.$inferSelect;
export type EvidenceRow = typeof work_order_evidence.$inferSelect;

/** Evidence as stored: location/geofence fields stay null until the work order is completed with it. */
export type EvidenceApi = {
  [K in keyof Evidence]: K extends "id" | "work_order_id" | "r2_key" ? Evidence[K] : Evidence[K] | null;
};

export const toIso = (ms: number): string => new Date(ms).toISOString();
export const toMs = (iso: string): number => Date.parse(iso);
const toIsoOrNull = (ms: number | null): string | null => (ms === null ? null : toIso(ms));

export function assetToApi(row: AssetRow): Asset {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    boundary: row.boundary_geojson === null ? null : (JSON.parse(row.boundary_geojson) as Polygon),
    created_at: toIso(row.created_at),
  };
}

export function unitToApi(row: AssetUnitRow): AssetUnit {
  return {
    id: row.id,
    asset_id: row.asset_id,
    name: row.name,
    unit_type: row.unit_type,
    boundary: JSON.parse(row.boundary_geojson) as Polygon,
    area_m2: row.area_m2,
    created_at: toIso(row.created_at),
  };
}

export function workOrderToApi(row: WorkOrderRow): WorkOrder {
  return {
    id: row.id,
    asset_id: row.asset_id,
    unit_id: row.unit_id,
    title: row.title,
    status: row.status,
    due_at: toIsoOrNull(row.due_at),
    created_at: toIso(row.created_at),
  };
}

export function evidenceToApi(row: EvidenceRow): EvidenceApi {
  return {
    id: row.id,
    work_order_id: row.work_order_id,
    r2_key: row.r2_key,
    lat: row.lat,
    lng: row.lng,
    accuracy_m: row.accuracy_m,
    captured_at: toIsoOrNull(row.captured_at),
    inside_geofence: row.inside_geofence,
    distance_outside_m: row.distance_outside_m,
  };
}
