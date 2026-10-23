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

function postAsset(headers: Record<string, string>, overrideEnv: Env = env) {
  return app.request(
    "/api/assets",
    {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ name: "สวนทดสอบ", kind: "farm" }),
    },
    overrideEnv,
  );
}

async function expectUnauthorized(res: Response) {
  expect(res.status).toBe(401);
  expect(res.headers.get("www-authenticate")).toBe("Bearer");
  expect(await res.json()).toEqual({ error: "unauthorized" });
}

describe("requireApiToken", () => {
  it("rejects a request without Authorization header", async () => {
    await expectUnauthorized(await postAsset({}));
  });

  it("rejects a wrong token of the same and of a different length", async () => {
    const sameLength = "x".repeat(TEST_API_TOKEN.length);
    await expectUnauthorized(await postAsset({ authorization: `Bearer ${sameLength}` }));
    await expectUnauthorized(await postAsset({ authorization: "Bearer short" }));
    await expectUnauthorized(await postAsset({ authorization: `Bearer ${TEST_API_TOKEN}extra` }));
  });

  it("rejects a non-Bearer scheme and an empty token", async () => {
    await expectUnauthorized(await postAsset({ authorization: `Basic ${TEST_API_TOKEN}` }));
    await expectUnauthorized(await postAsset({ authorization: "Bearer " }));
    await expectUnauthorized(await postAsset({ authorization: TEST_API_TOKEN }));
  });

  it("lets a correct token through", async () => {
    const res = await postAsset({ authorization: `Bearer ${TEST_API_TOKEN}` });
    expect(res.status).toBe(201);
  });

  it("guards every /api route, including tasks", async () => {
    const res = await app.request("/api/tasks/any/upload-ticket", { method: "POST" }, env);
    expect(res.status).toBe(401);
  });

  it("fails closed with 503 when API_TOKEN is not set", async () => {
    const { API_TOKEN: _omit, ...noToken } = env;
    const res = await postAsset({ authorization: `Bearer ${TEST_API_TOKEN}` }, noToken);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "auth_not_configured" });
  });

  it("fails closed with 503 when API_TOKEN is empty", async () => {
    const res = await postAsset({ authorization: "Bearer " }, { ...env, API_TOKEN: "" });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "auth_not_configured" });
  });

  it("keeps /health open without a header", async () => {
    const res = await app.request("/health", {}, env);
    expect(res.status).toBe(200);
  });
});
