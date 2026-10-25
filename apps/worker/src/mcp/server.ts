// Stateless MCP server over JSON-RPC 2.0 (POST /mcp, application/json responses only).
// Tools are read-only and call the existing Hono /api routes in-process with API_TOKEN,
// so the API token never reaches the AI client.
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
  /** Returns the /api path to GET, or null when the arguments are invalid. */
  path(args: Record<string, unknown>): string | null;
};

const TOOLS: Tool[] = [
  {
    name: "list_assets",
    title: "รายการสินทรัพย์",
    description: "List all assets (same fields as GET /api/assets).",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true },
    scope: "read",
    path: (args) => (Object.keys(args).length === 0 ? "/api/assets" : null),
  },
  {
    name: "get_asset",
    title: "รายละเอียดสินทรัพย์",
    description: "Get one asset with its units (same fields as GET /api/assets/:id).",
    inputSchema: {
      type: "object",
      properties: { asset_id: { type: "string", minLength: 1 } },
      required: ["asset_id"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
    scope: "read",
    path: (args) => {
      const keys = Object.keys(args);
      const id = args.asset_id;
      if (keys.length !== 1 || typeof id !== "string" || id.length === 0) return null;
      return `/api/assets/${encodeURIComponent(id)}`;
    },
  },
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

function toolError(code: string): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify({ error: code }) }], isError: true };
}

async function callTool(tool: Tool, args: unknown, scopes: string[], env: Env): Promise<ToolResult> {
  if (!scopes.includes(tool.scope)) return toolError("insufficient_scope");
  if (args !== undefined && !isObject(args)) return toolError("validation_error");
  const path = tool.path(args ?? {});
  if (!path) return toolError("validation_error");
  if (!env.API_TOKEN) return toolError("server_not_configured");
  try {
    const res = await app.request(path, { headers: { authorization: `Bearer ${env.API_TOKEN}` } }, env);
    const body: unknown = await res.json().catch(() => null);
    if (res.ok && body !== null) {
      return { content: [{ type: "text", text: JSON.stringify(body) }], structuredContent: body };
    }
    const code = isObject(body) && typeof body.error === "string" ? body.error : `upstream_${res.status}`;
    return toolError(code);
  } catch {
    return toolError("internal_error");
  }
}

/** Effective scopes = token scopes ∩ the `mcp-default` row's scopes; null when the row is missing or revoked. */
async function clientScopes(env: Env, tokenScopes: string[]): Promise<string[] | null> {
  const row = await env.DB.prepare("SELECT scopes, revoked_at FROM ai_clients WHERE name = ?")
    .bind(MCP_DEFAULT_CLIENT)
    .first<{ scopes: string; revoked_at: number | null }>();
  if (!row || row.revoked_at !== null) return null;
  const allowed = row.scopes.split(/\s+/).filter(Boolean);
  return tokenScopes.filter((s) => allowed.includes(s));
}

/** OAuthProvider adds `auth` (token scopes etc.) to the context it hands the API handler. */
type McpContext = ExecutionContext & { auth?: { scope?: string[] } };

/** OAuthProvider apiHandler: only reached with a valid access token for /mcp. */
export const mcpApiHandler = {
  async fetch(request: Request, env: Env, ctx: McpContext): Promise<Response> {
    const scopes = await clientScopes(env, ctx.auth?.scope ?? []);
    if (!scopes) {
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
        const tool = TOOLS.find((t) => t.name === params.name);
        if (!tool) return rpcError(id, -32602, `Unknown tool: ${String(params.name)}`);
        return rpcResult(id, await callTool(tool, params.arguments, scopes, env));
      }
      default:
        return rpcError(id, -32601, "Method not found");
    }
  },
};
