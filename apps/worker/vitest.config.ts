import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Tests run in plain Node instead of @cloudflare/vitest-pool-workers: pool-workers 0.23.0 (latest)
// declares peer vitest ^4.1 and does not support the installed vitest 5. Route tests get a real
// local D1 from wrangler's getPlatformProxy (Miniflare, in-memory, no remote bindings) and apply
// the SQL in migrations/ before running — the database is never mocked.
// `cloudflare:workers` (imported by @cloudflare/workers-oauth-provider) only exists in workerd, so
// Node gets a stub; the library must be inlined for the alias to apply to it.
export default defineConfig({
  resolve: {
    alias: {
      "cloudflare:workers": fileURLToPath(new URL("./test/stubs/cloudflare-workers.ts", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    server: { deps: { inline: ["@cloudflare/workers-oauth-provider"] } },
  },
});
