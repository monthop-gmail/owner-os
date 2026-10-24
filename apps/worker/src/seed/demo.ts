// Demo seed that goes through our own API (validation, server-side area, real geofence check),
// instead of loading SQL directly. Only `assets` from the fixture are loaded; `milestone4_not_loaded`
// is reference data for Milestone 4 and is ignored on purpose.
import type { AssetKind, AssetUnitType, Polygon } from "@owner-os/shared";

export type DemoProof = { lat: number; lng: number; accuracy_m: number };
export type DemoWorkOrder = { title: string; unit: string; proof?: DemoProof };
export type DemoUnit = { key: string; name: string; unit_type: AssetUnitType; boundary: Polygon };
export type DemoAsset = {
  key: string;
  name: string;
  kind: AssetKind;
  units: DemoUnit[];
  work_orders: DemoWorkOrder[];
};
export type DemoFixture = { assets: DemoAsset[]; milestone4_not_loaded?: unknown };

export type FetchFn = (path: string, init: RequestInit) => Response | Promise<Response>;

export type SeedFailure = { path: string; status: number; error: string };
export type SeedSummary = {
  assets: number;
  units: number;
  work_orders: number;
  submitted: number;
  failures: SeedFailure[];
};

export type PlanStep = { method: "POST" | "PUT"; path: string; description: string };

/**
 * Minimal valid 8×8 mid-grey baseline JPEG (one block, DC = 0, immediate EOB), built in code so the
 * seed never ships a real photo. Single-symbol Huffman tables make the scan a single byte.
 */
export function tinyJpeg(): Uint8Array {
  const segment = (marker: number, payload: number[]) => {
    const len = payload.length + 2;
    return [0xff, marker, len >> 8, len & 0xff, ...payload];
  };
  const oneSymbolTable = (tableClassAndId: number) => [tableClassAndId, 1, ...new Array<number>(15).fill(0), 0x00];
  return new Uint8Array([
    0xff, 0xd8, // SOI
    ...segment(0xdb, [0x00, ...new Array<number>(64).fill(1)]), // DQT: all ones
    ...segment(0xc0, [8, 0, 8, 0, 8, 1, 1, 0x11, 0]), // SOF0: 8-bit, 8×8, 1 component
    ...segment(0xc4, oneSymbolTable(0x00)), // DHT DC0: category 0 -> code "0"
    ...segment(0xc4, oneSymbolTable(0x10)), // DHT AC0: EOB -> code "0"
    ...segment(0xda, [1, 1, 0x00, 0, 63, 0]), // SOS
    0x3f, // scan: "0" (DC diff 0) + "0" (EOB) + 1-padding
    0xff, 0xd9, // EOI
  ]);
}

/** Pure plan of the requests a seed run would make; used by --dry-run (performs no I/O). */
export function planDemoSeed(fixture: DemoFixture): PlanStep[] {
  const steps: PlanStep[] = [];
  for (const asset of fixture.assets) {
    steps.push({ method: "POST", path: "/api/assets", description: `asset "${asset.name}" (${asset.kind})` });
    for (const unit of asset.units) {
      steps.push({
        method: "POST",
        path: `/api/assets/<${asset.key}>/units`,
        description: `unit "${unit.name}" (${unit.unit_type})`,
      });
    }
    for (const wo of asset.work_orders) {
      steps.push({
        method: "POST",
        path: `/api/assets/<${asset.key}>/work-orders`,
        description: `work order "${wo.title}" on <${wo.unit}>`,
      });
      if (wo.proof) {
        steps.push(
          { method: "POST", path: "/api/tasks/<wo>/upload-ticket", description: "upload ticket" },
          { method: "PUT", path: "/api/tasks/<wo>/evidence/<evidence>", description: "upload generated JPEG" },
          {
            method: "PUT",
            path: "/api/tasks/<wo>/complete",
            description: `complete at ${wo.proof.lat},${wo.proof.lng} ±${wo.proof.accuracy_m} m`,
          },
        );
      }
    }
  }
  return steps;
}

class SeedStop extends Error {
  constructor(readonly failure: SeedFailure) {
    super(`${failure.path} -> ${failure.status} ${failure.error}`);
  }
}

/**
 * Seeds the demo data through the API. Stops at the first non-2xx response and reports it in
 * `failures` (counts reflect what was created before the stop). Not idempotent: every run creates new rows.
 */
export async function seedDemo(
  fetchFn: FetchFn,
  opts: { token: string; fixture: DemoFixture; now?: Date },
): Promise<SeedSummary> {
  const summary: SeedSummary = { assets: 0, units: 0, work_orders: 0, submitted: 0, failures: [] };
  const auth = { authorization: `Bearer ${opts.token}` };
  const capturedAt = (opts.now ?? new Date()).toISOString();

  async function send<T>(method: string, path: string, body?: BodyInit, contentType = "application/json"): Promise<T> {
    const init: RequestInit = { method, headers: body === undefined ? auth : { ...auth, "content-type": contentType } };
    if (body !== undefined) init.body = body;
    const res = await fetchFn(path, init);
    const text = await res.text();
    if (!res.ok) {
      let error = text;
      try {
        error = (JSON.parse(text) as { error?: string }).error ?? text;
      } catch {
        // keep raw text
      }
      throw new SeedStop({ path, status: res.status, error });
    }
    return (text ? JSON.parse(text) : null) as T;
  }
  const json = (value: unknown) => JSON.stringify(value);

  try {
    for (const asset of opts.fixture.assets) {
      const created = await send<{ id: string }>("POST", "/api/assets", json({ name: asset.name, kind: asset.kind }));
      summary.assets++;

      const unitIds = new Map<string, string>();
      for (const unit of asset.units) {
        const u = await send<{ id: string }>(
          "POST",
          `/api/assets/${created.id}/units`,
          json({ name: unit.name, unit_type: unit.unit_type, boundary: unit.boundary }),
        );
        unitIds.set(unit.key, u.id);
        summary.units++;
      }

      for (const wo of asset.work_orders) {
        const unitId = unitIds.get(wo.unit);
        if (unitId === undefined) {
          throw new SeedStop({ path: `fixture:${asset.key}`, status: 0, error: `unknown unit key "${wo.unit}"` });
        }
        const w = await send<{ id: string }>(
          "POST",
          `/api/assets/${created.id}/work-orders`,
          json({ title: wo.title, unit_id: unitId }),
        );
        summary.work_orders++;

        if (wo.proof) {
          const ticket = await send<{ evidence_id: string; upload_url: string }>(
            "POST",
            `/api/tasks/${w.id}/upload-ticket`,
          );
          await send("PUT", ticket.upload_url, tinyJpeg(), "image/jpeg");
          await send(
            "PUT",
            `/api/tasks/${w.id}/complete`,
            json({ evidence_id: ticket.evidence_id, ...wo.proof, captured_at: capturedAt }),
          );
          summary.submitted++;
        }
      }
    }
  } catch (err) {
    if (err instanceof SeedStop) summary.failures.push(err.failure);
    else summary.failures.push({ path: "(network)", status: 0, error: String(err) });
  }
  return summary;
}
