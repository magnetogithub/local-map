import {describe, expect, expectTypeOf, it} from "vitest";

import type {ActiveCountryId} from "./country-id";
import {
  assertSingleEffectiveControlRepresentation,
  TERRITORY_EFFECTIVE_OWNER_FIELD,
} from "./territory-control-invariant";
import {createTerritoryEntity, type TerritoryEntity} from "./territory-entity";
import {deriveTerritoryId} from "./territory-id";

const entityInput = (properties: Record<string, unknown> = {}) => ({
  id: deriveTerritoryId({kind: "seed", seedVersion: "v1", sourceFeatureId: "control"}),
  ownerCountryId: "AAA",
  geometry: {
    type: "Polygon" as const,
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
  properties,
});

describe("10-13 single effective control invariant", () => {
  it("defines ownerCountryId as the only scalar effective-owner field", () => {
    expect(TERRITORY_EFFECTIVE_OWNER_FIELD).toBe("ownerCountryId");
    expectTypeOf<TerritoryEntity["ownerCountryId"]>().toEqualTypeOf<
      ActiveCountryId | null
    >();
    expectTypeOf<TerritoryEntity["ownerCountryId"]>().not.toEqualTypeOf<
      readonly ActiveCountryId[]
    >();
  });

  it("accepts one scalar owner or null", () => {
    expect(() => assertSingleEffectiveControlRepresentation({ownerCountryId: "AAA"})).not.toThrow();
    expect(() => assertSingleEffectiveControlRepresentation({ownerCountryId: null})).not.toThrow();
  });

  it("rejects an array of multiple owners", () => {
    expect(() =>
      assertSingleEffectiveControlRepresentation({ownerCountryId: ["AAA", "BBB"]}),
    ).toThrowError(expect.objectContaining({code: "multiple-territory-owners"}));
    expect(() =>
      assertSingleEffectiveControlRepresentation({ownerCountryIds: ["AAA", "BBB"]}),
    ).toThrowError(expect.objectContaining({code: "multiple-territory-owners"}));
  });

  it.each([
    "ownerCountryIds",
    "controllerCountryId",
    "controllerCountryIds",
    "controllingCountryId",
    "controllingCountryIds",
    "effectiveOwnerCountryId",
    "effectiveControllerCountryId",
    "control",
  ])("rejects the overlapping control field %s", (field) => {
    expect(() =>
      assertSingleEffectiveControlRepresentation({ownerCountryId: "AAA", [field]: "BBB"}),
    ).toThrowError(expect.objectContaining({code: "overlapping-territory-control"}));
  });

  it.each(["ownerCountryIds", "controllerCountryId", "control"])(
    "rejects overlapping control stored in Territory properties: %s",
    (field) => {
      expect(() => createTerritoryEntity(entityInput({[field]: "BBB"}))).toThrowError(
        expect.objectContaining({code: "overlapping-territory-control"}),
      );
    },
  );
});
