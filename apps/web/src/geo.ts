// Pure geometry helpers for the plot drawer. Leaflet works in {lat, lng}; GeoJSON is [lng, lat].
import { area } from "@turf/area";
import type { Polygon } from "@owner-os/shared";

export type LatLngPoint = { lat: number; lng: number };
export type Position = [lng: number, lat: number];

export const MIN_POLYGON_POINTS = 3;
export const M2_PER_RAI = 1600;

export const canClose = (points: readonly LatLngPoint[]): boolean => points.length >= MIN_POLYGON_POINTS;

/** GeoJSON ring in [lng, lat] order whose last position equals the first. */
export function closeRing(points: readonly LatLngPoint[]): Position[] {
  const ring: Position[] = points.map((p) => [p.lng, p.lat]);
  const first = ring[0];
  const last = ring[ring.length - 1];
  if (first && last && (first[0] !== last[0] || first[1] !== last[1])) ring.push([first[0], first[1]]);
  return ring;
}

/** Closed GeoJSON Polygon, or null when there are fewer than 3 distinct points. */
export function toPolygon(points: readonly LatLngPoint[]): Polygon | null {
  if (!canClose(points)) return null;
  return { type: "Polygon", coordinates: [closeRing(points)] };
}

/** Geodesic area in m² (0 when the shape cannot be closed yet). */
export function areaM2(points: readonly LatLngPoint[]): number {
  const polygon = toPolygon(points);
  return polygon ? area(polygon) : 0;
}

export const m2ToRai = (m2: number): number => m2 / M2_PER_RAI;

/** "47,435 ตร.ม. · 29.65 ไร่" */
export function formatArea(m2: number): string {
  const sqm = Math.round(m2).toLocaleString("en-US");
  return `${sqm} ตร.ม. · ${m2ToRai(m2).toFixed(2)} ไร่`;
}

/** Outer ring of a stored polygon as Leaflet [lat, lng] pairs (closing point dropped). */
export function polygonToLatLngs(polygon: Polygon): [number, number][] {
  const ring = polygon.coordinates[0] ?? [];
  const open = ring.length > 1 ? ring.slice(0, -1) : ring;
  return open.map(([lng, lat]) => [lat, lng]);
}
