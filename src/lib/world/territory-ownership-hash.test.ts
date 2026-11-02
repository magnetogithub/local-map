import {describe, expect, it} from "vitest";

import {createTerritoryEntity} from "./territory-entity";
import {deriveTerritoryId} from "./territory-id";
import {territoryOwnershipLeafHash} from "./territory-ownership-hash";

const territory = (
  sourceFeatureId: string,
  ownerCountryId: string | null,
  width = 2,
  propertyValue = "source",
) =>
  createTerritoryEntity({
    id: deriveTerritoryId({kind: "seed", seedVersion: "v2", sourceFeatureId}),
    ownerCountryId,
    geometry: {
      type: "Polygon",
      coordinates: [[[0, 0], [width, 0], [width, 2], [0, 0]]],
    },
    properties: {value: propertyValue},
  });

describe("10-25 territoryOwnership leaf hash", () => {
  it("ignores geometry coordinates and Territory properties", () => {
    expect(territoryOwnershipLeafHash(territory("alpha", "AAA", 2, "one"))).toBe(
      territoryOwnershipLeafHash(territory("alpha", "AAA", 8, "two")),
    );
  });

  it("changes when owner changes, including unclaim", () => {
    const owned = territoryOwnershipLeafHash(territory("alpha", "AAA"));
    const transferred = territoryOwnershipLeafHash(territory("alpha", "BBB"));
    const unclaimed = territoryOwnershipLeafHash(territory("alpha", null));

    expect(new Set([owned, transferred, unclaimed])).toHaveLength(3);
  });

  it("includes Territory ID even for the same owner", () => {
    expect(territoryOwnershipLeafHash(territory("alpha", "AAA"))).not.toBe(
      territoryOwnershipLeafHash(territory("beta", "AAA")),
    );
  });
});
