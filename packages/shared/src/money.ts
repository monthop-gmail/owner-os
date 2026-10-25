// Money and weight are stored as integers (satang, grams); the API shows baht and kilograms.

export const SATANG_PER_THB = 100;
export const G_PER_KG = 1000;

/** True when `value` has at most `places` decimal places (tolerates binary float noise). */
export function hasAtMostDecimals(value: number, places: number): boolean {
  const scaled = value * 10 ** places;
  return Math.abs(scaled - Math.round(scaled)) < 1e-6;
}

/** Kilograms (≤ 3 decimals) → integer grams. */
export const kgToG = (kg: number): number => Math.round(kg * G_PER_KG);
export const gToKg = (g: number): number => g / G_PER_KG;

/** Baht (≤ 2 decimals) → integer satang. */
export const thbToSatang = (thb: number): number => Math.round(thb * SATANG_PER_THB);
export const satangToThb = (satang: number): number => satang / SATANG_PER_THB;

/**
 * Revenue in satang for `weight_g` grams at `unit_price_satang` per kilogram:
 * round(weight_g × unit_price_satang / 1000), half up. Computed with BigInt so the product is exact.
 */
export function revenueSatang(weight_g: number, unit_price_satang: number): number {
  if (!Number.isSafeInteger(weight_g) || !Number.isSafeInteger(unit_price_satang) || weight_g < 0 || unit_price_satang < 0) {
    throw new RangeError("weight_g and unit_price_satang must be non-negative safe integers");
  }
  const product = BigInt(weight_g) * BigInt(unit_price_satang);
  const rounded = (product + BigInt(G_PER_KG / 2)) / BigInt(G_PER_KG);
  if (rounded > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError("revenue exceeds safe integer range");
  return Number(rounded);
}
