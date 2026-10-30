import fs from 'node:fs';
import {createHash} from 'node:crypto';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const pin = path => {const bytes = fs.readFileSync(path); return {path, sha256: digest(bytes), byteLength: bytes.length};};
const read = (path, expected) => {
  const p = pin(path);
  if (expected && p.sha256 !== expected) throw Error(`MEASUREMENT_PIN_MISMATCH:${path}`);
  return {pin: p, data: JSON.parse(fs.readFileSync(path, 'utf8'))};
};
const baseline = read('reports/chn-2020/baseline-play-performance.json', 'aeb6f3364493b49be153267c3672b08d7920b2d804739b881220408bebc9c9c8');
const candidate = read('reports/chn-2020/candidate-play-performance.json', 'ae505417d44c2268a375a512de2b44e39ed9fb6b24c8f6ab6dd166b09c4c134c');
const before = baseline.data, after = candidate.data;
if (!after.pass || after.turns.length !== 2 || !after.turns.every(t => t.secondActualTurn?.pass)) throw Error('FINAL_TWO_TURN_PROOF_REQUIRED');
const summary = values => ({samples: values, minimum: Math.min(...values), maximum: Math.max(...values), mean: values.reduce((a, b) => a + b, 0) / values.length});
const change = (a, b) => ({before: a, after: b, delta: b - a, ratio: a ? b / a : null});
const keys = (record, other) => Object.fromEntries(Object.keys(record).map(key => [key, change(record[key], other[key])]));
const beforeTurn = before.turns.find(t => t.actor === 'CHN' && t.target === 'PRK');
const afterTurn = after.turns.find(t => t.actor === 'CHN' && t.target === 'PRK');
const beforeEntry = before.gameplay.find(t => t.actor === 'CHN' && t.target === 'PRK');
const afterEntry = after.gameplay.find(t => t.actor === 'CHN' && t.target === 'PRK');
const report = {
  schemaVersion: 'chn-2020-performance-comparison-v1',
  candidateVerificationPass: after.pass,
  before: baseline.pin, after: candidate.pin,
  originalRuntimeProvenance: pin('reports/chn-2020/baseline-performance-provenance.json'),
  method: {
    cold: 'Fresh Vitest process and module caches; operating-system page cache was not flushed.',
    warm: 'Five repeated operations in the same process, with immutable metadata caches retained.',
    isolation: 'Root held heavy delivery and build work during the final candidate measurement.',
    limitations: ['One cold sample per recorded run; timings are observations, not a statistical regression threshold.',
      'Garbage collection was not forced; process memory includes Vite and runtime caches.',
      'Candidate after-turn memory includes two additional genuine followup commits; baseline has one actual commit.',
      'Total artifact bytes describe the immutable package, not the bytes transferred by one map view. Browser transfer evidence is separate.',
      'PRK-to-CHN had no successful coarse baseline, so its new north-direction route has no comparable baseline turn timing.'],
  },
  counts: keys(before.counts, after.counts),
  countryCells: keys(before.countryCells, after.countryCells),
  initialization: Object.fromEntries(Object.keys(before.initialization).filter(k => !Array.isArray(before.initialization[k])).map(k => [k, change(before.initialization[k], after.initialization[k])])),
  newGameWarmMs: {before: summary(before.initialization.newGameWarmMs), after: summary(after.initialization.newGameWarmMs)},
  bytes: keys(before.bytes, after.bytes),
  memory: {before: before.memory, after: after.memory,
    initializationRssIncrease: change(before.memory.afterInitialization.rss - before.memory.before.rss, after.memory.afterInitialization.rss - after.memory.before.rss),
    initializationHeapIncrease: change(before.memory.afterInitialization.heapUsed - before.memory.before.heapUsed, after.memory.afterInitialization.heapUsed - after.memory.before.heapUsed)},
  matchedCHNtoPRK: {
    sameFirstCellIds: JSON.stringify(beforeEntry.first.ids) === JSON.stringify(afterEntry.first.ids),
    sameCentroidDistanceMetrics: ['maximumGraphDepthKm', 'maximumForwardDepthKm', 'maximumLateralKm', 'maximumCellDiameterKm'].every(k => beforeEntry.first.metrics[k] === afterEntry.first.metrics[k]),
    firstTurn: Object.fromEntries(['contextMs', 'providerMs', 'planMs', 'commitMs'].map(k => [k, change(beforeTurn[k], afterTurn[k])])),
    warmPlanMs: {before: summary(beforeTurn.warmTurnSamples.map(t => t.planMs)), after: summary(afterTurn.warmTurnSamples.map(t => t.planMs))},
    warmCommitMs: {before: summary(beforeTurn.warmTurnSamples.map(t => t.commitMs)), after: summary(afterTurn.warmTurnSamples.map(t => t.commitMs))},
  },
  actualTwoTurnChecks: after.turns.map(t => ({actor: t.actor, target: t.target, direction: t.direction, actionText: t.actionText,
    authorityCells: t.authorityCells, initialAuthorityUnchanged: t.secondActualTurn.initialAuthorityUnchanged,
    firstChangedCells: t.changedCells, followupChangedCells: t.secondActualTurn.changedIds.length,
    followupBaseWorldRevision: t.secondActualTurn.baseWorldRevision, followupCommittedWorldRevision: t.secondActualTurn.committedWorldRevision})),
  defaultCountyGranularityLimitation: {
    diagnosis: pin('reports/chn-2020/frontier-seed-diagnosis.json'),
    failedBeforeSeedGuard: pin('reports/chn-2020/candidate-initial-failed-play-performance.json'),
    failedDefaultFollowup: pin('reports/chn-2020/candidate-area-guard-failed-play-performance.json'),
    explanation: 'The default PRK-to-CHN first entry is 2270.52 km2 but both adjacent unoccupied county cells exceed the unchanged 2800 km2 near limit. Supported north requests instead select a 779.58 km2 entry and a connected 1734.85 km2 followup. No distance, width, area, parent, lookup, or authority cap was raised.',
  },
  comparisonCode: pin('scripts/chn-2020/compare-performance.mjs'),
};
fs.writeFileSync('reports/chn-2020/performance-comparison.json', `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({before: baseline.pin.sha256, after: candidate.pin.sha256, newGameColdMs: report.initialization.newGameColdMs,
  bytes: report.bytes.total, actualTwoTurnChecks: report.actualTwoTurnChecks}));
