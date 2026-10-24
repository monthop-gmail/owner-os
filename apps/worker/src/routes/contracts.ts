import {
  computeSettlement,
  CreateContractInput,
  FixedTargetPreviewInput,
  PayPerJobPreviewInput,
  PropertyPreviewInput,
  satangToThb,
  SettlementError,
  thbToSatang,
  TurnkeyPreviewInput,
  type SettlementInput,
} from "@owner-os/shared";
import { and, desc, eq, sql, sum } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { Hono, type Context } from "hono";
import { asset_contracts, asset_units, assets, farm_crop_cycles, farm_harvest_logs } from "../db/schema";
import type { Env } from "../env";
import { contractTermsToStored, contractToApi, toMs, type StoredContractTerms } from "../mappers";

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

const DAY_MS = 24 * 60 * 60 * 1000;
/** A "month" for retainers derived from a crop cycle: 30 days, rounded up. */
const MONTH_MS = 30 * DAY_MS;

type RevenueSource = { revenue_from: "harvest_logs"; crop_cycle_id: string } | { revenue_from: "input" };

/**
 * Draft settlement for one contract — preview only: nothing is written to the database and nothing is paid.
 * The body depends on the contract type; amounts are baht in and baht out (satang inside the engine).
 */
contractsRoutes.post("/:id/settlement-preview", async (c) => {
  const db = drizzle(c.env.DB);
  const contract = await db.select().from(asset_contracts).where(eq(asset_contracts.id, c.req.param("id"))).get();
  if (!contract) return contractNotFound(c);
  if (!contract.is_active) return c.json({ error: "contract_not_active" }, 409);
  const terms = JSON.parse(contract.terms_json) as StoredContractTerms;

  /** Revenue from the cycle's harvest logs; the cycle must belong to the contract's asset. */
  const cycleRevenue = async (cropCycleId: string) => {
    const cycle = await db
      .select({ started_at: farm_crop_cycles.started_at, ended_at: farm_crop_cycles.ended_at })
      .from(farm_crop_cycles)
      .innerJoin(asset_units, eq(asset_units.id, farm_crop_cycles.unit_id))
      .where(and(eq(farm_crop_cycles.id, cropCycleId), eq(asset_units.asset_id, contract.asset_id)))
      .get();
    if (!cycle) return null;
    const [total] = await db
      .select({ revenue_satang: sum(farm_harvest_logs.revenue_satang).mapWith(Number) })
      .from(farm_harvest_logs)
      .where(eq(farm_harvest_logs.crop_cycle_id, cropCycleId));
    return { ...cycle, revenue_satang: total?.revenue_satang ?? 0 };
  };
  const cycleNotInAsset = () => c.json({ error: "crop_cycle_not_in_asset" }, 400);

  let input: SettlementInput;
  let source: RevenueSource = { revenue_from: "input" };

  switch (terms.contract_type) {
    case "turnkey_profit_share":
    case "fixed_target_bonus": {
      const parsed =
        terms.contract_type === "turnkey_profit_share"
          ? await parseBody(c, TurnkeyPreviewInput)
          : await parseBody(c, FixedTargetPreviewInput);
      if (!parsed.ok) return parsed.res;
      const body = parsed.data;
      let revenue = body.revenue_thb === undefined ? 0 : thbToSatang(body.revenue_thb);
      let periodMonths: number | undefined = (body as { period_months?: number | undefined }).period_months;
      if (body.crop_cycle_id !== undefined) {
        const cycle = await cycleRevenue(body.crop_cycle_id);
        if (!cycle) return cycleNotInAsset();
        revenue = cycle.revenue_satang;
        source = { revenue_from: "harvest_logs", crop_cycle_id: body.crop_cycle_id };
        if (periodMonths === undefined && cycle.started_at !== null && cycle.ended_at !== null) {
          periodMonths = Math.ceil(Math.max(0, cycle.ended_at - cycle.started_at) / MONTH_MS);
        }
      }
      const opex = thbToSatang(body.opex_thb);
      if (terms.contract_type === "turnkey_profit_share") {
        if (periodMonths === undefined) {
          return c.json(
            { error: "period_months_required", message: "send period_months, or a crop_cycle_id whose cycle has started_at and ended_at" },
            400,
          );
        }
        input = { contract_type: terms.contract_type, revenue_satang: revenue, opex_satang: opex, period_months: periodMonths };
      } else {
        input = { contract_type: terms.contract_type, revenue_satang: revenue, opex_satang: opex };
      }
      break;
    }
    case "pay_per_job": {
      const parsed = await parseBody(c, PayPerJobPreviewInput);
      if (!parsed.ok) return parsed.res;
      input = {
        contract_type: terms.contract_type,
        jobs: parsed.data.jobs.map((j) => ({ job_key: j.job_key, quantity_hundredths: Math.round(j.quantity * 100) })),
      };
      break;
    }
    case "property_management": {
      const parsed = await parseBody(c, PropertyPreviewInput);
      if (!parsed.ok) return parsed.res;
      input = {
        contract_type: terms.contract_type,
        revenue_satang: thbToSatang(parsed.data.revenue_thb),
        turnovers: parsed.data.turnovers,
      };
      break;
    }
  }

  let result;
  try {
    result = computeSettlement(terms, input);
  } catch (err) {
    if (err instanceof SettlementError) return c.json({ error: err.code, message: err.message }, 400);
    throw err;
  }

  return c.json({
    contract_id: contract.id,
    contract_type: result.contract_type,
    rules_status: result.rules_status,
    lines: result.lines.map((l) => ({ key: l.key, label_th: l.label_th, amount_thb: satangToThb(l.amount_satang), party: l.party })),
    owner_payout_thb: satangToThb(result.owner_payout_satang),
    operator_payout_thb: satangToThb(result.operator_payout_satang),
    assumptions: result.assumptions,
    source,
  });
});
