import {canonicalSerialize} from "../world/canonical-serializer";
import {createTopologyState, type TopologyEdge} from "../world/topology-state";
import type {CountryEntity} from "../world/country-entity";
import type {ActiveCountryId, RetiredCountryId} from "../world/country-id";
import {sha256Hex} from "../world/sha256";
import type {TerritoryEntity} from "../world/territory-entity";
import type {TerritoryId} from "../world/territory-id";
import {
  createWorldStateV2,
  WORLD_STATE_V2_SCHEMA_VERSION,
  type WorldStateV2,
} from "../world/world-state-v2";
import {historyHash} from "../world/purpose-hashes";
import type {WorldPatchV2, WorldPatchV2EntityChangeSets} from "./world-patch-v2";

export type DomainBeforeAfterImage<Entity> = Readonly<{
  before: Entity | null;
  after: Entity | null;
}>;

export type DomainBeforeImage = Readonly<{
  countriesById: Readonly<Record<string, DomainBeforeAfterImage<CountryEntity>>>;
  territoriesById: Readonly<Record<string, DomainBeforeAfterImage<TerritoryEntity>>>;
  topologyEdgesById: Readonly<Record<string, DomainBeforeAfterImage<TopologyEdge>>>;
  retiredCountryIds: DomainBeforeAfterImage<readonly RetiredCountryId[]>;
}>;

export type HistoryEntry = Readonly<{
  commandId: string;
  beforeRevision: number;
  afterRevision: number;
  beforeContentHash: string;
  afterContentHash: string;
  beforeImage: DomainBeforeImage;
  commandHash: string;
  redoPlan: unknown;
}>;

export type WorldHistory = Readonly<{
  entries: readonly HistoryEntry[];
  pointer: number;
  historyHash: string;
  currentRevision: number;
}>;

export type WorldStateV2Serialized = Readonly<{
  schemaVersion: typeof WORLD_STATE_V2_SCHEMA_VERSION;
  seedVersion: string;
  policyVersion: string;
  revision: number;
  countriesById: Readonly<Record<string, CountryEntity>>;
  countryOrder: readonly ActiveCountryId[];
  retiredCountryIds: readonly RetiredCountryId[];
  territoriesById: Readonly<Record<string, TerritoryEntity>>;
  territoryOrder: readonly TerritoryId[];
  topology: WorldStateV2["topology"];
  hashRoots: WorldStateV2["hashRoots"];
}>;

export type Prompt09MigrationResult = Readonly<{
  worldState: WorldStateV2;
  ignoredCountryIds: readonly string[];
}>;

const domainStateKeys = new Set([
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

const compareText = (left: string, right: string) => left < right ? -1 : left > right ? 1 : 0;
const hashCanonical = (value: unknown) => sha256Hex(canonicalSerialize(value));

const idsFromChangeSet = <Id extends string>(changeSet: {
  created: readonly Id[];
  updated: readonly Id[];
  deleted: readonly Id[];
}) => [...new Set([...changeSet.created, ...changeSet.updated, ...changeSet.deleted])]
  .sort(compareText);

export function checkpointWorldContentHash(state: WorldStateV2): string {
  return hashCanonical({
    namespace: "checkpointWorldContent",
    schemaVersion: state.schemaVersion,
    seedVersion: state.seedVersion,
    policyVersion: state.policyVersion,
    countriesById: state.countriesById,
    countryOrder: state.countryOrder,
    retiredCountryIds: [...state.retiredCountryIds].sort(compareText),
    territoriesById: state.territoriesById,
    territoryOrder: state.territoryOrder,
    topology: state.topology,
    hashRoots: state.hashRoots,
  });
}

export function createDomainBeforeImage(
  beforeState: WorldStateV2,
  afterState: WorldStateV2,
  changeSets: WorldPatchV2EntityChangeSets,
): DomainBeforeImage {
  const countriesById: Record<string, DomainBeforeAfterImage<CountryEntity>> = {};
  for (const countryId of idsFromChangeSet(changeSets.countries)) {
    countriesById[countryId] = Object.freeze({
      before: beforeState.countriesById[countryId] ?? null,
      after: afterState.countriesById[countryId] ?? null,
    });
  }
  const territoriesById: Record<string, DomainBeforeAfterImage<TerritoryEntity>> = {};
  for (const territoryId of idsFromChangeSet(changeSets.territories)) {
    territoriesById[territoryId] = Object.freeze({
      before: beforeState.territoriesById[territoryId] ?? null,
      after: afterState.territoriesById[territoryId] ?? null,
    });
  }
  const topologyEdgesById: Record<string, DomainBeforeAfterImage<TopologyEdge>> = {};
  for (const topologyEdgeId of idsFromChangeSet(changeSets.topologyEdges)) {
    topologyEdgesById[topologyEdgeId] = Object.freeze({
      before: beforeState.topology.edgesById[topologyEdgeId] ?? null,
      after: afterState.topology.edgesById[topologyEdgeId] ?? null,
    });
  }
  return Object.freeze({
    countriesById: Object.freeze(countriesById),
    territoriesById: Object.freeze(territoriesById),
    topologyEdgesById: Object.freeze(topologyEdgesById),
    retiredCountryIds: Object.freeze({
      before: Object.freeze([...beforeState.retiredCountryIds].sort(compareText)),
      after: Object.freeze([...afterState.retiredCountryIds].sort(compareText)),
    }),
  });
}

const applyRecordImages = <Entity>(
  current: Readonly<Record<string, Entity>>,
  images: Readonly<Record<string, DomainBeforeAfterImage<Entity>>>,
  side: "before" | "after",
) => {
  const next: Record<string, Entity> = {...current};
  for (const [id, image] of Object.entries(images)) {
    const value = image[side];
    if (value === null) delete next[id];
    else next[id] = value;
  }
  return next;
};

const createStateFromRecords = (
  base: WorldStateV2,
  revision: number,
  countriesById: Readonly<Record<string, CountryEntity>>,
  territoriesById: Readonly<Record<string, TerritoryEntity>>,
  topologyEdgesById: Readonly<Record<string, TopologyEdge>>,
  retiredCountryIds: readonly RetiredCountryId[],
) => createWorldStateV2({
  schemaVersion: WORLD_STATE_V2_SCHEMA_VERSION,
  seedVersion: base.seedVersion,
  policyVersion: base.policyVersion,
  revision,
  countriesById,
  countryOrder: Object.keys(countriesById).sort(compareText) as ActiveCountryId[],
  retiredCountryIds,
  territoriesById,
  territoryOrder: Object.keys(territoriesById).sort(compareText) as TerritoryId[],
  topology: createTopologyState(Object.values(topologyEdgesById)),
  hashRoots: base.hashRoots,
});

export function applyBeforeImageSide(
  state: WorldStateV2,
  image: DomainBeforeImage,
  side: "before" | "after",
): WorldStateV2 {
  return createStateFromRecords(
    state,
    state.revision + 1,
    applyRecordImages(state.countriesById, image.countriesById, side),
    applyRecordImages(state.territoriesById, image.territoriesById, side),
    applyRecordImages(state.topology.edgesById, image.topologyEdgesById, side),
    image.retiredCountryIds[side] ?? [...state.retiredCountryIds],
  );
}

const commandHash = (
  commandId: string,
  beforeContentHash: string,
  afterContentHash: string,
  beforeImage: DomainBeforeImage,
) => hashCanonical({
  namespace: "historyCommand",
  commandId,
  beforeContentHash,
  afterContentHash,
  beforeImage,
});

const computeHistoryHash = (entries: readonly HistoryEntry[], pointer: number) =>
  historyHash({
    commandHashes: entries.map((entry) => entry.commandHash),
    cursor: pointer,
  });

export function createWorldHistory(initialRevision: number): WorldHistory {
  return Object.freeze({
    entries: Object.freeze([]),
    pointer: 0,
    historyHash: computeHistoryHash([], 0),
    currentRevision: initialRevision,
  });
}

export function recordHistoryEntry(
  history: WorldHistory,
  patch: WorldPatchV2,
  beforeState: WorldStateV2,
  afterState: WorldStateV2,
): WorldHistory {
  const beforeImage = createDomainBeforeImage(beforeState, afterState, patch.entityChangeSets);
  const beforeContentHash = checkpointWorldContentHash(beforeState);
  const afterContentHash = checkpointWorldContentHash(afterState);
  const entry: HistoryEntry = Object.freeze({
    commandId: patch.commandId,
    beforeRevision: beforeState.revision,
    afterRevision: afterState.revision,
    beforeContentHash,
    afterContentHash,
    beforeImage,
    commandHash: commandHash(patch.commandId, beforeContentHash, afterContentHash, beforeImage),
    redoPlan: patch.plannerPatch,
  });
  const entries = Object.freeze([...history.entries.slice(0, history.pointer), entry]);
  const pointer = entries.length;
  return Object.freeze({
    entries,
    pointer,
    historyHash: computeHistoryHash(entries, pointer),
    currentRevision: afterState.revision,
  });
}

export function undoHistory(
  history: WorldHistory,
  state: WorldStateV2,
): Readonly<{history: WorldHistory; state: WorldStateV2}> {
  if (history.pointer <= 0) return Object.freeze({history, state});
  const entry = history.entries[history.pointer - 1];
  const nextState = applyBeforeImageSide(state, entry.beforeImage, "before");
  const pointer = history.pointer - 1;
  return Object.freeze({
    state: nextState,
    history: Object.freeze({
      ...history,
      pointer,
      historyHash: computeHistoryHash(history.entries, pointer),
      currentRevision: nextState.revision,
    }),
  });
}

export function redoHistory(
  history: WorldHistory,
  state: WorldStateV2,
): Readonly<{history: WorldHistory; state: WorldStateV2}> {
  if (history.pointer >= history.entries.length) return Object.freeze({history, state});
  const entry = history.entries[history.pointer];
  const nextState = applyBeforeImageSide(state, entry.beforeImage, "after");
  const pointer = history.pointer + 1;
  return Object.freeze({
    state: nextState,
    history: Object.freeze({
      ...history,
      pointer,
      historyHash: computeHistoryHash(history.entries, pointer),
      currentRevision: nextState.revision,
    }),
  });
}

export function serializeWorldStateV2(state: WorldStateV2): WorldStateV2Serialized {
  return Object.freeze({
    schemaVersion: state.schemaVersion,
    seedVersion: state.seedVersion,
    policyVersion: state.policyVersion,
    revision: state.revision,
    countriesById: state.countriesById,
    countryOrder: state.countryOrder,
    retiredCountryIds: Object.freeze([...state.retiredCountryIds].sort(compareText)),
    territoriesById: state.territoriesById,
    territoryOrder: state.territoryOrder,
    topology: state.topology,
    hashRoots: state.hashRoots,
  });
}

export function deserializeWorldStateV2(serialized: WorldStateV2Serialized): WorldStateV2 {
  const extraKeys = Object.keys(serialized).filter((key) => !domainStateKeys.has(key));
  if (extraKeys.length > 0) {
    throw new Error(`WorldState v2 persistence contains transient fields: ${extraKeys.join(", ")}`);
  }
  return createWorldStateV2(serialized);
}

export function migratePrompt09SaveToWorldStateV2(
  raw: unknown,
  fallbackWorldState: WorldStateV2,
): Prompt09MigrationResult {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return Object.freeze({worldState: fallbackWorldState, ignoredCountryIds: Object.freeze([])});
  }
  const input = raw as {
    worldStateV2?: unknown;
    deletedCountryIds?: unknown;
    selectedCountryId?: unknown;
    playerCountryId?: unknown;
  };
  if (input.worldStateV2) {
    return Object.freeze({
      worldState: deserializeWorldStateV2(input.worldStateV2 as WorldStateV2Serialized),
      ignoredCountryIds: Object.freeze([]),
    });
  }
  const ignoredCountryIds = [
    input.selectedCountryId,
    input.playerCountryId,
    ...(Array.isArray(input.deletedCountryIds) ? input.deletedCountryIds : []),
  ].filter((countryId): countryId is string =>
    typeof countryId === "string" && !fallbackWorldState.countriesById[countryId],
  ).sort(compareText);
  return Object.freeze({
    worldState: fallbackWorldState,
    ignoredCountryIds: Object.freeze([...new Set(ignoredCountryIds)]),
  });
}
