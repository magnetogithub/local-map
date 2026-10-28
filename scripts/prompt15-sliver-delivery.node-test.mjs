import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {gunzipSync} from 'node:zlib';
import {digest, hashCanonical, jsonBytes} from './prompt14-catalog-core.mjs';
import {POLICY, verifyTree, writeArtifact} from './prompt15-world-delivery-core.mjs';
import {buildDeliveryAssets, encodeScopedIncidence} from './prompt15-sliver-delivery.mjs';
import {verifyDraftDelivery} from './verify-prompt15-sliver-delivery.mjs';
import {INDEX_SCHEMA, VERSION, validateBindings, verifyRootBindings, membershipBytes, parentMetadata, budgetAccounting, dependencySpecifiers} from './prompt15-sliver-delivery-adapter.mjs';
const id = n => `territory:catalog:${String(n).padStart(64, '0')}`;
const square = (x, y, size = 1) => ({type: 'Polygon', coordinates: [[[x, y], [x + size, y], [x + size, y + size], [x, y + size], [x, y]]]});
test('dependency intake ignores JSDoc type imports and string examples while retaining runtime imports', () => {
  const source = '/** @import {Feature} from "geojson" */\nimport fs from "node:fs"; const s = "require(\'example\')"; const x = require("real-runtime");';
  assert.deepEqual(dependencySpecifiers(source).map(x => x.spec).sort(), ['node:fs', 'real-runtime']);
});
function fixture() {
  const cells = [1, 2, 3].map((n, i) => ({id: id(n), ordinal: n, sourceCountryId: i === 1 ? 'BBB' : 'AAA',
    parentKey: i === 1 ? 'BBB:b' : 'AAA:a', parentSourceFeatureId: i === 1 ? 'b' : 'a', adminId: i === 1 ? 'b' : 'a',
    oldTerritoryId: i === 1 ? id(8) : id(9), componentIndex: i === 2 ? 1 : 0, sourceComponentHash: String(n).repeat(64)}));
  const geometries = [square(0, 0), square(1, 0), square(20, 20, 1e-12)];
  geometries[0].coordinates.push([[.2, .2], [.2, .3], [.3, .3], [.3, .2], [.2, .2]]);
  const admin = {schemaVersion: INDEX_SCHEMA, cellCount: 3, parents: [
    {parentKey: 'AAA:a', sourceCountryId: 'AAA', sourceFeatureId: 'a', adminId: 'a', start: 0, count: 2, historicalParent: {cellCount: 3, parentHash: 'a'.repeat(64)}},
    {parentKey: 'BBB:b', sourceCountryId: 'BBB', sourceFeatureId: 'b', adminId: 'b', start: 2, count: 1, historicalParent: {cellCount: 1, parentHash: 'b'.repeat(64)}}],
    cellOrdinals: [1, 3, 2], parentOrdinalByCell: [1, 2, 1]};
  const previous = {schemaVersion: INDEX_SCHEMA, cellCount: 3, parents: [{oldTerritoryId: id(8), sourceCountryId: 'BBB', start: 0, count: 1},
    {oldTerritoryId: id(9), sourceCountryId: 'AAA', start: 1, count: 2}], cellOrdinals: [2, 1, 3], oldParentOrdinalByCell: [2, 1, 2]};
  const sourceByCountry = new Map(['AAA', 'BBB'].map(countryId => [countryId, {catalog: {entries: cells.filter(c => c.sourceCountryId === countryId).map(c => {
    const e = {...c}; delete e.ordinal; return e;
  })}, geometry: {type: 'FeatureCollection', features: cells.flatMap((c, i) => c.sourceCountryId === countryId ? [{type: 'Feature', properties: {
    cellId: c.id, ...Object.fromEntries(['sourceCountryId', 'parentKey', 'parentSourceFeatureId', 'adminId', 'oldTerritoryId', 'componentIndex'].map(k => [k, c[k]]))}, geometry: geometries[i]}] : [])}}]));
  const groups = new Map();
  for (let ci = 0; ci < cells.length; ci++) for (const ring of geometries[ci].coordinates) for (let i = 1; i < ring.length; i++) {
    const a = ring[i - 1], b = ring[i], k = JSON.stringify([a, b].sort((x, y) => x[0] - y[0] || x[1] - y[1]));
    const rows = groups.get(k) ?? []; rows.push({a, b, cell: ci + 1}); groups.set(k, rows);
  }
  const edges = [...groups.values()].map((rows, i) => ({id: `edge:fixture:${i + 1}`, ordinal: i + 1, left: rows[0].cell, right: rows[1]?.cell ?? 0,
    boundaryClass: rows.length === 2 ? 'country' : 'coast', flags: {positiveAdjacency: rows.length === 2, country: rows.length === 2,
      administrative: rows.length === 2, residual: false, previous: true}, geometry: {type: 'LineString', coordinates: [rows[0].a, rows[0].b]}, lengthKm: 1}));
  const sourceArtifact = p => ({path: p, byteLength: 100, sha256: 'e'.repeat(64), compression: 'gzip'});
  const context = {scope: 'FIXTURE', catalogRoot: 'fixture/catalog', indicesRoot: 'fixture/indices', inputPins: [], independentReport: {status: 'FIXTURE_ONLY'},
    trees: [{identity: {path: 'fixture/catalog/artifact-index.json', byteLength: 1, sha256: '1'.repeat(64)}, index: {artifacts: ['AAA', 'BBB'].map(c => sourceArtifact(`countries/${c}/geometry.geojson.gz`))}},
      {identity: {path: 'fixture/indices/artifact-index.json', byteLength: 1, sha256: '2'.repeat(64)}}],
    sourceBindings: {schemaVersion: 'prompt15-separate-membership-artifact-bindings-v1', combinedMembershipRoot: 'c'.repeat(64),
      administrative: {root: 'fixture/indices', artifact: sourceArtifact('administrative-membership.json.gz')}, previous: {root: 'fixture/indices', artifact: sourceArtifact('previous-parent-index.json.gz')}},
    order: {schemaVersion: INDEX_SCHEMA, cells}, admin, previous, cellCount: 3, edgeCount: edges.length, expectedCells: [1, 2, 3], expectedEdges: edges.map(e => e.ordinal), activeCountries: ['AAA', 'BBB'],
    indexRoot: {topologyShards: ['topology/000.json.gz'], roots: {catalogOrder: digest(jsonBytes(cells.map(c => c.id))), topology: 'd'.repeat(64)}},
    readCountry: c => sourceByCountry.get(c), readTopology: () => ({schemaVersion: INDEX_SCHEMA, bucket: 0, edges})};
  return {context, edges, geometries};
}
test('input schema, root and full forward/reverse binding reject stale/local ID, wrong parent and truncated membership', () => {
  const {context: c} = fixture(); validateBindings(c.order, c.admin, c.previous);
  for (const mutate of [x => {x.order.cells[1].ordinal = 1;}, x => {x.order.cells[1].id = x.order.cells[0].id;},
    x => {x.admin.cellOrdinals[1] = 1;}, x => {x.previous.cellOrdinals.pop();}, x => {x.order.cells[0].parentKey = 'AAA:wrong';},
    x => {x.order.schemaVersion = 'legacy';}, x => {x.admin.parents[0].count = 1;}]) {
    const x = structuredClone({order: c.order, admin: c.admin, previous: c.previous}); mutate(x); assert.throws(() => validateBindings(x.order, x.admin, x.previous));
  }
  const binding = {catalogRoot: c.catalogRoot, indicesRoot: c.indicesRoot, indicesIndexSchema: INDEX_SCHEMA, directory: {schemaVersion: 'prompt15-task-15-19-world-catalog-v1', preparationStatus: 'DRAFT_CATALOG_PREPARED_PENDING_VALIDATION', countryOrder: c.activeCountries, cellCount: 3},
    indices: {schemaVersion: INDEX_SCHEMA, status: 'DRAFT_GLOBAL_INDICES_BUILT_PENDING_COUNTRY_VALIDATION', root: c.indicesRoot},
    indexRoot: {...c.indexRoot, schemaVersion: INDEX_SCHEMA, sourceCatalogRoot: c.catalogRoot, countryOrder: c.activeCountries}, order: c.order, admin: c.admin, previous: c.previous};
  verifyRootBindings(binding);
  assert.doesNotThrow(() => verifyRootBindings({...binding, indices: {...binding.indices, schemaVersion: undefined}}));
  assert.throws(() => verifyRootBindings({...binding, indicesIndexSchema: 'legacy'}), /schema/);
  assert.throws(() => verifyRootBindings({...binding, indexRoot: {...binding.indexRoot, sourceCatalogRoot: 'stale/root'}}), /root/);
  assert.throws(() => verifyRootBindings({...binding, directory: {...binding.directory, schemaVersion: 'legacy'}}), /draft/);
});
test('binary CSR retains >512 members and separates historical generation count from actual current count', () => {
  const {context: c} = fixture(), n = 900;
  const membership = {parents: [{start: 0, count: n}], cellOrdinals: Array.from({length: n}, (_, i) => i + 1)};
  const b = membershipBytes(membership, new Set([1])); assert.equal(b.length, n * 4); assert.equal(b.readUInt32LE((n - 1) * 4), n);
  const transports = {administrative: {path: 'admin.bin.gz'}, previous: {path: 'old.bin.gz'}};
  const metadata = parentMetadata(c, transports); assert.equal(metadata.administrative[0].currentMembership.count, 2);
  assert.equal(metadata.administrative[0].historicalGeneration.cellCount, 3);
  assert.equal(metadata.administrative[0].currentMembership.artifact.path, 'admin.bin.gz');
  assert.notDeepEqual(c.sourceBindings.administrative.artifact, c.sourceBindings.combinedMembershipRoot);
});
test('incidence uses exact global ordinal offset, preserves coast, rejects missing/duplicate/self/unknown refs', () => {
  const l = new Uint32Array([0, 1, 2]), r = new Uint32Array([0, 0, 1]);
  const b = encodeScopedIncidence(l, r, [1, 2], 3, true); assert.equal(b.length, 16); assert.equal(b.readUInt32LE(8), 2); assert.equal(b.readUInt32LE(12), 1);
  assert.throws(() => encodeScopedIncidence(new Uint32Array([0, 0]), new Uint32Array([0, 0]), [1], 3, true));
  assert.throws(() => encodeScopedIncidence(new Uint32Array([0, 1]), new Uint32Array([0, 1]), [1], 3, true));
  assert.throws(() => encodeScopedIncidence(new Uint32Array([0, 4]), new Uint32Array([0, 0]), [1], 3, true));
});
test('actual byte accounting includes both indices; frozen delivered/initial limits and mandatory files enforced', () => {
  const names = ['manifest.json', 'tile-index.json', 'detail-index.json', POLICY.edgeIncidence.path];
  const a = names.map(path => ({path, byteLength: 10}));
  assert.deepEqual(budgetAccounting({artifacts: a, deliveryIndexBytes: 20, artifactIndexBytes: 30}), {delivered: 90, initialMetadata: 90, pass: true});
  assert.equal(budgetAccounting({artifacts: [...a, {path: 'detail.bin', byteLength: POLICY.renderByteBudget - 90}], deliveryIndexBytes: 20, artifactIndexBytes: 30}).pass, true);
  assert.equal(budgetAccounting({artifacts: [...a, {path: 'detail.bin', byteLength: POLICY.renderByteBudget - 89}], deliveryIndexBytes: 20, artifactIndexBytes: 30}).pass, false);
  assert.equal(budgetAccounting({artifacts: [{...a[0], byteLength: POLICY.initialMetadataByteBudget}, ...a.slice(1)], deliveryIndexBytes: 20, artifactIndexBytes: 30}).pass, false);
  assert.throws(() => budgetAccounting({artifacts: a.slice(1), deliveryIndexBytes: 20, artifactIndexBytes: 30}), /required/);
});
test('draft transport production pipeline + independent small-fixture verifier preserve exact tiny face/hole and actual coverage', () => {
  const {context: c, geometries} = fixture(), tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'prompt15-draft-delivery-test-'));
  const sourceIdentity = {policy: POLICY, inputPins: [], code: [], runtime: {node: process.version}, scope: c.scope, sourceBindings: c.sourceBindings, independentStructure: c.independentReport};
  const key = hashCanonical('prompt15-sliver-delivery-build.v1', sourceIdentity).slice(0, 20);
  const staging = path.join(tmp, 'candidate'), work = path.join(tmp, 'work');
  const result = buildDeliveryAssets(c, {staging, work, key, sourceIdentity, progress: () => {}});
  assert.equal(result.summary.counts.tiles, 5461); assert.equal(result.summary.schemaVersion, VERSION);
  assert.ok(result.coverage.missingOverviewCellOrdinals.includes(3));
  const exact = JSON.parse(gunzipSync(fs.readFileSync(path.join(staging, 'detail/countries/AAA.geojson.gz'))));
  assert.deepEqual(exact.features[0].geometry, geometries[0]); assert.deepEqual(exact.features[1].geometry, geometries[2]);
  const verified = verifyDraftDelivery(staging, c, () => {}); assert.equal(verified.smokeVerified, true);
  assert.equal(verified.counts.cells, 3); assert.ok(verified.bytes.pass);
  assert.throws(() => buildDeliveryAssets(c, {staging, work, key, sourceIdentity, progress: () => {}}), /existing/);
  const pin = verifyTree(staging).identity; fs.appendFileSync(path.join(staging, 'metadata/edge-incidence.bin.gz'), 'x');
  assert.throws(() => verifyTree(staging, pin), /bytes/);
});
test('invalid source edge/cell incidence and duplicate metadata fail before global generation', () => {
  for (const kind of ['edge', 'metadata']) {
    const {context: c, edges} = fixture(), tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'prompt15-draft-delivery-invalid-'));
    if (kind === 'edge') edges[1].ordinal = edges[0].ordinal;
    else {const original = c.readCountry; c.readCountry = country => {const source = structuredClone(original(country)); source.catalog.entries.push(source.catalog.entries[0]); return source;};}
    assert.throws(() => buildDeliveryAssets(c, {staging: path.join(tmp, 'candidate'), work: path.join(tmp, 'work'), key: 'fixture', sourceIdentity: {}, progress: () => {}}), /duplicate|count|metadata/i);
  }
});
