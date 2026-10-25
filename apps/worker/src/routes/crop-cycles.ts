import {
  canTransition,
  CreateCropCycleInput,
  CROP_TEMPLATES,
  stageTasks,
  TransitionCropCycleInput,
  type CropCycleStatus,
} from "@owner-os/shared";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { Hono, type Context } from "hono";
import { asset_units, farm_crop_cycles, work_orders } from "../db/schema";
import type { Env } from "../env";
import { cropCycleToApi, toMs, workOrderToApi } from "../mappers";

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
  const { crop, variety, expected_harvest_at, template_key } = parsed.data;

  // One open (not closed) cycle per unit, enforced in the same statement as the insert.
  const id = crypto.randomUUID();
  const result = await drizzle(c.env.DB).run(sql`
    INSERT INTO ${farm_crop_cycles} (id, unit_id, crop, variety, status, template_key, expected_harvest_at, created_at)
    SELECT ${id}, ${unitId}, ${crop}, ${variety ?? null}, 'planned', ${template_key ?? null},
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
  const tasks = current.template_key === null ? [] : stageTasks(current.template_key, to, now);
  const newIds = tasks.map(() => crypto.randomUUID());

  // One batch (one transaction). The stage's work orders are inserted *before* the status update and only
  // while the cycle is still in `from`; the update is conditional on `from` too. A request that lost a race
  // therefore inserts nothing and updates nothing.
  const inserts = tasks.map((task, i) =>
    db.insert(work_orders).select(
      db
        .select({
          id: sql<string>`${newIds[i]}`.as("id"),
          asset_id: asset_units.asset_id,
          unit_id: farm_crop_cycles.unit_id,
          crop_cycle_id: farm_crop_cycles.id,
          // insert…select needs every work_orders column, in table order.
          disaster_event_id: sql<string | null>`NULL`.as("disaster_event_id"),
          title: sql<string>`${task.title}`.as("title"),
          status: sql<"open">`'open'`.as("status"),
          due_at: sql<number>`${task.due_at_ms}`.as("due_at"),
          created_at: sql<number>`${now}`.as("created_at"),
          updated_at: sql<number>`${now}`.as("updated_at"),
        })
        .from(farm_crop_cycles)
        .innerJoin(asset_units, eq(asset_units.id, farm_crop_cycles.unit_id))
        .where(and(eq(farm_crop_cycles.id, id), eq(farm_crop_cycles.status, from))),
    ),
  );
  const update = db
    .update(farm_crop_cycles)
    .set({
      status: to,
      ...(to === "growing" ? { started_at: now } : {}),
      ...(to === "closed" ? { ended_at: now } : {}),
    })
    .where(and(eq(farm_crop_cycles.id, id), eq(farm_crop_cycles.status, from)))
    .returning();
  type CycleRow = typeof farm_crop_cycles.$inferSelect;
  let updated: CycleRow | undefined;
  const [firstInsert, ...moreInserts] = inserts;
  if (firstInsert === undefined) {
    [updated] = await update;
  } else {
    const results = await db.batch([firstInsert, ...moreInserts, update]);
    [updated] = results[results.length - 1] as CycleRow[];
  }
  if (!updated) return c.json({ error: "status_changed", from, to }, 409);

  const created = newIds.length === 0 ? [] : await db.select().from(work_orders).where(inArray(work_orders.id, newIds));
  const createdSorted = newIds.flatMap((wid) => created.filter((w) => w.id === wid));
  return c.json({ ...cropCycleToApi(updated), created_work_orders: createdSorted.map(workOrderToApi) });
});

cropCyclesRoutes.get("/:id/work-orders", async (c) => {
  const id = c.req.param("id");
  const db = drizzle(c.env.DB);
  const cycle = await db.select({ id: farm_crop_cycles.id }).from(farm_crop_cycles).where(eq(farm_crop_cycles.id, id)).get();
  if (!cycle) return cycleNotFound(c);
  const rows = await db
    .select()
    .from(work_orders)
    .where(eq(work_orders.crop_cycle_id, id))
    .orderBy(desc(work_orders.created_at), desc(sql`${work_orders}.rowid`));
  return c.json({ work_orders: rows.map(workOrderToApi) });
});

/** Mounted at /api/crop-templates: the stage task templates (read-only). */
export const cropTemplatesRoutes = new Hono<{ Bindings: Env }>();

cropTemplatesRoutes.get("/", (c) =>
  c.json({ templates: Object.entries(CROP_TEMPLATES).map(([key, template]) => ({ key, ...template })) }),
);
