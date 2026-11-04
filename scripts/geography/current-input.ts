import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {gunzipSync} from 'node:zlib';
import {createWorldGeometryCatalogContract, readCatalogTerritoryId, type WorldGeometryCatalogContract} from '../../src/lib/world/world-geometry-catalog-ref';
import {readWorldV3CountryId} from '../../src/lib/world/world-v3-validation';
import type {OperationalAdministrativeParent, OperationalCell, OperationalPreviousParent, OperationalCatalogDescriptor} from '../../src/lib/world/operational-catalog';
import {geographyArtifactSchema, type GeographyArtifact} from '../../src/lib/geography/state-province-contract';
import {nameFactsSchema, nameOverridesSchema, sourceNameKey, validateNameOverrides, type NameEnrichmentInput, type PublishedNameFacts} from './name-enrichment';

export const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
export function requireInput(ok: unknown, code: string): asserts ok {if (!ok) throw Error(code);}
export const ordered = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
export type Properties = Record<string, unknown>;
type Pin = GeographyArtifact;
/** Source-lock inventories may annotate pins with countryId; the shared artifact is strict. */
export const pinIdentity = (p: Pin): Pin => ({path: p.path, sha256: p.sha256, byteLength: p.byteLength});
type SourceLock = {countryId: string; normalizedInput: Pin; sources: {sourceId: string; version: string; artifact: Pin}[]};
type GeoJson = {features: {id?: unknown; properties: Properties}[]};
export type MacroGroup = {macroId: string; sourceFeatureId: string; name: string; nameKo?: string | null; sourceVersion: string};
type Hierarchy = {
  countryId: string; macroGroups: MacroGroup[];
  members?: {sourceFeatureId: string; macroId: string; method: string; evidence?: {matchedPublisherChildId?: string; matchedPublisherChildName?: string}}[];
  assignments?: {sourceFeatureId: string; macroId: string; method: string}[];
  unresolved?: {sourceFeatureId: string}[]; artifacts?: Pin[];
  sourceAdmin1?: {sourceId: string; artifact: Pin; metadata?: Pin}; floatingPrecisionExceptions?: Pin;
};
export type ProducerParent = OperationalAdministrativeParent & {macroId?: string};
export type BundleRecord = {id: string; countryId: string; administrativeParentKey: string; previousParentId: string; seedParentIds?: string[]};
export type FineProfile = {
  countryId: string; sourceId: string; sourceVersion: string; raw: Pin; normalized: Pin; lock: Pin; hierarchy: Pin;
  rawFeatures: Map<string, Properties>; normalizedFeatures: Map<string, Properties>;
  groups: Map<string, MacroGroup>; assignments: Map<string, {macroId: string; method: string}>; unresolved: Set<string>;
  macroArtifact: Pin; macroSourceId: string; macroFeatures: Map<string, Properties>;
  localizedNames?: Map<string, PublishedNameFacts>;
};
export type GeographyProducerInput = {
  catalog: WorldGeometryCatalogContract; descriptor: OperationalCatalogDescriptor; cells: OperationalCell[];
  parents: ProducerParent[]; previous: OperationalPreviousParent[];
  records: Map<string, BundleRecord>; features: Map<string, Properties>; bundle: Pin; provenance: Pin;
  fineProfiles: Map<string, FineProfile>;
  coarse: {artifact: Pin; version: string; sourceId: string; features: Map<string, Properties>};
  nameEnrichment?: NameEnrichmentInput;
  inputPins: Pin[]; codePins: Pin[]; scenarioDate: string;
  assertUnchanged: () => void;
};

/** Reads are pinned and deduplicated. Large polygon arrays are discarded after property extraction. */
export class PinnedInputReader {
  readonly pins = new Map<string, Pin>();
  constructor(readonly root: string, readonly readFile = (file: string) => fs.readFileSync(file)) {}
  read(relative: string, expected?: Omit<Pin, 'path'>): Buffer {
    geographyArtifactSchema.shape.path.parse(relative);
    const bytes = this.readFile(path.join(this.root, relative));
    const pin = {path: relative, sha256: digest(bytes), byteLength: bytes.length};
    const prior = this.pins.get(relative);
    requireInput(!prior || prior.sha256 === pin.sha256 && prior.byteLength === pin.byteLength, `INPUT_CHANGED:${relative}`);
    requireInput(!expected || pin.sha256 === expected.sha256 && pin.byteLength === expected.byteLength, `INPUT_IDENTITY:${relative}`);
    this.pins.set(relative, pin);
    return bytes;
  }
  json<T>(relative: string, expected?: Omit<Pin, 'path'>): T {return JSON.parse(this.read(relative, expected).toString('utf8')) as T;}
  pin(relative: string, expected?: Omit<Pin, 'path'>): Pin {this.read(relative, expected); return this.pins.get(relative)!;}
  assertUnchanged() {for (const p of this.pins.values()) this.read(p.path, p);}
}

const GENERATOR_CODE = [
  'scripts/geography/build-current-metadata.cjs', 'scripts/geography/current-input.ts',
  'scripts/geography/country-adapters.ts', 'scripts/geography/metadata-builder.ts', 'scripts/geography/verify-metadata.ts',
  'scripts/geography/name-enrichment.ts', 'scripts/geography/verify-name-metadata.ts',
  'src/lib/geography/state-province-contract.ts', 'src/lib/geography/state-province-validation.ts', 'src/lib/geography/state-province-io.ts',
  'src/lib/world/canonical-serializer.ts', 'src/lib/world/sha256.ts', 'src/lib/world/world-geometry-catalog-ref.ts',
  'src/lib/world/world-v3-validation.ts', 'src/lib/world/country-id.ts', 'src/lib/world/territory-id.ts',
  'src/lib/world/immutable-readonly-set.ts', 'src/lib/world/domain-hash-root.ts', 'package-lock.json',
];

function featuresBy(reader: PinnedInputReader, artifact: Pin, key: string): Map<string, Properties> {
  const input = reader.json<GeoJson>(artifact.path, artifact);
  const values = new Map(input.features.map(f => [String(f.properties[key]), f.properties]));
  requireInput(values.size === input.features.length && !values.has('undefined'), `SOURCE_FEATURE_IDS:${artifact.path}`);
  return values;
}

function readFineProfile(reader: PinnedInputReader, lockPin: Pin & {countryId: string}, hierarchyPin: Pin): FineProfile {
  const lock = reader.json<SourceLock>(lockPin.path, lockPin), hierarchy = reader.json<Hierarchy>(hierarchyPin.path, hierarchyPin);
  requireInput(lock.countryId === lockPin.countryId && hierarchy.countryId === lock.countryId && lock.sources.length === 1, 'FINE_SOURCE_PROFILE');
  const original = lock.sources[0];
  const rawFeatures = featuresBy(reader, original.artifact, 'shapeID');
  const normalizedFeatures = featuresBy(reader, lock.normalizedInput, 'sourceFeatureId');
  requireInput(rawFeatures.size === normalizedFeatures.size, 'NORMALIZED_SOURCE_COUNT');
  for (const [id, p] of normalizedFeatures) {
    const raw = rawFeatures.get(id);
    requireInput(raw && raw.shapeGroup === lock.countryId && p.countryId === lock.countryId && p.sourceId === original.sourceId && p.name === raw.shapeName, `NORMALIZED_SOURCE_IDENTITY:${id}`);
  }
  const assignments = new Map((hierarchy.members ?? hierarchy.assignments ?? []).map(m => [m.sourceFeatureId, {macroId: m.macroId, method: m.method}]));
  const unresolved = new Set((hierarchy.unresolved ?? []).map(m => m.sourceFeatureId));
  requireInput(assignments.size === (hierarchy.members ?? hierarchy.assignments ?? []).length && assignments.size + unresolved.size === rawFeatures.size, 'HIERARCHY_PARTITION');
  for (const id of rawFeatures.keys()) requireInput(Number(assignments.has(id)) + Number(unresolved.has(id)) === 1, `HIERARCHY_SOURCE:${id}`);
  const groups = new Map(hierarchy.macroGroups.map(g => [g.macroId, g]));
  requireInput(groups.size === hierarchy.macroGroups.length, 'DUPLICATE_MACRO_SOURCE');
  for (const a of assignments.values()) requireInput(groups.has(a.macroId), 'UNKNOWN_MACRO_SOURCE');
  for (const p of hierarchy.artifacts ?? []) reader.pin(p.path, p);
  if (hierarchy.floatingPrecisionExceptions) reader.pin(hierarchy.floatingPrecisionExceptions.path, hierarchy.floatingPrecisionExceptions);
  let macroArtifact: Pin, macroSourceId: string, macroFeatures: Map<string, Properties>;
  const localizedNames = new Map<string, PublishedNameFacts>();
  if (hierarchy.sourceAdmin1) {
    macroArtifact = hierarchy.sourceAdmin1.artifact;
    macroSourceId = hierarchy.sourceAdmin1.sourceId;
    macroFeatures = featuresBy(reader, macroArtifact, 'shapeID');
    if (hierarchy.sourceAdmin1.metadata) reader.pin(hierarchy.sourceAdmin1.metadata.path, hierarchy.sourceAdmin1.metadata);
  } else {
    const facts = hierarchy.artifacts?.find(p => p.path.endsWith('/hierarchy-facts.json'));
    requireInput(facts, 'MISSING_PUBLISHER_MACRO_FACTS');
    const value = reader.json<{parents: Properties[]; children: Properties[]}>(facts.path, facts);
    macroArtifact = facts; macroSourceId = 'publisher-hierarchy-facts';
    macroFeatures = new Map(value.parents.map(p => [String(p.id), p]));
    requireInput(macroFeatures.size === value.parents.length, 'DUPLICATE_PUBLISHER_MACRO');
    const children = new Map(value.children.map(p => [String(p.id), p]));
    requireInput(children.size === value.children.length, 'DUPLICATE_PUBLISHER_CHILD');
    for (const member of hierarchy.members ?? []) {
      const id = member.evidence?.matchedPublisherChildId;
      if (!id) continue;
      const child = children.get(id);
      requireInput(child && child.name === member.evidence?.matchedPublisherChildName, `PUBLISHER_CHILD_NAME:${member.sourceFeatureId}`);
      localizedNames.set(member.sourceFeatureId, {artifact: pinIdentity(facts), locator: `child.id:${id}`,
        hierarchyArtifact: pinIdentity(hierarchyPin), sourceFeatureId: member.sourceFeatureId, properties: child});
    }
  }
  for (const group of groups.values()) {
    const p = macroFeatures.get(group.sourceFeatureId);
    requireInput(p && (p.shapeName ?? p.name) === group.name, `MACRO_SOURCE_NAME:${group.macroId}`);
    requireInput(!group.nameKo || (p.native ?? p.name_ko) === group.nameKo, `MACRO_LOCALIZED_NAME:${group.macroId}`);
  }
  return {countryId: lock.countryId, sourceId: original.sourceId, sourceVersion: original.version, raw: pinIdentity(original.artifact),
    normalized: pinIdentity(lock.normalizedInput), lock: pinIdentity(lockPin), hierarchy: pinIdentity(hierarchyPin), rawFeatures, normalizedFeatures,
    groups, assignments, unresolved, macroArtifact: pinIdentity(macroArtifact), macroSourceId, macroFeatures, localizedNames};
}

export function readCurrentGeographyInput(root = process.cwd()): GeographyProducerInput {
  const reader = new PinnedInputReader(root);
  const pointer = reader.json<{catalogVersion: string; root: string; index: Omit<Pin, 'path'>}>('data/runtime/operational-catalog/current.json');
  const index = reader.json<{schemaVersion: string; artifacts: Pin[]}>(`${pointer.root}/artifact-index.json`, pointer.index);
  const artifacts = new Map(index.artifacts.map(a => [a.path, a]));
  requireInput(index.schemaVersion === 'operational-world-delivery-v2' && artifacts.size === index.artifacts.length, 'ARTIFACT_INDEX');
  const delivery = (file: string) => {const pin = artifacts.get(file); requireInput(pin, `MISSING_ARTIFACT:${file}`); return reader.read(`${pointer.root}/${file}`, pin);};
  const descriptor = JSON.parse(delivery('catalog.json').toString()) as OperationalCatalogDescriptor;
  const manifest = JSON.parse(delivery('manifest.json').toString());
  const detail = JSON.parse(delivery('detail-index.json').toString()) as {countries: {countryId: string; cellCount: number; metadata: Pin}[]};
  const parents = JSON.parse(gunzipSync(delivery('metadata/parents.json.gz')).toString()) as {administrative: ProducerParent[]; previous: OperationalPreviousParent[]};
  const provenance = JSON.parse(delivery('provenance.json').toString()) as {
    inputs: Pin[]; inputRoot: string; sourceLockArtifacts: (Pin & {countryId: string})[];
    hierarchyArtifacts: (Pin & {countryId: string})[]; fineCountries: string[]; incremental?: {scenarioDate: string};
  };
  requireInput(pointer.catalogVersion === descriptor.catalogRef.catalogVersion && manifest.ref.catalogVersion === pointer.catalogVersion &&
    ['geometryRoot', 'topologyRoot', 'renderArtifactRoot'].every(k => manifest.ref[k] === descriptor.catalogRef[k as keyof typeof descriptor.catalogRef]) &&
    JSON.stringify(manifest.counts) === JSON.stringify(descriptor.counts), 'CATALOG_MANIFEST_REF');
  requireInput(detail.countries.length === descriptor.counts.countries && JSON.stringify(detail.countries.map(c => c.countryId)) === JSON.stringify(descriptor.countryOrder), 'DETAIL_COUNTRY_ORDER');
  const administrative = parents.administrative.map((p, i) => ({...p, ordinal: i + 1}));
  const previous = parents.previous.map((p, i) => ({...p, ordinal: i + 1}));
  requireInput(administrative.length === descriptor.counts.administrativeParents && previous.length === descriptor.counts.previousParents, 'PARENT_COUNTS');
  requireInput(digest(Buffer.from(JSON.stringify(parents.administrative) + '\n')) === descriptor.indexRoots.administrativeMembership &&
    digest(Buffer.from(JSON.stringify(parents.previous) + '\n')) === descriptor.indexRoots.previousParent, 'PARENT_ROOTS');
  const cells: OperationalCell[] = [], ids = new Set<string>(), ordinals = new Set<number>();
  const adminCounts = new Array(administrative.length).fill(0), previousCounts = new Array(previous.length).fill(0);
  for (const country of detail.countries) {
    const meta = JSON.parse(gunzipSync(delivery(country.metadata.path)).toString()) as {countryId: string; columns: string[]; rows: [number, string, number, number][]};
    requireInput(meta.countryId === country.countryId && meta.rows.length === country.cellCount && meta.columns.join(',') === 'cellOrdinal,cellId,administrativeOrdinal,previousParentOrdinal', 'COUNTRY_ROWS');
    let last = 0;
    for (const [ordinal, id, a, p] of meta.rows) {
      requireInput(Number.isSafeInteger(ordinal) && ordinal > last && ordinal <= descriptor.counts.cells && !ids.has(id) && !ordinals.has(ordinal), 'CELL_ORDER_OR_DUPLICATE');
      requireInput(administrative[a - 1]?.sourceCountryId === country.countryId && previous[p - 1]?.sourceCountryId === country.countryId, 'PARENT_COUNTRY');
      last = ordinal; ids.add(id); ordinals.add(ordinal); adminCounts[a - 1]++; previousCounts[p - 1]++;
      cells.push({id: readCatalogTerritoryId(id), ordinal, sourceCountryId: readWorldV3CountryId(country.countryId, 'sourceCountryId'), administrativeOrdinal: a, previousParentOrdinal: p});
    }
  }
  cells.sort((a, b) => a.ordinal - b.ordinal);
  requireInput(cells.length === descriptor.counts.cells && cells.every((c, i) => c.ordinal === i + 1) &&
    adminCounts.every((n, i) => n === administrative[i].count) && previousCounts.every((n, i) => n === previous[i].count), 'COMPLETE_CATALOG_MEMBERSHIP');
  const territoryOrder = cells.map(c => c.id);
  requireInput(digest(Buffer.from(JSON.stringify(territoryOrder) + '\n')) === descriptor.indexRoots.catalogOrder, 'CATALOG_ORDER_ROOT');
  const catalog = createWorldGeometryCatalogContract({ref: descriptor.catalogRef, territoryOrder, territoriesById: Object.fromEntries(cells.map(c => [c.id, {id: c.id, sourceCountryId: c.sourceCountryId}]))});
  const bundlePin = provenance.inputs[0]; requireInput(bundlePin.sha256 === provenance.inputRoot, 'BUNDLE_INPUT_ROOT');
  const bundle = reader.json<{records: BundleRecord[]; features: {id: string; properties: Properties}[]; edges: unknown[]}>(bundlePin.path, bundlePin);
  const records = new Map(bundle.records.map(r => [r.id, r])), features = new Map(bundle.features.map(f => [f.id, f.properties]));
  requireInput(records.size === cells.length && features.size === cells.length && records.size === bundle.records.length && features.size === bundle.features.length && bundle.edges.length === descriptor.counts.edges, 'BUNDLE_MEMBERSHIP');
  for (const cell of cells) {
    const record = records.get(cell.id), properties = features.get(cell.id), parent = administrative[cell.administrativeOrdinal - 1], prior = previous[cell.previousParentOrdinal - 1];
    requireInput(record && properties && record.countryId === cell.sourceCountryId && properties.countryId === cell.sourceCountryId && record.administrativeParentKey === parent.parentKey && record.previousParentId === prior.oldTerritoryId, `BUNDLE_CELL_LINK:${cell.id}`);
    if (record.seedParentIds) requireInput(JSON.stringify(record.seedParentIds) === JSON.stringify(properties.seedParentIds) && record.seedParentIds.every(id => (prior.seedParentIds ?? [prior.oldTerritoryId]).includes(readCatalogTerritoryId(id))), `SEED_LINEAGE:${cell.id}`);
  }
  const fineProfiles = new Map<string, FineProfile>();
  requireInput(new Set(provenance.fineCountries).size === provenance.fineCountries.length && provenance.sourceLockArtifacts.length === provenance.fineCountries.length, 'FINE_COUNTRY_SOURCES');
  for (const country of [...provenance.fineCountries].sort(ordered)) {
    const lock = provenance.sourceLockArtifacts.find(a => a.countryId === country), hierarchy = provenance.hierarchyArtifacts.find(a => a.countryId === country);
    requireInput(lock && hierarchy && descriptor.countryOrder.includes(country), `FINE_COUNTRY_INPUT:${country}`);
    fineProfiles.set(country, readFineProfile(reader, lock, hierarchy));
  }
  const coarseLock = reader.json<{sourceVersion: string; lineageInputs: {repositoryPath: string; sha256: string; byteLength: number}[]}>('data/source-locks/prompt14-derived-game-input-lock.json');
  const coarsePin = coarseLock.lineageInputs.find(p => p.repositoryPath === 'data/raw/ne_10m_admin_1_states_provinces.geojson');
  requireInput(coarsePin, 'COARSE_SOURCE_LOCK');
  const coarseArtifact = {path: coarsePin.repositoryPath, sha256: coarsePin.sha256, byteLength: coarsePin.byteLength};
  const coarseFeatures = featuresBy(reader, coarseArtifact, 'ne_id');
  const factsPath = 'data/geography/names/verified-name-facts-v1.json', overridesPath = 'data/geography/names/source-name-overrides-v1.json';
  const nameEnrichment: NameEnrichmentInput = {facts: nameFactsSchema.parse(reader.json(factsPath)), factsArtifact: reader.pins.get(factsPath)!,
    overrides: nameOverridesSchema.parse(reader.json(overridesPath)), overridesArtifact: reader.pins.get(overridesPath)!};
  validateNameOverrides(nameEnrichment);
  for (const fact of nameEnrichment.facts.facts) if (fact.localSource) {
    reader.pin(fact.localSource.artifact.path, fact.localSource.artifact);
    requireInput(fact.localSource.artifact.path === coarseArtifact.path, 'UNSUPPORTED_LOCAL_NAME_FACT_SOURCE');
    const raw = coarseFeatures.get(fact.localSource.featureId);
    requireInput(raw && Object.entries(fact.localSource.requiredFields).every(([field, value]) => raw[field] === value), `LOCAL_NAME_FACT_CHANGED:${fact.id}`);
  }
  for (const row of nameEnrichment.overrides.entries) {
    const profile = fineProfiles.get(row.sourceCountryId);
    const fine = profile && row.sourceId === profile.sourceId && row.sourceVersion === profile.sourceVersion ? profile.rawFeatures.get(row.sourceFeatureId) : undefined;
    const macro = profile && row.sourceId === profile.macroSourceId ? [...profile.groups.values()].find(g => g.sourceFeatureId === row.sourceFeatureId && g.sourceVersion === row.sourceVersion) : undefined;
    requireInput((fine?.shapeName ?? macro?.name) === row.expectedSourceName, `NAME_OVERRIDE_TARGET_UNAVAILABLE:${sourceNameKey(row.sourceCountryId, row)}`);
  }
  const codePins = GENERATOR_CODE.map(file => reader.pin(file)).sort((a, b) => ordered(a.path, b.path));
  const codePaths = new Set(codePins.map(p => p.path));
  const inputPins = [...reader.pins.values()].filter(p => !codePaths.has(p.path)).sort((a, b) => ordered(a.path, b.path));
  return {catalog, descriptor, cells, parents: administrative, previous, records, features, bundle: bundlePin,
    provenance: reader.pins.get(`${pointer.root}/provenance.json`)!, fineProfiles,
    coarse: {artifact: coarseArtifact, version: coarseLock.sourceVersion, sourceId: 'natural-earth-admin1-states-provinces-10m', features: coarseFeatures},
    nameEnrichment, inputPins, codePins, scenarioDate: provenance.incremental?.scenarioDate ?? '2020-01-01', assertUnchanged: () => reader.assertUnchanged()};
}
