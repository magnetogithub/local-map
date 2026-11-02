// @vitest-environment node
// Optional real-package transport probe. No generated fixture, HTTP server, AI
// transport, active-pointer mutation or browser is involved in this measurement.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {expect, it} from 'vitest';
import {loadOperationalVectorDelivery} from '../../src/lib/map/operational-vector-delivery';
import type {CatalogFetch} from '../../src/lib/map/catalog-vector-delivery';

const pointerFile = process.env.CHN_CATALOG_POINTER;
const test = pointerFile ? it : it.skip;
test('measures one real changed CHN cell against explicit full-country detail', async () => {
  const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
  const pointerBytes = fs.readFileSync(pointerFile!), pointer = JSON.parse(pointerBytes.toString('utf8'));
  const indexBytes = fs.readFileSync(`${pointer.root}/artifact-index.json`);expect(sha(indexBytes)).toBe(pointer.index.sha256);expect(indexBytes.length).toBe(pointer.index.byteLength);
  const index = JSON.parse(indexBytes) as {artifacts: {path: string; sha256: string; byteLength: number}[]};
  const artifacts = new Map(index.artifacts.map(a => [a.path, a]));
  const checked = (file: string) => {const a = artifacts.get(file);if (!a) throw Error(`UNINDEXED:${file}`);const bytes = fs.readFileSync(path.join(pointer.root, file));expect(sha(bytes)).toBe(a.sha256);expect(bytes.length).toBe(a.byteLength);return bytes;};
  const descriptor = JSON.parse(checked('catalog.json').toString('utf8'));
  const detailIndex = JSON.parse(checked('detail-index.json').toString('utf8')) as {cellDetails?: {countryId: string; cellOrdinals: number[]; artifact: {path: string; byteLength: number}}[]};
  expect(detailIndex.cellDetails?.some(s => s.countryId === 'CHN')).toBe(true);
  const base = `/data/territory-catalog/${pointer.catalogVersion}/`;
  const identity = (file: string) => ({...artifacts.get(file)!, path: base + file});
  const bootstrap = {schemaVersion: 'operational-map-bootstrap-v1', catalog: descriptor, manifest: identity('manifest.json'), tileIndex: identity('tile-index.json'), detailIndex: identity('detail-index.json'), parents: identity('metadata/parents.json.gz'), coverage: identity('lod-coverage.json.gz')};
  const requests: {path: string; bytes: number; readMs: number}[] = [];
  const fetcher: CatalogFetch = async file => {if (!file.startsWith(base)) throw Error(`NONLOCAL_REQUEST:${file}`);const began = performance.now(), bytes = checked(file.slice(base.length));requests.push({path: file.slice(base.length), bytes: bytes.length, readMs: performance.now() - began});return new Response(new Uint8Array(bytes));};
  const timed = async <T,>(fn: () => Promise<T>) => {const began = performance.now(), value = await fn();return {value, ms: performance.now() - began};};
  const initialized = await timed(() => loadOperationalVectorDelivery(bootstrap, descriptor.catalogRef, fetcher)), delivery = initialized.value;
  const chn = await delivery.loadCountry('CHN'), prk = await delivery.loadCountry('PRK'), chnOrdinals = new Set(chn.map(c => c.ordinal)), prkOrdinals = new Set(prk.map(c => c.ordinal));
  let selectedOrdinal: number | null = null;
  for (let n = 1; n <= descriptor.counts.edges; n++) {const edge = delivery.edgeIncidence(n);if (chnOrdinals.has(edge.left) && prkOrdinals.has(edge.right)) {selectedOrdinal = edge.left;break;}if (chnOrdinals.has(edge.right) && prkOrdinals.has(edge.left)) {selectedOrdinal = edge.right;break;}}
  expect(selectedOrdinal).not.toBeNull();const cell = chn.find(c => c.ordinal === selectedOrdinal)!;
  const requestStart = requests.length, memoryBefore = process.memoryUsage(), cold = await timed(() => delivery.loadCellDetail([cell]));
  expect(cold.value.features.map(f => f.id)).toEqual([cell.ordinal]);
  const coldRequests = requests.slice(requestStart);expect(coldRequests.length).toBeGreaterThan(0);expect(coldRequests.every(r => r.path.startsWith('detail/cells/CHN/'))).toBe(true);expect(coldRequests.some(r => r.path === 'detail/countries/CHN.geojson.gz')).toBe(false);
  const beforeWarm = requests.length, warmSamples = [];
  for (let i = 0; i < 5; i++) {const sample = await timed(() => delivery.loadCellDetail([cell]));expect(sample.value.features).toEqual(cold.value.features);warmSamples.push(sample.ms);}
  expect(requests.length).toBe(beforeWarm);const afterSmall = process.memoryUsage(), smallCounters = delivery.counters();
  const fullInitialized = await timed(() => loadOperationalVectorDelivery(bootstrap, descriptor.catalogRef, fetcher)), fullDelivery = fullInitialized.value;
  const fullRequestStart = requests.length, full = await timed(() => fullDelivery.loadCountryDetail('CHN'));
  expect(full.value.features.length).toBe(chn.length);expect(full.value.features.find(f => f.id === cell.ordinal)).toEqual(cold.value.features[0]);
  const fullRequests = requests.slice(fullRequestStart);expect(fullRequests.some(r => r.path === 'detail/countries/CHN.geojson.gz')).toBe(true);
  const indexedShard = detailIndex.cellDetails!.find(s => s.countryId === 'CHN' && s.cellOrdinals.includes(cell.ordinal))!;
  const report = {schemaVersion: 'chn-2020-cell-detail-performance-v1',pass: true,pointer: {path: pointerFile,sha256: sha(pointerBytes),byteLength: pointerBytes.length,...pointer},
    conditions: {mode: 'actual immutable package through production vector loader and checked local-file fetch adapter',cold: 'fresh vector delivery byte cache; metadata initialized; OS file cache not flushed',warm: 'five repeated same-cell detail loads from the bounded decoded-byte LRU',full: 'separate fresh vector delivery; explicit whole CHN selection measured separately',timingScope: 'includes byte verification/read, gzip decode, JSON/schema validation and returned geometry; local read time reported within each request',externalAiCalls: 0},
    counts: descriptor.counts,chnCells: chn.length,cell: {id: cell.id,ordinal: cell.ordinal,sourceCountryId: cell.sourceCountryId,shard: indexedShard},initializationMs: initialized.ms,
    changedCell: {coldMs: cold.ms,warmMs: warmSamples,coldRequests,coldLocalReadAndDigestMs: coldRequests.reduce((n,r) => n + r.readMs,0),coldVerificationDecodeParseSelectionMs: Math.max(0,cold.ms-coldRequests.reduce((n,r) => n + r.readMs,0)),coldCompressedBytes: coldRequests.reduce((n,r) => n + r.bytes,0),selectedDecodedJsonBytes: Buffer.byteLength(JSON.stringify(cold.value)),cache: smallCounters,wholeCountryRequested: false},
    fullCountry: {initializationMs: fullInitialized.ms,selectionMs: full.ms,requests: fullRequests,localReadAndDigestMs: fullRequests.reduce((n,r) => n + r.readMs,0),verificationDecodeParseSelectionMs: Math.max(0,full.ms-fullRequests.reduce((n,r) => n + r.readMs,0)),compressedBytes: fullRequests.reduce((n,r) => n + r.bytes,0),decodedJsonBytes: Buffer.byteLength(JSON.stringify(full.value)),cache: fullDelivery.counters()},memory: {before: memoryBefore,afterSmall,afterFull: process.memoryUsage()}};
  const phase = process.env.CHN_VERIFY_PHASE || 'candidate';if (!/^[a-z0-9-]+$/.test(phase)) throw Error('UNSAFE_PHASE');
  const output = `reports/chn-2020/${phase}-cell-detail-performance.json`;fs.mkdirSync(path.dirname(output),{recursive:true});fs.writeFileSync(output,`${JSON.stringify(report,null,2)}\n`);
  console.log(JSON.stringify({pass:true,output,chnCells:chn.length,changedCellColdMs:cold.ms,changedCellWarmMs:warmSamples,changedCellCompressedBytes:report.changedCell.coldCompressedBytes,fullSelectionMs:full.ms,fullCompressedBytes:report.fullCountry.compressedBytes}));
}, 180_000);
