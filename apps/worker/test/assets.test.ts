import type { Asset, AssetUnit, Polygon, WorkOrder } from "@owner-os/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Env } from "../src/env";
import { app } from "../src/index";
import { authHeader, createTestEnv, type TestEnv } from "./d1";

let testEnv: TestEnv;
let env: Env;

beforeAll(async () => {
  testEnv = await createTestEnv();
  env = testEnv.env;
});

afterAll(async () => {
  await testEnv?.dispose();
});

function post(path: string, body: unknown): Promise<Response> {
  return Promise.resolve(
    app.request(
      path,
      {
        method: "POST",
        headers: { ...authHeader, "content-type": "application/json" },
        body: typeof body === "string" ? body : JSON.stringify(body),
      },
      env,
    ),
  );
}

// Fictional ~100 m × 100 m square near the equator (0.000898° ≈ 100 m).
const D = 100 / 111_320;
const square: Polygon = {
  type: "Polygon",
  coordinates: [
    [
      [0, 0],
      [D, 0],
      [D, D],
      [0, D],
      [0, 0],
    ],
  ],
};

async function createAsset(name = "สวนทดสอบ"): Promise<Asset> {
  const res = await post("/api/assets", { name, kind: "farm" });
  expect(res.status).toBe(201);
  return (await res.json()) as Asset;
}

async function createUnit(assetId: string): Promise<AssetUnit> {
  const res = await post(`/api/assets/${assetId}/units`, { name: "แปลง 1", unit_type: "plot", boundary: square });
  expect(res.status).toBe(201);
  return (await res.json()) as AssetUnit;
}

describe("POST /api/assets", () => {
  it("creates an asset and it round-trips from D1", async () => {
    const res = await post("/api/assets", { name: "สวนทุเรียน", kind: "farm", boundary: square });
    expect(res.status).toBe(201);
    const asset = (await res.json()) as Asset;
    expect(asset).toMatchObject({ name: "สวนทุเรียน", kind: "farm", boundary: square });
    expect(new Date(asset.created_at).toISOString()).toBe(asset.created_at);

    const row = await env.DB.prepare("SELECT * FROM assets WHERE id = ?").bind(asset.id).first<{
      name: string;
      kind: string;
      boundary_geojson: string;
      created_at: number;
    }>();
    expect(row).not.toBeNull();
    expect(row?.name).toBe("สวนทุเรียน");
    expect(row?.kind).toBe("farm");
    expect(JSON.parse(row?.boundary_geojson ?? "null")).toEqual(square);
    expect(row?.created_at).toBe(Date.parse(asset.created_at));
  });

  it("creates an asset without boundary", async () => {
    const res = await post("/api/assets", { name: "บ้าน", kind: "property" });
    expect(res.status).toBe(201);
    expect(((await res.json()) as Asset).boundary).toBeNull();
  });

  it("rejects an invalid body with validation_error", async () => {
    const res = await post("/api/assets", { name: "", kind: "castle" });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; issues: unknown[] };
    expect(body.error).toBe("validation_error");
    expect(body.issues.length).toBeGreaterThan(0);
  });

  it("rejects malformed JSON with 400", async () => {
    const res = await post("/api/assets", "{not json");
    expect(res.status).toBe(400);
  });
});

describe("POST /api/assets/:id/units", () => {
  it("creates a unit with server-computed area (~10,000 m² ±1%)", async () => {
    const asset = await createAsset();
    const unit = await createUnit(asset.id);
    expect(unit.asset_id).toBe(asset.id);
    expect(unit.boundary).toEqual(square);
    expect(unit.area_m2).not.toBeNull();
    expect(Math.abs((unit.area_m2 ?? 0) - 10_000)).toBeLessThan(100);

    const row = await env.DB.prepare("SELECT area_m2 FROM asset_units WHERE id = ?")
      .bind(unit.id)
      .first<{ area_m2: number }>();
    expect(row?.area_m2).toBe(unit.area_m2);
  });

  it("rejects client-supplied area_m2 or id", async () => {
    const asset = await createAsset();
    const base = { name: "แปลง", unit_type: "plot", boundary: square };
    expect((await post(`/api/assets/${asset.id}/units`, { ...base, area_m2: 1 })).status).toBe(400);
    expect((await post(`/api/assets/${asset.id}/units`, { ...base, id: "mine" })).status).toBe(400);
  });

  it("rejects an unclosed polygon", async () => {
    const asset = await createAsset();
    const open = { type: "Polygon", coordinates: [[[0, 0], [D, 0], [D, D], [0, D]]] };
    const res = await post(`/api/assets/${asset.id}/units`, { name: "แปลง", unit_type: "plot", boundary: open });
    expect(res.status).toBe(400);
  });

  it("returns 404 for an unknown asset", async () => {
    const res = await post("/api/assets/does-not-exist/units", { name: "แปลง", unit_type: "plot", boundary: square });
    expect(res.status).toBe(404);
  });

  it("rejects malformed JSON with 400", async () => {
    const asset = await createAsset();
    expect((await post(`/api/assets/${asset.id}/units`, "{")).status).toBe(400);
  });
});

describe("POST /api/assets/:id/work-orders", () => {
  it("creates an open work order on a unit of the asset", async () => {
    const asset = await createAsset();
    const unit = await createUnit(asset.id);
    const due = "2026-11-01T00:00:00.000Z";
    const res = await post(`/api/assets/${asset.id}/work-orders`, { title: "ใส่ปุ๋ย", unit_id: unit.id, due_at: due });
    expect(res.status).toBe(201);
    const wo = (await res.json()) as WorkOrder;
    expect(wo).toMatchObject({ asset_id: asset.id, unit_id: unit.id, title: "ใส่ปุ๋ย", status: "open", due_at: due });

    const row = await env.DB.prepare("SELECT status, due_at, created_at, updated_at FROM work_orders WHERE id = ?")
      .bind(wo.id)
      .first<{ status: string; due_at: number; created_at: number; updated_at: number }>();
    expect(row?.status).toBe("open");
    expect(row?.due_at).toBe(Date.parse(due));
    expect(row?.updated_at).toBe(row?.created_at);
  });

  it("creates a work order without unit or due date", async () => {
    const asset = await createAsset();
    const res = await post(`/api/assets/${asset.id}/work-orders`, { title: "ตรวจรั้ว" });
    expect(res.status).toBe(201);
    expect((await res.json()) as WorkOrder).toMatchObject({ unit_id: null, due_at: null, status: "open" });
  });

  it("rejects a unit_id that belongs to another asset", async () => {
    const assetA = await createAsset("A");
    const assetB = await createAsset("B");
    const unitOfB = await createUnit(assetB.id);
    const res = await post(`/api/assets/${assetA.id}/work-orders`, { title: "งาน", unit_id: unitOfB.id });
    expect(res.status).toBe(400);
  });

  it("rejects client-supplied status", async () => {
    const asset = await createAsset();
    const res = await post(`/api/assets/${asset.id}/work-orders`, { title: "งาน", status: "verified" });
    expect(res.status).toBe(400);
  });

  it("returns 404 for an unknown asset", async () => {
    expect((await post("/api/assets/does-not-exist/work-orders", { title: "งาน" })).status).toBe(404);
  });

  it("rejects malformed JSON with 400", async () => {
    const asset = await createAsset();
    expect((await post(`/api/assets/${asset.id}/work-orders`, "]")).status).toBe(400);
  });
});
