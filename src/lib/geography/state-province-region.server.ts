import 'server-only';
import type {CatalogRegionIndex, RegionRecord, RegionReference} from '../simulation/catalog-region';
import {regionKey} from '../simulation/catalog-region';
import {assertWorldGeometryCatalogRefMatches} from '../world/world-geometry-catalog-ref';
import type {GeographySnapshot, GeographySummary, GeographyLoadRequest, GeographyLoadResult} from './state-province-io';
import {loadProductionGeography} from './production-geography.server';
import type {StateId} from './state-province-contract';

/** HTTP never accepts filesystem paths. */
export type RegionGeographyLoader = (request: GeographyLoadRequest) => Promise<GeographyLoadResult>;
export const loadRegionGeography: RegionGeographyLoader = loadProductionGeography;

/** Explicit existing parent-to-reference crosswalk; no state/source ID is cast to subdivisionId. */
export function attachGeographyRegionIndex(index: CatalogRegionIndex, snapshot: GeographySnapshot,
  links: readonly Readonly<{stateId: StateId; reference: RegionReference}>[]): CatalogRegionIndex {
  if (!index.catalogRef) throw Error('REGION_CATALOG_REQUIRED');
  assertWorldGeometryCatalogRefMatches(index.catalogRef, snapshot.catalogRef);
  const states = new Map(snapshot.metadata.states.map(s => [s.stateId, s]));
  const byLegacy = new Map<string, GeographySummary>();
  const byState = new Map<string, RegionReference>();
  for (const link of links) {
    const state = states.get(link.stateId);
    if (!state) throw Error('GEOGRAPHY_STATE_CROSSWALK');
    const record = index.lookup(state.sourceCountryId, link.reference);
    const summary = snapshot.inspect({catalogRef: snapshot.catalogRef, metadataRef: snapshot.metadataRef, target: {kind: 'state', id: state.stateId}});
    if (!summary.ok) throw Error('GEOGRAPHY_STATE_CROSSWALK');
    const members = snapshot.metadata.provinces.filter(p => p.stateId === state.stateId).map(p => p.provinceId).sort();
    if (JSON.stringify(members) !== JSON.stringify([...record.territoryIds].sort()) || byLegacy.has(regionKey(link.reference)) || byState.has(state.stateId)) throw Error('GEOGRAPHY_STATE_CROSSWALK');
    byLegacy.set(regionKey(link.reference), summary.value); byState.set(state.stateId, Object.freeze({...record.ref}));
  }
  if (byState.size !== states.size) throw Error('GEOGRAPHY_STATE_CROSSWALK');
  const project = (record: RegionRecord): RegionRecord => {
    const summary = byLegacy.get(regionKey(record.ref));
    if (!summary) return record;
    const nameKo = summary.names.nameKo?.value ?? summary.names.displayName;
    const nameEn = summary.names.nameEn?.value ?? summary.names.displayName;
    const aliases = summary.names.aliases.map(a => a.value);
    if ([nameKo, nameEn, ...aliases].some(name => name.length > 120) || aliases.length > 16) throw Error('GEOGRAPHY_LEGACY_NAME_LIMIT');
    return Object.freeze({...record, nameKo, nameEn, aliases: Object.freeze(aliases), geography: summary});
  };
  const lookup = (countryId: string, reference: RegionReference) => project(index.lookup(countryId, reference));
  return Object.freeze({catalogRef: index.catalogRef, borderTerritories: index.borderTerritories, hasTerritory: index.hasTerritory,
    geography: Object.freeze({snapshot,
    legacyReference: (stateId: string) => byState.get(stateId) ?? null,
    summary: (reference: RegionReference) => byLegacy.get(regionKey(reference)) ?? null,
  }),
    get records() {return Object.freeze(index.records.map(project));}, lookup,
    listCountry: (countryId: string) => Object.freeze(index.listCountry(countryId).map(project)),
    search: (countryId: string, query: string) => {
      const found: RegionRecord[] = []; let offset = 0;
      for (;;) {
        const page = snapshot.search({sourceCountryId: countryId as never, kind: 'state', query, page: {offset, limit: 128}});
        if (!page.ok) throw Error(page.diagnostics[0].code);
        for (const summary of page.value.items) found.push(lookup(countryId, byState.get(summary.reference.target.id)!));
        offset += page.value.items.length;
        if (offset >= page.value.totalMatches) break;
      }
      return Object.freeze(found);
    },
    resolve: (countryId: string, reference: RegionReference, operation: string, cap = 512) => {
      const summary = byLegacy.get(regionKey(reference));
      if (!summary || summary.materialization.status === 'unsupported') throw Error('GEOGRAPHY_SCOPE_UNSUPPORTED');
      return project(index.resolve(countryId, reference, operation, cap));
    },
  });
}

/** Legacy compact fields remain compatible; metadata facts are carried separately and explicitly. */
export function compactRegion(record: RegionRecord) {
  return {ref: record.ref, parentCountryId: record.parentCountryId, countryIdSemantics: 'source' as const,
    nameKo: record.nameKo, nameEn: record.nameEn, materializable: false,
    geography: record.geography ?? null,
    materialization: record.geography?.materialization ?? {status: 'unsupported' as const, reason: 'No canonical geography metadata has been pinned for this legacy region'},
  };
}
