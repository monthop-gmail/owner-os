import { defineConfig } from "vitest/config";

// Tests run in plain Node instead of @cloudflare/vitest-pool-workers: pool-workers 0.23.0 (latest)
// declares peer vitest ^4.1 and does not support the installed vitest 5. Route tests get a real
// local D1 from wrangler's getPlatformProxy (Miniflare, in-memory, no remote bindings) and apply
// the SQL in migrations/ before running — the database is never mocked.
export default defineConfig({
  test: {
    environment: "node",
  },
});
