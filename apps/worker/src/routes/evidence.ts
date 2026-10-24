import { IdSchema } from "@owner-os/shared";
import { and, desc, eq, isNotNull, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { Hono, type Context } from "hono";
import { work_order_evidence, work_orders } from "../db/schema";
import type { Env } from "../env";
import { evidenceToApi } from "../mappers";

type AppContext = Context<{ Bindings: Env }>;

export const DEFAULT_EVIDENCE_LIMIT = 100;
export const MAX_EVIDENCE_LIMIT = 500;
const IMAGE_CACHE_CONTROL = "private, max-age=300";

// Query-string validation reuses the zod schemas exported by @owner-os/shared
// (the worker has no direct zod dependency). limit > MAX_EVIDENCE_LIMIT is rejected, not clamped.
const AssetIdQuery = IdSchema.optional();
const LimitQuery = IdSchema.regex(/^[1-9][0-9]{0,3}$/, "limit must be a positive integer").optional();

const evidenceNotFound = (c: AppContext) => c.json({ error: "evidence_not_found" }, 404);

export const evidenceRoutes = new Hono<{ Bindings: Env }>();

/** Uploaded evidence that has coordinates (map pins), newest upload first. */
evidenceRoutes.get("/", async (c) => {
  const assetId = AssetIdQuery.safeParse(c.req.query("asset_id"));
  const limitRaw = LimitQuery.safeParse(c.req.query("limit"));
  if (!assetId.success) return c.json({ error: "validation_error", issues: assetId.error.issues }, 400);
  if (!limitRaw.success) return c.json({ error: "validation_error", issues: limitRaw.error.issues }, 400);
  const limit = limitRaw.data === undefined ? DEFAULT_EVIDENCE_LIMIT : Number(limitRaw.data);
  if (limit > MAX_EVIDENCE_LIMIT) {
    return c.json({ error: "validation_error", issues: [{ path: ["limit"], message: `max ${MAX_EVIDENCE_LIMIT}` }] }, 400);
  }

  const conditions = [
    isNotNull(work_order_evidence.uploaded_at),
    isNotNull(work_order_evidence.lat),
    isNotNull(work_order_evidence.lng),
  ];
  if (assetId.data !== undefined) conditions.push(eq(work_orders.asset_id, assetId.data));

  const rows = await drizzle(c.env.DB)
    .select({
      evidence: work_order_evidence,
      asset_id: work_orders.asset_id,
      unit_id: work_orders.unit_id,
      work_order_title: work_orders.title,
    })
    .from(work_order_evidence)
    .innerJoin(work_orders, eq(work_orders.id, work_order_evidence.work_order_id))
    .where(and(...conditions))
    .orderBy(desc(work_order_evidence.uploaded_at), desc(sql`${work_order_evidence}.rowid`))
    .limit(limit);

  return c.json({
    evidence: rows.map((r) => ({
      ...evidenceToApi(r.evidence),
      asset_id: r.asset_id,
      unit_id: r.unit_id,
      work_order_title: r.work_order_title,
    })),
  });
});

evidenceRoutes.get("/:id/image", async (c) => {
  const row = await drizzle(c.env.DB)
    .select({ r2_key: work_order_evidence.r2_key, uploaded_at: work_order_evidence.uploaded_at })
    .from(work_order_evidence)
    .where(eq(work_order_evidence.id, c.req.param("id")))
    .get();
  if (!row || row.uploaded_at === null) return evidenceNotFound(c);

  const object = await c.env.BUCKET.get(row.r2_key);
  if (!object) return evidenceNotFound(c);

  return c.body(object.body, 200, {
    "content-type": object.httpMetadata?.contentType ?? "application/octet-stream",
    "content-length": String(object.size),
    "cache-control": IMAGE_CACHE_CONTROL,
    etag: object.httpEtag,
  });
});
