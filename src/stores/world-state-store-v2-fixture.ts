// Shared V2 store test fixture; not a standalone test suite.
import {createCountryEntity, type CountryEntity} from "@/lib/world/country-entity";
import type {ActiveCountryId, RetiredCountryId} from "@/lib/world/country-id";
import {deriveTerritoryId} from "@/lib/world/territory-id";
import {createTopologyState} from "@/lib/world/topology-state";
import {createWorldStateV2, WORLD_STATE_V2_SCHEMA_VERSION, type WorldStateV2} from "@/lib/world/world-state-v2";

const activeCountryId = (id: string) => id as ActiveCountryId;
const hex = (value: string) => value.repeat(64);
const seedVersion = "store-test-seed-v1";

export const testCommit = (
  nextState: WorldStateV2,
  previousCommitHash: string | null = null,
  commandId = `command-${nextState.revision}`,
) => ({
  commandId,
  revision: nextState.revision,
  worldContentHash: hex("1"),
  previousCommitHash,
  commitHash: hex(String((nextState.revision % 9) + 1)),
});

export const testCountry = (id: string, mapKo = id): CountryEntity =>
  createCountryEntity({
    id: activeCountryId(id),
    names: {
      shortKo: id,
      officialKo: id,
      mapKo,
      english: id,
      searchAliases: [id],
    },
    politicalStatus: "sovereign",
    presentationOverride: null,
    moduleVersions: {core: 1, names: 1},
  });

const territoryFor = (countryId: string) => {
  const offset = countryId.charCodeAt(0);
  return {
    id: deriveTerritoryId({
      kind: "seed",
      seedVersion,
      sourceFeatureId: countryId,
    }),
    ownerCountryId: activeCountryId(countryId),
    geometry: {
      type: "Polygon",
      coordinates: [[
        [offset, 0],
        [offset + 1, 0],
        [offset + 1, 1],
        [offset, 0],
      ]],
    },
    properties: {sourceFeatureId: countryId},
  };
};

export const testWorldState = (
  recordOrder: readonly string[],
  countryOrder: readonly string[] = recordOrder,
): WorldStateV2 => {
  const countriesById = Object.fromEntries(
    recordOrder.map((id) => [id, testCountry(id)]),
  );
  const territories = countryOrder.map(territoryFor);
  return createWorldStateV2({
    schemaVersion: WORLD_STATE_V2_SCHEMA_VERSION,
    seedVersion,
    policyVersion: "store-test-policy-v1",
    revision: 0,
    countriesById,
    countryOrder: countryOrder.map(activeCountryId),
    retiredCountryIds: [],
    territoriesById: Object.fromEntries(territories.map((territory) => [territory.id, territory])),
    territoryOrder: territories.map((territory) => territory.id),
    topology: createTopologyState([]),
    hashRoots: {
      countriesRootHash: null,
      presentationRootHash: null,
      territoriesRootHash: null,
      topologyRootHash: null,
    },
  });
};

export const replaceCountry = (
  state: WorldStateV2,
  country: CountryEntity,
): WorldStateV2 => Object.freeze({
  ...state,
  revision: state.revision + 1,
  countriesById: Object.freeze({...state.countriesById, [country.id]: country}),
});

export const addCountry = (
  state: WorldStateV2,
  country: CountryEntity,
): WorldStateV2 => {
  const territory = territoryFor(country.id);
  return createWorldStateV2({
    ...state,
    revision: state.revision + 1,
    countriesById: {...state.countriesById, [country.id]: country},
    countryOrder: [...state.countryOrder, country.id],
    territoriesById: {...state.territoriesById, [territory.id]: territory},
    territoryOrder: [...state.territoryOrder, territory.id],
  });
};

export const removeCountry = (
  state: WorldStateV2,
  countryId: string,
): WorldStateV2 => {
  const removedTerritoryIds = new Set(
    state.territoryOrder.filter(
      (territoryId) => state.territoriesById[territoryId].ownerCountryId === countryId,
    ),
  );
  const countriesById = {...state.countriesById};
  delete countriesById[countryId];
  const territoriesById = {...state.territoriesById};
  for (const territoryId of removedTerritoryIds) delete territoriesById[territoryId];
  return createWorldStateV2({
    ...state,
    revision: state.revision + 1,
    countriesById,
    countryOrder: state.countryOrder.filter((id) => id !== countryId),
    retiredCountryIds: [...state.retiredCountryIds, countryId as RetiredCountryId],
    territoriesById,
    territoryOrder: state.territoryOrder.filter((id) => !removedTerritoryIds.has(id)),
  });
};

export const withNextRevision = (state: WorldStateV2, revision: number): WorldStateV2 =>
  createWorldStateV2({...state, revision});
