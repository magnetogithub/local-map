// @vitest-environment node
import fs from 'node:fs';
import {gunzipSync, gzipSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import {beforeAll, describe, expect, it, vi} from 'vitest';
import type {AddProtocolAction, Map as MapLibreMap, SourceSpecification} from 'maplibre-gl';
import {VectorTile} from '@mapbox/vector-tile';
import {PbfReader} from 'pbf';
import {GET as bootstrapGET} from '@/app/api/world/catalog/operational/map/route';
import {GET as assetGET} from '@/app/data/territory-catalog/[version]/[...asset]/route';
import {prepareOperationalCatalog, OPERATIONAL_CATALOG_PATHS} from '../world/operational-catalog.server';
import {prepareOperationalMapDelivery} from './operational-delivery.server';
import {OPERATIONAL_MAP_SOURCE_ID, readOperationalMapBootstrap} from './operational-delivery-contract';
import {fetchOperationalVectorDelivery, loadOperationalVectorDelivery, type OperationalVectorDelivery} from './operational-vector-delivery';
import {registerCatalogTileProtocol, type CatalogFetch} from './catalog-vector-delivery';
import {createOperationalMapSources, OPERATIONAL_EXACT_CELL_SOURCE_ID, OPERATIONAL_EXACT_EDGE_SOURCE_ID} from './operational-map-sources';
import {mapLibreFeatureTarget} from './render-feature-ref';

const catalog = prepareOperationalCatalog(), ref = catalog.ref, base = `/data/territory-catalog/${ref.catalogVersion}/`;
const requests: string[] = [];
const asset = (file: string, headers?: HeadersInit) => assetGET(new Request(`http://localhost${base}${file}`, {headers}), {params: Promise.resolve({version: ref.catalogVersion, asset: file.split('/')})});
const fetcher: CatalogFetch = async path => {
  requests.push(path);
  if (path === '/api/world/catalog/operational/map') return bootstrapGET();
  if (!path.startsWith(base)) throw Error(`Unexpected request ${path}`);
  return asset(path.slice(base.length));
};
let delivery: OperationalVectorDelivery;
beforeAll(async () => {delivery = await fetchOperationalVectorDelivery(ref, fetcher);});

describe('16-04 operational map transport', () => {
  it('boots the admitted v3 without fetching world geometry or country metadata', () => {
    expect(requests).toEqual(['/api/world/catalog/operational/map', base + 'manifest.json', base + 'tile-index.json', base + 'detail-index.json', base + 'metadata/edge-incidence.bin.gz']);
    expect(delivery.bootstrap.catalog.counts.cells).toBe(catalog.descriptor.counts.cells);
    expect(delivery.source.promoteId).toBeUndefined();
    expect(delivery.source.tiles).toEqual([`${delivery.protocol}://${base}tiles/{z}/{x}/{y}.pbf.gz`]);
    expect(delivery.counters().cachedCountries).toBe(0);
    expect(() => readOperationalMapBootstrap(delivery.bootstrap, {...ref, geometryRoot: '0'.repeat(64)})).toThrow();
  });

  it('serves approved bytes as gzip payloads and denies build artifacts, traversal and other versions', async () => {
    const response = await asset('tiles/0/0/0.pbf.gz');
    expect(response.status).toBe(200); expect(response.headers.get('content-type')).toBe('application/gzip');
    expect(response.headers.get('content-encoding')).toBeNull();
    expect(response.headers.get('cache-control')).toContain('immutable');
    expect(new Uint8Array(await response.arrayBuffer()).slice(0, 2)).toEqual(new Uint8Array([31, 139]));
    expect((await asset('tiles/0/0/0.pbf.gz', {'if-none-match': response.headers.get('etag')!})).status).toBe(304);
    for (const file of ['artifact-index.json', 'provenance.json', '../manifest.json', 'tiles/9/0/0.pbf.gz', 'metadata/countries/ZZZ.json.gz']) expect((await asset(file)).status).toBe(404);
    expect((await assetGET(new Request('http://localhost/data/territory-catalog/other/manifest.json'), {params: Promise.resolve({version: 'other', asset: ['manifest.json']})})).status).toBe(404);
  });

  it('registers the actual MapLibre protocol, verifies gzip then returns decoded PBF with numeric IDs', async () => {
    let handler: AddProtocolAction | undefined;
    const api = {addProtocol: vi.fn((_id: string, action: AddProtocolAction) => {handler = action;}), removeProtocol: vi.fn()};
    const stopA = registerCatalogTileProtocol(api, delivery), stopB = registerCatalogTileProtocol(api, delivery);
    const response = await handler!({url: `${delivery.protocol}://${base}tiles/0/0/0.pbf.gz`, type: 'arrayBuffer'}, new AbortController());
    const bytes = response.data as ArrayBuffer;
    expect(new Uint8Array(bytes).slice(0, 2)).not.toEqual(new Uint8Array([31, 139]));
    const tile = new VectorTile(new PbfReader(new Uint8Array(bytes)) as unknown as ConstructorParameters<typeof VectorTile>[0]);
    expect(typeof tile.layers.territories.feature(0).id).toBe('number');
    expect(tile.layers.territories.feature(0).properties).not.toHaveProperty('territoryId');
    expect(tile.layers.administrative).toBeUndefined();
    const edge = tile.layers.edges.feature(0);
    expect(delivery.edgeIncidence(edge.id!).left).toBeGreaterThan(0);
    expect(mapLibreFeatureTarget(delivery.renderRef('territories', tile.layers.territories.feature(0).id!))).toEqual({source: OPERATIONAL_MAP_SOURCE_ID, sourceLayer: 'territories', id: tile.layers.territories.feature(0).id});
    const before = requests.length; await delivery.loadTile(base + 'tiles/0/0/0.pbf.gz'); expect(requests.length).toBe(before);
    stopA(); expect(api.removeProtocol).not.toHaveBeenCalled(); stopB(); expect(api.removeProtocol).toHaveBeenCalledOnce();
    await expect(delivery.loadTile(base + 'tiles/0/0/0.pbf')).rejects.toThrow('UNREGISTERED');
    const abort = new AbortController(); abort.abort(); await expect(delivery.loadTile(base + 'tiles/0/0/0.pbf.gz', abort.signal)).rejects.toThrow();
  });

  it('rejects corrupt compressed bytes before decompression and does not cache the failed tile', async () => {
    const bootstrap = delivery.bootstrap;
    let corrupt = true;
    const broken: CatalogFetch = async (path, init) => {
      const response = await fetcher(path, init);
      if (corrupt && path.endsWith('/tiles/0/0/0.pbf.gz')) {const bytes = new Uint8Array(await response.arrayBuffer()); bytes[0] ^= 1; return new Response(bytes);}
      return response;
    };
    const local = await loadOperationalVectorDelivery(bootstrap, ref, broken);
    await expect(local.loadTile(base + 'tiles/0/0/0.pbf.gz')).rejects.toThrow('SHA-256');
    corrupt = false; expect((await local.loadTile(base + 'tiles/0/0/0.pbf.gz')).byteLength).toBeGreaterThan(0);
  });

  it('maps original cell IDs, administrative and previous parents lazily for PRK and SVN', async () => {
    for (const countryId of ['PRK', 'SVN']) {
      const cells = await delivery.loadCountry(countryId), original = catalog.loadCountry(countryId);
      expect(cells).toEqual(original);
      expect(await delivery.resolveCells(cells.slice(0, 2))).toEqual(cells.slice(0, 2));
    }
    const first = (await delivery.loadCountry('PRK'))[0];
    await expect(delivery.resolveCells([{id: first.id, sourceCountryId: 'SVN'}])).rejects.toThrow('UNKNOWN_OPERATIONAL_CELL');
    await expect(delivery.resolveCells([{id: 'invented', sourceCountryId: 'PRK'}])).rejects.toThrow('UNKNOWN_OPERATIONAL_CELL');
  });

  it('loads original exact coarse geometry and reuses cached country bytes', async () => {
    const coverage = await delivery.loadCoverage(), cells = await delivery.loadCountry('SVN');
    expect(coverage.cellCount).toBe(catalog.descriptor.counts.cells);
    const cell = cells[0];
    expect(cell).toBeDefined();
    const selected = await delivery.loadCellDetail([cell]);
    const original = JSON.parse(gunzipSync(fs.readFileSync(`${OPERATIONAL_CATALOG_PATHS.delivery}/detail/countries/SVN.geojson.gz`)).toString());
    expect(selected.features).toEqual(original.features.filter((f: {id: number}) => f.id === cell.ordinal));
    expect(selected.features).toHaveLength(1);
    const before = requests.length;
    selected.features[0].geometry.coordinates.length = 0;
    const restored = await delivery.loadCellDetail([cell]);
    expect(restored.features[0].geometry.coordinates.length).toBeGreaterThan(0);
    expect(requests.length).toBe(before);
  });

  it('preserves coarse source parent mappings and exact edge geometry', async () => {
    const parents = await delivery.loadParents();
    const parent = parents.administrative.find(p => p.sourceCountryId === 'PRK')!;
    expect(await delivery.administrativeMembership(parent.parentKey)).toEqual(catalog.administrativeMembership(parent.parentKey));
  });

  it('uses explicit metadata membership when parent interval hints overlap or have different counts', async () => {
    const data = JSON.parse(gunzipSync(fs.readFileSync(`${OPERATIONAL_CATALOG_PATHS.delivery}/metadata/parents.json.gz`)).toString());
    for (const parents of [data.administrative, data.previous]) for (const p of parents) {p.start = 77; p.count = 999;}
    const bytes = gzipSync(JSON.stringify(data));
    const parents = {...delivery.bootstrap.parents, sha256: createHash('sha256').update(bytes).digest('hex'), byteLength: bytes.length};
    const local = await loadOperationalVectorDelivery({...delivery.bootstrap, parents}, ref, async (path, init) =>
      path === parents.path ? new Response(new Uint8Array(bytes)) : fetcher(path, init));
    const loaded = await local.loadParents(), parent = loaded.administrative.find(p => p.sourceCountryId === 'PRK')!;
    const members = await local.administrativeMembership(parent.parentKey);
    expect(members).toEqual(catalog.administrativeMembership(parent.parentKey));
    expect(members.length).not.toBe(parent.count);
  });

  it('loads only the requested exact topology shard and retains numeric incidence and coast', async () => {
    const before = requests.length, edges = await delivery.loadEdgeDetails([1, 2]);
    expect(requests.slice(before)).toEqual([base + 'detail/topology/000.json.gz']);
    const raw = JSON.parse(gunzipSync(fs.readFileSync(`${OPERATIONAL_CATALOG_PATHS.delivery}/detail/topology/000.json.gz`)).toString());
    expect(edges).toEqual(raw.edges.slice(0, 2).map((edge: Record<string, unknown>) => Object.fromEntries(Object.entries(edge).filter(([key]) => key !== 'lengthKm'))));
    expect(edges[0].right).toBe(0);
    expect(delivery.edgeIncidence(1)).toEqual({left: edges[0].left, right: edges[0].right});
    const incident = delivery.incidentEdges([edges[0].left]);
    expect(incident).toContain(1);
    expect(incident.every(n => {const e = delivery.edgeIncidence(n); return e.left === edges[0].left || e.right === edges[0].left;})).toBe(true);
    expect(() => delivery.edgeIncidence(0)).toThrow();
    expect(() => delivery.renderRef('edges', catalog.descriptor.counts.edges + 1)).toThrow();
    expect(delivery.counters().cachedBytes).toBeLessThanOrEqual(32 * 1024 * 1024);
  });

  it('mounts stable vector/exact sources and writes requested cell detail to the map source', async () => {
    const sources = new Map<string, {spec: SourceSpecification; setData: ReturnType<typeof vi.fn>}>();
    const map = {addSource: (id: string, spec: SourceSpecification) => sources.set(id, {spec, setData: vi.fn()}), getSource: (id: string) => sources.get(id), removeSource: (id: string) => sources.delete(id)};
    const acceptsMapLibre = (real: MapLibreMap) => createOperationalMapSources(real, {addProtocol: vi.fn(), removeProtocol: vi.fn()}, delivery);
    expect(typeof acceptsMapLibre).toBe('function');
    const api = {addProtocol: vi.fn(), removeProtocol: vi.fn()}, mounted = createOperationalMapSources(map, api, delivery);
    const vector = sources.get(OPERATIONAL_MAP_SOURCE_ID), cell = (await delivery.loadCountry('PRK'))[0];
    const data = await mounted.showCellDetail([cell]);
    expect(sources.get(OPERATIONAL_EXACT_CELL_SOURCE_ID)!.setData).toHaveBeenCalledWith(data);
    await mounted.showEdgeDetail([1]); expect(sources.get(OPERATIONAL_EXACT_EDGE_SOURCE_ID)!.setData).toHaveBeenCalled();
    expect(sources.get(OPERATIONAL_MAP_SOURCE_ID)).toBe(vector);
    mounted.clearDetail(); mounted.dispose(); mounted.dispose();
    expect(sources.size).toBe(0); expect(api.removeProtocol).toHaveBeenCalledOnce();
    await expect(mounted.showCountryDetail('PRK')).rejects.toThrow('DISPOSED');
  });

  it('prepares the local asset service without enumerating polygon or topology payloads', () => {
    const reads: string[] = [];
    const local = prepareOperationalCatalog(process.cwd(), file => {reads.push(file.replaceAll('\\', '/')); return fs.readFileSync(file);});
    expect(prepareOperationalMapDelivery(local).bootstrap.catalog.catalogRef).toEqual(ref);
    expect(reads.some(p => /\/detail\/countries\/|\/detail\/topology\/|\/tiles\//.test(p))).toBe(false);
  });
});
