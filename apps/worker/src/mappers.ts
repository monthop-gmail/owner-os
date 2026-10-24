// Row -> API mappers, one per entity. API layer: ISO-8601 strings, GeoJSON objects, snake_case.
// Add future fields (owner, assignee, cost, …) here so every route picks them up.
import {
  bpsToPct,
  gToKg,
  pctToBps,
  satangToThb,
  thbToSatang,
  weightedDamageBps,
  type Asset,
  type AssetUnit,
  type Contract,
  type ContractTerms,
  type CropCycle,
  type DisasterEvent,
  type Evidence,
  type HarvestLog,
  type Polygon,
  type SatangContractTerms,
  type WorkOrder,
} from "@owner-os/shared";
import type {
  disaster_event_units,
  disaster_events,
  asset_contracts,
  asset_units,
  assets,
  farm_crop_cycles,
  farm_harvest_logs,
  work_order_evidence,
  work_orders,
} from "./db/schema";

export type AssetRow = typeof assets.$inferSelect;
export type AssetUnitRow = typeof asset_units.$inferSelect;
export type WorkOrderRow = typeof work_orders.$inferSelect;
export type EvidenceRow = typeof work_order_evidence.$inferSelect;
export type CropCycleRow = typeof farm_crop_cycles.$inferSelect;
export type HarvestLogRow = typeof farm_harvest_logs.$inferSelect;
export type ContractRow = typeof asset_contracts.$inferSelect;

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
    crop_cycle_id: row.crop_cycle_id,
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

export function cropCycleToApi(row: CropCycleRow): CropCycle {
  return {
    id: row.id,
    unit_id: row.unit_id,
    crop: row.crop,
    variety: row.variety,
    status: row.status,
    template_key: row.template_key,
    started_at: toIsoOrNull(row.started_at),
    expected_harvest_at: toIsoOrNull(row.expected_harvest_at),
    ended_at: toIsoOrNull(row.ended_at),
    created_at: toIso(row.created_at),
  };
}

export function harvestLogToApi(row: HarvestLogRow): HarvestLog {
  return {
    id: row.id,
    crop_cycle_id: row.crop_cycle_id,
    harvested_at: toIso(row.harvested_at),
    weight_kg: gToKg(row.weight_g),
    unit_price_thb: satangToThb(row.unit_price_satang),
    revenue_thb: satangToThb(row.revenue_satang),
    buyer_name: row.buyer_name,
    note: row.note,
    slip_uploaded: row.slip_uploaded_at !== null,
    created_at: toIso(row.created_at),
  };
}

/** Contract terms as stored in asset_contracts.terms_json: satang and basis points (integers). */
export type StoredContractTerms = SatangContractTerms;

export function contractTermsToStored(t: ContractTerms): StoredContractTerms {
  switch (t.contract_type) {
    case "turnkey_profit_share":
      return {
        contract_type: t.contract_type,
        owner_share_bps: pctToBps(t.owner_share_pct),
        operator_share_bps: pctToBps(t.operator_share_pct),
        management_retainer_monthly_satang: thbToSatang(t.management_retainer_monthly_thb),
        retainer_timing: t.retainer_timing,
        loss_policy: t.loss_policy,
        ...(t.disaster_clause && {
          disaster_clause: {
            min_damage_bps: pctToBps(t.disaster_clause.min_damage_pct),
            loss_policy_on_disaster: t.disaster_clause.loss_policy_on_disaster,
            insurance_recipient: t.disaster_clause.insurance_recipient,
          },
        }),
      };
    case "pay_per_job":
      return {
        contract_type: t.contract_type,
        rates: t.rates.map((r) => ({ job_key: r.job_key, label: r.label, unit: r.unit, rate_satang: thbToSatang(r.rate_thb) })),
        ...(t.disaster_clause && {
          disaster_clause: {
            min_damage_bps: pctToBps(t.disaster_clause.min_damage_pct),
            cancellation_fee_bps_on_disaster: pctToBps(t.disaster_clause.cancellation_fee_pct_on_disaster),
          },
        }),
      };
    case "property_management":
      return {
        contract_type: t.contract_type,
        revenue_commission_bps: pctToBps(t.revenue_commission_pct),
        cleaning_fee_per_turnover_satang: thbToSatang(t.cleaning_fee_per_turnover_thb),
        ...(t.disaster_clause && {
          disaster_clause: {
            min_damage_bps: pctToBps(t.disaster_clause.min_damage_pct),
            repair_cost_owner_bps: pctToBps(t.disaster_clause.repair_cost_owner_pct),
          },
        }),
      };
    case "fixed_target_bonus":
      return {
        contract_type: t.contract_type,
        owner_target_revenue_satang: thbToSatang(t.owner_target_revenue_thb),
        excess_operator_bps: pctToBps(t.excess_operator_pct),
        opex_borne_by: t.opex_borne_by,
        shortfall_policy: t.shortfall_policy,
        ...(t.disaster_clause && {
          disaster_clause: {
            min_damage_bps: pctToBps(t.disaster_clause.min_damage_pct),
            target_adjustment: t.disaster_clause.target_adjustment,
            insurance_recipient: t.disaster_clause.insurance_recipient,
          },
        }),
      };
  }
}

export function contractTermsFromStored(s: StoredContractTerms): ContractTerms {
  switch (s.contract_type) {
    case "turnkey_profit_share":
      return {
        contract_type: s.contract_type,
        owner_share_pct: bpsToPct(s.owner_share_bps),
        operator_share_pct: bpsToPct(s.operator_share_bps),
        management_retainer_monthly_thb: satangToThb(s.management_retainer_monthly_satang),
        retainer_timing: s.retainer_timing,
        loss_policy: s.loss_policy,
        ...(s.disaster_clause && {
          disaster_clause: {
            min_damage_pct: bpsToPct(s.disaster_clause.min_damage_bps),
            loss_policy_on_disaster: s.disaster_clause.loss_policy_on_disaster,
            insurance_recipient: s.disaster_clause.insurance_recipient,
          },
        }),
      };
    case "pay_per_job":
      return {
        contract_type: s.contract_type,
        rates: s.rates.map((r) => ({ job_key: r.job_key, label: r.label, unit: r.unit, rate_thb: satangToThb(r.rate_satang) })),
        ...(s.disaster_clause && {
          disaster_clause: {
            min_damage_pct: bpsToPct(s.disaster_clause.min_damage_bps),
            cancellation_fee_pct_on_disaster: bpsToPct(s.disaster_clause.cancellation_fee_bps_on_disaster),
          },
        }),
      };
    case "property_management":
      return {
        contract_type: s.contract_type,
        revenue_commission_pct: bpsToPct(s.revenue_commission_bps),
        cleaning_fee_per_turnover_thb: satangToThb(s.cleaning_fee_per_turnover_satang),
        ...(s.disaster_clause && {
          disaster_clause: {
            min_damage_pct: bpsToPct(s.disaster_clause.min_damage_bps),
            repair_cost_owner_pct: bpsToPct(s.disaster_clause.repair_cost_owner_bps),
          },
        }),
      };
    case "fixed_target_bonus":
      return {
        contract_type: s.contract_type,
        owner_target_revenue_thb: satangToThb(s.owner_target_revenue_satang),
        excess_operator_pct: bpsToPct(s.excess_operator_bps),
        opex_borne_by: s.opex_borne_by,
        shortfall_policy: s.shortfall_policy,
        ...(s.disaster_clause && {
          disaster_clause: {
            min_damage_pct: bpsToPct(s.disaster_clause.min_damage_bps),
            target_adjustment: s.disaster_clause.target_adjustment,
            insurance_recipient: s.disaster_clause.insurance_recipient,
          },
        }),
      };
  }
}

export function contractToApi(row: ContractRow): Contract {
  return {
    id: row.id,
    asset_id: row.asset_id,
    contract_type: row.contract_type,
    partner_label: row.partner_label,
    terms: contractTermsFromStored(JSON.parse(row.terms_json) as StoredContractTerms),
    is_active: row.is_active,
    rules_status: row.rules_status,
    starts_at: toIso(row.starts_at),
    ends_at: toIsoOrNull(row.ends_at),
    created_at: toIso(row.created_at),
  };
}

export type DisasterEventRow = typeof disaster_events.$inferSelect;
/** An affected unit joined with its name and area. */
export type DisasterEventUnitJoined = typeof disaster_event_units.$inferSelect & {
  unit_name: string;
  area_m2: number | null;
};

export function disasterEventToApi(row: DisasterEventRow, units: DisasterEventUnitJoined[], evidence: EvidenceRow[]): DisasterEvent {
  return {
    id: row.id,
    asset_id: row.asset_id,
    event_type: row.event_type,
    occurred_at: toIso(row.occurred_at),
    ended_at: toIsoOrNull(row.ended_at),
    description: row.description,
    created_at: toIso(row.created_at),
    units: units.map((u) => ({
      unit_id: u.unit_id,
      unit_name: u.unit_name,
      area_m2: u.area_m2,
      damage_pct: bpsToPct(u.damage_bps),
      // m², 2 decimals
      damaged_area_m2: u.area_m2 === null ? null : Math.round((u.area_m2 * u.damage_bps) / 100) / 100,
      note: u.note,
    })),
    weighted_damage_pct: bpsToPct(weightedDamageBps(units)),
    // Linked evidence always has an upload and coordinates (checked when linking).
    evidence: evidence.map(evidenceToApi) as DisasterEvent["evidence"],
  };
}
