import { sql } from "drizzle-orm";
import { check, index, integer, primaryKey, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

// Enum values mirror @owner-os/shared (checked in test/schema.test.ts); not imported to keep the schema standalone.
// Timestamps are integer epoch milliseconds; GeoJSON is stored as text.

export const ASSET_KINDS = ["farm", "property", "equipment", "other"] as const;
export const ASSET_UNIT_TYPES = ["plot", "zone", "building", "other"] as const;
export const WORK_ORDER_STATUSES = ["open", "in_progress", "submitted", "verified", "rejected"] as const;
export const CROP_CYCLE_STATUSES = ["planned", "growing", "harvesting", "closed"] as const;
export const CROP_TEMPLATE_KEYS = ["durian", "maize", "melon"] as const;

export const assets = sqliteTable("assets", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  kind: text("kind", { enum: ASSET_KINDS }).notNull(),
  boundary_geojson: text("boundary_geojson"),
  created_at: integer("created_at").notNull(),
});

export const asset_units = sqliteTable(
  "asset_units",
  {
    id: text("id").primaryKey(),
    asset_id: text("asset_id")
      .notNull()
      .references(() => assets.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    unit_type: text("unit_type", { enum: ASSET_UNIT_TYPES }).notNull(),
    boundary_geojson: text("boundary_geojson").notNull(),
    area_m2: real("area_m2"),
    created_at: integer("created_at").notNull(),
  },
  (t) => [index("asset_units_asset_id_idx").on(t.asset_id)],
);

export const work_orders = sqliteTable(
  "work_orders",
  {
    id: text("id").primaryKey(),
    asset_id: text("asset_id")
      .notNull()
      .references(() => assets.id),
    unit_id: text("unit_id").references(() => asset_units.id),
    // Optional link to a crop cycle (migration 0001); must be a cycle of the same unit/asset (checked in the API).
    crop_cycle_id: text("crop_cycle_id").references(() => farm_crop_cycles.id),
    // Recovery work created from a disaster event (migration 0006).
    disaster_event_id: text("disaster_event_id").references(() => disaster_events.id),
    title: text("title").notNull(),
    status: text("status", { enum: WORK_ORDER_STATUSES }).notNull().default("open"),
    due_at: integer("due_at"),
    created_at: integer("created_at").notNull(),
    updated_at: integer("updated_at").notNull(),
  },
  (t) => [
    index("work_orders_asset_id_idx").on(t.asset_id),
    index("work_orders_status_idx").on(t.status),
    index("work_orders_crop_cycle_id_idx").on(t.crop_cycle_id),
    index("work_orders_disaster_event_id_idx").on(t.disaster_event_id),
  ],
);

// Location/geofence columns are nullable: the row is created when the upload ticket is issued (Task 2.2).
export const work_order_evidence = sqliteTable(
  "work_order_evidence",
  {
    id: text("id").primaryKey(),
    work_order_id: text("work_order_id")
      .notNull()
      .references(() => work_orders.id),
    r2_key: text("r2_key").notNull().unique(),
    lat: real("lat"),
    lng: real("lng"),
    accuracy_m: real("accuracy_m"),
    captured_at: integer("captured_at"),
    inside_geofence: integer("inside_geofence", { mode: "boolean" }),
    distance_outside_m: real("distance_outside_m"),
    uploaded_at: integer("uploaded_at"),
    created_at: integer("created_at").notNull(),
  },
  (t) => [index("work_order_evidence_work_order_id_idx").on(t.work_order_id)],
);

export const farm_crop_cycles = sqliteTable(
  "farm_crop_cycles",
  {
    id: text("id").primaryKey(),
    unit_id: text("unit_id")
      .notNull()
      .references(() => asset_units.id),
    crop: text("crop").notNull(),
    variety: text("variety"),
    status: text("status", { enum: CROP_CYCLE_STATUSES }).notNull().default("planned"),
    // Stage task template (migration 0002); null = no automatic work orders.
    template_key: text("template_key", { enum: CROP_TEMPLATE_KEYS }),
    started_at: integer("started_at"),
    expected_harvest_at: integer("expected_harvest_at"),
    ended_at: integer("ended_at"),
    created_at: integer("created_at").notNull(),
  },
  (t) => [index("farm_crop_cycles_unit_id_idx").on(t.unit_id)],
);

// Weight in grams and money in satang (integers); the API converts to kg / baht (migration 0003).
export const farm_harvest_logs = sqliteTable(
  "farm_harvest_logs",
  {
    id: text("id").primaryKey(),
    crop_cycle_id: text("crop_cycle_id")
      .notNull()
      .references(() => farm_crop_cycles.id),
    harvested_at: integer("harvested_at").notNull(),
    weight_g: integer("weight_g").notNull(),
    unit_price_satang: integer("unit_price_satang").notNull(),
    revenue_satang: integer("revenue_satang").notNull(),
    buyer_name: text("buyer_name"),
    slip_r2_key: text("slip_r2_key").notNull().unique(),
    slip_uploaded_at: integer("slip_uploaded_at"),
    note: text("note"),
    created_at: integer("created_at").notNull(),
  },
  (t) => [
    index("farm_harvest_logs_crop_cycle_id_idx").on(t.crop_cycle_id),
    check("farm_harvest_logs_weight_g_positive", sql`${t.weight_g} > 0`),
    check("farm_harvest_logs_unit_price_non_negative", sql`${t.unit_price_satang} >= 0`),
    check("farm_harvest_logs_revenue_non_negative", sql`${t.revenue_satang} >= 0`),
  ],
);

export const CONTRACT_TYPES = ["turnkey_profit_share", "pay_per_job", "property_management", "fixed_target_bonus"] as const;
export const RULES_STATUSES = ["draft_unconfirmed", "confirmed"] as const;

// Owner ↔ operator agreement (migration 0004). terms_json stores money in satang and percentages in
// basis points (integers); the API converts to baht / percent. At most one active contract per asset.
export const asset_contracts = sqliteTable(
  "asset_contracts",
  {
    id: text("id").primaryKey(),
    asset_id: text("asset_id")
      .notNull()
      .references(() => assets.id),
    contract_type: text("contract_type", { enum: CONTRACT_TYPES }).notNull(),
    partner_label: text("partner_label").notNull(),
    terms_json: text("terms_json").notNull(),
    is_active: integer("is_active", { mode: "boolean" }).notNull(),
    rules_status: text("rules_status", { enum: RULES_STATUSES }).notNull().default("draft_unconfirmed"),
    starts_at: integer("starts_at").notNull(),
    ends_at: integer("ends_at"),
    created_at: integer("created_at").notNull(),
    deactivated_at: integer("deactivated_at"),
  },
  (t) => [
    index("asset_contracts_asset_id_idx").on(t.asset_id),
    uniqueIndex("asset_contracts_one_active_per_asset").on(t.asset_id).where(sql`${t.is_active} = 1`),
  ],
);

export const DISASTER_TYPES = ["flood", "drought", "storm", "pest_disease", "fire", "other"] as const;

// Disaster / accident events (migration 0005): affected units with damage in basis points, and linked
// field evidence (photos with GPS that passed the geofence) for claims.
export const disaster_events = sqliteTable(
  "disaster_events",
  {
    id: text("id").primaryKey(),
    asset_id: text("asset_id")
      .notNull()
      .references(() => assets.id),
    event_type: text("event_type", { enum: DISASTER_TYPES }).notNull(),
    occurred_at: integer("occurred_at").notNull(),
    ended_at: integer("ended_at"),
    description: text("description"),
    created_at: integer("created_at").notNull(),
    // Set once when recovery work orders are generated (migration 0006); guards against doing it twice.
    recovery_tasks_created_at: integer("recovery_tasks_created_at"),
  },
  (t) => [index("disaster_events_asset_id_idx").on(t.asset_id)],
);

export const disaster_event_units = sqliteTable(
  "disaster_event_units",
  {
    event_id: text("event_id")
      .notNull()
      .references(() => disaster_events.id),
    unit_id: text("unit_id")
      .notNull()
      .references(() => asset_units.id),
    damage_bps: integer("damage_bps").notNull(),
    note: text("note"),
  },
  (t) => [
    primaryKey({ columns: [t.event_id, t.unit_id] }),
    index("disaster_event_units_unit_id_idx").on(t.unit_id),
    check("disaster_event_units_damage_bps_range", sql`${t.damage_bps} >= 0 AND ${t.damage_bps} <= 10000`),
  ],
);

export const disaster_event_evidence = sqliteTable(
  "disaster_event_evidence",
  {
    event_id: text("event_id")
      .notNull()
      .references(() => disaster_events.id),
    evidence_id: text("evidence_id")
      .notNull()
      .references(() => work_order_evidence.id),
  },
  (t) => [primaryKey({ columns: [t.event_id, t.evidence_id] })],
);

export type Asset = typeof assets.$inferSelect;
export type NewAsset = typeof assets.$inferInsert;
export type AssetUnit = typeof asset_units.$inferSelect;
export type NewAssetUnit = typeof asset_units.$inferInsert;
export type WorkOrder = typeof work_orders.$inferSelect;
export type NewWorkOrder = typeof work_orders.$inferInsert;
export type WorkOrderEvidence = typeof work_order_evidence.$inferSelect;
export type NewWorkOrderEvidence = typeof work_order_evidence.$inferInsert;
export type FarmCropCycle = typeof farm_crop_cycles.$inferSelect;
export type NewFarmCropCycle = typeof farm_crop_cycles.$inferInsert;
export type FarmHarvestLog = typeof farm_harvest_logs.$inferSelect;
export type NewFarmHarvestLog = typeof farm_harvest_logs.$inferInsert;
export type AssetContract = typeof asset_contracts.$inferSelect;
export type NewAssetContract = typeof asset_contracts.$inferInsert;
export type DisasterEventRow = typeof disaster_events.$inferSelect;
export type DisasterEventUnitRow = typeof disaster_event_units.$inferSelect;

// AI connectors (MCP over OAuth). Revoking a row (revoked_at set) cuts off every token of that client.
export const ai_clients = sqliteTable("ai_clients", {
  name: text("name").primaryKey(),
  /** Space-separated scopes, e.g. "read". */
  scopes: text("scopes").notNull(),
  rate_per_minute: integer("rate_per_minute").notNull().default(60),
  rate_per_day: integer("rate_per_day").notNull().default(5000),
  revoked_at: integer("revoked_at"),
  created_at: integer("created_at").notNull(),
});

export type AiClient = typeof ai_clients.$inferSelect;

// One row per MCP tools/call. Stores who/which tool/outcome only — never arguments, results or emails.
export const mcp_audit = sqliteTable(
  "mcp_audit",
  {
    id: text("id").primaryKey(),
    at: integer("at").notNull(),
    /** Same opaque hash as the OAuth grant's userId. */
    user_hash: text("user_hash").notNull(),
    /** DCR client_id of the token. */
    client_id: text("client_id").notNull(),
    tool: text("tool").notNull(),
    ok: integer("ok").notNull(),
    error_code: text("error_code"),
    ms: integer("ms").notNull(),
  },
  (t) => [index("mcp_audit_at_idx").on(t.at), check("mcp_audit_ok_bool", sql`${t.ok} IN (0, 1)`)],
);

export type McpAuditRow = typeof mcp_audit.$inferSelect;
