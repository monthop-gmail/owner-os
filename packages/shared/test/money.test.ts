import { describe, expect, it } from "vitest";
import { CreateHarvestLogInput, gToKg, hasAtMostDecimals, kgToG, revenueSatang, satangToThb, thbToSatang } from "../src/index";

describe("unit conversion", () => {
  it("converts kg to integer grams and baht to integer satang", () => {
    expect(kgToG(1200)).toBe(1_200_000);
    expect(kgToG(0.333)).toBe(333);
    expect(kgToG(1.005)).toBe(1005);
    expect(thbToSatang(85)).toBe(8500);
    expect(thbToSatang(33.33)).toBe(3333);
    expect(thbToSatang(0.29)).toBe(29); // 0.29 * 100 = 28.999999999999996 in floats
    expect(gToKg(333)).toBe(0.333);
    expect(satangToThb(10_200_000)).toBe(102_000);
  });

  it("checks decimal places", () => {
    expect(hasAtMostDecimals(0.333, 3)).toBe(true);
    expect(hasAtMostDecimals(0.3334, 3)).toBe(false);
    expect(hasAtMostDecimals(33.33, 2)).toBe(true);
    expect(hasAtMostDecimals(33.333, 2)).toBe(false);
  });
});

describe("revenueSatang", () => {
  it("matches the team's melon example: 1,200 kg × 85 THB = 102,000 THB", () => {
    const satang = revenueSatang(kgToG(1200), thbToSatang(85));
    expect(satang).toBe(10_200_000);
    expect(satangToThb(satang)).toBe(102_000);
  });

  it("rounds half up to the nearest satang: 0.333 kg × 33.33 THB = 11.10 THB", () => {
    // 333 g × 3333 satang / 1000 = 1109.889 → 1110 satang
    expect(revenueSatang(kgToG(0.333), thbToSatang(33.33))).toBe(1110);
    expect(revenueSatang(1, 500)).toBe(1); // 0.5 → 1
    expect(revenueSatang(1, 499)).toBe(0); // 0.499 → 0
    expect(revenueSatang(0, 9999)).toBe(0);
  });

  it("stays exact at the largest allowed inputs", () => {
    // 1,000,000 kg × 100,000 THB/kg = 1e11 THB = 1e13 satang
    expect(revenueSatang(kgToG(1_000_000), thbToSatang(100_000))).toBe(10_000_000_000_000);
  });

  it("rejects non-integer or negative inputs", () => {
    expect(() => revenueSatang(1.5, 100)).toThrow(RangeError);
    expect(() => revenueSatang(-1, 100)).toThrow(RangeError);
  });
});

describe("CreateHarvestLogInput", () => {
  const base = { harvested_at: "2026-10-24T02:00:00.000Z", weight_kg: 1200, unit_price_thb: 85 };

  it("accepts valid input with optional buyer and note", () => {
    expect(CreateHarvestLogInput.safeParse(base).success).toBe(true);
    expect(CreateHarvestLogInput.safeParse({ ...base, buyer_name: "ผู้ซื้อตัวอย่าง", note: "เกรด A" }).success).toBe(true);
    expect(CreateHarvestLogInput.safeParse({ ...base, weight_kg: 0.333, unit_price_thb: 33.33 }).success).toBe(true);
    expect(CreateHarvestLogInput.safeParse({ ...base, unit_price_thb: 0 }).success).toBe(true);
  });

  it("rejects revenue from the client and out-of-range values", () => {
    expect(CreateHarvestLogInput.safeParse({ ...base, revenue_thb: 102_000 }).success).toBe(false);
    expect(CreateHarvestLogInput.safeParse({ ...base, weight_kg: 0 }).success).toBe(false);
    expect(CreateHarvestLogInput.safeParse({ ...base, weight_kg: 1_000_001 }).success).toBe(false);
    expect(CreateHarvestLogInput.safeParse({ ...base, weight_kg: 1.2345 }).success).toBe(false);
    expect(CreateHarvestLogInput.safeParse({ ...base, unit_price_thb: -1 }).success).toBe(false);
    expect(CreateHarvestLogInput.safeParse({ ...base, unit_price_thb: 85.555 }).success).toBe(false);
    expect(CreateHarvestLogInput.safeParse({ ...base, harvested_at: "yesterday" }).success).toBe(false);
  });
});
