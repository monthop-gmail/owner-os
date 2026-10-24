import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fixtureJson from "../fixtures/demo-seed.json";
import type { Env } from "../src/env";
import { app } from "../src/index";
import { planDemoSeed, seedDemo, tinyJpeg, type DemoFixture, type SeedSummary } from "../src/seed/demo";
import { createTestEnv, TEST_API_TOKEN, type TestEnv } from "./d1";

const fixture = fixtureJson as DemoFixture;

let testEnv: TestEnv;
let env: Env;

beforeAll(async () => {
  testEnv = await createTestEnv();
  env = testEnv.env;
});

afterAll(async () => {
  await testEnv?.dispose();
});

const fetchFn = (path: string, init: RequestInit) => app.request(path, init, env);

async function countRows(table: string, where = "1 = 1"): Promise<number> {
  const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`).first<{ n: number }>();
  return row?.n ?? 0;
}

describe("planDemoSeed (--dry-run)", () => {
  it("plans every request without writing anything", async () => {
    const steps = planDemoSeed(fixture);
    expect(steps.filter((s) => s.path === "/api/assets")).toHaveLength(4);
    expect(steps.filter((s) => s.path.endsWith("/units"))).toHaveLength(4);
    expect(steps.filter((s) => s.path.endsWith("/work-orders"))).toHaveLength(5);
    expect(steps.filter((s) => s.path.endsWith("/complete"))).toHaveLength(3);
    expect(await countRows("assets")).toBe(0);
    expect(await countRows("work_orders")).toBe(0);
  });
});

describe("seedDemo through the API on local D1/R2", () => {
  let summary: SeedSummary;

  beforeAll(async () => {
    summary = await seedDemo(fetchFn, { token: TEST_API_TOKEN, fixture, now: new Date() });
  }, 30_000);

  it("reports a clean summary", () => {
    expect(summary).toEqual({ assets: 4, units: 4, work_orders: 5, submitted: 3, failures: [] });
  });

  it("creates 4 assets and 4 units with server-computed area", async () => {
    expect(await countRows("assets")).toBe(4);
    expect(await countRows("asset_units")).toBe(4);
    const durian = await env.DB.prepare("SELECT area_m2 FROM asset_units WHERE name = ?")
      .bind("แปลงหมอนทอง โซน A")
      .first<{ area_m2: number }>();
    expect(Math.abs((durian?.area_m2 ?? 0) - 47_435) / 47_435).toBeLessThan(0.01);
  });

  it("creates 5 work orders: 3 submitted with in-fence evidence, 2 open", async () => {
    expect(await countRows("work_orders")).toBe(5);
    expect(await countRows("work_orders", "status = 'submitted'")).toBe(3);
    expect(await countRows("work_orders", "status = 'open'")).toBe(2);
    expect(await countRows("work_order_evidence")).toBe(3);
    expect(await countRows("work_order_evidence", "inside_geofence = 1 AND uploaded_at IS NOT NULL")).toBe(3);

    const keys = await env.DB.prepare("SELECT r2_key FROM work_order_evidence").all<{ r2_key: string }>();
    for (const { r2_key } of keys.results) {
      const obj = await env.BUCKET.get(r2_key);
      expect(new Uint8Array(await obj!.arrayBuffer())).toEqual(tinyJpeg());
    }
  });

  it("does not load the milestone 4 reference data", async () => {
    expect(await countRows("farm_crop_cycles")).toBe(0);
  });
});

describe("seedDemo failure handling", () => {
  it("stops at the first non-2xx response and reports it", async () => {
    let calls = 0;
    const result = await seedDemo(
      (path, init) => {
        calls++;
        return app.request(path, init, env);
      },
      { token: "wrong-token", fixture },
    );
    expect(calls).toBe(1);
    expect(result).toMatchObject({ assets: 0, units: 0, work_orders: 0, submitted: 0 });
    expect(result.failures).toEqual([{ path: "/api/assets", status: 401, error: "unauthorized" }]);
  });

  it("starts with an SOI marker and ends with EOI for the generated JPEG", () => {
    const jpeg = tinyJpeg();
    expect(Array.from(jpeg.slice(0, 2))).toEqual([0xff, 0xd8]);
    expect(Array.from(jpeg.slice(-2))).toEqual([0xff, 0xd9]);
  });
});
