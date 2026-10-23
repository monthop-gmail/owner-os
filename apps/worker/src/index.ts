import { Hono } from "hono";
import { requireApiToken } from "./auth";
import type { Env } from "./env";
import { assetsRoutes } from "./routes/assets";
import { tasksRoutes } from "./routes/tasks";

export const app = new Hono<{ Bindings: Env }>();

app.get("/health", (c) => c.json({ ok: true, service: "owner-os-worker" }));

app.use("/api/*", requireApiToken);
app.route("/api/assets", assetsRoutes);
app.route("/api/tasks", tasksRoutes);

export default app;
