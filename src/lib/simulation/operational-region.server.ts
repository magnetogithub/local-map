import 'server-only';
import type {OperationalCatalog} from '../world/operational-catalog.server';
import {subdivisionReferenceSchema} from './world-effect';
import {regionKey, regionOperation, type CatalogRegionIndex, type RegionRecord, type RegionReference} from './catalog-region';

/** Complete source identities and memberships, independent of current owner/controller. */
export function createOperationalRegionIndex(catalog: OperationalCatalog): CatalogRegionIndex {
  const names = catalog.readRegionNames();
  const summaries = catalog.administrativeParents.map(parent => {
    const properties = parent.kind === 'administrative' && parent.sourceFeatureId ? names.get(parent.sourceFeatureId) : undefined;
    const text = (value: unknown) => typeof value === 'string' && value.trim() ? value : undefined;
    const fallback = parent.name || parent.parentKey;
    const nameEn = text(properties?.name_en) ?? text(properties?.name) ?? fallback;
    const nameKo = text(properties?.name_ko) ?? nameEn;
    const aliases = Object.freeze([...new Set([parent.name, properties?.name, properties?.name_local, properties?.postal, properties?.gns_name].filter((v): v is string => !!text(v)))]);
    const subdivisionId = parent.kind === 'administrative' ? `region:ne-admin1:${parent.sourceCountryId}:${parent.sourceFeatureId}` : `region:residual:${parent.sourceCountryId}:${parent.residualId}`;
    return Object.freeze({parent, ref: Object.freeze({catalogId: catalog.ref.catalogVersion, sourceVersion: catalog.ref.geometryRoot, subdivisionId}), nameEn, nameKo, aliases});
  });
  const byKey = new Map(summaries.map(s => [regionKey(s.ref), s]));
  if (byKey.size !== summaries.length) throw Error('DUPLICATE_REGION_REFERENCE');
  const cached = new Map<string, RegionRecord>();
  const lookup = (countryId: string, ref: RegionReference): RegionRecord => {
    subdivisionReferenceSchema.parse(ref);
    const key = regionKey(ref), summary = byKey.get(key);
    if (!summary) throw Error('UNKNOWN_REGION_OR_CATALOG');
    if (summary.parent.sourceCountryId !== countryId) throw Error('REGION_COUNTRY_SCOPE');
    let record = cached.get(key);
    if (!record) {
      const {parent} = summary;
      record = Object.freeze({ref: summary.ref, parentCountryId: countryId, nameKo: summary.nameKo, nameEn: summary.nameEn, aliases: summary.aliases,
        territoryIds: Object.freeze(catalog.administrativeMembership(parent.parentKey).map(c => c.id)),
        provenanceIds: Object.freeze([parent.restorationId ? `restoration:${parent.restorationId}` : `residual:${parent.residualId}`])});
      cached.set(key, record);
    }
    return record;
  };
  let allRecords: readonly RegionRecord[] | undefined;
  return Object.freeze({catalogRef: catalog.ref,
    get records() {return allRecords ??= Object.freeze(summaries.map(s => lookup(s.parent.sourceCountryId, s.ref)));},
    hasTerritory: (id: string) => {
      try {catalog.cell(id); return true;} catch (error) {
        if (error instanceof Error && (error.message === 'UNKNOWN_OPERATIONAL_CELL' || error.message.includes('bounded ASCII catalog TerritoryId'))) return false;
        throw error;
      }
    },
    listCountry: (countryId: string) => Object.freeze(summaries.filter(s => s.parent.sourceCountryId === countryId).map(s => lookup(countryId, s.ref))),
    lookup,
    resolve: (countryId: string, ref: RegionReference, operation: string, cap = 512) => {
      regionOperation.parse(operation);
      if (!Number.isInteger(cap) || cap < 1 || cap > 512) throw Error('REGION_REQUEST_CAP');
      const record = lookup(countryId, ref);
      if (record.territoryIds.length > cap) throw Error('REGION_REQUEST_CAP');
      return record;
    },
    search: (countryId: string, query: string) => {
      if (!query.trim() || query.length > 120) throw Error('INVALID_REGION_QUERY');
      const normalize = (s: string) => s.normalize('NFKC').toLocaleLowerCase('en-US');
      const q = normalize(query.trim());
      return Object.freeze(summaries.filter(s => s.parent.sourceCountryId === countryId && [s.nameEn, s.nameKo, ...s.aliases].some(n => normalize(n).includes(q)))
        .slice(0, 8).map(s => lookup(countryId, s.ref)));
    },
  });
}
