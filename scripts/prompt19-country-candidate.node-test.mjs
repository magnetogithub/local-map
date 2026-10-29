// Small artificial fixtures exercise contracts only; no KOR/PRK source acquisition or output.
import test from 'node:test';
import assert from 'node:assert/strict';
import {buildPrompt19CountryCandidate, prompt19SourceLockSchema} from './prompt19-country-core.mjs';

const polygon = (x0, y0, x1, y1) => ({type: 'Polygon', coordinates: [[[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]]]});
const feature = (id, geometry, countryId = 'KOR') => ({type: 'Feature', properties: {countryId, sourceId: 'fixture', sourceFeatureId: id,
  sourceParentId: 'source-parent', name: id, boundaryEvidenceRef: null}, geometry});
const pin = path => ({path, sha256: 'a'.repeat(64), byteLength: 1});
function fixture() {
  const geometry = polygon(0, 0, 4, 4);
  return {countryId: 'KOR', baselineIdentity: pin('fixture-baseline'),
    sourceLock: {schemaVersion: 'prompt19-country-source-lock-v1', countryId: 'KOR', normalizedCrs: 'EPSG:4326',
      sources: [{sourceId: 'fixture', url: 'https://example.org/source', version: 'test-only', publishedAt: null,
        retrievedAt: '2026-10-29T00:00:00Z', boundaryBasis: 'administrative', adminLevel: 2, temporalCoverage: 'fixture', scenarioDateCaveat: 'fixture only', originalCrs: 'EPSG:4326',
        license: {name: 'fixture only', url: 'https://example.org/license', attribution: 'fixture', redistributionAllowed: true}, artifact: pin('fixture.geojson')}],
      normalizedInput: pin('normalized.geojson'), preprocessing: {description: 'fixture', code: [pin('adapter.mjs')]}},
    envelope: {type: 'Feature', properties: {countryId: 'KOR'}, geometry},
    coarseParents: [{type: 'Feature', properties: {countryId: 'KOR', coarseTerritoryId: 'parent-one', parentKey: 'coarse:KOR:fixture', kind: 'administrative'}, geometry}],
    normalized: {type: 'FeatureCollection', features: [feature('west', polygon(0, 0, 2, 4)), feature('east', polygon(2, 0, 4, 4))]}};
}
test('stable local identities, complete positive land adjacency and no global registry fields', () => {
  const input = fixture(), result = buildPrompt19CountryCandidate(input);
  assert.equal(result.validation.pass, true);
  assert.equal(result.cells.features.length, 2);
  const [a, b] = result.cells.features.map(f => f.id);
  assert.deepEqual(result.topology.adjacency[a], [b]); assert.deepEqual(result.topology.adjacency[b], [a]);
  assert.ok(result.cells.features.every(f => f.id.startsWith('KOR:cell:') && !('ordinal' in f.properties) && !('catalogRef' in f.properties)));
  assert.equal(JSON.stringify(result.topology).includes('territory:catalog:'), false);
  const reversed = buildPrompt19CountryCandidate({...input, normalized: {...input.normalized, features: [...input.normalized.features].reverse()}});
  assert.deepEqual(reversed.cells, result.cells); assert.deepEqual(reversed.topology, result.topology);
});
test('an actual gap, however small, remains diagnostic and cannot become coastline or a filler cell', () => {
  const input = fixture(); input.normalized.features[1].geometry = polygon(2.00000001, 0, 4, 4);
  const result = buildPrompt19CountryCandidate(input);
  assert.equal(result.validation.pass, false); assert.equal(result.validation.checks.completeBoundaryPairing, false);
  assert.ok(result.residuals.features.length > 0); assert.equal(result.cells.features.length, 2);
});
test('overlap cannot be accepted or assigned by feature order', () => {
  const input = fixture(); input.normalized.features[1].geometry = polygon(1, 0, 4, 4);
  const result = buildPrompt19CountryCandidate(input);
  assert.equal(result.validation.checks.countryCoverage, false); assert.equal(result.validation.pass, false);
});
test('point contacts never produce land adjacency and missing small islands fail coverage', () => {
  const input = fixture(), island = polygon(4, 4, 5, 5);
  input.envelope.geometry = {type: 'MultiPolygon', coordinates: [polygon(0, 0, 4, 4).coordinates, island.coordinates]};
  input.coarseParents[0].geometry = input.envelope.geometry;
  input.normalized.features.push(feature('island', island));
  const result = buildPrompt19CountryCandidate(input), cell = result.cells.features.find(c => c.properties.sourceFeatureId === 'island');
  assert.equal(result.validation.pass, true); assert.deepEqual(result.topology.adjacency[cell.id], []);
  input.normalized.features.pop();
  assert.equal(buildPrompt19CountryCandidate(input).validation.pass, false);
});
test('polygon holes are kept and cannot be filled by another source feature', () => {
  const input = fixture(), hole = polygon(0.5, 1, 1.5, 2).coordinates[0].reverse();
  input.envelope.geometry.coordinates.push(hole); input.coarseParents[0].geometry = input.envelope.geometry;
  input.normalized.features[0].geometry.coordinates.push(hole);
  const result = buildPrompt19CountryCandidate(input);
  assert.equal(result.validation.pass, true); assert.equal(result.validation.totals.holes, 1);
});
test('parent crossing uses intersections with explicit membership rather than centroid allocation', () => {
  const input = fixture();
  input.coarseParents = [input.coarseParents[0], structuredClone(input.coarseParents[0])];
  input.coarseParents[0].geometry = polygon(0, 0, 2, 4);
  input.coarseParents[1].geometry = polygon(2, 0, 4, 4);
  input.coarseParents[1].properties = {...input.coarseParents[1].properties, coarseTerritoryId: 'parent-two', parentKey: 'coarse:KOR:second'};
  input.normalized.features = [feature('south', polygon(0, 0, 4, 2)), feature('north', polygon(0, 2, 4, 4))];
  const result = buildPrompt19CountryCandidate(input);
  assert.equal(result.validation.pass, true); assert.equal(result.cells.features.length, 4);
  assert.ok(result.validation.parentCoverage.every(p => p.localIds.length === 2 && p.distinctSourceFeatures === 2));
});
test('a renamed ADM1 or split components of one feature cannot certify fine partial selection', () => {
  const input = fixture(); input.normalized.features = [feature('whole', input.envelope.geometry)];
  const result = buildPrompt19CountryCandidate(input);
  assert.equal(result.validation.checks.administrativePartialSelection, false); assert.equal(result.validation.pass, false);
  input.sourceLock.sources[0].adminLevel = 1;
  assert.equal(prompt19SourceLockSchema.safeParse(input.sourceLock).success, false);
});
test('country, source identity, duplicate IDs, rights and natural boundary evidence fail closed', () => {
  const cases = [
    input => {input.normalized.features[0].properties.countryId = 'PRK';},
    input => {input.normalized.features[0].properties.sourceId = 'unknown';},
    input => {input.normalized.features[1].properties.sourceFeatureId = 'west';},
    input => {input.sourceLock.sources[0].license.redistributionAllowed = false;},
    input => {input.sourceLock.sources[0].boundaryBasis = 'documented-natural'; input.sourceLock.sources[0].adminLevel = null;},
    input => {input.normalized.features[0].properties.ordinal = 1;},
  ];
  for (const mutate of cases) {const input = fixture(); mutate(input); assert.throws(() => buildPrompt19CountryCandidate(input));}
});
