import { describe, expect, it } from "vitest";
import { describeGeofence, formatCapturedAt, GEOFENCE_BUFFER_M, pinStyle } from "./evidence";

describe("pinStyle", () => {
  it("is green inside the plot", () => {
    expect(pinStyle({ inside_geofence: true, distance_outside_m: 0 })).toMatchObject({ kind: "inside", color: "#16a34a" });
  });

  it("is orange when outside but within the 15 m buffer", () => {
    expect(pinStyle({ inside_geofence: false, distance_outside_m: 9.4 })).toMatchObject({ kind: "buffer", color: "#ea580c" });
    expect(pinStyle({ inside_geofence: false, distance_outside_m: GEOFENCE_BUFFER_M }).kind).toBe("buffer");
  });

  it("never shows an out-of-buffer row as a pass", () => {
    expect(pinStyle({ inside_geofence: false, distance_outside_m: 15.1 }).kind).toBe("outside");
    expect(pinStyle({ inside_geofence: null, distance_outside_m: null }).kind).toBe("outside");
  });
});

describe("describeGeofence", () => {
  it("describes inside / outside X m / unknown", () => {
    expect(describeGeofence({ inside_geofence: true, distance_outside_m: 0 })).toBe("อยู่ในแปลง");
    expect(describeGeofence({ inside_geofence: false, distance_outside_m: 9.6 })).toBe("นอกแปลง 10 ม.");
    expect(describeGeofence({ inside_geofence: null, distance_outside_m: null })).toBeNull();
  });
});

describe("formatCapturedAt", () => {
  it("formats in Asia/Bangkok with the Thai calendar", () => {
    expect(formatCapturedAt("2026-10-24T02:00:00Z")).toBe("24 ต.ค. 2569 · 09:00 น.");
  });

  it("crosses the date line into the next Thai day", () => {
    expect(formatCapturedAt("2026-10-24T18:30:00.000Z")).toBe("25 ต.ค. 2569 · 01:30 น.");
  });

  it("returns a dash for missing or invalid values", () => {
    expect(formatCapturedAt(null)).toBe("—");
    expect(formatCapturedAt("not-a-date")).toBe("—");
  });
});
