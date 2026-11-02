import {createProductionInitialWorldStateV2} from "../world/initial-world-state-v2";
import type {WorldStateV2} from "../world/world-state-v2";
import {
  createCountrySearchProjection,
  searchCountryProjection,
  type CountrySearchEntry,
  type CountrySearchProjection,
} from "./country-search-index-patch";

export type {CountrySearchEntry};

export function createCommittedCountrySearchProjection(
  state: WorldStateV2,
): CountrySearchProjection {
  return createCountrySearchProjection(state);
}

export const committedCountrySearchProjection: CountrySearchProjection =
  createCommittedCountrySearchProjection(createProductionInitialWorldStateV2().worldState);

export function searchCommittedCountryProjection(
  query: string,
  limit = 8,
): readonly CountrySearchEntry[] {
  return searchCountryProjection(committedCountrySearchProjection, query, limit);
}

export function getCommittedCountrySearchEntry(countryId: string): CountrySearchEntry | null {
  return committedCountrySearchProjection.entriesById.get(countryId as never) ?? null;
}

export function hasCommittedCountrySearchEntry(countryId: string): boolean {
  return getCommittedCountrySearchEntry(countryId) !== null;
}

export function isCommittedCountryPlayable(countryId: string): boolean {
  return getCommittedCountrySearchEntry(countryId)?.playable === true;
}
