import { area } from "@turf/area";
import {
  CreateAssetInput,
  CreateAssetUnitInput,
  CreateWorkOrderInput,
  WorkOrderStatus,
  type Asset,
} from "@owner-os/shared";
import { and, count, desc, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { Hono, type Context } from "hono";
import { asset_units, assets, farm_crop_cycles, work_orders } from "../db/schema";
import type { Env } from "../env";
import { assetToApi, toMs, unitToApi, workOrderToApi } from "../mappers";

type AppContext = Context<{ Bindings: Env }>;

type Parsed<T> = { ok: true; data: T } | { ok: false; res: Response };
type SafeParser<T> = {
  safeParse(data: unknown): { success: true; data: T } | { success: false; error: { issues: unknown[] } };
};

async function parseBody<T>(c: AppContext, schema: SafeParser<T>): Promise<Parsed<T>> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return { ok: false, res: c.json({ error: "invalid_json" }, 400) };
  }
  const result = schema.safeParse(body);
  if (!result.success) {
    return { ok: false, res: c.json({ error: "validation_error", issues: result.error.issues }, 400) };
  }
  return { ok: true, data: result.data };
}

async function assetExists(c: AppContext, id: string): Promise<boolean> {
  const row = await drizzle(c.env.DB).select({ id: assets.id }).from(assets).where(eq(assets.id, id)).get();
  return row !== undefined;
}

const notFound = (c: AppContext) => c.json({ error: "asset_not_found" }, 404);

export const assetsRoutes = new Hono<{ Bindings: Env }>();

type WorkOrderCounts = Record<WorkOrderStatus, number>;
const zeroCounts = (): WorkOrderCounts =>
  Object.fromEntries(WorkOrderStatus.options.map((s) => [s, 0])) as WorkOrderCounts;

// Newest first; rowid breaks ties between rows created in the same millisecond.
const newestAssets = [desc(assets.created_at), desc(sql`${assets}.rowid`)];
const newestUnits = [desc(asset_units.created_at), desc(sql`${asset_units}.rowid`)];
const newestWorkOrders = [desc(work_orders.created_at), desc(sql`${work_orders}.rowid`)];

assetsRoutes.get("/", async (c) => {
  const db = drizzle(c.env.DB);
  // Three queries in one round trip; counts come from GROUP BY, not per-asset queries.
  const [rows, unitCounts, woCounts] = await db.batch([
    db.select().from(assets).orderBy(...newestAssets),
    db.select({ asset_id: asset_units.asset_id, n: count() }).from(asset_units).groupBy(asset_units.asset_id),
    db
      .select({ asset_id: work_orders.asset_id, status: work_orders.status, n: count() })
      .from(work_orders)
      .groupBy(work_orders.asset_id, work_orders.status),
  ]);

  const unitsByAsset = new Map(unitCounts.map((r) => [r.asset_id, r.n]));
  const woByAsset = new Map<string, WorkOrderCounts>();
  for (const r of woCounts) {
    const counts = woByAsset.get(r.asset_id) ?? zeroCounts();
    counts[r.status] = r.n;
    woByAsset.set(r.asset_id, counts);
  }

  const list: (Asset & { unit_count: number; work_order_counts: WorkOrderCounts })[] = rows.map((row) => ({
    ...assetToApi(row),
    unit_count: unitsByAsset.get(row.id) ?? 0,
    work_order_counts: woByAsset.get(row.id) ?? zeroCounts(),
  }));
  return c.json({ assets: list });
});

assetsRoutes.get("/:id", async (c) => {
  const db = drizzle(c.env.DB);
  const assetId = c.req.param("id");
  const [assetRows, unitRows] = await db.batch([
    db.select().from(assets).where(eq(assets.id, assetId)),
    db.select().from(asset_units).where(eq(asset_units.asset_id, assetId)).orderBy(...newestUnits),
  ]);
  const asset = assetRows[0];
  if (!asset) return notFound(c);
  return c.json({ asset: assetToApi(asset), units: unitRows.map(unitToApi) });
});

assetsRoutes.get("/:id/work-orders", async (c) => {
  const assetId = c.req.param("id");
  const status = WorkOrderStatus.optional().safeParse(c.req.query("status"));
  if (!status.success) return c.json({ error: "validation_error", issues: status.error.issues }, 400);
  if (!(await assetExists(c, assetId))) return notFound(c);

  const rows = await drizzle(c.env.DB)
    .select()
    .from(work_orders)
    .where(
      status.data === undefined
        ? eq(work_orders.asset_id, assetId)
        : and(eq(work_orders.asset_id, assetId), eq(work_orders.status, status.data)),
    )
    .orderBy(...newestWorkOrders);
  return c.json({ work_orders: rows.map(workOrderToApi) });
});

assetsRoutes.post("/", async (c) => {
  const parsed = await parseBody(c, CreateAssetInput);
  if (!parsed.ok) return parsed.res;
  const { name, kind, boundary } = parsed.data;

  const row = await drizzle(c.env.DB)
    .insert(assets)
    .values({
      id: crypto.randomUUID(),
      name,
      kind,
      boundary_geojson: boundary === undefined ? null : JSON.stringify(boundary),
      created_at: Date.now(),
    })
    .returning()
    .get();
  return c.json(assetToApi(row), 201);
});

assetsRoutes.post("/:id/units", async (c) => {
  const assetId = c.req.param("id");
  if (!(await assetExists(c, assetId))) return notFound(c);

  const parsed = await parseBody(c, CreateAssetUnitInput);
  if (!parsed.ok) return parsed.res;
  const { name, unit_type, boundary } = parsed.data;

  const row = await drizzle(c.env.DB)
    .insert(asset_units)
    .values({
      id: crypto.randomUUID(),
      asset_id: assetId,
      name,
      unit_type,
      boundary_geojson: JSON.stringify(boundary),
      area_m2: area(boundary),
      created_at: Date.now(),
    })
    .returning()
    .get();
  return c.json(unitToApi(row), 201);
});

assetsRoutes.post("/:id/work-orders", async (c) => {
  const assetId = c.req.param("id");
  if (!(await assetExists(c, assetId))) return notFound(c);

  const parsed = await parseBody(c, CreateWorkOrderInput);
  if (!parsed.ok) return parsed.res;
  const { title, due_at, crop_cycle_id } = parsed.data;
  let { unit_id } = parsed.data;

  const db = drizzle(c.env.DB);
  if (crop_cycle_id !== undefined) {
    // The cycle must belong to a unit of this asset; the work order then targets that unit.
    const cycle = await db
      .select({ unit_id: farm_crop_cycles.unit_id })
      .from(farm_crop_cycles)
      .innerJoin(asset_units, eq(asset_units.id, farm_crop_cycles.unit_id))
      .where(and(eq(farm_crop_cycles.id, crop_cycle_id), eq(asset_units.asset_id, assetId)))
      .get();
    if (cycle === undefined) return c.json({ error: "crop_cycle_not_in_asset" }, 400);
    if (unit_id !== undefined && unit_id !== cycle.unit_id) return c.json({ error: "unit_not_in_crop_cycle" }, 400);
    unit_id = cycle.unit_id;
  }
  if (unit_id !== undefined) {
    const unit = await db
      .select({ id: asset_units.id })
      .from(asset_units)
      .where(and(eq(asset_units.id, unit_id), eq(asset_units.asset_id, assetId)))
      .get();
    if (unit === undefined) return c.json({ error: "unit_not_in_asset" }, 400);
  }

  const now = Date.now();
  const row = await db
    .insert(work_orders)
    .values({
      id: crypto.randomUUID(),
      asset_id: assetId,
      unit_id: unit_id ?? null,
      crop_cycle_id: crop_cycle_id ?? null,
      title,
      status: "open",
      due_at: due_at === undefined ? null : toMs(due_at),
      created_at: now,
      updated_at: now,
    })
    .returning()
    .get();
  return c.json(workOrderToApi(row), 201);
});
