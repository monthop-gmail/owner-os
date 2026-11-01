import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";

export type Env = {
  DB: D1Database;
  BUCKET: R2Bucket;
  /** Bearer token for /api/* (Worker secret; locally via .dev.vars). */
  API_TOKEN?: string;
  /** OAuth grants/tokens/clients for /mcp (workers-oauth-provider storage). */
  OAUTH_KV: KVNamespace;
  /** Injected by OAuthProvider before the default handler runs. */
  OAUTH_PROVIDER?: OAuthHelpers;
  /** Cloudflare Access team domain, e.g. `<team>.cloudflareaccess.com`. */
  ACCESS_TEAM_DOMAIN?: string;
  /** Cloudflare Access application audience tag protecting /oauth/authorize. */
  ACCESS_AUD?: string;
  /** Comma-separated owner emails or @domains allowed to approve OAuth consent. */
  OWNER_EMAILS?: string;
  /** Comma-separated HTTPS redirect hosts; HTTP is allowed only for explicit-port native-app loopback URIs. */
  MCP_ALLOWED_REDIRECT_HOSTS?: string;
  /** Dynamic client registration (/oauth/register) is accepted only when exactly "true". Default "false". */
  MCP_DCR_ENABLED?: string;
  /** HMAC key for one-time consent CSRF tokens (Worker secret). */
  CONSENT_CSRF_SECRET?: string;
};
