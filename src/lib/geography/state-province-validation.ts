import type {WorldGeometryCatalogContract} from '../world/world-geometry-catalog-ref';
import {assertWorldGeometryCatalogRefMatches} from '../world/world-geometry-catalog-ref';
import type {OperationalAdministrativeParent, OperationalCell} from '../world/operational-catalog';
import {canonicalStringify} from '../world/canonical-serializer';
import {
  countGeographyCountry, createSourceRegionId, geographyMetadataSchema, sealGeographyMetadata,
  type GeographyMetadata, type GeographyMetadataRef, type GeographyNames, type GeographySource,
  type GeographyEvidence,
} from './state-province-contract';

export const GEOGRAPHY_DIAGNOSTIC_CODES = [
  'GEOGRAPHY_SCHEMA', 'GEOGRAPHY_CATALOG', 'GEOGRAPHY_METADATA', 'GEOGRAPHY_NAME',
  'GEOGRAPHY_PARENT', 'GEOGRAPHY_SOURCE', 'GEOGRAPHY_MEMBERSHIP', 'GEOGRAPHY_COVERAGE',
] as const;
export type GeographyDiagnosticCode = typeof GEOGRAPHY_DIAGNOSTIC_CODES[number];
export type GeographyDiagnostic = Readonly<{
  code: GeographyDiagnosticCode; path: string; message: string;
  remedy: 'repair-input' | 'rebuild-for-catalog' | 'pin-metadata' | 'supply-evidence';
}>;
export type GeographyResult<T> = Readonly<{ok: true; value: T}> | Readonly<{ok: false; diagnostics: readonly GeographyDiagnostic[]}>;
/** Independently admitted target sets from the offline verifier, never inferred from a coverage flag. */
export type GeographyCoverageWitness = Readonly<{
  target: Readonly<{kind: 'state' | 'source-region'; id: string}>; provinceIds: readonly string[]; evidence: readonly GeographyEvidence[];
}>;
/** Inject metadata-only catalog rows. No polygons, builder imports or mutable world state. */
export type GeographyAdmissionContext = Readonly<{
  catalog: WorldGeometryCatalogContract;
  countryIds: readonly string[];
  cells: readonly OperationalCell[];
  administrativeParents: readonly OperationalAdministrativeParent[];
  /** Raw macro identity crosswalk; catalog parent.sourceFeatureId can be a synthetic runtime identity. */
  parentSources: readonly Readonly<{parentKey: string; source: GeographySource}>[];
  /** Complete known current membership for each registered lower-level source identity. */
  sourceMemberships: readonly Readonly<{sourceCountryId: string; source: GeographySource; provinceIds: readonly string[]}>[];
  coverageWitnesses: readonly GeographyCoverageWitness[];
}>;

export function geographyFailure(code: GeographyDiagnosticCode, path: string, message: string): GeographyResult<never> {
  const remedy = code === 'GEOGRAPHY_CATALOG' ? 'rebuild-for-catalog' : code === 'GEOGRAPHY_METADATA' ? 'pin-metadata'
    : code === 'GEOGRAPHY_COVERAGE' || code === 'GEOGRAPHY_SOURCE' ? 'supply-evidence' : 'repair-input';
  return {ok: false, diagnostics: [{code, path, message, remedy}]};
}
const same = (a: unknown, b: unknown) => canonicalStringify(a) === canonicalStringify(b);
const sameSet = (a: readonly string[], b: readonly string[]) => a.length === b.length && new Set(a).size === a.length && new Set(b).size === b.length && same([...a].sort(), [...b].sort());
const sourceKey = (country: string, source: GeographySource) => canonicalStringify([country, source.sourceId, source.sourceFeatureId, source.sourceVersion]);
function freeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {Object.values(value).forEach(freeze); Object.freeze(value);}
  return value;
}
function schemaCode(path: readonly PropertyKey[]): GeographyDiagnosticCode {
  if (path.includes('names')) return 'GEOGRAPHY_NAME';
  if (path.includes('coverage')) return 'GEOGRAPHY_COVERAGE';
  if (path.includes('catalogRef')) return 'GEOGRAPHY_CATALOG';
  if (path.includes('metadataRef')) return 'GEOGRAPHY_METADATA';
  if (path.some(p => ['stateId', 'parentStatus', 'parentEvidence', 'unassignedReason'].includes(String(p)))) return 'GEOGRAPHY_PARENT';
  return 'GEOGRAPHY_SCHEMA';
}

/** Shared semantic admission for A output, B loader and C input helper. Never repairs data. */
export function validateGeographyMetadata(value: unknown, context: GeographyAdmissionContext, expectedMetadataRef?: GeographyMetadataRef): GeographyResult<GeographyMetadata> {
  const parsed = geographyMetadataSchema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return geographyFailure(schemaCode(issue.path), issue.path.map(String).join('.'), issue.message);
  }
  const doc = parsed.data;
  try {assertWorldGeometryCatalogRefMatches(doc.catalogRef, context.catalog.ref);}
  catch {return geographyFailure('GEOGRAPHY_CATALOG', 'catalogRef', 'All catalogRef fields must match the admitted geometry catalog');}
  const {metadataRef, ...body} = doc;
  if (!same(metadataRef, sealGeographyMetadata(body).metadataRef) || expectedMetadataRef && !same(metadataRef, expectedMetadataRef)) {
    return geographyFailure('GEOGRAPHY_METADATA', 'metadataRef', 'Content root or pinned metadata snapshot does not match');
  }
  const unique = (values: readonly string[]) => new Set(values).size === values.length;
  if (!unique(doc.states.map(s => s.stateId)) || !unique(doc.provinces.map(p => p.provinceId)) ||
      !unique(doc.sourceRegions.map(r => r.sourceRegionId)) || !unique(doc.countries.map(c => c.sourceCountryId))) {
    return geographyFailure('GEOGRAPHY_MEMBERSHIP', '$', 'Duplicate entity identity');
  }
  const countries = new Set(context.countryIds), cells = new Map(context.cells.map(c => [c.id as string, c]));
  if (!sameSet(doc.provinces.map(p => p.provinceId), context.catalog.territoryOrder) ||
      !sameSet(context.cells.map(c => c.id), context.catalog.territoryOrder) ||
      !sameSet(doc.countries.map(c => c.sourceCountryId), context.countryIds)) {
    return geographyFailure('GEOGRAPHY_MEMBERSHIP', 'provinces', 'Metadata must cover the exact catalog and country sets without omissions or duplicates');
  }
  const states = new Map(doc.states.map(s => [s.stateId as string, s]));
  const provinces = new Map(doc.provinces.map(p => [p.provinceId as string, p]));
  const parentSources = new Map(context.parentSources.map(p => [p.parentKey, p.source]));
  const sourceMemberships = new Map(context.sourceMemberships.map(s => [sourceKey(s.sourceCountryId, s.source), s]));
  if (parentSources.size !== context.parentSources.length || sourceMemberships.size !== context.sourceMemberships.length) {
    return geographyFailure('GEOGRAPHY_SOURCE', '$', 'Admission evidence contains conflicting source mappings');
  }
  const parents = new Map(context.administrativeParents.map(p => [p.parentKey, p]));
  if (parents.size !== context.administrativeParents.length) return geographyFailure('GEOGRAPHY_PARENT', 'administrativeParents', 'Conflicting catalog parent keys');
  const declaredArtifacts = new Map([...doc.provenance.inputs, ...doc.provenance.code].map(a => [a.path, a]));
  if (declaredArtifacts.size !== doc.provenance.inputs.length + doc.provenance.code.length) return geographyFailure('GEOGRAPHY_SOURCE', 'provenance', 'Input/code artifact paths must be unambiguous');
  const evidenceDeclared = (items: readonly GeographyEvidence[]) => items.every(e => same(declaredArtifacts.get(e.artifact.path) ?? null, e.artifact));
  const nameError = (names: GeographyNames): string | undefined => {
    if (names.sourceName && names.sourceName.basis !== 'source') return 'sourceName must be a source fact';
    if (names.displayBasis !== 'derived' && ![names.sourceName, names.nameKo, names.nameEn].some(n => n?.value === names.displayName && n.basis === names.displayBasis)) return 'Display language fallback must match a name fact or be marked derived';
  };
  for (const [index, record] of [...doc.states, ...doc.provinces, ...doc.sourceRegions].entries()) {
    if (!countries.has(record.sourceCountryId)) return geographyFailure('GEOGRAPHY_CATALOG', `records.${index}.sourceCountryId`, 'Unknown source country');
    const error = nameError(record.names);
    if (error) return geographyFailure('GEOGRAPHY_NAME', `records.${index}.names`, error);
    const names = record.names;
    const facts = [names.sourceName, names.nameKo, names.nameEn, ...names.aliases].filter(n => n !== null);
    const sources = record.kind === 'province' ? record.sources : [record.source];
    if (!evidenceDeclared([...record.evidence, ...names.displayEvidence, ...facts.flatMap(f => f.evidence)]) ||
        sources.some(s => !same(declaredArtifacts.get(s.artifact.path) ?? null, s.artifact))) return geographyFailure('GEOGRAPHY_SOURCE', `records.${index}.evidence`, 'Evidence/source artifact is absent from the pinned input/code inventory');
  }
  const stateSources = doc.states.map(s => sourceKey(s.sourceCountryId, s.source));
  if (!unique(stateSources)) return geographyFailure('GEOGRAPHY_PARENT', 'states', 'One raw state identity cannot issue multiple states');
  for (const state of doc.states) {
    const parent = parents.get(state.catalogParentKey), source = parentSources.get(state.catalogParentKey);
    if (state.stateId !== state.catalogParentKey || !parent || parent.kind !== 'administrative' || parent.sourceCountryId !== state.sourceCountryId || !source || !same(source, state.source)) {
      return geographyFailure('GEOGRAPHY_PARENT', `states.${state.stateId}`, 'State must reuse one existing administrative parent and its evidenced source crosswalk');
    }
  }
  for (const province of doc.provinces) {
    const cell = cells.get(province.provinceId)!, catalogCell = context.catalog.territoriesById[province.provinceId];
    if (cell.sourceCountryId !== province.sourceCountryId || catalogCell?.sourceCountryId !== province.sourceCountryId) return geographyFailure('GEOGRAPHY_CATALOG', `provinces.${province.provinceId}`, 'Source country differs from catalog membership');
    const parent = context.administrativeParents[cell.administrativeOrdinal - 1];
    if (!parent || parent.sourceCountryId !== province.sourceCountryId) return geographyFailure('GEOGRAPHY_PARENT', `provinces.${province.provinceId}`, 'Invalid catalog parent ordinal');
    if (province.parentStatus === 'verified') {
      const state = states.get(province.stateId);
      if (!state || state.sourceCountryId !== province.sourceCountryId || parent.kind !== 'administrative' || state.catalogParentKey !== parent.parentKey) return geographyFailure('GEOGRAPHY_PARENT', `provinces.${province.provinceId}.stateId`, 'Verified state conflicts with registered operational membership');
    } else if (parent.kind === 'administrative' && parentSources.has(parent.parentKey)) {
      return geographyFailure('GEOGRAPHY_PARENT', `provinces.${province.provinceId}.stateId`, 'An existing administrative parent must be evidenced; do not silently discard registered membership');
    }
    if (province.precision === 'fine' && (!province.sources.length || province.geometryStatus === 'source-free') ||
        (province.geometryStatus === 'source-free') !== (province.sources.length === 0) ||
        !province.sources.length && province.names.sourceName !== null ||
        !unique(province.sources.map(s => sourceKey(province.sourceCountryId, s))) || !evidenceDeclared(province.parentEvidence) ||
        province.precision === 'residual' && (province.parentStatus !== 'unassigned' || province.sources.length > 0 || province.geometryStatus !== 'source-free')) {
      return geographyFailure('GEOGRAPHY_SOURCE', `provinces.${province.provinceId}`, 'Fine sources and source-free residual precision must be distinguished');
    }
    for (const source of province.sources) {
      const mapping = sourceMemberships.get(sourceKey(province.sourceCountryId, source));
      if (!mapping || !same(mapping.source, source) || !mapping.provinceIds.includes(province.provinceId)) return geographyFailure('GEOGRAPHY_SOURCE', `provinces.${province.provinceId}.sources`, 'Source identity lacks an admitted current cell linkage');
    }
  }
  const grouped = new Map<string, string[]>();
  for (const region of doc.sourceRegions) {
    const key = sourceKey(region.sourceCountryId, region.source), mapping = sourceMemberships.get(key);
    if (region.sourceRegionId !== createSourceRegionId(region.sourceCountryId, region.source.sourceId, region.source.sourceFeatureId) ||
        !mapping || !same(mapping.source, region.source) || !sameSet(region.provinceIds, mapping.provinceIds) || grouped.has(key)) {
      return geographyFailure('GEOGRAPHY_SOURCE', `sourceRegions.${region.sourceRegionId}`, 'A source group must match the entire admitted known membership of one original source identity');
    }
    for (const id of region.provinceIds) {
      const p = provinces.get(id);
      if (!p || p.sourceCountryId !== region.sourceCountryId || !p.sources.some(s => same(s, region.source))) return geographyFailure('GEOGRAPHY_SOURCE', `sourceRegions.${region.sourceRegionId}`, 'Group member has a missing or different source identity');
    }
    grouped.set(key, region.provinceIds);
  }
  for (const p of doc.provinces) for (const source of p.sources) {
    if (!grouped.get(sourceKey(p.sourceCountryId, source))?.includes(p.provinceId)) return geographyFailure('GEOGRAPHY_SOURCE', `provinces.${p.provinceId}.sources`, 'Every named source linkage needs its canonical source group');
  }
  for (const [key, mapping] of sourceMemberships) {
    if (!sameSet(mapping.provinceIds, grouped.get(key) ?? [])) return geographyFailure('GEOGRAPHY_SOURCE', 'sourceRegions', 'An admitted source membership was omitted or relabeled');
  }
  const witnesses = new Map(context.coverageWitnesses.map(w => [`${w.target.kind}:${w.target.id}`, w]));
  if (witnesses.size !== context.coverageWitnesses.length) return geographyFailure('GEOGRAPHY_COVERAGE', 'coverageWitnesses', 'Conflicting coverage targets');
  const coverageTargets = new Set([...doc.states.map(s => `state:${s.stateId}`), ...doc.sourceRegions.map(s => `source-region:${s.sourceRegionId}`)]);
  if ([...witnesses.keys()].some(key => !coverageTargets.has(key))) return geographyFailure('GEOGRAPHY_COVERAGE', 'coverageWitnesses', 'Coverage witness targets an unknown geography record');
  for (const record of [...doc.states, ...doc.sourceRegions]) {
    const isState = record.kind === 'state', id = isState ? record.stateId : record.sourceRegionId;
    const memberIds = isState ? doc.provinces.filter(p => p.stateId === id).map(p => p.provinceId) : record.provinceIds;
    const coverage = record.coverage, witness = witnesses.get(`${record.kind}:${id}`);
    if (!evidenceDeclared(coverage.evidence) || witness && (!evidenceDeclared(witness.evidence) || witness.provinceIds.some(id => provinces.get(id)?.sourceCountryId !== record.sourceCountryId))) return geographyFailure('GEOGRAPHY_COVERAGE', `${record.kind}.${id}.coverage`, 'Coverage evidence or target cells are outside the admitted inputs/country');
    if (coverage.knownProvinceCount !== memberIds.length || coverage.expectedProvinceCount !== null && coverage.expectedProvinceCount < memberIds.length ||
        coverage.status !== 'complete' && !coverage.limitations.length || coverage.status === 'unsupported' && coverage.expectedProvinceCount !== null) {
      return geographyFailure('GEOGRAPHY_COVERAGE', `${record.kind}.${id}.coverage`, 'Known, expected and unsupported scope counts/limitations are inconsistent');
    }
    if (coverage.status === 'complete' && (!witness || !witness.evidence.length || !coverage.evidence.length ||
        !sameSet(memberIds, witness.provinceIds) || coverage.expectedProvinceCount !== witness.provinceIds.length ||
        !witness.evidence.every(e => coverage.evidence.some(actual => same(actual, e))))) {
      return geographyFailure('GEOGRAPHY_COVERAGE', `${record.kind}.${id}.coverage`, 'Complete coverage needs an independently admitted target set and matching evidence');
    }
    if (coverage.expectedProvinceCount !== null && (!witness || coverage.expectedProvinceCount !== witness.provinceIds.length || !memberIds.every(id => witness.provinceIds.includes(id)))) {
      return geographyFailure('GEOGRAPHY_COVERAGE', `${record.kind}.${id}.coverage`, 'An expected total needs an independently admitted target set containing all known members');
    }
  }
  for (const country of doc.countries) {
    const counts = countGeographyCountry(doc, country.sourceCountryId), knownSources = doc.sourceRegions.filter(r => r.sourceCountryId === country.sourceCountryId).length;
    const expectedParentSupport = counts.unassignedParents === 0 ? 'complete' : counts.unassignedParents === counts.provinces ? 'unsupported' : 'partial';
    if (!same(counts, country.counts) || country.nameSupport !== (counts.sourceNamed ? 'source-and-derived' : 'derived-only') || country.parentSupport !== expectedParentSupport || country.sourceFeatureCount !== null && country.sourceFeatureCount < knownSources) return geographyFailure('GEOGRAPHY_MEMBERSHIP', `countries.${country.sourceCountryId}`, 'Country summary does not match entities; unknown official totals must remain explicit');
    if (country.sourceFeatureCount !== null && !country.sourceFeatureCountEvidence.length || country.officialSubdivisionCount !== null && !country.officialSubdivisionCountEvidence.length ||
        !evidenceDeclared([...country.sourceFeatureCountEvidence, ...country.officialSubdivisionCountEvidence])) return geographyFailure('GEOGRAPHY_COVERAGE', `countries.${country.sourceCountryId}`, 'Known source/official totals need separate pinned evidence; use null for unknown');
  }
  return {ok: true, value: freeze(doc)};
}
