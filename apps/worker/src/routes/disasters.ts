import {
  bpsToPct,
  combinedDamageBps,
  CreateDisasterEventInput,
  DisasterPrepInput,
  disasterWorkOrders,
  LinkDisasterEvidenceInput,
  pctToBps,
  type DisasterStage,
  type DisasterType,
} from "@owner-os/shared";
import { and, asc, desc, eq, gte, inArray, isNull, lte, ne, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { Hono, type Context } from "hono";
import {
  asset_units,
  assets,
  disaster_event_evidence,
  disaster_event_units,
  disaster_events,
  farm_crop_cycles,
  work_order_evidence,
  work_orders,
} from "../db/schema";
import type { Env } from "../env";
import { disasterEventToApi, toMs, workOrderToApi, type DisasterEventRow } from "../mappers";

type AppContext = Context<{ Bindings: Env }>;
type Db = ReturnType<typeof drizzle>;

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

const eventNotFound = (c: AppContext) => c.json({ error: "disaster_event_not_found" }, 404);

/** Loads units and evidence for several events with two queries (no per-event queries). */
async function withDetails(db: Db, events: DisasterEventRow[]) {
  if (events.length === 0) return [];
  const ids = events.map((e) => e.id);
  const [units, evidence] = await db.batch([
    db
      .select({
        event_id: disaster_event_units.event_id,
        unit_id: disaster_event_units.unit_id,
        damage_bps: disaster_event_units.damage_bps,
        note: disaster_event_units.note,
        unit_name: asset_units.name,
        area_m2: asset_units.area_m2,
      })
      .from(disaster_event_units)
      .innerJoin(asset_units, eq(asset_units.id, disaster_event_units.unit_id))
      .where(inArray(disaster_event_units.event_id, ids))
      .orderBy(asc(asset_units.name)),
    db
      .select({ event_id: disaster_event_evidence.event_id, evidence: work_order_evidence })
      .from(disaster_event_evidence)
      .innerJoin(work_order_evidence, eq(work_order_evidence.id, disaster_event_evidence.evidence_id))
      .where(inArray(disaster_event_evidence.event_id, ids))
      .orderBy(asc(work_order_evidence.captured_at)),
  ]);
  return events.map((e) =>
    disasterEventToApi(
      e,
      units.filter((u) => u.event_id === e.id),
      evidence.filter((x) => x.event_id === e.id).map((x) => x.evidence),
    ),
  );
}

/** Mounted at /api/assets: disaster events of one asset. */
export const assetDisasterRoutes = new Hono<{ Bindings: Env }>();

assetDisasterRoutes.post("/:id/disaster-events", async (c) => {
  const assetId = c.req.param("id");
  const db = drizzle(c.env.DB);
  const asset = await db.select({ id: assets.id }).from(assets).where(eq(assets.id, assetId)).get();
  if (!asset) return c.json({ error: "asset_not_found" }, 404);

  const parsed = await parseBody(c, CreateDisasterEventInput);
  if (!parsed.ok) return parsed.res;
  const input = parsed.data;

  const unitIds = input.units.map((u) => u.unit_id);
  const owned = await db
    .select({ id: asset_units.id })
    .from(asset_units)
    .where(and(eq(asset_units.asset_id, assetId), inArray(asset_units.id, unitIds)));
  if (owned.length !== unitIds.length) return c.json({ error: "unit_not_in_asset" }, 400);

  const id = crypto.randomUUID();
  const event = {
    id,
    asset_id: assetId,
    event_type: input.event_type,
    occurred_at: toMs(input.occurred_at),
    ended_at: input.ended_at === undefined ? null : toMs(input.ended_at),
    description: input.description ?? null,
    created_at: Date.now(),
    recovery_tasks_created_at: null,
  };
  // Event and all affected units in one batch (one transaction).
  await db.batch([
    db.insert(disaster_events).values(event),
    db.insert(disaster_event_units).values(
      input.units.map((u) => ({ event_id: id, unit_id: u.unit_id, damage_bps: pctToBps(u.damage_pct), note: u.note ?? null })),
    ),
  ]);
  const [created] = await withDetails(db, [event]);
  return c.json(created, 201);
});

/** Preparation work orders when a disaster is expected (no event is recorded). */
assetDisasterRoutes.post("/:id/disaster-prep", async (c) => {
  const assetId = c.req.param("id");
  const db = drizzle(c.env.DB);
  const asset = await db.select({ id: assets.id }).from(assets).where(eq(assets.id, assetId)).get();
  if (!asset) return c.json({ error: "asset_not_found" }, 404);
  const parsed = await parseBody(c, DisasterPrepInput);
  if (!parsed.ok) return parsed.res;

  const owned = await db
    .select({ id: asset_units.id })
    .from(asset_units)
    .where(
      parsed.data.unit_ids === undefined
        ? eq(asset_units.asset_id, assetId)
        : and(eq(asset_units.asset_id, assetId), inArray(asset_units.id, parsed.data.unit_ids)),
    )
    .orderBy(asc(asset_units.name));
  if (parsed.data.unit_ids !== undefined && owned.length !== parsed.data.unit_ids.length) {
    return c.json({ error: "unit_not_in_asset" }, 400);
  }

  const now = Date.now();
  const planned = await planDisasterWorkOrders(db, assetId, owned.map((u) => u.id), parsed.data.event_type, "prepare", now);
  const [first, ...rest] = planned.map((p) =>
    db.insert(work_orders).values({ ...p, disaster_event_id: null, status: "open", created_at: now, updated_at: now }),
  );
  if (first) await db.batch([first, ...rest]);
  return c.json({ created_work_orders: await selectWorkOrders(db, planned.map((p) => p.id)) }, 201);
});

assetDisasterRoutes.get("/:id/disaster-events", async (c) => {
  const assetId = c.req.param("id");
  const db = drizzle(c.env.DB);
  const [assetRows, events] = await db.batch([
    db.select({ id: assets.id }).from(assets).where(eq(assets.id, assetId)),
    db
      .select()
      .from(disaster_events)
      .where(eq(disaster_events.asset_id, assetId))
      .orderBy(desc(disaster_events.occurred_at), desc(sql`${disaster_events}.rowid`)),
  ]);
  if (assetRows.length === 0) return c.json({ error: "asset_not_found" }, 404);
  return c.json({ disaster_events: await withDetails(db, events) });
});

/** Mounted at /api/disaster-events. */
export const disasterEventsRoutes = new Hono<{ Bindings: Env }>();

disasterEventsRoutes.get("/:id", async (c) => {
  const db = drizzle(c.env.DB);
  const event = await db.select().from(disaster_events).where(eq(disaster_events.id, c.req.param("id"))).get();
  if (!event) return eventNotFound(c);
  const [[detail], recovery] = await Promise.all([withDetails(db, [event]), recoveryWorkOrders(db, event.id)]);
  return c.json({ ...detail, recovery_work_orders: recovery });
});

async function recoveryWorkOrders(db: Db, eventId: string) {
  const rows = await db
    .select()
    .from(work_orders)
    .where(eq(work_orders.disaster_event_id, eventId))
    .orderBy(asc(work_orders.unit_id), asc(sql`${work_orders}.rowid`));
  return rows.map(workOrderToApi);
}

/** The open (not closed) crop cycle per unit, if any — one per unit by construction. */
async function openCycles(db: Db, unitIds: string[]) {
  if (unitIds.length === 0) return new Map<string, { id: string; template_key: (typeof farm_crop_cycles.$inferSelect)["template_key"] }>();
  const rows = await db
    .select({ id: farm_crop_cycles.id, unit_id: farm_crop_cycles.unit_id, template_key: farm_crop_cycles.template_key })
    .from(farm_crop_cycles)
    .where(and(inArray(farm_crop_cycles.unit_id, unitIds), ne(farm_crop_cycles.status, "closed")));
  return new Map(rows.map((r) => [r.unit_id, { id: r.id, template_key: r.template_key }]));
}

type PlannedWorkOrder = {
  id: string;
  asset_id: string;
  unit_id: string;
  crop_cycle_id: string | null;
  title: string;
  due_at: number;
};

/** Stage tasks for each unit (+ crop extras from the unit's open cycle), with new ids. */
async function planDisasterWorkOrders(db: Db, assetId: string, unitIds: string[], type: DisasterType, stage: DisasterStage, now: number) {
  const cycles = await openCycles(db, unitIds);
  const planned: PlannedWorkOrder[] = [];
  for (const unitId of unitIds) {
    const cycle = cycles.get(unitId);
    for (const task of disasterWorkOrders(type, stage, cycle?.template_key ?? null, now)) {
      planned.push({
        id: crypto.randomUUID(),
        asset_id: assetId,
        unit_id: unitId,
        crop_cycle_id: cycle?.id ?? null,
        title: task.title,
        due_at: task.due_at_ms,
      });
    }
  }
  return planned;
}

async function selectWorkOrders(db: Db, ids: string[]) {
  if (ids.length === 0) return [];
  const rows = await db.select().from(work_orders).where(inArray(work_orders.id, ids));
  return ids.flatMap((id) => rows.filter((r) => r.id === id)).map(workOrderToApi);
}

/**
 * Recovery work orders for every affected unit — once per event. The inserts and the marker update run in
 * one batch and are all conditioned on recovery_tasks_created_at still being NULL (inserts run first), so a
 * repeated or concurrent request creates nothing and gets 409.
 */
disasterEventsRoutes.post("/:id/recovery-tasks", async (c) => {
  const eventId = c.req.param("id");
  const db = drizzle(c.env.DB);
  const event = await db.select().from(disaster_events).where(eq(disaster_events.id, eventId)).get();
  if (!event) return eventNotFound(c);
  if (event.recovery_tasks_created_at !== null) return c.json({ error: "recovery_tasks_already_created" }, 409);

  const units = await db
    .select({ unit_id: disaster_event_units.unit_id })
    .from(disaster_event_units)
    .innerJoin(asset_units, eq(asset_units.id, disaster_event_units.unit_id))
    .where(eq(disaster_event_units.event_id, eventId))
    .orderBy(asc(asset_units.name));
  const now = Date.now();
  const planned = await planDisasterWorkOrders(db, event.asset_id, units.map((u) => u.unit_id), event.event_type, "recover", now);

  const stillPending = and(eq(disaster_events.id, eventId), isNull(disaster_events.recovery_tasks_created_at));
  const inserts = planned.map((p) =>
    db.insert(work_orders).select(
      db
        .select({
          id: sql<string>`${p.id}`.as("id"),
          asset_id: disaster_events.asset_id,
          unit_id: sql<string>`${p.unit_id}`.as("unit_id"),
          crop_cycle_id: sql<string | null>`${p.crop_cycle_id}`.as("crop_cycle_id"),
          disaster_event_id: disaster_events.id,
          title: sql<string>`${p.title}`.as("title"),
          status: sql<"open">`'open'`.as("status"),
          due_at: sql<number>`${p.due_at}`.as("due_at"),
          created_at: sql<number>`${now}`.as("created_at"),
          updated_at: sql<number>`${now}`.as("updated_at"),
        })
        .from(disaster_events)
        .where(stillPending),
    ),
  );
  const mark = db.update(disaster_events).set({ recovery_tasks_created_at: now }).where(stillPending).returning({ id: disaster_events.id });
  const [firstInsert, ...moreInserts] = inserts;
  const marked = firstInsert
    ? ((await db.batch([firstInsert, ...moreInserts, mark])).at(-1) as { id: string }[])
    : await mark;
  if (marked.length !== 1) return c.json({ error: "recovery_tasks_already_created" }, 409);

  return c.json({ created_work_orders: await selectWorkOrders(db, planned.map((p) => p.id)) }, 201);
});

disasterEventsRoutes.post("/:id/evidence", async (c) => {
  const eventId = c.req.param("id");
  const db = drizzle(c.env.DB);
  const event = await db.select({ id: disaster_events.id }).from(disaster_events).where(eq(disaster_events.id, eventId)).get();
  if (!event) return eventNotFound(c);

  const parsed = await parseBody(c, LinkDisasterEvidenceInput);
  if (!parsed.ok) return parsed.res;

  const evidence = await db
    .select({
      uploaded_at: work_order_evidence.uploaded_at,
      lat: work_order_evidence.lat,
      lng: work_order_evidence.lng,
      unit_id: work_orders.unit_id,
    })
    .from(work_order_evidence)
    .innerJoin(work_orders, eq(work_orders.id, work_order_evidence.work_order_id))
    .where(eq(work_order_evidence.id, parsed.data.evidence_id))
    .get();
  if (!evidence) return c.json({ error: "evidence_not_found" }, 404);
  // Only located field photos (uploaded and completed through the geofence) count as claim evidence.
  if (evidence.uploaded_at === null || evidence.lat === null || evidence.lng === null) {
    return c.json({ error: "evidence_not_located" }, 400);
  }
  const affected =
    evidence.unit_id === null
      ? undefined
      : await db
          .select({ unit_id: disaster_event_units.unit_id })
          .from(disaster_event_units)
          .where(and(eq(disaster_event_units.event_id, eventId), eq(disaster_event_units.unit_id, evidence.unit_id)))
          .get();
  if (!affected) return c.json({ error: "evidence_not_in_affected_units" }, 400);

  const inserted = await db
    .insert(disaster_event_evidence)
    .values({ event_id: eventId, evidence_id: parsed.data.evidence_id })
    .onConflictDoNothing()
    .returning();
  if (inserted.length === 0) return c.json({ error: "evidence_already_linked" }, 409);

  const full = await db.select().from(disaster_events).where(eq(disaster_events.id, eventId)).get();
  const [detail] = await withDetails(db, full ? [full] : []);
  return c.json(detail, 201);
});

/**
 * Disaster events on the cycle's unit between started_at (or created_at) and ended_at (or now), oldest
 * first, with that unit's damage. Shared by the impact route and the settlement preview.
 */
export async function cycleDisasterEvents(
  db: Db,
  cycle: { unit_id: string; started_at: number | null; created_at: number; ended_at: number | null },
) {
  const from = cycle.started_at ?? cycle.created_at;
  const to = cycle.ended_at ?? Date.now();
  const events = await db
    .select({
      id: disaster_events.id,
      event_type: disaster_events.event_type,
      occurred_at: disaster_events.occurred_at,
      damage_bps: disaster_event_units.damage_bps,
    })
    .from(disaster_event_units)
    .innerJoin(disaster_events, eq(disaster_events.id, disaster_event_units.event_id))
    .where(
      and(
        eq(disaster_event_units.unit_id, cycle.unit_id),
        gte(disaster_events.occurred_at, from),
        lte(disaster_events.occurred_at, to),
      ),
    )
    .orderBy(asc(disaster_events.occurred_at));
  return { from, to, events };
}

/** Mounted at /api/crop-cycles: disasters that hit the cycle's unit during the cycle. */
export const cycleDisasterRoutes = new Hono<{ Bindings: Env }>();

cycleDisasterRoutes.get("/:id/disaster-impact", async (c) => {
  const db = drizzle(c.env.DB);
  const cycle = await db.select().from(farm_crop_cycles).where(eq(farm_crop_cycles.id, c.req.param("id"))).get();
  if (!cycle) return c.json({ error: "crop_cycle_not_found" }, 404);

  const { from, to, events: rows } = await cycleDisasterEvents(db, cycle);

  return c.json({
    crop_cycle_id: cycle.id,
    unit_id: cycle.unit_id,
    window: { from: new Date(from).toISOString(), to: new Date(to).toISOString() },
    events: rows.map((r) => ({
      id: r.id,
      event_type: r.event_type,
      occurred_at: new Date(r.occurred_at).toISOString(),
      damage_pct: bpsToPct(r.damage_bps),
    })),
    // Compounded: 1 − Π(1 − dᵢ), never above 100%.
    combined_damage_pct: bpsToPct(combinedDamageBps(rows.map((r) => r.damage_bps))),
  });
});
