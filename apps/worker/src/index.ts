import { Hono } from "hono";
import { requireApiToken } from "./auth";
import type { Env } from "./env";
import { createOAuthProvider, oauthRoutes } from "./mcp/oauth";
import { assetsRoutes } from "./routes/assets";
import { assetContractsRoutes, contractsRoutes } from "./routes/contracts";
import { cropCyclesRoutes, cropTemplatesRoutes, unitCropCyclesRoutes } from "./routes/crop-cycles";
import { assetDisasterRoutes, cycleDisasterRoutes, disasterEventsRoutes } from "./routes/disasters";
import { evidenceRoutes } from "./routes/evidence";
import { cycleHarvestLogsRoutes, harvestLogsRoutes } from "./routes/harvest-logs";
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

// OAuth consent for cloud AI connectors (behind Cloudflare Access). /api/* keeps API_TOKEN only.
app.route("/oauth", oauthRoutes);

app.use("/api/*", requireApiToken);
app.route("/api/assets", assetsRoutes);
app.route("/api/tasks", tasksRoutes);
app.route("/api/evidence", evidenceRoutes);
app.route("/api/units", unitCropCyclesRoutes);
app.route("/api/crop-cycles", cropCyclesRoutes);
app.route("/api/crop-templates", cropTemplatesRoutes);
app.route("/api/crop-cycles", cycleHarvestLogsRoutes);
app.route("/api/harvest-logs", harvestLogsRoutes);
app.route("/api/assets", assetContractsRoutes);
app.route("/api/contracts", contractsRoutes);
app.route("/api/assets", assetDisasterRoutes);
app.route("/api/disaster-events", disasterEventsRoutes);
app.route("/api/crop-cycles", cycleDisasterRoutes);

const defaultHandler = { fetch: (request: Request, env: Env, ctx: ExecutionContext) => app.fetch(request, env, ctx) };

// One OAuthProvider per isolate and origin (its resource URL is origin-specific). The provider
// receives env on every fetch; the only env value it captures is MCP_ALLOWED_REDIRECT_HOSTS (for
// the DCR callback), so that value is part of the cache key.
const MAX_CACHED_PROVIDERS = 16;
const providers = new Map<string, ReturnType<typeof createOAuthProvider>>();

export function getOAuthProvider(env: Env, origin: string): ReturnType<typeof createOAuthProvider> {
  const key = `${origin}\n${env.MCP_ALLOWED_REDIRECT_HOSTS ?? ""}`;
  let provider = providers.get(key);
  if (!provider) {
    if (providers.size >= MAX_CACHED_PROVIDERS) providers.clear();
    provider = createOAuthProvider(env, origin, defaultHandler);
    providers.set(key, provider);
  }
  return provider;
}

// OAuthProvider serves /oauth/token, /oauth/register and metadata, guards /mcp with OAuth tokens,
// and passes every other request to the Hono app unchanged.
export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return getOAuthProvider(env, new URL(request.url).origin).fetch(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
