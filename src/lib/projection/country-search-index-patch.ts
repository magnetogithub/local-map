import {normalizeSearchText} from "../country/normalize-search-text";
import type {ActiveCountryId} from "../world/country-id";
import type {CountryEntity} from "../world/country-entity";
import type {WorldStateV2} from "../world/world-state-v2";
import type {WorldPatchV2} from "../planning/world-patch-v2";

export type CountrySearchEntry = Readonly<{
  countryId: ActiveCountryId;
  shortKo: string;
  officialKo: string;
  mapKo: string;
  english: string;
  searchAliases: readonly string[];
  playable: boolean;
}>;

export type CountrySearchProjection = Readonly<{
  revision: number;
  entriesById: ReadonlyMap<ActiveCountryId, CountrySearchEntry>;
  fullRebuildCount: number;
}>;

export type SerializedCountrySearchProjection = Readonly<{
  revision: number;
  entries: readonly CountrySearchEntry[];
  fullRebuildCount: number;
}>;

export type CountrySearchIndexPatchOperation = Readonly<{
  countryId: ActiveCountryId;
  kind: "add" | "update" | "delete";
}>;

export type CountrySearchIndexPatchResult = Readonly<{
  projection: CountrySearchProjection;
  operations: readonly CountrySearchIndexPatchOperation[];
  fullRebuildCountDelta: number;
}>;

const compareText = (left: string, right: string) =>
  left < right ? -1 : left > right ? 1 : 0;

export const createCountrySearchEntry = (
  input: Readonly<{
    countryId: ActiveCountryId;
    shortKo: string;
    officialKo: string;
    mapKo: string;
    english: string;
    searchAliases: readonly string[];
    playable: boolean;
  }>,
): CountrySearchEntry => Object.freeze({
  countryId: input.countryId,
  shortKo: input.shortKo,
  officialKo: input.officialKo,
  mapKo: input.mapKo,
  english: input.english,
  searchAliases: Object.freeze([...input.searchAliases]),
  playable: input.playable,
});

const countrySearchEntry = (country: CountryEntity): CountrySearchEntry => createCountrySearchEntry({
  countryId: country.id,
  shortKo: country.names.shortKo,
  officialKo: country.names.officialKo,
  mapKo: country.names.mapKo,
  english: country.names.english,
  searchAliases: country.names.searchAliases,
  playable: country.politicalStatus === "sovereign",
});

export function createCountrySearchProjection(
  state: WorldStateV2,
  fullRebuildCount = 0,
): CountrySearchProjection {
  return Object.freeze({
    revision: state.revision,
    entriesById: new Map(
      Object.values(state.countriesById).map((country) => [country.id, countrySearchEntry(country)]),
    ),
    fullRebuildCount,
  });
}

const countryModuleDeltaIds = (patch: WorldPatchV2) =>
  new Set<ActiveCountryId>([
    ...patch.moduleLeafHashDeltas.countryCore.map(({id}) => id),
    ...patch.moduleLeafHashDeltas.countryPresentation.map(({id}) => id),
  ]);

const patchOperationIds = (patch: WorldPatchV2) => {
  const countryModuleIds = countryModuleDeltaIds(patch);
  const operations: CountrySearchIndexPatchOperation[] = [];
  for (const countryId of patch.entityChangeSets.countries.created) {
    if (countryModuleIds.has(countryId)) operations.push({countryId, kind: "add"});
  }
  for (const countryId of patch.entityChangeSets.countries.updated) {
    if (countryModuleIds.has(countryId)) operations.push({countryId, kind: "update"});
  }
  for (const countryId of patch.entityChangeSets.countries.deleted) {
    if (countryModuleIds.has(countryId)) operations.push({countryId, kind: "delete"});
  }
  return Object.freeze(operations.sort((left, right) =>
    compareText(left.countryId, right.countryId) || compareText(left.kind, right.kind),
  ));
};

export function applyCountrySearchIndexPatch(
  projection: CountrySearchProjection,
  patch: WorldPatchV2,
  committedState: WorldStateV2,
): CountrySearchIndexPatchResult {
  if (projection.revision !== patch.beforeRevision) {
    throw new Error(
      `Country search projection revision ${projection.revision} does not match patch beforeRevision ${patch.beforeRevision}`,
    );
  }
  if (committedState.revision !== patch.afterRevision) {
    throw new Error(
      `Committed state revision ${committedState.revision} does not match patch afterRevision ${patch.afterRevision}`,
    );
  }

  const operations = patchOperationIds(patch);
  const entriesById = new Map(projection.entriesById);
  for (const operation of operations) {
    if (operation.kind === "delete") {
      entriesById.delete(operation.countryId);
      continue;
    }
    const country = committedState.countriesById[operation.countryId];
    if (!country) {
      throw new Error(`Country search patch references missing country: ${operation.countryId}`);
    }
    entriesById.set(operation.countryId, countrySearchEntry(country));
  }

  return Object.freeze({
    projection: Object.freeze({
      revision: patch.afterRevision,
      entriesById,
      fullRebuildCount: projection.fullRebuildCount,
    }),
    operations,
    fullRebuildCountDelta: 0,
  });
}

const rank = (value: string, query: string) =>
  value === query ? 0 : value.startsWith(query) ? 1 : value.includes(query) ? 2 : 9;

const entryScore = (entry: CountrySearchEntry, query: string) =>
  Math.min(
    rank(normalizeSearchText(entry.countryId), query),
    rank(normalizeSearchText(entry.shortKo), query),
    rank(normalizeSearchText(entry.officialKo), query),
    rank(normalizeSearchText(entry.mapKo), query),
    rank(normalizeSearchText(entry.english), query),
    ...entry.searchAliases.map((alias) => rank(normalizeSearchText(alias), query)),
  );

export function searchCountryProjection(
  projection: CountrySearchProjection,
  query: string,
  limit = 8,
): readonly CountrySearchEntry[] {
  const normalizedQuery = normalizeSearchText(query);
  if (!normalizedQuery) return Object.freeze([]);
  return Object.freeze([...projection.entriesById.values()]
    .filter((entry) => entry.playable)
    .map((entry) => ({entry, score: entryScore(entry, normalizedQuery)}))
    .filter(({score}) => score < 9)
    .sort((left, right) =>
      left.score - right.score ||
      left.entry.shortKo.localeCompare(right.entry.shortKo, "ko") ||
      compareText(left.entry.countryId, right.entry.countryId),
    )
    .slice(0, limit)
    .map(({entry}) => entry));
}

export function serializeCountrySearchProjection(
  projection: CountrySearchProjection,
): SerializedCountrySearchProjection {
  return Object.freeze({
    revision: projection.revision,
    entries: Object.freeze([...projection.entriesById.values()]),
    fullRebuildCount: projection.fullRebuildCount,
  });
}

export function deserializeCountrySearchProjection(
  projection: SerializedCountrySearchProjection,
): CountrySearchProjection {
  return Object.freeze({
    revision: projection.revision,
    entriesById: new Map(
      projection.entries.map((entry) => [entry.countryId, createCountrySearchEntry(entry)]),
    ),
    fullRebuildCount: projection.fullRebuildCount,
  });
}
