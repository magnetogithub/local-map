import {describe, expect, expectTypeOf, it} from "vitest";

import {createCountryIdRegistry, issueCountryId, type ActiveCountryId} from "./country-id";
import {
  createTerritoryEntity,
  type TerritoryEntity,
  type TerritoryProperties,
} from "./territory-entity";
import {deriveTerritoryId} from "./territory-id";

const territoryInput = () => ({
  id: deriveTerritoryId({
    kind: "seed",
    seedVersion: "natural-earth-v1",
    sourceFeatureId: "feature-123",
  }),
  ownerCountryId: issueCountryId(
    "AAA",
    createCountryIdRegistry({activeCountryIds: [], retiredCountryIds: []}),
  ),
  geometry: {
    type: "Polygon" as const,
    coordinates: [
      [
        [0, 0],
        [2, 0],
        [2, 2],
        [0, 2],
        [0, 0],
      ],
    ],
  },
  properties: {landClass: "land", sourceFeatureId: "feature-123"},
});

describe("10-11 TerritoryEntity", () => {
  it("contains exactly id, nullable ownerCountryId, geometry, and properties", () => {
    const territory = createTerritoryEntity(territoryInput());

    expect(Object.keys(territory).sort()).toEqual([
      "geometry",
      "id",
      "ownerCountryId",
      "properties",
    ]);
    expectTypeOf<keyof TerritoryEntity>().toEqualTypeOf<
      "id" | "ownerCountryId" | "geometry" | "properties"
    >();
    expectTypeOf<TerritoryEntity["ownerCountryId"]>().toEqualTypeOf<
      ActiveCountryId | null
    >();
    expect(Object.isFrozen(territory)).toBe(true);
    expect(Object.isFrozen(territory.properties)).toBe(true);
  });

  it("accepts null as an unoccupied territory owner", () => {
    expect(createTerritoryEntity({...territoryInput(), ownerCountryId: null}).ownerCountryId).toBe(
      null,
    );
  });

  it.each([
    "names",
    "politicalStatus",
    "presentation",
    "presentationOverride",
    "moduleVersions",
    "economy",
    "diplomacy",
    "focusTree",
  ])("rejects duplicated country metadata at the top level: %s", (field) => {
    expect(() => createTerritoryEntity({...territoryInput(), [field]: {}})).toThrow(
      /unknown or missing/,
    );
  });

  it.each(["names", "politicalStatus", "presentationOverride", "moduleVersions"])(
    "rejects duplicated country metadata inside properties: %s",
    (field) => {
      expect(() =>
        createTerritoryEntity({
          ...territoryInput(),
          properties: {...territoryInput().properties, [field]: "duplicate"},
        }),
      ).toThrow(/country metadata/);
    },
  );

  it("keeps TerritoryProperties free of known CountryEntity fields", () => {
    type DuplicatedCountryMetadata = Extract<
      keyof TerritoryProperties,
      "names" | "politicalStatus" | "presentationOverride" | "moduleVersions"
    >;
    expectTypeOf<DuplicatedCountryMetadata>().toEqualTypeOf<never>();
  });

  it.each([
    {type: "Polygon", coordinates: []},
    {type: "MultiPolygon", coordinates: []},
    {type: "Polygon", coordinates: [[]]},
    {
      type: "Polygon",
      coordinates: [[[0, 0], [1, 0], [0, 0]]],
    },
    {
      type: "Polygon",
      coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1]]],
    },
    {
      type: "Polygon",
      coordinates: [[[0, 0], [1, 0], [2, 0], [0, 0]]],
    },
    {
      type: "Polygon",
      coordinates: [[[0, 0], [Number.NaN, 0], [1, 1], [0, 0]]],
    },
  ])("rejects malformed non-empty GeoJSON geometry %#", (geometry) => {
    expect(() => createTerritoryEntity({...territoryInput(), geometry})).toThrow(/geometry|ring|area|position/i);
  });

  it("deep-copies geometry and properties instead of retaining mutable input aliases", () => {
    const source = territoryInput();
    const territory = createTerritoryEntity(source);

    source.geometry.coordinates[0][0][0] = 99;
    source.properties.landClass = "mutated";

    expect(territory.geometry.coordinates[0][0]).toEqual([0, 0]);
    expect(territory.properties.landClass).toBe("land");
    expect(Object.isFrozen(territory.geometry)).toBe(true);
    expect(Object.isFrozen(territory.geometry.coordinates)).toBe(true);
    expect(Object.isFrozen(territory.geometry.coordinates[0])).toBe(true);
    expect(Object.isFrozen(territory.geometry.coordinates[0][0])).toBe(true);
  });
});
