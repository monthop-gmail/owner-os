import { Hono } from "hono";
import { requireApiToken } from "./auth";
import type { Env } from "./env";
import { assetsRoutes } from "./routes/assets";
import { evidenceRoutes } from "./routes/evidence";
import { tasksRoutes } from "./routes/tasks";
import { TEST_CAMERA_CSP, TEST_CAMERA_HTML } from "./test-camera";

export const app = new Hono<{ Bindings: Env }>();

app.get("/health", (c) => c.json({ ok: true, service: "owner-os-worker" }));

// Public page (no auth); the page itself sends the user-entered bearer token on every /api call.
app.get("/test-camera", (c) =>
  c.body(TEST_CAMERA_HTML, 200, {
    "content-type": "text/html; charset=utf-8",
    "content-security-policy": TEST_CAMERA_CSP,
    "cache-control": "no-store",
  }),
);

app.use("/api/*", requireApiToken);
app.route("/api/assets", assetsRoutes);
app.route("/api/tasks", tasksRoutes);
app.route("/api/evidence", evidenceRoutes);

export default app;
