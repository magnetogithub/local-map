import {countryIdSchema} from './simulation-contract-primitives';

export type CatalogBorderLookup = (countryId: string, neighborCountryId: string, cap: number) => readonly string[];

/** Selects existing cells along an approved shared land border; never creates geometry. */
export function createCatalogBorderLookup(
  entries: readonly Readonly<{id: string; sourceCountryId: string}>[],
  edges: readonly Readonly<{leftTerritoryId: string; rightTerritoryId: string | null}>[],
): CatalogBorderLookup {
  const countries = new Map(entries.map(entry => [entry.id, entry.sourceCountryId]));
  if (countries.size !== entries.length) throw Error('DUPLICATE_BORDER_TERRITORY');
  const borders = new Map<string, Set<string>>();
  for (const edge of edges) {
    const left = countries.get(edge.leftTerritoryId);
    const right = edge.rightTerritoryId === null ? null : countries.get(edge.rightTerritoryId);
    if (!left || (edge.rightTerritoryId !== null && !right)) throw Error('UNKNOWN_BORDER_TERRITORY');
    if (!right || left === right) continue;
    for (const [country, neighbor, territory] of [[left, right, edge.leftTerritoryId], [right, left, edge.rightTerritoryId!]]) {
      const key = `${country}:${neighbor}`, ids = borders.get(key) ?? new Set<string>();
      ids.add(territory); borders.set(key, ids);
    }
  }
  return (countryId, neighborCountryId, cap) => {
    countryIdSchema.parse(countryId); countryIdSchema.parse(neighborCountryId);
    if (countryId === neighborCountryId || !Number.isInteger(cap) || cap < 1 || cap > 512) throw Error('BORDER_REQUEST_SCOPE');
    const ids = [...(borders.get(`${countryId}:${neighborCountryId}`) ?? [])].sort();
    if (ids.length > cap) throw Error('BORDER_REQUEST_CAP');
    return Object.freeze(ids);
  };
}
