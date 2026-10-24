import { combinedDamageBps, CreateDisasterEventInput, LinkDisasterEvidenceInput, bpsToPct, pctToBps } from "@owner-os/shared";
import { and, asc, desc, eq, gte, inArray, lte, sql } from "drizzle-orm";
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
import { disasterEventToApi, toMs, type DisasterEventRow } from "../mappers";

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
  const [detail] = await withDetails(db, [event]);
  return c.json(detail);
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

/** Mounted at /api/crop-cycles: disasters that hit the cycle's unit during the cycle. */
export const cycleDisasterRoutes = new Hono<{ Bindings: Env }>();

cycleDisasterRoutes.get("/:id/disaster-impact", async (c) => {
  const db = drizzle(c.env.DB);
  const cycle = await db.select().from(farm_crop_cycles).where(eq(farm_crop_cycles.id, c.req.param("id"))).get();
  if (!cycle) return c.json({ error: "crop_cycle_not_found" }, 404);

  const from = cycle.started_at ?? cycle.created_at;
  const to = cycle.ended_at ?? Date.now();
  const rows = await db
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
