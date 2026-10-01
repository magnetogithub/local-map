import type {ActiveCountryId} from "../world/country-id";
import type {TerritoryId} from "../world/territory-id";
import type {TopologyEdgeId} from "../world/topology-state";
import type {WorldStateV2} from "../world/world-state-v2";

export type AffectedSet = Readonly<{
  countryIds: readonly ActiveCountryId[];
  directTerritoryIds: readonly TerritoryId[];
  territoryIds: readonly TerritoryId[];
  topologyEdgeIds: readonly TopologyEdgeId[];
}>;

export type AffectedSetInput = Readonly<{
  beforeState: WorldStateV2;
  afterState?: WorldStateV2;
  patch: unknown;
}>;

type MutableAffectedIds = {
  countryIds: Set<ActiveCountryId>;
  directTerritoryIds: Set<TerritoryId>;
};

const compareText = (left: string, right: string) =>
  left < right ? -1 : left > right ? 1 : 0;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const addCountry = (ids: MutableAffectedIds, value: unknown) => {
  if (typeof value === "string") ids.countryIds.add(value as ActiveCountryId);
};

const addTerritory = (ids: MutableAffectedIds, value: unknown) => {
  if (typeof value === "string") ids.directTerritoryIds.add(value as TerritoryId);
};

const addCountries = (ids: MutableAffectedIds, values: unknown) => {
  if (Array.isArray(values)) values.forEach((value) => addCountry(ids, value));
};

const addTerritories = (ids: MutableAffectedIds, values: unknown) => {
  if (Array.isArray(values)) values.forEach((value) => addTerritory(ids, value));
};

const addTerritoryRecordKeys = (ids: MutableAffectedIds, value: unknown) => {
  if (isRecord(value)) Object.keys(value).forEach((territoryId) => addTerritory(ids, territoryId));
};

const addCountryRecordKeys = (ids: MutableAffectedIds, value: unknown) => {
  if (isRecord(value)) Object.keys(value).forEach((countryId) => addCountry(ids, countryId));
};

const addCountryRecordValues = (ids: MutableAffectedIds, value: unknown) => {
  if (!isRecord(value)) return;
  Object.values(value).forEach((countryId) => {
    if (countryId !== null) addCountry(ids, countryId);
  });
};

function collectPatchAffectedIds(patch: unknown, ids: MutableAffectedIds) {
  if (!isRecord(patch) || typeof patch.kind !== "string") return;

  switch (patch.kind) {
    case "command.batch":
      if (Array.isArray(patch.commandPatches)) {
        patch.commandPatches.forEach((childPatch) => collectPatchAffectedIds(childPatch, ids));
      }
      return;
    case "country.create":
      addCountry(ids, patch.countryId);
      return;
    case "country.rename":
      addCountry(ids, patch.countryId);
      return;
    case "country.establish":
      addCountry(ids, patch.countryId);
      addTerritories(ids, patch.territoryIds);
      return;
    case "country.delete":
      addCountry(ids, patch.countryId);
      return;
    case "country.dissolve":
      addCountry(ids, patch.sourceCountryId);
      addTerritoryRecordKeys(ids, patch.territoryOwnerChanges);
      addCountryRecordValues(ids, patch.territoryOwnerChanges);
      addCountryRecordKeys(ids, patch.metadataSuccessionByTarget);
      return;
    case "country.merge":
      addCountries(ids, patch.sourceCountryIds);
      addCountries(ids, patch.removedSourceCountryIds);
      addCountry(ids, patch.resultCountryId);
      addTerritoryRecordKeys(ids, patch.territoryOwnerChanges);
      addCountryRecordValues(ids, patch.territoryOwnerChanges);
      return;
    case "country.split":
      addCountry(ids, patch.sourceCountryId);
      addCountries(ids, patch.resultCountryIds);
      addTerritoryRecordKeys(ids, patch.territoryOwnerChanges);
      addCountryRecordValues(ids, patch.territoryOwnerChanges);
      return;
    case "territory.partition":
      addTerritory(ids, patch.sourceTerritoryId);
      addTerritories(ids, patch.partitionTerritoryIds);
      return;
    case "territory.assign":
      addTerritory(ids, patch.territoryId);
      addCountry(ids, patch.afterOwnerCountryId);
      return;
    case "territory.unclaim":
      if (Array.isArray(patch.ownershipChanges)) {
        patch.ownershipChanges.forEach((change) => {
          if (!isRecord(change)) return;
          addTerritory(ids, change.territoryId);
          addCountry(ids, change.beforeOwnerCountryId);
        });
      }
      return;
    case "territory.replace":
      addTerritory(ids, patch.territoryId);
      addTerritories(ids, patch.recomputedTerritoryIds);
      return;
    case "territory.transfer":
      addTerritory(ids, patch.territoryId);
      addCountry(ids, patch.beforeOwnerCountryId);
      addCountry(ids, patch.afterOwnerCountryId);
      return;
  }
}

const collectTerritoryWithNeighbors = (
  state: WorldStateV2,
  directTerritoryIds: ReadonlySet<TerritoryId>,
) => {
  const territoryIds = new Set<TerritoryId>(directTerritoryIds);
  for (const territoryId of directTerritoryIds) {
    for (const neighborId of state.topology.neighborTerritoryIdsById[territoryId] ?? []) {
      territoryIds.add(neighborId);
    }
  }
  return territoryIds;
};

const collectTopologyEdges = (
  state: WorldStateV2,
  affectedTerritoryIds: ReadonlySet<TerritoryId>,
) => new Set(
  Object.values(state.topology.edgesById)
    .filter(({territoryIds}) => territoryIds.some((territoryId) =>
      territoryId !== null && affectedTerritoryIds.has(territoryId)
    ))
    .map(({id}) => id),
);

export function calculateAffectedSet({
  beforeState,
  afterState,
  patch,
}: AffectedSetInput): AffectedSet {
  const ids: MutableAffectedIds = {
    countryIds: new Set(),
    directTerritoryIds: new Set(),
  };
  collectPatchAffectedIds(patch, ids);

  const territoryIds = collectTerritoryWithNeighbors(beforeState, ids.directTerritoryIds);
  if (afterState) {
    for (const territoryId of collectTerritoryWithNeighbors(afterState, ids.directTerritoryIds)) {
      territoryIds.add(territoryId);
    }
  }

  const topologyEdgeIds = collectTopologyEdges(beforeState, territoryIds);
  if (afterState) {
    for (const edgeId of collectTopologyEdges(afterState, territoryIds)) {
      topologyEdgeIds.add(edgeId);
    }
  }

  return Object.freeze({
    countryIds: Object.freeze([...ids.countryIds].sort(compareText)),
    directTerritoryIds: Object.freeze([...ids.directTerritoryIds].sort(compareText)),
    territoryIds: Object.freeze([...territoryIds].sort(compareText)),
    topologyEdgeIds: Object.freeze([...topologyEdgeIds].sort(compareText)),
  });
}
