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
  /** Comma-separated owner emails (exact match only, no @domain wildcards) allowed to approve OAuth consent. */
  OWNER_EMAILS?: string;
  /** Comma-separated HTTPS redirect hosts (exact hostname match). */
  MCP_ALLOWED_REDIRECT_HOSTS?: string;
  /**
   * Explicit-port HTTP loopback redirects (localhost / 127.0.0.1 / [::1]) for native clients are accepted at DCR and
   * authorize only when exactly "true". Default "false".
   */
  MCP_ALLOW_LOOPBACK_REDIRECTS?: string;
  /** Dynamic client registration (/oauth/register) is accepted only when exactly "true". Default "false". */
  MCP_DCR_ENABLED?: string;
  /** HMAC key for one-time consent CSRF tokens (Worker secret). */
  CONSENT_CSRF_SECRET?: string;
};
