import { area } from "@turf/area";
import {
  CreateAssetInput,
  CreateAssetUnitInput,
  CreateWorkOrderInput,
  type Asset,
  type AssetUnit,
  type Polygon,
  type WorkOrder,
} from "@owner-os/shared";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { Hono, type Context } from "hono";
import { asset_units, assets, work_orders } from "../db/schema";
import type { Env } from "../env";

type AppContext = Context<{ Bindings: Env }>;

// API layer uses ISO-8601 strings; D1 stores integer epoch ms.
const toIso = (ms: number): string => new Date(ms).toISOString();
const toMs = (iso: string): number => Date.parse(iso);

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

function assetToApi(row: typeof assets.$inferSelect): Asset {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    boundary: row.boundary_geojson === null ? null : (JSON.parse(row.boundary_geojson) as Polygon),
    created_at: toIso(row.created_at),
  };
}

function unitToApi(row: typeof asset_units.$inferSelect): AssetUnit {
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

function workOrderToApi(row: typeof work_orders.$inferSelect): WorkOrder {
  return {
    id: row.id,
    asset_id: row.asset_id,
    unit_id: row.unit_id,
    title: row.title,
    status: row.status,
    due_at: row.due_at === null ? null : toIso(row.due_at),
    created_at: toIso(row.created_at),
  };
}

async function assetExists(c: AppContext, id: string): Promise<boolean> {
  const row = await drizzle(c.env.DB).select({ id: assets.id }).from(assets).where(eq(assets.id, id)).get();
  return row !== undefined;
}

const notFound = (c: AppContext) => c.json({ error: "asset_not_found" }, 404);

export const assetsRoutes = new Hono<{ Bindings: Env }>();

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
  const { title, unit_id, due_at } = parsed.data;

  const db = drizzle(c.env.DB);
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
