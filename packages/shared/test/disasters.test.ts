import { describe, expect, it } from "vitest";
import { combinedDamageBps, CreateDisasterEventInput, DISASTER_TYPE_LABELS, DisasterType, weightedDamageBps } from "../src/index";

describe("weightedDamageBps", () => {
  it("weights damage by area: 47,435 m² at 40% + 18,853 m² at 0% ≈ 28.62%", () => {
    // 47,435 × 4000 / 66,288 = 2862.36… → 2862 bps
    expect(
      weightedDamageBps([
        { area_m2: 47_435, damage_bps: 4000 },
        { area_m2: 18_853, damage_bps: 0 },
      ]),
    ).toBe(2862);
  });

  it("rounds areas to whole m² first and the result half up", () => {
    expect(weightedDamageBps([{ area_m2: 47_435.2, damage_bps: 4000 }])).toBe(4000);
    // (1 × 1 + 1 × 0) / 2 = 0.5 → 1
    expect(
      weightedDamageBps([
        { area_m2: 1, damage_bps: 1 },
        { area_m2: 1, damage_bps: 0 },
      ]),
    ).toBe(1);
  });

  it("returns 0 without area", () => {
    expect(weightedDamageBps([])).toBe(0);
    expect(
      weightedDamageBps([
        { area_m2: null, damage_bps: 5000 },
        { area_m2: 0, damage_bps: 9000 },
      ]),
    ).toBe(0);
  });
});

describe("combinedDamageBps", () => {
  it("compounds damage so it never exceeds 100%: 40% then 50% → 70%", () => {
    expect(combinedDamageBps([4000, 5000])).toBe(7000);
    expect(combinedDamageBps([10_000, 5000])).toBe(10_000);
    expect(combinedDamageBps([])).toBe(0);
    expect(combinedDamageBps([3333, 3333, 3333])).toBe(7037); // 1 − 0.6667³ = 0.703660… → 7036.6 bps → 7037
  });
});

describe("CreateDisasterEventInput", () => {
  const base = {
    event_type: "flood",
    occurred_at: new Date(Date.now() - 60_000).toISOString(),
    units: [{ unit_id: "u-1", damage_pct: 40 }],
  };
  const ok = (v: unknown) => CreateDisasterEventInput.safeParse(v).success;

  it("accepts a valid event", () => {
    expect(ok(base)).toBe(true);
    expect(ok({ ...base, ended_at: new Date().toISOString(), description: "น้ำท่วมขัง 3 วัน" })).toBe(true);
    expect(ok({ ...base, units: [{ unit_id: "u-1", damage_pct: 12.34, note: "ต้นล้ม 5 ต้น" }] })).toBe(true);
  });

  it("rejects bad damage, duplicate units, empty units, future dates, reversed ranges and unknown fields", () => {
    expect(ok({ ...base, units: [{ unit_id: "u-1", damage_pct: 101 }] })).toBe(false);
    expect(ok({ ...base, units: [{ unit_id: "u-1", damage_pct: 12.345 }] })).toBe(false);
    expect(
      ok({
        ...base,
        units: [
          { unit_id: "u-1", damage_pct: 10 },
          { unit_id: "u-1", damage_pct: 20 },
        ],
      }),
    ).toBe(false);
    expect(ok({ ...base, units: [] })).toBe(false);
    expect(ok({ ...base, occurred_at: new Date(Date.now() + 10 * 60_000).toISOString() })).toBe(false);
    expect(ok({ ...base, ended_at: new Date(Date.now() - 3_600_000).toISOString() })).toBe(false);
    expect(ok({ ...base, event_type: "meteor" })).toBe(false);
    expect(ok({ ...base, claim_amount: 1 })).toBe(false);
  });

  it("has a Thai label for every type", () => {
    for (const t of DisasterType.options) expect(DISASTER_TYPE_LABELS[t].length).toBeGreaterThan(0);
    expect(DISASTER_TYPE_LABELS.flood).toBe("น้ำท่วม");
  });
});
