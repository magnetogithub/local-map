// Capacity-only fixtures. These are ID/state records, never geographical cells
// or a substitute for any country's administrative boundary source.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {gzipSync} from 'node:zlib';
import {spawnSync} from 'node:child_process';
import {performance} from 'node:perf_hooks';
import {fileURLToPath} from 'node:url';

const self = fileURLToPath(import.meta.url), digest = value => createHash('sha256').update(value).digest('hex');
const pin = file => {const bytes = fs.readFileSync(file); return {path: path.relative(process.cwd(), file).replaceAll('\\', '/'), sha256: digest(bytes), byteLength: bytes.length};};
const measure = (fn, count = 5) => {
  const samplesMs = []; let value;
  for (let i = 0; i < count; i++) {const start = performance.now(); value = fn(); samplesMs.push(performance.now() - start);}
  const ordered = [...samplesMs].sort((a, b) => a - b);
  return {value, timing: {samplesMs, minimumMs: ordered[0], medianMs: ordered[Math.floor(ordered.length / 2)], maximumMs: ordered.at(-1)}};
};
const workerAt = process.argv.indexOf('--worker');
if (workerAt >= 0) {
  const count = Number(process.argv[workerAt + 1]);
  if (![10000, 50000, 100000, 250000].includes(count) || !global.gc) throw Error('BOUNDED_WORKER_WITH_EXPOSE_GC_REQUIRED');
  global.gc(); const memoryBefore = process.memoryUsage(), constructionStart = performance.now();
  const ids = Array.from({length: count}, (_, i) => `territory:catalog:${digest(`capacity-only-not-geography:${i}`)}`).sort();
  const mutable = {};
  for (let i = 0; i < count; i++) {
    const sourceCountryId = i < 3320 ? 'CHN' : i < 3514 ? 'PRK' : 'OTHER';
    mutable[ids[i]] = Object.freeze({id: ids[i], sourceCountryId, ownerCountryId: sourceCountryId, controllerCountryId: sourceCountryId});
  }
  const record = Object.freeze(mutable), constructionMs = performance.now() - constructionStart;
  global.gc(); const memoryBuilt = process.memoryUsage();
  const copy = measure(() => Object.freeze({...record, [ids[0]]: Object.freeze({...record[ids[0]], controllerCountryId: 'PRK'})}));
  const copied = copy.value; copy.value = undefined;
  global.gc(); const memoryWithOneRetainedCopy = process.memoryUsage();
  const eligibility = measure(() => {
    let eligible = 0, actorPresent = false, targetPresent = false;
    for (const id of Object.keys(record)) {
      const c = record[id]; actorPresent ||= c.ownerCountryId === 'PRK' || c.controllerCountryId === 'PRK';
      targetPresent ||= c.ownerCountryId === 'CHN' || c.controllerCountryId === 'CHN';
      if (c.ownerCountryId === 'CHN' && c.controllerCountryId === 'CHN') eligible++;
    }
    if (!actorPresent || !targetPresent || eligible !== 3320) throw Error('ELIGIBILITY_FIXTURE_INVALID');
    return eligible;
  });
  const delta = measure(() => {
    let changed = 0;
    for (const id of Object.keys(copied)) {
      const a = record[id], b = copied[id];
      if (!a || a.id !== b.id || a.sourceCountryId !== b.sourceCountryId) throw Error('IDENTITY_MISMATCH');
      if (a.ownerCountryId !== b.ownerCountryId || a.controllerCountryId !== b.controllerCountryId) changed++;
    }
    if (changed !== 1) throw Error('DELTA_FIXTURE_INVALID'); return changed;
  });
  const root = measure(() => {
    // A lower-bound analogue of the current all-leaf root rebuild: already
    // cached leaf identities, sorted entries, JSON encoding and SHA-256 only.
    // It excludes production canonical validation and changed-leaf hashing.
    const leaves = Object.entries(copied).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([id]) => [id, id.slice('territory:catalog:'.length)]);
    return digest(JSON.stringify({namespace: 'capacity-only-domain-root', domain: 'territories', leaves}));
  }, 3);
  const idJson = measure(() => JSON.stringify(ids), 3), idBytes = Buffer.byteLength(idJson.value), idGzipBytes = gzipSync(idJson.value).length;
  idJson.value = undefined;
  const stateJson = measure(() => JSON.stringify(copied), 3), stateJsonBytes = Buffer.byteLength(stateJson.value); stateJson.value = undefined;
  const result = {count, source: 'deterministic synthetic metadata; CHN3320/PRK194/OTHER remainder; no coordinates, geometry, real source hierarchy or authority claims',
    constructionMs, retainedStateHeapBytes: memoryBuilt.heapUsed - memoryBefore.heapUsed,
    retainedAdditionalFullMapCopyHeapBytes: memoryWithOneRetainedCopy.heapUsed - memoryBuilt.heapUsed,
    memory: {before: memoryBefore, built: memoryBuilt, withOneRetainedCopy: memoryWithOneRetainedCopy, afterOperations: process.memoryUsage()},
    timings: {fullRecordCopyOneChangedCell: copy.timing, globalFrontierEligibilityPrefix: eligibility.timing, globalOneCellDeltaScan: delta.timing,
      cachedLeafRootSortEncodeShaLowerBound: root.timing, fullIdOrderJsonEncode: idJson.timing, fullStateRecordJsonEncode: stateJson.timing},
    byteSizes: {fullIdOrderJson: idBytes, fullIdOrderGzip: idGzipBytes, fullStateRecordJson: stateJsonBytes,
      sourceOwnerControllerUint16ColumnsOnly: count * 6}, invariants: {changedCells: delta.value, eligibleCells: eligibility.value, hashLength: root.value.length}};
  console.log(JSON.stringify(result));
} else {
  const scenarios = [];
  for (const count of [10000, 50000, 100000, 250000]) {
    const child = spawnSync(process.execPath, ['--expose-gc', self, '--worker', String(count)], {cwd: process.cwd(), encoding: 'utf8', timeout: 120000, maxBuffer: 4 * 1024 * 1024});
    if (child.status !== 0) throw Error(`CAPACITY_WORKER_FAILED:${count}:${child.stderr || child.error || child.status}`);
    scenarios.push(JSON.parse(child.stdout));
  }
  const report = {schemaVersion: 'world-micro-metadata-capacity-v1', createdAt: new Date().toISOString(), code: pin(self),
    measured: true, geographicBenchmark: false, productionGameBenchmark: false,
    environment: {node: process.version, platform: process.platform, arch: process.arch, cpuModel: os.cpus()[0]?.model,
      logicalProcessors: os.cpus().length, hostMemoryBytes: os.totalmem(), worker: 'fresh sequential Node process per size; --expose-gc, explicit GC outside timing series'},
    limitations: ['Algorithms mirror selected current JS data-structure costs; they do not call the full production game or validators.',
      'No geometry, real spatial adjacency, rendering, browser, network, AI provider, revision checking or military constraints are benchmarked.',
      'Global eligibility measures only the all-world prefix; actual target adjacency and traversal add work.',
      'Already sorted IDs and cached synthetic leaf identities make root rebuilding a lower-bound analogue, not the production canonical serializer.',
      'Three or five within-process samples characterize this host only; GC/JIT/cache effects remain and no concurrent-work exclusion is asserted.',
      '500k is deliberately not allocated or benchmarked. Any 500k planning figures elsewhere are extrapolations.'], scenarios};
  const output = path.join(path.dirname(self), 'metadata-capacity.json'); fs.writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({output: pin(output), scenarios: scenarios.map(s => ({count: s.count, retainedStateHeapBytes: s.retainedStateHeapBytes,
    copyMedianMs: s.timings.fullRecordCopyOneChangedCell.medianMs, deltaMedianMs: s.timings.globalOneCellDeltaScan.medianMs,
    rootLowerBoundMedianMs: s.timings.cachedLeafRootSortEncodeShaLowerBound.medianMs}))}));
}
