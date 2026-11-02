// @vitest-environment node
import {createHash} from 'node:crypto';
import {gzipSync} from 'node:zlib';
import {describe, expect, it, vi} from 'vitest';
import {loadOperationalVectorDelivery} from '../../src/lib/map/operational-vector-delivery';
import type {CatalogFetch} from '../../src/lib/map/catalog-vector-delivery';
import type {Feature, Polygon} from 'geojson';

type Artifact = {path: string; sha256: string; byteLength: number};
type CellShard = {countryId: string; cellOrdinals: number[]; bbox?: [number, number, number, number]; artifact: Artifact};
const version = 'catalog-v3-chn-shard-fixture-v1', base = `/data/territory-catalog/${version}/`, schemaVersion = 'operational-world-delivery-v2';
const root = (n: number) => String(n).repeat(64), id = (n: number) => `territory:catalog:${String(n).padStart(64, '0')}`;
const expected = {catalogVersion: version, geometryRoot: root(1), topologyRoot: root(2), renderArtifactRoot: root(3), manifestPath: `${base}manifest.json`};
const ref = {catalogVersion: version, geometryRoot: root(1), topologyRoot: root(2), renderArtifactRoot: root(3), catalogOrderRoot: root(4), administrativeMembershipRoot: root(5), previousParentRoot: root(6)};
const counts = {countries: 2, cells: 3, edges: 3, administrativeParents: 2, previousParents: 3};
const square = (ordinal: number, x: number): Feature<Polygon> => ({type: 'Feature', id: ordinal, properties: {}, geometry: {type: 'Polygon', coordinates: [[[x, 30], [x + .2, 30], [x + .2, 30.2], [x, 30.2], [x, 30]]]}});

function fixture(locations: readonly number[] = [100, 100.2, 127]) {
  const files = new Map<string, Buffer>();
  const store = (file: string, value: unknown, raw = false): Artifact => {
    let bytes = raw ? value as Buffer : Buffer.from(`${JSON.stringify(value)}\n`);
    if (file.endsWith('.gz')) bytes = gzipSync(bytes);
    files.set(base + file, bytes);return {path: file, sha256: createHash('sha256').update(bytes).digest('hex'), byteLength: bytes.length};
  };
  const features = locations.map((x, i) => square(i + 1, x));
  const edges = [[1, 0], [1, 3], [2, 0]].map(([left, right], i) => ({id: `edge:operational:${String(i + 1).padStart(64, '0')}`, ordinal: i + 1, left, right,
    boundaryClass: right ? 'country' : 'coast', flags: {positiveAdjacency: !!right, country: !!right, administrative: false, previous: false, residual: false},
    geometry: {type: 'LineString', coordinates: [[locations[left - 1], 30], [locations[left - 1], 30.2]]}}));
  const countries = [
    {countryId: 'CHN', cellCount: 2, metadata: store('metadata/countries/CHN.json.gz', {countryId: 'CHN', columns: ['cellOrdinal', 'cellId', 'administrativeOrdinal', 'previousParentOrdinal'], rows: [[1, id(1), 1, 1], [2, id(2), 1, 2]]}), detail: store('detail/countries/CHN.geojson.gz', {type: 'FeatureCollection', features: features.slice(0, 2)})},
    {countryId: 'PRK', cellCount: 1, metadata: store('metadata/countries/PRK.json.gz', {countryId: 'PRK', columns: ['cellOrdinal', 'cellId', 'administrativeOrdinal', 'previousParentOrdinal'], rows: [[3, id(3), 2, 3]]}), detail: store('detail/countries/PRK.geojson.gz', {type: 'FeatureCollection', features: features.slice(2)})},
  ];
  const detail: {schemaVersion: string; ref: typeof ref; countries: typeof countries; edgeDetails: {shard: string; firstOrdinal: number; count: number; artifact: Artifact}[]; cellDetails?: CellShard[]; parents: string; lodCoverage: string; lazy: boolean} = {
    schemaVersion, ref: {...ref}, countries, edgeDetails: edges.map((edge, i) => ({shard: `topology/${String(i).padStart(3, '0')}.json.gz`, firstOrdinal: i + 1, count: 1,
      artifact: store(`detail/topology/${String(i).padStart(3, '0')}.json.gz`, {schemaVersion, edges: [edge]})})),
    cellDetails: [0, 1].map(i => ({countryId: 'CHN', cellOrdinals: [i + 1], bbox: [locations[i], 30, locations[i] + .2, 30.2], artifact: store(`detail/cells/CHN/${String(i).padStart(4, '0')}.geojson.gz`, {type: 'FeatureCollection', features: [features[i]]})})), parents: 'metadata/parents.json.gz', lodCoverage: 'lod-coverage.json.gz', lazy: true,
  };
  const tileArtifacts = [];
  for (let z = 0; z <= 6; z++) for (let x = 0; x < 2 ** z; x++) for (let y = 0; y < 2 ** z; y++) tileArtifacts.push({path: `tiles/${z}/${x}/${y}.pbf.gz`, sha256: root(0), byteLength: 0});
  const tileIndex = store('tile-index.json', {schemaVersion, ref, artifacts: tileArtifacts});
  const rawIncidence = Buffer.alloc(24);edges.forEach((edge, i) => {rawIncidence.writeUInt32LE(edge.left, i * 8);rawIncidence.writeUInt32LE(edge.right, i * 8 + 4);});
  const incidence = store('metadata/edge-incidence.bin.gz', rawIncidence, true);
  const parents = store('metadata/parents.json.gz', {}), coverage = store('lod-coverage.json.gz', {});
  const fetcher: CatalogFetch = vi.fn(async file => {const bytes = files.get(file);if (!bytes) throw Error(`UNEXPECTED_ASSET:${file}`);return new Response(new Uint8Array(bytes));});
  const fullIdentity = (a: Artifact) => ({...a, path: base + a.path});
  return {detail, features, fetcher, files, edges,
    replaceShard: (i: number, shardFeatures: Feature<Polygon>[]) => {const shard = detail.cellDetails![i];shard.artifact = store(shard.artifact.path, {type: 'FeatureCollection', features: shardFeatures});},
    replaceEdge: (i: number, edge: typeof edges[number]) => {const shard = detail.edgeDetails[i];shard.artifact = store(shard.artifact.path, {schemaVersion, edges: [edge]});},
    load: async () => {
      const detailIndex = store('detail-index.json', detail);
      const manifest = store('manifest.json', {schemaVersion, ref, counts, sourceId: 'world-operational-catalog', minZoom: 0, maxZoom: 6, promoteId: null, tileTemplate: 'tiles/{z}/{x}/{y}.pbf.gz', tileIndex, detailIndex,
        policy: {tileTransport: {compression: 'gzip', httpContentEncoding: null}, administrativeMinZoom: 4, operationalMinZoom: 8}, edgeIncidence: {format: 'uint32-le-pairs', recordBytes: 8, recordCount: counts.edges, decodedByteLength: counts.edges * 8, artifact: incidence}});
      const bootstrap = {schemaVersion: 'operational-map-bootstrap-v1', catalog: {schemaVersion: 'operational-catalog-v1', catalogRef: expected, indexRoots: {catalogOrder: ref.catalogOrderRoot, administrativeMembership: ref.administrativeMembershipRoot, previousParent: ref.previousParentRoot}, counts, countryOrder: ['CHN', 'PRK']}, manifest: fullIdentity(manifest), tileIndex: fullIdentity(tileIndex), detailIndex: fullIdentity(detailIndex), parents: fullIdentity(parents), coverage: fullIdentity(coverage)};
      return loadOperationalVectorDelivery(bootstrap, expected, fetcher);
    },
  };
}

describe('bounded exact cell-detail transport', () => {
  it('loads a changed CHN cell from its shard without fetching full CHN, and reuses by-ID metadata', async () => {
    const f = fixture(), delivery = await f.load();vi.mocked(f.fetcher).mockClear();
    const hint = {id: id(1), sourceCountryId: 'CHN'};
    const selected = await delivery.loadCellDetail([hint]);expect(selected.features).toEqual([f.features[0]]);
    expect(vi.mocked(f.fetcher).mock.calls.map(([file]) => file)).toEqual([base + 'metadata/countries/CHN.json.gz', base + 'detail/cells/CHN/0000.geojson.gz']);
    const first = (await delivery.resolveCells([hint]))[0];expect((await delivery.resolveCells([hint]))[0]).toBe(first);
    expect(delivery.counters().countryMetadataBuilds).toBe(1);
    selected.features[0].geometry.coordinates.length = 0;
    expect((await delivery.loadCellDetail([hint])).features).toEqual([f.features[0]]);
    expect(vi.mocked(f.fetcher).mock.calls).toHaveLength(2);
    expect(delivery.counters().cachedBytes).toBeLessThanOrEqual(32 * 1024 * 1024);
  });

  it('keeps explicit full-country selection and old v2 catalogs backward compatible', async () => {
    const f = fixture();delete f.detail.cellDetails;const old = await f.load();vi.mocked(f.fetcher).mockClear();
    expect((await old.loadCellDetail([{id: id(1), sourceCountryId: 'CHN'}])).features).toEqual([f.features[0]]);
    expect(vi.mocked(f.fetcher).mock.calls.map(([file]) => file)).toContain(base + 'detail/countries/CHN.geojson.gz');
    const newer = fixture(), delivery = await newer.load();vi.mocked(newer.fetcher).mockClear();
    expect((await delivery.loadCountryDetail('CHN')).features).toEqual(newer.features.slice(0, 2));
    expect(vi.mocked(newer.fetcher).mock.calls.map(([file]) => file)).toContain(base + 'detail/countries/CHN.geojson.gz');
  });

  it('rejects missing, duplicate and unregistered shard mapping before geometry fetch', async () => {
    for (const mutation of ['missing', 'duplicate', 'path']) {
      const f = fixture();if (mutation === 'missing') f.detail.cellDetails!.pop();
      else if (mutation === 'duplicate') f.detail.cellDetails![1].cellOrdinals = [1];
      else f.detail.cellDetails![0].artifact.path = 'detail/cells/CHN/../../PRK/0000.geojson.gz';
      await expect(f.load()).rejects.toThrow('INVALID_OPERATIONAL_CELL_DETAIL_INDEX');
      expect(vi.mocked(f.fetcher).mock.calls.some(([file]) => file.includes('/detail/cells/'))).toBe(false);
    }
  });

  it('rejects wrong-country ordinals without fetching full country as fallback', async () => {
    const f = fixture();f.detail.cellDetails![1].cellOrdinals = [3];const delivery = await f.load();
    await expect(delivery.loadCellDetail([{id: id(1), sourceCountryId: 'CHN'}])).rejects.toThrow('INVALID_OPERATIONAL_CELL_DETAIL_MAPPING');
    expect(vi.mocked(f.fetcher).mock.calls.some(([file]) => file.endsWith('/detail/countries/CHN.geojson.gz'))).toBe(false);
  });

  it('rejects stale catalog references and corrupted shard bytes', async () => {
    const stale = fixture();stale.detail.ref.geometryRoot = root(0);await expect(stale.load()).rejects.toThrow('Catalog ref mismatch');
    const f = fixture(), delivery = await f.load(), shard = f.detail.cellDetails![0];
    const bytes = Buffer.from(f.files.get(base + shard.artifact.path)!);bytes[0] ^= 1;f.files.set(base + shard.artifact.path, bytes);
    await expect(delivery.loadCellDetail([{id: id(1), sourceCountryId: 'CHN'}])).rejects.toThrow('SHA-256');
  });

  it('validates every feature in the fetched shard, including duplicate/unrequested IDs and malformed geometry', async () => {
    for (const mutation of ['duplicate', 'missing', 'wrong-id', 'geometry']) {
      const f = fixture();
      if (mutation === 'duplicate') f.replaceShard(0, [f.features[0], f.features[0]]);
      else if (mutation === 'missing') f.replaceShard(0, []);
      else if (mutation === 'wrong-id') f.replaceShard(0, [f.features[1]]);
      else f.replaceShard(0, [{...f.features[0], geometry: {type: 'Polygon', coordinates: []}}]);
      const delivery = await f.load();await expect(delivery.loadCellDetail([{id: id(1), sourceCountryId: 'CHN'}])).rejects.toThrow();
      expect(vi.mocked(f.fetcher).mock.calls.some(([file]) => file.endsWith('/detail/countries/CHN.geojson.gz'))).toBe(false);
    }
  });
});

describe('country viewport exact detail', () => {
  const nearFirst = [100.01, 30.01, 100.19, 30.19] as const;

  it('fetches only intersecting shards and exact incident edges, keeping whole cells and excluding full CHN', async () => {
    const f = fixture(), delivery = await f.load();vi.mocked(f.fetcher).mockClear();
    const selected = await delivery.loadCountryViewportDetail('CHN', nearFirst);
    expect(selected.cells.features).toEqual([f.features[0]]);
    expect(selected.edges).toEqual(f.edges.slice(0, 2));
    expect(vi.mocked(f.fetcher).mock.calls.map(([path]) => path)).toEqual([
      base + 'metadata/countries/CHN.json.gz', base + 'detail/cells/CHN/0000.geojson.gz',
      base + 'detail/topology/000.json.gz', base + 'detail/topology/001.json.gz',
    ]);
    expect(selected.cells.features[0].geometry.coordinates[0][0]).toEqual([100, 30]);
    const before = vi.mocked(f.fetcher).mock.calls.length, builds = delivery.counters().parsedShardBuilds;
    selected.cells.features[0].geometry.coordinates.length = 0;selected.edges[0].geometry.coordinates.length = 0;
    expect(await delivery.loadCountryViewportDetail('CHN', nearFirst)).toEqual({cells: {type: 'FeatureCollection', features: [f.features[0]]}, edges: f.edges.slice(0, 2)});
    expect(vi.mocked(f.fetcher).mock.calls).toHaveLength(before);
    expect(delivery.counters().parsedShardBuilds).toBe(builds);expect(delivery.counters().exactCellCacheHits).toBe(1);
    expect(delivery.counters().exactEdgeCacheHits).toBe(2);
  });

  it('returns empty detail without fetching geometry outside the country viewport', async () => {
    const f = fixture(), delivery = await f.load();vi.mocked(f.fetcher).mockClear();
    expect(await delivery.loadCountryViewportDetail('CHN', [0, -10, 10, 10])).toEqual({cells: {type: 'FeatureCollection', features: []}, edges: []});
    expect(vi.mocked(f.fetcher).mock.calls.map(([path]) => path)).toEqual([base + 'metadata/countries/CHN.json.gz']);
  });

  it('normalizes wrapped views, date-line crossings and world spans without duplicating cells or edges', async () => {
    const f = fixture([179.7, -179.9, 127]), delivery = await f.load();
    for (const bounds of [[179.6, 30, -179.6, 31], [539.6, 30, 540.4, 31], [-540, 30, -180, 31], [180, 30, -180, 31]] as const) {
      const selected = await delivery.loadCountryViewportDetail('CHN', bounds);
      expect(selected.cells.features).toEqual(f.features.slice(0, 2));expect(selected.edges).toEqual(f.edges);
    }
    expect((await delivery.loadCountryViewportDetail('CHN', [-180, 30, -179.6, 31])).cells.features).toEqual([f.features[1]]);
  });

  it('rejects invalid bounds before metadata or geometry I/O', async () => {
    const f = fixture(), delivery = await f.load();vi.mocked(f.fetcher).mockClear();
    for (const bounds of [[0, 10, 20, -10], [NaN, 0, 10, 20], [0, -91, 20, 10], [0, 0, 20, 91]] as const) await expect(delivery.loadCountryViewportDetail('CHN', bounds)).rejects.toThrow('INVALID_OPERATIONAL_VIEWPORT_BOUNDS');
    expect(vi.mocked(f.fetcher).mock.calls).toHaveLength(0);
  });

  it('preserves unsharded catalogs and optional old shard bboxes while returning only intersecting cells', async () => {
    const old = fixture();delete old.detail.cellDetails;const delivery = await old.load();
    expect((await delivery.loadCountryViewportDetail('CHN', nearFirst)).cells.features).toEqual([old.features[0]]);
    expect(vi.mocked(old.fetcher).mock.calls.some(([p]) => p.endsWith('/detail/countries/CHN.geojson.gz'))).toBe(true);
    const noBounds = fixture();noBounds.detail.cellDetails!.forEach(shard => {delete shard.bbox;});const indexed = await noBounds.load();
    expect((await indexed.loadCountryViewportDetail('CHN', nearFirst)).cells.features).toEqual([noBounds.features[0]]);
    expect(vi.mocked(noBounds.fetcher).mock.calls.some(([p]) => p.endsWith('/detail/countries/CHN.geojson.gz'))).toBe(false);
  });

  it('rejects corrupted shards, understated stored bboxes and mismatched edge incidence', async () => {
    const corrupt = fixture(), delivery = await corrupt.load(), path = base + corrupt.detail.cellDetails![0].artifact.path;
    const bytes = Buffer.from(corrupt.files.get(path)!);bytes[0] ^= 1;corrupt.files.set(path, bytes);
    await expect(delivery.loadCountryViewportDetail('CHN', nearFirst)).rejects.toThrow('SHA-256');
    const wrongBounds = fixture();wrongBounds.detail.cellDetails![0].bbox![2] = 100.1;
    await expect((await wrongBounds.load()).loadCountryViewportDetail('CHN', nearFirst)).rejects.toThrow('INVALID_OPERATIONAL_EXACT_CELL_SHARD_BOUNDS');
    const edgeMismatch = fixture();edgeMismatch.replaceEdge(0, {...edgeMismatch.edges[0], left: 2});
    await expect((await edgeMismatch.load()).loadCountryViewportDetail('CHN', nearFirst)).rejects.toThrow('INVALID_OPERATIONAL_EXACT_EDGE');
  });

  it('aborts a stale viewport after transport resolves even when the transport ignores AbortSignal', async () => {
    const f = fixture(), original = vi.mocked(f.fetcher).getMockImplementation()!;
    let release!: () => void, started!: () => void;const pending = new Promise<void>(resolve => {release = resolve;}), fetching = new Promise<void>(resolve => {started = resolve;});
    vi.mocked(f.fetcher).mockImplementation(async (path, init) => {
      if (path.endsWith('/detail/cells/CHN/0000.geojson.gz')) {started();await pending;}
      return original(path, init);
    });
    const delivery = await f.load(), abort = new AbortController(), stale = delivery.loadCountryViewportDetail('CHN', nearFirst, abort.signal);
    await fetching;abort.abort();
    const fresh = await delivery.loadCountryViewportDetail('CHN', [100.21, 30.01, 100.39, 30.19]);
    expect(fresh.cells.features).toEqual([f.features[1]]);release();await expect(stale).rejects.toThrow();
    expect(vi.mocked(f.fetcher).mock.calls.some(([path]) => path.endsWith('/detail/topology/000.json.gz'))).toBe(false);
    const cachedAbort = new AbortController();cachedAbort.abort();
    await expect(delivery.loadCountryViewportDetail('CHN', nearFirst, cachedAbort.signal)).rejects.toThrow();
  });

  it('does not retain oversized parsed shards and bounds the parsed geometry cache', async () => {
    const f = fixture();f.replaceShard(0, [{...f.features[0], properties: {large: 'x'.repeat(2 * 1024 * 1024)}}]);
    const delivery = await f.load(), hint = {id: id(1), sourceCountryId: 'CHN'};
    await delivery.loadCellDetail([hint]);expect(delivery.counters().parsedShardEntries).toBe(0);
    await delivery.loadCellDetail([hint]);expect(delivery.counters().parsedShardBuilds).toBe(2);
    expect(delivery.counters().parsedShardBytes).toBeLessThanOrEqual(4 * 1024 * 1024);expect(delivery.counters().parsedShardEntries).toBeLessThanOrEqual(8);
  });

  it('evicts complete-cell geometry by its bounded coordinate memory estimate without changing later results', async () => {
    const f = fixture();f.detail.cellDetails!.push({countryId: 'PRK', cellOrdinals: [3], bbox: [127, 30, 127.2, 30.2],
      artifact: {path: 'detail/cells/PRK/0000.geojson.gz', sha256: root(0), byteLength: 0}});
    for (let index = 0; index < 3; index++) {
      const corners = f.features[index].geometry.coordinates[0], ring = [];
      for (let side = 0; side < 4; side++) for (let step = 0; step < 7500; step++) {
        const a = corners[side], b = corners[side + 1], t = step / 7500;ring.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
      }
      ring.push(corners[0]);f.replaceShard(index, [{...f.features[index], geometry: {type: 'Polygon', coordinates: [ring]}}]);
    }
    const delivery = await f.load(), hints = [1, 2, 3].map(n => ({id: id(n), sourceCountryId: n === 3 ? 'PRK' : 'CHN'}));
    await delivery.loadCellDetail(hints);expect(delivery.counters().cachedExactCells).toBe(2);
    expect(delivery.counters().cachedExactCellEstimatedBytes).toBeLessThanOrEqual(4 * 1024 * 1024);
    const before = delivery.counters().exactCellCacheHits;await delivery.loadCellDetail(hints.slice(1));
    expect(delivery.counters().exactCellCacheHits).toBe(before + 2);
    const restored = await delivery.loadCellDetail(hints.slice(0, 1));expect(restored.features[0].id).toBe(1);
    expect((restored.features[0].geometry as Polygon).coordinates[0]).toHaveLength(30001);
    expect(delivery.counters().cachedExactCellEstimatedBytes).toBeLessThanOrEqual(4 * 1024 * 1024);
  });
});
