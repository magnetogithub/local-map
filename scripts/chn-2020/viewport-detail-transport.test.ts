// @vitest-environment node
// Opt-in probe of the actual immutable package, without HTTP, browser or AI.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {expect, it} from 'vitest';
import {loadOperationalVectorDelivery, type OperationalViewportBounds} from '../../src/lib/map/operational-vector-delivery';
import type {CatalogFetch} from '../../src/lib/map/catalog-vector-delivery';

const pointerFile = process.env.CHN_CATALOG_POINTER;
(pointerFile ? it : it.skip)('measures bounded actual CHN viewport cells and exact incidence edges', async () => {
  const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
  const pointerBytes = fs.readFileSync(pointerFile!), pointer = JSON.parse(pointerBytes.toString('utf8'));
  const indexBytes = fs.readFileSync(path.join(pointer.root, 'artifact-index.json'));
  expect(sha(indexBytes)).toBe(pointer.index.sha256);expect(indexBytes.length).toBe(pointer.index.byteLength);
  const index = JSON.parse(indexBytes), artifacts = new Map<string, {path: string; sha256: string; byteLength: number}>(index.artifacts.map((a: {path: string}) => [a.path, a]));
  const checked = (file: string) => {
    const pin = artifacts.get(file);if (!pin) throw Error('UNINDEXED_VIEWPORT_ASSET');
    const bytes = fs.readFileSync(path.join(pointer.root, file));expect(sha(bytes)).toBe(pin.sha256);expect(bytes.length).toBe(pin.byteLength);return bytes;
  };
  const descriptor = JSON.parse(checked('catalog.json').toString('utf8')), base = `/data/territory-catalog/${pointer.catalogVersion}/`;
  const identity = (file: string) => ({...artifacts.get(file)!, path: base + file});
  const bootstrap = {schemaVersion: 'operational-map-bootstrap-v1', catalog: descriptor, manifest: identity('manifest.json'), tileIndex: identity('tile-index.json'), detailIndex: identity('detail-index.json'), parents: identity('metadata/parents.json.gz'), coverage: identity('lod-coverage.json.gz')};
  const requests: {path: string; bytes: number}[] = [];
  const fetcher: CatalogFetch = async (file, init) => {
    init?.signal?.throwIfAborted();if (!file.startsWith(base)) throw Error('NONLOCAL_VIEWPORT_ASSET');
    const relative = file.slice(base.length), bytes = checked(relative);requests.push({path: relative, bytes: bytes.length});return new Response(new Uint8Array(bytes));
  };
  const results = [];
  for (const [name, bounds] of [
    ['chn-prk', [124.1, 39.9, 124.6, 40.4]], ['shanghai', [121.2, 31, 121.7, 31.4]],
    ['hainan', [109.2, 18.1, 109.8, 18.6]], ['west', [79.7, 35, 80.3, 35.5]],
  ] as readonly (readonly [string, OperationalViewportBounds])[]) {
    const delivery = await loadOperationalVectorDelivery(bootstrap, descriptor.catalogRef, fetcher), startRequests = requests.length;
    const began = performance.now(), cold = await delivery.loadCountryViewportDetail('CHN', bounds), coldMs = performance.now() - began;
    const coldRequests = requests.slice(startRequests), cellIds = cold.cells.features.map(f => Number(f.id));
    expect(cellIds.length).toBeGreaterThan(0);expect(cellIds.length).toBeLessThan(3320);
    expect(new Set(cellIds).size).toBe(cellIds.length);expect(cold.edges.map(e => e.ordinal)).toEqual(delivery.incidentEdges(cellIds));
    expect(coldRequests.some(r => r.path.startsWith('detail/cells/CHN/'))).toBe(true);
    expect(coldRequests.some(r => r.path === 'detail/countries/CHN.geojson.gz')).toBe(false);
    expect(cold.edges.every(e => cellIds.includes(e.left) || cellIds.includes(e.right))).toBe(true);
    const warmStart = requests.length, warmBegan = performance.now(), warm = await delivery.loadCountryViewportDetail('CHN', bounds), warmMs = performance.now() - warmBegan;
    expect(warm).toEqual(cold);
    const cache = delivery.counters();expect(cache.parsedShardEntries).toBeLessThanOrEqual(8);expect(cache.parsedShardBytes).toBeLessThanOrEqual(4 * 1024 * 1024);
    results.push({name, bounds, coldMs, warmMs, cells: cellIds.length, edges: cold.edges.length, returnedJsonBytes: Buffer.byteLength(JSON.stringify(cold)),
      compressedBytes: coldRequests.reduce((sum, r) => sum + r.bytes, 0), requests: coldRequests,
      warmRequests: requests.slice(warmStart), cache});
  }
  const report = {schemaVersion: 'chn-2020-viewport-detail-performance-v1', pass: true, catalogVersion: pointer.catalogVersion,
    pointer: {path: pointerFile, sha256: sha(pointerBytes), byteLength: pointerBytes.length},
    conditions: {transport: 'actual checked local files through production vector loader', cold: 'fresh loader caches; OS file cache not flushed', warm: 'same viewport and loader', browserRenderMeasured: false, externalAiCalls: 0}, results};
  const output = process.env.CHN_VIEWPORT_REPORT;
  if (output) {fs.mkdirSync(path.dirname(output), {recursive: true});fs.writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);}
  console.log(JSON.stringify({pass: true, output: output ?? null, results: results.map(({name, coldMs, warmMs, cells, edges, returnedJsonBytes, compressedBytes}) => ({name, coldMs, warmMs, cells, edges, returnedJsonBytes, compressedBytes}))}));
}, 180_000);
