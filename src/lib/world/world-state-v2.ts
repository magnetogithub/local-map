import {createCountryEntity, type CountryEntity} from "./country-entity";
import {
  createCountryIdRegistry,
  type ActiveCountryId,
  type RetiredCountryId,
} from "./country-id";
import {createCountryOrder, type CountryOrder} from "./country-order";
import {createTerritoryEntity, type TerritoryEntity} from "./territory-entity";
import type {TerritoryId} from "./territory-id";
import {createTerritoryOrder, type TerritoryOrder} from "./territory-order";
import {assertTerritoryOwnerReferences} from "./territory-owner-invariants";
import {createTopologyStateSnapshot, type TopologyState} from "./topology-state";

export const WORLD_STATE_V2_SCHEMA_VERSION = 2 as const;

export type WorldStateV2HashRoots = Readonly<{
  countriesRootHash: string | null;
  territoriesRootHash: string | null;
  topologyRootHash: string | null;
  presentationRootHash: string | null;
}>;

export type WorldStateV2 = Readonly<{
  schemaVersion: typeof WORLD_STATE_V2_SCHEMA_VERSION;
  seedVersion: string;
  policyVersion: string;
  revision: number;
  countriesById: Readonly<Record<string, CountryEntity>>;
  countryOrder: CountryOrder;
  retiredCountryIds: ReadonlySet<RetiredCountryId>;
  territoriesById: Readonly<Record<string, TerritoryEntity>>;
  territoryOrder: TerritoryOrder;
  topology: TopologyState;
  hashRoots: WorldStateV2HashRoots;
}>;

export type SerializedWorldStateV2 = Omit<WorldStateV2, "retiredCountryIds"> & Readonly<{
  retiredCountryIds: readonly RetiredCountryId[];
}>;

export function serializeWorldStateV2(state: WorldStateV2): SerializedWorldStateV2 {
  return {...state, retiredCountryIds: [...state.retiredCountryIds]};
}

export function deserializeWorldStateV2(serialized: SerializedWorldStateV2): WorldStateV2 {
  return createWorldStateV2(serialized);
}

export type WorldStateV2Input = Readonly<{
  schemaVersion: unknown;
  seedVersion: unknown;
  policyVersion: unknown;
  revision: unknown;
  countriesById: unknown;
  countryOrder: Iterable<ActiveCountryId>;
  retiredCountryIds: Iterable<RetiredCountryId>;
  territoriesById: unknown;
  territoryOrder: Iterable<TerritoryId>;
  topology: TopologyState;
  hashRoots: unknown;
}>;

const worldStateKeys = [
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
] as const;

const hashRootKeys = [
  "countriesRootHash",
  "presentationRootHash",
  "territoriesRootHash",
  "topologyRootHash",
] as const;

const assertExactKeys = (value: object, expected: readonly string[], context: string) => {
  const actual = Object.keys(value).sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${context} contains unknown or missing fields`);
  }
};

const readCanonicalVersion = (value: unknown, context: string) => {
  if (typeof value !== "string" || value.trim().length === 0 || value !== value.trim()) {
    throw new Error(`${context} must be a non-empty canonical string`);
  }
  return value;
};

const readRecord = (value: unknown, context: string): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${context} must be an object record`);
  }
  return value as Record<string, unknown>;
};

const readHashRoots = (value: unknown): WorldStateV2HashRoots => {
  const input = readRecord(value, "WorldStateV2.hashRoots");
  assertExactKeys(input, hashRootKeys, "WorldStateV2.hashRoots");
  const readRoot = (field: (typeof hashRootKeys)[number]) => {
    const root = input[field];
    if (root === null) return null;
    return readCanonicalVersion(root, `WorldStateV2.hashRoots.${field}`);
  };
  return Object.freeze({
    countriesRootHash: readRoot("countriesRootHash"),
    territoriesRootHash: readRoot("territoriesRootHash"),
    topologyRootHash: readRoot("topologyRootHash"),
    presentationRootHash: readRoot("presentationRootHash"),
  });
};

const buildCountryRecord = (
  value: unknown,
  countryOrder: CountryOrder,
): Readonly<Record<string, CountryEntity>> => {
  const input = readRecord(value, "WorldStateV2.countriesById");
  const recordIds = Object.keys(input).sort();
  if (
    recordIds.length !== countryOrder.length ||
    recordIds.some((countryId, index) => countryId !== countryOrder[index])
  ) {
    throw new Error("WorldStateV2 countriesById and countryOrder must contain the same IDs");
  }
  const output: Record<string, CountryEntity> = {};
  for (const countryId of countryOrder) {
    const country = input[countryId];
    if (!country || typeof country !== "object" || Array.isArray(country)) {
      throw new Error(`WorldStateV2 country record is invalid: ${countryId}`);
    }
    const snapshot = createCountryEntity(country);
    if (snapshot.id !== countryId) {
      throw new Error(`WorldStateV2 country record key does not match entity id: ${countryId}`);
    }
    output[countryId] = snapshot;
  }
  return Object.freeze(output);
};

const buildTerritoryRecord = (
  value: unknown,
  territoryOrder: TerritoryOrder,
): Readonly<Record<string, TerritoryEntity>> => {
  const input = readRecord(value, "WorldStateV2.territoriesById");
  const recordIds = Object.keys(input).sort();
  if (
    recordIds.length !== territoryOrder.length ||
    recordIds.some((territoryId, index) => territoryId !== territoryOrder[index])
  ) {
    throw new Error("WorldStateV2 territoriesById and territoryOrder must contain the same IDs");
  }
  const output: Record<string, TerritoryEntity> = {};
  for (const territoryId of territoryOrder) {
    const territory = input[territoryId];
    if (!territory || typeof territory !== "object" || Array.isArray(territory)) {
      throw new Error(`WorldStateV2 territory record is invalid: ${territoryId}`);
    }
    const snapshot = createTerritoryEntity(territory);
    if (snapshot.id !== territoryId) {
      throw new Error(`WorldStateV2 territory record key does not match entity id: ${territoryId}`);
    }
    output[territoryId] = snapshot;
  }
  return Object.freeze(output);
};

const assertTopologyReferences = (
  topology: TopologyState,
  territoriesById: Readonly<Record<string, TerritoryEntity>>,
) => {
  for (const edge of Object.values(topology.edgesById)) {
    for (const territoryId of edge.territoryIds) {
      if (territoryId !== null && !territoriesById[territoryId]) {
        throw new Error(`Topology edge ${edge.id} references unknown TerritoryId ${territoryId}`);
      }
    }
  }
  for (const [territoryId, neighbors] of Object.entries(
    topology.neighborTerritoryIdsById,
  )) {
    if (!territoriesById[territoryId]) {
      throw new Error(`Topology neighbor index references unknown TerritoryId ${territoryId}`);
    }
    for (const neighborTerritoryId of neighbors) {
      if (!territoriesById[neighborTerritoryId]) {
        throw new Error(
          `Topology neighbor index references unknown TerritoryId ${neighborTerritoryId}`,
        );
      }
    }
  }
};

export function createWorldStateV2(input: WorldStateV2Input): WorldStateV2 {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("WorldStateV2 input must be an object");
  }
  assertExactKeys(input, worldStateKeys, "WorldStateV2");
  if (input.schemaVersion !== WORLD_STATE_V2_SCHEMA_VERSION) {
    throw new Error(`WorldStateV2.schemaVersion must be ${WORLD_STATE_V2_SCHEMA_VERSION}`);
  }
  if (!Number.isSafeInteger(input.revision) || (input.revision as number) < 0) {
    throw new Error("WorldStateV2.revision must be a non-negative safe integer");
  }

  const countryOrder = createCountryOrder(input.countryOrder);
  const countriesById = buildCountryRecord(input.countriesById, countryOrder);
  const countryIdRegistry = createCountryIdRegistry({
    activeCountryIds: countryOrder,
    retiredCountryIds: input.retiredCountryIds,
  });
  const territoryOrder = createTerritoryOrder(input.territoryOrder);
  const territoriesById = buildTerritoryRecord(input.territoriesById, territoryOrder);
  const topology = createTopologyStateSnapshot(input.topology);
  assertTerritoryOwnerReferences(Object.values(territoriesById), countryIdRegistry);
  assertTopologyReferences(topology, territoriesById);

  return Object.freeze({
    schemaVersion: WORLD_STATE_V2_SCHEMA_VERSION,
    seedVersion: readCanonicalVersion(input.seedVersion, "WorldStateV2.seedVersion"),
    policyVersion: readCanonicalVersion(input.policyVersion, "WorldStateV2.policyVersion"),
    revision: input.revision as number,
    countriesById,
    countryOrder,
    retiredCountryIds: countryIdRegistry.retiredCountryIds,
    territoriesById,
    territoryOrder,
    topology,
    hashRoots: readHashRoots(input.hashRoots),
  });
}

export function assertWorldStateV2(value: unknown): asserts value is WorldStateV2 {
  createWorldStateV2(value as WorldStateV2Input);
}
