// @vitest-environment node
import path from 'node:path';
import {createHash} from 'node:crypto';
import {gzipSync} from 'node:zlib';
import {describe, expect, it} from 'vitest';
import {prepareOperationalCatalog, OPERATIONAL_CATALOG_PATHS} from './operational-catalog.server';
import {OPERATIONAL_CATALOG_VERSION} from './operational-catalog';

const schemaVersion = 'operational-world-delivery-v2', root = (n: number) => String(n).repeat(64);
const cellId = (n: number) => `territory:catalog:${String(n).padStart(64, '0')}`;
const edgeId = (n: number) => `edge:operational:${String(n).padStart(64, '0')}`;
function fixture(tie = false) {
  const workspace = process.cwd(), prefix = OPERATIONAL_CATALOG_PATHS.delivery;
  const files = new Map<string, {bytes: Buffer; sha256: string; byteLength: number}>(), reads: string[] = [];
  const store = (file: string, value: unknown, raw = false) => {
    let bytes = raw ? value as Buffer : Buffer.from(`${JSON.stringify(value)}\n`);if (file.endsWith('.gz')) bytes = gzipSync(bytes);
    const artifact = {bytes, sha256: createHash('sha256').update(bytes).digest('hex'), byteLength: bytes.length};files.set(file, artifact);return {path: file, sha256: artifact.sha256, byteLength: artifact.byteLength};
  };
  const ref = {catalogVersion: OPERATIONAL_CATALOG_VERSION, geometryRoot: root(1), topologyRoot: root(2), renderArtifactRoot: root(3), manifestPath: `/data/territory-catalog/${OPERATIONAL_CATALOG_VERSION}/manifest.json`};
  store('catalog.json', {schemaVersion: 'operational-catalog-v1', catalogRef: ref, counts: {countries: 3, cells: 4, edges: 4, administrativeParents: 3, previousParents: 4}, countryOrder: ['CHN', 'PRK', 'USA'], indexRoots: {catalogOrder: root(4), administrativeMembership: root(5), previousParent: root(6)}});
  const administrative = ['CHN', 'PRK', 'USA'].map((sourceCountryId, i) => ({parentKey: `parent:${sourceCountryId}`, sourceCountryId, kind: 'administrative', start: i, count: sourceCountryId === 'USA' ? 2 : 1}));
  const previous = ['CHN', 'PRK', 'USA', 'USA'].map((sourceCountryId, i) => ({oldTerritoryId: cellId(i + 1), sourceCountryId, start: i, count: 1}));
  store('metadata/parents.json.gz', {administrative, previous});
  const countries = ['CHN', 'PRK', 'USA'].map((countryId, i) => ({countryId, cellCount: countryId === 'USA' ? 2 : 1,
    metadata: store(`metadata/countries/${countryId}.json.gz`, {countryId, columns: ['cellOrdinal', 'cellId', 'administrativeOrdinal', 'previousParentOrdinal'], rows: (countryId === 'USA' ? [3, 4] : [i + 1]).map(n => [n, cellId(n), i + 1, n])}),
    detail: {path: `detail/countries/${countryId}.geojson.gz`, sha256: root(0), byteLength: 0}}));
  const edges = [
    {ordinal: 1, id: edgeId(1), left: 1, right: 2, lengthKm: tie ? 3 : 2, geometry: {type: 'LineString', coordinates: [[0, 0], [1, 0], [1, 1]]}},
    {ordinal: 2, id: edgeId(2), left: 2, right: 1, lengthKm: 3, geometry: {type: 'LineString', coordinates: [[0, 0], [0, 2], [0, 3]]}},
    {ordinal: 3, id: edgeId(3), left: 3, right: 0, lengthKm: 1, geometry: {type: 'LineString', coordinates: [[10, 0], [10, 1]]}},
    {ordinal: 4, id: edgeId(4), left: 3, right: 4, lengthKm: 1, geometry: {type: 'LineString', coordinates: [[10, 1], [11, 1]]}},
  ].map(e => ({...e, boundaryClass: e.right ? 'country' : 'coast', flags: {positiveAdjacency: e.right > 0, country: e.ordinal < 3, administrative: false, previous: e.right > 0, residual: false}}));
  const edgeDetails = edges.map((e, i) => {const shard = `topology/${String(i).padStart(3, '0')}.json.gz`;return {shard, firstOrdinal: i + 1, count: 1, artifact: store(`detail/${shard}`, {schemaVersion, edges: [e]})};});
  store('detail-index.json', {schemaVersion, ref, countries, edgeDetails});
  store('adjacency.json.gz', {cellCount: 4, offsets: [0, 1, 2, 3, 4], neighbors: [2, 1, 4, 3]});
  const binary = Buffer.alloc(32);edges.forEach((e, i) => {binary.writeUInt32LE(e.left, i * 8);binary.writeUInt32LE(e.right, i * 8 + 4);});store('metadata/edge-incidence.bin.gz', binary, true);
  return {reads, binary, edges,
    mutateEdgeIndex: (mutation: (shards: typeof edgeDetails) => void) => {const detail = JSON.parse(files.get('detail-index.json')!.bytes.toString());mutation(detail.edgeDetails);store('detail-index.json', detail);},
    incidence: (bytes: Buffer, repin = true) => {if (repin) store('metadata/edge-incidence.bin.gz', bytes, true);else files.get('metadata/edge-incidence.bin.gz')!.bytes = gzipSync(bytes);},
    replaceEdge: (index: number, mutation: Partial<typeof edges[number]>) => {store(`detail/topology/${String(index).padStart(3, '0')}.json.gz`, {schemaVersion, edges: [{...edges[index], ...mutation}]});
      const detail = JSON.parse(files.get('detail-index.json')!.bytes.toString());detail.edgeDetails[index].artifact = {path: `detail/topology/${String(index).padStart(3, '0')}.json.gz`, sha256: files.get(`detail/topology/${String(index).padStart(3, '0')}.json.gz`)!.sha256, byteLength: files.get(`detail/topology/${String(index).padStart(3, '0')}.json.gz`)!.byteLength};store('detail-index.json', detail);},
    prepare: () => {
      const index = Buffer.from(JSON.stringify({schemaVersion, artifacts: [...files].map(([file, a]) => ({path: file, sha256: a.sha256, byteLength: a.byteLength}))}));
      const pointer = Buffer.from(JSON.stringify({catalogVersion: OPERATIONAL_CATALOG_VERSION, root: prefix, index: {sha256: createHash('sha256').update(index).digest('hex'), byteLength: index.length}}));
      return prepareOperationalCatalog(workspace, file => {
        const relative = path.relative(workspace, file).replaceAll('\\', '/');reads.push(relative);
        if (relative === 'data/runtime/operational-catalog/current.json') return pointer;if (relative === `${prefix}/artifact-index.json`) return index;
        if (!relative.startsWith(`${prefix}/`)) throw Error(`UNEXPECTED_READ:${relative}`);const artifact = files.get(relative.slice(prefix.length + 1));if (!artifact) throw Error(`UNEXPECTED_GEOMETRY_READ:${relative}`);return artifact.bytes;
      });
    },
  };
}

describe('lazy exact edge lookup from immutable binary incidence', () => {
  it('answers incidence without geometry and loads only matching pair shards once', () => {
    const f = fixture(), catalog = f.prepare();expect(f.reads.some(file => file.includes('edge-incidence'))).toBe(false);
    expect(catalog.edgeIncidence(3)).toEqual({left: 3, right: 0});expect(f.reads.some(file => file.includes('/detail/topology/'))).toBe(false);
    expect(catalog.sharedBoundary(1, 2)).toEqual({edgeOrdinal: 2, start: [0, 0], end: [0, 2]});
    expect(f.reads.filter(file => file.includes('/detail/topology/')).map(file => file.split('/').at(-1))).toEqual(['000.json.gz', '001.json.gz']);
    const before = f.reads.length;expect(catalog.sharedBoundary(2, 1).edgeOrdinal).toBe(2);expect(catalog.edgeIncidence(1)).toEqual({left: 1, right: 2});expect(f.reads.length).toBe(before);
    expect(f.reads.filter(file => file.endsWith('/metadata/edge-incidence.bin.gz'))).toHaveLength(1);
    expect(() => catalog.sharedBoundary(1, 3)).toThrow('NO_OPERATIONAL_LAND_BOUNDARY');
  });

  it('preserves first-ordinal edge ties and first longest-segment ties', () => {
    const catalog = fixture(true).prepare();expect(catalog.sharedBoundary(1, 2)).toEqual({edgeOrdinal: 1, start: [0, 0], end: [1, 0]});
  });

  it('rejects corrupt compressed bytes before admitting incidence', () => {
    const f = fixture(), changed = Buffer.from(f.binary);changed.writeUInt32LE(4, 0);f.incidence(changed, false);const catalog = f.prepare();
    expect(() => catalog.edgeIncidence(1)).toThrow('OPERATIONAL_ASSET_IDENTITY');expect(f.reads.some(file => file.includes('/detail/topology/'))).toBe(false);
  });

  it('rejects binary length, zero left, out-of-range right and self incidence', () => {
    for (const mutation of ['length', 'zero', 'range', 'self']) {
      const f = fixture(), binary = Buffer.from(f.binary);if (mutation === 'zero') binary.writeUInt32LE(0, 0);if (mutation === 'range') binary.writeUInt32LE(5, 4);if (mutation === 'self') binary.writeUInt32LE(1, 4);f.incidence(mutation === 'length' ? binary.subarray(0, -1) : binary);const catalog = f.prepare();
      expect(() => catalog.edgeIncidence(1)).toThrow(mutation === 'length' ? 'OPERATIONAL_EDGE_INCIDENCE_SHAPE' : 'OPERATIONAL_EDGE_INCIDENCE_MAPPING');expect(f.reads.some(file => file.includes('/detail/topology/'))).toBe(false);
    }
  });

  it('rejects a hash-verified geometry edge whose incidence differs from the binary index', () => {
    const f = fixture();f.replaceEdge(0, {right: 3});const catalog = f.prepare();expect(catalog.edgeIncidence(1)).toEqual({left: 1, right: 2});
    expect(() => catalog.sharedBoundary(1, 2)).toThrow('OPERATIONAL_EDGE_INCIDENCE_MISMATCH');expect(f.reads.some(file => file.endsWith('/002.json.gz') || file.endsWith('/003.json.gz'))).toBe(false);
  });

  it('rejects duplicate topology cache identities and noncontiguous ordinal mappings', () => {
    for (const duplicate of [true, false]) {const f = fixture();f.mutateEdgeIndex(shards => {if (duplicate) {shards[1].shard = shards[0].shard;shards[1].artifact = shards[0].artifact;}else shards[1].firstOrdinal++;});expect(() => f.prepare()).toThrow('OPERATIONAL_EDGE_INDEX');}
  });
});
