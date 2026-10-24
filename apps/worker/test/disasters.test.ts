import type { Asset, AssetUnit, CropCycle, DisasterEvent, Polygon, WorkOrder } from "@owner-os/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fixtureJson from "../fixtures/demo-seed.json";
import type { Env } from "../src/env";
import { app } from "../src/index";
import { seedDemo, tinyJpeg, type DemoFixture } from "../src/seed/demo";
import { applyMigrations, authHeader, createTestEnv, TEST_API_TOKEN, type TestEnv } from "./d1";

type Impact = { events: { id: string; event_type: string; occurred_at: string; damage_pct: number }[]; combined_damage_pct: number };

let testEnv: TestEnv;
let env: Env;
let durian: Asset;
let durianUnit: AssetUnit;
let maize: Asset;

function send(method: "GET" | "POST" | "PUT", path: string, body?: unknown, contentType = "application/json", targetEnv: Env = env) {
  return app.request(
    path,
    {
      method,
      headers: { ...authHeader, "content-type": contentType },
      ...(body === undefined ? {} : { body: body instanceof Uint8Array ? body : JSON.stringify(body) }),
    },
    targetEnv,
  );
}

async function json<T>(res: Response, status: number): Promise<T> {
  expect(res.status).toBe(status);
  return (await res.json()) as T;
}

const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

beforeAll(async () => {
  testEnv = await createTestEnv();
  env = testEnv.env;
  const summary = await seedDemo((p, i) => app.request(p, i, env), { token: TEST_API_TOKEN, fixture: fixtureJson as DemoFixture });
  expect(summary.failures).toEqual([]);
  const { assets } = await json<{ assets: Asset[] }>(await send("GET", "/api/assets"), 200);
  durian = assets.find((a) => a.name.includes("ทุเรียน"))!;
  maize = assets.find((a) => a.name.includes("ข้าวโพด"))!;
  durianUnit = (await json<{ units: AssetUnit[] }>(await send("GET", `/api/assets/${durian.id}`), 200)).units[0]!;
}, 30_000);

afterAll(async () => {
  await testEnv?.dispose();
});

const flood = (unitId: string, damage_pct: number, occurred_at = minutesAgo(10)) => ({
  event_type: "flood",
  occurred_at,
  description: "น้ำท่วมขัง (demo)",
  units: [{ unit_id: unitId, damage_pct }],
});

async function submittedEvidenceId(asset: Asset): Promise<string> {
  const { work_orders } = await json<{ work_orders: WorkOrder[] }>(await send("GET", `/api/assets/${asset.id}/work-orders?status=submitted`), 200);
  const task = await json<{ evidence: { id: string }[] }>(await send("GET", `/api/tasks/${work_orders[0]!.id}`), 200);
  return task.evidence[0]!.id;
}

describe("POST /api/assets/:id/disaster-events", () => {
  it("records a 40% flood on the durian plot with weighted damage and damaged area", async () => {
    const event = await json<DisasterEvent>(await send("POST", `/api/assets/${durian.id}/disaster-events`, flood(durianUnit.id, 40)), 201);
    expect(event).toMatchObject({ asset_id: durian.id, event_type: "flood", description: "น้ำท่วมขัง (demo)", weighted_damage_pct: 40, evidence: [] });
    expect(event.units).toEqual([
      {
        unit_id: durianUnit.id,
        unit_name: "แปลงหมอนทอง โซน A",
        area_m2: durianUnit.area_m2,
        damage_pct: 40,
        damaged_area_m2: Math.round(durianUnit.area_m2! * 40) / 100,
        note: null,
      },
    ]);
    expect(Math.abs(event.units[0]!.damaged_area_m2! - 18_974)).toBeLessThan(200); // ≈ 47,435 × 40%
    const row = await env.DB.prepare("SELECT damage_bps FROM disaster_event_units WHERE event_id = ?").bind(event.id).first();
    expect(row).toEqual({ damage_bps: 4000 });

    const { recovery_work_orders, ...detail } = await json<DisasterEvent & { recovery_work_orders: unknown[] }>(
      await send("GET", `/api/disaster-events/${event.id}`),
      200,
    );
    expect(detail).toEqual(event);
    expect(recovery_work_orders).toEqual([]);
    const list = await json<{ disaster_events: DisasterEvent[] }>(await send("GET", `/api/assets/${durian.id}/disaster-events`), 200);
    expect(list.disaster_events.map((e) => e.id)).toContain(event.id);
  });

  it("rejects a unit of another asset, damage 101, duplicate units and a future date with 400", async () => {
    const { units: maizeUnits } = await json<{ units: AssetUnit[] }>(await send("GET", `/api/assets/${maize.id}`), 200);
    const other = await send("POST", `/api/assets/${durian.id}/disaster-events`, flood(maizeUnits[0]!.id, 10));
    expect((await json<{ error: string }>(other, 400)).error).toBe("unit_not_in_asset");
    expect((await send("POST", `/api/assets/${durian.id}/disaster-events`, flood(durianUnit.id, 101))).status).toBe(400);
    const dup = { ...flood(durianUnit.id, 10), units: [{ unit_id: durianUnit.id, damage_pct: 10 }, { unit_id: durianUnit.id, damage_pct: 20 }] };
    expect((await send("POST", `/api/assets/${durian.id}/disaster-events`, dup)).status).toBe(400);
    const future = flood(durianUnit.id, 10, new Date(Date.now() + 10 * 60_000).toISOString());
    expect((await send("POST", `/api/assets/${durian.id}/disaster-events`, future)).status).toBe(400);
    expect((await send("POST", "/api/assets/nope/disaster-events", flood(durianUnit.id, 10))).status).toBe(404);
  });
});

describe("POST /api/disaster-events/:id/evidence", () => {
  it("links located evidence from the affected plot; rejects other plots, duplicates and unlocated uploads", async () => {
    const event = await json<DisasterEvent>(await send("POST", `/api/assets/${durian.id}/disaster-events`, flood(durianUnit.id, 25)), 201);

    const durianEvidence = await submittedEvidenceId(durian);
    const linked = await json<DisasterEvent>(await send("POST", `/api/disaster-events/${event.id}/evidence`, { evidence_id: durianEvidence }), 201);
    expect(linked.evidence.map((e) => e.id)).toEqual([durianEvidence]);
    expect(linked.evidence[0]!.lat).not.toBeNull();

    const again = await send("POST", `/api/disaster-events/${event.id}/evidence`, { evidence_id: durianEvidence });
    expect((await json<{ error: string }>(again, 409)).error).toBe("evidence_already_linked");

    const maizeEvidence = await submittedEvidenceId(maize);
    const wrongPlot = await send("POST", `/api/disaster-events/${event.id}/evidence`, { evidence_id: maizeEvidence });
    expect((await json<{ error: string }>(wrongPlot, 400)).error).toBe("evidence_not_in_affected_units");

    // Uploaded on the durian plot but never completed through the geofence → no coordinates.
    const wo = await json<WorkOrder>(
      await send("POST", `/api/assets/${durian.id}/work-orders`, { title: "สำรวจความเสียหาย (demo)", unit_id: durianUnit.id }),
      201,
    );
    const ticket = await json<{ evidence_id: string; upload_url: string }>(await send("POST", `/api/tasks/${wo.id}/upload-ticket`), 201);
    expect((await send("PUT", ticket.upload_url, tinyJpeg(), "image/jpeg")).status).toBe(204);
    const unlocated = await send("POST", `/api/disaster-events/${event.id}/evidence`, { evidence_id: ticket.evidence_id });
    expect((await json<{ error: string }>(unlocated, 400)).error).toBe("evidence_not_located");

    expect((await send("POST", `/api/disaster-events/${event.id}/evidence`, { evidence_id: "nope" })).status).toBe(404);
    expect((await send("POST", "/api/disaster-events/nope/evidence", { evidence_id: durianEvidence })).status).toBe(404);
    const detail = await json<DisasterEvent>(await send("GET", `/api/disaster-events/${event.id}`), 200);
    expect(detail.evidence).toHaveLength(1);
  });
});

describe("GET /api/crop-cycles/:id/disaster-impact", () => {
  // Fictional ~100 m square at the equator, on a fresh asset so earlier events do not interfere.
  const D = 100 / 111_319.49;
  const square: Polygon = { type: "Polygon", coordinates: [[[0, 0], [D, 0], [D, D], [0, D], [0, 0]]] };

  it("compounds 40% and 50% within the cycle to 70% and ignores events before the cycle started", async () => {
    const asset = await json<Asset>(await send("POST", "/api/assets", { name: "สวนทดสอบภัย (demo)", kind: "farm" }), 201);
    const unit = await json<AssetUnit>(await send("POST", `/api/assets/${asset.id}/units`, { name: "แปลง 1", unit_type: "plot", boundary: square }), 201);
    const before = await json<DisasterEvent>(await send("POST", `/api/assets/${asset.id}/disaster-events`, flood(unit.id, 90, minutesAgo(24 * 60))), 201);

    const cycle = await json<CropCycle>(await send("POST", `/api/units/${unit.id}/crop-cycles`, { crop: "ทุเรียน" }), 201);
    await json(await send("POST", `/api/crop-cycles/${cycle.id}/transition`, { to: "growing" }), 200);
    await new Promise((r) => setTimeout(r, 5));
    const now = () => new Date().toISOString();
    const a = await json<DisasterEvent>(await send("POST", `/api/assets/${asset.id}/disaster-events`, { ...flood(unit.id, 40, now()), event_type: "storm" }), 201);
    const b = await json<DisasterEvent>(await send("POST", `/api/assets/${asset.id}/disaster-events`, { ...flood(unit.id, 50, now()), event_type: "pest_disease" }), 201);

    const impact = await json<Impact>(await send("GET", `/api/crop-cycles/${cycle.id}/disaster-impact`), 200);
    expect(impact.events.map((e) => [e.id, e.damage_pct])).toEqual([
      [a.id, 40],
      [b.id, 50],
    ]);
    expect(impact.events.map((e) => e.id)).not.toContain(before.id);
    expect(impact.combined_damage_pct).toBe(70);
  });

  it("returns 0% for a cycle without events and 404 for an unknown cycle", async () => {
    const asset = await json<Asset>(await send("POST", "/api/assets", { name: "สวนปลอดภัย (demo)", kind: "farm" }), 201);
    const unit = await json<AssetUnit>(await send("POST", `/api/assets/${asset.id}/units`, { name: "แปลง 1", unit_type: "plot", boundary: square }), 201);
    const cycle = await json<CropCycle>(await send("POST", `/api/units/${unit.id}/crop-cycles`, { crop: "ข้าวโพด" }), 201);
    expect(await json<Impact>(await send("GET", `/api/crop-cycles/${cycle.id}/disaster-impact`), 200)).toMatchObject({ events: [], combined_damage_pct: 0 });
    expect((await send("GET", "/api/crop-cycles/nope/disaster-impact")).status).toBe(404);
  });
});

describe("auth and migration", () => {
  it("returns 401 without a token on every disaster route", async () => {
    for (const [method, path] of [
      ["POST", "/api/assets/any/disaster-events"],
      ["GET", "/api/assets/any/disaster-events"],
      ["GET", "/api/disaster-events/any"],
      ["POST", "/api/disaster-events/any/evidence"],
      ["GET", "/api/crop-cycles/any/disaster-impact"],
    ] as const) {
      expect((await app.request(path, { method }, env)).status, `${method} ${path}`).toBe(401);
    }
  });

  it("applies migration 0005 on a database with existing data", async () => {
    // Rows written directly in the 0004-era schema (the current API expects the latest schema).
    const legacy = await createTestEnv({ migrations: (f) => f < "0005_" });
    try {
      const db = legacy.env.DB;
      const now = Date.now();
      await db.batch([
        db.prepare("INSERT INTO assets (id, name, kind, created_at) VALUES ('v', 'พูลวิลล่า (demo)', 'property', ?)").bind(now),
        db
          .prepare("INSERT INTO asset_units (id, asset_id, name, unit_type, boundary_geojson, area_m2, created_at) VALUES ('vu', 'v', 'Villa 1', 'building', '{}', 1897, ?)")
          .bind(now),
        db
          .prepare("INSERT INTO work_orders (id, asset_id, unit_id, title, status, created_at, updated_at) VALUES ('w', 'v', 'vu', 'ล้างสระ', 'submitted', ?, ?)")
          .bind(now, now),
        db
          .prepare(
            "INSERT INTO asset_contracts (id, asset_id, contract_type, partner_label, terms_json, is_active, starts_at, created_at) VALUES ('k', 'v', 'property_management', 'บริษัทบริหารที่พัก (demo)', '{}', 1, ?, ?)",
          )
          .bind(now, now),
      ]);
      const counts = "SELECT (SELECT COUNT(*) FROM assets) a, (SELECT COUNT(*) FROM work_orders) w, (SELECT COUNT(*) FROM asset_contracts) k";
      const before = await db.prepare(counts).first();
      const applied = await applyMigrations(db, (f) => f >= "0005_");
      expect(applied[0]).toBe("0005_disaster_events.sql");
      expect(await db.prepare(counts).first()).toEqual(before);
      expect(before).toEqual({ a: 1, w: 1, k: 1 });

      const res = await send("POST", "/api/assets/v/disaster-events", { ...flood("vu", 15), event_type: "storm" }, "application/json", legacy.env);
      expect(res.status).toBe(201);
    } finally {
      await legacy.dispose();
    }
  });
});
