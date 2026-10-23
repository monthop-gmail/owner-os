import { Hono } from "hono";

type Env = {
  DB: D1Database;
  BUCKET: R2Bucket;
};

export const app = new Hono<{ Bindings: Env }>();

app.get("/health", (c) => c.json({ ok: true, service: "owner-os-worker" }));

export default app;
