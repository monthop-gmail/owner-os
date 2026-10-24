import { describe, expect, it } from "vitest";
import { areaM2, canClose, closeRing, formatArea, m2ToRai, polygonToLatLngs, toPolygon, type LatLngPoint } from "./geo";

// Durian demo plot (fictional): [[102.834,16.44],[102.836,16.44],[102.836,16.442],[102.834,16.442]] as [lng, lat].
const durian: LatLngPoint[] = [
  { lng: 102.834, lat: 16.44 },
  { lng: 102.836, lat: 16.44 },
  { lng: 102.836, lat: 16.442 },
  { lng: 102.834, lat: 16.442 },
];

describe("closeRing / toPolygon", () => {
  it("closes the ring in [lng, lat] order", () => {
    const ring = closeRing(durian);
    expect(ring).toHaveLength(5);
    expect(ring[0]).toEqual([102.834, 16.44]);
    expect(ring[4]).toEqual(ring[0]);
  });

  it("does not duplicate the closing point when already closed", () => {
    expect(closeRing([...durian, durian[0]!])).toHaveLength(5);
  });

  it("builds a closed GeoJSON polygon", () => {
    expect(toPolygon(durian)).toEqual({
      type: "Polygon",
      coordinates: [
        [
          [102.834, 16.44],
          [102.836, 16.44],
          [102.836, 16.442],
          [102.834, 16.442],
          [102.834, 16.44],
        ],
      ],
    });
  });

  it("cannot close fewer than 3 points", () => {
    expect(canClose(durian.slice(0, 2))).toBe(false);
    expect(toPolygon(durian.slice(0, 2))).toBeNull();
    expect(areaM2(durian.slice(0, 2))).toBe(0);
    expect(canClose(durian.slice(0, 3))).toBe(true);
  });
});

describe("area", () => {
  it("computes ≈ 47,435 m² (±1%) and ≈ 29.65 rai for the durian plot", () => {
    const m2 = areaM2(durian);
    expect(Math.abs(m2 - 47_435) / 47_435).toBeLessThan(0.01);
    expect(m2ToRai(m2)).toBeCloseTo(29.65, 1);
    expect(m2ToRai(1600)).toBe(1);
    expect(formatArea(m2)).toMatch(/^47,4\d\d ตร\.ม\. · 29\.6\d ไร่$/);
  });

  it("round-trips a stored polygon to Leaflet [lat, lng] pairs", () => {
    expect(polygonToLatLngs(toPolygon(durian)!)).toEqual(durian.map((p) => [p.lat, p.lng]));
  });
});
