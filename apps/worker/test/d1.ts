import { getPlatformProxy } from "wrangler";
import type { Env } from "../src/env";

// tsconfig only loads workers types, so node:fs is imported untyped (tests run under Node).
type Fs = {
  readdirSync(path: URL): string[];
  readFileSync(path: URL, encoding: "utf8"): string;
};
const fs = (await import("node:fs" as string)) as Fs;
const migrationsDir = new URL("../migrations/", (import.meta as ImportMeta & { url: string }).url);

async function applyMigrations(db: D1Database): Promise<void> {
  const files = fs.readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort();
  for (const file of files) {
    const statements = fs
      .readFileSync(new URL(file, migrationsDir), "utf8")
      .split("--> statement-breakpoint")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    await db.batch(statements.map((s) => db.prepare(s)));
  }
}

export type TestEnv = { env: Env; dispose: () => Promise<void> };

/** Real local D1 + R2 via Miniflare (in-memory, no remote bindings) with all migrations applied. */
export async function createTestEnv(): Promise<TestEnv> {
  const proxy = await getPlatformProxy<Env>({ persist: false, remoteBindings: false });
  await applyMigrations(proxy.env.DB);
  return { env: proxy.env, dispose: () => proxy.dispose() };
}
