import test from 'node:test';
import assert from 'node:assert/strict';
import {canonical, geometryMetadata, hashCanonical, normalizeGeometry} from './prompt14-catalog-core.mjs';
import {globalCellId} from './prompt19-joined-topology.mjs';
import {deriveFineMacroWorld} from './prompt19-fine-macro-topology.mjs';

const box = (w, s, e, n) => normalizeGeometry({type: 'Polygon', coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]]});
const seedId = name => `territory:catalog:${hashCanonical('fixture-old-parent', name)}`;
const pk = p => p.join(','), cmp = (a, b) => a[0] - b[0] || a[1] - b[1];

function makeFixture({donut = false, residual = false} = {}) {
  const shapes = donut ? [
    normalizeGeometry({type: 'Polygon', coordinates: [[[0, 0], [2, 0], [2, 1], [1, 1], [1, 3], [2, 3], [2, 4], [0, 4], [0, 0]]]}),
    normalizeGeometry({type: 'Polygon', coordinates: [[[2, 0], [4, 0], [4, 4], [2, 4], [2, 3], [3, 3], [3, 1], [2, 1], [2, 0]]]}),
  ] : [box(0, 0, 1, 1), box(1, 0, 2, 1), box(2, 0, 3, 1)];
  const specs = shapes.map((geometry, i) => ({countryId: 'KOR', sourceFeatureId: i < 2 ? 'A' : 'B', parent: i === 0 ? 'old1' : 'old2', geometry}));
  if (residual) specs.push({countryId: 'KOR', sourceFeatureId: null, parent: 'old2', geometry: box(3, 0, 4, 1)});
  specs.push({countryId: 'USA', sourceFeatureId: null, parent: 'usa', geometry: box(10, 0, 11, 1)});
  const all = specs.map((s, i) => {
    const localId = `${s.countryId}:cell:${hashCanonical('fixture-local', [s, i])}`;
    return {type: 'Feature', id: localId, properties: {localId, countryId: s.countryId,
      sourceId: s.sourceFeatureId ? 'fixture-admin2' : 'canonical-country-p0', sourceFeatureId: s.sourceFeatureId ?? `residual-${i}`,
      sourceVersion: s.sourceFeatureId ? 'source-v1' : null, sourceParentId: null,
      fineSourceIdentity: s.sourceFeatureId ? {sourceId: 'fixture-admin2', sourceFeatureId: s.sourceFeatureId} : null,
      unresolvedFineSourceAssignment: !s.sourceFeatureId, boundaryBasis: s.sourceFeatureId ? 'administrative' : 'canonical-country-residual',
      adminLevel: s.sourceFeatureId ? 2 : null, administrativeParentKey: `coarse:${s.countryId}:${s.parent}`,
      coarseParentTerritoryId: seedId(s.parent), name: s.sourceFeatureId ?? s.countryId, arrangementGroup: s.parent,
      decisions: [s.sourceFeatureId ? 'actual-source-membership' : 'canonical-country-residual']}, geometry: s.geometry};
  });
  const records = all.map(c => ({id: globalCellId(c), countryId: c.properties.countryId,
    administrativeParentKey: c.properties.administrativeParentKey, previousParentId: c.properties.coarseParentTerritoryId}));
  const byId = new Map(records.map(r => [r.id, r])), segmentMap = new Map();
  for (const c of all) {
    const id = globalCellId(c);
    for (const ring of c.geometry.coordinates) for (let i = 1; i < ring.length; i++) {
      const a = ring[i - 1], b = ring[i], key = cmp(a, b) < 0 ? `${pk(a)};${pk(b)}` : `${pk(b)};${pk(a)}`;
      if (segmentMap.has(key)) {
        const edge = segmentMap.get(key); assert.equal(edge.rightTerritoryId, null); edge.rightTerritoryId = id;
      } else segmentMap.set(key, {leftTerritoryId: id, rightTerritoryId: null, geometry: {type: 'LineString', coordinates: [a, b]}});
    }
  }
  const edges = [...segmentMap.values()].map(e => {
    const left = byId.get(e.leftTerritoryId), right = byId.get(e.rightTerritoryId);
    const record = {...e, boundaryClass: !right ? 'coast' : left.countryId !== right.countryId ? 'country' : left.administrativeParentKey === right.administrativeParentKey ? 'operational' : 'administrative'};
    return {id: `edge:operational:${hashCanonical('fixture-edge', record)}`, ...record};
  });
  const administrative = ['old1', 'old2', 'usa'].map(name => ({parentKey: `coarse:${name === 'usa' ? 'USA' : 'KOR'}:${name}`,
    sourceCountryId: name === 'usa' ? 'USA' : 'KOR', kind: 'administrative', name, sourceFeatureId: name,
    sourceVersion: 'old-source', adminId: name, restorationId: name, residualId: null, start: 0, count: 1}));
  const previous = administrative.map(p => ({oldTerritoryId: seedId(p.name), sourceCountryId: p.sourceCountryId, start: 0, count: 1}));
  const cells = all.filter(c => c.properties.countryId === 'KOR');
  const bundle = {schemaVersion: 'prompt19-joined-world-input-v1', features: all.map(c => ({...c, id: globalCellId(c)})), records, edges,
    parents: {administrative, previous}, report: {invalid: [], unresolved: [], sourceTrace: [{countryId: 'KOR', sourceFeatureId: 'A', represented: true}],
      summary: [{countryId: 'KOR', sourceFeatures: donut ? 1 : 2, cells: cells.length}], topology: {pass: true, edges: edges.length}}};
  const crosswalks = {KOR: {A: {macroId: 'west', name: 'West', nameKo: '서부', sourceVersion: 'official-hierarchy-v1'},
    B: {macroId: 'east', name: 'East', nameKo: '동부', sourceVersion: 'official-hierarchy-v1'}}};
  return {bundle, cells, crosswalks};
}

const cellsWithSource = (result, id) => result.cells.filter(c => c.properties.fineSourceIdentity?.sourceFeatureId === id);
const freezes = value => {if (value && typeof value === 'object' && !Object.isFrozen(value)) {Object.freeze(value); for (const child of Object.values(value)) freezes(child);} return value;};

test('merges a complete fine source across old ADM1 cuts and promotes only shared fine edges between new macros', () => {
  const input = makeFixture(), before = canonical(input); freezes(input);
  const result = deriveFineMacroWorld(input), a = cellsWithSource(result, 'A');
  assert.equal(a.length, 1); assert.equal(geometryMetadata(a[0].geometry).area, 2);
  assert.equal(result.oldCellToNewCell[globalCellId(input.cells[0])], result.oldCellToNewCell[globalCellId(input.cells[1])]);
  assert.equal(result.evidence.removedSeams, 1); assert.equal(result.evidence.sourceCoordinatesMoved, 0);
  assert.equal(result.bundle.edges.some(e => e.geometry.coordinates.every(p => p[0] === 1)), false);
  const promoted = result.bundle.edges.filter(e => e.boundaryClass === 'administrative');
  assert.equal(promoted.length, 1); assert.deepEqual(promoted[0].geometry.coordinates, [[2, 0], [2, 1]]);
  const left = result.bundle.records.find(r => r.id === promoted[0].leftTerritoryId), right = result.bundle.records.find(r => r.id === promoted[0].rightTerritoryId);
  assert.notEqual(left.administrativeParentKey, right.administrativeParentKey);
  assert.equal(canonical(input), before); assert.strictEqual(result.bundle.report.sourceTrace, input.bundle.report.sourceTrace);
  assert.equal(result.bundle.report.summary.find(s => s.countryId === 'KOR').cells, 2);
});

test('different fine sources remain separate but their shared line is micro when their verified macro parent agrees', () => {
  const input = makeFixture(); input.crosswalks.KOR.B = {...input.crosswalks.KOR.A};
  const result = deriveFineMacroWorld(input);
  assert.equal(result.cells.length, 2);
  const shared = result.bundle.edges.find(e => e.rightTerritoryId);
  assert.equal(shared.boundaryClass, 'operational');
  assert.equal(result.bundle.parents.administrative.filter(p => p.sourceCountryId === 'KOR').length, 1);
});

test('exact dissolution retains an administrative hole and its coastline without changing edge coordinates', () => {
  const input = makeFixture({donut: true}), result = deriveFineMacroWorld(input), fine = cellsWithSource(result, 'A');
  assert.equal(fine.length, 1); assert.equal(geometryMetadata(fine[0].geometry).area, 12); assert.equal(geometryMetadata(fine[0].geometry).holes, 1);
  assert.ok(result.bundle.edges.every(e => e.boundaryClass === 'coast'));
  const original = new Set(input.bundle.edges.map(e => canonical(e.geometry)));
  assert.ok(result.bundle.edges.every(e => original.has(canonical(e.geometry))));
  assert.equal(result.bundle.edges.filter(e => e.leftTerritoryId === globalCellId(fine[0])).length, 12);
});

test('source-free residual land keeps its ID and geometry and never gains a fine or named macro identity', () => {
  const input = makeFixture({residual: true}), old = input.cells.find(c => c.properties.fineSourceIdentity === null), result = deriveFineMacroWorld(input);
  const current = result.cells.find(c => c.id === old.id), id = globalCellId(old);
  assert.ok(current); assert.strictEqual(current.geometry, old.geometry); assert.equal(result.oldCellToNewCell[id], id);
  assert.equal(current.properties.fineSourceIdentity, null); assert.equal(current.properties.sourceParentId, null);
  const record = result.bundle.records.find(r => r.id === id), parent = result.bundle.parents.administrative.find(p => p.parentKey === record.administrativeParentKey);
  assert.equal(parent.kind, 'country-envelope-residual'); assert.equal(parent.sourceFeatureId, null);
  assert.ok(result.bundle.edges.filter(e => e.rightTerritoryId && [e.leftTerritoryId, e.rightTerritoryId].includes(id)).every(e => e.boundaryClass === 'residual'));
});

test('merged records retain every actual predecessor for runtime seed-state consensus', () => {
  const input = makeFixture(), result = deriveFineMacroWorld(input), a = cellsWithSource(result, 'A')[0];
  const expected = [seedId('old1'), seedId('old2')].sort(), record = result.bundle.records.find(r => r.id === globalCellId(a));
  assert.deepEqual(record.seedParentIds, expected); assert.equal(record.previousParentId, expected[0]);
  const parent = result.bundle.parents.previous.find(p => p.oldTerritoryId === record.previousParentId);
  assert.deepEqual(parent.seedParentIds, expected); assert.equal(a.properties.coarseParentTerritoryId, null);
  assert.deepEqual(a.properties.seedParentIds, expected);
});

test('other-country cells, records, parents and edges remain the original objects', () => {
  const input = makeFixture(), result = deriveFineMacroWorld(input), country = 'USA';
  const oldRecord = input.bundle.records.find(r => r.countryId === country), oldFeature = input.bundle.features.find(f => f.id === oldRecord.id);
  assert.strictEqual(result.bundle.records.find(r => r.id === oldRecord.id), oldRecord);
  assert.strictEqual(result.bundle.features.find(f => f.id === oldRecord.id), oldFeature);
  for (const kind of ['administrative', 'previous']) assert.strictEqual(result.bundle.parents[kind].find(p => p.sourceCountryId === country), input.bundle.parents[kind].find(p => p.sourceCountryId === country));
  for (const edge of input.bundle.edges.filter(e => e.leftTerritoryId === oldRecord.id)) assert.strictEqual(result.bundle.edges.find(e => e.id === edge.id), edge);
});

test('rejects missing, malformed or inconsistent crosswalks and incomplete cell coverage', () => {
  for (const bad of [undefined, {}, {macroId: 'west'}, {macroId: '', name: 'West'}, {macroId: 'west', name: 'West', sourceVersion: 2}]) {
    const input = makeFixture(); input.crosswalks.KOR.A = bad;
    assert.throws(() => deriveFineMacroWorld(input), /MISSING_OR_INVALID_CROSSWALK/);
  }
  const inconsistent = makeFixture(); inconsistent.crosswalks.KOR.B.macroId = 'west';
  assert.throws(() => deriveFineMacroWorld(inconsistent), /INCONSISTENT_PARENT/);
  const incomplete = makeFixture(); incomplete.cells.pop();
  assert.throws(() => deriveFineMacroWorld(incomplete), /INCOMPLETE_CELLS/);
});

test('results and content-addressed IDs are independent of input cell enumeration', () => {
  const first = makeFixture(), second = makeFixture(); second.cells.reverse();
  const a = deriveFineMacroWorld(first), b = deriveFineMacroWorld(second);
  assert.deepEqual(a.cells, b.cells); assert.deepEqual(a.bundle.records, b.bundle.records); assert.deepEqual(a.bundle.edges, b.bundle.edges);
});
