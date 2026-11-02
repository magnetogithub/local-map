import {describe, expect, it} from "vitest";

import {
  normalizeTopologyGeometry,
  topologyGeometryHash,
  type TopologyGeometryPolicy,
} from "./topology-geometry-policy";

const policy: TopologyGeometryPolicy = {
  version: "test-v1",
  coordinatePrecision: 3,
  exteriorRingWinding: "counterclockwise",
  minimumRingArea: 0.01,
};

describe("10-46 topology geometry policy", () => {
  it("normalizes precision, winding, start point, and hash deterministically", () => {
    const forward = {type: "Polygon", coordinates: [[
      [1.0004, 1.0004], [1.0004, 0.0004], [0.0004, 0.0004],
      [0.0004, 1.0004], [1.0004, 1.0004],
    ]]};
    const reversed = {type: "Polygon", coordinates: [[
      [0.0004, 0.0004], [1.0004, 0.0004], [1.0004, 1.0004],
      [0.0004, 1.0004], [0.0004, 0.0004],
    ]]};

    expect(normalizeTopologyGeometry(forward, policy)).toEqual(normalizeTopologyGeometry(reversed, policy));
    expect(topologyGeometryHash(forward, policy)).toBe(topologyGeometryHash(reversed, policy));
  });

  it("rejects rings below the selected minimum area", () => {
    expect(() => normalizeTopologyGeometry({
      type: "Polygon",
      coordinates: [[[0, 0], [0.01, 0], [0, 0.01], [0, 0]]],
    }, policy)).toThrow(/minimumRingArea/);
  });
});
