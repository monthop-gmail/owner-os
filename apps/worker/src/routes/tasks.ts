import { CompleteWorkOrderInput, type Evidence, type Polygon } from "@owner-os/shared";
import { and, count, desc, eq, exists, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { Hono, type Context } from "hono";
import { asset_units, assets, work_order_evidence, work_orders } from "../db/schema";
import type { Env } from "../env";
import { checkGeofence } from "../geofence";
import { evidenceToApi, toIso, workOrderToApi } from "../mappers";

type AppContext = Context<{ Bindings: Env }>;

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const MAX_ACCURACY_M = 100;
const GEOFENCE_BUFFER_M = 15;
export const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const ACTIVE_STATUSES = ["open", "in_progress"] as const;
export const MAX_EVIDENCE_PER_WORK_ORDER = 20;
const CAPTURED_AT_MAX_FUTURE_MS = 5 * 60 * 1000;
const CAPTURED_AT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

const isActive = (status: string): boolean => (ACTIVE_STATUSES as readonly string[]).includes(status);

type Db = ReturnType<typeof drizzle>;

/** Uploaded evidence counts against the per-work-order quota; pending tickets do not. */
async function uploadedEvidenceCount(db: Db, woId: string): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(work_order_evidence)
    .where(and(eq(work_order_evidence.work_order_id, woId), isNotNull(work_order_evidence.uploaded_at)));
  return row?.n ?? 0;
}

/** SQL condition "work order <id> still has quota left", evaluated inside the same statement. */
const hasEvidenceQuota = (woId: string) =>
  sql`(SELECT COUNT(*) FROM ${work_order_evidence} WHERE ${work_order_evidence.work_order_id} = ${woId} AND ${work_order_evidence.uploaded_at} IS NOT NULL) < ${MAX_EVIDENCE_PER_WORK_ORDER}`;

/** SQL condition "work order <id> is still open/in_progress", evaluated inside the same statement. */
const workOrderIsActive = (db: Db, woId: string) =>
  exists(
    db
      .select({ id: work_orders.id })
      .from(work_orders)
      .where(and(eq(work_orders.id, woId), inArray(work_orders.status, [...ACTIVE_STATUSES]))),
  );

async function findWorkOrder(c: AppContext, id: string) {
  return drizzle(c.env.DB).select().from(work_orders).where(eq(work_orders.id, id)).get();
}

async function findEvidence(c: AppContext, workOrderId: string, evidenceId: string) {
  return drizzle(c.env.DB)
    .select()
    .from(work_order_evidence)
    .where(and(eq(work_order_evidence.id, evidenceId), eq(work_order_evidence.work_order_id, workOrderId)))
    .get();
}

/** Unit boundary when the work order targets a unit, otherwise the asset boundary. */
async function findFence(c: AppContext, wo: typeof work_orders.$inferSelect): Promise<Polygon | null> {
  const db = drizzle(c.env.DB);
  if (wo.unit_id !== null) {
    const unit = await db
      .select({ boundary: asset_units.boundary_geojson })
      .from(asset_units)
      .where(eq(asset_units.id, wo.unit_id))
      .get();
    if (unit) return JSON.parse(unit.boundary) as Polygon;
  }
  const asset = await db
    .select({ boundary: assets.boundary_geojson })
    .from(assets)
    .where(eq(assets.id, wo.asset_id))
    .get();
  return asset?.boundary ? (JSON.parse(asset.boundary) as Polygon) : null;
}

const woNotFound = (c: AppContext) => c.json({ error: "work_order_not_found" }, 404);
const evidenceNotFound = (c: AppContext) => c.json({ error: "evidence_not_found" }, 404);
const notActive = (c: AppContext) => c.json({ error: "work_order_not_active" }, 409);
const alreadyUploaded = (c: AppContext) => c.json({ error: "evidence_already_uploaded" }, 409);
const evidenceLimit = (c: AppContext) => c.json({ error: "evidence_limit" }, 409);

export const tasksRoutes = new Hono<{ Bindings: Env }>();

tasksRoutes.get("/:id", async (c) => {
  const db = drizzle(c.env.DB);
  const woId = c.req.param("id");
  const [woRows, evidenceRows] = await db.batch([
    db.select().from(work_orders).where(eq(work_orders.id, woId)),
    db
      .select()
      .from(work_order_evidence)
      .where(and(eq(work_order_evidence.work_order_id, woId), isNotNull(work_order_evidence.uploaded_at)))
      .orderBy(desc(work_order_evidence.uploaded_at), desc(sql`${work_order_evidence}.rowid`)),
  ]);
  const wo = woRows[0];
  if (!wo) return woNotFound(c);
  return c.json({ work_order: workOrderToApi(wo), evidence: evidenceRows.map(evidenceToApi) });
});

tasksRoutes.post("/:id/upload-ticket", async (c) => {
  const woId = c.req.param("id");
  const wo = await findWorkOrder(c, woId);
  if (!wo) return woNotFound(c);
  if (!isActive(wo.status)) return notActive(c);

  const db = drizzle(c.env.DB);
  if ((await uploadedEvidenceCount(db, woId)) >= MAX_EVIDENCE_PER_WORK_ORDER) return evidenceLimit(c);

  const evidenceId = crypto.randomUUID();
  await db
    .insert(work_order_evidence)
    .values({
      id: evidenceId,
      work_order_id: woId,
      r2_key: `work-orders/${woId}/${evidenceId}`,
      created_at: Date.now(),
    })
    .run();
  return c.json({ evidence_id: evidenceId, upload_url: `/api/tasks/${woId}/evidence/${evidenceId}` }, 201);
});

tasksRoutes.put("/:id/evidence/:evidenceId", async (c) => {
  const woId = c.req.param("id");
  const evidence = await findEvidence(c, woId, c.req.param("evidenceId"));
  if (!evidence) return evidenceNotFound(c);
  const wo = await findWorkOrder(c, woId);
  if (!wo || !isActive(wo.status)) return notActive(c);
  if (evidence.uploaded_at !== null) return alreadyUploaded(c);

  const contentType = (c.req.header("content-type") ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
  if (!IMAGE_TYPES.has(contentType)) return c.json({ error: "unsupported_media_type" }, 415);

  const declared = Number(c.req.header("content-length"));
  if (Number.isFinite(declared) && declared > MAX_UPLOAD_BYTES) return c.json({ error: "payload_too_large" }, 413);

  const bytes = await c.req.arrayBuffer();
  if (bytes.byteLength === 0) return c.json({ error: "empty_body" }, 400);
  if (bytes.byteLength > MAX_UPLOAD_BYTES) return c.json({ error: "payload_too_large" }, 413);

  // Reserve the slot atomically before writing to R2 so concurrent uploads cannot both succeed
  // and cannot push the work order past its evidence quota.
  const db = drizzle(c.env.DB);
  const reserved = await db
    .update(work_order_evidence)
    .set({ uploaded_at: Date.now() })
    .where(
      and(
        eq(work_order_evidence.id, evidence.id),
        isNull(work_order_evidence.uploaded_at),
        workOrderIsActive(db, woId),
        hasEvidenceQuota(woId),
      ),
    )
    .returning({ id: work_order_evidence.id });
  if (reserved.length !== 1) {
    if ((await uploadedEvidenceCount(db, woId)) >= MAX_EVIDENCE_PER_WORK_ORDER) return evidenceLimit(c);
    return alreadyUploaded(c);
  }

  try {
    await c.env.BUCKET.put(evidence.r2_key, bytes, { httpMetadata: { contentType } });
  } catch (err) {
    await db.update(work_order_evidence).set({ uploaded_at: null }).where(eq(work_order_evidence.id, evidence.id)).run();
    throw err;
  }
  return c.body(null, 204);
});

tasksRoutes.put("/:id/complete", async (c) => {
  const woId = c.req.param("id");
  const wo = await findWorkOrder(c, woId);
  if (!wo) return woNotFound(c);

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }
  const parsed = CompleteWorkOrderInput.safeParse(body);
  if (!parsed.success) return c.json({ error: "validation_error", issues: parsed.error.issues }, 400);
  const input = parsed.data;

  if (!isActive(wo.status)) return notActive(c);

  const evidence = await findEvidence(c, woId, input.evidence_id);
  if (!evidence) return evidenceNotFound(c);

  if (input.accuracy_m > MAX_ACCURACY_M) return c.json({ error: "accuracy_too_low" }, 422);

  const capturedAtMs = Date.parse(input.captured_at);
  const serverNow = Date.now();
  if (capturedAtMs > serverNow + CAPTURED_AT_MAX_FUTURE_MS || capturedAtMs < serverNow - CAPTURED_AT_MAX_AGE_MS) {
    return c.json({ error: "captured_at_out_of_range" }, 422);
  }
  if ((await c.env.BUCKET.head(evidence.r2_key)) === null) return c.json({ error: "evidence_not_uploaded" }, 422);

  const fence = await findFence(c, wo);
  if (!fence) return c.json({ error: "no_geofence" }, 422);

  const geo = checkGeofence(input.lng, input.lat, fence, GEOFENCE_BUFFER_M);
  if (!geo.passed) return c.json({ error: "outside_geofence", distance_outside_m: geo.distance_outside_m }, 422);

  // Both statements run in one D1 batch (a single transaction). The evidence write is conditioned on the
  // work order still being active, so a request that loses a race leaves its evidence row untouched.
  const db = drizzle(c.env.DB);
  const now = Date.now();
  const [updatedEvidence, [updatedWo]] = await db.batch([
    db
      .update(work_order_evidence)
      .set({
        lat: input.lat,
        lng: input.lng,
        accuracy_m: input.accuracy_m,
        captured_at: capturedAtMs,
        inside_geofence: geo.inside,
        distance_outside_m: geo.distance_outside_m,
      })
      .where(and(eq(work_order_evidence.id, evidence.id), workOrderIsActive(db, woId)))
      .returning({ id: work_order_evidence.id }),
    db
      .update(work_orders)
      .set({ status: "submitted", updated_at: now })
      .where(and(eq(work_orders.id, woId), inArray(work_orders.status, [...ACTIVE_STATUSES])))
      .returning(),
  ]);
  if (updatedEvidence.length !== 1 || !updatedWo) return notActive(c);

  const evidenceOut: Evidence = {
    id: evidence.id,
    work_order_id: woId,
    r2_key: evidence.r2_key,
    lat: input.lat,
    lng: input.lng,
    accuracy_m: input.accuracy_m,
    captured_at: toIso(capturedAtMs),
    inside_geofence: geo.inside,
    distance_outside_m: geo.distance_outside_m,
  };
  return c.json({ work_order: workOrderToApi(updatedWo), evidence: evidenceOut }, 200);
});
