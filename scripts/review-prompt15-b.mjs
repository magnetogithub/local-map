// Read-only artifact verification for an existing checkpoint B experiment.
import fs from 'node:fs';
import path from 'node:path';
import {CELL_EXPERIMENT_POLICY as P} from './prompt15-cell-policy.mjs';
import {fileIdentity, readJSON, physicalMetrics} from './prompt15-cell-core.mjs';
import {digest, jsonBytes} from './prompt14-catalog-core.mjs';

const dir = 'reports/prompt15';
const failures = [];
const check = (condition, reason) => { if (!condition) failures.push(reason); };
const verify = expected => {
  const actual = fileIdentity(expected.path);
  check(actual.sha256 === expected.sha256 && actual.byteLength === expected.byteLength, `Changed bytes: ${expected.path}`);
};
const connected = (ids, adjacency) => {
  if (!ids.length) return false;
  const allowed = new Set(ids), reached = new Set([ids[0]]), queue = [ids[0]];
  while (queue.length) for (const id of adjacency[queue.pop()] ?? []) {
    if (allowed.has(id) && !reached.has(id)) { reached.add(id); queue.push(id); }
  }
  return reached.size === allowed.size;
};
const decision = readJSON(`${dir}/15-03-policy-decision.json`);
const review = readJSON(`${dir}/15-REVIEW-B.json`);
const validation = readJSON(`${dir}/15-03-validation.json`);
check(fs.readFileSync(`${dir}/15-03-predeclared-policy.json`).equals(jsonBytes(P)), 'Predeclared policy changed');
check(review.status === 'pass' && decision.status === 'pass' && validation.status === 'pass', 'Checkpoint or validation failed');
verify(review.checkpoint);
verify(review.validation);
for (const input of decision.inputs) verify(input);
for (const input of readJSON(`${dir}/15-03-start-snapshot.json`).inputs) verify(input);
for (const input of readJSON(`${dir}/15-03-validation-inputs.json`)) verify(input);
const selected = decision.comparisons.find(c => c.candidate.id === decision.selectedCandidate);
check(selected.allSampleChecksPassed && Object.values(selected.worldProjection.budgetChecks).every(Boolean), 'Selected candidate failed resource or sample gates');
for (const [key, value] of Object.entries(selected.worldProjection.costs)) check(value <= P.budgets[key], `World estimate over budget: ${key}`);
const countries = [];
let tileFiles = 0;
for (const country of P.representativeCountries) {
  const prefix = `${dir}/cell-experiments/${decision.selectedCandidate}/${country}`;
  const first = readJSON(`${prefix}/first/summary.json`), second = readJSON(`${prefix}/second/summary.json`);
  for (const run of ['first', 'second']) {
    const base = `${prefix}/${run}`, summary = readJSON(`${base}/summary.json`);
    check(summary.status === 'pass' && Object.values(summary.checks).every(Boolean), `${country}/${run}: sample failed`);
    for (const artifact of summary.artifacts) verify(artifact);
    const render = readJSON(`${base}/render-index.json`);
    for (const tile of render.tiles) { verify(tile); tileFiles++; }
    const normalized = render.tiles.map(t => ({...fileIdentity(t.path), path: path.relative(base, t.path).split(path.sep).join('/')}));
    check(digest(jsonBytes(normalized)) === summary.deterministicRoots.render, `${country}/${run}: PBF root mismatch`);
  }
  check(JSON.stringify(first.deterministicRoots) === JSON.stringify(second.deterministicRoots), `${country}: independent roots differ`);
  for (const name of ['geometry.geojson', 'topology.json', 'membership.json', 'cell-measurements.json']) {
    check(fs.readFileSync(`${prefix}/first/${name}`).equals(fs.readFileSync(`${prefix}/second/${name}`)), `${country}: independent ${name} differs`);
  }
  const cells = readJSON(`${prefix}/first/cell-measurements.json`), byId = new Map(cells.map(c => [c.id, c]));
  const members = readJSON(`${prefix}/first/membership.json`), topology = readJSON(`${prefix}/first/topology.json`);
  check(new Set(members.flatMap(p => p.cellIds)).size === cells.length && members.reduce((n, p) => n + p.cellIds.length, 0) === cells.length, `${country}: membership is not a partition`);
  for (const feature of readJSON(`${prefix}/first/geometry.geojson`).features) {
    const m = physicalMetrics(feature.geometry), saved = byId.get(feature.properties.territoryId);
    check(!!saved && Math.abs(saved.areaKm2 - m.areaKm2) < 1e-7 && Math.abs(saved.diameterUpperBoundKm - m.diameterUpperBoundKm) < 1e-7, `${country}: saved physical measurement mismatch`);
    check(m.areaKm2 <= P.interiorMaximumAreaKm2 && m.diameterUpperBoundKm <= P.interiorMaximumDiameterKm, `${country}: interior resolution failed`);
  }
  for (const id of first.behavior.frontierCellIds) {
    const c = byId.get(id);
    check(c.areaKm2 <= P.boundaryMaximumAreaKm2 && c.diameterUpperBoundKm <= P.boundaryMaximumDiameterKm, `${country}: border resolution failed`);
  }
  for (const scenario of first.behavior.scenarios) {
    const near = scenario.ranges.near;
    check(near.ids.every(id => byId.has(id)), `${country}: unknown selection ID`);
    if (near.status === 'pass') {
      check(connected(near.ids, topology.adjacency), `${country}: disconnected near selection`);
      check(near.ids.length <= P.lookupCap && near.areaKm2 <= P.ranges.near.maximumAreaKm2, `${country}: near cap exceeded`);
    }
    for (const parent of near.parentAreaFractions ?? []) if (parent.parentAreaKm2 >= P.sufficientlyLargeAdministrativeAreaKm2) {
      check(parent.occupiedAreaKm2 / parent.parentAreaKm2 <= P.nearMaximumParentAreaFraction, `${country}: near occupies too much of parent`);
    }
    if (scenario.kind === 'national-frontier') {
      const occupied = new Set(near.ids);
      check(connected(scenario.second.ids, topology.adjacency) && scenario.second.ids.every(id => !occupied.has(id)), `${country}: second advance is disconnected or repeats cells`);
      check(scenario.second.ids.some(id => topology.adjacency[id].some(n => occupied.has(n))), `${country}: second advance does not touch current front`);
    }
  }
  countries.push({country, cells: cells.length, parents: members.length, summary: fileIdentity(`${prefix}/first/summary.json`)});
}
const result = {review: 'B', status: failures.length ? 'fail' : 'pass', command: 'node scripts/review-prompt15-b.mjs', tools: {node: process.version}, selectedCandidate: decision.selectedCandidate,
  inputs: [fileIdentity('scripts/review-prompt15-b.mjs'), fileIdentity(`${dir}/15-03-policy-decision.json`), fileIdentity(`${dir}/15-03-validation.json`)], countries, verifiedTileFiles: tileFiles, failures,
  scope: 'Independent current-byte and graph recheck of existing offline samples. World costs are projections; runtime, API, migration and global generation are deferred.', resumeAt: failures.length ? '15-3' : '15-4'};
fs.writeFileSync(`${dir}/15-review-b-recheck.json`, jsonBytes(result));
review.independentRecheck = fileIdentity(`${dir}/15-review-b-recheck.json`);
review.status = result.status;
review.resumeAt = result.resumeAt;
fs.writeFileSync(`${dir}/15-REVIEW-B.json`, jsonBytes(review));
console.log(JSON.stringify({status: result.status, countries: countries.length, verifiedTileFiles: tileFiles, failures}));
if (failures.length) process.exitCode = 1;
