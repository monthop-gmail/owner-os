// Stateless MCP server over JSON-RPC 2.0 (POST /mcp, application/json responses only).
// Tools are read-only and call the existing Hono /api routes in-process with API_TOKEN,
// so the API token never reaches the AI client.
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
type Tool = {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: { readOnlyHint: true };
  scope: "read";
  /** Every internal path this tool builds must start with this prefix. */
  prefix: string;
  /** Returns the /api path (+ query) to GET, built only with apiPath/withQuery; null when the arguments are invalid. */
  path(args: Record<string, unknown>): string | null;
};

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
}): Tool {
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

async function callTool(tool: Tool, args: unknown, scopes: string[], env: Env): Promise<ToolOutcome> {
  if (!scopes.includes(tool.scope)) return toolError("insufficient_scope");
  if (args !== undefined && !isObject(args)) return toolError("validation_error");
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

/** Effective scopes = token scopes ∩ the `mcp-default` row's scopes, plus its rate limits; null when missing or revoked. */
async function clientGrant(env: Env, tokenScopes: string[]): Promise<ClientGrant | null> {
  const row = await env.DB.prepare(
    "SELECT scopes, revoked_at, rate_per_minute, rate_per_day FROM ai_clients WHERE name = ?",
  )
    .bind(MCP_DEFAULT_CLIENT)
    .first<{ scopes: string; revoked_at: number | null; rate_per_minute: number; rate_per_day: number }>();
  if (!row || row.revoked_at !== null) return null;
  const allowed = row.scopes.split(/\s+/).filter(Boolean);
  return {
    scopes: tokenScopes.filter((s) => allowed.includes(s)),
    ratePerMinute: row.rate_per_minute,
    ratePerDay: row.rate_per_day,
  };
}

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;

/**
 * Per-DCR-client limit counted from mcp_audit rows (index on client_id, at). This is read-then-decide,
 * not atomic: concurrent calls (and audit rows still pending in waitUntil) can overshoot slightly.
 */
async function rateLimitExceeded(env: Env, clientId: string, grant: ClientGrant): Promise<"per_minute" | "per_day" | null> {
  const now = Date.now();
  let row: { day: number; minute: number } | null;
  try {
    row = await env.DB.prepare(
      "SELECT COUNT(*) AS day, COALESCE(SUM(at > ?1), 0) AS minute FROM mcp_audit WHERE client_id = ?2 AND at > ?3",
    )
      .bind(now - MINUTE_MS, clientId, now - DAY_MS)
      .first<{ day: number; minute: number }>();
  } catch (err) {
    // Like audit writes, a broken audit table must not take the read-only tools down: fail open, but log.
    console.warn("mcp rate limit check failed", err instanceof Error ? err.message : "unknown");
    return null;
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
    const grant = await clientGrant(env, ctx.auth?.scope ?? []);
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
        const limited = await rateLimitExceeded(env, ctx.auth?.clientId ?? "", grant);
        const outcome = limited
          ? rateLimited(limited)
          : tool
            ? await callTool(tool, params.arguments, grant.scopes, env)
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
