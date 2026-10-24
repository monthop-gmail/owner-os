import type { Asset, AssetUnit, Evidence, Polygon, WorkOrder } from "@owner-os/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Env } from "../src/env";
import { MAX_EVIDENCE_PER_WORK_ORDER } from "../src/routes/tasks";
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

// Fictional ~100 m × 100 m square at the equator; 1 m east ≈ 1 / 111_319.49 degrees of longitude.
const M = 1 / 111_319.49;
const D = 100 * M;
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
const INSIDE = { lng: D / 2, lat: D / 2 };
const eastBy = (m: number) => ({ lng: D + m * M, lat: D / 2 });

// Fake JPEG: just the SOI/APP0 marker bytes.
const FAKE_JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);
// Server checks captured_at against its own clock, so fixtures are relative to the real time.
const NOW = new Date(Date.now() - 60_000).toISOString();
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

async function request(method: string, path: string, body?: unknown, contentType = "application/json") {
  const init: RequestInit = { method, headers: authHeader };
  if (body !== undefined) {
    init.headers = { ...authHeader, "content-type": contentType };
    init.body = body instanceof Uint8Array || typeof body === "string" ? body : JSON.stringify(body);
  }
  return app.request(path, init, env);
}

async function json<T>(res: Response, status: number): Promise<T> {
  expect(res.status).toBe(status);
  return (await res.json()) as T;
}

/** Creates asset (+ optional unit) and an open work order. Fence is on the unit if present, else the asset. */
async function setup(opts: { fenceOn: "unit" | "asset" | "none" } = { fenceOn: "unit" }) {
  const asset = await json<Asset>(
    await request("POST", "/api/assets", {
      name: "สวนทดสอบ",
      kind: "farm",
      ...(opts.fenceOn === "asset" ? { boundary: square } : {}),
    }),
    201,
  );
  let unit: AssetUnit | undefined;
  if (opts.fenceOn === "unit") {
    unit = await json<AssetUnit>(
      await request("POST", `/api/assets/${asset.id}/units`, { name: "แปลง 1", unit_type: "plot", boundary: square }),
      201,
    );
  }
  const wo = await json<WorkOrder>(
    await request("POST", `/api/assets/${asset.id}/work-orders`, {
      title: "ใส่ปุ๋ย",
      ...(unit ? { unit_id: unit.id } : {}),
    }),
    201,
  );
  return { asset, unit, wo };
}

async function ticket(woId: string) {
  return json<{ evidence_id: string; upload_url: string }>(
    await request("POST", `/api/tasks/${woId}/upload-ticket`),
    201,
  );
}

async function ticketAndUpload(woId: string) {
  const t = await ticket(woId);
  const res = await request("PUT", t.upload_url, FAKE_JPEG, "image/jpeg");
  expect(res.status).toBe(204);
  return t;
}

function complete(woId: string, body: Record<string, unknown>) {
  return request("PUT", `/api/tasks/${woId}/complete`, body);
}

const fix = (evidenceId: string, at: { lng: number; lat: number }, accuracy_m = 5) => ({
  evidence_id: evidenceId,
  ...at,
  accuracy_m,
  captured_at: NOW,
});

describe("upload-ticket", () => {
  it("creates an evidence row with the expected r2_key", async () => {
    const { wo } = await setup();
    const t = await ticket(wo.id);
    expect(t.upload_url).toBe(`/api/tasks/${wo.id}/evidence/${t.evidence_id}`);
    const row = await env.DB.prepare("SELECT r2_key, uploaded_at FROM work_order_evidence WHERE id = ?")
      .bind(t.evidence_id)
      .first<{ r2_key: string; uploaded_at: number | null }>();
    expect(row).toEqual({ r2_key: `work-orders/${wo.id}/${t.evidence_id}`, uploaded_at: null });
  });

  it("returns 404 for an unknown work order", async () => {
    expect((await request("POST", "/api/tasks/nope/upload-ticket")).status).toBe(404);
  });
});

describe("PUT evidence", () => {
  it("rejects content-type text/plain with 415", async () => {
    const { wo } = await setup();
    const t = await ticket(wo.id);
    expect((await request("PUT", t.upload_url, "hello", "text/plain")).status).toBe(415);
  });

  it("rejects an empty body with 400", async () => {
    const { wo } = await setup();
    const t = await ticket(wo.id);
    expect((await request("PUT", t.upload_url, new Uint8Array(0), "image/png")).status).toBe(400);
  });

  it("rejects files over 10 MB with 413", async () => {
    const { wo } = await setup();
    const t = await ticket(wo.id);
    const big = new Uint8Array(10 * 1024 * 1024 + 1);
    expect((await request("PUT", t.upload_url, big, "image/jpeg")).status).toBe(413);
  });

  it("rejects a second upload with 409", async () => {
    const { wo } = await setup();
    const t = await ticketAndUpload(wo.id);
    expect((await request("PUT", t.upload_url, FAKE_JPEG, "image/jpeg")).status).toBe(409);
  });

  it("returns 404 when the evidence belongs to another work order", async () => {
    const a = await setup();
    const b = await setup();
    const tb = await ticket(b.wo.id);
    const res = await request("PUT", `/api/tasks/${a.wo.id}/evidence/${tb.evidence_id}`, FAKE_JPEG, "image/jpeg");
    expect(res.status).toBe(404);
  });
});

describe("PUT evidence on an inactive work order", () => {
  it("rejects an upload to a submitted work order with 409", async () => {
    const { wo } = await setup();
    const done = await ticketAndUpload(wo.id);
    const pending = await ticket(wo.id);
    expect((await complete(wo.id, fix(done.evidence_id, INSIDE))).status).toBe(200);

    expect((await request("PUT", pending.upload_url, FAKE_JPEG, "image/jpeg")).status).toBe(409);
    const row = await env.DB.prepare("SELECT uploaded_at FROM work_order_evidence WHERE id = ?")
      .bind(pending.evidence_id)
      .first();
    expect(row).toEqual({ uploaded_at: null });
    expect(await env.BUCKET.head(`work-orders/${wo.id}/${pending.evidence_id}`)).toBeNull();
  });

  it("lets only one of two concurrent uploads of the same evidence win", async () => {
    const { wo } = await setup();
    const t = await ticket(wo.id);
    const statuses = (
      await Promise.all([
        request("PUT", t.upload_url, FAKE_JPEG, "image/jpeg"),
        request("PUT", t.upload_url, FAKE_JPEG, "image/jpeg"),
      ])
    )
      .map((r) => r.status)
      .sort();
    expect(statuses).toEqual([204, 409]);
  });
});

describe("evidence limit", () => {
  it(`allows ${MAX_EVIDENCE_PER_WORK_ORDER} tickets per work order and rejects the next with 429`, async () => {
    expect(MAX_EVIDENCE_PER_WORK_ORDER).toBe(20);
    const { wo } = await setup();
    for (let i = 0; i < MAX_EVIDENCE_PER_WORK_ORDER; i++) {
      expect((await request("POST", `/api/tasks/${wo.id}/upload-ticket`)).status).toBe(201);
    }
    const body = await json<{ error: string }>(await request("POST", `/api/tasks/${wo.id}/upload-ticket`), 429);
    expect(body.error).toBe("evidence_limit");

    const other = await setup();
    expect((await request("POST", `/api/tasks/${other.wo.id}/upload-ticket`)).status).toBe(201);
  });
});

describe("PUT complete", () => {
  it("passes inside the unit fence: submitted + file in R2", async () => {
    const { wo } = await setup();
    const t = await ticketAndUpload(wo.id);
    const body = await json<{ work_order: WorkOrder; evidence: Evidence }>(
      await complete(wo.id, fix(t.evidence_id, INSIDE)),
      200,
    );
    expect(body.work_order.status).toBe("submitted");
    expect(body.evidence).toMatchObject({ inside_geofence: true, distance_outside_m: 0, captured_at: NOW });

    const obj = await env.BUCKET.get(`work-orders/${wo.id}/${t.evidence_id}`);
    expect(obj).not.toBeNull();
    expect(new Uint8Array(await obj!.arrayBuffer())).toEqual(FAKE_JPEG);
    expect(obj!.httpMetadata?.contentType).toBe("image/jpeg");

    const row = await env.DB.prepare(
      "SELECT lat, lng, accuracy_m, captured_at, inside_geofence, distance_outside_m FROM work_order_evidence WHERE id = ?",
    )
      .bind(t.evidence_id)
      .first();
    expect(row).toEqual({
      lat: INSIDE.lat,
      lng: INSIDE.lng,
      accuracy_m: 5,
      captured_at: Date.parse(NOW),
      inside_geofence: 1,
      distance_outside_m: 0,
    });
    const woRow = await env.DB.prepare("SELECT status FROM work_orders WHERE id = ?").bind(wo.id).first();
    expect(woRow).toEqual({ status: "submitted" });
  });

  it("passes 10 m outside (within buffer)", async () => {
    const { wo } = await setup();
    const t = await ticketAndUpload(wo.id);
    const body = await json<{ evidence: Evidence }>(await complete(wo.id, fix(t.evidence_id, eastBy(10))), 200);
    expect(body.evidence.inside_geofence).toBe(false);
    expect(body.evidence.distance_outside_m).toBeCloseTo(10, 0);

    const row = await env.DB.prepare(
      "SELECT inside_geofence, distance_outside_m FROM work_order_evidence WHERE id = ?",
    )
      .bind(t.evidence_id)
      .first<{ inside_geofence: number; distance_outside_m: number }>();
    expect(row?.inside_geofence).toBe(0);
    expect(row?.distance_outside_m).toBeCloseTo(10, 0);
  });

  it("fails 100 m outside with 422 and ~100 m distance, without touching the DB", async () => {
    const { wo } = await setup();
    const t = await ticketAndUpload(wo.id);
    const body = await json<{ error: string; distance_outside_m: number }>(
      await complete(wo.id, fix(t.evidence_id, eastBy(100))),
      422,
    );
    expect(body.error).toBe("outside_geofence");
    expect(Math.abs(body.distance_outside_m - 100)).toBeLessThanOrEqual(3);

    const woRow = await env.DB.prepare("SELECT status FROM work_orders WHERE id = ?").bind(wo.id).first();
    expect(woRow).toEqual({ status: "open" });
    const ev = await env.DB.prepare("SELECT lat, inside_geofence FROM work_order_evidence WHERE id = ?")
      .bind(t.evidence_id)
      .first();
    expect(ev).toEqual({ lat: null, inside_geofence: null });
  });

  it("does not widen the fence by accuracy: 10 m out @90 passes, 20 m out @90 fails", async () => {
    const a = await setup();
    const ta = await ticketAndUpload(a.wo.id);
    expect((await complete(a.wo.id, fix(ta.evidence_id, eastBy(10), 90))).status).toBe(200);

    const b = await setup();
    const tb = await ticketAndUpload(b.wo.id);
    const body = await json<{ error: string }>(await complete(b.wo.id, fix(tb.evidence_id, eastBy(20), 90)), 422);
    expect(body.error).toBe("outside_geofence");
  });

  it("rejects accuracy 500 with 422 accuracy_too_low", async () => {
    const { wo } = await setup();
    const t = await ticketAndUpload(wo.id);
    const body = await json<{ error: string }>(await complete(wo.id, fix(t.evidence_id, INSIDE, 500)), 422);
    expect(body.error).toBe("accuracy_too_low");
  });

  it("rejects evidence that was never uploaded with 422", async () => {
    const { wo } = await setup();
    const t = await ticket(wo.id);
    const body = await json<{ error: string }>(await complete(wo.id, fix(t.evidence_id, INSIDE)), 422);
    expect(body.error).toBe("evidence_not_uploaded");
  });

  it("returns 404 for evidence of another work order", async () => {
    const a = await setup();
    const b = await setup();
    const tb = await ticketAndUpload(b.wo.id);
    expect((await complete(a.wo.id, fix(tb.evidence_id, INSIDE))).status).toBe(404);
  });

  it("returns 409 when completing again after submitted", async () => {
    const { wo } = await setup();
    const t = await ticketAndUpload(wo.id);
    expect((await complete(wo.id, fix(t.evidence_id, INSIDE))).status).toBe(200);
    expect((await complete(wo.id, fix(t.evidence_id, INSIDE))).status).toBe(409);
    expect((await request("POST", `/api/tasks/${wo.id}/upload-ticket`)).status).toBe(409);
  });

  it("rejects client-supplied inside_geofence with 400", async () => {
    const { wo } = await setup();
    const t = await ticketAndUpload(wo.id);
    const res = await complete(wo.id, { ...fix(t.evidence_id, eastBy(100)), inside_geofence: true });
    expect(res.status).toBe(400);
  });

  it("uses the asset boundary when the work order has no unit", async () => {
    const { wo } = await setup({ fenceOn: "asset" });
    expect(wo.unit_id).toBeNull();
    const t = await ticketAndUpload(wo.id);
    expect((await complete(wo.id, fix(t.evidence_id, INSIDE))).status).toBe(200);

    const other = await setup({ fenceOn: "asset" });
    const to = await ticketAndUpload(other.wo.id);
    const body = await json<{ error: string }>(await complete(other.wo.id, fix(to.evidence_id, eastBy(100))), 422);
    expect(body.error).toBe("outside_geofence");
  });

  it("returns 422 no_geofence when neither unit nor asset has a boundary", async () => {
    const { wo } = await setup({ fenceOn: "none" });
    const t = await ticketAndUpload(wo.id);
    const body = await json<{ error: string }>(await complete(wo.id, fix(t.evidence_id, INSIDE)), 422);
    expect(body.error).toBe("no_geofence");
  });

  it("returns 404 for an unknown work order and 400 for malformed JSON", async () => {
    expect((await complete("nope", fix("x", INSIDE))).status).toBe(404);
    const { wo } = await setup();
    expect((await request("PUT", `/api/tasks/${wo.id}/complete`, "{", "application/json")).status).toBe(400);
  });

  it("lets only one of two concurrent completes win and leaves the loser's evidence untouched", async () => {
    const { wo } = await setup();
    const a = await ticketAndUpload(wo.id);
    const b = await ticketAndUpload(wo.id);
    const [ra, rb] = await Promise.all([
      complete(wo.id, fix(a.evidence_id, INSIDE)),
      complete(wo.id, fix(b.evidence_id, INSIDE)),
    ]);
    expect([ra.status, rb.status].sort()).toEqual([200, 409]);

    const loser = ra.status === 409 ? a : b;
    const row = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM work_order_evidence WHERE id = ? AND lat IS NULL AND inside_geofence IS NULL",
    )
      .bind(loser.evidence_id)
      .first<{ n: number }>();
    expect(row?.n).toBe(1);
    const woRow = await env.DB.prepare("SELECT status FROM work_orders WHERE id = ?").bind(wo.id).first();
    expect(woRow).toEqual({ status: "submitted" });
  });

  it("rejects captured_at more than 5 minutes in the future with 422", async () => {
    const { wo } = await setup();
    const t = await ticketAndUpload(wo.id);
    const future = new Date(Date.now() + 6 * MINUTE).toISOString();
    const body = await json<{ error: string }>(
      await complete(wo.id, { ...fix(t.evidence_id, INSIDE), captured_at: future }),
      422,
    );
    expect(body.error).toBe("captured_at_out_of_range");
  });

  it("rejects captured_at older than 24 hours with 422", async () => {
    const { wo } = await setup();
    const t = await ticketAndUpload(wo.id);
    const old = new Date(Date.now() - 25 * HOUR).toISOString();
    const body = await json<{ error: string }>(
      await complete(wo.id, { ...fix(t.evidence_id, INSIDE), captured_at: old }),
      422,
    );
    expect(body.error).toBe("captured_at_out_of_range");
  });

  it("accepts captured_at slightly in the future and 23 hours ago", async () => {
    const a = await setup();
    const ta = await ticketAndUpload(a.wo.id);
    const soon = new Date(Date.now() + 2 * MINUTE).toISOString();
    expect((await complete(a.wo.id, { ...fix(ta.evidence_id, INSIDE), captured_at: soon })).status).toBe(200);

    const b = await setup();
    const tb = await ticketAndUpload(b.wo.id);
    const earlier = new Date(Date.now() - 23 * HOUR).toISOString();
    expect((await complete(b.wo.id, { ...fix(tb.evidence_id, INSIDE), captured_at: earlier })).status).toBe(200);
  });
});
