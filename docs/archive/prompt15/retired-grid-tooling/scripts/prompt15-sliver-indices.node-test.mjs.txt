import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {buildMembership, validateMembership, pairOccurrences, sourceSupport, buildTopology} from './prompt15-sliver-indices-core.mjs';
import {validateTopology} from './prompt15-sliver-indices.mjs';
import {openDraft, DRAFT_INDEX_IDENTITY} from './prompt15-sliver-indices-adapter.mjs';
import {assertFreshOutput, verifyPin, identity} from './prompt15-sliver-adoption-draft.mjs';

const id = n => `territory:catalog:${String(n).padStart(64, '0')}`;
const rectangle = (x, y, w = 1, h = 1) => ({type: 'Polygon', coordinates: [[[x, y], [x + w, y], [x + w, y + h], [x, y + h], [x, y]]]});
function membershipFixture(count = 3) {
  const cells = Array.from({length: count}, (_, i) => ({id: id(i + 1), ordinal: i + 1, sourceCountryId: 'AAA', parentKey: 'AAA:parent',
    parentSourceFeatureId: 'parent', adminId: 'parent', oldTerritoryId: id(0), sourceComponentHash: 'a'.repeat(64), componentIndex: 0}));
  const parents = new Map([['AAA:parent', {parentKey: 'AAA:parent', sourceCountryId: 'AAA', sourceFeatureId: 'parent', adminId: 'parent'}]]);
  const oldParents = new Map([[id(0), {properties: {sourceCountryId: 'AAA'}, geometry: rectangle(0, 0)}]]);
  return {cells, parents, oldParents};
}
test('fresh ID-sorted world ordinals and full forward/reverse memberships including >512', () => {
  const f = membershipFixture(900), m = buildMembership(f.cells, f.parents, f.oldParents);
  assert.equal(m.administrative.parents[0].count, 900); assert.equal(m.previous.parents[0].count, 900);
  assert.equal(m.administrative.cellOrdinals.length, 900); assert.equal(m.previous.cellOrdinals.length, 900);
  assert.equal(validateMembership(f.cells, m.administrative, m.previous).pass, true);
  m.administrative.cellOrdinals.length = 512; assert.equal(validateMembership(f.cells, m.administrative, m.previous).pass, false);
});
test('duplicate cell IDs and stale/local ordinal rejected', () => {
  for (const mutate of [f => {f.cells[1].id = f.cells[0].id;}, f => {f.cells[1].ordinal = 1;}]) {
    const f = membershipFixture(); mutate(f); assert.throws(() => buildMembership(f.cells, f.parents, f.oldParents), /Duplicate ID|stale/);
  }
});
test('unknown/mismatched administrative and previous parent rejected', () => {
  for (const mutate of [f => {f.cells[0].parentKey = 'AAA:missing';}, f => {f.cells[0].oldTerritoryId = id(8);},
    f => {f.cells[0].adminId = 'other';}, f => {f.cells[0].sourceCountryId = 'BBB';}]) {
    const f = membershipFixture(); mutate(f); assert.throws(() => buildMembership(f.cells, f.parents, f.oldParents), /Invalid membership parent/);
  }
});
test('missing/duplicate CSR entries, wrong reverse and forward membership rejected', () => {
  for (const mutate of [m => {m.administrative.cellOrdinals[1] = 1;}, m => {m.previous.cellOrdinals.pop();},
    m => {m.administrative.parentOrdinalByCell[0] = 10;}, m => {m.previous.oldParentOrdinalByCell[0] = 9;},
    m => {m.administrative.parents.push(m.administrative.parents[0]);}]) {
    const f = membershipFixture(), m = buildMembership(f.cells, f.parents, f.oldParents); mutate(m);
    assert.equal(validateMembership(f.cells, m.administrative, m.previous).pass, false);
  }
});
test('full positive-length opposite source support pairs; point-only/remote/wrong owner rejected', () => {
  const cells = membershipFixture(2).cells;
  const r = (owner, side, a = [0, 0], b = [0, 1]) => [[0, 0], [0, 1], owner, side, null, a, b];
  assert.deepEqual(pairOccurrences({a: [0, 0], b: [0, 1], records: [r(1, 0), r(2, 1)]}, cells), {left: 1, right: 2, a: [0, 0], b: [0, 1]});
  for (const records of [[r(1, 0), r(2, 0)], [r(1, 0), r(9, 1)], [r(1, 0), r(2, 1, [0, 1], [1, 1])],
    [r(1, 0), r(2, 1, [4, 0], [4, 1])], [r(1, 0), r(1, 0)]])
    assert.throws(() => pairOccurrences({a: [0, 0], b: [0, 1], records}, cells));
  assert.equal(sourceSupport([0, 1], [1, 1], [0, 0], [0, 1]), false);
  assert.equal(sourceSupport([0, 0], [0, 0], [0, 0], [0, 1]), false);
});
test('schema/input tampering, unsafe input and existing output refused', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'prompt15-indices-pins-'));
  fs.writeFileSync(path.join(tmp, 'input.json'), '{}'); const pin = identity(tmp, 'input.json');
  fs.writeFileSync(path.join(tmp, 'input.json'), '{"tampered":true}'); assert.throws(() => verifyPin(tmp, pin), /identity mismatch/);
  assert.throws(() => verifyPin(tmp, {...pin, path: 'missing.json'}), /ENOENT/);
  assert.throws(() => assertFreshOutput(tmp), /Refusing existing output/);
  assert.throws(() => openDraft({catalogRoot: '../not-an-input', evidenceManifest: 'a.json'}), /Unsafe/);
  assert.equal(DRAFT_INDEX_IDENTITY.byteLength, 165354);
});
test('production topology path and serialized verifier: land border, coast, point-only and remote components', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'prompt15-indices-topology-'));
  const cells = membershipFixture(4).cells;
  cells[1] = {...cells[1], sourceCountryId: 'BBB', parentKey: 'BBB:p', adminId: 'p'};
  // 1 and 2 share an edge; 3 touches 2 at one vertex; 4 is remote.
  const geometries = [rectangle(0, 0), rectangle(1, 0), rectangle(2, 1), rectangle(5, 0)];
  const countryGeometry = {AAA: {type: 'MultiPolygon', coordinates: [geometries[0].coordinates, geometries[2].coordinates, geometries[3].coordinates]}, BBB: geometries[1]};
  const context = {p0: {type: 'FeatureCollection', features: Object.entries(countryGeometry).map(([countryId, geometry]) => ({type: 'Feature', properties: {countryId}, geometry}))},
    oldParents: new Map(), approvedParents: new Map(), selected: new Map(), featuresForCountry: country => ({type: 'FeatureCollection', features: cells.flatMap((c, i) =>
      c.sourceCountryId === country ? [{type: 'Feature', properties: {cellId: c.id}, geometry: geometries[i]}] : [])})};
  const shards = new Map(), result = buildTopology({context, cells, countryOrder: ['AAA', 'BBB'], work: path.join(tmp, 'work'), emit: (p, v) => shards.set(p, v), progress: () => {}});
  const read = bucket => ({edges: shards.get(`topology/${String(bucket).padStart(3, '0')}.json.gz`).edges,
    support: shards.get(`source-support/${String(bucket).padStart(3, '0')}.json.gz`).support});
  assert.equal(result.adjacency.adjacencyPairs, 1); assert.equal(result.counts.isolatedCells, 2);
  assert.equal(validateTopology(cells, result.adjacency, result.incidence, result.counts, read).status, 'PASS');
  const badAdj = structuredClone(result.adjacency); badAdj.neighbors[0] = 4;
  assert.throws(() => validateTopology(cells, badAdj, result.incidence, result.counts, read), /adjacency/);
  const badInc = structuredClone(result.incidence); badInc.signedEdges[0] = 999999;
  assert.throws(() => validateTopology(cells, result.adjacency, badInc, result.counts, read), /incidence/);
  const nonempty = [...shards].find(([key, v]) => key.startsWith('topology/') && v.edges.length);
  const edge = nonempty[1].edges[0], saved = structuredClone(edge); edge.right = 999;
  assert.throws(() => validateTopology(cells, result.adjacency, result.incidence, result.counts, read)); Object.assign(edge, saved);
  const trace = [...shards].find(([key, v]) => key.startsWith('source-support/') && v.support.length)[1].support[0];
  const original = structuredClone(trace); trace.owners[0].sourceSegment = [[99, 0], [99, 1]];
  assert.throws(() => validateTopology(cells, result.adjacency, result.incidence, result.counts, read), /source segment/); Object.assign(trace, original);
  assert.equal(result.counts.edges, 15);
});
