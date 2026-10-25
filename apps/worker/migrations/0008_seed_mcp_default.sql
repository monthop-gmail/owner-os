-- Seed the default MCP connector row (read-only). Idempotent; created_at = 2026-10-25T00:00:00Z.
INSERT OR IGNORE INTO `ai_clients` (`name`, `scopes`, `rate_per_minute`, `rate_per_day`, `revoked_at`, `created_at`) VALUES ('mcp-default', 'read', 60, 5000, NULL, 1792886400000);
