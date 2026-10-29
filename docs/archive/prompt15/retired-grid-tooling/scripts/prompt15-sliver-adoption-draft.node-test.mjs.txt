import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {gunzipSync} from 'node:zlib';
import {digest, jsonBytes} from './prompt14-catalog-core.mjs';
import {MANIFEST_PIN, safeRelative, identity, verifyPin, collectPins, validatePlan, validateAssets,
  validateCorrespondence, serializeReplacement, gzipJSON, assertFreshOutput, claimWorldIds, assemble} from './prompt15-sliver-adoption-draft.mjs';

const id = n => `territory:catalog:${String(n).padStart(64, '0')}`;
const rectangle = (a, b) => ({type: 'Polygon', coordinates: [[[a, 0], [b, 0], [b, 1], [a, 1], [a, 0]]]});
function fixture() {
  const entry = n => ({id: id(n), sourceCountryId: 'AAA', oldTerritoryId: id(9), adminId: 'parent', parentKey: 'AAA:parent',
    parentSourceFeatureId: 'parent', sourceComponentHash: 'a'.repeat(64), componentIndex: 0, sourceTiny: false,
    refined: true, areaKm2: 1, diameterKm: 2, bbox: [n - 1, 0, n, 1], centroid: [n - 0.5, 0.5]});
  const entries = [entry(1), entry(2)], geometries = [rectangle(0, 1), rectangle(1, 2)];
  const catalog = {schemaVersion: 'prompt15-task-15-19-world-catalog-v1', policyVersion: 'prompt15-cell-experiment-v6', candidateId: 'adaptive-12-24-v6', countryId: 'AAA', entries};
  const geometry = {type: 'FeatureCollection', features: entries.map((e, i) => ({type: 'Feature', properties: {
    cellId: e.id, ...Object.fromEntries(['sourceCountryId', 'oldTerritoryId', 'adminId', 'parentKey', 'parentSourceFeatureId', 'componentIndex', 'refined'].map(k => [k, e[k]])),
  }, geometry: geometries[i]}))};
  const cell = {...entry(3), countryId: 'AAA', geometry: rectangle(0, 2), diameterUpperBoundKm: 3, areaKm2: 2, ordinal: 25,
    bbox: [0, 0, 2, 1], centroid: [1, 0.5], sourceFeatureId: 'selected-fixed-feature', parentHash: 'b'.repeat(64), inputRole: 'P1'};
  const correspondence = {mode: 'MERGED_OR_IDENTITY', complete: true, mapping: [{selectedCellId: cell.id,
    selectedGeometryHash: digest(jsonBytes(cell.geometry)), parentKey: cell.parentKey, oldTerritoryId: cell.oldTerritoryId,
    componentIndex: cell.componentIndex, sourceComponentHash: cell.sourceComponentHash,
    originalCells: entries.map((e, i) => ({id: e.id, geometryHash: digest(jsonBytes(geometries[i]))}))}]};
  return {catalog, geometry, cells: [cell], correspondence};
}
function run(f) {return serializeReplacement(f.cells, f.catalog, f.correspondence, f.geometry);}
function planFixture() {
  const selected = {countryId: 'AAA', selectedCellInput: {kind: 'REPLACE_WITH_PINNED_LOCAL_PROPOSAL', cellCount: 1},
    selectedGeometryReplacementRequired: true, selectedV2Sliver: 'PASS_REUSED', unresolvedProblems: [], alreadyAdopted: false, originalCellCount: 2};
  return {manifest: {changedCountrySelections: [selected], remainingBaselineCountries: {count: 1, countryIds: ['BBB']}, plannedCellDelta: -1},
    directory: {countryOrder: ['AAA', 'BBB'], cellCount: 3}, expected: {countries: 2, selectedCountries: 1, replacements: 1, retained: 1,
      baselineCells: 3, selectedCells: 1, originalSelectedCells: 2, cells: 2}};
}
test('existing 15-19 serializer fields preserve actual selected IDs, geometry and ownership; discard local ordinal', () => {
  const f = fixture(), a = run(f), b = run(f);
  assert.equal(a.catalog.entries[0].id, f.cells[0].id);
  assert.deepEqual(a.geometry.features[0].geometry, f.cells[0].geometry);
  assert.equal(a.catalog.entries[0].diameterKm, f.cells[0].diameterUpperBoundKm);
  assert.equal(a.catalog.entries[0].parentKey, 'AAA:parent');
  assert.equal(Object.hasOwn(a.catalog.entries[0], 'ordinal'), false);
  assert.equal(Object.hasOwn(a.geometry.features[0].properties, 'ordinal'), false);
  assert.deepEqual(a.census, {originalCells: 2, selectedCells: 1, complete: true});
  assert.deepEqual(gzipJSON(a.catalog), gzipJSON(b.catalog));
  assert.deepEqual(gzipJSON(a.geometry), gzipJSON(b.geometry));
  assert.deepEqual(JSON.parse(gunzipSync(gzipJSON(a.geometry))), a.geometry);
});
for (const [name, mutate, message] of [
  ['missing mapping', f => {f.correspondence.mapping = [];}, /omissions/],
  ['duplicate mapping', f => {f.correspondence.mapping.push(structuredClone(f.correspondence.mapping[0]));}, /selected correspondence/],
  ['duplicate original input', f => {f.correspondence.mapping[0].originalCells[1] = f.correspondence.mapping[0].originalCells[0];}, /original correspondence/],
  ['wrong parent', f => {f.correspondence.mapping[0].parentKey = 'AAA:other';}, /selected correspondence/],
  ['wrong old owner', f => {f.catalog.entries[0].oldTerritoryId = id(8); f.geometry.features[0].properties.oldTerritoryId = id(8);}, /original correspondence/],
  ['wrong component', f => {f.correspondence.mapping[0].componentIndex = 1;}, /selected correspondence/],
  ['forged sourceTiny', f => {f.cells[0].sourceTiny = true;}, /original correspondence/],
  ['tampered selected geometry', f => {f.cells[0].geometry.coordinates[0][0][0] = -1;}, /geometry hash mismatch/],
  ['tampered original geometry', f => {f.geometry.features[0].geometry.coordinates[0][0][0] = -1;}, /geometry hash mismatch/],
  ['wrong country', f => {f.cells[0].countryId = 'BBB';}, /proposal country/],
  ['unknown original', f => {f.correspondence.mapping[0].originalCells[0].id = id(7);}, /original correspondence/],
  ['incomplete proof', f => {f.correspondence.complete = false;}, /Incomplete correspondence/],
]) test(`reject ${name}`, () => {const f = fixture(); mutate(f); assert.throws(() => run(f), message);});

test('catalog and feature ID sets are bijective, property mismatches and duplicate IDs rejected', () => {
  const f = fixture(); validateAssets(f.catalog, f.geometry, 'AAA');
  const g = structuredClone(f.geometry); g.features[1].properties.cellId = g.features[0].properties.cellId;
  assert.throws(() => validateAssets(f.catalog, g, 'AAA'), /duplicate geometry/);
  g.features[1].properties.cellId = id(2); g.features[1].properties.parentKey = 'AAA:other';
  assert.throws(() => validateAssets(f.catalog, g, 'AAA'), /identity mismatch/);
  f.catalog.entries.push(f.catalog.entries[0]); f.geometry.features.push(f.geometry.features[0]);
  assert.throws(() => validateAssets(f.catalog, f.geometry, 'AAA'), /Duplicate catalog/);
});
test('disjoint exact country and cell census; missing, duplicate and overlapping countries rejected', () => {
  const f = planFixture(); assert.equal(validatePlan(f.manifest, f.directory, f.expected).size, 1);
  for (const mutation of [
    a => {a.directory.countryOrder[1] = 'AAA';},
    a => {a.manifest.remainingBaselineCountries.countryIds = ['AAA'];},
    a => {a.manifest.changedCountrySelections[0].selectedCellInput.cellCount = 2;},
    a => {a.manifest.changedCountrySelections[0].countryId = 'CCC';},
    a => {a.manifest.changedCountrySelections.push(a.manifest.changedCountrySelections[0]);},
  ]) {const a = structuredClone(f); mutation(a); assert.throws(() => validatePlan(a.manifest, a.directory, a.expected));}
});
test('missing/tampered files and conflicting/incomplete pins rejected; immutable copy is not a hard link', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'prompt15-adoption-test-'));
  fs.writeFileSync(path.join(tmp, 'source.json'), '{}\n');
  const pin = identity(tmp, 'source.json'); assert.deepEqual(verifyPin(tmp, pin), pin);
  fs.copyFileSync(path.join(tmp, 'source.json'), path.join(tmp, 'copy.json'), fs.constants.COPYFILE_EXCL);
  fs.writeFileSync(path.join(tmp, 'copy.json'), 'changed'); assert.deepEqual(verifyPin(tmp, pin), pin);
  assert.throws(() => verifyPin(tmp, {...pin, path: 'missing.json'}), /ENOENT/);
  fs.writeFileSync(path.join(tmp, 'source.json'), '{"changed":true}\n');
  assert.throws(() => verifyPin(tmp, pin), /identity mismatch/);
  assert.throws(() => collectPins([pin, {...pin, byteLength: 99}]), /Conflicting/);
  assert.throws(() => collectPins({path: 'input.json', sha256: 'x'}), /Incomplete/);
  // Tiny temp evidence is intentionally retained; no recursive cleanup or historical file deletion.
});
test('traversal, absolute paths and alternate separators rejected', () => {
  for (const p of ['../x', 'a/../b', '/tmp/x', 'D:/x', 'a\\b', 'a//b', 'a/./b']) assert.throws(() => safeRelative(p), /Unsafe/);
  assert.equal(safeRelative('countries/AAA/catalog.json.gz'), 'countries/AAA/catalog.json.gz');
});
test('existing final and staging output refused without modifying existing bytes', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'prompt15-adoption-output-'));
  const file = path.join(tmp, 'marker'); fs.writeFileSync(file, 'preserve');
  assert.throws(() => assertFreshOutput(tmp), /Refusing existing output/);
  assert.equal(fs.readFileSync(file, 'utf8'), 'preserve');
  assert.throws(() => assemble(tmp, 'data/not-evidence'), /dedicated report tree/);
});
test('new selected ID collision with a retained-country ID rejected by the production world census', () => {
  const ids = new Set([id(1)]); claimWorldIds(ids, [id(2), id(3)]);
  assert.equal(ids.size, 3); assert.throws(() => claimWorldIds(ids, [id(1)]), /World ID collision/);
});
test('production assembler refuses existing root or staging and retains failure evidence', () => {
  for (const staging of [false, true]) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'prompt15-adoption-existing-'));
    const name = '15-19-sliver-adoption-draft-v1-' + 'a'.repeat(20);
    const target = path.join(tmp, 'data/derived/prompt15', staging ? `.${name}.staging` : name);
    fs.mkdirSync(target, {recursive: true}); fs.writeFileSync(path.join(target, 'marker'), 'original');
    const evidence = 'reports/prompt15/15-22-sliver-adoption/test/assembly';
    const state = {manifest: {}, directory: {countryOrder: []}, selected: new Map(), base: '', inputs: [], code: [], contentHash: 'a'.repeat(64), runtime: {}};
    assert.throws(() => assemble(tmp, evidence, state), /Refusing existing output/);
    assert.equal(fs.readFileSync(path.join(target, 'marker'), 'utf8'), 'original');
    assert.equal(JSON.parse(fs.readFileSync(path.join(tmp, evidence, 'failure.json'))).status, 'DRAFT_ASSEMBLY_FAIL');
  }
});
test('real pinned 16 proposals serialize without normalizing, assigning IDs or importing local world references', () => {
  verifyPin(process.cwd(), MANIFEST_PIN);
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PIN.path)), base = path.posix.dirname(manifest.baseArtifactIndexes.catalog.path);
  let replacements = 0, selected = 0, original = 0;
  for (const selection of manifest.changedCountrySelections) {
    verifyPin(process.cwd(), selection.cellCorrespondence); verifyPin(process.cwd(), selection.selectedCellInput.file);
    selected += selection.selectedCellInput.cellCount; original += selection.originalCellCount;
    if (!selection.selectedGeometryReplacementRequired) continue;
    replacements++;
    const prefix = `${base}/countries/${selection.countryId}`;
    const catalog = JSON.parse(gunzipSync(fs.readFileSync(`${prefix}/catalog.json.gz`)));
    const geometry = JSON.parse(gunzipSync(fs.readFileSync(`${prefix}/geometry.geojson.gz`)));
    const cells = JSON.parse(fs.readFileSync(selection.selectedCellInput.file.path));
    const correspondence = JSON.parse(fs.readFileSync(selection.cellCorrespondence.path));
    const actual = serializeReplacement(cells, catalog, correspondence, geometry);
    assert.equal(actual.census.selectedCells, selection.selectedCellInput.cellCount);
    for (let i = 0; i < cells.length; i++) {
      assert.equal(actual.catalog.entries[i].id, cells[i].id);
      assert.deepEqual(jsonBytes(actual.geometry.features[i].geometry), jsonBytes(cells[i].geometry));
      assert.equal(Object.hasOwn(actual.catalog.entries[i], 'ordinal'), false);
    }
    // The same validator is used by the assembly path; no independent pass-only adapter.
    validateCorrespondence(correspondence, validateAssets(catalog, geometry, selection.countryId),
      validateAssets(actual.catalog, actual.geometry, selection.countryId), selection.countryId);
  }
  assert.equal(replacements, 16); assert.equal(selected, 883); assert.equal(original, 913);
});
