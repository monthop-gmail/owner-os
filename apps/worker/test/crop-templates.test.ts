import { CROP_TEMPLATES, DAY_MS, TemplateKey, type Asset, type AssetUnit, type CropCycle, type CropCycleStatus, type Polygon, type WorkOrder } from "@owner-os/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CROP_TEMPLATE_KEYS } from "../src/db/schema";
import type { Env } from "../src/env";
import { app } from "../src/index";
import { applyMigrations, authHeader, createTestEnv, type TestEnv } from "./d1";

type TransitionResponse = CropCycle & { created_work_orders: WorkOrder[] };

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

function send(method: "GET" | "POST", path: string, body?: unknown, targetEnv: Env = env) {
  return app.request(
    path,
    {
      method,
      headers: { ...authHeader, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
    targetEnv,
  );
}

async function json<T>(res: Response, status: number): Promise<T> {
  expect(res.status).toBe(status);
  return (await res.json()) as T;
}

async function newCycle(templateKey?: string) {
  const asset = await json<Asset>(await send("POST", "/api/assets", { name: "ฟาร์มทดสอบ", kind: "farm" }), 201);
  const unit = await json<AssetUnit>(
    await send("POST", `/api/assets/${asset.id}/units`, { name: "แปลง 1", unit_type: "plot", boundary: square }),
    201,
  );
  const cycle = await json<CropCycle>(
    await send("POST", `/api/units/${unit.id}/crop-cycles`, {
      crop: "ทุเรียน",
      ...(templateKey === undefined ? {} : { template_key: templateKey }),
    }),
    201,
  );
  return { asset, unit, cycle };
}

const transition = (id: string, to: CropCycleStatus) => send("POST", `/api/crop-cycles/${id}/transition`, { to });

async function cycleWorkOrders(id: string): Promise<WorkOrder[]> {
  return (await json<{ work_orders: WorkOrder[] }>(await send("GET", `/api/crop-cycles/${id}/work-orders`), 200)).work_orders;
}

describe("crop cycle templates", () => {
  it("stores template_key and keeps the DB enum in sync with shared", async () => {
    expect([...CROP_TEMPLATE_KEYS]).toEqual(TemplateKey.options);
    const { cycle } = await newCycle("durian");
    expect(cycle.template_key).toBe("durian");
    const plain = await newCycle();
    expect(plain.cycle.template_key).toBeNull();
  });

  it("rejects an unknown template_key with 400", async () => {
    const { unit } = await newCycle();
    const res = await send("POST", `/api/units/${unit.id}/crop-cycles`, { crop: "มะม่วง", template_key: "mango" });
    expect(res.status).toBe(400);
  });

  it("durian planned→growing creates the 3 growing work orders linked to the unit and cycle", async () => {
    const { asset, unit, cycle } = await newCycle("durian");
    const before = Date.now();
    const body = await json<TransitionResponse>(await transition(cycle.id, "growing"), 200);
    const after = Date.now();

    expect(body.status).toBe("growing");
    const expected = CROP_TEMPLATES.durian.stages.growing;
    expect(body.created_work_orders.map((w) => w.title)).toEqual(expected.map((t) => t.title));
    const enteredAt = Date.parse(body.started_at!);
    expect(enteredAt).toBeGreaterThanOrEqual(before);
    expect(enteredAt).toBeLessThanOrEqual(after);
    body.created_work_orders.forEach((wo, i) => {
      expect(wo).toMatchObject({ asset_id: asset.id, unit_id: unit.id, crop_cycle_id: cycle.id, status: "open" });
      const dueMs = Date.parse(wo.due_at!);
      expect(Math.abs(dueMs - (enteredAt + expected[i]!.due_offset_days * DAY_MS))).toBeLessThanOrEqual(1000);
    });
    expect((await cycleWorkOrders(cycle.id)).map((w) => w.id).sort()).toEqual(body.created_work_orders.map((w) => w.id).sort());
  });

  it("growing→harvesting adds the 2 harvesting work orders (5 in total)", async () => {
    const { cycle } = await newCycle("durian");
    await json(await transition(cycle.id, "growing"), 200);
    const body = await json<TransitionResponse>(await transition(cycle.id, "harvesting"), 200);
    expect(body.created_work_orders.map((w) => w.title)).toEqual(
      CROP_TEMPLATES.durian.stages.harvesting.map((t) => t.title),
    );
    expect(await cycleWorkOrders(cycle.id)).toHaveLength(5);

    // harvesting→closed creates nothing more.
    const closed = await json<TransitionResponse>(await transition(cycle.id, "closed"), 200);
    expect(closed.created_work_orders).toEqual([]);
    expect(await cycleWorkOrders(cycle.id)).toHaveLength(5);
  });

  it("a cycle without a template creates no work orders", async () => {
    const { cycle } = await newCycle();
    const growing = await json<TransitionResponse>(await transition(cycle.id, "growing"), 200);
    const harvesting = await json<TransitionResponse>(await transition(cycle.id, "harvesting"), 200);
    expect(growing.created_work_orders).toEqual([]);
    expect(harvesting.created_work_orders).toEqual([]);
    expect(await cycleWorkOrders(cycle.id)).toEqual([]);
  });

  it("planned→closed creates no work orders", async () => {
    const { cycle } = await newCycle("maize");
    const body = await json<TransitionResponse>(await transition(cycle.id, "closed"), 200);
    expect(body.created_work_orders).toEqual([]);
    expect(await cycleWorkOrders(cycle.id)).toEqual([]);
  });

  it("two concurrent growing→harvesting: one wins and the harvesting work orders exist once", async () => {
    const { cycle } = await newCycle("melon");
    await json(await transition(cycle.id, "growing"), 200);
    const [a, b] = await Promise.all([transition(cycle.id, "harvesting"), transition(cycle.id, "harvesting")]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);

    const all = await cycleWorkOrders(cycle.id);
    const harvestingTitles = CROP_TEMPLATES.melon.stages.harvesting.map((t) => t.title);
    expect(all.filter((w) => harvestingTitles.includes(w.title))).toHaveLength(2);
    expect(all).toHaveLength(CROP_TEMPLATES.melon.stages.growing.length + 2);
  });

  it("returns 404 for the work orders of an unknown cycle", async () => {
    expect((await send("GET", "/api/crop-cycles/nope/work-orders")).status).toBe(404);
  });

  it("lists the templates", async () => {
    const body = await json<{ templates: { key: string; label: string }[] }>(await send("GET", "/api/crop-templates"), 200);
    expect(body.templates.map((t) => t.key)).toEqual(["durian", "maize", "melon"]);
    expect(body.templates[0]!.label).toBe("ทุเรียน (ไม้ผล)");
    expect((await app.request("/api/crop-templates", {}, env)).status).toBe(401);
  });
});

describe("migration 0002 on a database with 4.1a data", () => {
  it("adds template_key without losing cycles or linked work orders", async () => {
    const legacy = await createTestEnv({ migrations: (f) => !f.startsWith("0002_") });
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
          .prepare("INSERT INTO farm_crop_cycles (id, unit_id, crop, status, started_at, created_at) VALUES ('c', 'u', 'ทุเรียน', 'growing', ?, ?)")
          .bind(now, now),
        db
          .prepare(
            "INSERT INTO work_orders (id, asset_id, unit_id, crop_cycle_id, title, status, created_at, updated_at) VALUES ('w', 'a', 'u', 'c', 'งานเดิม', 'open', ?, ?)",
          )
          .bind(now, now),
      ]);

      expect(await applyMigrations(db, (f) => f.startsWith("0002_"))).toEqual(["0002_crop_template.sql"]);

      expect(await db.prepare("SELECT id, status, template_key FROM farm_crop_cycles").all().then((r) => r.results)).toEqual([
        { id: "c", status: "growing", template_key: null },
      ]);
      expect(await db.prepare("SELECT id, crop_cycle_id FROM work_orders").all().then((r) => r.results)).toEqual([
        { id: "w", crop_cycle_id: "c" },
      ]);

      // Old cycle without a template: transition still works and creates nothing.
      const res = await send("POST", "/api/crop-cycles/c/transition", { to: "harvesting" }, legacy.env);
      expect(res.status).toBe(200);
      expect(((await res.json()) as TransitionResponse).created_work_orders).toEqual([]);
    } finally {
      await legacy.dispose();
    }
  });
});
