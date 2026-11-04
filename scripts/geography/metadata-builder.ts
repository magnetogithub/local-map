import fs from 'node:fs';
import path from 'node:path';
import {gzipSync} from 'node:zlib';
import {canonicalStringify} from '../../src/lib/world/canonical-serializer';
import {
  GEOGRAPHY_SCHEMA_VERSION, countGeographyCountry, createSourceRegionId, sealGeographyMetadata, stateIdSchema,
  type GeographyMetadataBody, type GeographyProvince, type GeographySourceRegion, type GeographyState,
} from '../../src/lib/geography/state-province-contract';
import {
  geographyArtifactBytes, identifyGeographyArtifact, geographyManifestSchema, geographyAdmissionEvidenceSchema,
  type GeographyAdmissionEvidence, type GeographyManifest,
} from '../../src/lib/geography/state-province-io';
import {evidenceAt, limitedCoverage, parentSource, provinceSource} from './country-adapters';
import {ordered, readCurrentGeographyInput, requireInput, type GeographyProducerInput} from './current-input';
import {verifyProducerMetadata} from './verify-metadata';
import {enrichCuratedNames, enrichPublishedNames} from './name-enrichment';

/** Pure producer over pinned properties and exact metadata rows. Never generates geometry. */
export function createCurrentGeographyMetadata(input: GeographyProducerInput) {
  const stateSources = input.parents.filter(p => p.kind === 'administrative').map(parent => ({parent, data: parentSource(input, parent)}));
  const states: GeographyState[] = stateSources.map(({parent, data}) => ({
    kind: 'state' as const, stateId: stateIdSchema.parse(parent.parentKey), catalogParentKey: parent.parentKey,
    sourceCountryId: input.cells.find(c => c.sourceCountryId === parent.sourceCountryId)!.sourceCountryId,
    source: data.source, names: data.names, evidence: data.evidence,
    coverage: limitedCoverage(parent.count, data.coarse, data.evidence),
  })).sort((a, b) => ordered(a.stateId, b.stateId));
  const provinces: GeographyProvince[] = [];
  const groups = new Map<string, GeographySourceRegion>();
  for (const cell of input.cells) {
    const parent = input.parents[cell.administrativeOrdinal - 1], data = provinceSource(input, cell);
    provinces.push({kind: 'province', provinceId: cell.id, sourceCountryId: cell.sourceCountryId,
      names: data.names, precision: data.precision, geometryStatus: data.geometryStatus,
      sources: data.source ? [data.source] : [], evidence: data.evidence, parentEvidence: data.parentEvidence,
      ...(parent.kind === 'administrative'
        ? {parentStatus: 'verified' as const, stateId: stateIdSchema.parse(parent.parentKey), unassignedReason: null}
        : {parentStatus: 'unassigned' as const, stateId: null, unassignedReason: data.source ? 'Source hierarchy explicitly leaves the macro parent unconfirmed.' : 'Source-free game residual; no official state attribution.'})});
    if (data.source) {
      const id = createSourceRegionId(cell.sourceCountryId, data.source.sourceId, data.source.sourceFeatureId);
      let group = groups.get(id);
      if (!group) {
        group = {kind: 'source-region', sourceRegionId: id, sourceCountryId: cell.sourceCountryId, source: data.source,
          names: data.names, provinceIds: [], evidence: data.evidence,
          coverage: limitedCoverage(0, data.precision === 'coarse', data.evidence)};
        groups.set(id, group);
      }
      requireInput(canonicalStringify(group.source) === canonicalStringify(data.source), 'SOURCE_GROUP_VERSION_CONFLICT');
      group.provinceIds.push(cell.id);
    }
  }
  const sourceRegions = [...groups.values()].sort((a, b) => ordered(a.sourceRegionId, b.sourceRegionId));
  for (const group of sourceRegions) {
    group.provinceIds.sort(ordered); group.coverage.knownProvinceCount = group.provinceIds.length;
    // Group evidence points to the raw source and fixed bundle, not to a chosen first cell.
    const evidence = group.evidence.map(e => e.artifact.path === input.bundle.path ? {...e, locator: `source:${group.source.sourceId}:${group.source.sourceFeatureId}`} : e);
    group.evidence = evidence; group.coverage.evidence = evidence;
  }
  const body: GeographyMetadataBody = {schemaVersion: GEOGRAPHY_SCHEMA_VERSION, catalogRef: input.catalog.ref,
    provenance: {scenarioDate: input.scenarioDate, method: `Pinned current-catalog source join; no geometry operations. gzip-level-9-v1; node=${process.versions.node}; zlib=${process.versions.zlib}; platform=${process.platform}.`,
      inputs: input.inputPins, code: input.codePins, limitations: [
        'Known source membership is complete; original geographic coverage is not independently certified in this metadata-only task.',
        'Existing gameplay polygons are source-derived/game-adjusted; source-exact equality and scenario-date legal status are not certified.',
        'Coarse countries retain their existing resolution. No missing official units, translations or state assignments are invented.',
        'Fine-country source-lock and hierarchy files retain vintage, license, source-count and manual game-correction limitations.',
      ]}, states, provinces: provinces.sort((a, b) => ordered(a.provinceId, b.provinceId)), sourceRegions, countries: []};
  for (const record of [...body.states, ...body.provinces, ...body.sourceRegions]) {
    const source = record.kind === 'province' ? record.sources[0] : record.source;
    if (!source) continue;
    const profile = input.fineProfiles.get(record.sourceCountryId);
    const published = source.sourceId === profile?.sourceId ? profile.localizedNames?.get(source.sourceFeatureId) : undefined;
    record.names = enrichCuratedNames(enrichPublishedNames(record.names, published), source, record.sourceCountryId, input.nameEnrichment);
  }
  body.countries = input.descriptor.countryOrder.map(countryId => {
    const counts = countGeographyCountry(body, countryId), profile = input.fineProfiles.get(countryId);
    return {sourceCountryId: input.catalog.territoriesById[input.cells.find(c => c.sourceCountryId === countryId)!.id].sourceCountryId,
      counts, sourceFeatureCount: profile?.rawFeatures.size ?? null, officialSubdivisionCount: null,
      sourceFeatureCountEvidence: profile ? [evidenceAt(profile.normalized, 'features.length', 'actual-fixed-source-feature-count')] : [],
      officialSubdivisionCountEvidence: [], nameSupport: counts.sourceNamed ? 'source-and-derived' as const : 'derived-only' as const,
      parentSupport: counts.unassignedParents === 0 ? 'complete' as const : counts.unassignedParents === counts.provinces ? 'unsupported' as const : 'partial' as const};
  });
  const metadata = sealGeographyMetadata(body);
  const admission: GeographyAdmissionEvidence = geographyAdmissionEvidenceSchema.parse({schemaVersion: 'geography-admission-v1',
    catalogRef: input.catalog.ref, metadataRef: metadata.metadataRef,
    parentSources: states.map(s => ({parentKey: s.stateId, source: s.source})),
    sourceMemberships: sourceRegions.map(g => ({sourceCountryId: g.sourceCountryId, source: g.source, provinceIds: g.provinceIds})),
    coverageWitnesses: [],
  });
  const verification = verifyProducerMetadata(metadata, admission, input);
  return {metadata, admission, verification};
}

/** Existing outputs are immutable; a partial previous run can only be completed with identical bytes. */
export function writeImmutable(file: string, bytes: Uint8Array) {
  try {fs.writeFileSync(file, bytes, {flag: 'wx'});}
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    requireInput(fs.readFileSync(file).equals(Buffer.from(bytes)), `IMMUTABLE_METADATA_CHANGED:${file}`);
  }
}

/** Artifact identity covers gzip bytes; metadataRef still covers decoded canonical body. */
export const encodeMetadataArtifact = (value: unknown) => gzipSync(geographyArtifactBytes(value), {level: 9});

export function buildCurrentGeographyMetadata(root = process.cwd()) {
  const input = readCurrentGeographyInput(root), result = createCurrentGeographyMetadata(input);
  const relative = `data/derived/geography/${result.metadata.metadataRef.contentRoot}`;
  const bytes = {metadata: encodeMetadataArtifact(result.metadata), admission: encodeMetadataArtifact(result.admission)};
  const manifest: GeographyManifest = geographyManifestSchema.parse({schemaVersion: 'state-province-manifest-v1', purpose: 'production',
    catalogRef: input.catalog.ref, metadataRef: result.metadata.metadataRef,
    metadata: identifyGeographyArtifact(`${relative}/metadata.json.gz`, bytes.metadata), admission: identifyGeographyArtifact(`${relative}/admission.json.gz`, bytes.admission)});
  const report = {schemaVersion: 'geography-metadata-generation-v1', catalogRef: input.catalog.ref, metadataRef: result.metadata.metadataRef,
    manifestPurpose: manifest.purpose, validation: result.verification, countries: result.metadata.countries,
    omittedOriginalSourceFeatures: [...input.fineProfiles.values()].map(profile => ({countryId: profile.countryId,
      sourceFeatureIds: [...profile.rawFeatures.keys()].filter(id => !result.admission.sourceMemberships.some(s => s.sourceCountryId === profile.countryId && s.source.sourceFeatureId === id)).sort(ordered),
      meaning: 'No current game cell has this original source identity. No new geometry or automatic incorporation.'})),
    preservation: {inputsUnchanged: true, activeCatalogPointerUnchanged: true, geometryOperations: 0, runtimeWrites: 0},
    transport: {encoding: 'gzip', decodedFormat: 'canonical-json-plus-LF', compressionProfile: 'gzip-level-9-v1',
      node: process.versions.node, zlib: process.versions.zlib, platform: process.platform},
    consumerStatus: 'Immutable producer output only; runtime selection/API integration belongs to 20-08.'};
  input.assertUnchanged();
  fs.mkdirSync(path.join(root, relative), {recursive: true});
  writeImmutable(path.join(root, relative, 'metadata.json.gz'), bytes.metadata);
  writeImmutable(path.join(root, relative, 'admission.json.gz'), bytes.admission);
  writeImmutable(path.join(root, relative, 'generation-report.json'), geographyArtifactBytes(report));
  writeImmutable(path.join(root, relative, 'manifest.json'), geographyArtifactBytes(manifest));
  const manifestIdentity = identifyGeographyArtifact(`${relative}/manifest.json`, geographyArtifactBytes(manifest));
  return {manifest: manifestIdentity, metadataRef: result.metadata.metadataRef, catalogRef: input.catalog.ref,
    counts: result.verification.counts, outputByteLength: bytes.metadata.length + bytes.admission.length,
    report: `${relative}/generation-report.json`};
}
