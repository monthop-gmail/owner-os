import { CreateContractInput } from "@owner-os/shared";
import { and, desc, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { Hono, type Context } from "hono";
import { asset_contracts, assets } from "../db/schema";
import type { Env } from "../env";
import { contractTermsToStored, contractToApi, toMs } from "../mappers";

type AppContext = Context<{ Bindings: Env }>;

type SafeParser<T> = {
  safeParse(data: unknown): { success: true; data: T } | { success: false; error: { issues: unknown[] } };
};

async function parseBody<T>(c: AppContext, schema: SafeParser<T>): Promise<{ ok: true; data: T } | { ok: false; res: Response }> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return { ok: false, res: c.json({ error: "invalid_json" }, 400) };
  }
  const result = schema.safeParse(body);
  if (!result.success) return { ok: false, res: c.json({ error: "validation_error", issues: result.error.issues }, 400) };
  return { ok: true, data: result.data };
}

const contractNotFound = (c: AppContext) => c.json({ error: "contract_not_found" }, 404);

/** Mounted at /api/assets: contracts of one asset. */
export const assetContractsRoutes = new Hono<{ Bindings: Env }>();

assetContractsRoutes.post("/:id/contracts", async (c) => {
  const assetId = c.req.param("id");
  const db = drizzle(c.env.DB);
  const asset = await db.select({ id: assets.id }).from(assets).where(eq(assets.id, assetId)).get();
  if (!asset) return c.json({ error: "asset_not_found" }, 404);

  const parsed = await parseBody(c, CreateContractInput);
  if (!parsed.ok) return parsed.res;
  const { partner_label, starts_at, ends_at, terms } = parsed.data;

  // Single statement: insert only if the asset has no active contract. A partial unique index
  // (asset_contracts_one_active_per_asset) backs this up at the database level.
  const id = crypto.randomUUID();
  const result = await db.run(sql`
    INSERT INTO ${asset_contracts} (id, asset_id, contract_type, partner_label, terms_json, is_active, rules_status, starts_at, ends_at, created_at)
    SELECT ${id}, ${assetId}, ${terms.contract_type}, ${partner_label}, ${JSON.stringify(contractTermsToStored(terms))},
           1, 'draft_unconfirmed', ${toMs(starts_at)}, ${ends_at === undefined ? null : toMs(ends_at)}, ${Date.now()}
    WHERE NOT EXISTS (
      SELECT 1 FROM ${asset_contracts} WHERE ${asset_contracts.asset_id} = ${assetId} AND ${asset_contracts.is_active} = 1
    )`);
  if (result.meta.changes !== 1) return c.json({ error: "active_contract_exists" }, 409);

  const row = await db.select().from(asset_contracts).where(eq(asset_contracts.id, id)).get();
  if (!row) return contractNotFound(c);
  return c.json(contractToApi(row), 201);
});

assetContractsRoutes.get("/:id/contracts", async (c) => {
  const assetId = c.req.param("id");
  const db = drizzle(c.env.DB);
  const [assetRows, rows] = await db.batch([
    db.select({ id: assets.id }).from(assets).where(eq(assets.id, assetId)),
    db
      .select()
      .from(asset_contracts)
      .where(eq(asset_contracts.asset_id, assetId))
      .orderBy(desc(asset_contracts.created_at), desc(sql`${asset_contracts}.rowid`)),
  ]);
  if (assetRows.length === 0) return c.json({ error: "asset_not_found" }, 404);
  return c.json({ contracts: rows.map(contractToApi) });
});

/** Mounted at /api/contracts. */
export const contractsRoutes = new Hono<{ Bindings: Env }>();

contractsRoutes.get("/:id", async (c) => {
  const row = await drizzle(c.env.DB).select().from(asset_contracts).where(eq(asset_contracts.id, c.req.param("id"))).get();
  if (!row) return contractNotFound(c);
  return c.json(contractToApi(row));
});

contractsRoutes.post("/:id/deactivate", async (c) => {
  const id = c.req.param("id");
  const db = drizzle(c.env.DB);
  const [updated] = await db
    .update(asset_contracts)
    .set({ is_active: false, deactivated_at: Date.now() })
    .where(and(eq(asset_contracts.id, id), eq(asset_contracts.is_active, true)))
    .returning();
  if (updated) return c.json(contractToApi(updated));

  const exists = await db.select({ id: asset_contracts.id }).from(asset_contracts).where(eq(asset_contracts.id, id)).get();
  return exists ? c.json({ error: "contract_not_active" }, 409) : contractNotFound(c);
});
