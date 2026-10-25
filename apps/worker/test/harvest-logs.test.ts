import {
  kgToG,
  revenueSatang,
  thbToSatang,
  type Asset,
  type AssetUnit,
  type CropCycle,
  type CropCycleStatus,
  type HarvestLog,
  type Polygon,
} from "@owner-os/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Env } from "../src/env";
import { app } from "../src/index";
import { tinyJpeg } from "../src/seed/demo";
import { applyMigrations, authHeader, createTestEnv, type TestEnv } from "./d1";

type Created = { harvest_log: HarvestLog; slip_upload_url: string };
type Listing = { harvest_logs: HarvestLog[]; totals: { weight_kg: number; revenue_thb: number; count: number } };

let testEnv: TestEnv;
let env: Env;

beforeAll(async () => {
  testEnv = await createTestEnv();
  env = testEnv.env;
});

afterAll(async () => {
  await testEnv?.dispose();
});

// Fictional ~100 m square at the equator.
const D = 100 / 111_319.49;
const square: Polygon = { type: "Polygon", coordinates: [[[0, 0], [D, 0], [D, D], [0, D], [0, 0]]] };
const recently = () => new Date(Date.now() - 60_000).toISOString();

function send(method: "GET" | "POST" | "PUT", path: string, body?: unknown, contentType = "application/json", targetEnv: Env = env) {
  return app.request(
    path,
    {
      method,
      headers: { ...authHeader, "content-type": contentType },
      ...(body === undefined ? {} : { body: body instanceof Uint8Array || typeof body === "string" ? body : JSON.stringify(body) }),
    },
    targetEnv,
  );
}

async function json<T>(res: Response, status: number): Promise<T> {
  expect(res.status).toBe(status);
  return (await res.json()) as T;
}

/** A crop cycle moved to `status` (planned → growing → harvesting, or closed). */
async function cycleAt(status: CropCycleStatus): Promise<CropCycle> {
  const asset = await json<Asset>(await send("POST", "/api/assets", { name: "มินิฟาร์มทดสอบ", kind: "farm" }), 201);
  const unit = await json<AssetUnit>(
    await send("POST", `/api/assets/${asset.id}/units`, { name: "โรงเรือน 1", unit_type: "building", boundary: square }),
    201,
  );
  let cycle = await json<CropCycle>(await send("POST", `/api/units/${unit.id}/crop-cycles`, { crop: "เมล่อน" }), 201);
  const steps: Record<CropCycleStatus, CropCycleStatus[]> = {
    planned: [],
    growing: ["growing"],
    harvesting: ["growing", "harvesting"],
    closed: ["growing", "harvesting", "closed"],
  };
  for (const to of steps[status]) {
    cycle = await json<CropCycle>(await send("POST", `/api/crop-cycles/${cycle.id}/transition`, { to }), 200);
  }
  return cycle;
}

const createLog = (cycleId: string, body: Record<string, unknown>) => send("POST", `/api/crop-cycles/${cycleId}/harvest-logs`, body);

describe("POST /api/crop-cycles/:id/harvest-logs", () => {
  it("creates a log on a harvesting cycle with server-computed revenue", async () => {
    const cycle = await cycleAt("harvesting");
    const at = recently();
    const body = await json<Created>(
      await createLog(cycle.id, { harvested_at: at, weight_kg: 1200, unit_price_thb: 85, buyer_name: "ผู้ซื้อตัวอย่าง" }),
      201,
    );
    expect(body.harvest_log).toMatchObject({
      crop_cycle_id: cycle.id,
      harvested_at: at,
      weight_kg: 1200,
      unit_price_thb: 85,
      revenue_thb: 102_000,
      buyer_name: "ผู้ซื้อตัวอย่าง",
      note: null,
      slip_uploaded: false,
    });
    expect(body.slip_upload_url).toBe(`/api/harvest-logs/${body.harvest_log.id}/slip`);

    const row = await env.DB.prepare(
      "SELECT weight_g, unit_price_satang, revenue_satang, slip_r2_key, slip_uploaded_at FROM farm_harvest_logs WHERE id = ?",
    )
      .bind(body.harvest_log.id)
      .first();
    expect(row).toEqual({
      weight_g: 1_200_000,
      unit_price_satang: 8_500,
      revenue_satang: 10_200_000,
      slip_r2_key: `harvest-logs/${cycle.id}/${body.harvest_log.id}`,
      slip_uploaded_at: null,
    });
  });

  it.each<CropCycleStatus>(["planned", "growing", "closed"])("rejects a %s cycle with 409 cycle_not_harvesting", async (status) => {
    const cycle = await cycleAt(status);
    const body = await json<{ error: string }>(
      await createLog(cycle.id, { harvested_at: recently(), weight_kg: 10, unit_price_thb: 5 }),
      409,
    );
    expect(body.error).toBe("cycle_not_harvesting");
  });

  it("rejects client-supplied revenue and invalid numbers with 400", async () => {
    const cycle = await cycleAt("harvesting");
    const base = { harvested_at: recently(), weight_kg: 10, unit_price_thb: 5 };
    expect((await createLog(cycle.id, { ...base, revenue_thb: 999 })).status).toBe(400);
    expect((await createLog(cycle.id, { ...base, revenue_satang: 999 })).status).toBe(400);
    expect((await createLog(cycle.id, { ...base, weight_kg: 0 })).status).toBe(400);
    expect((await createLog(cycle.id, { ...base, weight_kg: 1.2345 })).status).toBe(400);
    expect((await createLog(cycle.id, { ...base, unit_price_thb: 1.005 })).status).toBe(400);
  });

  it("rejects harvested_at more than 5 minutes in the future with 422", async () => {
    const cycle = await cycleAt("harvesting");
    const future = new Date(Date.now() + 6 * 60_000).toISOString();
    const body = await json<{ error: string }>(await createLog(cycle.id, { harvested_at: future, weight_kg: 1, unit_price_thb: 1 }), 422);
    expect(body.error).toBe("harvested_at_in_future");
  });

  it("returns 404 for an unknown cycle", async () => {
    expect((await createLog("nope", { harvested_at: recently(), weight_kg: 1, unit_price_thb: 1 })).status).toBe(404);
  });
});

describe("GET /api/crop-cycles/:id/harvest-logs", () => {
  it("totals 3 logs (with decimals) exactly to the satang", async () => {
    const cycle = await cycleAt("harvesting");
    const logs = [
      { weight_kg: 0.333, unit_price_thb: 33.33 }, // 1110 satang
      { weight_kg: 1200, unit_price_thb: 85 }, // 10,200,000 satang
      { weight_kg: 12.345, unit_price_thb: 49.99 }, // 12345 g × 4999 / 1000 = 61,712.655 → 61,713 satang
    ];
    for (const [i, l] of logs.entries()) {
      await json(await createLog(cycle.id, { ...l, harvested_at: new Date(Date.now() - (3 - i) * 60_000).toISOString() }), 201);
    }
    const expectedSatang = logs.reduce((sum, l) => sum + revenueSatang(kgToG(l.weight_kg), thbToSatang(l.unit_price_thb)), 0);
    expect(expectedSatang).toBe(1110 + 10_200_000 + 61_713);
    const expectedGrams = logs.reduce((sum, l) => sum + kgToG(l.weight_kg), 0);

    const body = await json<Listing>(await send("GET", `/api/crop-cycles/${cycle.id}/harvest-logs`), 200);
    expect(body.totals.count).toBe(3);
    expect(Math.round(body.totals.revenue_thb * 100)).toBe(expectedSatang);
    expect(body.totals.revenue_thb).toBe(expectedSatang / 100);
    expect(body.totals.weight_kg).toBe(expectedGrams / 1000);
    // Newest harvest first.
    expect(body.harvest_logs.map((l) => l.weight_kg)).toEqual([12.345, 1200, 0.333]);
    expect(body.harvest_logs.map((l) => l.revenue_thb)).toEqual([617.13, 102_000, 11.1]);

    const db = await env.DB.prepare("SELECT SUM(revenue_satang) s FROM farm_harvest_logs WHERE crop_cycle_id = ?").bind(cycle.id).first();
    expect(db).toEqual({ s: expectedSatang });
  });

  it("returns zero totals for a cycle without logs and 404 for an unknown cycle", async () => {
    const cycle = await cycleAt("harvesting");
    const body = await json<Listing>(await send("GET", `/api/crop-cycles/${cycle.id}/harvest-logs`), 200);
    expect(body).toEqual({ harvest_logs: [], totals: { weight_kg: 0, revenue_thb: 0, count: 0 } });
    expect((await send("GET", "/api/crop-cycles/nope/harvest-logs")).status).toBe(404);
  });
});

describe("weigh slip", () => {
  async function newLog(): Promise<Created> {
    const cycle = await cycleAt("harvesting");
    return json<Created>(await createLog(cycle.id, { harvested_at: recently(), weight_kg: 50, unit_price_thb: 20 }), 201);
  }

  it("uploads the slip once and serves it back with private caching and nosniff", async () => {
    const { harvest_log, slip_upload_url } = await newLog();
    expect((await send("GET", slip_upload_url)).status).toBe(404);

    expect((await send("PUT", slip_upload_url, tinyJpeg(), "image/jpeg")).status).toBe(204);
    const again = await json<{ error: string }>(await send("PUT", slip_upload_url, tinyJpeg(), "image/jpeg"), 409);
    expect(again.error).toBe("slip_already_uploaded");

    const res = await send("GET", slip_upload_url);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/jpeg");
    expect(res.headers.get("cache-control")).toBe("private, max-age=300");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(tinyJpeg());

    const list = await json<Listing>(await send("GET", `/api/crop-cycles/${harvest_log.crop_cycle_id}/harvest-logs`), 200);
    expect(list.harvest_logs[0]!.slip_uploaded).toBe(true);
  });

  it("lets only one of two concurrent slip uploads win", async () => {
    const { harvest_log, slip_upload_url } = await newLog();
    const [a, b] = await Promise.all([
      send("PUT", slip_upload_url, tinyJpeg(), "image/jpeg"),
      send("PUT", slip_upload_url, tinyJpeg(), "image/jpeg"),
    ]);
    expect([a.status, b.status].sort()).toEqual([204, 409]);
    const loser = a.status === 409 ? a : b;
    expect(((await loser.json()) as { error: string }).error).toBe("slip_already_uploaded");
    const row = await env.DB.prepare("SELECT slip_uploaded_at FROM farm_harvest_logs WHERE id = ?")
      .bind(harvest_log.id)
      .first<{ slip_uploaded_at: number | null }>();
    expect(row!.slip_uploaded_at).not.toBeNull();
    expect((await send("GET", slip_upload_url)).status).toBe(200);
  });

  it("rejects the wrong content type (415), too large (413) and empty (400) uploads", async () => {
    const { slip_upload_url } = await newLog();
    expect((await send("PUT", slip_upload_url, "not an image", "text/plain")).status).toBe(415);
    expect((await send("PUT", slip_upload_url, new Uint8Array(10 * 1024 * 1024 + 1), "image/png")).status).toBe(413);
    expect((await send("PUT", slip_upload_url, new Uint8Array(0), "image/webp")).status).toBe(400);
    // None of the rejected uploads reserved the slot.
    expect((await send("PUT", slip_upload_url, tinyJpeg(), "image/jpeg")).status).toBe(204);
  });

  it("rolls slip_uploaded_at back when BUCKET.put fails, then a retry succeeds", async () => {
    const { harvest_log, slip_upload_url } = await newLog();
    const failingBucket = { put: () => Promise.reject(new Error("simulated R2 failure")) } as unknown as R2Bucket;
    const failed = await send("PUT", slip_upload_url, tinyJpeg(), "image/jpeg", { ...env, BUCKET: failingBucket });
    expect(failed.status).toBe(500);
    const row = await env.DB.prepare("SELECT slip_uploaded_at FROM farm_harvest_logs WHERE id = ?").bind(harvest_log.id).first();
    expect(row).toEqual({ slip_uploaded_at: null });

    expect((await send("PUT", slip_upload_url, tinyJpeg(), "image/jpeg")).status).toBe(204);
    expect((await send("GET", slip_upload_url)).status).toBe(200);
  });

  it("returns 404 for an unknown harvest log", async () => {
    expect((await send("PUT", "/api/harvest-logs/nope/slip", tinyJpeg(), "image/jpeg")).status).toBe(404);
    expect((await send("GET", "/api/harvest-logs/nope/slip")).status).toBe(404);
  });

  it("requires a token on every harvest route", async () => {
    for (const [method, path] of [
      ["POST", "/api/crop-cycles/any/harvest-logs"],
      ["GET", "/api/crop-cycles/any/harvest-logs"],
      ["PUT", "/api/harvest-logs/any/slip"],
      ["GET", "/api/harvest-logs/any/slip"],
    ] as const) {
      expect((await app.request(path, { method }, env)).status, `${method} ${path}`).toBe(401);
    }
  });
});

describe("database constraints", () => {
  it("rejects non-positive weight and negative money even without the API", async () => {
    const cycle = await cycleAt("harvesting");
    const insert = (weight: number, price: number, revenue: number) =>
      env.DB.prepare(
        "INSERT INTO farm_harvest_logs (id, crop_cycle_id, harvested_at, weight_g, unit_price_satang, revenue_satang, slip_r2_key, created_at) VALUES (?, ?, 0, ?, ?, ?, ?, 0)",
      )
        .bind(crypto.randomUUID(), cycle.id, weight, price, revenue, crypto.randomUUID())
        .run();
    await expect(insert(0, 100, 0)).rejects.toThrow(/CHECK constraint/);
    await expect(insert(10, -1, 0)).rejects.toThrow(/CHECK constraint/);
    await expect(insert(10, 1, -1)).rejects.toThrow(/CHECK constraint/);
    await expect(insert(10, 0, 0)).resolves.toBeTruthy();
  });
});

describe("migration 0003 on a database with existing data", () => {
  it("creates farm_harvest_logs without touching earlier rows", async () => {
    const legacy = await createTestEnv({ migrations: (f) => !f.startsWith("0003_") });
    try {
      const db = legacy.env.DB;
      const now = Date.now();
      await db.batch([
        db.prepare("INSERT INTO assets (id, name, kind, created_at) VALUES ('a', 'สวนเดิม', 'farm', ?)").bind(now),
        db
          .prepare(
            "INSERT INTO asset_units (id, asset_id, name, unit_type, boundary_geojson, area_m2, created_at) VALUES ('u', 'a', 'แปลงเดิม', 'plot', ?, 10000, ?)",
          )
          .bind(JSON.stringify(square), now),
        db
          .prepare(
            "INSERT INTO farm_crop_cycles (id, unit_id, crop, status, template_key, started_at, created_at) VALUES ('c', 'u', 'เมล่อน', 'harvesting', 'melon', ?, ?)",
          )
          .bind(now, now),
        db
          .prepare(
            "INSERT INTO work_orders (id, asset_id, unit_id, crop_cycle_id, title, status, created_at, updated_at) VALUES ('w', 'a', 'u', 'c', 'งานเดิม', 'open', ?, ?)",
          )
          .bind(now, now),
      ]);

      expect(await applyMigrations(db, (f) => f.startsWith("0003_"))).toEqual(["0003_harvest_logs.sql"]);
      const counts = await db
        .prepare(
          "SELECT (SELECT COUNT(*) FROM assets) a, (SELECT COUNT(*) FROM asset_units) u, (SELECT COUNT(*) FROM farm_crop_cycles) c, (SELECT COUNT(*) FROM work_orders) w, (SELECT COUNT(*) FROM farm_harvest_logs) h",
        )
        .first();
      expect(counts).toEqual({ a: 1, u: 1, c: 1, w: 1, h: 0 });

      const created = await json<Created>(
        await send("POST", "/api/crop-cycles/c/harvest-logs", { harvested_at: recently(), weight_kg: 1200, unit_price_thb: 85 }, "application/json", legacy.env),
        201,
      );
      expect(created.harvest_log.revenue_thb).toBe(102_000);
    } finally {
      await legacy.dispose();
    }
  });
});
