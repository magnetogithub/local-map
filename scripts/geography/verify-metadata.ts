import path from 'node:path';
import {gunzipSync} from 'node:zlib';
import {canonicalStringify} from '../../src/lib/world/canonical-serializer';
import {validateGeographyMetadata} from '../../src/lib/geography/state-province-validation';
import {validateGeographyAdmissionEvidence, validateGeographyManifest, type GeographyAdmissionEvidence} from '../../src/lib/geography/state-province-io';
import {type GeographyArtifact, type GeographyMetadata, type GeographySource} from '../../src/lib/geography/state-province-contract';
import {PinnedInputReader, ordered, readCurrentGeographyInput, requireInput, type GeographyProducerInput} from './current-input';
import {verifyMetadataNames} from './verify-name-metadata';

const key = (country: string, source: Pick<GeographySource, 'sourceId' | 'sourceFeatureId' | 'sourceVersion'>) => JSON.stringify([country, source.sourceId, source.sourceFeatureId, source.sourceVersion]);
const same = (a: unknown, b: unknown) => canonicalStringify(a) === canonicalStringify(b);
const normalizedName = (v: unknown) => typeof v === 'string' && v.trim() ? v.trim().replace(/\s+/gu, ' ') : null;

/** Independently re-derive source/parent membership from pinned raw identities and current rows.
 * Does not import the producer adapters or infer any target set from coverage flags. */
export function verifyProducerMetadata(metadata: GeographyMetadata, admission: GeographyAdmissionEvidence, input: GeographyProducerInput) {
  requireInput(same(metadata.provenance.inputs, input.inputPins) && same(metadata.provenance.code, input.codePins), 'GENERATOR_PROVENANCE');
  requireInput(admission.coverageWitnesses.length === 0, 'NO_UNVERIFIED_COMPLETE_WITNESS');
  const actual = new Map(metadata.provinces.map(p => [p.provinceId as string, p]));
  const groupMembers = new Map<string, string[]>();
  const rawParents = new Map(input.parents.filter(p => p.kind === 'administrative').map(p => [p.parentKey, p]));
  requireInput(actual.size === input.cells.length && metadata.provinces.length === input.cells.length && metadata.states.length === rawParents.size, 'PRODUCER_ENTITY_COUNTS');
  let fine = 0, coarse = 0, residual = 0, unassigned = 0, sourceFree = 0, sourceLinked = 0;
  for (const cell of input.cells) {
    const province = actual.get(cell.id), parent = input.parents[cell.administrativeOrdinal - 1], p = input.features.get(cell.id)!;
    requireInput(province && province.sourceCountryId === cell.sourceCountryId, `VERIFY_PROVINCE:${cell.id}`);
    requireInput(province.stateId === (parent.kind === 'administrative' ? parent.parentKey : null) && province.parentStatus === (parent.kind === 'administrative' ? 'verified' : 'unassigned'), `VERIFY_PARENT:${cell.id}`);
    if (province.stateId === null) unassigned++;
    const profile = input.fineProfiles.get(cell.sourceCountryId);
    const identity = p.fineSourceIdentity as {sourceId: string; sourceFeatureId: string} | null | undefined;
    let expectedSource: Pick<GeographySource, 'sourceId' | 'sourceFeatureId' | 'sourceVersion' | 'artifact'> | null = null;
    let originalName: unknown;
    if (profile && identity) {
      fine++;
      const raw = profile.rawFeatures.get(identity.sourceFeatureId), normalized = profile.normalizedFeatures.get(identity.sourceFeatureId);
      requireInput(raw && normalized && identity.sourceId === profile.sourceId && p.sourceVersion === profile.sourceVersion, `VERIFY_RAW_IDENTITY:${cell.id}`);
      requireInput(raw.shapeName === normalized.name && p.name === normalized.name, `VERIFY_RAW_NAME:${cell.id}`);
      const assignment = profile.assignments.get(identity.sourceFeatureId);
      requireInput(assignment ? parent.macroId === assignment.macroId && parent.kind === 'administrative' : profile.unresolved.has(identity.sourceFeatureId) && parent.kind === 'country-envelope-residual', `VERIFY_SOURCE_PARENT:${cell.id}`);
      expectedSource = {sourceId: profile.sourceId, sourceFeatureId: identity.sourceFeatureId, sourceVersion: profile.sourceVersion, artifact: profile.raw};
      originalName = raw.shapeName;
      requireInput(province.precision === 'fine', 'VERIFY_FINE_PRECISION');
    } else if (!profile) {
      coarse++; requireInput(province.precision === 'coarse', 'VERIFY_COARSE_PRECISION');
      if (parent.kind === 'administrative') {
        requireInput(parent.sourceFeatureId && input.coarse.features.has(parent.sourceFeatureId), 'VERIFY_COARSE_SOURCE');
        expectedSource = {sourceId: input.coarse.sourceId, sourceFeatureId: parent.sourceFeatureId, sourceVersion: input.coarse.version, artifact: input.coarse.artifact};
        originalName = input.coarse.features.get(parent.sourceFeatureId)!.name;
      }
    } else {residual++; requireInput(province.precision === 'residual', 'VERIFY_RESIDUAL_PRECISION');}
    if (expectedSource) {
      sourceLinked++;
      const source = province.sources[0];
      requireInput(province.sources.length === 1 && source.sourceId === expectedSource.sourceId && source.sourceFeatureId === expectedSource.sourceFeatureId && source.sourceVersion === expectedSource.sourceVersion && same(source.artifact, expectedSource.artifact), `VERIFY_SOURCE_REFERENCE:${cell.id}`);
      requireInput(province.names.sourceName?.value === normalizedName(originalName) || !normalizedName(originalName) && province.names.sourceName === null, `VERIFY_NAME_REFERENCE:${cell.id}`);
      requireInput(province.geometryStatus === 'game-adjusted', 'NO_UNCERTIFIED_SOURCE_EXACT');
      const k = key(cell.sourceCountryId, source), values = groupMembers.get(k) ?? []; values.push(cell.id); groupMembers.set(k, values);
    } else {
      sourceFree++;
      requireInput(!province.sources.length && province.geometryStatus === 'source-free' && province.names.sourceName === null && province.names.nameKo === null && province.names.nameEn === null && province.names.displayBasis === 'derived', `VERIFY_DERIVED_LABEL:${cell.id}`);
    }
  }
  for (const state of metadata.states) {
    const parent = rawParents.get(state.stateId); requireInput(parent, 'VERIFY_STATE_KEY');
    const profile = input.fineProfiles.get(parent.sourceCountryId);
    if (profile) {
      const group = profile.groups.get(parent.macroId!); requireInput(group, 'VERIFY_MACRO_CROSSWALK');
      requireInput(state.source.sourceId === profile.macroSourceId && state.source.sourceFeatureId === group.sourceFeatureId && state.source.sourceVersion === group.sourceVersion && same(state.source.artifact, profile.macroArtifact), 'VERIFY_MACRO_SOURCE');
      const raw = profile.macroFeatures.get(group.sourceFeatureId)!;
      requireInput(state.names.sourceName?.value === normalizedName(raw.shapeName ?? raw.name), 'VERIFY_MACRO_NAME');
    } else requireInput(state.source.sourceFeatureId === parent.sourceFeatureId && state.source.sourceId === input.coarse.sourceId && state.source.sourceVersion === input.coarse.version && same(state.source.artifact, input.coarse.artifact), 'VERIFY_COARSE_STATE');
  }
  requireInput(groupMembers.size === metadata.sourceRegions.length && groupMembers.size === admission.sourceMemberships.length, 'VERIFY_GROUP_CARDINALITY');
  for (const group of [...metadata.sourceRegions, ...admission.sourceMemberships]) {
    const expected = groupMembers.get(key(group.sourceCountryId, group.source));
    requireInput(expected && same([...group.provinceIds].sort(ordered), [...expected].sort(ordered)), 'VERIFY_COMPLETE_KNOWN_GROUP_MEMBERS');
  }
  for (const record of [...metadata.states, ...metadata.sourceRegions]) requireInput(record.coverage.status !== 'complete' && record.coverage.expectedProvinceCount === null && record.coverage.limitations.length, 'VERIFY_CONSERVATIVE_COVERAGE');
  for (const country of metadata.countries) requireInput(country.sourceFeatureCount === (input.fineProfiles.get(country.sourceCountryId)?.rawFeatures.size ?? null) && country.officialSubdivisionCount === null, 'VERIFY_SOURCE_AND_OFFICIAL_COUNTS');
  const validation = validateGeographyMetadata(metadata, {catalog: input.catalog, countryIds: input.descriptor.countryOrder,
    cells: input.cells, administrativeParents: input.parents, ...admission}, metadata.metadataRef);
  requireInput(validation.ok, `COMMON_CONTRACT:${validation.ok ? '' : JSON.stringify(validation.diagnostics)}`);
  const names = verifyMetadataNames(metadata, input);
  return {status: 'validated-metadata-only', counts: {countries: metadata.countries.length, provinces: actual.size,
    states: metadata.states.length, sourceRegions: groupMembers.size, fine, coarse, residual, sourceLinked, sourceFree, unassignedParents: unassigned},
    checks: {exactCatalogProvinceSet: true,sourceCountryMatches: true,rawSourceAndParentJoins: true,knownSourceMembershipComplete: true,
      unknownParentsRemainNull: true,coarsePrecisionPreserved: true,noUnverifiedCompleteCoverage: true,commonSchemaAndContentRoot: true},
    names, administrativeTruthClaim: false};
}

/** Offline artifact verification entry; a manifest alone cannot invent a PASS. */
export function verifyCurrentGeographyOutput(root: string, manifestPath: string) {
  const input = readCurrentGeographyInput(root), reader = new PinnedInputReader(root);
  const manifestResult = validateGeographyManifest(reader.json(manifestPath), {catalogRef: input.catalog.ref, metadataRef: null});
  requireInput(manifestResult.ok, `MANIFEST_REJECTED:${manifestResult.ok ? '' : JSON.stringify(manifestResult.diagnostics)}`);
  const manifest = manifestResult.value;
  const readPayload = (artifact: GeographyArtifact) => {
    const bytes = reader.read(artifact.path, artifact);
    return JSON.parse((artifact.path.endsWith('.json.gz') ? gunzipSync(bytes, {maxOutputLength: 128 * 1024 * 1024}) : bytes).toString('utf8'));
  };
  const metadata = readPayload(manifest.metadata) as GeographyMetadata;
  const admissionResult = validateGeographyAdmissionEvidence(readPayload(manifest.admission), manifest);
  requireInput(admissionResult.ok, 'ADMISSION_REJECTED');
  requireInput(same(metadata.metadataRef, manifest.metadataRef), 'MANIFEST_METADATA_ROOT');
  const verification = verifyProducerMetadata(metadata, admissionResult.value, input);
  input.assertUnchanged(); reader.assertUnchanged();
  return {manifest: reader.pins.get(manifestPath), metadataRef: metadata.metadataRef, catalogRef: input.catalog.ref, ...verification,
    outputDirectory: path.posix.dirname(manifestPath)};
}
