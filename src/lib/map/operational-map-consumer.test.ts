// @vitest-environment node
import {afterEach, describe, expect, it, vi} from 'vitest';
import {createRequire} from 'node:module';
import {createExpression, validateStyleMin} from '@maplibre/maplibre-gl-style-spec';
import type {Feature, FeatureCollection, Polygon} from 'geojson';
import type {GeoJSONSourceDiff, LayerSpecification, LineLayerSpecification, Map as MapLibreMap, SourceSpecification} from 'maplibre-gl';
import {createTerritoryEntityV3} from '../world/territory-entity-v3';
import {createWorldGeometryCatalogRef, readCatalogTerritoryId} from '../world/world-geometry-catalog-ref';
import type {OperationalCell, OperationalStateChange} from '../world/operational-catalog';
import type {OperationalMapWorld} from '../projection/operational-map-projection';
import * as projection from '../projection/operational-map-projection';
import {createOperationalMapConsumer, OPERATIONAL_CHANGED_CELL_SOURCE_ID, OPERATIONAL_FRONT_SOURCE_ID, OPERATIONAL_MAP_LAYERS as L, type OperationalMapPort} from './operational-map-consumer';
import {OPERATIONAL_MAP_SOURCE_ID} from './operational-delivery-contract';
import type {OperationalVectorDelivery} from './operational-vector-delivery';
import {OPERATIONAL_EXACT_CELL_SOURCE_ID, OPERATIONAL_EXACT_EDGE_SOURCE_ID} from './operational-map-sources';

afterEach(() => vi.restoreAllMocks());

const ref = createWorldGeometryCatalogRef({catalogVersion: 'catalog-v3-fixture', geometryRoot: 'a'.repeat(64), topologyRoot: 'b'.repeat(64), renderArtifactRoot: 'c'.repeat(64), manifestPath: '/data/territory-catalog/catalog-v3-fixture/manifest.json'});
const ids = [1, 2, 3, 4, 5].map(n => readCatalogTerritoryId(`territory:catalog:${String(n).padStart(64, '0')}`));
function fixture(occupied = false, observeInitially = true) {
  const cells: OperationalCell[] = ids.map((id, i) => ({id, ordinal: i + 1, sourceCountryId: i < 3 ? 'BBB' : 'AAA', administrativeOrdinal: i < 3 ? 10 : 20, previousParentOrdinal: i < 3 ? 1 : 2})) as OperationalCell[];
  const world: OperationalMapWorld = {catalogRef: ref, revision: 0, territoryOrder: ids,
    countriesById: {AAA: {mapColor: '#FF0000'}, BBB: {mapColor: '#0000FF'}, CCC: {mapColor: '#00FF00'}},
    territoriesById: Object.fromEntries(cells.map(c => [c.id, createTerritoryEntityV3({id: c.id, sourceCountryId: c.sourceCountryId, ownerCountryId: c.sourceCountryId, controllerCountryId: occupied && c.ordinal === 1 ? 'AAA' : c.sourceCountryId})]))};
  const pairs = [{left: 1, right: 2}, {left: 2, right: 3}, {left: 1, right: 0}, {left: 3, right: 4}, {left: 4, right: 5}];
  const edgeClasses = [3, 3, 0, 1, 3];
  const features: Feature<Polygon>[] = cells.map(c => ({type: 'Feature', id: c.ordinal, properties: {}, geometry: {type: 'Polygon', coordinates: [
    [[c.ordinal, 0], [c.ordinal + 1, 0], [c.ordinal + 1, 1], [c.ordinal, 1], [c.ordinal, 0]],
    ...(c.ordinal === 1 ? [[[1.2, 0.2], [1.2, 0.3], [1.3, 0.3], [1.3, 0.2], [1.2, 0.2]]] : []),
  ]}}));
  const collection = (selected: Feature[]): FeatureCollection => ({type: 'FeatureCollection', features: selected});
  let observer: ((batch: {cells: readonly number[]; edges: readonly number[]}) => void) | undefined;
  const identity = {path: ref.manifestPath, sha256: 'd'.repeat(64), byteLength: 0};
  const delivery = {
    bootstrap: {schemaVersion: 'operational-map-bootstrap-v1', legacyBoundaryOrdinals: [] as number[], catalog: {schemaVersion: 'operational-catalog-v1', catalogRef: ref, counts: {cells: 5, edges: 5, countries: 2, administrativeParents: 20, previousParents: 2}, countryOrder: ['AAA', 'BBB'],
      indexRoots: {catalogOrder: 'd'.repeat(64), administrativeMembership: 'e'.repeat(64), previousParent: 'f'.repeat(64)}}, manifest: identity, tileIndex: identity, detailIndex: identity, parents: identity, coverage: identity},
    source: {type: 'vector', tiles: ['pax-test:///tiles/{z}/{x}/{y}.pbf.gz'], minzoom: 0, maxzoom: 6}, protocol: 'pax-test',
    edgeIncidence: vi.fn((n: number) => pairs[n - 1]),
    incidentEdges: vi.fn((ordinals: readonly number[]) => pairs.flatMap((e, i) => ordinals.includes(e.left) || ordinals.includes(e.right) ? [i + 1] : [])),
    observeTileFeatures: vi.fn((listener: NonNullable<typeof observer>) => {observer = listener; if (observeInitially) listener({cells: [1, 2, 3, 4, 5], edges: [1, 2, 3, 4, 5]}); return () => {observer = undefined;};}),
    resolveCells: vi.fn(async (hints: readonly {id: string; sourceCountryId: string}[]) => hints.map(h => {
      const c = cells.find(c => c.id === h.id && c.sourceCountryId === h.sourceCountryId); if (!c) throw Error('UNKNOWN_CELL'); return c;
    })),
    loadCellDetail: vi.fn(async (hints: readonly {id: string}[]) => collection(features.filter((_, i) => hints.some(h => h.id === ids[i]))) as FeatureCollection<Polygon>),
    loadCountryDetail: vi.fn(async (country: string) => collection(features.filter((_, i) => cells[i].sourceCountryId === country)) as FeatureCollection<Polygon>),
    loadEdgeDetails: vi.fn(async (ordinals: readonly number[]) => ordinals.map(ordinal => ({id: `edge:operational:${String(ordinal).padStart(64, '0')}`, ordinal, ...pairs[ordinal - 1], boundaryClass: (['coast', 'country', 'administrative', 'operational', 'residual'] as const)[edgeClasses[ordinal - 1]],
      flags: {positiveAdjacency: pairs[ordinal - 1].right > 0, country: edgeClasses[ordinal - 1] === 1, administrative: edgeClasses[ordinal - 1] === 2, previous: false, residual: edgeClasses[ordinal - 1] === 4}, geometry: {type: 'LineString' as const, coordinates: [[ordinal, 0], [ordinal, 1]]}}))),
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
    setLayoutProperty: vi.fn((id, name, value) => {
      const layer = layers.get(id);
      if (!layer || layer.type !== 'line' || name !== 'visibility') throw Error('INVALID_LAYOUT_TARGET');
      layer.layout = {...layer.layout, visibility: value as 'visible' | 'none'};
    }),
    setFeatureState: vi.fn((target, state) => {
      if (target.source !== OPERATIONAL_MAP_SOURCE_ID && !sources.get(target.source)?.features.has(Number(target.id))) throw Error('STATE_WITHOUT_SOURCE_FEATURE');
      const key = `${target.source}:${target.sourceLayer ?? ''}:${target.id}`; states.set(key, {...states.get(key), ...state});
    }),
    removeFeatureState: vi.fn(target => states.delete(`${target.source}:${target.sourceLayer ?? ''}:${target.id}`)),
    on: (event, layer, listener) => listeners.set(`${event}:${layer}`, listener), off: (event, layer) => listeners.delete(`${event}:${layer}`),
  };
  const state = (n: number, edge = false) => states.get(`${OPERATIONAL_MAP_SOURCE_ID}:${edge ? 'edges' : 'territories'}:${n}`)!;
  const sourceState = (source: string, n: number) => states.get(`${source}::${n}`);
  const baseFrontOpacity = (n: number, boundaryClass = edgeClasses[n - 1]) => {
    const layer = layers.get(L.front) as LineLayerSpecification;
    const expression = createExpression(['case', layer.filter, layer.paint!['line-opacity'], 0]);
    if (expression.result !== 'success') throw Error(JSON.stringify(expression.value));
    return expression.value.evaluate({zoom: 1}, {type: 'LineString', id: n, properties: {c: boundaryClass}}, state(n, true) ?? {});
  };
  const front = (n: number) => baseFrontOpacity(n) > 0 || sources.get(OPERATIONAL_FRONT_SOURCE_ID)!.features.has(n);
  const api = {addProtocol: vi.fn(), removeProtocol: vi.fn()};
  return {world, cells, delivery, map, sources, layers, states, state, sourceState, front, baseFrontOpacity, edgeClasses, api, listeners, features,
    emit: (batch: {cells: number[]; edges: number[]}) => observer?.(batch)};
}
function update(before: OperationalMapWorld, changes: Record<number, {controllerCountryId?: string | null; ownerCountryId?: string | null}>, revision = before.revision + 1) {
  const territoriesById = {...before.territoriesById};
  const cells = Object.entries(changes).map(([n, patch]) => {const id = ids[Number(n) - 1], a = before.territoriesById[id], b = createTerritoryEntityV3({...a, ...patch}); territoriesById[id] = b; return {id, before: a, after: b};});
  const world = {...before, revision, territoriesById};
  const change: OperationalStateChange = {catalogRef: ref, baseWorldRevision: before.revision, worldRevision: revision, cells};
  return {world, change};
}
async function mount(f = fixture(), callbacks: Pick<Parameters<typeof createOperationalMapConsumer>[0], 'onSelect' | 'onHover' | 'onTerritorySelect'> = {}) {
  return {...f, consumer: await createOperationalMapConsumer({map: f.map, protocolApi: f.api, delivery: f.delivery, world: f.world, ...callbacks})};
}
function deferred<Value>() {
  let resolve!: (value: Value) => void, reject!: (error: Error) => void;
  const promise = new Promise<Value>((yes, no) => {resolve = yes; reject = no;});
  return {promise, resolve, reject};
}

describe('16-05 authoritative operational map projection', () => {
  it('mounts black peaceful country borders and hides every internal boundary layer', async () => {
    const f = await mount();
    const acceptsRealMap = (map: MapLibreMap) => createOperationalMapConsumer({map, protocolApi: f.api, delivery: f.delivery, world: f.world});
    expect(typeof acceptsRealMap).toBe('function');
    expect(validateStyleMin({version: 8, sources: Object.fromEntries([...f.sources].map(([id, s]) => [id, s.spec])), layers: [...f.layers.values()]})).toEqual([]);
    expect(f.layers.get(L.administrative)).toMatchObject({'source-layer': 'edges', minzoom: 2.2, layout: {visibility: 'visible'}, paint: {'line-color': '#FFFFFF'}});
    expect(f.layers.get(L.detailAdministrative)).toMatchObject({minzoom: 2.2, layout: {visibility: 'visible'}, paint: {'line-color': '#FFFFFF'}});
    for (const id of [L.country, L.detailCountry]) expect(f.layers.get(id)).toMatchObject({paint: {'line-color': '#000000'}});
    for (const id of [OPERATIONAL_EXACT_CELL_SOURCE_ID, OPERATIONAL_EXACT_EDGE_SOURCE_ID, OPERATIONAL_CHANGED_CELL_SOURCE_ID, OPERATIONAL_FRONT_SOURCE_ID]) {
      expect(f.sources.get(id)!.spec).toMatchObject({type: 'geojson', tolerance: 0});
    }
    for (const id of [L.fill, L.detailFill, L.changedFill]) expect(f.layers.get(id)).toMatchObject({paint: {'fill-antialias': false}});
    for (const id of [L.synthetic, L.detailSynthetic]) expect(f.layers.get(id)).toMatchObject({minzoom: 2.2, layout: {visibility: 'none'}});
    expect(f.state(1)).toMatchObject({mapColor: '#0000FF', occupied: false});
    expect(f.layers.get(L.front)).toMatchObject({filter: ['==', ['get', 'c'], 1]});
    for (const n of [1, 2, 3, 4, 5]) expect(f.front(n)).toBe(false);
    for (const c of [0, 1, 2, 3, 4]) expect(f.baseFrontOpacity(4, c)).toBe(0);
    expect(vi.mocked(f.map.setFeatureState).mock.calls.filter(([target]) => target.sourceLayer === 'edges')).toHaveLength(0);
    expect(f.map.setFeatureState).toHaveBeenCalledTimes(5); // Only observed vector cells; exact sources are empty.
    expect(Object.keys(f.state(1)).sort()).toEqual(['exactCell', 'hover', 'mapColor', 'occupied', 'selected', 'selectionColor']);
    expect(f.sourceState(OPERATIONAL_EXACT_CELL_SOURCE_ID, 1)).toBeUndefined(); expect(f.sourceState(OPERATIONAL_CHANGED_CELL_SOURCE_ID, 1)).toBeUndefined();
    expect(f.map.removeFeatureState).not.toHaveBeenCalled(); expect(f.delivery.edgeIncidence).not.toHaveBeenCalled();
    expect(f.delivery.loadCellDetail).not.toHaveBeenCalled(); f.consumer.dispose(); expect(f.layers.size).toBe(0); expect(f.sources.size).toBe(0);
  });

  it('retains continuous low-zoom land when it is partitioned into individually subpixel cells', async () => {
    const f = await mount();
    type Tile = {features: {geometry: number[][][]}[]};
    const geojsonvt = createRequire(import.meta.url)('geojson-vt').default as (data: FeatureCollection, options: {tolerance: number; maxZoom: number}) => {getTile: (z: number, x: number, y: number) => Tile | null};
    const rectangle = (west: number, south: number, east: number, north: number): Feature<Polygon> => ({type: 'Feature', properties: {}, geometry: {type: 'Polygon',
      coordinates: [[[west, south], [east, south], [east, north], [west, north], [west, south]]]}});
    const features: Feature<Polygon>[] = [];
    for (let x = 0; x < 32; x++) for (let y = 0; y < 32; y++) features.push(rectangle(126.8 + x / 160, 37.2 + y / 160, 126.8 + (x + 1) / 160, 37.2 + (y + 1) / 160));
    const area = (data: FeatureCollection, tolerance: number) => geojsonvt(data, {tolerance, maxZoom: 9}).getTile(1, 1, 0)?.features.reduce((sum, feature) =>
      sum + feature.geometry.reduce((total, ring) => total + Math.abs(ring.reduce((value, b, i) => {
        const a = ring[(i + ring.length - 1) % ring.length]; return value + a[0] * b[1] - b[0] * a[1];
      }, 0) / 2), 0), 0) ?? 0;
    const envelope = {type: 'FeatureCollection' as const, features: [rectangle(126.8, 37.2, 127, 37.4)]}, partitions = {type: 'FeatureCollection' as const, features};
    const expected = area(envelope, 0), options = f.sources.get(OPERATIONAL_EXACT_CELL_SOURCE_ID)!.spec;
    if (options.type !== 'geojson') throw Error('Expected exact GeoJSON source');
    expect(expected).toBeGreaterThan(0);
    expect(area(partitions, 0.375)).toBeLessThan(expected);
    expect(area(partitions, options.tolerance!)).toBe(expected);
    f.consumer.dispose();
  });

  it('retains hidden administrative data for selection without exposing it on country detail or occupation', async () => {
    const input = fixture(); input.edgeClasses[0] = 2;
    const f = await mount(input);
    await f.consumer.showCountryDetail('BBB');
    expect(f.delivery.incidentEdges).toHaveBeenCalledWith([1, 2, 3]);
    expect(f.delivery.loadEdgeDetails).toHaveBeenLastCalledWith([1, 2, 3, 4], expect.any(AbortSignal));
    const boundaries = f.sources.get(OPERATIONAL_EXACT_EDGE_SOURCE_ID)!;
    expect(boundaries.features.get(1)).toMatchObject({properties: {administrative: true, boundaryClass: 'administrative'}, geometry: {coordinates: [[1, 0], [1, 1]]}});
    expect(f.layers.get(L.detailAdministrative)).toMatchObject({filter: ['==', ['id'], -1], layout: {visibility: 'visible'}});
    f.consumer.selectCountry('BBB'); f.consumer.hoverCountry('BBB');
    const occupied = update(f.world, {1: {controllerCountryId: 'AAA'}}); await f.consumer.updateWorld(occupied.world, occupied.change);
    expect(f.front(1)).toBe(true);
    for (const id of [L.synthetic, L.detailSynthetic]) expect(f.layers.get(id)).toMatchObject({layout: {visibility: 'none'}});
    f.consumer.clearDetail(); expect(boundaries.features.size).toBe(0); expect(f.front(4)).toBe(false); expect(f.front(1)).toBe(true);
    f.consumer.dispose();
  });

  it('separates original ADM1 boundaries from debug-only fine boundaries without data or world updates', async () => {
    const input = fixture(); input.delivery.bootstrap.legacyBoundaryOrdinals = [2];
    input.edgeClasses[0] = 2; input.edgeClasses[1] = 2;
    const f = await mount(input), before = f.consumer.getProjection(), vector = f.sources.get(OPERATIONAL_MAP_SOURCE_ID);
    expect(f.layers.get(L.administrative)).toMatchObject({filter: ['match', ['id'], [2], true, false]});
    const matches = (layerId: string, edgeId: number, exact = false, kind = 'administrative') => {
      const expression = createExpression((f.layers.get(layerId) as LineLayerSpecification).filter);
      if (expression.result !== 'success') throw Error(JSON.stringify(expression.value));
      return expression.value.evaluate({zoom: 6}, {type: 'LineString', id: edgeId, properties: exact ? {boundaryClass: kind} : {c: kind === 'country' ? 1 : 2}});
    };
    for (const [legacy, micro, exact] of [[L.administrative, L.synthetic, false], [L.detailAdministrative, L.detailSynthetic, true]] as const) {
      expect(matches(legacy, 2, exact)).toBe(true); expect(matches(legacy, 1, exact)).toBe(false);
      expect(matches(micro, 1, exact)).toBe(true); expect(matches(micro, 2, exact)).toBe(false);
      expect(matches(micro, 4, exact, 'country')).toBe(false);
    }
    f.consumer.setDebugBoundaries(true);
    for (const id of [L.synthetic, L.detailSynthetic]) expect(f.layers.get(id)).toMatchObject({layout: {visibility: 'visible'}});
    await f.consumer.showCountryDetail('BBB'); f.consumer.clearDetail();
    for (const id of [L.synthetic, L.detailSynthetic]) expect(f.layers.get(id)).toMatchObject({layout: {visibility: 'visible'}});
    const loaded = f.delivery.loadEdgeDetails.mock.calls.length;
    f.consumer.setDebugBoundaries(false);
    for (const id of [L.synthetic, L.detailSynthetic]) expect(f.layers.get(id)).toMatchObject({layout: {visibility: 'none'}});
    for (const id of [L.administrative, L.detailAdministrative]) expect(f.layers.get(id)).toMatchObject({layout: {visibility: 'visible'}, paint: {'line-color': '#FFFFFF'}});
    expect(f.consumer.getProjection()).toBe(before); expect(f.sources.get(OPERATIONAL_MAP_SOURCE_ID)).toBe(vector);
    expect(f.delivery.loadEdgeDetails).toHaveBeenCalledTimes(loaded); expect(f.consumer.getUpdateStats().updates).toBe(0);
    for (const source of f.sources.values()) expect(source.updateData).not.toHaveBeenCalled();
    f.consumer.dispose();
  });

  it('replaces simplified country, legacy and micro lines with exact detail instead of drawing both', async () => {
    const input = fixture(); input.delivery.bootstrap.legacyBoundaryOrdinals = [2];
    input.edgeClasses[0] = 2; input.edgeClasses[1] = 2;
    const f = await mount(input); f.consumer.setDebugBoundaries(true);
    const opacity = (layerId: string, n: number) => {
      const expression = createExpression((f.layers.get(layerId) as LineLayerSpecification).paint!['line-opacity']);
      if (expression.result !== 'success') throw Error(JSON.stringify(expression.value));
      return expression.value.evaluate({zoom: 6}, {type: 'LineString', id: n, properties: {}}, f.state(n, true) ?? {});
    };
    const cases = [[L.country, L.detailCountry, 4], [L.administrative, L.detailAdministrative, 2], [L.synthetic, L.detailSynthetic, 1]] as const;
    for (const [vector, , n] of cases) expect(opacity(vector, n)).toBeGreaterThan(0);
    await f.consumer.showCountryDetail('BBB');
    for (const [vector, exact, n] of cases) {
      expect(opacity(vector, n)).toBe(0); expect(opacity(exact, n)).toBeGreaterThan(0);
      expect(f.sources.get(OPERATIONAL_EXACT_EDGE_SOURCE_ID)!.features.has(n)).toBe(true);
    }
    expect(opacity(L.synthetic, 5)).toBeGreaterThan(0); // A different country's edge is not masked.
    f.emit({cells: [1, 2, 3], edges: [1, 2, 3, 4]});
    for (const [vector, , n] of cases) expect(opacity(vector, n)).toBe(0);
    f.consumer.clearDetail();
    for (const [vector, , n] of cases) expect(opacity(vector, n)).toBeGreaterThan(0);
    expect(f.sources.get(OPERATIONAL_EXACT_EDGE_SOURCE_ID)!.features.size).toBe(0);
    f.consumer.dispose();
  });

  it('preserves the detail mask when fronts disappear and preserves fronts when detail closes', async () => {
    const f = await mount(); await f.consumer.showCountryDetail('BBB');
    const occupied = update(f.world, {1: {controllerCountryId: 'AAA'}});
    await f.consumer.updateWorld(occupied.world, occupied.change);
    expect(f.state(1, true)).toMatchObject({detailEdge: true, front: true, exactFront: true});
    const liberated = update(occupied.world, {1: {controllerCountryId: 'BBB'}});
    await f.consumer.updateWorld(liberated.world, liberated.change);
    expect(f.state(1, true)).toMatchObject({detailEdge: true, front: false, exactFront: false});
    const restored = update(liberated.world, {1: {controllerCountryId: 'AAA'}});
    await f.consumer.updateWorld(restored.world, restored.change);
    f.consumer.clearDetail();
    expect(f.state(1, true)).toMatchObject({detailEdge: false, front: true, exactFront: true});
    expect(f.front(1)).toBe(true); f.consumer.dispose();
  });

  it('shows partial occupation inside one administrative parent, preserves the polygon hole and updates only incident edges', async () => {
    const f = await mount(), next = update(f.world, {1: {controllerCountryId: 'AAA'}}), vector = f.sources.get(OPERATIONAL_MAP_SOURCE_ID);
    vi.mocked(f.map.setFeatureState).mockClear();
    await f.consumer.updateWorld(next.world, next.change);
    expect(next.world.territoriesById[ids[0]].ownerCountryId).toBe('BBB'); expect(f.world.territoriesById[ids[0]].controllerCountryId).toBe('BBB');
    expect(f.state(1)).toMatchObject({mapColor: '#FF0000', occupied: true, exactCell: true}); expect(f.state(2)).toMatchObject({mapColor: '#0000FF', occupied: false});
    expect(f.cells[0].administrativeOrdinal).toBe(f.cells[1].administrativeOrdinal);
    expect(f.state(1, true)).toMatchObject({front: true, exactFront: true}); expect(f.front(1)).toBe(true); expect(f.front(3)).toBe(false);
    expect(f.sources.get(OPERATIONAL_CHANGED_CELL_SOURCE_ID)!.features.get(1)!.geometry).toEqual(f.features[0].geometry);
    expect([...f.sources.get(OPERATIONAL_FRONT_SOURCE_ID)!.features.keys()]).toEqual([1]);
    const edgeWrites = vi.mocked(f.map.setFeatureState).mock.calls.filter(([t]) => t.sourceLayer === 'edges').map(([t]) => t.id);
    expect(edgeWrites).toEqual([1]); expect(f.sources.get(OPERATIONAL_MAP_SOURCE_ID)).toBe(vector);
    for (const source of f.sources.values()) expect(source.setData).not.toHaveBeenCalled();
    expect(f.consumer.getUpdateStats()).toMatchObject({fullProjectionBuilds: 1, edgesExamined: 2, updates: 1}); f.consumer.dispose();
  });

  it('moves the front after the next advance and removes the same-controller internal edge', async () => {
    const f = await mount(), first = update(f.world, {1: {controllerCountryId: 'AAA'}}); await f.consumer.updateWorld(first.world, first.change);
    const second = update(first.world, {2: {controllerCountryId: 'AAA'}}); await f.consumer.updateWorld(second.world, second.change);
    expect(f.front(1)).toBe(false); expect(f.state(1, true)).toBeUndefined(); expect(f.state(2, true)).toMatchObject({front: true, exactFront: true}); expect(f.front(2)).toBe(true);
    expect([...f.sources.get(OPERATIONAL_FRONT_SOURCE_ID)!.features.keys()]).toEqual([2]);
    expect(f.sources.get(OPERATIONAL_FRONT_SOURCE_ID)!.updateData).toHaveBeenLastCalledWith(expect.objectContaining({remove: [1], add: [expect.objectContaining({id: 2})]}));
    f.consumer.dispose();
  });

  it('uses the same snapshot path for liberation, undo/redo and ownership transfer', async () => {
    const f = await mount(), occupied = update(f.world, {1: {controllerCountryId: 'AAA'}}); await f.consumer.updateWorld(occupied.world, occupied.change);
    const liberated = update(occupied.world, {1: {controllerCountryId: 'BBB'}}); await f.consumer.updateWorld(liberated.world);
    expect(f.state(1)).toMatchObject({mapColor: '#0000FF', occupied: false}); expect(f.front(1)).toBe(false); expect(f.state(1, true)).toBeUndefined();
    await f.consumer.updateWorld({...occupied.world, revision: 3}); expect(f.state(1)).toMatchObject({mapColor: '#FF0000', occupied: true});
    await f.consumer.updateWorld({...liberated.world, revision: 4}); expect(f.state(1)).toMatchObject({mapColor: '#0000FF', occupied: false});
    const transfer = update({...liberated.world, revision: 4}, {1: {ownerCountryId: 'CCC', controllerCountryId: 'CCC'}}); await f.consumer.updateWorld(transfer.world, transfer.change);
    expect(f.state(1)).toMatchObject({mapColor: '#00FF00', occupied: false});
    expect(f.consumer.getProjection().world.territoriesById[ids[0]]).toMatchObject({ownerCountryId: 'CCC', controllerCountryId: 'CCC'});
    expect(f.front(1)).toBe(false); expect(f.front(4)).toBe(false);
    const preserve = update(transfer.world, {1: {ownerCountryId: 'AAA'}}); await f.consumer.updateWorld(preserve.world, preserve.change);
    expect(f.state(1)).toMatchObject({mapColor: '#00FF00', occupied: true});
    expect(f.front(1)).toBe(true); expect(f.front(4)).toBe(false);
    expect(f.consumer.getProjection().world.territoriesById[ids[0]]).toMatchObject({ownerCountryId: 'AAA', controllerCountryId: 'CCC'});
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
    release(); await Promise.all([one, two]); expect(f.consumer.getProjection().appliedRevision).toBe(2); expect(f.front(1)).toBe(false); expect(f.front(2)).toBe(true);
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

  it.each([2, 3, 4])('keeps new and restored c=%i fronts in full exact geometry after selection detail closes', async boundaryClass => {
    for (const restored of [false, true]) {
      const fixtureInput = fixture(restored); fixtureInput.edgeClasses[0] = boundaryClass;
      const f = await mount(fixtureInput);
      if (!restored) {const next = update(f.world, {1: {controllerCountryId: 'AAA'}}); await f.consumer.updateWorld(next.world, next.change);}
      expect(f.delivery.incidentEdges).toHaveBeenCalledWith([1]); expect(f.delivery.loadEdgeDetails).toHaveBeenCalledWith([1], expect.any(AbortSignal));
      const fronts = f.sources.get(OPERATIONAL_FRONT_SOURCE_ID)!, expected = {type: 'LineString', coordinates: [[1, 0], [1, 1]]};
      expect(fronts.features.get(1)!.geometry).toEqual(expected);
      expect(f.baseFrontOpacity(1)).toBe(0); expect(f.front(1)).toBe(true);
      await f.consumer.showCountryDetail('BBB'); f.consumer.clearDetail();
      expect(fronts.features.get(1)!.geometry).toEqual(expected); expect(f.front(1)).toBe(true);
      expect(f.state(1).exactCell).toBe(true); expect(f.state(2).exactCell).toBe(false);
      vi.mocked(f.map.setFeatureState).mockClear();
      f.emit({cells: [], edges: [1, 2, 3, 4, 5]});
      expect(f.map.setFeatureState).not.toHaveBeenCalled(); expect(f.front(1)).toBe(true); f.consumer.dispose();
    }
  });

  it('moves occupation fronts inland and restores peaceful borders on liberation, undo and redo', async () => {
    const f = await mount(), occupied = update(f.world, {3: {controllerCountryId: 'AAA'}});
    await f.consumer.updateWorld(occupied.world, occupied.change);
    expect(f.state(4, true)).toBeUndefined(); expect(f.baseFrontOpacity(4)).toBe(0); expect(f.front(4)).toBe(false);
    expect(f.front(2)).toBe(true); expect(f.sources.get(OPERATIONAL_FRONT_SOURCE_ID)!.features.get(2)!.geometry).toEqual({type: 'LineString', coordinates: [[2, 0], [2, 1]]});
    f.emit({cells: [], edges: [4]}); expect(f.front(4)).toBe(false);
    const liberated = {...f.world, revision: 2}; await f.consumer.updateWorld(liberated);
    expect(f.state(2, true)).toBeUndefined(); expect(f.state(4, true)).toBeUndefined();
    expect(f.baseFrontOpacity(4)).toBe(0);
    expect(f.front(2)).toBe(false); expect(f.front(4)).toBe(false);
    expect(f.map.removeFeatureState).toHaveBeenCalledWith({source: OPERATIONAL_MAP_SOURCE_ID, sourceLayer: 'edges', id: 2});
    await f.consumer.updateWorld({...occupied.world, revision: 3}); expect(f.front(2)).toBe(true); expect(f.front(4)).toBe(false);
    await f.consumer.updateWorld({...liberated, revision: 4}); expect(f.front(2)).toBe(false); expect(f.front(4)).toBe(false);
    expect([...f.sources.get(OPERATIONAL_FRONT_SOURCE_ID)!.features.keys()]).toEqual([]); f.consumer.dispose();
  });

  it('restores an inland occupation front before its tile is observed while the original border remains peaceful', async () => {
    const initial = fixture(false, false), restored = update(initial.world, {3: {controllerCountryId: 'AAA'}}).world;
    const f = await mount({...initial, world: restored});
    expect(f.state(4, true)).toBeUndefined(); expect(f.front(4)).toBe(false);
    expect(f.front(2)).toBe(true); expect(f.sources.get(OPERATIONAL_FRONT_SOURCE_ID)!.features.has(2)).toBe(true);
    vi.mocked(f.map.setFeatureState).mockClear(); f.emit({cells: [], edges: [2, 4]});
    expect(f.map.setFeatureState).not.toHaveBeenCalled(); expect(f.front(4)).toBe(false); expect(f.front(2)).toBe(true); f.consumer.dispose();
  });

  it.each([false, true])('restores null controllers on one or both sides of an original border (both=%s)', async both => {
    const initial = fixture(), changes: Parameters<typeof update>[1] = {3: {ownerCountryId: null, controllerCountryId: null}};
    if (both) changes[4] = {ownerCountryId: null, controllerCountryId: null};
    const restored = update(initial.world, changes).world, f = await mount({...initial, world: restored});
    expect(f.state(3)).toMatchObject({mapColor: '#D6D3C7', occupied: false}); expect(f.front(2)).toBe(false);
    expect(f.front(4)).toBe(false); expect(f.state(4, true)).toBeUndefined();
    expect(f.front(3)).toBe(false); f.consumer.dispose();
  });

  it('keeps owner-only restoration exact and masks the base copy of an unchanged original front', async () => {
    const initial = fixture(), restored = update(initial.world, {3: {ownerCountryId: 'CCC'}}).world, f = await mount({...initial, world: restored});
    expect(f.state(3)).toMatchObject({mapColor: '#0000FF', occupied: true});
    expect(f.consumer.getProjection().world.territoriesById[ids[2]]).toMatchObject({ownerCountryId: 'CCC', controllerCountryId: 'BBB'});
    expect(f.state(4, true)).toEqual({front: true, exactFront: true}); expect(f.baseFrontOpacity(4)).toBe(0); expect(f.front(4)).toBe(true);
    expect(f.sources.get(OPERATIONAL_FRONT_SOURCE_ID)!.features.get(4)!.geometry).toEqual({type: 'LineString', coordinates: [[4, 0], [4, 1]]});
    f.consumer.clearDetail(); expect(f.front(4)).toBe(true); f.consumer.dispose();
  });

  it('keeps peaceful transferred territory free of fronts after its source country retires', async () => {
    const initial = fixture(), restored = update(initial.world, Object.fromEntries([1, 2, 3].map(n => [n, {ownerCountryId: 'AAA', controllerCountryId: 'AAA'}]))).world;
    const f = await mount({...initial, world: {...restored, countriesById: {AAA: initial.world.countriesById.AAA}}});
    expect(f.state(4, true)).toBeUndefined(); expect(f.front(4)).toBe(false); expect(f.front(1)).toBe(false); f.consumer.dispose();
  });

  it('does not rewrite an unchanged override on an owner change', async () => {
    const f = await mount(fixture(true)), next = update(f.world, {1: {ownerCountryId: 'CCC'}});
    vi.mocked(f.map.setFeatureState).mockClear(); await f.consumer.updateWorld(next.world, next.change);
    expect(vi.mocked(f.map.setFeatureState).mock.calls.filter(([target]) => target.sourceLayer === 'edges')).toHaveLength(0);
    expect(f.map.removeFeatureState).not.toHaveBeenCalled(); expect(f.front(1)).toBe(true); f.consumer.dispose();
  });

  it.each(['set', 'remove'] as const)('requires resynchronization after a failed sparse edge state %s', async operation => {
    const f = await mount(), occupied = update(f.world, {3: {controllerCountryId: 'AAA'}});
    if (operation === 'remove') await f.consumer.updateWorld(occupied.world, occupied.change);
    if (operation === 'set') {
      const write = vi.mocked(f.map.setFeatureState).getMockImplementation()!;
      vi.mocked(f.map.setFeatureState).mockImplementation((target, state) => {
        if (target.sourceLayer === 'edges') throw Error('edge state write'); return write(target, state);
      });
    } else vi.mocked(f.map.removeFeatureState).mockImplementationOnce(() => {throw Error('edge state remove');});
    const next = operation === 'set' ? occupied : update(occupied.world, {3: {controllerCountryId: 'BBB'}});
    await expect(f.consumer.updateWorld(next.world, next.change)).rejects.toThrow('edge state');
    expect(f.consumer.getUpdateStats().resyncRequired).toBe(true);
    await expect(f.consumer.updateWorld({...next.world, revision: 3})).rejects.toThrow('RESYNC_REQUIRED'); f.consumer.dispose();
  });

  it('writes restored geometry only to its source until the vector cell is observed', async () => {
    const f = await mount(fixture(true, false));
    expect(f.state(1)).toBeUndefined(); expect(f.sourceState(OPERATIONAL_EXACT_CELL_SOURCE_ID, 1)).toBeUndefined();
    expect(f.sourceState(OPERATIONAL_CHANGED_CELL_SOURCE_ID, 1)).toMatchObject({mapColor: '#FF0000', occupied: true});
    vi.mocked(f.map.setFeatureState).mockClear(); f.consumer.hoverCountry('BBB');
    expect(f.map.setFeatureState).toHaveBeenCalledExactlyOnceWith({source: OPERATIONAL_CHANGED_CELL_SOURCE_ID, id: 1}, {hover: true});
    vi.mocked(f.map.setFeatureState).mockClear(); f.emit({cells: [1], edges: [1]});
    expect(f.map.setFeatureState).toHaveBeenCalledExactlyOnceWith({source: OPERATIONAL_MAP_SOURCE_ID, sourceLayer: 'territories', id: 1}, expect.objectContaining({mapColor: '#FF0000', hover: true, exactCell: true}));
    vi.mocked(f.map.setFeatureState).mockClear(); f.emit({cells: [1], edges: [1]}); expect(f.map.setFeatureState).not.toHaveBeenCalled(); f.consumer.dispose();
  });

  it('publishes latest state when detail arrives and cleans only the removed exact source state', async () => {
    const f = await mount(fixture(true)), changed = f.sourceState(OPERATIONAL_CHANGED_CELL_SOURCE_ID, 1);
    f.consumer.hoverCountry('BBB'); f.consumer.selectCountry('BBB');
    await f.consumer.showCountryDetail('BBB');
    expect(f.sourceState(OPERATIONAL_EXACT_CELL_SOURCE_ID, 1)).toMatchObject({mapColor: '#FF0000', occupied: true, hover: true, selected: true});
    expect(f.state(2).exactCell).toBe(true);
    f.consumer.clearDetail();
    for (const n of [1, 2, 3]) expect(f.sourceState(OPERATIONAL_EXACT_CELL_SOURCE_ID, n)).toBeUndefined();
    expect(f.sourceState(OPERATIONAL_CHANGED_CELL_SOURCE_ID, 1)).toMatchObject({...changed, hover: true, selected: true});
    expect(f.state(1).exactCell).toBe(true); expect(f.state(2).exactCell).toBe(false);
    vi.mocked(f.map.setFeatureState).mockClear(); f.consumer.hoverCountry('AAA');
    expect(vi.mocked(f.map.setFeatureState).mock.calls.some(([target]) => target.source === OPERATIONAL_EXACT_CELL_SOURCE_ID)).toBe(false);
    expect(f.sourceState(OPERATIONAL_CHANGED_CELL_SOURCE_ID, 1)!.hover).toBe(false); f.consumer.dispose();
  });

  it('updates hover and selection flags for indexed countries without recomputing cell colors', async () => {
    const f = await mount(), view = vi.spyOn(projection, 'operationalCellView');
    vi.mocked(f.map.setFeatureState).mockClear(); f.consumer.hoverCountry('BBB');
    expect(view).not.toHaveBeenCalled();
    expect(vi.mocked(f.map.setFeatureState).mock.calls.map(([target, state]) => [target.id, state])).toEqual([[1, {hover: true}], [2, {hover: true}], [3, {hover: true}]]);
    vi.mocked(f.map.setFeatureState).mockClear(); f.consumer.hoverCountry('BBB'); expect(f.map.setFeatureState).not.toHaveBeenCalled();
    f.consumer.selectCountry('AAA');
    expect(vi.mocked(f.map.setFeatureState).mock.calls.map(([target, state]) => [target.id, state])).toEqual([[4, {selected: true}], [5, {selected: true}]]);
    expect(f.state(1)).toMatchObject({hover: true, selected: false}); expect(f.state(4)).toMatchObject({hover: false, selected: true});
    vi.mocked(f.map.setFeatureState).mockClear(); f.consumer.hoverCountry('CCC');
    expect(f.map.setFeatureState).toHaveBeenCalledTimes(3); expect(f.state(4).selected).toBe(true);
    expect(view).not.toHaveBeenCalled(); f.consumer.dispose();
  });

  it('keeps interaction ownership distinct from controller color and reindexes ownership changes', async () => {
    const f = await mount(fixture(true)); f.consumer.selectCountry('BBB');
    const transfer = update(f.world, {1: {ownerCountryId: 'AAA'}}); await f.consumer.updateWorld(transfer.world, transfer.change);
    expect(f.state(1)).toMatchObject({mapColor: '#FF0000', occupied: false, selected: false});
    vi.mocked(f.map.setFeatureState).mockClear(); f.consumer.hoverCountry('BBB');
    expect(vi.mocked(f.map.setFeatureState).mock.calls.map(([target]) => target.id)).toEqual([2, 3]);
    const recolored = {...transfer.world, revision: 2, countriesById: {...transfer.world.countriesById, BBB: {mapColor: '#ABCDEF'}}};
    vi.mocked(f.map.setFeatureState).mockClear(); await f.consumer.updateWorld(recolored, {catalogRef: ref, baseWorldRevision: 1, worldRevision: 2, cells: []});
    expect(vi.mocked(f.map.setFeatureState).mock.calls.map(([target]) => target.id)).toEqual([2, 3]);
    expect(f.state(1).mapColor).toBe('#FF0000'); expect(f.state(2).mapColor).toBe('#ABCDEF');
    await f.consumer.updateWorld({...f.world, revision: 3}); expect(f.state(1).selected).toBe(true);
    vi.mocked(f.map.setFeatureState).mockClear(); f.consumer.hoverCountry(null);
    expect(new Set(vi.mocked(f.map.setFeatureState).mock.calls.map(([target]) => target.id))).toEqual(new Set([1, 2, 3])); f.consumer.dispose();
  });

  it('uses controller fallback for unowned cells and authoritative hits without ID fields in paint state', async () => {
    const initial = fixture(), unowned = update(initial.world, {1: {ownerCountryId: null, controllerCountryId: 'AAA'}}).world;
    const onSelect = vi.fn(), onTerritorySelect = vi.fn(), f = await mount({...initial, world: unowned}, {onSelect, onTerritorySelect});
    f.consumer.selectCountry('AAA'); expect(f.state(1).selected).toBe(true);
    expect(f.state(1)).not.toHaveProperty('id'); expect(f.state(1)).not.toHaveProperty('ownerCountryId'); expect(f.state(1)).not.toHaveProperty('controllerCountryId');
    f.listeners.get(`click:${L.changedFill}`)!({features: [{id: 1, source: OPERATIONAL_CHANGED_CELL_SOURCE_ID}]});
    expect(onSelect).toHaveBeenLastCalledWith('AAA'); expect(onTerritorySelect).toHaveBeenLastCalledWith(ids[0]);
    const next = update(unowned, {1: {controllerCountryId: 'BBB'}}); await f.consumer.updateWorld(next.world, next.change);
    expect(f.state(1)).toMatchObject({mapColor: '#0000FF', selected: false});
    f.consumer.selectCountry('BBB'); expect(f.state(1).selected).toBe(true);
    f.listeners.get(`click:${L.changedFill}`)!({features: [{id: 1, source: OPERATIONAL_CHANGED_CELL_SOURCE_ID}]});
    expect(onSelect).toHaveBeenLastCalledWith('BBB'); expect(onTerritorySelect).toHaveBeenLastCalledWith(ids[0]);
    const uncontrolled = update(next.world, {1: {controllerCountryId: null}}); await f.consumer.updateWorld(uncontrolled.world, uncontrolled.change);
    expect(f.state(1)).toMatchObject({mapColor: '#D6D3C7', selected: false, hover: false});
    vi.mocked(f.map.setFeatureState).mockClear(); f.consumer.hoverCountry('BBB');
    expect(vi.mocked(f.map.setFeatureState).mock.calls.map(([target]) => target.id)).toEqual([2, 3]); f.consumer.dispose();
  });

  it('removes detail-only cells from both indexes and reuses the latest flags when reopening', async () => {
    const f = await mount(fixture(false, false)); f.consumer.hoverCountry('BBB'); f.consumer.selectCountry('BBB');
    await f.consumer.showCountryDetail('BBB');
    expect(f.sourceState(OPERATIONAL_EXACT_CELL_SOURCE_ID, 2)).toMatchObject({hover: true, selected: true}); expect(f.state(2)).toBeUndefined();
    f.consumer.clearDetail(); const view = vi.spyOn(projection, 'operationalCellView'); vi.mocked(f.map.setFeatureState).mockClear();
    f.consumer.hoverCountry('AAA'); f.consumer.selectCountry('AAA');
    const recolored = {...f.world, revision: 1, countriesById: {...f.world.countriesById, BBB: {mapColor: '#ABCDEF'}}};
    await f.consumer.updateWorld(recolored, {catalogRef: ref, baseWorldRevision: 0, worldRevision: 1, cells: []});
    expect(f.map.setFeatureState).not.toHaveBeenCalled(); expect(view).not.toHaveBeenCalled();
    await f.consumer.showCountryDetail('BBB'); expect(f.sourceState(OPERATIONAL_EXACT_CELL_SOURCE_ID, 2)).toMatchObject({mapColor: '#ABCDEF', hover: false, selected: false}); f.consumer.dispose();
  });

  it('uses the latest world, hover and selection after a pending country detail load', async () => {
    const f = await mount(), pending = deferred<Awaited<ReturnType<typeof f.delivery.loadCountryDetail>>>();
    f.delivery.loadCountryDetail.mockImplementationOnce(() => pending.promise);
    const loading = f.consumer.showCountryDetail('BBB'), occupied = update(f.world, {1: {controllerCountryId: 'AAA'}});
    const recolored = {...occupied.world, countriesById: {...occupied.world.countriesById, AAA: {mapColor: '#ABCDEF'}}};
    await f.consumer.updateWorld(recolored, occupied.change); f.consumer.hoverCountry('BBB'); f.consumer.selectCountry('BBB');
    pending.resolve({type: 'FeatureCollection', features: f.features.slice(0, 3)}); await loading;
    expect(f.sourceState(OPERATIONAL_EXACT_CELL_SOURCE_ID, 1)).toMatchObject({mapColor: '#ABCDEF', occupied: true, hover: true, selected: true});
    expect(f.sourceState(OPERATIONAL_CHANGED_CELL_SOURCE_ID, 1)).toMatchObject({mapColor: '#ABCDEF', hover: true, selected: true});
    expect(f.state(1).exactCell).toBe(true); f.consumer.dispose();
  });

  it.each(['clear', 'replace'] as const)('ignores a stale detail completion after %s without reviving membership', async operation => {
    const f = await mount(), pending = deferred<Awaited<ReturnType<typeof f.delivery.loadCountryDetail>>>();
    f.delivery.loadCountryDetail.mockImplementationOnce(() => pending.promise); const loading = f.consumer.showCountryDetail('BBB');
    const aborted = expect(loading).rejects.toHaveProperty('name', 'AbortError');
    if (operation === 'clear') f.consumer.clearDetail(); else await f.consumer.showCountryDetail('AAA');
    vi.mocked(f.map.setFeatureState).mockClear(); pending.resolve({type: 'FeatureCollection', features: f.features.slice(0, 3)}); await aborted;
    expect(f.map.setFeatureState).not.toHaveBeenCalled();
    expect(f.sourceState(OPERATIONAL_EXACT_CELL_SOURCE_ID, 1)).toBeUndefined();
    expect([...f.sources.get(OPERATIONAL_EXACT_CELL_SOURCE_ID)!.features.keys()]).toEqual(operation === 'clear' ? [] : [4, 5]);
    expect(f.state(1).exactCell).toBe(false); f.consumer.dispose();
  });

  it('keeps the previous detail membership after a failed load and can retry', async () => {
    const f = await mount(); await f.consumer.showCountryDetail('AAA');
    f.delivery.loadCountryDetail.mockRejectedValueOnce(Error('network'));
    await expect(f.consumer.showCountryDetail('BBB')).rejects.toThrow('network');
    expect(f.state(4).exactCell).toBe(true); expect(f.sourceState(OPERATIONAL_EXACT_CELL_SOURCE_ID, 4)).toBeDefined();
    expect(f.consumer.getUpdateStats().resyncRequired).toBe(false);
    await f.consumer.showCountryDetail('BBB');
    expect(f.state(4).exactCell).toBe(false); expect(f.sourceState(OPERATIONAL_EXACT_CELL_SOURCE_ID, 4)).toBeUndefined();
    expect(f.sourceState(OPERATIONAL_EXACT_CELL_SOURCE_ID, 1)).toBeDefined(); f.consumer.dispose();
  });

  it('clears indexed hover and selection when a country retires', async () => {
    const onSelect = vi.fn(), onHover = vi.fn(), f = await mount(fixture(), {onSelect, onHover});
    f.consumer.selectCountry('BBB'); f.consumer.hoverCountry('BBB');
    const transferred = update(f.world, Object.fromEntries([1, 2, 3].map(n => [n, {ownerCountryId: 'AAA', controllerCountryId: 'AAA'}])));
    await f.consumer.updateWorld({...transferred.world, countriesById: {AAA: f.world.countriesById.AAA}}, transferred.change);
    expect(onSelect).toHaveBeenLastCalledWith(null); expect(onHover).toHaveBeenLastCalledWith(null);
    for (const n of [1, 2, 3]) expect(f.state(n)).toMatchObject({selected: false, hover: false, mapColor: '#FF0000'});
    expect(() => f.consumer.hoverCountry('BBB')).toThrow('UNKNOWN_OPERATIONAL_MAP_COUNTRY'); f.consumer.dispose();
  });

  it.each(['publish', 'cleanup', 'hover'] as const)('requires resynchronization after partial cell state %s fails', async operation => {
    const f = await mount();
    if (operation === 'cleanup') {
      await f.consumer.showCountryDetail('BBB');
      const remove = vi.mocked(f.map.removeFeatureState).getMockImplementation()!;
      vi.mocked(f.map.removeFeatureState).mockImplementation(target => {
        if (target.source === OPERATIONAL_EXACT_CELL_SOURCE_ID) throw Error('cell state cleanup');
        return remove(target);
      });
      expect(() => f.consumer.clearDetail()).toThrow('cell state cleanup');
    } else {
      const write = vi.mocked(f.map.setFeatureState).getMockImplementation()!;
      vi.mocked(f.map.setFeatureState).mockImplementation((target, state) => {
        if (target.sourceLayer !== 'edges') throw Error('cell state publish');
        return write(target, state);
      });
      if (operation === 'publish') await expect(f.consumer.showCountryDetail('BBB')).rejects.toThrow('cell state publish');
      else expect(() => f.consumer.hoverCountry('BBB')).toThrow('cell state publish');
    }
    expect(f.consumer.getUpdateStats().resyncRequired).toBe(true); expect(() => f.consumer.selectCountry('AAA')).toThrow('RESYNC_REQUIRED'); f.consumer.dispose();
  });

  it.each(['country', 'clear', 'edge'] as const)('distinguishes a %s source publication failure from a retryable fetch failure', async operation => {
    const f = await mount();
    if (operation === 'clear') await f.consumer.showCountryDetail('BBB');
    const source = operation === 'country' ? OPERATIONAL_EXACT_CELL_SOURCE_ID : OPERATIONAL_EXACT_EDGE_SOURCE_ID;
    f.sources.get(source)!.setData.mockImplementationOnce(() => {throw Error('source write');});
    if (operation === 'clear') {
      expect(() => f.consumer.clearDetail()).toThrow('SOURCE_WRITE_FAILED');
      expect(f.sources.get(OPERATIONAL_EXACT_CELL_SOURCE_ID)!.features.size).toBe(0);
    } else if (operation === 'country') await expect(f.consumer.showCountryDetail('BBB')).rejects.toThrow('SOURCE_WRITE_FAILED');
    else await expect(f.consumer.showEdgeDetail([1])).rejects.toThrow('SOURCE_WRITE_FAILED');
    expect(f.consumer.getUpdateStats().resyncRequired).toBe(true); expect(() => f.consumer.hoverCountry('BBB')).toThrow('RESYNC_REQUIRED'); f.consumer.dispose();
  });

  it.each(['onSelect', 'onHover'] as const)('requires resynchronization if a retirement %s callback interrupts world publication', async callback => {
    const f = await mount(fixture(), {[callback]: () => {throw Error('retirement callback');}});
    f.consumer.selectCountry('BBB'); f.consumer.hoverCountry('BBB');
    const transferred = update(f.world, Object.fromEntries([1, 2, 3].map(n => [n, {ownerCountryId: 'AAA', controllerCountryId: 'AAA'}])));
    await expect(f.consumer.updateWorld({...transferred.world, countriesById: {AAA: f.world.countriesById.AAA}}, transferred.change)).rejects.toThrow('retirement callback');
    expect(f.consumer.getUpdateStats().resyncRequired).toBe(true); expect(() => f.consumer.clearDetail()).toThrow('RESYNC_REQUIRED'); f.consumer.dispose();
  });
});
