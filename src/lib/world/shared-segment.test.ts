import {describe, expect, it} from "vitest";

import type {TerritoryGeometry} from "./territory-entity";
import {
  canonicalizeTopologySegment,
  extractSharedTopologySegments,
} from "./shared-segment";

const square = (minX: number, minY: number): TerritoryGeometry => ({
  type: "Polygon",
  coordinates: [[
    [minX, minY], [minX + 1, minY], [minX + 1, minY + 1],
    [minX, minY + 1], [minX, minY],
  ]],
});

describe("10-48 shared segment extraction", () => {
  it("extracts a real shared boundary and ignores bbox-only overlap", () => {
    expect(extractSharedTopologySegments(square(0, 0), square(1, 0))).toEqual([
      [[1, 0], [1, 1]],
    ]);
    expect(extractSharedTopologySegments(square(0, 0), square(0.5, 0.5))).toEqual([]);
  });

  it("canonicalizes reversed dateline segments to the same short segment", () => {
    const forward = canonicalizeTopologySegment([179, 0], [-179, 0]);
    const reverse = canonicalizeTopologySegment([-179, 0], [179, 0]);

    expect(forward).toEqual(reverse);
    expect(Math.abs(forward[1][0] - forward[0][0])).toBe(2);
  });
});
