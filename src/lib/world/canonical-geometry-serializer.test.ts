import {describe, expect, it} from "vitest";

import {
  canonicalGeometrySerialize,
  normalizeCanonicalGeometry,
  type CanonicalGeometryPolicy,
} from "./canonical-geometry-serializer";

const policy: CanonicalGeometryPolicy = {
  coordinatePrecision: 6,
  exteriorRingWinding: "counterclockwise",
};
const bytes = (geometry: unknown, selectedPolicy = policy) => [
  ...canonicalGeometrySerialize(geometry, selectedPolicy),
];

describe("10-21 canonical geometry serializer", () => {
  it("produces identical bytes after precision, winding, and ring-start normalization", () => {
    const first = {
      type: "Polygon",
      coordinates: [
        [[4.0000004, 4], [4, 0], [-0, 0], [0, 4], [4.0000004, 4]],
        [[3, 3], [1, 3], [1, 1], [3, 1], [3, 3]],
      ],
    };
    const second = {
      coordinates: [
        [[0, 4], [0, 0], [4.00000049, 0], [4, 4], [0, 4]],
        [[1, 1], [1, 3], [3, 3], [3, 1], [1, 1]],
      ],
      type: "Polygon",
    };

    expect(bytes(first)).toEqual(bytes(second));
    expect(normalizeCanonicalGeometry(first, policy)).toEqual({
      type: "Polygon",
      coordinates: [
        [[0, 0], [4, 0], [4, 4], [0, 4], [0, 0]],
        [[1, 1], [1, 3], [3, 3], [3, 1], [1, 1]],
      ],
    });
  });

  it("sorts holes and MultiPolygon components independently of input order", () => {
    const shell = [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]];
    const leftHole = [[1, 1], [1, 2], [2, 2], [2, 1], [1, 1]];
    const rightHole = [[7, 7], [7, 8], [8, 8], [8, 7], [7, 7]];
    const farPolygon = [[[20, 20], [22, 20], [22, 22], [20, 20]]];
    const first = {
      type: "MultiPolygon",
      coordinates: [[shell, rightHole, leftHole], farPolygon],
    };
    const second = {
      type: "MultiPolygon",
      coordinates: [farPolygon, [shell, leftHole, rightHole]],
    };

    expect(bytes(first)).toEqual(bytes(second));
  });

  it("honors an explicit clockwise exterior policy while keeping holes opposite", () => {
    const geometry = {
      type: "Polygon",
      coordinates: [
        [[0, 0], [3, 0], [3, 3], [0, 0]],
        [[1, 1], [1.5, 2], [2, 1], [1, 1]],
      ],
    };
    const normalized = normalizeCanonicalGeometry(geometry, {
      coordinatePrecision: 3,
      exteriorRingWinding: "clockwise",
    });

    expect(normalized.coordinates).toEqual([
      [[0, 0], [3, 3], [3, 0], [0, 0]],
      [[1, 1], [2, 1], [1.5, 2], [1, 1]],
    ]);
  });

  it.each([
    ["negative precision", {...policy, coordinatePrecision: -1}],
    ["fractional precision", {...policy, coordinatePrecision: 1.5}],
    ["excess precision", {...policy, coordinatePrecision: 16}],
    ["unknown winding", {...policy, exteriorRingWinding: "automatic"}],
  ])("rejects an invalid geometry policy: %s", (_name, invalidPolicy) => {
    expect(() =>
      canonicalGeometrySerialize(
        {type: "Polygon", coordinates: [[[0, 0], [2, 0], [2, 2], [0, 0]]]},
        invalidPolicy as CanonicalGeometryPolicy,
      ),
    ).toThrow(/policy/i);
  });

  it("rejects geometry collapsed by the selected precision", () => {
    expect(() =>
      canonicalGeometrySerialize(
        {
          type: "Polygon",
          coordinates: [[[0, 0], [0.004, 0], [0.004, 0.004], [0, 0]]],
        },
        {coordinatePrecision: 2, exteriorRingWinding: "counterclockwise"},
      ),
    ).toThrow(/precision|area/i);
  });
});
