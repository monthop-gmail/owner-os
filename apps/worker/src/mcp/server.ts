// Stateless MCP server over JSON-RPC 2.0 (POST /mcp, application/json responses only).
// Tools are read-only and call the existing Hono /api routes in-process with API_TOKEN,
// so the API token never reaches the AI client.
import { CreateDisasterEventInput, DisasterPrepInput, DisasterType } from "@owner-os/shared";
import { WORK_ORDER_STATUSES } from "../db/schema";
import type { Env } from "../env";
import { app } from "../index";

export const MCP_DEFAULT_CLIENT = "mcp-default";
export const SUPPORTED_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"] as const;
export const DEFAULT_PROTOCOL_VERSION = "2025-06-18";
export const SERVER_VERSION = "0.5.1";
export const INSTRUCTIONS =
  "owner-os: ข้อมูลสินทรัพย์/แปลง/งานของเจ้าของ · ตัวเลขเงินทั้งหมดเป็นร่าง draft_unconfirmed · พิกัดและรูปเป็นค่าที่ภาคสนามแจ้ง";

type JsonRpcId = string | number;
type JsonRpcRequest = { jsonrpc: "2.0"; id?: JsonRpcId; method: string; params?: unknown };
type ToolResult = { content: { type: "text"; text: string }[]; structuredContent?: unknown; isError?: boolean };
type ToolBase = {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: { readOnlyHint: boolean; destructiveHint?: boolean };
  /** `read`: reads/computes only. `draft`: inserts an ai_drafts row only (owner confirms elsewhere). */
  scope: "read" | "draft";
};
/** A plain read tool: one internal GET. */
type GetTool = ToolBase & {
  /** Every internal path this tool builds must start with this prefix. */
  prefix: string;
  /** Returns the /api path (+ query) to GET, built only with apiPath/withQuery; null when the arguments are invalid. */
  path(args: Record<string, unknown>): string | null;
};
/** A computed tool (settlement preview/what-if via internalPreviewPost) or a draft tool (ai_drafts insert only). */
type RunTool = ToolBase & {
  /** Strict argument check; null → validation_error before anything else happens. */
  parse(args: Record<string, unknown>): unknown;
  run(input: unknown, env: Env & { API_TOKEN: string }, auth: McpAuth | undefined): Promise<ToolOutcome>;
};
type Tool = GetTool | RunTool;

const WORK_ORDER_STATUS_VALUES: readonly string[] = WORK_ORDER_STATUSES;
const SAFE_SEGMENT = /^[A-Za-z0-9_-]{1,64}$/;

/** A path segment taken from tool arguments; validated by apiPath. */
class ArgSegment {
  constructor(readonly value: unknown) {}
}
const arg = (value: unknown) => new ArgSegment(value);

/**
 * Joins constant segments and argument segments into `/a/b/c`. Argument segments must match
 * SAFE_SEGMENT, so ".", "..", "/", "?", "%" and empty values can never reach the router.
 */
export function apiPath(...segments: (string | ArgSegment)[]): string | null {
  const parts: string[] = [];
  for (const seg of segments) {
    if (seg instanceof ArgSegment) {
      if (typeof seg.value !== "string" || !SAFE_SEGMENT.test(seg.value)) return null;
      parts.push(seg.value);
    } else {
      parts.push(seg);
    }
  }
  return `/${parts.join("/")}`;
}

/** Appends a query built with URLSearchParams from already-validated values (undefined entries skipped). */
function withQuery(path: string | null, query: Record<string, string | undefined>): string | null {
  if (path === null) return null;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) if (value !== undefined) params.set(key, value);
  const qs = params.toString();
  return qs ? `${path}?${qs}` : path;
}

/** The final path must survive URL parsing unchanged (no normalisation) and stay under the tool's prefix. */
export function isSafeInternalPath(path: string, prefix: string): boolean {
  let url: URL;
  try {
    url = new URL(path, "http://internal");
  } catch {
    return false;
  }
  if (url.origin !== "http://internal" || `${url.pathname}${url.search}` !== path) return false;
  return url.pathname === prefix || url.pathname.startsWith(`${prefix}/`);
}

/** Arguments may only contain these keys. */
function onlyKeys(args: Record<string, unknown>, allowed: string[]): boolean {
  return Object.keys(args).every((k) => allowed.includes(k));
}

/** A read tool taking exactly one required id argument `key`, which becomes a validated path segment. */
function idTool(spec: {
  name: string;
  title: string;
  description: string;
  key: string;
  prefix: string;
  path: (id: ArgSegment) => string | null;
}): GetTool {
  return {
    name: spec.name,
    title: spec.title,
    description: spec.description,
    inputSchema: {
      type: "object",
      properties: { [spec.key]: { type: "string", pattern: SAFE_SEGMENT.source } },
      required: [spec.key],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
    scope: "read",
    prefix: spec.prefix,
    path: (args) => (onlyKeys(args, [spec.key]) ? spec.path(arg(args[spec.key])) : null),
  };
}

// ---- Settlement preview / what-if (compute only; POST /api/contracts/:id/settlement-preview writes nothing) ----

const SETTLEMENT_PREVIEW_PATH = /^\/api\/contracts\/[A-Za-z0-9_-]{1,64}\/settlement-preview$/;
const DRAFT_NOTE =
  "ตัวเลขทั้งหมดเป็นร่าง draft_unconfirmed (กติกายังไม่ยืนยันจากเจ้าของ) · คำนวณเพื่อดูผลเท่านั้น ไม่มีการบันทึก settlement";

/**
 * The only internal non-GET request MCP may make: POST to exactly
 * /api/contracts/<safe id>/settlement-preview (checked by regex and isSafeInternalPath before sending).
 * Returns null — without any request — for any other path.
 */
export async function internalPreviewPost(
  path: string,
  body: Record<string, unknown>,
  env: Env & { API_TOKEN: string },
): Promise<Response | null> {
  if (!SETTLEMENT_PREVIEW_PATH.test(path) || !isSafeInternalPath(path, "/api/contracts")) return null;
  return app.request(
    path,
    {
      method: "POST",
      headers: { authorization: `Bearer ${env.API_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    },
    env,
  );
}

type PreviewCall = { ok: true; body: Record<string, unknown> } | { ok: false; error: string };

async function internalPreview(
  contractId: string,
  input: Record<string, unknown>,
  env: Env & { API_TOKEN: string },
): Promise<PreviewCall> {
  const path = apiPath("api", "contracts", arg(contractId), "settlement-preview");
  const res = path === null ? null : await internalPreviewPost(path, input, env);
  if (!res) return { ok: false, error: "validation_error" };
  const body: unknown = await res.json().catch(() => null);
  if (res.ok && isObject(body)) return { ok: true, body };
  return { ok: false, error: isObject(body) && typeof body.error === "string" ? body.error : `upstream_${res.status}` };
}

const isNum = (v: unknown, min = -Infinity, max = Infinity): v is number =>
  typeof v === "number" && Number.isFinite(v) && v >= min && v <= max;

const PREVIEW_NUMBER_FIELDS = [
  "revenue_thb",
  "opex_thb",
  "period_months",
  "turnovers",
  "repair_cost_thb",
  "damage_pct",
  "insurance_thb",
  "government_aid_thb",
] as const;
const PREVIEW_FIELDS = ["crop_cycle_id", ...PREVIEW_NUMBER_FIELDS, "jobs", "cancelled_jobs"];

function isJobList(v: unknown): boolean {
  return (
    Array.isArray(v) &&
    v.length <= 200 &&
    v.every((j) => isObject(j) && onlyKeys(j, ["job_key", "quantity"]) && typeof j.job_key === "string" && isNum(j.quantity))
  );
}

/**
 * Shape check for preview inputs (strict keys, primitive types). Contract-type rules (required fields,
 * ranges, decimals) stay with the route, so the tool reports the route's own error codes.
 */
function parsePreviewInput(v: unknown): Record<string, unknown> | null {
  if (!isObject(v) || !onlyKeys(v, PREVIEW_FIELDS)) return null;
  if (v.crop_cycle_id !== undefined && (typeof v.crop_cycle_id !== "string" || !SAFE_SEGMENT.test(v.crop_cycle_id))) return null;
  for (const key of PREVIEW_NUMBER_FIELDS) if (v[key] !== undefined && !isNum(v[key])) return null;
  for (const key of ["jobs", "cancelled_jobs"]) if (v[key] !== undefined && !isJobList(v[key])) return null;
  return { ...v };
}

const NUM = { type: "number" } as const;
const JOBS = {
  type: "array",
  items: {
    type: "object",
    properties: { job_key: { type: "string" }, quantity: { type: "number" } },
    required: ["job_key", "quantity"],
    additionalProperties: false,
  },
} as const;
const PREVIEW_PROPERTIES = {
  crop_cycle_id: { type: "string", pattern: SAFE_SEGMENT.source, description: "use the cycle's harvest-log revenue (instead of revenue_thb)" },
  revenue_thb: NUM,
  opex_thb: NUM,
  period_months: { type: "integer", minimum: 0 },
  jobs: JOBS,
  cancelled_jobs: JOBS,
  turnovers: { type: "integer", minimum: 0 },
  repair_cost_thb: NUM,
  damage_pct: { type: "number", minimum: 0, maximum: 100 },
  insurance_thb: NUM,
  government_aid_thb: NUM,
};

type WhatIfScenario = {
  label: string;
  revenue_change_pct?: number;
  opex_change_pct?: number;
  damage_pct?: number;
  insurance_thb?: number;
};
type WhatIfInput = { contract_id: string; base: Record<string, unknown>; scenarios: WhatIfScenario[] };

function parseScenario(v: unknown): WhatIfScenario | null {
  if (!isObject(v) || !onlyKeys(v, ["label", "revenue_change_pct", "opex_change_pct", "damage_pct", "insurance_thb"])) return null;
  const { label, revenue_change_pct, opex_change_pct, damage_pct, insurance_thb } = v;
  if (typeof label !== "string" || label.length < 1 || label.length > 60) return null;
  if (revenue_change_pct !== undefined && !isNum(revenue_change_pct, -100, 300)) return null;
  if (opex_change_pct !== undefined && !isNum(opex_change_pct, -100, 300)) return null;
  if (damage_pct !== undefined && !isNum(damage_pct, 0, 100)) return null;
  if (insurance_thb !== undefined && !isNum(insurance_thb, 0)) return null;
  return v as WhatIfScenario;
}

/** amount × (1 + pct/100), rounded to whole satang once. */
function adjustThb(thb: number, pct: number): number {
  return Math.round(Math.round(thb * 100) * (1 + pct / 100)) / 100;
}

/** Revenue the base preview actually used (the harvest logs' total when it was given a crop_cycle_id). */
function previewRevenueThb(body: Record<string, unknown>): number | undefined {
  const inflows = Array.isArray(body.inflows) ? (body.inflows as { key?: unknown; amount_thb?: unknown }[]) : [];
  const revenue = inflows.find((i) => i.key === "revenue")?.amount_thb;
  return typeof revenue === "number" ? revenue : undefined;
}

/** Builds one scenario's preview input from the base, or returns an error code for that scenario. */
function scenarioInputs(
  base: Record<string, unknown>,
  basePreview: Record<string, unknown>,
  sc: WhatIfScenario,
): { inputs: Record<string, unknown> } | { error: string } {
  const inputs: Record<string, unknown> = { ...base };
  if (sc.revenue_change_pct !== undefined) {
    let revenue = typeof base.revenue_thb === "number" ? base.revenue_thb : undefined;
    if (base.crop_cycle_id !== undefined) {
      // Send the cycle's real revenue as revenue_thb (never both). Damage the route took from the
      // cycle's disaster events is carried over so the scenario only changes what it says it changes.
      revenue = previewRevenueThb(basePreview);
      delete inputs.crop_cycle_id;
      const source = isObject(basePreview.source) ? basePreview.source : {};
      if (inputs.damage_pct === undefined && source.damage_from === "events" && typeof source.damage_pct === "number") {
        inputs.damage_pct = source.damage_pct;
      }
    }
    if (revenue === undefined) return { error: "revenue_not_applicable" };
    inputs.revenue_thb = adjustThb(revenue, sc.revenue_change_pct);
  }
  if (sc.opex_change_pct !== undefined) {
    if (typeof base.opex_thb !== "number") return { error: "opex_not_applicable" };
    inputs.opex_thb = adjustThb(base.opex_thb, sc.opex_change_pct);
  }
  if (sc.damage_pct !== undefined) inputs.damage_pct = sc.damage_pct;
  if (sc.insurance_thb !== undefined) inputs.insurance_thb = sc.insurance_thb;
  return { inputs };
}

function jsonResult(body: Record<string, unknown>): ToolOutcome {
  return { result: { content: [{ type: "text", text: JSON.stringify(body) }], structuredContent: body }, errorCode: null };
}

const settlementPreviewTool: RunTool = {
  name: "settlement_preview",
  title: "ร่างการแบ่งผลประโยชน์ตามสัญญา",
  description:
    "Preview how revenue would be split under one contract (same as POST /api/contracts/:id/settlement-preview). " +
    "Compute only — nothing is saved. Required fields depend on the contract type. ตัวเลขและกติกาทั้งหมดเป็นร่าง draft_unconfirmed",
  inputSchema: {
    type: "object",
    properties: { contract_id: { type: "string", pattern: SAFE_SEGMENT.source }, ...PREVIEW_PROPERTIES },
    required: ["contract_id"],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true },
  scope: "read",
  parse: (args) => {
    const { contract_id, ...rest } = args;
    if (typeof contract_id !== "string" || !SAFE_SEGMENT.test(contract_id)) return null;
    const input = parsePreviewInput(rest);
    return input && { contract_id, input };
  },
  run: async (parsed, env) => {
    const { contract_id, input } = parsed as { contract_id: string; input: Record<string, unknown> };
    const res = await internalPreview(contract_id, input, env);
    return res.ok ? jsonResult(res.body) : toolError(res.error);
  },
};

const settlementWhatIfTool: RunTool = {
  name: "settlement_what_if",
  title: "เทียบหลายสถานการณ์ (what-if)",
  description:
    "Compare up to 10 scenarios against a base settlement preview of one contract, e.g. price drops of 10/20/30% " +
    "(revenue_change_pct: -10, -20, -30) or a disaster with insurance. revenue/opex are scaled by (1 + pct/100) and " +
    "rounded to satang once. Compute only — nothing is saved. ตัวเลขและกติกาทั้งหมดเป็นร่าง draft_unconfirmed",
  inputSchema: {
    type: "object",
    properties: {
      contract_id: { type: "string", pattern: SAFE_SEGMENT.source },
      base: { type: "object", properties: PREVIEW_PROPERTIES, additionalProperties: false },
      scenarios: {
        type: "array",
        minItems: 1,
        maxItems: 10,
        items: {
          type: "object",
          properties: {
            label: { type: "string", minLength: 1, maxLength: 60 },
            revenue_change_pct: { type: "number", minimum: -100, maximum: 300 },
            opex_change_pct: { type: "number", minimum: -100, maximum: 300 },
            damage_pct: { type: "number", minimum: 0, maximum: 100 },
            insurance_thb: { type: "number", minimum: 0 },
          },
          required: ["label"],
          additionalProperties: false,
        },
      },
    },
    required: ["contract_id", "base", "scenarios"],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true },
  scope: "read",
  parse: (args): WhatIfInput | null => {
    if (!onlyKeys(args, ["contract_id", "base", "scenarios"])) return null;
    const { contract_id, base, scenarios } = args;
    if (typeof contract_id !== "string" || !SAFE_SEGMENT.test(contract_id)) return null;
    const baseInput = parsePreviewInput(base);
    if (!baseInput || !Array.isArray(scenarios) || scenarios.length < 1 || scenarios.length > 10) return null;
    const parsed = scenarios.map(parseScenario);
    if (parsed.some((sc) => sc === null)) return null;
    return { contract_id, base: baseInput, scenarios: parsed as WhatIfScenario[] };
  },
  run: async (parsed, env) => {
    const { contract_id, base, scenarios } = parsed as WhatIfInput;
    // At most 1 + 10 internal previews; the whole call is one tool call for audit and rate limit.
    const basePreview = await internalPreview(contract_id, base, env);
    if (!basePreview.ok) return toolError(basePreview.error);
    const results = [];
    for (const sc of scenarios) {
      const built = scenarioInputs(base, basePreview.body, sc);
      if ("error" in built) {
        results.push({ label: sc.label, error: built.error });
        continue;
      }
      const res = await internalPreview(contract_id, built.inputs, env);
      results.push(
        res.ok
          ? {
              label: sc.label,
              inputs_used: built.inputs,
              owner_payout_thb: res.body.owner_payout_thb,
              operator_payout_thb: res.body.operator_payout_thb,
              disaster_clause_applied: res.body.disaster_clause_applied,
            }
          : { label: sc.label, inputs_used: built.inputs, error: res.error },
      );
    }
    return jsonResult({ base: basePreview.body, scenarios: results, rules_status: "draft_unconfirmed", note: DRAFT_NOTE });
  },
};

// ---- Draft tools (scope `draft`): AI proposes, the owner confirms via /api/ai-drafts ----
// These only INSERT into ai_drafts (plus read queries); they never call the existing write routes.

export const MAX_PENDING_DRAFTS_PER_ASSET = 20;
const DRAFT_MESSAGE = "ร่างรอเจ้าของยืนยันในระบบ ยังไม่มีผลกับข้อมูลจริง";
const DRAFT_ANNOTATIONS = { readOnlyHint: false, destructiveHint: false };

type DraftKind = "disaster_event" | "disaster_prep" | "recovery_tasks";

/** Inserts a pending draft unless the asset already has MAX_PENDING_DRAFTS_PER_ASSET (one statement). */
async function insertDraft(
  env: Env,
  auth: McpAuth | undefined,
  kind: DraftKind,
  assetId: string,
  payload: unknown,
): Promise<ToolOutcome> {
  const id = crypto.randomUUID();
  const res = await env.DB.prepare(
    `INSERT INTO ai_drafts (id, kind, asset_id, payload_json, status, created_at, created_by_user_hash, created_by_client_id)
     SELECT ?1, ?2, ?3, ?4, 'pending', ?5, ?6, ?7
     WHERE (SELECT COUNT(*) FROM ai_drafts WHERE asset_id = ?3 AND status = 'pending') < ?8`,
  )
    .bind(id, kind, assetId, JSON.stringify(payload), Date.now(), auth?.userId ?? "", auth?.clientId ?? "", MAX_PENDING_DRAFTS_PER_ASSET)
    .run();
  if (res.meta.changes !== 1) return toolError("too_many_pending_drafts");
  return jsonResult({ draft_id: id, status: "pending", message: DRAFT_MESSAGE });
}

async function assetExists(env: Env, assetId: string): Promise<boolean> {
  return (await env.DB.prepare("SELECT 1 AS x FROM assets WHERE id = ?").bind(assetId).first()) !== null;
}

/** True when every id is a unit of the asset. */
async function unitsInAsset(env: Env, assetId: string, unitIds: string[]): Promise<boolean> {
  const unique = [...new Set(unitIds)];
  if (unique.length === 0) return true;
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM asset_units WHERE asset_id = ? AND id IN (${unique.map(() => "?").join(", ")})`,
  )
    .bind(assetId, ...unique)
    .first<{ n: number }>();
  return row?.n === unique.length;
}

const safeId = (v: unknown): v is string => typeof v === "string" && SAFE_SEGMENT.test(v);
const ID_PROP = { type: "string", pattern: SAFE_SEGMENT.source } as const;
const DISASTER_TYPE_PROP = { type: "string", enum: [...DisasterType.options] } as const;

const proposeDisasterEventTool: RunTool = {
  name: "propose_disaster_event",
  title: "เสนอร่างบันทึกเหตุภัย",
  description:
    "Propose recording a disaster event (affected units + damage %) for the owner to confirm. " +
    "Creates a pending draft only — no disaster event exists until the owner confirms. เสนอร่างให้เจ้าของยืนยัน (ไม่มีผลจนกว่าจะยืนยัน)",
  inputSchema: {
    type: "object",
    properties: {
      asset_id: ID_PROP,
      event_type: DISASTER_TYPE_PROP,
      occurred_at: { type: "string", format: "date-time" },
      ended_at: { type: "string", format: "date-time" },
      description: { type: "string", minLength: 1, maxLength: 1000 },
      units: {
        type: "array",
        minItems: 1,
        maxItems: 200,
        items: {
          type: "object",
          properties: {
            unit_id: ID_PROP,
            damage_pct: { type: "number", minimum: 0, maximum: 100 },
            note: { type: "string", minLength: 1, maxLength: 500 },
          },
          required: ["unit_id", "damage_pct"],
          additionalProperties: false,
        },
      },
    },
    required: ["asset_id", "event_type", "occurred_at", "units"],
    additionalProperties: false,
  },
  annotations: DRAFT_ANNOTATIONS,
  scope: "draft",
  parse: (args) => {
    const { asset_id, ...rest } = args;
    if (!safeId(asset_id)) return null;
    // Same zod schema as POST /api/assets/:id/disaster-events.
    const parsed = CreateDisasterEventInput.safeParse(rest);
    if (!parsed.success || !parsed.data.units.every((u) => safeId(u.unit_id))) return null;
    return { asset_id, payload: parsed.data };
  },
  run: async (input, env, auth) => {
    const { asset_id, payload } = input as { asset_id: string; payload: CreateDisasterEventInput };
    if (!(await assetExists(env, asset_id))) return toolError("asset_not_found");
    if (!(await unitsInAsset(env, asset_id, payload.units.map((u) => u.unit_id)))) return toolError("unit_not_in_asset");
    return insertDraft(env, auth, "disaster_event", asset_id, payload);
  },
};

const proposeDisasterPrepTool: RunTool = {
  name: "propose_disaster_prep",
  title: "เสนอร่างงานเตรียมรับมือภัย",
  description:
    "Propose preparation work orders for an expected disaster (all units of the asset, or unit_ids). " +
    "Creates a pending draft only — no work order exists until the owner confirms. เสนอร่างให้เจ้าของยืนยัน (ไม่มีผลจนกว่าจะยืนยัน)",
  inputSchema: {
    type: "object",
    properties: {
      asset_id: ID_PROP,
      event_type: DISASTER_TYPE_PROP,
      unit_ids: { type: "array", items: ID_PROP, minItems: 1, maxItems: 200, uniqueItems: true },
    },
    required: ["asset_id", "event_type"],
    additionalProperties: false,
  },
  annotations: DRAFT_ANNOTATIONS,
  scope: "draft",
  parse: (args) => {
    const { asset_id, ...rest } = args;
    if (!safeId(asset_id)) return null;
    // Same zod schema as POST /api/assets/:id/disaster-prep.
    const parsed = DisasterPrepInput.safeParse(rest);
    if (!parsed.success || !(parsed.data.unit_ids ?? []).every(safeId)) return null;
    return { asset_id, payload: parsed.data };
  },
  run: async (input, env, auth) => {
    const { asset_id, payload } = input as { asset_id: string; payload: { event_type: string; unit_ids?: string[] } };
    if (!(await assetExists(env, asset_id))) return toolError("asset_not_found");
    if (!(await unitsInAsset(env, asset_id, payload.unit_ids ?? []))) return toolError("unit_not_in_asset");
    return insertDraft(env, auth, "disaster_prep", asset_id, payload);
  },
};

const proposeRecoveryTasksTool: RunTool = {
  name: "propose_recovery_tasks",
  title: "เสนอร่างงานฟื้นฟูหลังภัย",
  description:
    "Propose recovery work orders for a recorded disaster event that has no recovery tasks yet. " +
    "Creates a pending draft only — no work order exists until the owner confirms. เสนอร่างให้เจ้าของยืนยัน (ไม่มีผลจนกว่าจะยืนยัน)",
  inputSchema: {
    type: "object",
    properties: { disaster_event_id: ID_PROP },
    required: ["disaster_event_id"],
    additionalProperties: false,
  },
  annotations: DRAFT_ANNOTATIONS,
  scope: "draft",
  parse: (args) => (onlyKeys(args, ["disaster_event_id"]) && safeId(args.disaster_event_id) ? { disaster_event_id: args.disaster_event_id } : null),
  run: async (input, env, auth) => {
    const { disaster_event_id } = input as { disaster_event_id: string };
    const event = await env.DB.prepare("SELECT asset_id, recovery_tasks_created_at FROM disaster_events WHERE id = ?")
      .bind(disaster_event_id)
      .first<{ asset_id: string; recovery_tasks_created_at: number | null }>();
    if (!event) return toolError("disaster_event_not_found");
    if (event.recovery_tasks_created_at !== null) return toolError("recovery_tasks_already_created");
    return insertDraft(env, auth, "recovery_tasks", event.asset_id, { disaster_event_id });
  },
};

const TOOLS: Tool[] = [
  {
    name: "list_assets",
    title: "รายการสินทรัพย์",
    description: "List all assets (same fields as GET /api/assets).",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true },
    scope: "read",
    prefix: "/api/assets",
    path: (args) => (onlyKeys(args, []) ? apiPath("api", "assets") : null),
  },
  {
    name: "get_asset",
    title: "รายละเอียดสินทรัพย์",
    description: "Get one asset with its units (same fields as GET /api/assets/:id).",
    inputSchema: {
      type: "object",
      properties: { asset_id: { type: "string", pattern: SAFE_SEGMENT.source } },
      required: ["asset_id"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
    scope: "read",
    prefix: "/api/assets",
    path: (args) => (onlyKeys(args, ["asset_id"]) ? apiPath("api", "assets", arg(args.asset_id)) : null),
  },
  {
    name: "list_work_orders",
    title: "งานของสินทรัพย์",
    description: "List work orders of one asset, optionally filtered by status (same fields as GET /api/assets/:id/work-orders).",
    inputSchema: {
      type: "object",
      properties: {
        asset_id: { type: "string", pattern: SAFE_SEGMENT.source },
        status: { type: "string", enum: [...WORK_ORDER_STATUSES] },
      },
      required: ["asset_id"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
    scope: "read",
    prefix: "/api/assets",
    path: (args) => {
      if (!onlyKeys(args, ["asset_id", "status"])) return null;
      const { status } = args;
      if (status !== undefined && (typeof status !== "string" || !WORK_ORDER_STATUS_VALUES.includes(status))) return null;
      return withQuery(apiPath("api", "assets", arg(args.asset_id), "work-orders"), { status });
    },
  },
  {
    name: "get_work_order",
    title: "รายละเอียดงาน",
    description:
      "Get one work order with its evidence metadata (same fields as GET /api/tasks/:id). Image files are not returned.",
    inputSchema: {
      type: "object",
      properties: { work_order_id: { type: "string", pattern: SAFE_SEGMENT.source } },
      required: ["work_order_id"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
    scope: "read",
    prefix: "/api/tasks",
    path: (args) => (onlyKeys(args, ["work_order_id"]) ? apiPath("api", "tasks", arg(args.work_order_id)) : null),
  },
  {
    name: "list_evidence",
    title: "หลักฐานภาคสนาม",
    description:
      "List uploaded proof-of-work evidence metadata, newest first (same fields as GET /api/evidence). " +
      "lat/lng/accuracy are as reported by the field device (ค่าที่ภาคสนามแจ้ง), not independently verified. Image files are not returned.",
    inputSchema: {
      type: "object",
      properties: {
        asset_id: { type: "string", pattern: SAFE_SEGMENT.source },
        limit: { type: "integer", minimum: 1, maximum: 100, default: 50 },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
    scope: "read",
    prefix: "/api/evidence",
    path: (args) => {
      if (!onlyKeys(args, ["asset_id", "limit"])) return null;
      const { asset_id, limit = 50 } = args;
      if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > 100) return null;
      if (asset_id !== undefined && (typeof asset_id !== "string" || !SAFE_SEGMENT.test(asset_id))) return null;
      return withQuery(apiPath("api", "evidence"), { asset_id, limit: String(limit) });
    },
  },
  idTool({
    name: "list_crop_cycles",
    title: "รอบปลูกของแปลง",
    description: "List crop cycles of one unit/plot (same fields as GET /api/units/:id/crop-cycles).",
    key: "unit_id",
    prefix: "/api/units",
    path: (id) => apiPath("api", "units", id, "crop-cycles"),
  }),
  idTool({
    name: "list_harvest_logs",
    title: "บันทึกผลผลิต",
    description:
      "List harvest logs of one crop cycle with totals (same fields as GET /api/crop-cycles/:id/harvest-logs). Weighing-slip images are not returned.",
    key: "crop_cycle_id",
    prefix: "/api/crop-cycles",
    path: (id) => apiPath("api", "crop-cycles", id, "harvest-logs"),
  }),
  idTool({
    name: "list_contracts",
    title: "สัญญาของสินทรัพย์",
    description:
      "List contracts of one asset (same fields as GET /api/assets/:id/contracts). ตัวเลขและกติกาทั้งหมดเป็นร่าง draft_unconfirmed",
    key: "asset_id",
    prefix: "/api/assets",
    path: (id) => apiPath("api", "assets", id, "contracts"),
  }),
  idTool({
    name: "list_disaster_events",
    title: "เหตุภัยของสินทรัพย์",
    description: "List disaster events of one asset (same fields as GET /api/assets/:id/disaster-events).",
    key: "asset_id",
    prefix: "/api/assets",
    path: (id) => apiPath("api", "assets", id, "disaster-events"),
  }),
  idTool({
    name: "get_disaster_impact",
    title: "ผลกระทบภัยต่อรอบปลูก",
    description: "Disaster impact on one crop cycle (same fields as GET /api/crop-cycles/:id/disaster-impact).",
    key: "crop_cycle_id",
    prefix: "/api/crop-cycles",
    path: (id) => apiPath("api", "crop-cycles", id, "disaster-impact"),
  }),
  settlementPreviewTool,
  settlementWhatIfTool,
  proposeDisasterEventTool,
  proposeDisasterPrepTool,
  proposeRecoveryTasksTool,
];

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRequest(value: unknown): value is JsonRpcRequest {
  if (!isObject(value) || value.jsonrpc !== "2.0" || typeof value.method !== "string") return false;
  if ("id" in value && typeof value.id !== "string" && typeof value.id !== "number") return false;
  return value.params === undefined || typeof value.params === "object";
}

function rpcResult(id: JsonRpcId, result: unknown): Response {
  return Response.json({ jsonrpc: "2.0", id, result });
}

function rpcError(id: JsonRpcId | null, code: number, message: string, status = 200): Response {
  return Response.json({ jsonrpc: "2.0", id, error: { code, message } }, { status });
}

type ToolOutcome = { result: ToolResult; errorCode: string | null };

function toolError(code: string): ToolOutcome {
  return { result: { content: [{ type: "text", text: JSON.stringify({ error: code }) }], isError: true }, errorCode: code };
}

function rateLimited(window: "per_minute" | "per_day"): ToolOutcome {
  const message = window === "per_minute" ? "rate limit exceeded (per minute)" : "rate limit exceeded (per day)";
  return {
    result: { content: [{ type: "text", text: JSON.stringify({ error: "rate_limited", window, message }) }], isError: true },
    errorCode: "rate_limited",
  };
}

/** Internal read request: always GET with the server-side API_TOKEN; tools cannot choose the method. */
function internalGet(path: string, env: Env & { API_TOKEN: string }): Promise<Response> {
  return Promise.resolve(app.request(path, { method: "GET", headers: { authorization: `Bearer ${env.API_TOKEN}` } }, env));
}

async function callTool(
  tool: Tool,
  args: unknown,
  scopes: string[],
  env: Env,
  auth: McpAuth | undefined,
): Promise<ToolOutcome> {
  if (!scopes.includes(tool.scope)) return toolError("insufficient_scope");
  if (args !== undefined && !isObject(args)) return toolError("validation_error");
  if ("run" in tool) {
    const input = tool.parse(args ?? {});
    if (input === null) return toolError("validation_error");
    // Draft tools never call /api, so only read tools need API_TOKEN.
    const apiToken = env.API_TOKEN ?? "";
    if (tool.scope === "read" && !apiToken) return toolError("server_not_configured");
    try {
      return await tool.run(input, { ...env, API_TOKEN: apiToken }, auth);
    } catch {
      return toolError("internal_error");
    }
  }
  const path = tool.path(args ?? {});
  if (path === null || !isSafeInternalPath(path, tool.prefix)) return toolError("validation_error");
  const token = env.API_TOKEN;
  if (!token) return toolError("server_not_configured");
  try {
    const res = await internalGet(path, { ...env, API_TOKEN: token });
    const body: unknown = await res.json().catch(() => null);
    if (res.ok && body !== null) {
      return { result: { content: [{ type: "text", text: JSON.stringify(body) }], structuredContent: body }, errorCode: null };
    }
    return toolError(isObject(body) && typeof body.error === "string" ? body.error : `upstream_${res.status}`);
  } catch {
    return toolError("internal_error");
  }
}

type McpAuth = { scope?: string[]; userId?: string; clientId?: string };

/** One mcp_audit row per tools/call: no arguments, results or emails are stored. Never fails the call. */
async function writeAudit(
  env: Env,
  auth: McpAuth | undefined,
  entry: { tool: string; errorCode: string | null; ms: number },
): Promise<void> {
  try {
    await env.DB.prepare(
      "INSERT INTO mcp_audit (id, at, user_hash, client_id, tool, ok, error_code, ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    )
      .bind(
        crypto.randomUUID(),
        Date.now(),
        auth?.userId ?? "",
        auth?.clientId ?? "",
        entry.tool,
        entry.errorCode === null ? 1 : 0,
        entry.errorCode,
        entry.ms,
      )
      .run();
  } catch (err) {
    console.warn("mcp_audit write failed", err instanceof Error ? err.message : "unknown");
  }
}

type ClientGrant = { scopes: string[]; ratePerMinute: number; ratePerDay: number };

type ClientRow = { scopes: string; revoked_at: number | null; rate_per_minute: number; rate_per_day: number };

const rowScopes = (row: ClientRow) => row.scopes.split(/[\s,]+/).filter(Boolean);

/**
 * Effective scopes = token ∩ the global `mcp-default` row ∩ this DCR client's own row; rate limits come from
 * the client row. Fail-closed: null when either row is missing or revoked (never falls back to the global row).
 */
async function clientGrant(env: Env, tokenScopes: string[], clientId: string | undefined): Promise<ClientGrant | null> {
  if (!clientId) return null;
  const select = "SELECT scopes, revoked_at, rate_per_minute, rate_per_day FROM ai_clients WHERE ";
  const [global, client] = await env.DB.batch<ClientRow>([
    env.DB.prepare(`${select}name = ? AND client_id IS NULL`).bind(MCP_DEFAULT_CLIENT),
    env.DB.prepare(`${select}client_id = ?`).bind(clientId),
  ]);
  const g = global?.results[0];
  const c = client?.results[0];
  if (!g || g.revoked_at !== null || !c || c.revoked_at !== null) return null;
  const globalScopes = rowScopes(g);
  const clientScopes = rowScopes(c);
  return {
    scopes: tokenScopes.filter((s) => globalScopes.includes(s) && clientScopes.includes(s)),
    ratePerMinute: c.rate_per_minute,
    ratePerDay: c.rate_per_day,
  };
}

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;

/**
 * Per-DCR-client limit counted from mcp_audit rows (index on client_id, at). This is read-then-decide,
 * not atomic: concurrent calls (and audit rows still pending in waitUntil) can overshoot slightly.
 */
async function rateLimitExceeded(
  env: Env,
  clientId: string,
  grant: ClientGrant,
): Promise<"per_minute" | "per_day" | "unavailable" | null> {
  const now = Date.now();
  let row: { day: number; minute: number } | null;
  try {
    row = await env.DB.prepare(
      "SELECT COUNT(*) AS day, COALESCE(SUM(at > ?1), 0) AS minute FROM mcp_audit WHERE client_id = ?2 AND at > ?3",
    )
      .bind(now - MINUTE_MS, clientId, now - DAY_MS)
      .first<{ day: number; minute: number }>();
  } catch (err) {
    // The caller decides: read tools fail open (like audit writes), draft tools fail closed.
    console.warn("mcp rate limit check failed", err instanceof Error ? err.message : "unknown");
    return "unavailable";
  }
  if ((row?.minute ?? 0) >= grant.ratePerMinute) return "per_minute";
  if ((row?.day ?? 0) >= grant.ratePerDay) return "per_day";
  return null;
}

/** OAuthProvider adds `auth` (token scopes, grant userId, DCR clientId) to the context it hands the API handler. */
type McpContext = ExecutionContext & { auth?: McpAuth };

/** OAuthProvider apiHandler: only reached with a valid access token for /mcp. */
export const mcpApiHandler = {
  async fetch(request: Request, env: Env, ctx: McpContext): Promise<Response> {
    const grant = await clientGrant(env, ctx.auth?.scope ?? [], ctx.auth?.clientId);
    if (!grant) {
      return Response.json(
        { error: "client_revoked" },
        { status: 401, headers: { "WWW-Authenticate": 'Bearer error="invalid_token"' } },
      );
    }
    if (request.method !== "POST") {
      return Response.json({ error: "method_not_allowed" }, { status: 405, headers: { allow: "POST" } });
    }

    let message: unknown;
    try {
      message = JSON.parse(await request.text());
    } catch {
      return rpcError(null, -32700, "Parse error", 400);
    }
    if (Array.isArray(message)) return rpcError(null, -32600, "Batch requests are not supported", 400);
    if (!isRequest(message)) return rpcError(null, -32600, "Invalid Request", 400);

    // Notifications (no id) get no JSON-RPC response.
    if (message.id === undefined) return new Response(null, { status: 202 });
    const { id, method } = message;
    const params = isObject(message.params) ? message.params : {};

    switch (method) {
      case "initialize": {
        const requested = params.protocolVersion;
        const protocolVersion = SUPPORTED_PROTOCOL_VERSIONS.find((v) => v === requested) ?? DEFAULT_PROTOCOL_VERSION;
        return rpcResult(id, {
          protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: "owner-os", version: SERVER_VERSION },
          instructions: INSTRUCTIONS,
        });
      }
      case "ping":
        return rpcResult(id, {});
      case "tools/list":
        return rpcResult(id, {
          tools: TOOLS.map(({ name, title, description, inputSchema, annotations }) => ({
            name,
            title,
            description,
            inputSchema,
            annotations,
          })),
        });
      case "tools/call": {
        const started = Date.now();
        const tool = TOOLS.find((t) => t.name === params.name);
        // The AI-supplied name is only stored when it is one of ours.
        const check = await rateLimitExceeded(env, ctx.auth?.clientId ?? "", grant);
        // Read tools fail open when the limit cannot be checked; draft tools fail closed (no draft is stored).
        const limited = check === "unavailable" ? (tool?.scope === "draft" ? check : null) : check;
        const outcome =
          limited === "unavailable"
            ? toolError("rate_check_unavailable")
            : limited
              ? rateLimited(limited)
              : tool
                ? await callTool(tool, params.arguments, grant.scopes, env, ctx.auth)
                : null;
        const audit = writeAudit(env, ctx.auth, {
          tool: tool?.name ?? "(unknown)",
          errorCode: outcome ? outcome.errorCode : "unknown_tool",
          ms: Date.now() - started,
        });
        if (typeof ctx.waitUntil === "function") ctx.waitUntil(audit);
        else await audit;
        if (!outcome) return rpcError(id, -32602, "Unknown tool");
        return rpcResult(id, outcome.result);
      }
      default:
        return rpcError(id, -32601, "Method not found");
    }
  },
};
