import { index, integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

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
