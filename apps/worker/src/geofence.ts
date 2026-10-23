import { booleanPointInPolygon } from "@turf/boolean-point-in-polygon";
import { pointToPolygonDistance } from "@turf/point-to-polygon-distance";
import type { Polygon } from "@owner-os/shared";

export type GeofenceResult = {
  inside: boolean;
  /** Metres from the point to the nearest polygon edge; 0 when inside. */
  distance_outside_m: number;
  passed: boolean;
};

/**
 * Pure geofence check. GPS accuracy is deliberately not an input: a poor fix must not widen the fence
 * (accuracy is gated separately by the caller).
 */
export function checkGeofence(lng: number, lat: number, polygon: Polygon, bufferM = 15): GeofenceResult {
  const point: [number, number] = [lng, lat];
  const inside = booleanPointInPolygon(point, polygon);
  const distance_outside_m = inside ? 0 : Math.max(0, pointToPolygonDistance(point, polygon, { units: "meters" }));
  return { inside, distance_outside_m, passed: inside || distance_outside_m <= bufferM };
}
