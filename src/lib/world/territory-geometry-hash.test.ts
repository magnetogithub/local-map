import {describe, expect, it} from "vitest";

import type {CanonicalGeometryPolicy} from "./canonical-geometry-serializer";
import {createTerritoryEntity} from "./territory-entity";
import {territoryGeometryLeafHash} from "./territory-geometry-hash";
import {deriveTerritoryId} from "./territory-id";

const policy: CanonicalGeometryPolicy = {
  coordinatePrecision: 6,
  exteriorRingWinding: "counterclockwise",
};
const territory = (geometry: unknown, ownerCountryId: string | null, source = "alpha") =>
  createTerritoryEntity({
    id: deriveTerritoryId({kind: "seed", seedVersion: "v2", sourceFeatureId: source}),
    ownerCountryId,
    geometry,
    properties: {sourceFeatureId: source},
  });

describe("10-24 territoryGeometry leaf hash", () => {
  it("ignores owner, Territory ID, and scalar property changes", () => {
    const geometry = {
      type: "Polygon",
      coordinates: [[[0, 0], [4, 0], [4, 4], [0, 0]]],
    };
    const owned = territory(geometry, "AAA", "alpha");
    const unclaimed = territory(geometry, null, "beta");

    expect(territoryGeometryLeafHash(owned, policy)).toBe(
      territoryGeometryLeafHash(unclaimed, policy),
    );
  });

  it("hashes equivalent precision/winding-normalized geometry identically", () => {
    const clockwise = territory(
      {type: "Polygon", coordinates: [[[4.0000004, 4], [4, 0], [0, 0], [4.0000004, 4]]]},
      "AAA",
    );
    const counterclockwise = territory(
      {type: "Polygon", coordinates: [[[0, 0], [4.00000049, 0], [4, 4], [0, 0]]]},
      "AAA",
    );

    expect(territoryGeometryLeafHash(clockwise, policy)).toBe(
      territoryGeometryLeafHash(counterclockwise, policy),
    );
  });

  it("changes when normalized geometry changes", () => {
    const first = territory(
      {type: "Polygon", coordinates: [[[0, 0], [4, 0], [4, 4], [0, 0]]]},
      "AAA",
    );
    const changed = territory(
      {type: "Polygon", coordinates: [[[0, 0], [5, 0], [4, 4], [0, 0]]]},
      "AAA",
    );

    expect(territoryGeometryLeafHash(first, policy)).not.toBe(
      territoryGeometryLeafHash(changed, policy),
    );
  });
});
