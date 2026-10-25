import { CreateHarvestLogInput, gToKg, kgToG, revenueSatang, satangToThb, thbToSatang } from "@owner-os/shared";
import { and, count, desc, eq, isNull, sql, sum } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { Hono, type Context } from "hono";
import { farm_crop_cycles, farm_harvest_logs } from "../db/schema";
import type { Env } from "../env";
import { harvestLogToApi, toMs } from "../mappers";
import { IMAGE_TYPES, MAX_UPLOAD_BYTES } from "./tasks";

type AppContext = Context<{ Bindings: Env }>;

const HARVESTED_AT_MAX_FUTURE_MS = 5 * 60 * 1000;
const SLIP_CACHE_CONTROL = "private, max-age=300";

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

const cycleNotFound = (c: AppContext) => c.json({ error: "crop_cycle_not_found" }, 404);
const logNotFound = (c: AppContext) => c.json({ error: "harvest_log_not_found" }, 404);
const notHarvesting = (c: AppContext) => c.json({ error: "cycle_not_harvesting" }, 409);
const slipAlreadyUploaded = (c: AppContext) => c.json({ error: "slip_already_uploaded" }, 409);

/** Mounted at /api/crop-cycles: harvest logs of one crop cycle. */
export const cycleHarvestLogsRoutes = new Hono<{ Bindings: Env }>();

cycleHarvestLogsRoutes.post("/:id/harvest-logs", async (c) => {
  const cycleId = c.req.param("id");
  const db = drizzle(c.env.DB);
  const cycle = await db
    .select({ status: farm_crop_cycles.status })
    .from(farm_crop_cycles)
    .where(eq(farm_crop_cycles.id, cycleId))
    .get();
  if (!cycle) return cycleNotFound(c);

  const parsed = await parseBody(c, CreateHarvestLogInput);
  if (!parsed.ok) return parsed.res;
  const input = parsed.data;
  if (cycle.status !== "harvesting") return notHarvesting(c);

  const harvestedAtMs = toMs(input.harvested_at);
  const now = Date.now();
  if (harvestedAtMs > now + HARVESTED_AT_MAX_FUTURE_MS) return c.json({ error: "harvested_at_in_future" }, 422);

  // Integers only from here on: grams, satang per kg, and revenue computed by the server.
  const weightG = kgToG(input.weight_kg);
  const unitPriceSatang = thbToSatang(input.unit_price_thb);
  const id = crypto.randomUUID();

  // Insert only while the cycle is still harvesting, so a concurrent close cannot be missed.
  const inserted = await db
    .insert(farm_harvest_logs)
    .select(
      db
        .select({
          id: sql<string>`${id}`.as("id"),
          crop_cycle_id: farm_crop_cycles.id,
          harvested_at: sql<number>`${harvestedAtMs}`.as("harvested_at"),
          weight_g: sql<number>`${weightG}`.as("weight_g"),
          unit_price_satang: sql<number>`${unitPriceSatang}`.as("unit_price_satang"),
          revenue_satang: sql<number>`${revenueSatang(weightG, unitPriceSatang)}`.as("revenue_satang"),
          buyer_name: sql<string | null>`${input.buyer_name ?? null}`.as("buyer_name"),
          slip_r2_key: sql<string>`${`harvest-logs/${cycleId}/${id}`}`.as("slip_r2_key"),
          slip_uploaded_at: sql<number | null>`NULL`.as("slip_uploaded_at"),
          note: sql<string | null>`${input.note ?? null}`.as("note"),
          created_at: sql<number>`${now}`.as("created_at"),
        })
        .from(farm_crop_cycles)
        .where(and(eq(farm_crop_cycles.id, cycleId), eq(farm_crop_cycles.status, "harvesting"))),
    )
    .returning();
  const row = inserted[0];
  if (!row) return notHarvesting(c);

  return c.json({ harvest_log: harvestLogToApi(row), slip_upload_url: `/api/harvest-logs/${id}/slip` }, 201);
});

cycleHarvestLogsRoutes.get("/:id/harvest-logs", async (c) => {
  const cycleId = c.req.param("id");
  const db = drizzle(c.env.DB);
  const [cycles, rows, totals] = await db.batch([
    db.select({ id: farm_crop_cycles.id }).from(farm_crop_cycles).where(eq(farm_crop_cycles.id, cycleId)),
    db
      .select()
      .from(farm_harvest_logs)
      .where(eq(farm_harvest_logs.crop_cycle_id, cycleId))
      .orderBy(desc(farm_harvest_logs.harvested_at), desc(sql`${farm_harvest_logs}.rowid`)),
    // Integer sums in SQL (grams, satang); converted to kg / baht only for the response.
    db
      .select({
        weight_g: sum(farm_harvest_logs.weight_g).mapWith(Number),
        revenue_satang: sum(farm_harvest_logs.revenue_satang).mapWith(Number),
        count: count(),
      })
      .from(farm_harvest_logs)
      .where(eq(farm_harvest_logs.crop_cycle_id, cycleId)),
  ]);
  if (cycles.length === 0) return cycleNotFound(c);
  const t = totals[0];
  return c.json({
    harvest_logs: rows.map(harvestLogToApi),
    totals: {
      weight_kg: gToKg(t?.weight_g ?? 0),
      revenue_thb: satangToThb(t?.revenue_satang ?? 0),
      count: t?.count ?? 0,
    },
  });
});

/** Mounted at /api/harvest-logs: weigh slip upload and download. */
export const harvestLogsRoutes = new Hono<{ Bindings: Env }>();

harvestLogsRoutes.put("/:id/slip", async (c) => {
  const db = drizzle(c.env.DB);
  const log = await db.select().from(farm_harvest_logs).where(eq(farm_harvest_logs.id, c.req.param("id"))).get();
  if (!log) return logNotFound(c);
  if (log.slip_uploaded_at !== null) return slipAlreadyUploaded(c);

  const contentType = (c.req.header("content-type") ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
  if (!IMAGE_TYPES.has(contentType)) return c.json({ error: "unsupported_media_type" }, 415);

  const declared = Number(c.req.header("content-length"));
  if (Number.isFinite(declared) && declared > MAX_UPLOAD_BYTES) return c.json({ error: "payload_too_large" }, 413);

  const bytes = await c.req.arrayBuffer();
  if (bytes.byteLength === 0) return c.json({ error: "empty_body" }, 400);
  if (bytes.byteLength > MAX_UPLOAD_BYTES) return c.json({ error: "payload_too_large" }, 413);

  // Reserve atomically before writing to R2 so two uploads cannot both succeed; undo if the put fails.
  const reserved = await db
    .update(farm_harvest_logs)
    .set({ slip_uploaded_at: Date.now() })
    .where(and(eq(farm_harvest_logs.id, log.id), isNull(farm_harvest_logs.slip_uploaded_at)))
    .returning({ id: farm_harvest_logs.id });
  if (reserved.length !== 1) return slipAlreadyUploaded(c);

  try {
    await c.env.BUCKET.put(log.slip_r2_key, bytes, { httpMetadata: { contentType } });
  } catch (err) {
    await db.update(farm_harvest_logs).set({ slip_uploaded_at: null }).where(eq(farm_harvest_logs.id, log.id)).run();
    throw err;
  }
  return c.body(null, 204);
});

harvestLogsRoutes.get("/:id/slip", async (c) => {
  const log = await drizzle(c.env.DB)
    .select({ r2_key: farm_harvest_logs.slip_r2_key, uploaded_at: farm_harvest_logs.slip_uploaded_at })
    .from(farm_harvest_logs)
    .where(eq(farm_harvest_logs.id, c.req.param("id")))
    .get();
  if (!log || log.uploaded_at === null) return c.json({ error: "slip_not_found" }, 404);

  const object = await c.env.BUCKET.get(log.r2_key);
  if (!object) return c.json({ error: "slip_not_found" }, 404);

  return c.body(object.body, 200, {
    "content-type": object.httpMetadata?.contentType ?? "application/octet-stream",
    "content-length": String(object.size),
    "cache-control": SLIP_CACHE_CONTROL,
    "x-content-type-options": "nosniff",
    etag: object.httpEtag,
  });
});
