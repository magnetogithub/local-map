// @vitest-environment node
import {createHash} from 'node:crypto';
import {describe, expect, it} from 'vitest';
import {createStateProvinceContractFixture} from '../test-only/state-province-contract-fixture';
import {readOperationalCellState} from '../world/operational-catalog';
import {
  countGeographyCountry, createSourceRegionId, normalizeGeographyName, sealGeographyMetadata, stateIdSchema,
  type GeographyMetadata,
} from './state-province-contract';
import {validateGeographyMetadata, type GeographyAdmissionContext, type GeographyDiagnosticCode} from './state-province-validation';
import {
  geographyArtifactBytes, geographyManifestSchema, geographySearchRequestSchema, geographySnapshotKey,
  validateGeographyAdmissionEvidence, validateGeographyManifest, verifyGeographyArtifact,
} from './state-province-io';

const reseal = (doc: GeographyMetadata) => {
  const {metadataRef, ...body} = doc; void metadataRef;
  return sealGeographyMetadata(body);
};
function rejects(doc: GeographyMetadata, context: GeographyAdmissionContext, code: GeographyDiagnosticCode) {
  const result = validateGeographyMetadata(doc, context);
  expect(result).toMatchObject({ok: false, diagnostics: [{code}]});
  if (!result.ok) expect(result.diagnostics[0].remedy).toBeTruthy();
}

describe('state/province geography v1 common contract', () => {
  it('admits fictional states, source groups, known and null parents without inventing coverage', () => {
    const f = createStateProvinceContractFixture();
    const result = validateGeographyMetadata(f.metadata, f.context, f.metadata.metadataRef);
    expect(result.ok).toBe(true);
    if (!result.ok) throw Error(JSON.stringify(result.diagnostics));
    expect(result.value.provinces[2]).toMatchObject({provinceId: f.ids[2], parentStatus: 'unassigned', stateId: null, geometryStatus: 'game-adjusted'});
    expect(result.value.provinces[3].precision).toBe('coarse');
    expect(result.value.provinces[4]).toMatchObject({precision: 'residual', sources: [], names: {displayBasis: 'derived', sourceName: null, nameKo: null}});
    expect(result.value.states[1].coverage).toMatchObject({status: 'partial', expectedProvinceCount: null});
    expect(result.value.sourceRegions[2].coverage.status).toBe('unsupported');
    expect(result.value.countries[1].officialSubdivisionCount).toBeNull();
    expect(Object.isFrozen(result.value.provinces[0].names.aliases)).toBe(true);
    expect(f.metadata.states[0].source.sourceFeatureId).not.toBe(f.context.administrativeParents[0].sourceFeatureId);
  });

  it('keeps duplicate names as distinct identities and all cells of one source together', () => {
    const f = createStateProvinceContractFixture();
    const groups = f.metadata.sourceRegions.filter(r => r.names.sourceName?.value === 'Springfield');
    expect(groups).toHaveLength(2);
    expect(groups[0].sourceCountryId).not.toBe(groups[1].sourceCountryId);
    expect(groups[0].sourceRegionId).not.toBe(groups[1].sourceRegionId);
    expect(groups[0].provinceIds).toEqual(f.ids.slice(0, 2));
    const bad = structuredClone(f.metadata);
    bad.sourceRegions[0].provinceIds.pop();
    bad.sourceRegions[0].coverage.knownProvinceCount = 1;
    rejects(reseal(bad), f.context, 'GEOGRAPHY_SOURCE');
  });

  it('normalizes whitespace, NFKC and case without merging punctuation or different scripts', () => {
    expect(normalizeGeographyName('  Ｓｐｒｉｎｇｆｉｅｌｄ\t CITY  ')).toBe('springfield city');
    expect(normalizeGeographyName('청진')).toBe('청진');
    expect(normalizeGeographyName('A-B')).not.toBe(normalizeGeographyName('AB'));
  });

  it('changes metadata identity for name/alias edits while preserving state, province and source identity', () => {
    const f = createStateProvinceContractFixture(), changed = structuredClone(f.metadata);
    changed.provinces[0].names.aliases.push({value: 'Another spelling', language: 'en', basis: 'verified-alias', evidence: changed.provinces[0].evidence});
    changed.states[0].names.displayName = 'Fictional eastern state';
    changed.states[0].names.displayBasis = 'derived';
    const updated = reseal(changed);
    expect(validateGeographyMetadata(updated, f.context).ok).toBe(true);
    expect(updated.metadataRef).not.toEqual(f.metadata.metadataRef);
    expect(updated.provinces.map(p => p.provinceId)).toEqual(f.ids);
    expect(updated.states.map(s => s.stateId)).toEqual(f.metadata.states.map(s => s.stateId));
    expect(updated.sourceRegions.map(s => s.sourceRegionId)).toEqual(f.metadata.sourceRegions.map(s => s.sourceRegionId));
    expect(updated.catalogRef).toEqual(f.catalog.ref);
    expect(validateGeographyMetadata(updated, f.context, f.metadata.metadataRef)).toMatchObject({ok: false, diagnostics: [{code: 'GEOGRAPHY_METADATA'}]});
  });

  it('reads changed owner/controller from the supplied world while metadata remains static', () => {
    const f = createStateProvinceContractFixture(), bytes = geographyArtifactBytes(f.metadata);
    expect(readOperationalCellState(f.worldBefore, f.catalog.ref, f.ids[0]).ownerCountryId).toBe('AAA');
    expect(readOperationalCellState(f.worldAfter, f.catalog.ref, f.ids[0])).toMatchObject({sourceCountryId: 'AAA', ownerCountryId: 'BBB', controllerCountryId: 'BBB'});
    expect(f.metadata.provinces[0].sourceCountryId).toBe('AAA');
    expect(geographyArtifactBytes(f.metadata)).toEqual(bytes);
    const bad = structuredClone(f.metadata);
    Object.assign(bad.provinces[0], {ownerCountryId: 'BBB'});
    rejects(bad, f.context, 'GEOGRAPHY_SCHEMA');
  });

  it.each(['geometryRoot', 'topologyRoot', 'renderArtifactRoot', 'manifestPath'] as const)('rejects a different %s even with the same catalogVersion', field => {
    const f = createStateProvinceContractFixture(), bad = structuredClone(f.metadata);
    bad.catalogRef = {...bad.catalogRef, [field]: field === 'manifestPath' ? '/data/other/synthetic-geography-v1/manifest.json' : 'f'.repeat(64)};
    rejects(reseal(bad), f.context, 'GEOGRAPHY_CATALOG');
  });

  it('rejects changed bytes, unsealed content, stale metadata and fixture production use', () => {
    const f = createStateProvinceContractFixture();
    const tampered = structuredClone(f.metadata); tampered.provinces[0].names.displayName = 'tampered';
    rejects(tampered, f.context, 'GEOGRAPHY_METADATA');
    expect(validateGeographyManifest(f.manifest, {catalogRef: f.catalog.ref, metadataRef: f.metadata.metadataRef})).toMatchObject({ok: false, diagnostics: [{code: 'GEOGRAPHY_SOURCE'}]});
    expect(validateGeographyManifest(f.manifest, {catalogRef: f.catalog.ref, metadataRef: {...f.metadata.metadataRef, contentRoot: 'f'.repeat(64)}}, true)).toMatchObject({ok: false, diagnostics: [{code: 'GEOGRAPHY_METADATA'}]});
    const bytes = f.files.get(f.manifest.metadata.path)!;
    expect(verifyGeographyArtifact(f.manifest.metadata, bytes).ok).toBe(true);
    expect(verifyGeographyArtifact(f.manifest.metadata, new Uint8Array([...bytes, 32]))).toMatchObject({ok: false});
  });

  it('produces deterministic independent in-memory artifacts for A, B and C', () => {
    const f = createStateProvinceContractFixture(), other = createStateProvinceContractFixture();
    expect(other.manifestIdentity).toEqual(f.manifestIdentity);
    expect(validateGeographyManifest(f.manifest, {catalogRef: f.catalog.ref, metadataRef: null}, true).ok).toBe(true);
    expect(validateGeographyAdmissionEvidence(f.admission, f.manifest).ok).toBe(true);
    const bytes = f.files.get(f.manifest.metadata.path)!;
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(f.manifest.metadata.sha256);
    expect(geographyManifestSchema.safeParse({...f.manifest, metadata: {...f.manifest.metadata, path: '../escape.json'}}).success).toBe(false);
    expect(validateGeographyAdmissionEvidence({...f.admission, metadataRef: {...f.admission.metadataRef, contentRoot: 'f'.repeat(64)}}, f.manifest)).toMatchObject({ok: false});
  });

  it('separates snapshot keys by all geometry fields and metadata content', () => {
    const f = createStateProvinceContractFixture(), key = geographySnapshotKey(f.catalog.ref, f.metadata.metadataRef);
    expect(geographySnapshotKey({...f.catalog.ref, topologyRoot: 'f'.repeat(64)}, f.metadata.metadataRef)).not.toBe(key);
    expect(geographySnapshotKey(f.catalog.ref, {...f.metadata.metadataRef, contentRoot: 'f'.repeat(64)})).not.toBe(key);
  });

  it.each(['omit', 'duplicate', 'wrong-country'] as const)('rejects %s catalog province membership', operation => {
    const f = createStateProvinceContractFixture(), bad = structuredClone(f.metadata);
    if (operation === 'omit') bad.provinces.pop();
    if (operation === 'duplicate') bad.provinces.push(structuredClone(bad.provinces[0]));
    if (operation === 'wrong-country') bad.provinces[0].sourceCountryId = bad.provinces[3].sourceCountryId;
    rejects(reseal(bad), f.context, operation === 'wrong-country' ? 'GEOGRAPHY_CATALOG' : 'GEOGRAPHY_MEMBERSHIP');
  });

  it('rejects reassignment to a different or residual state', () => {
    const f = createStateProvinceContractFixture(), bad = structuredClone(f.metadata);
    bad.provinces[0] = {...bad.provinces[0], parentStatus: 'verified', stateId: f.stateB, unassignedReason: null};
    rejects(reseal(bad), f.context, 'GEOGRAPHY_PARENT');
    const residual = structuredClone(f.metadata);
    residual.states[0].stateId = stateIdSchema.parse('fine-macro-residual:AAA');
    residual.states[0].catalogParentKey = 'fine-macro-residual:AAA';
    rejects(reseal(residual), f.context, 'GEOGRAPHY_PARENT');
  });

  it('rejects a fabricated source identity, split source groups and dropped source attribution', () => {
    const f = createStateProvinceContractFixture(), bad = structuredClone(f.metadata);
    bad.provinces[0].sources[0].sourceFeatureId = 'invented';
    rejects(reseal(bad), f.context, 'GEOGRAPHY_SOURCE');
    const lost = structuredClone(f.metadata);
    lost.sourceRegions.pop();
    lost.provinces[3].sources = [];
    lost.provinces[3].geometryStatus = 'source-free';
    lost.provinces[3].names.sourceName = null;
    rejects(reseal(lost), f.context, 'GEOGRAPHY_SOURCE');
  });

  it('rejects complete coverage without the independently admitted target or with missing target members', () => {
    const f = createStateProvinceContractFixture();
    rejects(f.metadata, {...f.context, coverageWitnesses: []}, 'GEOGRAPHY_COVERAGE');
    const witness = structuredClone(f.admission.coverageWitnesses);
    witness[0].provinceIds.push(f.ids[2]);
    rejects(f.metadata, {...f.context, coverageWitnesses: witness}, 'GEOGRAPHY_COVERAGE');
    const fabricated = structuredClone(f.metadata);
    fabricated.sourceRegions[1].coverage = {...fabricated.sourceRegions[0].coverage, knownProvinceCount: 1, expectedProvinceCount: 1};
    rejects(reseal(fabricated), f.context, 'GEOGRAPHY_COVERAGE');
  });

  it('does not convert unknown totals to zero or English fallback to a verified Korean fact', () => {
    const f = createStateProvinceContractFixture(), bad = structuredClone(f.metadata);
    bad.countries[1].sourceFeatureCount = 0;
    rejects(reseal(bad), f.context, 'GEOGRAPHY_MEMBERSHIP');
    const unsupportedCount = structuredClone(f.metadata);
    unsupportedCount.countries[0].officialSubdivisionCount = 999;
    rejects(reseal(unsupportedCount), f.context, 'GEOGRAPHY_COVERAGE');
    const wrongDisplay = structuredClone(f.metadata);
    wrongDisplay.provinces[0].names.displayBasis = 'verified-translation';
    rejects(reseal(wrongDisplay), f.context, 'GEOGRAPHY_NAME');
    const extraName = structuredClone(f.metadata);
    Object.assign(extraName.provinces[0].names, {nameKoVerified: true});
    rejects(extraName, f.context, 'GEOGRAPHY_NAME');
  });

  it('bounds read pages independently of the existing 512-cell action cap', () => {
    expect(geographySearchRequestSchema.safeParse({sourceCountryId: null, kind: null, query: 'Springfield', page: {offset: 0, limit: 128}}).success).toBe(true);
    expect(geographySearchRequestSchema.safeParse({sourceCountryId: 'AAA', kind: null, query: 'Springfield', page: {offset: 0, limit: 129}}).success).toBe(false);
    const f = createStateProvinceContractFixture();
    expect(countGeographyCountry(f.metadata, 'AAA')).toMatchObject({provinces: 3, fine: 3, unassignedParents: 1});
    expect(createSourceRegionId('AAA', 'source', 'feature')).not.toBe(createSourceRegionId('BBB', 'source', 'feature'));
  });
});
