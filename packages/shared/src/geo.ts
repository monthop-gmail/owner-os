import { z } from "zod";

// z.number() rejects NaN and ±Infinity in Zod 4.
export const LngSchema = z.number().min(-180).max(180);
export const LatSchema = z.number().min(-90).max(90);

/** GeoJSON position order: [lng, lat]. */
export const LngLatSchema = z.tuple([LngSchema, LatSchema]);

export const PointSchema = z.object({
  type: z.literal("Point"),
  coordinates: LngLatSchema,
});

export const LinearRingSchema = z
  .array(LngLatSchema)
  .min(4, "ring must have at least 4 positions")
  .refine(
    (ring) => {
      const first = ring[0];
      const last = ring[ring.length - 1];
      return first !== undefined && last !== undefined && first[0] === last[0] && first[1] === last[1];
    },
    { message: "ring must be closed (first position equals last)" },
  );

export const PolygonSchema = z.object({
  type: z.literal("Polygon"),
  coordinates: z.array(LinearRingSchema).min(1, "polygon must have at least 1 ring"),
});

export type LngLat = z.infer<typeof LngLatSchema>;
export type Point = z.infer<typeof PointSchema>;
export type LinearRing = z.infer<typeof LinearRingSchema>;
export type Polygon = z.infer<typeof PolygonSchema>;
