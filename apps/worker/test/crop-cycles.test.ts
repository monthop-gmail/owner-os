import type { Asset, AssetUnit, CropCycle, CropCycleStatus, Polygon, WorkOrder } from "@owner-os/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Env } from "../src/env";
import { app } from "../src/index";
import { applyMigrations, authHeader, createTestEnv, type TestEnv } from "./d1";

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

function send(method: "GET" | "POST", path: string, body?: unknown) {
  return app.request(
    path,
    {
      method,
      headers: { ...authHeader, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
    env,
  );
}

async function json<T>(res: Response, status: number): Promise<T> {
  expect(res.status).toBe(status);
  return (await res.json()) as T;
}

async function newUnit(): Promise<{ asset: Asset; unit: AssetUnit }> {
  const asset = await json<Asset>(await send("POST", "/api/assets", { name: "ฟาร์มทดสอบ", kind: "farm" }), 201);
  const unit = await json<AssetUnit>(
    await send("POST", `/api/assets/${asset.id}/units`, { name: "แปลง 1", unit_type: "plot", boundary: square }),
    201,
  );
  return { asset, unit };
}

async function newCycle(unitId: string, body: Record<string, unknown> = { crop: "ทุเรียน", variety: "หมอนทอง" }) {
  return json<CropCycle>(await send("POST", `/api/units/${unitId}/crop-cycles`, body), 201);
}

const transition = (id: string, to: CropCycleStatus) => send("POST", `/api/crop-cycles/${id}/transition`, { to });

async function cycleAt(status: CropCycleStatus): Promise<CropCycle> {
  const { unit } = await newUnit();
  let cycle = await newCycle(unit.id);
  const path: Record<CropCycleStatus, CropCycleStatus[]> = {
    planned: [],
    growing: ["growing"],
    harvesting: ["growing", "harvesting"],
    closed: ["closed"],
  };
  for (const to of path[status]) cycle = await json<CropCycle>(await transition(cycle.id, to), 200);
  expect(cycle.status).toBe(status);
  return cycle;
}

describe("POST/GET /api/units/:id/crop-cycles", () => {
  it("creates a planned cycle and lists cycles newest first", async () => {
    const { unit } = await newUnit();
    const harvest = "2027-06-01T00:00:00.000Z";
    const cycle = await newCycle(unit.id, { crop: "ทุเรียน", variety: "หมอนทอง", expected_harvest_at: harvest });
    expect(cycle).toMatchObject({
      unit_id: unit.id,
      crop: "ทุเรียน",
      variety: "หมอนทอง",
      status: "planned",
      started_at: null,
      ended_at: null,
      expected_harvest_at: harvest,
    });
    const row = await env.DB.prepare("SELECT status, expected_harvest_at FROM farm_crop_cycles WHERE id = ?")
      .bind(cycle.id)
      .first();
    expect(row).toEqual({ status: "planned", expected_harvest_at: Date.parse(harvest) });

    await json(await transition(cycle.id, "closed"), 200);
    const second = await newCycle(unit.id, { crop: "ข้าวโพด" });
    const list = await json<{ crop_cycles: CropCycle[] }>(await send("GET", `/api/units/${unit.id}/crop-cycles`), 200);
    expect(list.crop_cycles.map((c) => c.id)).toEqual([second.id, cycle.id]);
    expect(second.variety).toBeNull();
  });

  it("rejects a second open cycle on the same unit with 409, and allows a new one after closing", async () => {
    const { unit } = await newUnit();
    const first = await newCycle(unit.id);
    expect((await send("POST", `/api/units/${unit.id}/crop-cycles`, { crop: "ข้าวโพด" })).status).toBe(409);
    await json(await transition(first.id, "growing"), 200);
    const body = await json<{ error: string }>(await send("POST", `/api/units/${unit.id}/crop-cycles`, { crop: "ข้าวโพด" }), 409);
    expect(body.error).toBe("open_crop_cycle_exists");

    await json(await transition(first.id, "closed"), 200);
    await newCycle(unit.id, { crop: "ข้าวโพด" });
  });

  it("returns 404 for an unknown unit and 400 for invalid input", async () => {
    expect((await send("POST", "/api/units/nope/crop-cycles", { crop: "ทุเรียน" })).status).toBe(404);
    expect((await send("GET", "/api/units/nope/crop-cycles")).status).toBe(404);
    const { unit } = await newUnit();
    expect((await send("POST", `/api/units/${unit.id}/crop-cycles`, { crop: "" })).status).toBe(400);
    expect((await send("POST", `/api/units/${unit.id}/crop-cycles`, { crop: "ทุเรียน", status: "growing" })).status).toBe(400);
  });
});

describe("POST /api/crop-cycles/:id/transition", () => {
  const allowed: [CropCycleStatus, CropCycleStatus][] = [
    ["planned", "growing"],
    ["growing", "harvesting"],
    ["harvesting", "closed"],
    ["planned", "closed"],
    ["growing", "closed"],
  ];
  it.each(allowed)("allows %s -> %s", async (from, to) => {
    const cycle = await cycleAt(from);
    const moved = await json<CropCycle>(await transition(cycle.id, to), 200);
    expect(moved.status).toBe(to);
  });

  const forbidden: [CropCycleStatus, CropCycleStatus][] = [
    ["growing", "planned"],
    ["closed", "growing"],
    ["harvesting", "growing"],
    ["planned", "harvesting"],
    ["harvesting", "planned"],
    ["closed", "planned"],
  ];
  it.each(forbidden)("rejects %s -> %s with 409 invalid_transition", async (from, to) => {
    const cycle = await cycleAt(from);
    const body = await json<{ error: string; from: string; to: string }>(await transition(cycle.id, to), 409);
    expect(body).toEqual({ error: "invalid_transition", from, to });
    const row = await env.DB.prepare("SELECT status FROM farm_crop_cycles WHERE id = ?").bind(cycle.id).first();
    expect(row).toEqual({ status: from });
  });

  it("sets started_at when growing and ended_at when closed", async () => {
    const { unit } = await newUnit();
    const cycle = await newCycle(unit.id);
    const before = Date.now();
    const growing = await json<CropCycle>(await transition(cycle.id, "growing"), 200);
    expect(Date.parse(growing.started_at!)).toBeGreaterThanOrEqual(before);
    expect(growing.ended_at).toBeNull();
    const harvesting = await json<CropCycle>(await transition(cycle.id, "harvesting"), 200);
    expect(harvesting.started_at).toBe(growing.started_at);
    const closed = await json<CropCycle>(await transition(cycle.id, "closed"), 200);
    expect(closed.started_at).toBe(growing.started_at);
    expect(Date.parse(closed.ended_at!)).toBeGreaterThanOrEqual(Date.parse(growing.started_at!));
  });

  it("lets only one of two concurrent transitions from growing win", async () => {
    const cycle = await cycleAt("growing");
    const [a, b] = await Promise.all([transition(cycle.id, "harvesting"), transition(cycle.id, "closed")]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    const winner = (await (a.status === 200 ? a : b).json()) as CropCycle;
    const row = await env.DB.prepare("SELECT status FROM farm_crop_cycles WHERE id = ?").bind(cycle.id).first();
    expect(row).toEqual({ status: winner.status });
  });

  it("returns 404 for an unknown cycle and 400 for a bad body", async () => {
    expect((await transition("nope", "growing")).status).toBe(404);
    const cycle = await cycleAt("planned");
    expect((await send("POST", `/api/crop-cycles/${cycle.id}/transition`, { to: "fallow" })).status).toBe(400);
  });
});

describe("work orders linked to a crop cycle", () => {
  it("links a cycle of the same asset and inherits its unit", async () => {
    const { asset, unit } = await newUnit();
    const cycle = await newCycle(unit.id);
    const wo = await json<WorkOrder>(
      await send("POST", `/api/assets/${asset.id}/work-orders`, { title: "ใส่ปุ๋ย", crop_cycle_id: cycle.id }),
      201,
    );
    expect(wo).toMatchObject({ crop_cycle_id: cycle.id, unit_id: unit.id });
    const listed = await json<{ work_orders: WorkOrder[] }>(await send("GET", `/api/assets/${asset.id}/work-orders`), 200);
    expect(listed.work_orders[0]!.crop_cycle_id).toBe(cycle.id);
  });

  it("rejects a cycle from another asset with 400", async () => {
    const a = await newUnit();
    const b = await newUnit();
    const cycleOfB = await newCycle(b.unit.id);
    const body = await json<{ error: string }>(
      await send("POST", `/api/assets/${a.asset.id}/work-orders`, { title: "งาน", crop_cycle_id: cycleOfB.id }),
      400,
    );
    expect(body.error).toBe("crop_cycle_not_in_asset");
  });

  it("rejects a unit_id that is not the cycle's unit with 400", async () => {
    const { asset, unit } = await newUnit();
    const other = await json<AssetUnit>(
      await send("POST", `/api/assets/${asset.id}/units`, { name: "แปลง 2", unit_type: "plot", boundary: square }),
      201,
    );
    const cycle = await newCycle(unit.id);
    const body = await json<{ error: string }>(
      await send("POST", `/api/assets/${asset.id}/work-orders`, { title: "งาน", unit_id: other.id, crop_cycle_id: cycle.id }),
      400,
    );
    expect(body.error).toBe("unit_not_in_crop_cycle");
  });

  it("requires a token", async () => {
    const res = await app.request("/api/units/any/crop-cycles", {}, env);
    expect(res.status).toBe(401);
    expect((await app.request("/api/crop-cycles/any/transition", { method: "POST" }, env)).status).toBe(401);
  });
});

describe("migration 0001 on a database that already has data", () => {
  it("adds crop_cycle_id without losing existing rows", async () => {
    const legacy = await createTestEnv({ migrations: (f) => f.startsWith("0000_") });
    try {
      const db = legacy.env.DB;
      const now = Date.now();
      // Rows as they existed before 0001 (written with 0000 columns only).
      await db.batch([
        db.prepare("INSERT INTO assets (id, name, kind, created_at) VALUES ('a', 'สวนเดิม', 'farm', ?)").bind(now),
        db
          .prepare(
            "INSERT INTO asset_units (id, asset_id, name, unit_type, boundary_geojson, area_m2, created_at) VALUES ('u', 'a', 'แปลงเดิม', 'plot', ?, 10000, ?)",
          )
          .bind(JSON.stringify(square), now),
        db
          .prepare(
            "INSERT INTO work_orders (id, asset_id, unit_id, title, status, created_at, updated_at) VALUES ('w', 'a', 'u', 'งานเดิม', 'submitted', ?, ?)",
          )
          .bind(now, now),
        db
          .prepare(
            "INSERT INTO work_order_evidence (id, work_order_id, r2_key, lat, lng, uploaded_at, created_at) VALUES ('e', 'w', 'work-orders/w/e', 0.0001, 0.0001, ?, ?)",
          )
          .bind(now, now),
        db
          .prepare("INSERT INTO farm_crop_cycles (id, unit_id, crop, status, created_at) VALUES ('c', 'u', 'ทุเรียน', 'growing', ?)")
          .bind(now),
      ]);

      const applied = await applyMigrations(db, (f) => !f.startsWith("0000_"));
      expect(applied[0]).toBe("0001_crop_cycle_link.sql");

      const counts = await db
        .prepare(
          "SELECT (SELECT COUNT(*) FROM assets) a, (SELECT COUNT(*) FROM asset_units) u, (SELECT COUNT(*) FROM work_orders) w, (SELECT COUNT(*) FROM work_order_evidence) e, (SELECT COUNT(*) FROM farm_crop_cycles) c",
        )
        .first();
      expect(counts).toEqual({ a: 1, u: 1, w: 1, e: 1, c: 1 });
      expect(await db.prepare("SELECT title, status, crop_cycle_id FROM work_orders WHERE id = 'w'").first()).toEqual({
        title: "งานเดิม",
        status: "submitted",
        crop_cycle_id: null,
      });

      // The new column is usable through the API on the migrated database.
      const res = await app.request(
        "/api/assets/a/work-orders",
        {
          method: "POST",
          headers: { ...authHeader, "content-type": "application/json" },
          body: JSON.stringify({ title: "งานใหม่", crop_cycle_id: "c" }),
        },
        legacy.env,
      );
      expect(res.status).toBe(201);
      expect(((await res.json()) as WorkOrder).crop_cycle_id).toBe("c");
      const index = await db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'work_orders_crop_cycle_id_idx'")
        .first();
      expect(index).toEqual({ name: "work_orders_crop_cycle_id_idx" });
    } finally {
      await legacy.dispose();
    }
  });
});
