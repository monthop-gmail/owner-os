import type { Polygon } from "@owner-os/shared";
import { describe, expect, it } from "vitest";
import { checkGeofence } from "../src/geofence";

// Fictional ~100 m × 100 m square at the equator; 1 m east ≈ 1 / 111_319.49 degrees of longitude.
const M = 1 / 111_319.49;
const D = 100 * M;
const square: Polygon = {
  type: "Polygon",
  coordinates: [
    [
      [0, 0],
      [D, 0],
      [D, D],
      [0, D],
      [0, 0],
    ],
  ],
};
const midLat = D / 2;
const eastBy = (m: number): number => D + m * M;

describe("checkGeofence", () => {
  it("passes a point inside with zero distance", () => {
    expect(checkGeofence(D / 2, midLat, square)).toEqual({ inside: true, distance_outside_m: 0, passed: true });
  });

  it("passes a point 10 m outside (within the 15 m buffer)", () => {
    const r = checkGeofence(eastBy(10), midLat, square);
    expect(r.inside).toBe(false);
    expect(r.distance_outside_m).toBeCloseTo(10, 0);
    expect(r.passed).toBe(true);
  });

  it("fails a point 20 m outside", () => {
    const r = checkGeofence(eastBy(20), midLat, square);
    expect(r.distance_outside_m).toBeCloseTo(20, 0);
    expect(r.passed).toBe(false);
  });

  it("measures ~100 m for a point 100 m outside", () => {
    const r = checkGeofence(eastBy(100), midLat, square);
    expect(Math.abs(r.distance_outside_m - 100)).toBeLessThanOrEqual(3);
    expect(r.passed).toBe(false);
  });

  it("honours a custom buffer", () => {
    expect(checkGeofence(eastBy(20), midLat, square, 25).passed).toBe(true);
    expect(checkGeofence(eastBy(10), midLat, square, 5).passed).toBe(false);
  });
});
