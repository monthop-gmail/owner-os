import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Env } from "../src/env";
import { app } from "../src/index";
import { createTestEnv, TEST_API_TOKEN, type TestEnv } from "./d1";

let testEnv: TestEnv;
let env: Env;

beforeAll(async () => {
  testEnv = await createTestEnv();
  env = testEnv.env;
});

afterAll(async () => {
  await testEnv?.dispose();
});

describe("GET /test-camera", () => {
  it("serves the HTML page without a token, with CSP and no-store", async () => {
    const res = await app.request("/test-camera", {}, env);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(res.headers.get("content-security-policy")).toBe(
      "default-src 'self'; img-src 'self' blob: data:; script-src 'self' 'unsafe-inline'; " +
        "style-src 'self' 'unsafe-inline'; connect-src 'self'",
    );
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("does not leak the configured API token", async () => {
    const body = await (await app.request("/test-camera", {}, env)).text();
    expect(env.API_TOKEN).toBe(TEST_API_TOKEN);
    expect(body).not.toContain(TEST_API_TOKEN);
  });

  it("contains the camera input and the upload flow", async () => {
    const body = await (await app.request("/test-camera", {}, env)).text();
    expect(body).toContain('capture="environment"');
    expect(body).toContain('type="password"');
    expect(body).toContain("/upload-ticket");
    expect(body).toContain("/complete");
    expect(body).toContain('"authorization": "Bearer "');
  });

  it("still requires a token for /api/*", async () => {
    const res = await app.request("/api/assets", { method: "POST" }, env);
    expect(res.status).toBe(401);
  });
});
