import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {gunzipSync} from 'node:zlib';
import {afterEach, describe, expect, it} from 'vitest';
import {createStateProvinceContractFixture} from '../../src/lib/test-only/state-province-contract-fixture';
import {geographyArtifactBytes, identifyGeographyArtifact} from '../../src/lib/geography/state-province-io';
import {sealGeographyMetadata} from '../../src/lib/geography/state-province-contract';
import {createCurrentGeographyMetadata, encodeMetadataArtifact, writeImmutable} from './metadata-builder';
import {PinnedInputReader, ordered, pinIdentity, type GeographyProducerInput} from './current-input';
import {verifyProducerMetadata} from './verify-metadata';
import {verifyMetadataNames} from './verify-name-metadata';

function producerFixture(): GeographyProducerInput {
  const fixture = createStateProvinceContractFixture(), raw = fixture.metadata.provinces[0].sources[0].artifact;
  const bundle = identifyGeographyArtifact('fixtures/geography/joined.json', geographyArtifactBytes({fixture: true}));
  const parents = fixture.context.administrativeParents.map(p => ({...p, ...(p.ordinal === 1 ? {macroId: 'AAA-east'} : {})}));
  const sourceId = 'fixture-children', sourceVersion = 'fixture-v1';
  const fineProfile = {countryId: 'AAA', sourceId, sourceVersion, raw, normalized: raw, lock: raw, hierarchy: raw,
    rawFeatures: new Map([['AAA-city', {shapeName: 'Springfield', shapeGroup: 'AAA'}], ['AAA-port', {shapeName: 'Old Port', shapeGroup: 'AAA'}]]),
    normalizedFeatures: new Map([['AAA-city', {name: 'Springfield', sourceId, countryId: 'AAA'}], ['AAA-port', {name: 'Old Port', sourceId, countryId: 'AAA'}]]),
    groups: new Map([['AAA-east', {macroId: 'AAA-east', sourceFeatureId: 'AAA-state', name: 'Springfield', sourceVersion}]]),
    assignments: new Map([['AAA-city', {macroId: 'AAA-east', method: 'fictional-crosswalk'}]]), unresolved: new Set(['AAA-port']),
    macroArtifact: raw, macroSourceId: 'fixture-macros', macroFeatures: new Map([['AAA-state', {shapeName: 'Springfield'}]])};
  const records = new Map(fixture.context.cells.map(c => [c.id as string, {id: c.id, countryId: c.sourceCountryId,
    administrativeParentKey: parents[c.administrativeOrdinal - 1].parentKey, previousParentId: c.id}]));
  const features = new Map(fixture.context.cells.map((c, i) => [c.id as string, i < 3 ? {
    countryId: 'AAA', fineSourceIdentity: {sourceId, sourceFeatureId: i === 2 ? 'AAA-port' : 'AAA-city'},
    sourceId, sourceFeatureId: i === 2 ? 'AAA-port' : 'AAA-city', sourceVersion,
    sourceParentId: i === 2 ? null : 'AAA-east', name: i === 2 ? 'Old Port' : 'Springfield',
  } : {countryId: 'BBB'}]));
  return {catalog: fixture.catalog, descriptor: {schemaVersion: 'operational-catalog-v1', catalogRef: fixture.catalog.ref,
    counts: {countries: 2, cells: 5, edges: 0, administrativeParents: 4, previousParents: 5}, countryOrder: ['AAA', 'BBB'],
    indexRoots: {catalogOrder: '1'.repeat(64), administrativeMembership: '2'.repeat(64), previousParent: '3'.repeat(64)}},
    cells: [...fixture.context.cells], parents, previous: [], records, features, bundle, provenance: raw,
    fineProfiles: new Map([['AAA', fineProfile]]),
    coarse: {artifact: raw, sourceId: 'fixture-coarse', version: sourceVersion,
      features: new Map([['BBB-east', {name: 'Springfield', name_en: 'Springfield', name_ko: 'Springfield'}]])},
    inputPins: [raw, bundle].sort((a, b) => ordered(a.path, b.path)), codePins: fixture.metadata.provenance.code,
    scenarioDate: '2020-01-01', assertUnchanged: () => {}};
}

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) {
    const resolved = path.resolve(directory), temporaryRoot = path.resolve(os.tmpdir()) + path.sep;
    if (!resolved.startsWith(temporaryRoot) || !path.basename(resolved).startsWith('geography-test-')) throw Error('UNSAFE_TEST_CLEANUP');
    fs.rmSync(resolved, {recursive: true, force: true});
  }
});

describe('offline current catalog metadata producer', () => {
  it('projects annotated source inventory pins to the exact shared artifact shape', () => {
    const pin = {...producerFixture().bundle, countryId: 'AAA'};
    expect(pinIdentity(pin)).toEqual({path: pin.path, sha256: pin.sha256, byteLength: pin.byteLength});
    expect(Object.keys(pinIdentity(pin))).toHaveLength(3);
  });
  it('covers every ID once, preserving fine/coarse/residual, null parents and many cells per original', () => {
    const input = producerFixture(), {metadata, admission, verification} = createCurrentGeographyMetadata(input);
    expect(metadata.provinces.map(p => p.provinceId)).toEqual(input.catalog.territoryOrder);
    expect(verification.counts).toEqual({countries: 2, provinces: 5, states: 2, sourceRegions: 3, fine: 3, coarse: 2, residual: 0, sourceLinked: 4, sourceFree: 1, unassignedParents: 2});
    expect(metadata.provinces[2]).toMatchObject({stateId: null, precision: 'fine', names: {sourceName: {value: 'Old Port'}}});
    expect(metadata.provinces[4]).toMatchObject({stateId: null, precision: 'coarse', sources: [], names: {displayBasis: 'derived', sourceName: null}});
    expect(metadata.sourceRegions.find(r => r.source.sourceFeatureId === 'AAA-city')!.provinceIds).toHaveLength(2);
    expect(metadata.states[0].stateId).toBe('coarse:BBB:fixture-east');
    expect(admission.coverageWitnesses).toEqual([]);
    expect([...metadata.states, ...metadata.sourceRegions].every(r => r.coverage.status !== 'complete' && r.coverage.expectedProvinceCount === null)).toBe(true);
  });

  it('is deterministic for identical pinned input and does not mutate the input or catalog', () => {
    const input = producerFixture(), before = structuredClone(input.catalog), features = structuredClone(input.features);
    const first = createCurrentGeographyMetadata(input), second = createCurrentGeographyMetadata(input);
    expect(geographyArtifactBytes(first.metadata)).toEqual(geographyArtifactBytes(second.metadata));
    expect(geographyArtifactBytes(first.admission)).toEqual(geographyArtifactBytes(second.admission));
    expect(input.catalog).toEqual(before); expect(input.features).toEqual(features);
    expect(encodeMetadataArtifact(first.metadata)).toEqual(encodeMetadataArtifact(second.metadata));
    expect(gunzipSync(encodeMetadataArtifact(first.metadata))).toEqual(Buffer.from(geographyArtifactBytes(first.metadata)));
  });

  it('keeps duplicate names separate and does not certify English fallback as Korean', () => {
    const {metadata} = createCurrentGeographyMetadata(producerFixture());
    const namesakes = metadata.sourceRegions.filter(r => r.names.sourceName?.value === 'Springfield');
    expect(namesakes).toHaveLength(2); expect(namesakes[0].sourceRegionId).not.toBe(namesakes[1].sourceRegionId);
    expect(metadata.provinces[3].names.nameKo).toBeNull();
    expect(metadata.countries.find(c => c.sourceCountryId === 'BBB')!.sourceFeatureCount).toBeNull();
    expect(metadata.countries.every(c => c.officialSubdivisionCount === null)).toBe(true);
  });

  it.each(['source', 'parent', 'version'] as const)('rejects changed fine %s input rather than guessing', field => {
    const input = producerFixture(), p = input.features.get(input.cells[0].id)!;
    if (field === 'source') p.fineSourceIdentity = {sourceId: 'invented', sourceFeatureId: 'AAA-city'};
    if (field === 'parent') p.sourceParentId = 'another-state';
    if (field === 'version') p.sourceVersion = 'stale-version';
    expect(() => createCurrentGeographyMetadata(input)).toThrow(/CELL_/);
  });

  it('rejects missing original coarse names/source identity instead of inventing a source', () => {
    const input = producerFixture(); input.coarse.features.clear();
    expect(() => createCurrentGeographyMetadata(input)).toThrow('COARSE_RAW_FEATURE');
  });

  it('independently catches falsified source groups, parent assignments and resealed coverage flags', () => {
    const input = producerFixture(), result = createCurrentGeographyMetadata(input);
    const broken = structuredClone(result.metadata);
    broken.sourceRegions[0].provinceIds.push(broken.provinces[4].provinceId);
    expect(() => verifyProducerMetadata(broken, result.admission, input)).toThrow('VERIFY_COMPLETE_KNOWN_GROUP_MEMBERS');
    const wrong = structuredClone(result.metadata);
    wrong.provinces[2] = {...wrong.provinces[2], parentStatus: 'verified', stateId: wrong.states[1].stateId, unassignedReason: null};
    expect(() => verifyProducerMetadata(wrong, result.admission, input)).toThrow('VERIFY_PARENT');
    const {metadataRef, ...body} = structuredClone(result.metadata); void metadataRef;
    body.sourceRegions[0].coverage.status = 'complete'; body.sourceRegions[0].coverage.expectedProvinceCount = body.sourceRegions[0].provinceIds.length;
    expect(() => verifyProducerMetadata(sealGeographyMetadata(body), result.admission, input)).toThrow('VERIFY_CONSERVATIVE_COVERAGE');
  });

  it('rejects a correct spelling attributed to an unrelated pinned input', () => {
    const input = producerFixture(), {metadata} = createCurrentGeographyMetadata(input);
    const bad = structuredClone(metadata);
    bad.provinces[0].names.sourceName!.evidence = [{artifact: input.bundle, locator: 'wrong-source', method: 'incorrect-attribution'}];
    expect(() => verifyMetadataNames(bad, input)).toThrow('NAME_ORIGINAL_EVIDENCE_MISMATCH');
  });

  it('pins real input bytes, detects replacement during generation and refuses path traversal', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'geography-test-')); directories.push(root);
    fs.writeFileSync(path.join(root, 'input.json'), '{}\n');
    const reader = new PinnedInputReader(root), pin = reader.pin('input.json');
    expect(reader.json('input.json', pin)).toEqual({});
    fs.writeFileSync(path.join(root, 'input.json'), '{"changed":true}\n');
    expect(() => reader.assertUnchanged()).toThrow('INPUT_CHANGED');
    expect(() => new PinnedInputReader(root).read('input.json', pin)).toThrow('INPUT_IDENTITY');
    expect(() => reader.read('../input.json')).toThrow();
  });

  it('reuses identical immutable bytes and never overwrites existing output', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'geography-test-')); directories.push(root);
    const file = path.join(root, 'metadata.json'); writeImmutable(file, Buffer.from('original\n'));
    writeImmutable(file, Buffer.from('original\n'));
    expect(() => writeImmutable(file, Buffer.from('different\n'))).toThrow('IMMUTABLE_METADATA_CHANGED');
    expect(fs.readFileSync(file, 'utf8')).toBe('original\n');
  });
});
