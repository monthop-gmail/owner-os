import { IdSchema } from "@owner-os/shared";
import { Hono, type Context } from "hono";
import { AI_DRAFT_STATUSES } from "../db/schema";
import type { Env } from "../env";
import { app } from "../index";

// Owner review of AI drafts (mounted at /api/ai-drafts, behind requireApiToken — MCP tokens never get here).
// Confirming runs the existing write route for the draft's kind; nothing is re-implemented here.

type AppContext = Context<{ Bindings: Env }>;
type DraftRow = {
  id: string;
  kind: "disaster_event" | "disaster_prep" | "recovery_tasks";
  asset_id: string;
  payload_json: string;
  status: (typeof AI_DRAFT_STATUSES)[number];
  created_at: number;
  created_by_client_id: string;
  decided_at: number | null;
  decision_note: string | null;
  result_ref: string | null;
};

const LIST_LIMIT = 200;
const MAX_NOTE_LENGTH = 500;

/** API view: payload parsed, timestamps ISO; the creator's user hash is not exposed. */
function draftToApi(row: DraftRow) {
  return {
    id: row.id,
    kind: row.kind,
    asset_id: row.asset_id,
    payload: JSON.parse(row.payload_json) as unknown,
    status: row.status,
    created_at: new Date(row.created_at).toISOString(),
    created_by_client_id: row.created_by_client_id,
    decided_at: row.decided_at === null ? null : new Date(row.decided_at).toISOString(),
    decision_note: row.decision_note,
    result_ref: row.result_ref,
  };
}

async function selectDraft(c: AppContext, id: string): Promise<DraftRow | null> {
  return c.env.DB.prepare("SELECT * FROM ai_drafts WHERE id = ?").bind(id).first<DraftRow>();
}

/** 404 when the draft does not exist, otherwise 409 (it was already decided). */
async function notPending(c: AppContext, id: string) {
  const row = await selectDraft(c, id);
  if (!row) return c.json({ error: "draft_not_found" }, 404);
  return c.json({ error: "draft_not_pending", status: row.status }, 409);
}

/** The existing write route (and body) that confirming a draft of this kind runs. */
function actionFor(row: DraftRow): { path: string; body: unknown } {
  const payload = JSON.parse(row.payload_json) as Record<string, unknown>;
  const asset = encodeURIComponent(row.asset_id);
  switch (row.kind) {
    case "disaster_event":
      return { path: `/api/assets/${asset}/disaster-events`, body: payload };
    case "disaster_prep":
      return { path: `/api/assets/${asset}/disaster-prep`, body: payload };
    case "recovery_tasks":
      return { path: `/api/disaster-events/${encodeURIComponent(String(payload.disaster_event_id))}/recovery-tasks`, body: {} };
  }
}

/** What the confirm created, stored in result_ref. */
function resultRef(row: DraftRow, body: Record<string, unknown>): string | null {
  switch (row.kind) {
    case "disaster_event":
      return typeof body.id === "string" ? body.id : null;
    case "recovery_tasks":
      return String((JSON.parse(row.payload_json) as { disaster_event_id: unknown }).disaster_event_id);
    case "disaster_prep": {
      const created = Array.isArray(body.created_work_orders) ? (body.created_work_orders as { id?: unknown }[]) : [];
      return JSON.stringify(created.map((w) => w.id));
    }
  }
}

export const aiDraftsRoutes = new Hono<{ Bindings: Env }>();

aiDraftsRoutes.get("/", async (c) => {
  const status = c.req.query("status");
  const assetId = c.req.query("asset_id");
  if (status !== undefined && !(AI_DRAFT_STATUSES as readonly string[]).includes(status)) {
    return c.json({ error: "validation_error", issues: [{ path: ["status"], message: `one of ${AI_DRAFT_STATUSES.join(", ")}` }] }, 400);
  }
  const asset = IdSchema.optional().safeParse(assetId);
  if (!asset.success) return c.json({ error: "validation_error", issues: asset.error.issues }, 400);

  const where: string[] = [];
  const binds: string[] = [];
  if (status !== undefined) {
    where.push("status = ?");
    binds.push(status);
  }
  if (asset.data !== undefined) {
    where.push("asset_id = ?");
    binds.push(asset.data);
  }
  const { results } = await c.env.DB.prepare(
    `SELECT * FROM ai_drafts ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at DESC, rowid DESC LIMIT ${LIST_LIMIT}`,
  )
    .bind(...binds)
    .all<DraftRow>();
  return c.json({ drafts: results.map(draftToApi) });
});

aiDraftsRoutes.post("/:id/confirm", async (c) => {
  const id = c.req.param("id");
  const now = Date.now();
  // Claim first: only one confirm can move pending → confirmed; a loser gets 409 and runs nothing.
  const claimed = await c.env.DB.prepare(
    "UPDATE ai_drafts SET status = 'confirmed', decided_at = ? WHERE id = ? AND status = 'pending' RETURNING *",
  )
    .bind(now, id)
    .first<DraftRow>();
  if (!claimed) return notPending(c, id);

  const action = actionFor(claimed);
  let res: Response;
  try {
    res = await app.request(
      action.path,
      {
        method: "POST",
        headers: { authorization: c.req.header("authorization") ?? "", "content-type": "application/json" },
        body: JSON.stringify(action.body),
      },
      c.env,
    );
  } catch (err) {
    await releaseClaim(c, id);
    throw err;
  }
  const body: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    // The data changed since the AI proposed it (or the draft no longer validates): back to pending,
    // and the owner sees the existing route's error unchanged.
    await releaseClaim(c, id);
    return c.json(body ?? { error: `upstream_${res.status}` }, res.status as 400);
  }

  const ref = resultRef(claimed, (body ?? {}) as Record<string, unknown>);
  await c.env.DB.prepare("UPDATE ai_drafts SET result_ref = ? WHERE id = ?").bind(ref, id).run();
  const row = await selectDraft(c, id);
  return c.json({ draft: draftToApi(row!), result: body });
});

async function releaseClaim(c: AppContext, id: string): Promise<void> {
  await c.env.DB.prepare("UPDATE ai_drafts SET status = 'pending', decided_at = NULL WHERE id = ? AND status = 'confirmed' AND result_ref IS NULL")
    .bind(id)
    .run();
}

/** Body `{ note? }` (or empty). Returns the note (null when absent) or undefined when the body is invalid. */
function parseRejectNote(text: string): string | null | undefined {
  if (text.trim() === "") return null;
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) return undefined;
  const { note, ...rest } = body as { note?: unknown };
  if (Object.keys(rest).length > 0) return undefined;
  if (note === undefined) return null;
  return typeof note === "string" && note.length >= 1 && note.length <= MAX_NOTE_LENGTH ? note : undefined;
}

aiDraftsRoutes.post("/:id/reject", async (c) => {
  const id = c.req.param("id");
  const note = parseRejectNote(await c.req.text());
  if (note === undefined) {
    return c.json({ error: "validation_error", issues: [{ path: ["note"], message: `optional string 1–${MAX_NOTE_LENGTH}` }] }, 400);
  }
  const rejected = await c.env.DB.prepare(
    "UPDATE ai_drafts SET status = 'rejected', decided_at = ?, decision_note = ? WHERE id = ? AND status = 'pending' RETURNING *",
  )
    .bind(Date.now(), note, id)
    .first<DraftRow>();
  if (!rejected) return notPending(c, id);
  return c.json({ draft: draftToApi(rejected) });
});
