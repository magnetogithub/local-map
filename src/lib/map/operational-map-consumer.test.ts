// @vitest-environment node
import {describe, expect, it, vi} from 'vitest';
import {validateStyleMin} from '@maplibre/maplibre-gl-style-spec';
import type {Feature, FeatureCollection, Polygon} from 'geojson';
import type {GeoJSONSourceDiff, LayerSpecification, Map as MapLibreMap, SourceSpecification} from 'maplibre-gl';
import {createTerritoryEntityV3} from '../world/territory-entity-v3';
import {createWorldGeometryCatalogRef, readCatalogTerritoryId} from '../world/world-geometry-catalog-ref';
import type {OperationalCell, OperationalStateChange} from '../world/operational-catalog';
import type {OperationalMapWorld} from '../projection/operational-map-projection';
import {createOperationalMapConsumer, OPERATIONAL_CHANGED_CELL_SOURCE_ID, OPERATIONAL_FRONT_SOURCE_ID, OPERATIONAL_MAP_LAYERS as L, type OperationalMapPort} from './operational-map-consumer';
import {OPERATIONAL_MAP_SOURCE_ID} from './operational-delivery-contract';
import type {OperationalVectorDelivery} from './operational-vector-delivery';

const ref = createWorldGeometryCatalogRef({catalogVersion: 'catalog-v3-fixture', geometryRoot: 'a'.repeat(64), topologyRoot: 'b'.repeat(64), renderArtifactRoot: 'c'.repeat(64), manifestPath: '/data/territory-catalog/catalog-v3-fixture/manifest.json'});
const ids = [1, 2, 3, 4, 5].map(n => readCatalogTerritoryId(`territory:catalog:${String(n).padStart(64, '0')}`));
function fixture(occupied = false) {
  const cells: OperationalCell[] = ids.map((id, i) => ({id, ordinal: i + 1, sourceCountryId: i < 3 ? 'BBB' : 'AAA', administrativeOrdinal: i < 3 ? 10 : 20, previousParentOrdinal: i < 3 ? 1 : 2})) as OperationalCell[];
  const world: OperationalMapWorld = {catalogRef: ref, revision: 0, territoryOrder: ids,
    countriesById: {AAA: {mapColor: '#FF0000'}, BBB: {mapColor: '#0000FF'}, CCC: {mapColor: '#00FF00'}},
    territoriesById: Object.fromEntries(cells.map(c => [c.id, createTerritoryEntityV3({id: c.id, sourceCountryId: c.sourceCountryId, ownerCountryId: c.sourceCountryId, controllerCountryId: occupied && c.ordinal === 1 ? 'AAA' : c.sourceCountryId})]))};
  const pairs = [{left: 1, right: 2}, {left: 2, right: 3}, {left: 1, right: 0}, {left: 3, right: 4}, {left: 4, right: 5}];
  const features: Feature<Polygon>[] = cells.map(c => ({type: 'Feature', id: c.ordinal, properties: {}, geometry: {type: 'Polygon', coordinates: [
    [[c.ordinal, 0], [c.ordinal + 1, 0], [c.ordinal + 1, 1], [c.ordinal, 1], [c.ordinal, 0]],
    ...(c.ordinal === 1 ? [[[1.2, 0.2], [1.2, 0.3], [1.3, 0.3], [1.3, 0.2], [1.2, 0.2]]] : []),
  ]}}));
  const collection = (selected: Feature[]): FeatureCollection => ({type: 'FeatureCollection', features: selected});
  let observer: ((batch: {cells: readonly number[]; edges: readonly number[]}) => void) | undefined;
  const identity = {path: ref.manifestPath, sha256: 'd'.repeat(64), byteLength: 0};
  const delivery = {
    bootstrap: {schemaVersion: 'operational-map-bootstrap-v1', catalog: {schemaVersion: 'operational-catalog-v1', catalogRef: ref, counts: {cells: 5, edges: 5, countries: 2, administrativeParents: 20, previousParents: 2}, countryOrder: ['AAA', 'BBB'],
      indexRoots: {catalogOrder: 'd'.repeat(64), administrativeMembership: 'e'.repeat(64), previousParent: 'f'.repeat(64)}}, manifest: identity, tileIndex: identity, detailIndex: identity, parents: identity, coverage: identity},
    source: {type: 'vector', tiles: ['pax-test:///tiles/{z}/{x}/{y}.pbf.gz'], minzoom: 0, maxzoom: 6}, protocol: 'pax-test',
    edgeIncidence: vi.fn((n: number) => pairs[n - 1]),
    incidentEdges: vi.fn((ordinals: readonly number[]) => pairs.flatMap((e, i) => ordinals.includes(e.left) || ordinals.includes(e.right) ? [i + 1] : [])),
    observeTileFeatures: vi.fn((listener: NonNullable<typeof observer>) => {observer = listener; listener({cells: [1, 2, 3, 4, 5], edges: [1, 2, 3, 4, 5]}); return () => {observer = undefined;};}),
    resolveCells: vi.fn(async (hints: readonly {id: string; sourceCountryId: string}[]) => hints.map(h => {
      const c = cells.find(c => c.id === h.id && c.sourceCountryId === h.sourceCountryId); if (!c) throw Error('UNKNOWN_CELL'); return c;
    })),
    loadCellDetail: vi.fn(async (hints: readonly {id: string}[]) => collection(features.filter((_, i) => hints.some(h => h.id === ids[i]))) as FeatureCollection<Polygon>),
    loadCountryDetail: vi.fn(async (country: string) => collection(features.filter((_, i) => cells[i].sourceCountryId === country)) as FeatureCollection<Polygon>),
    loadEdgeDetails: vi.fn(async (ordinals: readonly number[]) => ordinals.map(ordinal => ({id: `edge:operational:${String(ordinal).padStart(64, '0')}`, ordinal, ...pairs[ordinal - 1], boundaryClass: 'operational' as const,
      flags: {positiveAdjacency: pairs[ordinal - 1].right > 0, country: false, administrative: false, previous: false, residual: false}, geometry: {type: 'LineString' as const, coordinates: [[ordinal, 0], [ordinal, 1]]}}))),
    loadTile: vi.fn(), loadCountry: vi.fn(), loadParents: vi.fn(), administrativeMembership: vi.fn(), loadCoverage: vi.fn(), renderRef: vi.fn(), counters: vi.fn(),
  } satisfies OperationalVectorDelivery;
  const sources = new Map<string, {spec: SourceSpecification; features: Map<number, Feature>; updateData: ReturnType<typeof vi.fn>; setData: ReturnType<typeof vi.fn>}>();
  const layers = new Map<string, LayerSpecification>(), listeners = new Map<string, (event: {features?: {id: number; source: string; sourceLayer?: string}[]}) => void>();
  const states = new Map<string, Record<string, unknown>>();
  const map: OperationalMapPort = {
    addSource: (id, spec) => {
      const features = new Map<number, Feature>();
      sources.set(id, {spec, features, setData: vi.fn((data: FeatureCollection) => {features.clear(); for (const f of data.features) features.set(Number(f.id), f);}),
        updateData: vi.fn((diff: GeoJSONSourceDiff) => {for (const n of diff.remove ?? []) features.delete(Number(n)); for (const f of diff.add ?? []) features.set(Number(f.id), f);})});
    }, removeSource: id => sources.delete(id), getSource: id => sources.get(id), addLayer: layer => layers.set(layer.id, layer), removeLayer: id => layers.delete(id), getLayer: id => layers.get(id),
    setFeatureState: vi.fn((target, state) => {const key = `${target.source}:${target.sourceLayer ?? ''}:${target.id}`; states.set(key, {...states.get(key), ...state});}),
    on: (event, layer, listener) => listeners.set(`${event}:${layer}`, listener), off: (event, layer) => listeners.delete(`${event}:${layer}`),
  };
  const state = (n: number, edge = false) => states.get(`${OPERATIONAL_MAP_SOURCE_ID}:${edge ? 'edges' : 'territories'}:${n}`)!;
  const api = {addProtocol: vi.fn(), removeProtocol: vi.fn()};
  return {world, cells, delivery, map, sources, layers, states, state, api, listeners, features,
    emit: (batch: {cells: number[]; edges: number[]}) => observer?.(batch)};
}
function update(before: OperationalMapWorld, changes: Record<number, {controllerCountryId?: string; ownerCountryId?: string}>, revision = before.revision + 1) {
  const territoriesById = {...before.territoriesById};
  const cells = Object.entries(changes).map(([n, patch]) => {const id = ids[Number(n) - 1], a = before.territoriesById[id], b = createTerritoryEntityV3({...a, ...patch}); territoriesById[id] = b; return {id, before: a, after: b};});
  const world = {...before, revision, territoriesById};
  const change: OperationalStateChange = {catalogRef: ref, baseWorldRevision: before.revision, worldRevision: revision, cells};
  return {world, change};
}
async function mount(f = fixture()) {return {...f, consumer: await createOperationalMapConsumer({map: f.map, protocolApi: f.api, delivery: f.delivery, world: f.world})};}

describe('16-05 authoritative operational map projection', () => {
  it('mounts valid controller-color layers, separate real borders and hidden synthetic cells', async () => {
    const f = await mount();
    const acceptsRealMap = (map: MapLibreMap) => createOperationalMapConsumer({map, protocolApi: f.api, delivery: f.delivery, world: f.world});
    expect(typeof acceptsRealMap).toBe('function');
    expect(validateStyleMin({version: 8, sources: Object.fromEntries([...f.sources].map(([id, s]) => [id, s.spec])), layers: [...f.layers.values()]})).toEqual([]);
    expect(f.layers.get(L.administrative)).toMatchObject({'source-layer': 'administrative', minzoom: 4});
    expect(f.layers.get(L.detailAdministrative)).toMatchObject({minzoom: 4});
    for (const id of [L.synthetic, L.detailSynthetic]) expect(f.layers.get(id)).toMatchObject({minzoom: 8, layout: {visibility: 'none'}});
    expect(f.state(1)).toMatchObject({mapColor: '#0000FF', occupied: false});
    expect(f.state(1, true).front).toBe(false); expect(f.state(3, true).front).toBe(false); expect(f.state(4, true).front).toBe(true);
    expect(f.delivery.loadCellDetail).not.toHaveBeenCalled(); f.consumer.dispose(); expect(f.layers.size).toBe(0); expect(f.sources.size).toBe(0);
  });

  it('shows partial occupation inside one administrative parent, preserves the polygon hole and updates only incident edges', async () => {
    const f = await mount(), next = update(f.world, {1: {controllerCountryId: 'AAA'}}), vector = f.sources.get(OPERATIONAL_MAP_SOURCE_ID);
    vi.mocked(f.map.setFeatureState).mockClear();
    await f.consumer.updateWorld(next.world, next.change);
    expect(next.world.territoriesById[ids[0]].ownerCountryId).toBe('BBB'); expect(f.world.territoriesById[ids[0]].controllerCountryId).toBe('BBB');
    expect(f.state(1)).toMatchObject({mapColor: '#FF0000', occupied: true, exactCell: true}); expect(f.state(2)).toMatchObject({mapColor: '#0000FF', occupied: false});
    expect(f.cells[0].administrativeOrdinal).toBe(f.cells[1].administrativeOrdinal);
    expect(f.state(1, true)).toMatchObject({front: true, exactFront: true}); expect(f.state(3, true).front).toBe(false);
    expect(f.sources.get(OPERATIONAL_CHANGED_CELL_SOURCE_ID)!.features.get(1)!.geometry).toEqual(f.features[0].geometry);
    expect([...f.sources.get(OPERATIONAL_FRONT_SOURCE_ID)!.features.keys()]).toEqual([1]);
    const edgeWrites = vi.mocked(f.map.setFeatureState).mock.calls.filter(([t]) => t.sourceLayer === 'edges').map(([t]) => t.id);
    expect(edgeWrites).toEqual([1, 3]); expect(f.sources.get(OPERATIONAL_MAP_SOURCE_ID)).toBe(vector);
    for (const source of f.sources.values()) expect(source.setData).not.toHaveBeenCalled();
    expect(f.consumer.getUpdateStats()).toMatchObject({fullProjectionBuilds: 1, edgesExamined: 2, updates: 1}); f.consumer.dispose();
  });

  it('moves the front after the next advance and removes the same-controller internal edge', async () => {
    const f = await mount(), first = update(f.world, {1: {controllerCountryId: 'AAA'}}); await f.consumer.updateWorld(first.world, first.change);
    const second = update(first.world, {2: {controllerCountryId: 'AAA'}}); await f.consumer.updateWorld(second.world, second.change);
    expect(f.state(1, true).front).toBe(false); expect(f.state(2, true)).toMatchObject({front: true, exactFront: true});
    expect([...f.sources.get(OPERATIONAL_FRONT_SOURCE_ID)!.features.keys()]).toEqual([2]);
    expect(f.sources.get(OPERATIONAL_FRONT_SOURCE_ID)!.updateData).toHaveBeenLastCalledWith(expect.objectContaining({remove: [1], add: [expect.objectContaining({id: 2})]}));
    f.consumer.dispose();
  });

  it('uses the same snapshot path for liberation, undo/redo and ownership transfer', async () => {
    const f = await mount(), occupied = update(f.world, {1: {controllerCountryId: 'AAA'}}); await f.consumer.updateWorld(occupied.world, occupied.change);
    const liberated = update(occupied.world, {1: {controllerCountryId: 'BBB'}}); await f.consumer.updateWorld(liberated.world);
    expect(f.state(1)).toMatchObject({mapColor: '#0000FF', occupied: false}); expect(f.state(1, true).front).toBe(false);
    await f.consumer.updateWorld({...occupied.world, revision: 3}); expect(f.state(1)).toMatchObject({mapColor: '#FF0000', occupied: true});
    await f.consumer.updateWorld({...liberated.world, revision: 4}); expect(f.state(1)).toMatchObject({mapColor: '#0000FF', occupied: false});
    const transfer = update({...liberated.world, revision: 4}, {1: {ownerCountryId: 'CCC', controllerCountryId: 'CCC'}}); await f.consumer.updateWorld(transfer.world, transfer.change);
    expect(f.state(1)).toMatchObject({ownerCountryId: 'CCC', controllerCountryId: 'CCC', mapColor: '#00FF00', occupied: false});
    const preserve = update(transfer.world, {1: {ownerCountryId: 'AAA'}}); await f.consumer.updateWorld(preserve.world, preserve.change);
    expect(f.state(1)).toMatchObject({ownerCountryId: 'AAA', controllerCountryId: 'CCC', mapColor: '#00FF00', occupied: true});
    expect(f.delivery.loadCellDetail).toHaveBeenCalledTimes(1); expect(f.consumer.getUpdateStats().fullProjectionBuilds).toBe(1); f.consumer.dispose();
  });

  it('updates occupied cells when the controller color changes and preserves country selection and hit identity', async () => {
    const f = await mount(), occupied = update(f.world, {1: {controllerCountryId: 'AAA'}}); await f.consumer.updateWorld(occupied.world, occupied.change);
    f.consumer.selectCountry('BBB'); expect(f.state(1).selected).toBe(true);
    const next = {...occupied.world, revision: 2, countriesById: {...occupied.world.countriesById, AAA: {mapColor: '#ABCDEF'}}};
    const before = f.delivery.loadCellDetail.mock.calls.length; await f.consumer.updateWorld(next, {catalogRef: ref, baseWorldRevision: 1, worldRevision: 2, cells: []});
    expect(f.state(1)).toMatchObject({mapColor: '#ABCDEF', selected: true}); expect(f.state(4).mapColor).toBe('#ABCDEF'); expect(f.state(2).mapColor).toBe('#0000FF');
    expect(f.delivery.loadCellDetail.mock.calls.length).toBe(before);
    f.listeners.get(`click:${L.changedFill}`)!({features: [{id: 1, source: OPERATIONAL_CHANGED_CELL_SOURCE_ID}]});
    expect(f.state(1).selected).toBe(true); f.consumer.dispose();
  });

  it('rejects stale or forged deltas before map writes and can retry a valid update', async () => {
    const f = await mount(), next = update(f.world, {1: {controllerCountryId: 'AAA'}}); vi.mocked(f.map.setFeatureState).mockClear();
    for (const change of [{...next.change, baseWorldRevision: 99}, {...next.change, catalogRef: {...ref, geometryRoot: '0'.repeat(64)}},
      {...next.change, cells: [{...next.change.cells[0], after: f.world.territoriesById[ids[0]]}]},
      {...next.change, cells: [{...next.change.cells[0], id: readCatalogTerritoryId(`territory:catalog:${'f'.repeat(64)}`)}]},
      {...next.change, cells: [next.change.cells[0], next.change.cells[0]]}]) {
      await expect(f.consumer.updateWorld(next.world, change)).rejects.toThrow();
    }
    expect(f.consumer.getProjection().world).toBe(f.world); expect(f.map.setFeatureState).not.toHaveBeenCalled();
    expect(f.sources.get(OPERATIONAL_CHANGED_CELL_SOURCE_ID)!.updateData).not.toHaveBeenCalled();
    await f.consumer.updateWorld(next.world, next.change); await expect(f.consumer.updateWorld({...f.world})).rejects.toThrow('STALE'); f.consumer.dispose();
  });

  it('keeps the prior projection when exact loading fails, then applies a retry', async () => {
    const f = await mount(), next = update(f.world, {1: {controllerCountryId: 'AAA'}});
    f.delivery.loadEdgeDetails.mockRejectedValueOnce(Error('network'));
    await expect(f.consumer.updateWorld(next.world, next.change)).rejects.toThrow('network');
    expect(f.consumer.getProjection().world).toBe(f.world); expect(f.sources.get(OPERATIONAL_CHANGED_CELL_SOURCE_ID)!.features.size).toBe(0);
    await f.consumer.updateWorld(next.world, next.change); expect(f.state(1).mapColor).toBe('#FF0000'); f.consumer.dispose();
  });

  it('serializes rapid updates and ignores pending geometry after disposal', async () => {
    const f = await mount(), first = update(f.world, {1: {controllerCountryId: 'AAA'}}), second = update(first.world, {2: {controllerCountryId: 'AAA'}});
    let release!: () => void; const pending = new Promise<void>(resolve => {release = resolve;}), original = f.delivery.loadCellDetail.getMockImplementation()!;
    f.delivery.loadCellDetail.mockImplementationOnce(async hints => {await pending; return original(hints);});
    const one = f.consumer.updateWorld(first.world, first.change), two = f.consumer.updateWorld(second.world, second.change);
    release(); await Promise.all([one, two]); expect(f.consumer.getProjection().appliedRevision).toBe(2); expect(f.state(1, true).front).toBe(false); expect(f.state(2, true).front).toBe(true);
    f.consumer.dispose();
    const g = await mount(); let finish!: () => void; const wait = new Promise<void>(resolve => {finish = resolve;});
    g.delivery.loadCellDetail.mockImplementationOnce(async () => {await wait; return {type: 'FeatureCollection', features: [g.features[0]]};});
    const inFlight = g.consumer.updateWorld(first.world, first.change); await Promise.resolve(); await Promise.resolve();
    g.consumer.dispose(); finish(); await expect(inFlight).rejects.toThrow(); expect(g.sources.size).toBe(0);
  });

  it('restores occupied snapshots and refreshes exact detail without rebuilding the vector source', async () => {
    const f = await mount(fixture(true));
    expect(f.state(1)).toMatchObject({mapColor: '#FF0000', occupied: true}); expect(f.sources.get(OPERATIONAL_CHANGED_CELL_SOURCE_ID)!.features.has(1)).toBe(true);
    const vector = f.sources.get(OPERATIONAL_MAP_SOURCE_ID); await f.consumer.showCountryDetail('BBB');
    expect(f.state(2).exactCell).toBe(true); f.consumer.clearDetail(); expect(f.state(2).exactCell).toBe(false); expect(f.state(1).exactCell).toBe(true);
    f.emit({cells: [1], edges: [1]}); expect(f.state(1).mapColor).toBe('#FF0000'); expect(f.sources.get(OPERATIONAL_MAP_SOURCE_ID)).toBe(vector); f.consumer.dispose();
  });
});
