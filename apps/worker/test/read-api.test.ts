import type { Asset, AssetUnit, WorkOrder } from "@owner-os/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fixtureJson from "../fixtures/demo-seed.json";
import type { Env } from "../src/env";
import { app } from "../src/index";
import type { EvidenceApi } from "../src/mappers";
import { seedDemo, tinyJpeg, type DemoFixture } from "../src/seed/demo";
import { authHeader, createTestEnv, TEST_API_TOKEN, type TestEnv } from "./d1";

type AssetListItem = Asset & {
  unit_count: number;
  work_order_counts: Record<"open" | "in_progress" | "submitted" | "verified" | "rejected", number>;
};
type PinEvidence = EvidenceApi & { asset_id: string; unit_id: string | null; work_order_title: string };

let testEnv: TestEnv;
let env: Env;
let assetsByName: Map<string, AssetListItem>;

const get = (path: string, headers: Record<string, string> = authHeader) => app.request(path, { headers }, env);

async function json<T>(path: string, status = 200): Promise<T> {
  const res = await get(path);
  expect(res.status).toBe(status);
  return (await res.json()) as T;
}

const DURIAN = "สวนทุเรียนนายหัวภูพาน (demo)";
const MELON = "มินิฟาร์มโรงเรือนเมล่อน (demo)";

beforeAll(async () => {
  testEnv = await createTestEnv();
  env = testEnv.env;
  const summary = await seedDemo((p, i) => app.request(p, i, env), {
    token: TEST_API_TOKEN,
    fixture: fixtureJson as DemoFixture,
    now: new Date(),
  });
  expect(summary.failures).toEqual([]);
  const { assets } = await json<{ assets: AssetListItem[] }>("/api/assets");
  assetsByName = new Map(assets.map((a) => [a.name, a]));
}, 30_000);

afterAll(async () => {
  await testEnv?.dispose();
});

describe("GET /api/assets", () => {
  it("lists the 4 seeded assets newest first with unit and work order counts", async () => {
    const { assets } = await json<{ assets: AssetListItem[] }>("/api/assets");
    expect(assets).toHaveLength(4);
    expect(assets.map((a) => a.name)).toEqual([
      "พูลวิลล่าปล่อยเช่า (demo)",
      MELON,
      "ไร่ข้าวโพดโมเดิร์นฟาร์ม (demo)",
      DURIAN,
    ]);
    expect(assetsByName.get(DURIAN)).toMatchObject({
      unit_count: 1,
      work_order_counts: { open: 1, in_progress: 0, submitted: 1, verified: 0, rejected: 0 },
    });
    expect(assetsByName.get(MELON)?.work_order_counts).toEqual({
      open: 1,
      in_progress: 0,
      submitted: 0,
      verified: 0,
      rejected: 0,
    });
    expect(new Date(assets[0]!.created_at).toISOString()).toBe(assets[0]!.created_at);
  });
});

describe("GET /api/assets/:id", () => {
  it("returns the asset with its units (GeoJSON boundary, server area)", async () => {
    const durian = assetsByName.get(DURIAN)!;
    const body = await json<{ asset: Asset; units: AssetUnit[] }>(`/api/assets/${durian.id}`);
    expect(body.asset).toMatchObject({ id: durian.id, name: DURIAN, kind: "farm" });
    expect(body.units).toHaveLength(1);
    expect(body.units[0]!.boundary.type).toBe("Polygon");
    expect(body.units[0]!.area_m2).toBeGreaterThan(47_000);
  });

  it("returns 404 for an unknown asset", async () => {
    expect((await get("/api/assets/nope")).status).toBe(404);
  });
});

describe("GET /api/assets/:id/work-orders", () => {
  it("lists and filters by status", async () => {
    const durian = assetsByName.get(DURIAN)!;
    const all = await json<{ work_orders: WorkOrder[] }>(`/api/assets/${durian.id}/work-orders`);
    expect(all.work_orders).toHaveLength(2);
    const submitted = await json<{ work_orders: WorkOrder[] }>(
      `/api/assets/${durian.id}/work-orders?status=submitted`,
    );
    expect(submitted.work_orders.map((w) => w.title)).toEqual(["พ่นปุ๋ยทางใบและฮอร์โมนขยายพูรอบที่ 2"]);
  });

  it("rejects an unknown status with 400 and an unknown asset with 404", async () => {
    const durian = assetsByName.get(DURIAN)!;
    expect((await get(`/api/assets/${durian.id}/work-orders?status=done`)).status).toBe(400);
    expect((await get("/api/assets/nope/work-orders")).status).toBe(404);
  });
});

describe("GET /api/tasks/:id", () => {
  it("returns 1 evidence for a submitted work order and 0 for an open one", async () => {
    const durian = assetsByName.get(DURIAN)!;
    const { work_orders } = await json<{ work_orders: WorkOrder[] }>(`/api/assets/${durian.id}/work-orders`);
    const submitted = work_orders.find((w) => w.status === "submitted")!;
    const open = work_orders.find((w) => w.status === "open")!;

    const s = await json<{ work_order: WorkOrder; evidence: EvidenceApi[] }>(`/api/tasks/${submitted.id}`);
    expect(s.work_order.id).toBe(submitted.id);
    expect(s.evidence).toHaveLength(1);
    expect(s.evidence[0]).toMatchObject({ work_order_id: submitted.id, inside_geofence: true, lat: 16.441 });

    const o = await json<{ evidence: EvidenceApi[] }>(`/api/tasks/${open.id}`);
    expect(o.evidence).toEqual([]);
  });

  it("does not list tickets that were never uploaded", async () => {
    const melon = assetsByName.get(MELON)!;
    const { work_orders } = await json<{ work_orders: WorkOrder[] }>(`/api/assets/${melon.id}/work-orders`);
    const wo = work_orders[0]!;
    const ticket = await app.request(`/api/tasks/${wo.id}/upload-ticket`, { method: "POST", headers: authHeader }, env);
    expect(ticket.status).toBe(201);
    expect((await json<{ evidence: EvidenceApi[] }>(`/api/tasks/${wo.id}`)).evidence).toEqual([]);
  });

  it("returns 404 for an unknown work order", async () => {
    expect((await get("/api/tasks/nope")).status).toBe(404);
  });
});

describe("GET /api/evidence", () => {
  it("lists the 3 uploaded evidence with coordinates and work order context", async () => {
    const { evidence } = await json<{ evidence: PinEvidence[] }>("/api/evidence");
    expect(evidence).toHaveLength(3);
    for (const e of evidence) {
      expect(e.lat).not.toBeNull();
      expect(e.lng).not.toBeNull();
      expect(e.work_order_title.length).toBeGreaterThan(0);
      expect(e.unit_id).not.toBeNull();
    }
  });

  it("filters by asset_id and honours limit", async () => {
    const durian = assetsByName.get(DURIAN)!;
    const filtered = await json<{ evidence: PinEvidence[] }>(`/api/evidence?asset_id=${durian.id}`);
    expect(filtered.evidence).toHaveLength(1);
    expect(filtered.evidence[0]!.asset_id).toBe(durian.id);
    expect((await json<{ evidence: PinEvidence[] }>("/api/evidence?limit=2")).evidence).toHaveLength(2);
    expect((await json<{ evidence: PinEvidence[] }>("/api/evidence?limit=500")).evidence).toHaveLength(3);
  });

  it("excludes evidence that was uploaded but failed the geofence (no coordinates)", async () => {
    const durian = assetsByName.get(DURIAN)!;
    const detail = await json<{ units: AssetUnit[] }>(`/api/assets/${durian.id}`);
    const send = (method: "POST" | "PUT", path: string, body?: BodyInit, contentType = "application/json") =>
      app.request(path, { method, headers: { ...authHeader, "content-type": contentType }, ...(body ? { body } : {}) }, env);

    const woRes = await send(
      "POST",
      `/api/assets/${durian.id}/work-orders`,
      JSON.stringify({ title: "ตรวจนอกแปลง", unit_id: detail.units[0]!.id }),
    );
    expect(woRes.status).toBe(201);
    const wo = (await woRes.json()) as WorkOrder;
    const ticket = (await (await send("POST", `/api/tasks/${wo.id}/upload-ticket`)).json()) as {
      evidence_id: string;
      upload_url: string;
    };
    expect((await send("PUT", ticket.upload_url, tinyJpeg(), "image/jpeg")).status).toBe(204);

    // ~1 km east of the durian plot (fictional point), so the fence check fails and nothing is written.
    const complete = await send(
      "PUT",
      `/api/tasks/${wo.id}/complete`,
      JSON.stringify({
        evidence_id: ticket.evidence_id,
        lat: 16.441,
        lng: 102.845,
        accuracy_m: 10,
        captured_at: new Date().toISOString(),
      }),
    );
    expect(complete.status).toBe(422);
    expect(((await complete.json()) as { error: string }).error).toBe("outside_geofence");

    // Uploaded (shows in task detail) but has no coordinates -> not a map pin.
    const task = await json<{ evidence: EvidenceApi[] }>(`/api/tasks/${wo.id}`);
    expect(task.evidence.map((e) => e.id)).toEqual([ticket.evidence_id]);
    expect(task.evidence[0]).toMatchObject({ lat: null, lng: null });

    const pins = await json<{ evidence: PinEvidence[] }>(`/api/evidence?limit=500`);
    expect(pins.evidence.map((e) => e.id)).not.toContain(ticket.evidence_id);
    const durianPins = await json<{ evidence: PinEvidence[] }>(`/api/evidence?asset_id=${durian.id}`);
    expect(durianPins.evidence.map((e) => e.id)).not.toContain(ticket.evidence_id);
  });

  it("rejects limit 600 (and non-numeric limits) with 400 instead of clamping", async () => {
    expect((await get("/api/evidence?limit=600")).status).toBe(400);
    expect((await get("/api/evidence?limit=0")).status).toBe(400);
    expect((await get("/api/evidence?limit=abc")).status).toBe(400);
  });
});

describe("GET /api/evidence/:id/image", () => {
  it("streams the uploaded JPEG with private caching", async () => {
    const { evidence } = await json<{ evidence: PinEvidence[] }>("/api/evidence?limit=1");
    const res = await get(`/api/evidence/${evidence[0]!.id}/image`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/jpeg");
    expect(res.headers.get("cache-control")).toBe("private, max-age=300");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(tinyJpeg());
  });

  it("returns 404 for unknown or not-yet-uploaded evidence", async () => {
    expect((await get("/api/evidence/nope/image")).status).toBe(404);
    const melon = assetsByName.get(MELON)!;
    const { work_orders } = await json<{ work_orders: WorkOrder[] }>(`/api/assets/${melon.id}/work-orders`);
    const t = await app.request(`/api/tasks/${work_orders[0]!.id}/upload-ticket`, { method: "POST", headers: authHeader }, env);
    const { evidence_id } = (await t.json()) as { evidence_id: string };
    expect((await get(`/api/evidence/${evidence_id}/image`)).status).toBe(404);
  });

  it("returns 404 when the R2 object is missing", async () => {
    const { evidence } = await json<{ evidence: PinEvidence[] }>("/api/evidence?limit=1");
    const res = await app.request(`/api/evidence/${evidence[0]!.id}/image`, { headers: authHeader }, {
      ...env,
      BUCKET: { get: () => Promise.resolve(null) } as unknown as R2Bucket,
    });
    expect(res.status).toBe(404);
  });
});

describe("auth on read routes", () => {
  it("returns 401 without a token on every new route", async () => {
    const durian = assetsByName.get(DURIAN)!;
    const paths = [
      "/api/assets",
      `/api/assets/${durian.id}`,
      `/api/assets/${durian.id}/work-orders`,
      "/api/tasks/any",
      "/api/evidence",
      "/api/evidence/any/image",
    ];
    for (const path of paths) {
      expect((await get(path, {})).status, path).toBe(401);
    }
  });
});
