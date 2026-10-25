import { DAY_MS, type Asset, type AssetUnit, type CropCycle, type DisasterEvent, type Polygon, type WorkOrder } from "@owner-os/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fixtureJson from "../fixtures/demo-seed.json";
import type { Env } from "../src/env";
import { app } from "../src/index";
import { seedDemo, type DemoFixture } from "../src/seed/demo";
import { applyMigrations, authHeader, createTestEnv, TEST_API_TOKEN, type TestEnv } from "./d1";

type Created = { created_work_orders: WorkOrder[] };

let testEnv: TestEnv;
let env: Env;
let durian: Asset;
let plotA: AssetUnit; // has an open durian crop cycle
let plotB: AssetUnit; // no crop cycle
let cycleA: CropCycle;
let maize: Asset;

function send(method: "GET" | "POST", path: string, body?: unknown, targetEnv: Env = env) {
  return app.request(
    path,
    { method, headers: { ...authHeader, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) },
    targetEnv,
  );
}

async function json<T>(res: Response, status: number): Promise<T> {
  expect(res.status).toBe(status);
  return (await res.json()) as T;
}

// Fictional plot next to the demo durian plot.
const plotBBoundary: Polygon = {
  type: "Polygon",
  coordinates: [[[102.8362, 16.44], [102.8375, 16.44], [102.8375, 16.4413], [102.8362, 16.4413], [102.8362, 16.44]]],
};

beforeAll(async () => {
  testEnv = await createTestEnv();
  env = testEnv.env;
  const summary = await seedDemo((p, i) => app.request(p, i, env), { token: TEST_API_TOKEN, fixture: fixtureJson as DemoFixture });
  expect(summary.failures).toEqual([]);
  const { assets } = await json<{ assets: Asset[] }>(await send("GET", "/api/assets"), 200);
  durian = assets.find((a) => a.name.includes("ทุเรียน"))!;
  maize = assets.find((a) => a.name.includes("ข้าวโพด"))!;
  plotA = (await json<{ units: AssetUnit[] }>(await send("GET", `/api/assets/${durian.id}`), 200)).units[0]!;
  plotB = await json<AssetUnit>(
    await send("POST", `/api/assets/${durian.id}/units`, { name: "แปลงหมอนทอง โซน B", unit_type: "plot", boundary: plotBBoundary }),
    201,
  );
  cycleA = await json<CropCycle>(await send("POST", `/api/units/${plotA.id}/crop-cycles`, { crop: "ทุเรียน", template_key: "durian" }), 201);
}, 30_000);

afterAll(async () => {
  await testEnv?.dispose();
});

const countWorkOrders = async (where: string, ...binds: unknown[]) =>
  (await env.DB.prepare(`SELECT COUNT(*) n FROM work_orders WHERE ${where}`).bind(...binds).first<{ n: number }>())!.n;

async function floodEvent(units: AssetUnit[]): Promise<DisasterEvent> {
  return json<DisasterEvent>(
    await send("POST", `/api/assets/${durian.id}/disaster-events`, {
      event_type: "flood",
      occurred_at: new Date(Date.now() - 60_000).toISOString(),
      units: units.map((u) => ({ unit_id: u.id, damage_pct: 40 })),
    }),
    201,
  );
}

describe("POST /api/assets/:id/disaster-prep", () => {
  it("storm on the durian asset: 2 base tasks per plot + the durian extra on the plot with a durian cycle", async () => {
    const body = await json<Created>(await send("POST", `/api/assets/${durian.id}/disaster-prep`, { event_type: "storm" }), 201);
    const onA = body.created_work_orders.filter((w) => w.unit_id === plotA.id);
    const onB = body.created_work_orders.filter((w) => w.unit_id === plotB.id);
    expect(onA.map((w) => w.title)).toEqual([
      "[เตรียมรับมือพายุ/ลมแรง] โยงกิ่ง/ค้ำยันต้น",
      "[เตรียมรับมือพายุ/ลมแรง] เก็บวัสดุที่ปลิวได้",
      "[เตรียมรับมือพายุ/ลมแรง] ตัดแต่งทรงพุ่มลดแรงลม",
    ]);
    expect(onB.map((w) => w.title)).toEqual(["[เตรียมรับมือพายุ/ลมแรง] โยงกิ่ง/ค้ำยันต้น", "[เตรียมรับมือพายุ/ลมแรง] เก็บวัสดุที่ปลิวได้"]);
    for (const w of onA) expect(w).toMatchObject({ asset_id: durian.id, crop_cycle_id: cycleA.id, disaster_event_id: null, status: "open" });
    for (const w of onB) expect(w).toMatchObject({ crop_cycle_id: null, disaster_event_id: null });
  });

  it("limits to the given unit_ids and rejects a unit of another asset", async () => {
    const only = await json<Created>(await send("POST", `/api/assets/${durian.id}/disaster-prep`, { event_type: "fire", unit_ids: [plotB.id] }), 201);
    expect(only.created_work_orders.map((w) => [w.unit_id, w.title])).toEqual([[plotB.id, "[เตรียมรับมือไฟไหม้] ทำแนวกันไฟรอบแปลง"]]);

    const { units: maizeUnits } = await json<{ units: AssetUnit[] }>(await send("GET", `/api/assets/${maize.id}`), 200);
    const res = await send("POST", `/api/assets/${durian.id}/disaster-prep`, { event_type: "fire", unit_ids: [maizeUnits[0]!.id] });
    expect((await json<{ error: string }>(res, 400)).error).toBe("unit_not_in_asset");
    expect((await send("POST", `/api/assets/${durian.id}/disaster-prep`, { event_type: "meteor" })).status).toBe(400);
    expect((await send("POST", "/api/assets/nope/disaster-prep", { event_type: "fire" })).status).toBe(404);
  });
});

describe("POST /api/disaster-events/:id/recovery-tasks", () => {
  it("creates flood recovery tasks for both plots, with the durian extra, links and due dates", async () => {
    const event = await floodEvent([plotA, plotB]);
    const before = Date.now();
    const body = await json<Created>(await send("POST", `/api/disaster-events/${event.id}/recovery-tasks`), 201);
    const after = Date.now();

    const onA = body.created_work_orders.filter((w) => w.unit_id === plotA.id);
    const onB = body.created_work_orders.filter((w) => w.unit_id === plotB.id);
    expect(onA.map((w) => w.title)).toEqual([
      "[ฟื้นฟูหลังน้ำท่วม] ระบายน้ำออกจากแปลง",
      "[ฟื้นฟูหลังน้ำท่วม] ถ่ายรูปความเสียหายรายแปลง",
      "[ฟื้นฟูหลังน้ำท่วม] ตรวจรากเน่าและโรคหลังน้ำลด",
      "[ฟื้นฟูหลังน้ำท่วม] ตรวจโรครากเน่าโคนเน่า (ไฟทอฟธอรา)",
    ]);
    expect(onB).toHaveLength(3);
    for (const w of body.created_work_orders) expect(w).toMatchObject({ asset_id: durian.id, disaster_event_id: event.id, status: "open" });
    for (const w of onA) expect(w.crop_cycle_id).toBe(cycleA.id);
    for (const w of onB) expect(w.crop_cycle_id).toBeNull();

    const offsets = [0, 0, 3, 3];
    onA.forEach((w, i) => {
      const due = Date.parse(w.due_at!);
      expect(due).toBeGreaterThanOrEqual(before + offsets[i]! * DAY_MS - 1000);
      expect(due).toBeLessThanOrEqual(after + offsets[i]! * DAY_MS + 1000);
    });

    const detail = await json<DisasterEvent & { recovery_work_orders: WorkOrder[] }>(await send("GET", `/api/disaster-events/${event.id}`), 200);
    expect(detail.recovery_work_orders.map((w) => w.id).sort()).toEqual(body.created_work_orders.map((w) => w.id).sort());
  });

  it("runs once per event: a second call → 409 without new work orders", async () => {
    const event = await floodEvent([plotB]);
    await json(await send("POST", `/api/disaster-events/${event.id}/recovery-tasks`), 201);
    expect(await countWorkOrders("disaster_event_id = ?", event.id)).toBe(3);
    const again = await send("POST", `/api/disaster-events/${event.id}/recovery-tasks`);
    expect((await json<{ error: string }>(again, 409)).error).toBe("recovery_tasks_already_created");
    expect(await countWorkOrders("disaster_event_id = ?", event.id)).toBe(3);
  });

  it("two concurrent calls: one 201, one 409, and the tasks exist once", async () => {
    const event = await floodEvent([plotA, plotB]);
    const [a, b] = await Promise.all([
      send("POST", `/api/disaster-events/${event.id}/recovery-tasks`),
      send("POST", `/api/disaster-events/${event.id}/recovery-tasks`),
    ]);
    expect([a.status, b.status].sort()).toEqual([201, 409]);
    expect(await countWorkOrders("disaster_event_id = ?", event.id)).toBe(4 + 3);
  });

  it("returns 404 for an unknown event and 401 without a token", async () => {
    expect((await send("POST", "/api/disaster-events/nope/recovery-tasks")).status).toBe(404);
    expect((await app.request("/api/disaster-events/any/recovery-tasks", { method: "POST" }, env)).status).toBe(401);
    expect((await app.request("/api/assets/any/disaster-prep", { method: "POST" }, env)).status).toBe(401);
  });
});

describe("migration 0006 on a database with existing data", () => {
  it("adds the link columns without touching earlier rows", async () => {
    const legacy = await createTestEnv({ migrations: (f) => !f.startsWith("0006_") });
    try {
      const db = legacy.env.DB;
      const now = Date.now();
      await db.batch([
        db.prepare("INSERT INTO assets (id, name, kind, created_at) VALUES ('a', 'สวนเดิม', 'farm', ?)").bind(now),
        db
          .prepare("INSERT INTO asset_units (id, asset_id, name, unit_type, boundary_geojson, area_m2, created_at) VALUES ('u', 'a', 'แปลงเดิม', 'plot', '{}', 100, ?)")
          .bind(now),
        db
          .prepare("INSERT INTO work_orders (id, asset_id, unit_id, title, status, created_at, updated_at) VALUES ('w', 'a', 'u', 'งานเดิม', 'open', ?, ?)")
          .bind(now, now),
        db.prepare("INSERT INTO disaster_events (id, asset_id, event_type, occurred_at, created_at) VALUES ('e', 'a', 'storm', ?, ?)").bind(now, now),
        db.prepare("INSERT INTO disaster_event_units (event_id, unit_id, damage_bps) VALUES ('e', 'u', 3000)"),
      ]);
      expect(await applyMigrations(db, (f) => f.startsWith("0006_"))).toEqual(["0006_work_order_disaster_link.sql"]);
      expect(await db.prepare("SELECT title, disaster_event_id FROM work_orders").all().then((r) => r.results)).toEqual([
        { title: "งานเดิม", disaster_event_id: null },
      ]);
      expect(await db.prepare("SELECT recovery_tasks_created_at FROM disaster_events").first()).toEqual({ recovery_tasks_created_at: null });

      const created = await json<Created>(await send("POST", "/api/disaster-events/e/recovery-tasks", undefined, legacy.env), 201);
      expect(created.created_work_orders.map((w) => w.title)[0]).toBe("[ฟื้นฟูหลังพายุ/ลมแรง] ถ่ายรูปความเสียหายรายแปลง");
    } finally {
      await legacy.dispose();
    }
  });
});
