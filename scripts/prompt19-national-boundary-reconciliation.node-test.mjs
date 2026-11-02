import test from 'node:test';
import assert from 'node:assert/strict';
import {canonical, geometryMetadata, hashCanonical, normalizeGeometry} from './prompt14-catalog-core.mjs';
import {ringsFromSegments} from './prompt14-boundary-arrangement.mjs';
import {nodeCatalogBoundarySegments} from './prompt14-catalog-topology.mjs';
import {globalCellId} from './prompt19-joined-topology.mjs';
import {reconcileNationalBoundaries} from './prompt19-national-boundary-reconciliation.mjs';

const scale = 0.01;
const polygon = rings => normalizeGeometry({type: 'Polygon', coordinates: rings.map(r => r.map(p => p.map(v => v * scale)))});
const box = (w, s, e, n) => polygon([[[w, s], [e, s], [e, n], [w, n], [w, s]]]);
const fine = (name, geometry, countryId = 'KOR') => ({name, geometry, countryId, fine: true});
const residual = (name, geometry, countryId = 'KOR') => ({name, geometry, countryId, fine: false});

function fixture(specs) {
  const all = [...specs, residual('outside', box(1000, 0, 1001, 1), 'USA')].map(s => {
    const localId = `${s.countryId}:cell:${hashCanonical('national-reconciliation-fixture', s)}`, parent = `${s.countryId}:macro:${s.fine ? s.name : 'residual'}`;
    const seed = `territory:catalog:${hashCanonical('national-reconciliation-fixture-seed', [s.countryId, s.name])}`;
    return {type: 'Feature', id: localId, properties: {localId, countryId: s.countryId, name: s.name,
      sourceId: s.fine ? 'fixture-fine' : 'canonical-country-p0', sourceFeatureId: s.fine ? s.name : `residual:${s.name}`,
      sourceVersion: s.fine ? 'fixture-v1' : null, fineSourceIdentity: s.fine ? {sourceId: 'fixture-fine', sourceFeatureId: s.name} : null,
      unresolvedFineSourceAssignment: !s.fine, sourceParentId: s.fine ? parent : null, administrativeParentKey: parent,
      coarseParentTerritoryId: seed, seedParentIds: [seed], boundaryBasis: s.fine ? 'administrative' : 'canonical-country-residual', decisions: [s.fine ? 'actual-source-membership' : 'canonical-country-residual']}, geometry: s.geometry};
  });
  const common = nodeCatalogBoundarySegments(all.map(c => ({geometry: c.geometry, identity: {sourceCountryId: c.properties.countryId}})), {type: 'FeatureCollection', features: []});
  const directed = all.map(() => []);
  for (const e of common.segments.values()) {for (const i of e.left) directed[i].push([e.a, e.b]); for (const i of e.right) directed[i].push([e.b, e.a]);}
  all.forEach((c, i) => {c.geometry = ringsFromSegments(directed[i]);});
  const records = all.map(c => ({id: globalCellId(c), countryId: c.properties.countryId, administrativeParentKey: c.properties.administrativeParentKey,
    previousParentId: c.properties.coarseParentTerritoryId, seedParentIds: c.properties.seedParentIds}));
  const edges = [...common.segments.values()].map(e => {
    let left = e.left[0], right = e.right[0], coordinates = [e.a, e.b];
    if (left === undefined) {left = right; right = undefined; coordinates.reverse();}
    const l = all[left], r = right === undefined ? null : all[right];
    const identity = {leftTerritoryId: globalCellId(l), rightTerritoryId: r ? globalCellId(r) : null,
      boundaryClass: !r ? 'coast' : l.properties.countryId !== r.properties.countryId ? 'country' : !l.properties.fineSourceIdentity || !r.properties.fineSourceIdentity ? 'residual' : l.properties.administrativeParentKey === r.properties.administrativeParentKey ? 'operational' : 'administrative',
      geometry: {type: 'LineString', coordinates}};
    return {id: `edge:operational:${hashCanonical('national-reconciliation-fixture-edge', identity)}`, ...identity};
  });
  const administrative = [...new Map(all.map(c => [c.properties.administrativeParentKey, {parentKey: c.properties.administrativeParentKey,
    sourceCountryId: c.properties.countryId, kind: c.properties.fineSourceIdentity ? 'administrative' : 'country-envelope-residual', sourceFeatureId: c.properties.sourceFeatureId, name: c.properties.name, start: 0, count: 1}])).values()];
  const previous = all.map(c => ({oldTerritoryId: c.properties.coarseParentTerritoryId, sourceCountryId: c.properties.countryId, start: 0, count: 1}));
  const cells = all.filter(c => c.properties.countryId !== 'USA');
  return {cells, bundle: {schemaVersion: 'prompt19-joined-world-input-v1', features: all.map(c => ({...c, id: globalCellId(c)})), records, edges,
    parents: {administrative, previous}, report: {invalid: [], unresolved: [], strictSourceMembership: true, topology: {pass: true},
      sourceTrace: [{represented: true}], summary: [...new Set(cells.map(c => c.properties.countryId))].map(countryId => ({countryId, cells: cells.filter(c => c.properties.countryId === countryId).length}))}}};
}

const bySource = (r, source) => r.cells.filter(c => c.properties.fineSourceIdentity?.sourceFeatureId === source);
const area = cells => cells.reduce((s, c) => s + geometryMetadata(c.geometry).area, 0);
const freeze = v => {if (v && typeof v === 'object' && !Object.isFrozen(v)) {Object.freeze(v); Object.values(v).forEach(freeze);} return v;};
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-10, `${a} != ${b}`);

test('absorbs a coast residual with one same-country positive-length fine-family contact without mutating inputs', () => {
  const input = fixture([fine('A', box(0, 0, 1, 1)), residual('coast', box(0, 1, 1, 1.1))]), before = canonical(input); freeze(input);
  const result = reconcileNationalBoundaries(input);
  assert.equal(result.cells.length, 1); near(area(bySource(result, 'A')), 1.1 * scale ** 2);
  assert.equal(result.evidence.changes.length, 1); assert.equal(result.evidence.changes[0].witness, 'unique-positive-length-fine-family-contact');
  assert.equal(result.cells[0].properties.geometryBasis, 'gameplay-national-boundary-reconciled');
  assert.equal(result.cells[0].properties.boundaryAdjustment.administrativeTruthClaim, false);
  assert.equal(result.bundle.report.strictSourceMembership, false); assert.equal(canonical(input), before);
  assert.strictEqual(result.bundle.report.sourceTrace, input.bundle.report.sourceTrace);
});

test('an enclosed source hole remains unassigned with its original geometry and ID', () => {
  const outer = polygon([[[0, 0], [3, 0], [3, 3], [0, 3], [0, 0]], [[1, 1], [1, 2], [2, 2], [2, 1], [1, 1]]]);
  const input = fixture([fine('A', outer), residual('hole', box(1, 1, 2, 2))]), old = input.cells[1], result = reconcileNationalBoundaries(input);
  const hole = result.cells.find(c => c.id === old.id); assert.ok(hole); assert.strictEqual(hole.geometry, old.geometry);
  assert.equal(hole.properties.fineSourceIdentity, null); assert.equal(geometryMetadata(bySource(result, 'A')[0].geometry).holes, 1);
  assert.equal(result.evidence.changes.length, 0); assert.ok(result.evidence.retained.some(r => r.reason === 'enclosed-inland-residual'));
});

test('the same locked national seam is covered by fine families on both sides without crossing country ownership', () => {
  const input = fixture([fine('South', box(0, 0, 1, 1)), residual('South-strip', box(0, 1, 1, 1.1)),
    residual('North-strip', box(0, 1.1, 1, 1.2), 'PRK'), fine('North', box(0, 1.2, 1, 2.2), 'PRK')]);
  const national = input.bundle.edges.filter(e => e.boundaryClass === 'country').map(e => canonical(e.geometry));
  const result = reconcileNationalBoundaries(input);
  assert.equal(result.evidence.sharedKoreaBorderAfter.fineBothSidesFraction, 1);
  assert.deepEqual(result.bundle.edges.filter(e => e.boundaryClass === 'country').map(e => canonical(e.geometry)), national);
  near(area(result.cells.filter(c => c.properties.countryId === 'KOR')), 1.1 * scale ** 2);
  near(area(result.cells.filter(c => c.properties.countryId === 'PRK')), 1.1 * scale ** 2);
});

test('two actual shared-fine terminal headings split a three-family coastal strip in one partition', () => {
  const input = fixture([fine('A', box(0, 0, 1, 1)), fine('B', box(1, 0, 2, 1)), fine('C', box(2, 0, 3, 1)), residual('strip', box(0, 1, 3, 1.2))]);
  const before = canonical(input), result = reconcileNationalBoundaries(input);
  assert.equal(result.cells.length, 3); for (const source of ['A', 'B', 'C']) near(area(bySource(result, source)), 1.2 * scale ** 2);
  const split = result.evidence.splitAttempts.find(a => a.outcome === 'witnessed-split'); assert.ok(split); assert.equal(split.rays, 2); assert.equal(split.faces, 3);
  assert.equal(result.evidence.changes.filter(c => c.kind === 'witnessed-residual-part-assignment').length, 3);
  assert.ok(result.evidence.changes.every(c => c.originalResidualIds.every(id => id === globalCellId(input.cells[3]))));
  assert.equal(result.evidence.precisionNormalization.gridDegrees, 1e-12); assert.equal(canonical(input), before);
  const ids = new Set(result.bundle.records.map(r => r.id)); assert.ok(result.bundle.edges.every(e => ids.has(e.leftTerritoryId) && (!e.rightTerritoryId || ids.has(e.rightTerritoryId))));
});

test('multiple source contacts without an actual shared terminal retain an ambiguous residual', () => {
  const input = fixture([fine('A', box(0, 0, 1, 1)), residual('ambiguous', box(1, 0, 2, 1)), fine('B', box(2, 0, 3, 1))]);
  const result = reconcileNationalBoundaries(input), old = input.cells[1], current = result.cells.find(c => c.id === old.id);
  assert.ok(current); assert.strictEqual(current.geometry, old.geometry); assert.equal(current.properties.fineSourceIdentity, null);
  assert.equal(result.evidence.changes.length, 0); assert.ok(result.evidence.splitAttempts.some(a => a.outcome === 'no-witnessed-terminal-enters-residual'));
});

test('fine identity never propagates across a country edge and unrelated countries retain their original objects', () => {
  const input = fixture([fine('A', box(0, 0, 1, 1)), residual('foreign', box(1, 0, 1.1, 1), 'PRK')]), result = reconcileNationalBoundaries(input);
  assert.equal(result.cells.find(c => c.properties.countryId === 'PRK').properties.fineSourceIdentity, null);
  const usa = input.bundle.records.find(r => r.countryId === 'USA'); assert.strictEqual(result.bundle.records.find(r => r.id === usa.id), usa);
  assert.strictEqual(result.bundle.features.find(f => f.id === usa.id), input.bundle.features.find(f => f.id === usa.id));
  for (const e of input.bundle.edges.filter(e => e.leftTerritoryId === usa.id)) assert.strictEqual(result.bundle.edges.find(n => n.id === e.id), e);
});

test('bulk missing source land and large thin multi-family gaps remain unassigned', () => {
  const bulk = fixture([fine('A', box(0, 0, 20, 1)), residual('missing-county', box(0, 1, 20, 21))]);
  const result = reconcileNationalBoundaries(bulk); assert.equal(result.evidence.changes.length, 0); assert.equal(result.cells.length, 2);
  assert.ok(result.evidence.retained.some(r => r.reason === 'bulk-missing-source-land'));
  const thin = fixture([fine('A', box(0, 0, 150, 1)), fine('B', box(150, 0, 300, 1)), residual('large-thin', box(0, 1, 300, 2))]);
  const retained = reconcileNationalBoundaries(thin); assert.equal(retained.evidence.changes.length, 0); assert.equal(retained.cells.length, 3);
});

test('unique-family propagation retains original residual provenance and every seed predecessor', () => {
  const input = fixture([fine('A', box(0, 0, 1, 1)), residual('first', box(0, 1, 1, 1.1)), residual('second', box(0, 1.1, 1, 1.2))]);
  const result = reconcileNationalBoundaries(input), originals = input.cells.slice(1).map(globalCellId).sort();
  assert.equal(result.cells.length, 1); assert.equal(result.evidence.changes.length, 2);
  assert.deepEqual(result.cells[0].properties.boundaryAdjustment.originalResidualIds, originals);
  assert.deepEqual(result.evidence.changes.flatMap(c => c.originalResidualIds).sort(), originals);
  assert.deepEqual(result.bundle.records.find(r => r.countryId === 'KOR').seedParentIds, input.cells.flatMap(c => c.properties.seedParentIds).sort());
  for (const c of input.cells) assert.deepEqual(result.lineage[globalCellId(c)], [globalCellId(result.cells[0])]);
});

test('content identities and output geometry are deterministic when local enumeration is reversed', () => {
  const input = fixture([fine('A', box(0, 0, 1, 1)), fine('B', box(1, 0, 2, 1)), residual('strip', box(0, 1, 2, 1.2))]);
  const a = reconcileNationalBoundaries(input), b = reconcileNationalBoundaries({...input, cells: [...input.cells].reverse()});
  assert.deepEqual(a.cells, b.cells); assert.deepEqual(a.bundle.edges, b.bundle.edges); assert.deepEqual(a.lineage, b.lineage);
});

test('a later split follows the original terminal through a certified same-pair corridor after unique contact converges', () => {
  const input = fixture([fine('A', box(0, 0, 1, 1)), fine('B', box(1, 0, 2, 1)),
    residual('bridge', box(0, 1, 2, 1.1)), residual('outer-strip', box(0, 1.1, 2, 1.3))]);
  const result = reconcileNationalBoundaries(input);
  assert.equal(result.cells.length, 2); near(area(bySource(result, 'A')), 1.3 * scale ** 2); near(area(bySource(result, 'B')), 1.3 * scale ** 2);
  assert.ok(result.evidence.splitAttempts.some(a => a.round > 0 && a.outcome === 'witnessed-split'));
  assert.ok(result.evidence.changes.some(c => c.terminalWitnesses?.some(w => w.corridorWitness?.terminalToResidualEntryKm > 0)));
  const originalResiduals = new Set(input.cells.filter(c => !c.properties.fineSourceIdentity).map(globalCellId));
  assert.ok(result.evidence.changes.every(c => c.originalResidualIds.every(id => originalResiduals.has(id))));
  assert.ok(result.cells.every(c => c.properties.boundaryAdjustment.originalResidualIds.every(id => originalResiduals.has(id))));
});

test('a DMZ residual with no justified original terminal remains explicit and unassigned', () => {
  const input = fixture([fine('A', box(0, 0, 1, 1)), residual('unproved-dmz', box(1, 0, 2, 1)), fine('B', box(2, 0, 3, 1)), fine('North', box(1, 1, 2, 2), 'PRK')]);
  const result = reconcileNationalBoundaries(input), remaining = result.evidence.remainingDmzResiduals;
  assert.equal(remaining.length, 1); assert.equal(remaining[0].countryId, 'KOR'); assert.ok(remaining[0].lengthKm > 0);
  assert.match(remaining[0].reason, /No original shared-fine terminal heading/);
  const cell = result.cells.find(c => globalCellId(c) === remaining[0].id); assert.ok(cell); assert.equal(cell.properties.fineSourceIdentity, null);
});

test('opt-in cleanup absorbs a small near-boundary P0 land loop only with one fine family around its entire perimeter', () => {
  const outer = polygon([[[0, 0], [3, 0], [3, 3], [0, 3], [0, 0]], [[1, 1], [1, 2], [2, 2], [2, 1], [1, 1]]]);
  const input = fixture([fine('A', outer), residual('land-loop', box(1, 1, 2, 2))]), before = canonical(input); freeze(input);
  const unchanged = reconcileNationalBoundaries(input); assert.equal(unchanged.cells.length, 2); assert.equal(Object.hasOwn(unchanged.evidence, 'cleanupBoundarySlivers'), false);
  const result = reconcileNationalBoundaries({...input, cleanupBoundarySlivers: true});
  assert.equal(result.cells.length, 1); assert.equal(geometryMetadata(result.cells[0].geometry).holes, 0); near(area(result.cells), 9 * scale ** 2);
  const change = result.evidence.changes.find(c => c.kind === 'enclosed-residual-loop-absorption'); assert.ok(change);
  assert.equal(change.enclosedCleanup.sourceFreeP0LandCell, true); assert.equal(change.enclosedCleanup.wholePerimeterContact, true);
  assert.ok(change.approximateAreaKm2 <= 3); assert.ok(change.enclosedCleanup.minimumBoundaryDistanceKm <= 5); assert.ok(change.enclosedCleanup.maximumBoundaryVertexDistanceKm <= 5);
  near(change.enclosedCleanup.positiveFineContactPerimeterKm, change.perimeterKm);
  assert.deepEqual(change.originalResidualIds, [globalCellId(input.cells[1])]);
  assert.equal(result.evidence.cleanupBoundarySlivers, true); assert.equal(result.evidence.cleanupPolicy.maximumEnclosedResidualAreaKm2, 3);
  assert.equal(result.cells[0].properties.boundaryAdjustment.rawSourceArtifactGeometryUnmodified, true);
  assert.deepEqual(result.cells[0].properties.boundaryAdjustment.enclosedCleanupResidualIds, change.originalResidualIds);
  assert.equal(canonical(input), before);
});

test('cleanup preserves a small source-free loop farther than 5 km inland and actual water holes', () => {
  const outer = polygon([[[0, 0], [20, 0], [20, 20], [0, 20], [0, 0]], [[9, 9], [9, 10], [10, 10], [10, 9], [9, 9]]]);
  const input = fixture([fine('A', outer), residual('far-loop', box(9, 9, 10, 10))]);
  const result = reconcileNationalBoundaries({...input, cleanupBoundarySlivers: true});
  assert.equal(result.cells.length, 2); assert.equal(result.evidence.changes.length, 0);
  const retained = result.evidence.retained.find(r => r.originalResidualId === globalCellId(input.cells[1])); assert.ok(retained);
  assert.equal(retained.cleanupEvaluation.wholePerimeterContact, true); assert.ok(retained.cleanupEvaluation.minimumBoundaryDistanceKm > 5);
  assert.equal(retained.cleanupEvaluation.eligible, false);
  const water = fixture([fine('A', outer)]), waterResult = reconcileNationalBoundaries({...water, cleanupBoundarySlivers: true});
  assert.equal(waterResult.evidence.changes.length, 0); assert.equal(geometryMetadata(waterResult.cells[0].geometry).holes, 1);
  assert.deepEqual(waterResult.cells[0].geometry, water.cells[0].geometry);
});

test('cleanup permits a witnessed 159 km² long thin strip while default mode retains its former 100 km² cap', () => {
  const input = fixture([fine('A', box(0, 0, 50, 1)), fine('B', box(50, 0, 100, 1)), residual('long-thin', box(0, 1, 100, 2.3))]);
  assert.equal(reconcileNationalBoundaries(input).cells.length, 3);
  const result = reconcileNationalBoundaries({...input, cleanupBoundarySlivers: true}); assert.equal(result.cells.length, 2);
  const extended = result.evidence.changes.filter(c => c.longThinResidualException); assert.equal(extended.length, 2);
  for (const change of extended) {
    assert.ok(change.approximateAreaKm2 > 100 && change.approximateAreaKm2 <= 250); assert.ok(change.effectiveStripWidthKm <= 2);
    assert.ok(change.terminalWitnesses.length > 0 && change.terminalWitnesses.every(w => w.lengthKm <= 10));
    assert.equal(change.guard.originalSharedFineTerminalWitnessRequired, true);
  }
  near(area(result.cells), area(input.cells));
});

test('cleanup retains bulk missing land and long thin residuals above 250 km² or wider than 2 km', () => {
  for (const [length, height] of [[300, 1], [75, 2.4]]) {
    const input = fixture([fine('A', box(0, 0, length / 2, 1)), fine('B', box(length / 2, 0, length, 1)), residual('guarded', box(0, 1, length, 1 + height))]);
    const result = reconcileNationalBoundaries({...input, cleanupBoundarySlivers: true}); assert.equal(result.cells.length, 3); assert.equal(result.evidence.changes.length, 0);
  }
  const bulk = fixture([fine('A', box(0, 0, 20, 1)), residual('missing-county', box(0, 1, 20, 21))]);
  assert.equal(reconcileNationalBoundaries({...bulk, cleanupBoundarySlivers: true}).evidence.changes.length, 0);
});

test('cleanup does not use an internal administrative edge as exterior proximity or absorb a loop with vertices beyond 5 km', () => {
  const internal = fixture([fine('A', polygon([[[0, 0], [11, 0], [11, 20], [0, 20], [0, 0]], [[9, 9], [9, 10], [10, 10], [10, 9], [9, 9]]])),
    fine('B', box(11, 0, 20, 20)), residual('far-outline-near-admin', box(9, 9, 10, 10))]);
  const kept = reconcileNationalBoundaries({...internal, cleanupBoundarySlivers: true}); assert.equal(kept.evidence.changes.length, 0);
  assert.ok(kept.evidence.retained.find(r => r.originalResidualId === globalCellId(internal.cells[2])).cleanupEvaluation.minimumBoundaryDistanceKm > 5);
  const narrow = [[1, 1], [1.1, 1], [7.1, 7], [7, 7], [1, 1]];
  const corridor = fixture([fine('A', polygon([[[0, 0], [20, 0], [20, 20], [0, 20], [0, 0]], narrow])), residual('inland-corridor', polygon([narrow]))]);
  const result = reconcileNationalBoundaries({...corridor, cleanupBoundarySlivers: true}); assert.equal(result.evidence.changes.length, 0);
  const proof = result.evidence.retained.find(r => r.originalResidualId === globalCellId(corridor.cells[1])).cleanupEvaluation;
  assert.ok(proof.minimumBoundaryDistanceKm <= 5); assert.ok(proof.maximumBoundaryVertexDistanceKm > 5); assert.equal(proof.eligible, false);
});

test('cleanup continues an original heading through a same-pair protrusion only with a whole-path interval certificate', () => {
  const ring = [[0, 1], [2, 1], [2, 2], [0, 2], [0, 1]], hole = [[0.9, 1.1], [0.9, 1.2], [1.1, 1.2], [1.1, 1.1], [0.9, 1.1]];
  const input = fixture([fine('A', box(0, 0, 1, 1)), fine('B', box(1, 0, 2, 1)), residual('coastal-strip', polygon([ring, hole])), fine('A', box(0.9, 1.1, 1.1, 1.2))]);
  const previous = reconcileNationalBoundaries(input); assert.equal(previous.cells.filter(c => !c.properties.fineSourceIdentity).length, 1);
  const result = reconcileNationalBoundaries({...input, cleanupBoundarySlivers: true});
  assert.equal(result.cells.filter(c => !c.properties.fineSourceIdentity).length, 0); near(area(result.cells), area(input.cells));
  const witnesses = result.evidence.changes.flatMap(c => c.terminalWitnesses ?? []).filter(w => w.lengthKm > w.earlierResidualExitKm);
  assert.ok(witnesses.length > 0);
  assert.ok(witnesses.every(w => w.lengthKm <= 10 && w.corridorWitness.wholePathSegmentCertificate));
  assert.ok(witnesses.some(w => w.corridorWitness.certifiedSegments.some(s => !s.targetResidual && s.fineFamilies?.length)));
  assert.ok(witnesses.every(w => Math.abs(w.corridorWitness.certifiedSegments.reduce((sum, s) => sum + s.toFraction - s.fromFraction, 0) - 1) < 1e-12));
});

test('cleanup does not continue a heading through a third fine family, another country, or sea', () => {
  const ring = [[0, 1], [2, 1], [2, 2], [0, 2], [0, 1]], hole = [[0.9, 1.1], [0.9, 1.2], [1.1, 1.2], [1.1, 1.1], [0.9, 1.1]];
  for (const blocker of [fine('C', box(0.9, 1.1, 1.1, 1.2)), fine('Foreign', box(0.9, 1.1, 1.1, 1.2), 'PRK'), null]) {
    const input = fixture([fine('A', box(0, 0, 1, 1)), fine('B', box(1, 0, 2, 1)), residual('guarded-strip', polygon([ring, hole])), ...(blocker ? [blocker] : [])]);
    const result = reconcileNationalBoundaries({...input, cleanupBoundarySlivers: true});
    assert.equal(result.cells.filter(c => !c.properties.fineSourceIdentity).length, 1); assert.equal(result.evidence.changes.length, 0);
    near(area(result.cells), area(input.cells));
  }
});
