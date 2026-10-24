import { canTransition, CreateCropCycleInput, TransitionCropCycleInput, type CropCycleStatus } from "@owner-os/shared";
import { and, desc, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { Hono, type Context } from "hono";
import { asset_units, farm_crop_cycles } from "../db/schema";
import type { Env } from "../env";
import { cropCycleToApi, toMs } from "../mappers";

type AppContext = Context<{ Bindings: Env }>;

type SafeParser<T> = {
  safeParse(data: unknown): { success: true; data: T } | { success: false; error: { issues: unknown[] } };
};

async function parseBody<T>(c: AppContext, schema: SafeParser<T>): Promise<{ ok: true; data: T } | { ok: false; res: Response }> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return { ok: false, res: c.json({ error: "invalid_json" }, 400) };
  }
  const result = schema.safeParse(body);
  if (!result.success) return { ok: false, res: c.json({ error: "validation_error", issues: result.error.issues }, 400) };
  return { ok: true, data: result.data };
}

const unitNotFound = (c: AppContext) => c.json({ error: "unit_not_found" }, 404);
const cycleNotFound = (c: AppContext) => c.json({ error: "crop_cycle_not_found" }, 404);

async function unitExists(c: AppContext, id: string): Promise<boolean> {
  const row = await drizzle(c.env.DB).select({ id: asset_units.id }).from(asset_units).where(eq(asset_units.id, id)).get();
  return row !== undefined;
}

/** Mounted at /api/units: crop cycles of one unit. */
export const unitCropCyclesRoutes = new Hono<{ Bindings: Env }>();

unitCropCyclesRoutes.post("/:id/crop-cycles", async (c) => {
  const unitId = c.req.param("id");
  if (!(await unitExists(c, unitId))) return unitNotFound(c);
  const parsed = await parseBody(c, CreateCropCycleInput);
  if (!parsed.ok) return parsed.res;
  const { crop, variety, expected_harvest_at } = parsed.data;

  // One open (not closed) cycle per unit, enforced in the same statement as the insert.
  const id = crypto.randomUUID();
  const result = await drizzle(c.env.DB).run(sql`
    INSERT INTO ${farm_crop_cycles} (id, unit_id, crop, variety, status, expected_harvest_at, created_at)
    SELECT ${id}, ${unitId}, ${crop}, ${variety ?? null}, 'planned',
           ${expected_harvest_at === undefined ? null : toMs(expected_harvest_at)}, ${Date.now()}
    WHERE NOT EXISTS (
      SELECT 1 FROM ${farm_crop_cycles}
      WHERE ${farm_crop_cycles.unit_id} = ${unitId} AND ${farm_crop_cycles.status} <> 'closed'
    )`);
  if (result.meta.changes !== 1) return c.json({ error: "open_crop_cycle_exists" }, 409);

  const row = await drizzle(c.env.DB).select().from(farm_crop_cycles).where(eq(farm_crop_cycles.id, id)).get();
  if (!row) return cycleNotFound(c);
  return c.json(cropCycleToApi(row), 201);
});

unitCropCyclesRoutes.get("/:id/crop-cycles", async (c) => {
  const unitId = c.req.param("id");
  if (!(await unitExists(c, unitId))) return unitNotFound(c);
  const rows = await drizzle(c.env.DB)
    .select()
    .from(farm_crop_cycles)
    .where(eq(farm_crop_cycles.unit_id, unitId))
    .orderBy(desc(farm_crop_cycles.created_at), desc(sql`${farm_crop_cycles}.rowid`));
  return c.json({ crop_cycles: rows.map(cropCycleToApi) });
});

/** Mounted at /api/crop-cycles. */
export const cropCyclesRoutes = new Hono<{ Bindings: Env }>();

cropCyclesRoutes.post("/:id/transition", async (c) => {
  const id = c.req.param("id");
  const db = drizzle(c.env.DB);
  const current = await db.select().from(farm_crop_cycles).where(eq(farm_crop_cycles.id, id)).get();
  if (!current) return cycleNotFound(c);

  const parsed = await parseBody(c, TransitionCropCycleInput);
  if (!parsed.ok) return parsed.res;
  const from: CropCycleStatus = current.status;
  const { to } = parsed.data;
  if (!canTransition(from, to)) return c.json({ error: "invalid_transition", from, to }, 409);

  const now = Date.now();
  // Conditional on the status we validated against: a concurrent transition makes this update 0 rows.
  const [updated] = await db
    .update(farm_crop_cycles)
    .set({
      status: to,
      ...(to === "growing" ? { started_at: now } : {}),
      ...(to === "closed" ? { ended_at: now } : {}),
    })
    .where(and(eq(farm_crop_cycles.id, id), eq(farm_crop_cycles.status, from)))
    .returning();
  if (!updated) return c.json({ error: "status_changed", from, to }, 409);
  return c.json(cropCycleToApi(updated));
});
