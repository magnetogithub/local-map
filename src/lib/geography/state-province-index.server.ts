import 'server-only';
import {assertWorldGeometryCatalogRefMatches} from '../world/world-geometry-catalog-ref';
import {canonicalStringify} from '../world/canonical-serializer';
import {
  geographyCountryIdSchema, normalizeGeographyName,
  type GeographyCountry, type GeographyMetadata, type GeographyNames, type GeographySource,
} from './state-province-contract';
import {
  geographyPageRequestSchema, geographyReferenceSchema, geographySearchRequestSchema,
  type GeographyPage, type GeographyPageRequest, type GeographyReference,
  type GeographySnapshot, type GeographySummary,
} from './state-province-io';
import {geographyFailure, type GeographyResult} from './state-province-validation';

const listSchema = geographySearchRequestSchema.omit({query: true});
const targetKey = (target: GeographyReference['target']) => `${target.kind}:${target.id}`;
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const sourceKey = (country: string, source: GeographySource) =>
  canonicalStringify([country, source.sourceId, source.sourceFeatureId, source.sourceVersion]);
const searchNames = (names: GeographyNames) => new Set([
  names.displayName, names.sourceName?.value, names.nameKo?.value, names.nameEn?.value,
  ...names.aliases.map(alias => alias.value),
].filter((name): name is string => name !== undefined).map(normalizeGeographyName));

/** Internal construction boundary: the loader passes semantically admitted, frozen metadata. */
export function createGeographySnapshot(metadata: GeographyMetadata): GeographySnapshot {
  const {catalogRef, metadataRef} = metadata;
  const summaries = new Map<string, GeographySummary>();
  const memberships = new Map<string, readonly string[]>();
  const stateMembers = new Map<string, string[]>();
  const provinces = new Map(metadata.provinces.map(p => [p.provinceId as string, p]));
  for (const province of metadata.provinces) {
    if (province.stateId !== null) {
      const members = stateMembers.get(province.stateId) ?? [];
      members.push(province.provinceId);
      stateMembers.set(province.stateId, members);
    }
  }
  const add = (summary: GeographySummary, ids: readonly string[]) => {
    const key = targetKey(summary.reference.target);
    summaries.set(key, Object.freeze({...summary,
      reference: Object.freeze({...summary.reference, target: Object.freeze(summary.reference.target)}),
      materialization: Object.freeze(summary.materialization),
    }));
    memberships.set(key, Object.freeze([...ids].sort(compare)));
  };
  const reference = (target: GeographyReference['target']): GeographyReference => ({catalogRef, metadataRef, target});
  const materialization = (supported: boolean): GeographySummary['materialization'] => supported
    ? {status: 'requires-validation', reason: 'Read identity only; validate coverage, world revision, authority and action limits before execution'}
    : {status: 'unsupported', reason: 'Geographic scope or parent is unverified; known membership does not certify the entire requested region'};
  for (const province of metadata.provinces) {
    add({reference: reference({kind: 'province', id: province.provinceId}), sourceCountryId: province.sourceCountryId,
      names: province.names, stateId: province.stateId, parentStatus: province.parentStatus,
      precision: province.precision, geometryStatus: province.geometryStatus, coverage: null, knownProvinceCount: 1,
      materialization: materialization(province.parentStatus === 'verified'),
    }, [province.provinceId]);
  }
  for (const state of metadata.states) {
    const ids = stateMembers.get(state.stateId) ?? [];
    add({reference: reference({kind: 'state', id: state.stateId}), sourceCountryId: state.sourceCountryId, names: state.names,
      stateId: state.stateId, parentStatus: 'not-applicable', precision: null, geometryStatus: null,
      coverage: state.coverage, knownProvinceCount: ids.length,
      materialization: materialization(state.coverage.status === 'complete'),
    }, ids);
  }
  for (const region of metadata.sourceRegions) {
    const parents = new Set(region.provinceIds.map(id => provinces.get(id)!.stateId));
    const stateId = parents.size === 1 ? [...parents][0] : null;
    const parentStatus = parents.has(null) ? 'unassigned' : stateId === null ? 'not-applicable' : 'verified';
    add({reference: reference({kind: 'source-region', id: region.sourceRegionId}), sourceCountryId: region.sourceCountryId,
      names: region.names, stateId, parentStatus, precision: null, geometryStatus: null,
      coverage: region.coverage, knownProvinceCount: region.provinceIds.length,
      materialization: materialization(region.coverage.status === 'complete' && parentStatus !== 'unassigned'),
    }, region.provinceIds);
  }
  const statesBySource = new Map(metadata.states.map(state => [sourceKey(state.sourceCountryId, state.source), state]));
  const regionsBySource = new Map(metadata.sourceRegions.map(region => [sourceKey(region.sourceCountryId, region.source), region]));
  const equivalentStates = new Map<string, string>();
  for (const region of metadata.sourceRegions) {
    const state = statesBySource.get(sourceKey(region.sourceCountryId, region.source));
    if (state && canonicalStringify(state.source) === canonicalStringify(region.source) &&
        canonicalStringify(memberships.get(`state:${state.stateId}`)) ===
        canonicalStringify(memberships.get(`source-region:${region.sourceRegionId}`))) {
      equivalentStates.set(`source-region:${region.sourceRegionId}`, `state:${state.stateId}`);
    }
  }
  // An unfiltered place lookup prefers the named source group over its cells.
  // A state also represents its source group only with the same source identity
  // AND exact membership. Equal names or overlapping known sets are insufficient.
  const canonicalNameMatches = (matches: readonly GeographySummary[]) => {
    const matched = new Set(matches.map(summary => targetKey(summary.reference.target)));
    return matches.filter(summary => {
      const {kind, id} = summary.reference.target;
      if (kind === 'source-region') {
        const state = equivalentStates.get(targetKey(summary.reference.target));
        return !state || !matched.has(state);
      }
      if (kind !== 'province') return true;
      const province = provinces.get(id)!;
      return !province.sources.length || !province.sources.every(source => {
        const region = regionsBySource.get(sourceKey(province.sourceCountryId, source));
        if (!region) return false;
        const key = `source-region:${region.sourceRegionId}`, state = equivalentStates.get(key);
        return matched.has(key) || state !== undefined && matched.has(state);
      });
    });
  };
  const ordered = [...summaries.values()].sort((a, b) => compare(targetKey(a.reference.target), targetKey(b.reference.target)));
  const names = new Map(ordered.map(summary => [summary, searchNames(summary.names)]));
  const exactNames = new Map<string, Set<GeographySummary>>();
  for (const summary of ordered) for (const name of names.get(summary)!) {
    const candidates = exactNames.get(name) ?? new Set();
    candidates.add(summary); exactNames.set(name, candidates);
  }
  const paginate = <T>(items: readonly T[], page: GeographyPageRequest, ambiguous: boolean): GeographyPage<T> => Object.freeze({
    catalogRef, metadataRef, items: Object.freeze(items.slice(page.offset, page.offset + page.limit)),
    totalMatches: items.length, ...page,
    truncated: items.length > 0 && (page.offset > 0 || page.offset + page.limit < items.length), ambiguous,
  });
  const checkReference = (value: GeographyReference): GeographyResult<GeographySummary> => {
    const parsed = geographyReferenceSchema.safeParse(value);
    if (!parsed.success) return geographyFailure('GEOGRAPHY_SCHEMA', 'reference', parsed.error.issues[0].message);
    const ref = parsed.data;
    try {assertWorldGeometryCatalogRefMatches(ref.catalogRef, catalogRef);}
    catch {return geographyFailure('GEOGRAPHY_CATALOG', 'reference.catalogRef', 'Reference belongs to a different catalog snapshot');}
    if (canonicalStringify(ref.metadataRef) !== canonicalStringify(metadataRef)) return geographyFailure('GEOGRAPHY_METADATA', 'reference.metadataRef', 'Reference belongs to a different metadata snapshot');
    const summary = summaries.get(targetKey(ref.target));
    return summary ? {ok: true, value: summary} : geographyFailure('GEOGRAPHY_MEMBERSHIP', 'reference.target', 'Unknown geography target in the pinned snapshot');
  };
  const checkCountry = (country: string | null) => country === null || metadata.countries.some(c => c.sourceCountryId === country);
  return Object.freeze({catalogRef, metadataRef, metadata,
    search(request) {
      const parsed = geographySearchRequestSchema.safeParse(request);
      if (!parsed.success) return geographyFailure('GEOGRAPHY_SCHEMA', 'search', parsed.error.issues[0].message);
      const {sourceCountryId, kind, query, page} = parsed.data;
      if (!checkCountry(sourceCountryId)) return geographyFailure('GEOGRAPHY_CATALOG', 'search.sourceCountryId', 'Unknown source country in the pinned snapshot');
      const normalized = normalizeGeographyName(query);
      if (!normalized) return geographyFailure('GEOGRAPHY_NAME', 'search.query', 'Query must contain a normalized name');
      // Exact names/aliases take precedence within the requested country and kind.
      const filter = (summary: GeographySummary) => (sourceCountryId === null || summary.sourceCountryId === sourceCountryId) &&
        (kind === null || summary.reference.target.kind === kind);
      const exact = exactNames.get(normalized);
      const direct = ordered.filter(s => filter(s) && exact?.has(s));
      const candidates = direct.length ? direct : ordered.filter(s => filter(s) && [...names.get(s)!].some(name => name.includes(normalized)));
      const matches = kind === null ? canonicalNameMatches(candidates) : candidates;
      return {ok: true, value: paginate(matches, page, matches.length > 1)};
    },
    list(request) {
      const parsed = listSchema.safeParse(request);
      if (!parsed.success) return geographyFailure('GEOGRAPHY_SCHEMA', 'list', parsed.error.issues[0].message);
      const {sourceCountryId, kind, page} = parsed.data;
      if (!checkCountry(sourceCountryId)) return geographyFailure('GEOGRAPHY_CATALOG', 'list.sourceCountryId', 'Unknown source country in the pinned snapshot');
      return {ok: true, value: paginate(ordered.filter(s => (sourceCountryId === null || s.sourceCountryId === sourceCountryId) &&
        (kind === null || s.reference.target.kind === kind)), page, false)};
    },
    inspect: checkReference,
    members(ref, page) {
      const summary = checkReference(ref);
      if (!summary.ok) return summary;
      const parsed = geographyPageRequestSchema.safeParse(page);
      if (!parsed.success) return geographyFailure('GEOGRAPHY_SCHEMA', 'members.page', parsed.error.issues[0].message);
      return {ok: true, value: Object.freeze({...paginate(memberships.get(targetKey(summary.value.reference.target))!, parsed.data, false),
        reference: summary.value.reference, coverage: summary.value.coverage})};
    },
  });
}

/** Host-only country summary; source classification is independent of current ownership. */
export function readGeographyCountry(snapshot: GeographySnapshot, sourceCountryId: string): GeographyResult<GeographyCountry> {
  const parsed = geographyCountryIdSchema.safeParse(sourceCountryId);
  if (!parsed.success) return geographyFailure('GEOGRAPHY_SCHEMA', 'sourceCountryId', parsed.error.issues[0].message);
  const country = snapshot.metadata.countries.find(c => c.sourceCountryId === parsed.data);
  return country ? {ok: true as const, value: country} : geographyFailure('GEOGRAPHY_CATALOG', 'sourceCountryId', 'Unknown source country in the pinned snapshot');
}

/** Full known set for trusted host consumers. This does not create an executable selection. */
export function readAllGeographyMembers(snapshot: GeographySnapshot, reference: GeographyReference) {
  const first = snapshot.members(reference, {offset: 0, limit: 128});
  if (!first.ok) return first;
  const provinceIds = [...first.value.items];
  while (provinceIds.length < first.value.totalMatches) {
    const next = snapshot.members(reference, {offset: provinceIds.length, limit: 128});
    if (!next.ok) return next;
    provinceIds.push(...next.value.items);
  }
  return {ok: true as const, value: Object.freeze({catalogRef: snapshot.catalogRef, metadataRef: snapshot.metadataRef,
    reference: first.value.reference, provinceIds: Object.freeze(provinceIds), totalMatches: first.value.totalMatches,
    knownMembershipComplete: true as const, coverage: first.value.coverage})};
}
