// Seed demo data through the owner-os API.
//   OWNER_OS_URL=http://localhost:8787 OWNER_OS_TOKEN=... pnpm seed:demo [--dry-run]
// WARNING: not idempotent — every run creates a new copy of the demo data (no GET/DELETE API yet).
import fixtureJson from "../fixtures/demo-seed.json";
import { planDemoSeed, seedDemo, type DemoFixture } from "../src/seed/demo";

// The worker tsconfig only loads workers types, so Node's process is typed locally.
type NodeProcess = { argv: string[]; env: Record<string, string | undefined>; exit(code: number): never };
const proc: NodeProcess = (globalThis as unknown as { process: NodeProcess }).process;

const fixture = fixtureJson as DemoFixture;
const dryRun = proc.argv.includes("--dry-run");

console.warn("⚠️  Running this seed again creates duplicate demo data (there is no GET/DELETE API yet).");

if (dryRun) {
  const steps = planDemoSeed(fixture);
  console.log(`Dry run — ${steps.length} requests would be sent (nothing is written):`);
  for (const s of steps) console.log(`  ${s.method.padEnd(4)} ${s.path}  ${s.description}`);
  proc.exit(0);
}

const baseUrl = proc.env.OWNER_OS_URL?.replace(/\/+$/, "");
const token = proc.env.OWNER_OS_TOKEN;
if (!baseUrl || !token) {
  console.error("Set OWNER_OS_URL (e.g. http://localhost:8787) and OWNER_OS_TOKEN (the Worker API_TOKEN).");
  proc.exit(1);
}

const summary = await seedDemo((path, init) => fetch(baseUrl + path, init), { token, fixture, now: new Date() });
console.log(
  `assets ${summary.assets} · units ${summary.units} · work orders ${summary.work_orders} · submitted ${summary.submitted}`,
);
if (summary.failures.length > 0) {
  for (const f of summary.failures) console.error(`FAILED ${f.path} -> ${f.status} ${f.error}`);
  console.error("Seed stopped at the first failure; data created before it was kept.");
  proc.exit(1);
}
