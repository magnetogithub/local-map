import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {gunzipSync} from 'node:zlib';
import {prompt19SourceLockSchema} from '../../prompt19-country-core.mjs';
import {jsonBytes, normalizeGeometry, polygons} from '../../prompt14-catalog-core.mjs';
import {globalCellId} from '../../prompt19-joined-topology.mjs';

const root = 'data/raw/prompt19/KOR/geoboundaries-9469f095';
const json = path => JSON.parse(fs.readFileSync(path));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
test('acquired KOR ADM3 and preprocessing inputs match the recorded byte identities', () => {
  const lock = prompt19SourceLockSchema.parse(json('data/source-locks/prompt19/KOR.json'));
  const acquisition = json(`${root}/acquisition.json`);
  const extraLicense = json(`${root}/additional-license-receipt.json`);
  for (const p of [...acquisition.receipts, extraLicense, lock.normalizedInput, ...lock.preprocessing.code]) {
    const bytes = fs.readFileSync(p.path); assert.equal(bytes.length, p.byteLength); assert.equal(sha(bytes), p.sha256);
  }
  assert.equal(lock.sources[0].adminLevel, 3);
  assert.equal(lock.sources[0].publishedAt, null); // Verified buildDate is not a verified publication date.
  assert.match(lock.sources[0].temporalCoverage, /2018/); assert.match(lock.sources[0].scenarioDateCaveat, /2020-01-01/);
  assert.match(lock.sources[0].license.name, /KOGL Type 1/); assert.match(fs.readFileSync(`${root}/citation-and-use.txt`, 'utf8'), /CC BY 4\.0/);
});
test('every real source feature, component, hole and coordinate is retained without guessed parent IDs', () => {
  const source = json(`${root}/source.geojson`), normalized = json('data/raw/prompt19/KOR/normalized-boundaries.geojson');
  assert.equal(source.features.length, 3504); assert.equal(normalized.features.length, source.features.length);
  assert.equal(new Set(normalized.features.map(f => f.properties.sourceFeatureId)).size, 3504);
  for (const [i, f] of source.features.entries()) {
    const candidate = normalized.features[i];
    assert.equal(f.properties.shapeGroup, 'KOR'); assert.equal(f.properties.shapeType, 'ADM3');
    assert.equal(candidate.properties.sourceFeatureId, f.properties.shapeID);
    assert.equal(candidate.properties.sourceParentId, null);
    assert.deepEqual(candidate.geometry, f.geometry);
  }
});
test('the actual source validity report passes and the immutable baseline inputs remain pinned', () => {
  const inspection = json('reports/verification/prompt19/KOR/source-inspection.json');
  assert.equal(inspection.sourceValidity.pass, true); assert.deepEqual(inspection.sourceValidity.errors, []);
  assert.deepEqual(inspection.totals, {features: 3504, components: 4767, holes: 10, vertices: 777212});
  const handoff = json('reports/maintenance/prompt19-handoff.json');
  for (const p of [handoff.baseline.artifactIndex, ...handoff.baseline.artifacts]) {
    const bytes = fs.readFileSync(p.path); assert.equal(sha(bytes), p.sha256); assert.equal(bytes.length, p.byteLength);
  }
});
test('actual source land contacts are positive, symmetric, and use known source IDs', () => {
  const report = json('reports/verification/prompt19/KOR/source-adjacency-verification.json');
  const bytes = fs.readFileSync(report.graph.path); assert.equal(sha(bytes), report.graph.sha256);
  const graph = JSON.parse(gunzipSync(bytes));
  const ids = new Set(json('data/raw/prompt19/KOR/normalized-boundaries.geojson').features.map(f => f.properties.sourceFeatureId));
  assert.equal(Object.keys(graph.adjacency).length, ids.size);
  for (const [id, neighbors] of Object.entries(graph.adjacency)) for (const n of neighbors) {
    assert.ok(ids.has(id) && ids.has(n) && n !== id); assert.ok(graph.adjacency[n].includes(id));
  }
  for (const e of graph.edges) {
    assert.ok(ids.has(e.leftSourceId) && ids.has(e.rightSourceId)); assert.ok(e.lengthKm > 0);
    assert.ok(e.geometry.coordinates.every(line => line.length === 2 && (line[0][0] !== line[1][0] || line[0][1] !== line[1][1])));
  }
  assert.equal(report.ambiguousSegments, 0);
  assert.equal(report.candidateCoverageOrTopologyPass, false);
});
test('the finer source supports partial ADM1 selection while the detached outline discrepancy remains explicit', () => {
  const precision = json('reports/verification/prompt19/KOR/parent-precision.json');
  const administrative = precision.parents.filter(p => p.kind === 'administrative');
  assert.equal(administrative.length, 17); assert.ok(administrative.every(p => p.distinctRealSourceFeatures > 1 && p.errors.length === 0));
  assert.ok(administrative.find(p => p.name === 'Sejong').distinctRealSourceFeatures > 1);
  const island = json('reports/verification/prompt19/KOR/boundary-evidence.json').detachedCoarseIsland;
  assert.equal(island.assignmentPerformed, false); assert.deepEqual(island.actualSourceIntersections, []);
});
test('the previous generator failure and alternative remain intact as historical evidence', () => {
  const history = json('reports/verification/prompt19/KOR/A-handoff.json');
  for (const path of ['reports/verification/prompt19/KOR/common-failure-sequence.json', 'reports/verification/prompt19/KOR/direct-overlay-investigation.json']) {
    const pin = history.evidenceFiles.find(p => p.path === path), bytes = fs.readFileSync(path);
    assert.ok(pin); assert.equal(bytes.length, pin.byteLength); assert.equal(sha(bytes), pin.sha256);
  }
  const sequence = json('reports/verification/prompt19/KOR/common-failure-sequence.json');
  assert.ok(sequence.failures.some(f => f.operation === 'intersection' && f.inputVertices === 70));
  assert.ok(sequence.failures.some(f => f.operation === 'union' && f.argumentCount > 4000));
  const alternative = json('reports/verification/prompt19/KOR/direct-overlay-investigation.json');
  assert.deepEqual(alternative.inputValidity, [true, true]); assert.equal(alternative.resultValid, true);
  assert.equal(alternative.appliedToSharedGenerator, false);
  assert.equal(history.countryCandidateReady, false);
  assert.equal(history.commonGeneratorFailure.officialCandidatePath, null);
});

test('the active mixed catalog uses the joined KOR candidate and keeps coarse residual provenance explicit', () => {
  const pointer = json('data/runtime/operational-catalog/current.json');
  const checked = (path, pin) => {const bytes = fs.readFileSync(path); assert.equal(bytes.length, pin.byteLength); assert.equal(sha(bytes), pin.sha256); return bytes;};
  const index = JSON.parse(checked(`${pointer.root}/artifact-index.json`, pointer.index));
  const packaged = file => JSON.parse(gunzipSync(checked(`${pointer.root}/${file}`, index.artifacts.find(a => a.path === file))));
  const rows = packaged('metadata/countries/KOR.json.gz').rows;
  const runtimeIds = new Set(rows.map(r => r[1]));
  const candidatesRoot = 'data/derived/prompt19/candidates/KOR';
  const candidates = fs.readdirSync(candidatesRoot, {withFileTypes: true}).filter(d => d.isDirectory() && /^joined-[a-f0-9]{20}$/.test(d.name)).flatMap(d => {
    const candidate = json(`${candidatesRoot}/${d.name}/cells.geojson`);
    if (candidate.features.length !== rows.length || candidate.features.some(f => !runtimeIds.has(globalCellId(f)))) return [];
    assert.equal(d.name, `joined-${sha(jsonBytes(candidate.features)).slice(0, 20)}`);
    return [{root: `${candidatesRoot}/${d.name}`, features: candidate.features}];
  });
  assert.equal(candidates.length, 1, 'One content-addressed joined candidate must match the active KOR catalog IDs');
  const candidate = candidates[0], verification = json(`${candidate.root}/verification.json`);
  const mixed = json('reports/maintenance/prompt19-C/mixed-verification.json');
  assert.equal(mixed.pass, true); assert.equal(mixed.catalogVersion, pointer.catalogVersion);
  assert.equal(mixed.unchangedCountries, 245);
  assert.equal(verification.countryId, 'KOR'); assert.equal(verification.worldCoverageComplete, true);
  assert.equal(verification.topology.pass, true); assert.equal(verification.topology.ambiguousSides, 0);
  assert.equal(verification.topology.unpairedInteriorBoundaries, 0); assert.equal(verification.topology.completeBoundaryCoverage, true);
  assert.equal(candidate.features.length, verification.summary.cells);
  const union = mixed.unionReports.find(r => r.countryId === 'KOR');
  assert.equal(union.cells, candidate.features.length); assert.equal(union.unionComponents, 53); assert.equal(union.unionHoles, 0);
  assert.ok(Math.abs(union.areaDifference) < 1e-11);
  assert.ok(mixed.renderedArea.length > 0 && mixed.renderedArea.every(r => r.interiorMissingSamples === 0));

  const provenance = JSON.parse(checked(`${pointer.root}/provenance.json`, index.artifacts.find(a => a.path === 'provenance.json')));
  const inputPin = provenance.inputs.find(input => input.sha256 === provenance.inputRoot);
  assert.ok(inputPin, 'The active package must pin its joint input');
  const input = JSON.parse(checked(inputPin.path, inputPin));
  assert.deepEqual(input.report.summary.find(summary => summary.countryId === 'KOR'), verification.summary);
  assert.deepEqual(input.report.sourceTrace.filter(trace => trace.countryId === 'KOR'), verification.sourceTrace);
  const locks = provenance.sourceLocks.filter(lock => lock.countryId === 'KOR');
  assert.equal(locks.length, 1, 'The active package must declare exactly one KOR source lock');
  const lock = prompt19SourceLockSchema.parse(locks[0]);
  const source = JSON.parse(checked(lock.normalizedInput.path, lock.normalizedInput)), knownSourceIds = new Set(source.features.map(f => f.properties.sourceFeatureId));
  const sourceById = new Map(source.features.map(f => [f.properties.sourceFeatureId, f]));
  const sourceInfo = new Map(lock.sources.map(source => [source.sourceId, source]));
  const parents = json('data/derived/prompt19/baseline-v1/coarse-parents.geojson').features.filter(f => f.properties.countryId === 'KOR');
  const parentById = new Map(parents.map(f => [f.properties.coarseTerritoryId, f]));
  const fine = candidate.features.filter(f => !f.properties.unresolvedFineSourceAssignment);
  const residual = candidate.features.filter(f => f.properties.unresolvedFineSourceAssignment);
  assert.ok(fine.length > parents.length);
  assert.equal(residual.length, verification.summary.coarseResidualCells);
  assert.ok(residual.length > 0); assert.equal(verification.fineAssignmentComplete, false);
  assert.deepEqual(verification.unresolvedFineSourceAssignment, residual.map(f => f.id));
  for (const f of candidate.features) {
    const p = f.properties, parent = parentById.get(p.coarseParentTerritoryId);
    assert.equal(f.id, p.localId); assert.equal(p.countryId, 'KOR'); assert.ok(parent);
    assert.equal(p.administrativeParentKey, parent.properties.parentKey);
    if (p.unresolvedFineSourceAssignment) {
      assert.equal(p.sourceId, 'canonical-country-p0'); assert.equal(p.adminLevel, null);
      assert.equal(p.fineSourceIdentity, null); assert.equal(p.sourceVersion, null);
      assert.ok(['canonical-country-residual', 'canonical-country-component'].includes(p.boundaryBasis));
    } else {
      const info = sourceInfo.get(p.sourceId);
      assert.ok(info); assert.equal(p.sourceVersion, info.version);
      assert.equal(p.boundaryBasis, info.boundaryBasis); assert.equal(p.adminLevel, info.adminLevel);
      assert.ok(knownSourceIds.has(p.sourceFeatureId));
      assert.equal(p.sourceParentId, sourceById.get(p.sourceFeatureId).properties.sourceParentId);
      assert.deepEqual(p.fineSourceIdentity, {sourceId: p.sourceId, sourceFeatureId: p.sourceFeatureId});
    }
  }
  const partialParents = parents.filter(f => f.properties.kind === 'administrative').filter(parent => {
    const members = fine.filter(f => f.properties.coarseParentTerritoryId === parent.properties.coarseTerritoryId);
    return new Set(members.map(f => f.properties.sourceFeatureId)).size > 1;
  });
  assert.ok(partialParents.length > 0, 'The active source must support partial ADM1 selection without inventing subunits in single-district parents');

  // Every source component needs exactly one trace, including components outside the game envelope.
  const componentKeys = new Set(source.features.flatMap(f => polygons(f.geometry).map((_, i) => `${f.properties.sourceFeatureId}:${i}`)));
  const tracedKeys = new Set();
  const tracesBySource = new Map();
  for (const trace of verification.sourceTrace) {
    assert.equal(trace.countryId, 'KOR'); assert.ok(knownSourceIds.has(trace.sourceFeatureId));
    const key = `${trace.sourceFeatureId}:${trace.componentIndex}`;
    assert.ok(componentKeys.has(key)); assert.ok(!tracedKeys.has(key)); tracedKeys.add(key);
    const traces = tracesBySource.get(trace.sourceFeatureId) ?? []; traces.push(trace); tracesBySource.set(trace.sourceFeatureId, traces);
    assert.equal(trace.disposition, trace.represented ? 'represented-inside-fixed-envelope' : 'source-outside-fixed-envelope');
  }
  assert.deepEqual(tracedKeys, componentKeys); assert.equal(tracesBySource.size, knownSourceIds.size);
  const excludedIds = new Set([...tracesBySource].filter(([, traces]) => traces.every(t => !t.represented)).map(([id]) => id));
  assert.ok(fine.every(f => !excludedIds.has(f.properties.sourceFeatureId)));
  if (lock.sources[0].sourceId === 'geoboundaries-gbOpen-KOR-ADM3-2018') {
    // Keep the old ADM3-specific evidence when auditing that historical active package.
    const precision = json('reports/verification/prompt19/KOR/parent-precision.json');
    const insideIds = new Set(precision.parents.flatMap(p => p.sources.map(s => s.sourceFeatureId)));
    const outsideIds = new Set([...knownSourceIds].filter(id => !insideIds.has(id)));
    assert.equal(outsideIds.size, 26); assert.equal(verification.sourceTrace.length, 4767);
    assert.deepEqual(excludedIds, outsideIds);
    const island = json('reports/verification/prompt19/KOR/boundary-evidence.json').detachedCoarseIsland;
    const retainedIsland = residual.filter(f => f.properties.coarseParentTerritoryId === island.coarseTerritoryId);
    assert.equal(retainedIsland.length, 1);
    assert.deepEqual(normalizeGeometry(retainedIsland[0].geometry), normalizeGeometry(parentById.get(island.coarseTerritoryId).geometry));
  }

  const geometryByOrdinal = new Map(packaged('detail/countries/KOR.geojson.gz').features.map(f => [f.id, f.geometry]));
  const geometryById = new Map(rows.map(r => [r[1], geometryByOrdinal.get(r[0])]));
  for (const f of candidate.features) assert.deepEqual(geometryById.get(globalCellId(f)), f.geometry);
});
