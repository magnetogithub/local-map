import {describe, expect, it} from "vitest";

import {createCountryIdRegistry} from "./country-id";
import {createTerritoryEntity} from "./territory-entity";
import {deriveTerritoryId} from "./territory-id";
import {assertTerritoryOwnerReferences} from "./territory-owner-invariants";

const territory = (sourceFeatureId: string, ownerCountryId: unknown) =>
  createTerritoryEntity({
    id: deriveTerritoryId({kind: "seed", seedVersion: "v1", sourceFeatureId}),
    ownerCountryId,
    geometry: {
      type: "Polygon",
      coordinates: [
        [
          [0, 0],
          [1, 0],
          [1, 1],
          [0, 1],
          [0, 0],
        ],
      ],
    },
    properties: {},
  });

describe("10-12 Territory owner reference invariant", () => {
  const registry = () =>
    createCountryIdRegistry({
      activeCountryIds: ["AAA", "BBB"],
      retiredCountryIds: ["OLD"],
    });

  it("accepts active owners and null unoccupied owners", () => {
    expect(() =>
      assertTerritoryOwnerReferences(
        [territory("owned", "AAA"), territory("unoccupied", null)],
        registry(),
      ),
    ).not.toThrow();
  });

  it("rejects an unknown ownerCountryId", () => {
    expect(() =>
      assertTerritoryOwnerReferences([territory("unknown", "ZZZ")], registry()),
    ).toThrowError(expect.objectContaining({code: "unknown-territory-owner"}));
  });

  it("rejects a retired ownerCountryId", () => {
    expect(() =>
      assertTerritoryOwnerReferences([territory("retired", "OLD")], registry()),
    ).toThrowError(expect.objectContaining({code: "retired-territory-owner"}));
  });

  it("reports the offending TerritoryId", () => {
    const invalidTerritory = territory("reported", "ZZZ");

    expect(() => assertTerritoryOwnerReferences([invalidTerritory], registry())).toThrow(
      invalidTerritory.id,
    );
  });
});
