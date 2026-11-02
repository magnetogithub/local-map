import {describe, expect, expectTypeOf, it} from "vitest";

import {createCountryEntity, type CountryEntity} from "./country-entity";
import {createCountryIdRegistry, issueCountryId} from "./country-id";
import {createTerritoryEntity, type TerritoryEntity} from "./territory-entity";
import {deriveTerritoryId} from "./territory-id";
import {createTopologyState, type TopologyEdge} from "./topology-state";
import {
  createWorldStateV2,
  WORLD_STATE_V2_SCHEMA_VERSION,
  type WorldStateV2,
} from "./world-state-v2";

const fixture = () => {
  const countryIdRegistry = createCountryIdRegistry({
    activeCountryIds: [],
    retiredCountryIds: ["OLD"],
  });
  const countryId = issueCountryId("AAA", countryIdRegistry);
  const country = createCountryEntity({
    id: countryId,
    names: {
      shortKo: "Example",
      officialKo: "Example Republic",
      mapKo: "Example",
      english: "Example",
      searchAliases: ["AAA"],
    },
    politicalStatus: "sovereign",
    presentationOverride: null,
    moduleVersions: {core: 1, names: 1},
  });
  const territoryId = deriveTerritoryId({
    kind: "seed",
    seedVersion: "seed-v1",
    sourceFeatureId: "AAA",
  });
  const territory = createTerritoryEntity({
    id: territoryId,
    ownerCountryId: countryId,
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
    properties: {sourceFeatureId: "AAA"},
  });
  return {
    schemaVersion: WORLD_STATE_V2_SCHEMA_VERSION,
    seedVersion: "seed-v1",
    policyVersion: "world-policy-v1",
    revision: 0,
    countriesById: {[country.id]: country},
    countryOrder: [country.id],
    retiredCountryIds: countryIdRegistry.retiredCountryIds,
    territoriesById: {[territory.id]: territory},
    territoryOrder: [territory.id],
    topology: createTopologyState([]),
    hashRoots: {
      countriesRootHash: null,
      territoriesRootHash: null,
      topologyRootHash: null,
      presentationRootHash: null,
    },
  };
};

describe("10-18 WorldState v2 container", () => {
  it("contains the eleven responsibility-separated domain fields", () => {
    const state = createWorldStateV2(fixture());

    expect(Object.keys(state).sort()).toEqual([
      "countriesById",
      "countryOrder",
      "hashRoots",
      "policyVersion",
      "retiredCountryIds",
      "revision",
      "schemaVersion",
      "seedVersion",
      "territoriesById",
      "territoryOrder",
      "topology",
    ]);
    expectTypeOf<keyof WorldStateV2>().toEqualTypeOf<
      | "schemaVersion"
      | "seedVersion"
      | "policyVersion"
      | "revision"
      | "countriesById"
      | "countryOrder"
      | "retiredCountryIds"
      | "territoriesById"
      | "territoryOrder"
      | "topology"
      | "hashRoots"
    >();
    expect(Object.isFrozen(state)).toBe(true);
  });

  it("does not overlap country, territory, and topology responsibilities", () => {
    type CountryGeometryOverlap = Extract<keyof CountryEntity, "geometry" | "properties">;
    type TerritoryCountryOverlap = Extract<
      keyof TerritoryEntity,
      "names" | "politicalStatus" | "presentationOverride" | "moduleVersions"
    >;
    type TopologyOwnerOverlap = Extract<keyof TopologyEdge, "countryId" | "ownerCountryId">;

    expectTypeOf<CountryGeometryOverlap>().toEqualTypeOf<never>();
    expectTypeOf<TerritoryCountryOverlap>().toEqualTypeOf<never>();
    expectTypeOf<TopologyOwnerOverlap>().toEqualTypeOf<never>();
  });

  it("requires country and territory records to match their deterministic orders", () => {
    const input = fixture();

    expect(() => createWorldStateV2({...input, countryOrder: []})).toThrow(/countryOrder/);
    expect(() => createWorldStateV2({...input, territoryOrder: []})).toThrow(/territoryOrder/);
  });

  it("enforces owner references across the combined domains", () => {
    const input = fixture();
    const [territoryId] = input.territoryOrder;
    const invalidTerritory = createTerritoryEntity({
      ...input.territoriesById[territoryId],
      ownerCountryId: "UNKNOWN",
    });

    expect(() =>
      createWorldStateV2({
        ...input,
        territoriesById: {[territoryId]: invalidTerritory},
      }),
    ).toThrowError(expect.objectContaining({code: "unknown-territory-owner"}));
  });

  it("rejects topology references to territories outside the territory domain", () => {
    const input = fixture();
    const unknownTerritoryId = deriveTerritoryId({
      kind: "seed",
      seedVersion: "seed-v1",
      sourceFeatureId: "UNKNOWN",
    });
    const topology = createTopologyState([
      {
        id: "topology-edge:unknown-coast",
        territoryIds: [unknownTerritoryId, null],
        classification: "coast",
        coordinates: [
          [0, 0],
          [1, 0],
        ],
      },
    ]);

    expect(() => createWorldStateV2({...input, topology})).toThrow(/unknown TerritoryId/);
  });

  it("rejects a forged or asymmetric topology neighbor index", () => {
    const input = fixture();
    const [territoryId] = input.territoryOrder;
    const forgedTopology = {
      edgesById: {},
      neighborTerritoryIdsById: {[territoryId]: [territoryId]},
    };

    expect(() =>
      createWorldStateV2({...input, topology: forgedTopology as typeof input.topology}),
    ).toThrow(/neighbor index/i);
  });

  it("defensively snapshots raw collections, entities, topology, and hash roots", () => {
    const input = fixture();
    const [countryId] = input.countryOrder;
    const [territoryId] = input.territoryOrder;
    const rawCountry = {...input.countriesById[countryId]};
    const rawTerritory = {
      ...input.territoriesById[territoryId],
      geometry: JSON.parse(JSON.stringify(input.territoriesById[territoryId].geometry)),
      properties: {...input.territoriesById[territoryId].properties},
    };
    const rawTopology: {
      edgesById: Record<string, never>;
      neighborTerritoryIdsById: Record<string, string[]>;
    } = {edgesById: {}, neighborTerritoryIdsById: {}};
    const rawHashRoots: Record<keyof typeof input.hashRoots, string | null> = {
      ...input.hashRoots,
    };
    const state = createWorldStateV2({
      ...input,
      countriesById: {[countryId]: rawCountry},
      territoriesById: {[territoryId]: rawTerritory},
      topology: rawTopology as unknown as typeof input.topology,
      hashRoots: rawHashRoots,
    });

    rawCountry.politicalStatus = "dependent";
    rawTerritory.properties.sourceFeatureId = "MUTATED";
    rawTerritory.geometry.coordinates[0][0][0] = 99;
    rawTopology.neighborTerritoryIdsById[territoryId] = [territoryId];
    rawHashRoots.countriesRootHash = "MUTATED";

    expect(state.countriesById[countryId].politicalStatus).toBe("sovereign");
    expect(state.territoriesById[territoryId].properties.sourceFeatureId).toBe("AAA");
    expect(state.territoriesById[territoryId].geometry.coordinates[0][0]).toEqual([0, 0]);
    expect(state.topology.neighborTerritoryIdsById[territoryId]).toBeUndefined();
    expect(state.hashRoots.countriesRootHash).toBeNull();
  });
});
