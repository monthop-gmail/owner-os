import { describe, expect, it } from "vitest";
import { app } from "../src/index";

describe("worker", () => {
  it("GET /health returns 200 with service info", async () => {
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, service: "owner-os-worker" });
  });

  it("unknown route returns 404", async () => {
    const res = await app.request("/nope");
    expect(res.status).toBe(404);
  });
});
