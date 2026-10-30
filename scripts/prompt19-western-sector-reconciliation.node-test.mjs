import test from 'node:test';
import assert from 'node:assert/strict';
import polygonClipping from 'polygon-clipping';
import {canonical, hashCanonical, normalizeGeometry, polygons, signedArea} from './prompt14-catalog-core.mjs';
import {ringsFromSegments} from './prompt14-boundary-arrangement.mjs';
import {nodeCatalogBoundarySegments} from './prompt14-catalog-topology.mjs';
import {globalCellId} from './prompt19-joined-topology.mjs';
import {reconcileWesternSector} from './prompt19-western-sector-reconciliation.mjs';

const paju = '91817680B14253606839965', yeoncheon = '91817680B98224083425041';
const shape = ring => normalizeGeometry({type: 'Polygon', coordinates: [ring.map(([x, y]) => [126.7 + x * 0.01, 37.9 + y * 0.01])]});
const box = (w, s, e, n) => shape([[w, s], [e, s], [e, n], [w, n], [w, s]]);
const fine = (name, geometry, countryId = 'KOR', macro = 'KOR:macro:31') => ({name, geometry, countryId, macro, fine: true});
const residual = (name, geometry, countryId = 'KOR') => ({name, geometry, countryId, macro: null, fine: false});

function fixture({differentMacro = false, exposedCoast = false, extra = []} = {}) {
  const specs = [fine(paju, exposedCoast ? box(0, 0, 1, 1) : shape([[0, 0], [1, 0], [1, 1], [0.5, 1], [0.5, 2], [0, 2], [0, 0]])),
    fine(yeoncheon, exposedCoast ? box(1, 0, 2, 1) : shape([[1, 0], [2, 0], [2, 2], [1.5, 2], [1.5, 1], [1, 1], [1, 0]]), 'KOR', differentMacro ? 'KOR:macro:other' : 'KOR:macro:31'),
    residual('inner', box(0.5, 1, 1.5, 1.5)), residual('border', box(0.5, 1.5, 1.5, 2)),
    fine('North', box(0, 2, 2, 3), 'PRK', 'PRK:macro:1'), ...extra,
    residual('remote-island', box(10, 0, 11, 1)), residual('outside', box(100, 0, 101, 1), 'USA')];
  const all = specs.map((s, i) => {
    const localId = `${s.countryId}:cell:${hashCanonical('western-fixture-local', [s, i])}`, seed = `territory:catalog:${hashCanonical('western-fixture-seed', [s.name, i])}`;
    return {type: 'Feature', id: localId, properties: {localId, countryId: s.countryId, name: s.name, sourceId: s.fine ? 'fixture-ADM2' : 'canonical-country-p0', sourceFeatureId: s.name,
      sourceVersion: s.fine ? 'fixture-v1' : null, fineSourceIdentity: s.fine ? {sourceId: 'fixture-ADM2', sourceFeatureId: s.name} : null, unresolvedFineSourceAssignment: !s.fine,
      sourceParentId: s.macro, administrativeParentKey: s.fine ? `fine-macro:${s.countryId}:${s.macro}` : `fine-macro-residual:${s.countryId}`,
      coarseParentTerritoryId: s.fine ? null : seed, seedParentIds: [seed], boundaryBasis: s.fine ? 'administrative' : 'canonical-country-residual', decisions: [s.fine ? 'actual-source-membership' : 'canonical-country-residual']}, geometry: s.geometry};
  });
  const noded = nodeCatalogBoundarySegments(all.map(c => ({geometry: c.geometry, identity: {sourceCountryId: c.properties.countryId}})), {type: 'FeatureCollection', features: []});
  const directed = all.map(() => []); for (const e of noded.segments.values()) {for (const i of e.left) directed[i].push([e.a, e.b]); for (const i of e.right) directed[i].push([e.b, e.a]);}
  all.forEach((c, i) => {c.geometry = ringsFromSegments(directed[i]);});
  const records = all.map(c => ({id: globalCellId(c), countryId: c.properties.countryId, administrativeParentKey: c.properties.administrativeParentKey, previousParentId: c.properties.seedParentIds[0], seedParentIds: c.properties.seedParentIds}));
  const edges = [...noded.segments.values()].map(e => {
    let l = e.left[0], r = e.right[0], coordinates = [e.a, e.b]; if (l === undefined) {l = r; r = undefined; coordinates.reverse();}
    const a = all[l], b = r === undefined ? null : all[r];
    const identity = {leftTerritoryId: globalCellId(a), rightTerritoryId: b ? globalCellId(b) : null,
      boundaryClass: !b ? 'coast' : a.properties.countryId !== b.properties.countryId ? 'country' : !a.properties.fineSourceIdentity || !b.properties.fineSourceIdentity ? 'residual' : a.properties.administrativeParentKey === b.properties.administrativeParentKey ? 'operational' : 'administrative', geometry: {type: 'LineString', coordinates}};
    return {id: `edge:operational:${hashCanonical('western-fixture-edge', identity)}`, ...identity};
  });
  const administrative = [...new Map(all.map(c => [c.properties.administrativeParentKey, {parentKey: c.properties.administrativeParentKey, sourceCountryId: c.properties.countryId, kind: c.properties.fineSourceIdentity ? 'administrative' : 'country-envelope-residual', sourceFeatureId: c.properties.sourceFeatureId, name: c.properties.name, start: 0, count: 1}])).values()];
  const previous = all.map(c => ({oldTerritoryId: c.properties.seedParentIds[0], sourceCountryId: c.properties.countryId, start: 0, count: 1}));
  const cells = all.filter(c => ['KOR', 'PRK'].includes(c.properties.countryId));
  return {cells, bundle: {features: all.map(c => ({...c, id: globalCellId(c)})), records, edges, parents: {administrative, previous},
    report: {invalid: [], unresolved: [], topology: {pass: true}, strictSourceMembership: false, nationalBoundaryReconciliation: {basis: 'game-boundary-reconciliation', changes: [], lineage: Object.fromEntries(records.map(r => [r.id, [r.id]])), policy: 'fixture original stage'},
      summary: ['KOR', 'PRK'].map(countryId => ({countryId, cells: cells.filter(c => c.properties.countryId === countryId).length}))}}};
}

const freeze = v => {if (v && typeof v === 'object' && !Object.isFrozen(v)) {Object.freeze(v); Object.values(v).forEach(freeze);} return v;};
const area = coordinates => coordinates.reduce((sum, p) => sum + Math.max(0, Math.abs(signedArea(p[0])) - p.slice(1).reduce((n, ring) => n + Math.abs(signedArea(ring)), 0)), 0);
const family = c => c.properties.fineSourceIdentity?.sourceFeatureId;
const union = cells => polygonClipping.union(...cells.map(c => polygons(c.geometry)));
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-10, `${a} != ${b}`);

test('partitions the whole connected source-free sector and reaches 100% fine coverage without moving countries or deleting fine territory', () => {
  const input = fixture(), before = canonical(input); freeze(input);
  const result = reconcileWesternSector(input);
  assert.equal(result.evidence.component.inputCellIds.length, 2); assert.equal(result.cells.length, input.cells.length - 2);
  assert.equal(result.evidence.sharedKoreaBorderAfter.fineBothSidesFraction, 1); assert.deepEqual(result.evidence.remainingDmzResiduals, []);
  assert.equal(result.evidence.changes.length, 2); near(result.evidence.ledger.areaError, 0); near(result.evidence.ledger.assignedFamilyArea, result.evidence.ledger.inputResidualArea);
  for (const country of ['KOR', 'PRK']) {
    const old = union(input.cells.filter(c => c.properties.countryId === country)), now = union(result.cells.filter(c => c.properties.countryId === country));
    near(area(polygonClipping.difference(old, now)), 0); near(area(polygonClipping.difference(now, old)), 0);
  }
  for (const source of [paju, yeoncheon, 'North']) {
    const old = union(input.cells.filter(c => family(c) === source)), now = union(result.cells.filter(c => family(c) === source)); near(area(polygonClipping.difference(old, now)), 0);
  }
  assert.equal(canonical(input), before);
});

test('uses only same-country positive fine-contact line samples with an explicit distance approximation bound', () => {
  const input = fixture(), result = reconcileWesternSector(input), sampling = result.evidence.sampling;
  assert.equal(sampling.continuousSegmentVoronoi, false); assert.equal(sampling.boundaryPositionDisplacementBoundClaimed, false);
  assert.ok(sampling.actualMaximumSpacingKm <= 0.25); assert.ok(sampling.maximumContactDistanceOverestimateKm <= 0.125);
  const allowed = new Set(result.evidence.contacts.flatMap(c => c.edges.map(e => e.id)));
  for (const site of sampling.sites) {
    assert.ok(site.contactEdgeIds.length > 0 && site.contactEdgeIds.every(id => allowed.has(id)));
    assert.ok(site.families.every(name => !name.includes('North') && name.startsWith('["KOR"')));
    const q = site.pointKm; let minimum = Infinity;
    for (const contact of result.evidence.contacts) for (const e of contact.edges) for (let i = 1; i < e.geometry.coordinates.length; i++) {
      const project = p => [(p[0] - sampling.origin[0]) * sampling.xScaleKmPerDegree, (p[1] - sampling.origin[1]) * sampling.yScaleKmPerDegree];
      const a = project(e.geometry.coordinates[i - 1]), b = project(e.geometry.coordinates[i]), v = [b[0] - a[0], b[1] - a[1]], t = Math.max(0, Math.min(1, ((q[0] - a[0]) * v[0] + (q[1] - a[1]) * v[1]) / (v[0] ** 2 + v[1] ** 2)));
      minimum = Math.min(minimum, Math.hypot(q[0] - a[0] - t * v[0], q[1] - a[1] - t * v[1]));
    }
    assert.ok(minimum < 1e-9);
  }
});

test('every assigned connected component has a positive contact certificate to its receiving original family', () => {
  const input = fixture(), result = reconcileWesternSector(input);
  for (const change of result.evidence.changes) {
    assert.equal(change.method, 'gameplay-contact-partition'); assert.equal(change.administrativeTruthClaim, false);
    assert.ok(change.assignedPartGeometry); assert.ok(change.assignedComponents.length > 0);
    for (const component of change.assignedComponents) {
      assert.ok(component.positiveOriginalFineContactKm > 0); assert.ok(component.contactSegments.length > 0);
      for (const s of component.contactSegments) assert.ok(s.originalFineCellIds.every(id => input.cells.some(c => globalCellId(c) === id && family(c) === change.fineSourceIdentity.sourceFeatureId)));
    }
  }
  for (const ledger of result.evidence.inputResiduals) {near(ledger.area, ledger.assignedArea); near(ledger.areaError, 0); assert.ok(ledger.assignments.length === 2);}
});

test('retains unrelated residual islands and all other-country identity/geometry objects', () => {
  const input = fixture(), result = reconcileWesternSector(input), island = input.cells.find(c => c.properties.name === 'remote-island');
  const current = result.cells.find(c => c.id === island.id); assert.ok(current); assert.strictEqual(current.geometry, island.geometry); assert.equal(current.properties.fineSourceIdentity, null);
  const usa = input.bundle.records.find(r => r.countryId === 'USA'); assert.strictEqual(result.bundle.records.find(r => r.id === usa.id), usa);
  assert.strictEqual(result.bundle.features.find(f => f.id === usa.id), input.bundle.features.find(f => f.id === usa.id));
  for (const edge of input.bundle.edges.filter(e => e.leftTerritoryId === usa.id)) assert.strictEqual(result.bundle.edges.find(e => e.id === edge.id), edge);
});

test('updates combined national provenance and retains every actual seed predecessor', () => {
  const input = fixture(), result = reconcileWesternSector(input);
  assert.deepEqual(result.bundle.report.nationalBoundaryReconciliation.remainingDmzResiduals, []);
  assert.equal(result.bundle.report.nationalBoundaryReconciliation.sharedKoreaBorderAfter.fineBothSidesFraction, 1);
  assert.deepEqual(result.bundle.report.nationalBoundaryReconciliation.changes, result.evidence.changes);
  for (const cell of result.cells.filter(c => [paju, yeoncheon].includes(family(c)))) {
    assert.equal(cell.properties.boundaryBasis, 'game-boundary-reconciliation'); assert.equal(cell.properties.geometryBasis, 'gameplay-national-boundary-reconciled');
    assert.equal(cell.properties.boundaryAdjustment.method, 'gameplay-contact-partition'); assert.equal(cell.properties.boundaryAdjustment.rawSourceArtifactGeometryUnmodified, true);
    const record = result.bundle.records.find(r => r.id === globalCellId(cell));
    assert.ok(record.seedParentIds.length >= 2); assert.equal(record.previousParentId, record.seedParentIds[0]);
    const consensusSeeds = [...new Set(result.bundle.records.filter(r => r.previousParentId === record.previousParentId).flatMap(r => r.seedParentIds))].sort();
    assert.deepEqual(result.bundle.parents.previous.find(p => p.oldTerritoryId === record.previousParentId).seedParentIds, consensusSeeds);
  }
  for (const id of result.evidence.component.inputCellIds) assert.ok(result.lineage[id].length > 0 && result.lineage[id].every(next => result.bundle.records.some(r => r.id === next)));
});

test('rejects a coast-exposed sector, different macro contact, or second unrelated DMZ residual sector', () => {
  assert.throws(() => reconcileWesternSector(fixture({exposedCoast: true})), /MUST_NOT_TOUCH_COAST/);
  assert.throws(() => reconcileWesternSector(fixture({differentMacro: true})), /TWO_SAME_MACRO/);
  assert.throws(() => reconcileWesternSector(fixture({extra: [residual('second-border', box(20, 0, 21, 1)), fine('North2', box(20, 1, 21, 2), 'PRK', 'PRK:macro:1')]})), /EXPECTED_ONE_KOREAN_RESIDUAL_BORDER_SECTOR/);
});

test('content identities, contact sampling and topology are independent of local cell enumeration', () => {
  const input = fixture(), a = reconcileWesternSector(input), b = reconcileWesternSector({...input, cells: [...input.cells].reverse()});
  assert.deepEqual(a.cells, b.cells); assert.deepEqual(a.bundle.edges, b.bundle.edges); assert.deepEqual(a.bundle.records, b.bundle.records); assert.deepEqual(a.lineage, b.lineage);
  assert.deepEqual(a.evidence.sampling, b.evidence.sampling);
});
