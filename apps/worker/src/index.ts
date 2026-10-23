import { Hono } from "hono";
import type { Env } from "./env";
import { assetsRoutes } from "./routes/assets";

export const app = new Hono<{ Bindings: Env }>();

app.get("/health", (c) => c.json({ ok: true, service: "owner-os-worker" }));

app.route("/api/assets", assetsRoutes);

export default app;
