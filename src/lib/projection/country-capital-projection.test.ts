import {describe, expect, it} from "vitest";

import {createCountryEntity} from "../world/country-entity";
import type {ActiveCountryId} from "../world/country-id";
import type {SeedCountryCapital} from "../world/seed-v1-to-v2";
import {createTopologyState} from "../world/topology-state";
import {createTerritoryEntity, type TerritoryGeometry} from "../world/territory-entity";
import {deriveTerritoryId, type TerritoryId} from "../world/territory-id";
import {
  createWorldStateV2,
  WORLD_STATE_V2_SCHEMA_VERSION,
  type WorldStateV2,
} from "../world/world-state-v2";
import {
  countDanglingCapitalFeatures,
  createCountryCapitalProjection,
  pointInTerritoryGeometry,
} from "./country-capital-projection";

const activeCountryId = (countryId: "AAA" | "BBB") => countryId as ActiveCountryId;

const rectangle = (x: number): TerritoryGeometry => ({
  type: "Polygon",
  coordinates: [[
    [x, 0],
    [x + 2, 0],
    [x + 2, 2],
    [x, 2],
    [x, 0],
  ]],
});

const country = (id: "AAA" | "BBB") => createCountryEntity({
  id: activeCountryId(id),
  names: {
    shortKo: id,
    officialKo: `${id} Republic`,
    mapKo: id,
    english: `${id} Republic`,
    searchAliases: [id],
  },
  politicalStatus: "sovereign",
  presentationOverride: null,
  moduleVersions: {capital: 1, core: 1, names: 1},
});

const territoryId = (sourceFeatureId: string) =>
  deriveTerritoryId({kind: "seed", seedVersion: "10-95-test", sourceFeatureId});

const territory = (
  id: TerritoryId,
  ownerCountryId: "AAA" | "BBB" | null,
  geometry: TerritoryGeometry,
) => createTerritoryEntity({
  id,
  ownerCountryId,
  geometry,
  properties: {sourceFeatureId: id},
});

const world = (
  revision: number,
  ownerCountryId: "AAA" | "BBB" | null,
): WorldStateV2 => {
  const alpha = territoryId("alpha");
  const beta = territoryId("beta");
  const territoriesById = {
    [alpha]: territory(alpha, ownerCountryId, rectangle(0)),
    [beta]: territory(beta, "BBB", rectangle(4)),
  };
  return createWorldStateV2({
    schemaVersion: WORLD_STATE_V2_SCHEMA_VERSION,
    seedVersion: "10-95-test",
    policyVersion: "world-policy-v1",
    revision,
    countriesById: {
      AAA: country("AAA"),
      BBB: country("BBB"),
    },
    countryOrder: [activeCountryId("AAA"), activeCountryId("BBB")],
    retiredCountryIds: [],
    territoriesById,
    territoryOrder: [alpha, beta],
    topology: createTopologyState([]),
    hashRoots: {
      countriesRootHash: null,
      presentationRootHash: null,
      territoriesRootHash: null,
      topologyRootHash: null,
    },
  });
};

const capitals: Readonly<Record<string, SeedCountryCapital>> = Object.freeze({
  AAA: Object.freeze({
    countryId: activeCountryId("AAA"),
    nameKo: "Alpha City",
    nameEn: "Alpha City",
    capitalType: "national",
    labelRank: 1,
    coordinates: Object.freeze([1, 1] as const),
  }),
});

describe("10-95 country capital projection", () => {
  it("projects capital dots with the currently owned containing Territory", () => {
    const state = world(20, "AAA");
    const projection = createCountryCapitalProjection(state, capitals);
    const feature = projection.featuresByCountryId.get(activeCountryId("AAA"));
    const ownedContainingTerritoryId = state.territoryOrder.find((territoryId) => {
      const candidate = state.territoriesById[territoryId];
      return candidate.ownerCountryId === "AAA" &&
        pointInTerritoryGeometry([1, 1], candidate.geometry);
    });

    expect(projection.revision).toBe(20);
    expect(feature?.properties.countryId).toBe("AAA");
    expect(feature?.properties.territoryId).toBe(ownedContainingTerritoryId);
    expect(feature?.geometry.coordinates).toEqual([1, 1]);
    expect(projection.featuresByCountryId.has(activeCountryId("BBB"))).toBe(false);
    expect(projection.features.filter(({properties}) => properties.countryId === "BBB"))
      .toHaveLength(0);
    expect(countDanglingCapitalFeatures(projection, state)).toBe(0);
  });

  it("drops capitals whose containing Territory is no longer owned by that country", () => {
    const transferred = world(21, "BBB");
    const projection = createCountryCapitalProjection(transferred, capitals);
    const containingTerritory = transferred.territoryOrder
      .map((territoryId) => transferred.territoriesById[territoryId])
      .find((territory) => pointInTerritoryGeometry([1, 1], territory.geometry));

    expect(containingTerritory?.ownerCountryId).toBe("BBB");
    expect(projection.featuresByCountryId.has(activeCountryId("AAA"))).toBe(false);
    expect(projection.features).toHaveLength(0);
    expect(countDanglingCapitalFeatures(projection, transferred)).toBe(0);
  });
});
