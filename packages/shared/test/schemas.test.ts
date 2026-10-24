import { describe, expect, it } from "vitest";
import {
  AssetSchema,
  AssetUnitSchema,
  CompleteWorkOrderInput,
  CreateAssetInput,
  CreateAssetUnitInput,
  CreateWorkOrderInput,
  CreateCropCycleInput,
  CROP_CYCLE_TRANSITIONS,
  CropCycleSchema,
  CropCycleStatus,
  TransitionCropCycleInput,
  canTransition,
  LngLatSchema,
  PointSchema,
  PolygonSchema,
  WorkOrderSchema,
} from "../src/index";

const NOW = "2026-10-23T10:00:00.000Z";

const square = {
  type: "Polygon",
  coordinates: [
    [
      [100.5, 13.7],
      [100.6, 13.7],
      [100.6, 13.8],
      [100.5, 13.8],
      [100.5, 13.7],
    ],
  ],
};

const unit = {
  id: "u-1",
  asset_id: "a-1",
  name: "แปลง A",
  unit_type: "plot",
  boundary: square,
  area_m2: null,
  created_at: NOW,
};

const workOrder = {
  id: "wo-1",
  asset_id: "a-1",
  unit_id: null,
  crop_cycle_id: null,
  title: "ใส่ปุ๋ย",
  status: "open",
  due_at: null,
  created_at: NOW,
};

const complete = { evidence_id: "ev-1", lat: 13.75, lng: 100.55, accuracy_m: 8, captured_at: NOW };

describe("geo", () => {
  it("accepts a closed polygon", () => {
    expect(PolygonSchema.safeParse(square).success).toBe(true);
  });

  it("accepts a valid point", () => {
    expect(PointSchema.safeParse({ type: "Point", coordinates: [100.5, 13.7] }).success).toBe(true);
  });

  it("rejects an unclosed ring", () => {
    const open = { type: "Polygon", coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1]]] };
    expect(PolygonSchema.safeParse(open).success).toBe(false);
  });

  it("rejects a ring with only 3 positions", () => {
    const tri = { type: "Polygon", coordinates: [[[0, 0], [1, 0], [0, 0]]] };
    expect(PolygonSchema.safeParse(tri).success).toBe(false);
  });

  it("rejects a polygon with no rings", () => {
    expect(PolygonSchema.safeParse({ type: "Polygon", coordinates: [] }).success).toBe(false);
  });

  it("rejects lat 91", () => {
    expect(LngLatSchema.safeParse([100, 91]).success).toBe(false);
  });

  it("rejects lng -181", () => {
    expect(LngLatSchema.safeParse([-181, 13]).success).toBe(false);
  });

  it("rejects NaN and Infinity", () => {
    expect(LngLatSchema.safeParse([Number.NaN, 13]).success).toBe(false);
    expect(LngLatSchema.safeParse([100, Number.POSITIVE_INFINITY]).success).toBe(false);
  });
});

describe("entities", () => {
  it("accepts an asset without boundary", () => {
    const asset = { id: "a-1", name: "สวนทุเรียน", kind: "farm", boundary: null, created_at: NOW };
    expect(AssetSchema.safeParse(asset).success).toBe(true);
  });

  it("accepts a valid unit", () => {
    expect(AssetUnitSchema.safeParse(unit).success).toBe(true);
  });

  it("rejects a unit without boundary", () => {
    const { boundary: _omit, ...noBoundary } = unit;
    expect(AssetUnitSchema.safeParse(noBoundary).success).toBe(false);
    expect(AssetUnitSchema.safeParse({ ...unit, boundary: null }).success).toBe(false);
  });

  it("accepts a valid work order", () => {
    expect(WorkOrderSchema.safeParse(workOrder).success).toBe(true);
  });

  it("rejects a status outside the enum", () => {
    expect(WorkOrderSchema.safeParse({ ...workOrder, status: "done" }).success).toBe(false);
  });
});

describe("inputs", () => {
  it("accepts a valid complete input", () => {
    expect(CompleteWorkOrderInput.safeParse(complete).success).toBe(true);
  });

  it("rejects negative accuracy_m", () => {
    expect(CompleteWorkOrderInput.safeParse({ ...complete, accuracy_m: -1 }).success).toBe(false);
  });

  it("rejects a non-ISO captured_at", () => {
    expect(CompleteWorkOrderInput.safeParse({ ...complete, captured_at: "yesterday" }).success).toBe(false);
  });

  it("accepts CreateAssetInput with and without boundary", () => {
    expect(CreateAssetInput.safeParse({ name: "บ้าน", kind: "property" }).success).toBe(true);
    expect(CreateAssetInput.safeParse({ name: "สวน", kind: "farm", boundary: square }).success).toBe(true);
  });

  it("rejects CreateAssetInput that includes an id (strict)", () => {
    expect(CreateAssetInput.safeParse({ id: "x", name: "บ้าน", kind: "property" }).success).toBe(false);
  });

  it("rejects CreateAssetUnitInput that includes an id (strict)", () => {
    const input = { id: "x", name: "แปลง A", unit_type: "plot", boundary: square };
    expect(CreateAssetUnitInput.safeParse(input).success).toBe(false);
  });

  it("rejects CompleteWorkOrderInput that includes inside_geofence (server-computed)", () => {
    expect(CompleteWorkOrderInput.safeParse({ ...complete, inside_geofence: true }).success).toBe(false);
  });

  it("accepts a valid CreateWorkOrderInput", () => {
    expect(CreateWorkOrderInput.safeParse({ title: "ตัดหญ้า" }).success).toBe(true);
    expect(CreateWorkOrderInput.safeParse({ title: "ตัดหญ้า", unit_id: "u-1", due_at: NOW }).success).toBe(true);
  });

  it("rejects CreateWorkOrderInput with unknown keys (strict)", () => {
    expect(CreateWorkOrderInput.safeParse({ title: "ตัดหญ้า", status: "verified" }).success).toBe(false);
  });

  it("rejects CompleteWorkOrderInput without evidence_id", () => {
    const { evidence_id: _omit, ...noEvidence } = complete;
    expect(CompleteWorkOrderInput.safeParse(noEvidence).success).toBe(false);
  });
});

describe("crop cycles", () => {
  it("allows exactly the five forward transitions", () => {
    const allowed: [CropCycleStatus, CropCycleStatus][] = [
      ["planned", "growing"],
      ["growing", "harvesting"],
      ["harvesting", "closed"],
      ["planned", "closed"],
      ["growing", "closed"],
    ];
    for (const [from, to] of allowed) expect(canTransition(from, to), `${from}->${to}`).toBe(true);
    const total = Object.values(CROP_CYCLE_TRANSITIONS).reduce((n, tos) => n + tos.length, 0);
    expect(total).toBe(allowed.length);
  });

  it("forbids going back, skipping to harvesting, and leaving closed", () => {
    const statuses = CropCycleStatus.options;
    expect(canTransition("growing", "planned")).toBe(false);
    expect(canTransition("closed", "growing")).toBe(false);
    expect(canTransition("harvesting", "growing")).toBe(false);
    expect(canTransition("planned", "harvesting")).toBe(false);
    for (const s of statuses) {
      expect(canTransition(s, s)).toBe(false);
      expect(canTransition("closed", s)).toBe(false);
    }
  });

  it("validates crop cycle shapes and strict inputs", () => {
    const cycle = {
      id: "c-1",
      unit_id: "u-1",
      crop: "ทุเรียน",
      variety: "หมอนทอง",
      status: "planned",
      template_key: null,
      started_at: null,
      expected_harvest_at: null,
      ended_at: null,
      created_at: NOW,
    };
    expect(CropCycleSchema.safeParse(cycle).success).toBe(true);
    expect(CropCycleSchema.safeParse({ ...cycle, status: "fallow" }).success).toBe(false);
    expect(CreateCropCycleInput.safeParse({ crop: "ข้าวโพด" }).success).toBe(true);
    expect(CreateCropCycleInput.safeParse({ crop: "" }).success).toBe(false);
    expect(CreateCropCycleInput.safeParse({ crop: "x".repeat(101) }).success).toBe(false);
    expect(CreateCropCycleInput.safeParse({ crop: "ข้าวโพด", status: "growing" }).success).toBe(false);
    expect(TransitionCropCycleInput.safeParse({ to: "growing" }).success).toBe(true);
    expect(TransitionCropCycleInput.safeParse({ to: "fallow" }).success).toBe(false);
    expect(TransitionCropCycleInput.safeParse({ to: "growing", started_at: NOW }).success).toBe(false);
  });

  it("accepts crop_cycle_id on work orders", () => {
    expect(CreateWorkOrderInput.safeParse({ title: "งาน", crop_cycle_id: "c-1" }).success).toBe(true);
  });
});
