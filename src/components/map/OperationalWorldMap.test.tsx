import {useMemo} from 'react';
import {act, cleanup, fireEvent, render, screen, waitFor} from '@testing-library/react';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {useStore} from 'zustand';
import type {OperationalMapConsumer, createOperationalMapConsumer} from '@/lib/map/operational-map-consumer';
import {operationalGamePresentation} from '@/lib/projection/operational-game-presentation';
import {createOperationalGameClient} from '@/lib/simulation/client/operational-game-client';
import {createSimulationStateV2} from '@/lib/simulation/simulation-state-v2';
import {createWorldGeometryCatalogContract, readCatalogTerritoryId} from '@/lib/world/world-geometry-catalog-ref';
import {createWorldStateV3, transitionWorldStateV3, type WorldStateV3} from '@/lib/world/world-state-v3';
import {createOperationalStateChange} from '@/lib/world/operational-state-change';
import {useGameSetupStore} from '@/stores/game-setup-store';
import {DEFAULT_GAME_UI_SETTINGS, type GameUiSettings} from '@/lib/game-ui/ui-settings';
import {operationalCountryBorderWidth} from '@/lib/map/operational-boundary-style';
import {OperationalWorldMap} from './OperationalWorldMap';

type MapFixture = {
  options: Record<string, unknown>;
  zoom: number;
  bounds: [number, number, number, number];
  sourceReady: boolean;
  fire(event: string, payload?: {error?: Error; sourceId?: string}): void;
  listenerCount(event: string): number;
  remove: ReturnType<typeof vi.fn>;
  triggerRepaint: ReturnType<typeof vi.fn>;
  setPaintProperty: ReturnType<typeof vi.fn>;
};
const mocks = vi.hoisted(() => ({
  maps: [] as MapFixture[], consumers: [] as OperationalMapConsumer[],
  createConsumer: vi.fn(), delivery: vi.fn(), labels: vi.fn(),
  labelUpdates: [] as ReturnType<typeof vi.fn>[],
}));
vi.mock('maplibre-gl', () => {
  class FakeMap {
    private canvas = document.createElement('canvas');
    private listeners = new Map<string, ((payload?: {error?: Error; sourceId?: string}) => void)[]>();
    private onceListeners = new Map<string, ((payload?: {error?: Error; sourceId?: string}) => void)[]>();
    private sources = new Map<string, {setData: ReturnType<typeof vi.fn>}>();
    private layers = new Set<string>();
    zoom = 1;
    sourceReady = true;
    bounds: [number, number, number, number] = [100, 20, 110, 40];
    remove = vi.fn();
    triggerRepaint = vi.fn(() => queueMicrotask(() => this.fire('idle')));
    constructor(public options: Record<string, unknown>) {mocks.maps.push(this);}
    fire(event: string, payload?: {error?: Error; sourceId?: string}) {
      const once = this.onceListeners.get(event) ?? []; this.onceListeners.delete(event);
      for (const listener of [...this.listeners.get(event) ?? [], ...once]) listener(payload);
    }
    once(event: string, listener: (payload?: {error?: Error; sourceId?: string}) => void) {this.onceListeners.set(event, [...this.onceListeners.get(event) ?? [], listener]);}
    on(event: string, listener: (payload?: {error?: Error; sourceId?: string}) => void) {this.listeners.set(event, [...this.listeners.get(event) ?? [], listener]);}
    off(event: string, listener: (payload?: {error?: Error; sourceId?: string}) => void) {this.listeners.set(event, (this.listeners.get(event) ?? []).filter(value => value !== listener));}
    listenerCount(event: string) {return this.listeners.get(event)?.length ?? 0;}
    addControl() {}
    addSource(id: string) {this.sources.set(id, {setData: vi.fn()});}
    getSource(id: string) {return this.sources.get(id);}
    isSourceLoaded() {return this.sourceReady;}
    addLayer(layer: {id: string}) {this.layers.add(layer.id);}
    getLayer(id: string) {return this.layers.has(id);}
    setLayoutProperty() {}
    setPaintProperty = vi.fn();
    getCanvas() {return this.canvas;}
    getCenter() {return {lng: 0};}
    getZoom() {return this.zoom;}
    getBounds() {return {getWest: () => this.bounds[0], getSouth: () => this.bounds[1], getEast: () => this.bounds[2], getNorth: () => this.bounds[3]};}
    flyTo() {}
    resize() {}
  }
  return {Map: FakeMap, NavigationControl: class {}};
});
vi.mock('@/lib/map/operational-map-consumer', () => ({
  createOperationalMapConsumer: mocks.createConsumer, OPERATIONAL_MAP_LAYERS: {country: 'operational-country-border', detailCountry: 'operational-detail-country-border'},
  OPERATIONAL_PROVINCE_LOD_SOURCE_ID: 'world-operational-province-display-lod',
  OPERATIONAL_MICRO_LOD_SOURCE_ID: 'world-operational-micro-display-lod',
}));
vi.mock('@/lib/map/operational-vector-delivery', () => ({fetchOperationalVectorDelivery: mocks.delivery}));
vi.mock('@/lib/map/operational-country-labels', () => ({mountOperationalCountryLabels: mocks.labels}));

type CountryDetail = Awaited<ReturnType<OperationalMapConsumer['showCountryDetail']>>;
const empty = (): CountryDetail => ({type: 'FeatureCollection', features: []});
function deferred<Value>() {
  let resolve!: (value: Value) => void, reject!: (error: Error) => void;
  const promise = new Promise<Value>((yes, no) => {resolve = yes; reject = no;});
  return {promise, resolve, reject};
}
function fixture() {
  const countries = ['AAA', 'BBB'], ids = countries.map((_, i) => readCatalogTerritoryId(`territory:catalog:${String(i + 1).padStart(64, '0')}`));
  const catalog = createWorldGeometryCatalogContract({ref: {catalogVersion: 'f06-fixture-v1', geometryRoot: '1'.repeat(64), topologyRoot: '2'.repeat(64),
    renderArtifactRoot: '3'.repeat(64), manifestPath: '/data/territory-catalog/f06-fixture-v1/manifest.json'},
    territoryOrder: ids, territoriesById: Object.fromEntries(ids.map((id, i) => [id, {id, sourceCountryId: countries[i]}]))});
  const world = createWorldStateV3({schemaVersion: 3, seedVersion: 'f06-seed', policyVersion: 'f06-policy', revision: 0,
    countriesById: Object.fromEntries(countries.map(id => [id, {id, names: {shortKo: id, officialKo: id, mapKo: id, english: id, searchAliases: []},
      politicalStatus: 'sovereign', presentationOverride: null, moduleVersions: {core: 1, names: 1}, mapColor: id === 'AAA' ? '#334455' : '#556677'}])),
    countryOrder: countries, retiredCountryIds: new Set(), catalogRef: catalog.ref, territoryOrder: ids,
    territoriesById: Object.fromEntries(ids.map((id, i) => [id, {id, sourceCountryId: countries[i], ownerCountryId: countries[i], controllerCountryId: countries[i]}]))}, catalog);
  const simulation = createSimulationStateV2({schemaVersion: 2, revision: 0, currentDate: '2020-01-01', turnNumber: 0, playerCountryId: 'AAA', queuedActions: [],
    factsById: {}, factOrder: [], situationsById: {}, situationOrder: [], scheduledConsequences: [], eventLog: [], history: {lastCommittedTurnId: null, committedTurnCount: 0},
    territorialControlAuthoritiesById: {}, territorialControlAuthorityOrder: [], countryPresentationAuthoritiesById: {}, countryPresentationAuthorityOrder: []}, world);
  const client = createOperationalGameClient({sessionId: '757c2206-552c-4e0e-99b4-816d841ec403', snapshot: {
    world: {...world, retiredCountryIds: []}, simulation, revisions: {worldRevision: 0, simulationRevision: 0}, stateChange: null,
    counts: {AAA: {owned: 1, controlled: 1, occupied: 0}, BBB: {owned: 1, controlled: 1, occupied: 0}}, canUndo: false, canRedo: false, report: null,
  }, runs: [[1, 'AAA', 'AAA', 'AAA'], [1, 'BBB', 'BBB', 'BBB']], seedVersion: world.seedVersion, policyVersion: world.policyVersion, presentation: []}, ids);
  const presentation = operationalGamePresentation(client.getSnapshot().world, client.presentation), store = useGameSetupStore.getState();
  store.setCountrySearchProjection(presentation.search); store.setCountryPanelProjection(presentation.panel);
  const publish = (controllerCountryId: 'AAA' | 'BBB') => {
    const before = client.getSnapshot();
    const next = transitionWorldStateV3(before.world, catalog, {territories: {[ids[0]]: {...before.world.territoriesById[ids[0]],
      controllerCountryId: before.world.countriesById[controllerCountryId].id}}}, before.world.revision + 1);
    client.store.setState({...before, world: next, stateChange: createOperationalStateChange(before.world, next), revisions: {...before.revisions, worldRevision: next.revision}}, true);
    return next;
  };
  return {client, publish};
}
function MapHarness({client, uiSettings}: {client: ReturnType<typeof fixture>['client']; uiSettings?: GameUiSettings}) {
  const world = useStore(client.store, value => value.world);
  const presentation = useMemo(() => operationalGamePresentation(world, client.presentation), [client, world]);
  return <OperationalWorldMap client={client} presentation={presentation} uiSettings={uiSettings}/>;
}
beforeEach(() => {
  useGameSetupStore.getState().resetGameSetup();
  vi.clearAllMocks(); mocks.maps.length = 0; mocks.consumers.length = 0; mocks.labelUpdates.length = 0;
  vi.stubGlobal('ResizeObserver', class {observe() {} disconnect() {}});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  mocks.delivery.mockResolvedValue({});
  mocks.labels.mockImplementation(async () => {
    const updateWorld = vi.fn(); mocks.labelUpdates.push(updateWorld);
    return {updateWorld, visibility: vi.fn(), dispose: vi.fn()};
  });
  mocks.createConsumer.mockImplementation(async (input: Parameters<typeof createOperationalMapConsumer>[0]) => {
    for (const id of ['operational-country-border', 'operational-detail-country-border']) input.map.addLayer({id, type: 'line', source: 'fixture'});
    let projection = {world: input.world, appliedRevision: input.world.revision}, selectedDetailCells = 0, detailSourceWrites = 0, provinceLodReady = false, provinceLodActive = false, microLodReady = false, microLodActive = false;
    const consumer: OperationalMapConsumer = {
      getProjection: () => projection, getUpdateStats: () => ({fullProjectionBuilds: 1, updates: 0, cellsUpdated: 0, edgesExamined: 0,
        exactCellsAdded: 0, exactFrontsAdded: 0, exactFrontsRemoved: 0, exactCells: 0, exactFronts: 0, selectedDetailCells, detailSourceWrites,
        debugBoundaryScopeBuilds: 0, debugBoundaryFilterWrites: 0, debugBoundaryCountryIds: [], debugBoundaryEdgeCount: 0,
        provinceDisplayLodReady: provinceLodReady, provinceDisplayLodActive: provinceLodActive, provinceDisplayLodVertexCount: 0, provinceDisplayLodSourceWrites: 0,
        microDisplayLodReady: microLodReady, microDisplayLodActive: microLodActive, microDisplayLodInScope: false, microDisplayLodVertexCount: 0, microDisplayLodSourceWrites: 0, resyncRequired: false}),
      selectCountry: vi.fn(), hoverCountry: vi.fn(), setDebugBoundaries: vi.fn(),
      supportsCountryViewportDetail: vi.fn(() => true),
      loadProvinceBoundaryLod: vi.fn(async () => {provinceLodReady = true;}),
      setProvinceBoundaryLodEnabled: vi.fn(enabled => {provinceLodActive = enabled && provinceLodReady;}),
      loadMicroBoundaryLod: vi.fn(async () => {microLodReady = true;}),
      setMicroBoundaryLodEnabled: vi.fn(enabled => {microLodActive = enabled && microLodReady;}),
      updateWorld: vi.fn(async world => {projection = {world, appliedRevision: world.revision};}),
      showCountryDetail: vi.fn(async () => empty()),
      showCountryViewportDetail: vi.fn(async (_id, _bounds, signal) => {signal?.throwIfAborted(); selectedDetailCells = 1; detailSourceWrites++; return empty();}),
      showEdgeDetail: vi.fn(async () => ({type: 'FeatureCollection' as const, features: []})),
      clearDetail: vi.fn(() => {selectedDetailCells = 0; detailSourceWrites++;}), dispose: vi.fn(),
    };
    mocks.consumers.push(consumer); return consumer;
  });
});
afterEach(() => {cleanup(); useGameSetupStore.getState().resetGameSetup(); vi.restoreAllMocks(); vi.unstubAllGlobals();});

async function mount(options: {debug?: boolean; zoom?: number; sourceReady?: boolean} = {}) {
  const f = fixture(), settings = {...DEFAULT_GAME_UI_SETTINGS, debugMapBoundaries: options.debug ?? false};
  const view = render(<MapHarness client={f.client} uiSettings={settings}/>);
  const map = mocks.maps[0]; map.zoom = options.zoom ?? 1; map.sourceReady = options.sourceReady ?? true;
  await act(async () => {mocks.maps[0].fire('load');});
  await waitFor(() => expect(screen.getByTestId('world-map')).toHaveAttribute('data-map-status', 'ready'));
  return {...f, ...view, settings, map, consumer: mocks.consumers[0]};
}

describe('F06 operational map recovery', () => {
  it('waits for province display source readiness, restores originals at high zoom, and reuses the loaded LOD', async () => {
    mocks.delivery.mockResolvedValueOnce({bootstrap: {provinceBoundaryLod: {bounds: [73, 18, 135, 54], minZoom: 2.2, maxZoom: 7}}});
    const f = await mount({zoom: 5, sourceReady: false}), snapshot = f.client.getSnapshot();
    await waitFor(() => expect(f.consumer.loadProvinceBoundaryLod).toHaveBeenCalledOnce());
    expect(f.consumer.getUpdateStats().provinceDisplayLodActive).toBe(false);
    act(() => {f.map.sourceReady = true; f.map.fire('sourcedata', {sourceId: 'world-operational-province-display-lod'});});
    await waitFor(() => expect(f.consumer.getUpdateStats().provinceDisplayLodActive).toBe(true));
    act(() => {f.map.zoom = 7.3; f.map.fire('move');});
    expect(f.consumer.getUpdateStats().provinceDisplayLodActive).toBe(false);
    act(() => {f.map.zoom = 5; f.map.fire('moveend');});
    expect(f.consumer.getUpdateStats().provinceDisplayLodActive).toBe(true);
    act(() => {f.map.bounds = [-110, 30, -100, 40]; f.map.fire('move');});
    expect(f.consumer.getUpdateStats().provinceDisplayLodActive).toBe(false);
    expect(f.consumer.loadProvinceBoundaryLod).toHaveBeenCalledOnce(); expect(f.client.getSnapshot()).toBe(snapshot);
    f.unmount(); expect(f.map.listenerCount('sourcedata')).toBe(0); expect(f.map.listenerCount('move')).toBe(0);
  });

  it('does not activate a late province response after moving outside China', async () => {
    mocks.delivery.mockResolvedValueOnce({bootstrap: {provinceBoundaryLod: {bounds: [73, 18, 135, 54], minZoom: 2.2, maxZoom: 7}}});
    const f = await mount(), pending = deferred<void>();
    vi.mocked(f.consumer.loadProvinceBoundaryLod).mockReturnValueOnce(pending.promise);
    act(() => {f.map.zoom = 5; f.map.fire('moveend');});
    expect(f.consumer.loadProvinceBoundaryLod).toHaveBeenCalledOnce();
    act(() => {f.map.bounds = [-110, 30, -100, 40]; f.map.fire('move');});
    vi.spyOn(f.consumer, 'getUpdateStats').mockReturnValue({...f.consumer.getUpdateStats(), provinceDisplayLodReady: true});
    await act(async () => pending.resolve());
    expect(f.consumer.setProvinceBoundaryLodEnabled).toHaveBeenLastCalledWith(false);
  });

  it('uses hovered country independently of selection, clears detail on sea, and skips unsharded countries', async () => {
    const f = await mount({debug: true, zoom: 7.3}), snapshot = f.client.getSnapshot();
    act(() => useGameSetupStore.getState().selectCountry('AAA'));
    await act(async () => {await new Promise(resolve => setTimeout(resolve, 160));});
    expect(f.consumer.showCountryViewportDetail).not.toHaveBeenCalled();
    act(() => useGameSetupStore.getState().setHoveredCountry('BBB'));
    await waitFor(() => expect(f.consumer.showCountryViewportDetail).toHaveBeenCalledExactlyOnceWith('BBB', f.map.bounds, expect.any(AbortSignal)));
    expect(useGameSetupStore.getState().selectedCountryId).toBe('AAA');
    act(() => useGameSetupStore.getState().setHoveredCountry(null));
    expect(f.consumer.clearDetail).toHaveBeenCalledOnce();
    vi.mocked(f.consumer.supportsCountryViewportDetail).mockReturnValue(false);
    act(() => useGameSetupStore.getState().setHoveredCountry('AAA'));
    await act(async () => {await new Promise(resolve => setTimeout(resolve, 160));});
    expect(f.consumer.showCountryViewportDetail).toHaveBeenCalledOnce();
    expect(f.consumer.showCountryDetail).not.toHaveBeenCalled(); expect(f.client.getSnapshot()).toBe(snapshot);
  });

  it('uses verified vector selection in normal mode even at high zoom, without loading national or viewport exact geometry', async () => {
    const f = await mount({zoom: 7.8}), snapshot = f.client.getSnapshot();
    act(() => useGameSetupStore.getState().selectCountry('AAA'));
    await waitFor(() => expect(f.consumer.selectCountry).toHaveBeenLastCalledWith('AAA'));
    act(() => {f.map.fire('movestart'); f.map.bounds = [102, 22, 104, 24]; f.map.fire('moveend');});
    await act(async () => {await new Promise(resolve => setTimeout(resolve, 160));});
    expect(f.consumer.showCountryDetail).not.toHaveBeenCalled();
    expect(f.consumer.showCountryViewportDetail).not.toHaveBeenCalled();
    expect(screen.queryByText(/상세 지도를 불러오는 중/)).not.toBeInTheDocument();
    expect(f.client.getSnapshot()).toBe(snapshot);
    expect(screen.getByTestId('world-map')).toHaveAttribute('data-map-status', 'ready');
  });

  it('loads only the settled viewport in high-zoom debug mode and clears it when the view returns below the threshold', async () => {
    const f = await mount({debug: true, zoom: 6.9}), snapshot = f.client.getSnapshot();
    act(() => useGameSetupStore.getState().setHoveredCountry('AAA'));
    expect(f.consumer.showCountryViewportDetail).not.toHaveBeenCalled();
    act(() => {f.map.fire('movestart'); f.map.zoom = 7.3; f.map.bounds = [102, 22, 104, 24]; f.map.fire('moveend');});
    await waitFor(() => expect(f.consumer.showCountryViewportDetail).toHaveBeenCalledExactlyOnceWith('AAA', [102, 22, 104, 24], expect.any(AbortSignal)));
    await waitFor(() => expect(screen.queryByText(/상세 지도를 불러오는 중/)).not.toBeInTheDocument());
    expect(f.consumer.showCountryDetail).not.toHaveBeenCalled();
    act(() => {f.map.fire('movestart'); f.map.zoom = 6.8; f.map.fire('moveend');});
    expect(f.consumer.clearDetail).toHaveBeenCalledOnce();
    expect(f.consumer.showCountryViewportDetail).toHaveBeenCalledOnce();
    expect(f.client.getSnapshot()).toBe(snapshot);
  });

  it('aborts pending camera detail, debounces movement to the latest bounds, and ignores the old request completion', async () => {
    const f = await mount({debug: true, zoom: 7.3}), old = deferred<CountryDetail>(), latest = deferred<CountryDetail>();
    vi.mocked(f.consumer.showCountryViewportDetail).mockReturnValueOnce(old.promise).mockReturnValueOnce(latest.promise);
    act(() => useGameSetupStore.getState().setHoveredCountry('AAA'));
    await waitFor(() => expect(f.consumer.showCountryViewportDetail).toHaveBeenCalledOnce());
    const oldSignal = vi.mocked(f.consumer.showCountryViewportDetail).mock.calls[0][2]!;
    act(() => {
      f.map.fire('movestart'); f.map.bounds = [101, 21, 103, 23]; f.map.fire('moveend');
      f.map.fire('movestart'); f.map.bounds = [105, 25, 107, 27]; f.map.fire('moveend');
    });
    expect(oldSignal.aborted).toBe(true);
    expect(f.consumer.showCountryViewportDetail).toHaveBeenCalledOnce();
    await waitFor(() => expect(f.consumer.showCountryViewportDetail).toHaveBeenCalledTimes(2));
    expect(f.consumer.showCountryViewportDetail).toHaveBeenLastCalledWith('AAA', [105, 25, 107, 27], expect.any(AbortSignal));
    await act(async () => old.reject(Error('obsolete viewport offline')));
    expect(screen.getByText(/상세 지도를 불러오는 중/)).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    await act(async () => latest.resolve(empty()));
    expect(screen.queryByText(/상세 지도를 불러오는 중/)).not.toBeInTheDocument();
    const latestSignal = vi.mocked(f.consumer.showCountryViewportDetail).mock.calls[1][2]!;
    f.unmount();
    expect(latestSignal.aborted).toBe(true);
    expect(f.map.listenerCount('movestart')).toBe(0); expect(f.map.listenerCount('moveend')).toBe(0);
  });

  it('toggles debug boundaries immediately without remounting the map or changing the game snapshot', async () => {
    const f = await mount(), snapshot = f.client.getSnapshot();
    expect(DEFAULT_GAME_UI_SETTINGS.debugMapBoundaries).toBe(false);
    expect(f.consumer.setDebugBoundaries).toHaveBeenLastCalledWith(false);
    const worldUpdates = vi.mocked(f.consumer.updateWorld).mock.calls.length;
    const detailLoads = vi.mocked(f.consumer.showCountryViewportDetail).mock.calls.length;
    f.rerender(<MapHarness client={f.client} uiSettings={{...DEFAULT_GAME_UI_SETTINGS, debugMapBoundaries: true}}/>);
    await waitFor(() => expect(f.consumer.setDebugBoundaries).toHaveBeenLastCalledWith(true));
    f.rerender(<MapHarness client={f.client} uiSettings={DEFAULT_GAME_UI_SETTINGS}/>);
    await waitFor(() => expect(f.consumer.setDebugBoundaries).toHaveBeenLastCalledWith(false));
    expect(f.client.getSnapshot()).toBe(snapshot);
    expect(f.consumer.updateWorld).toHaveBeenCalledTimes(worldUpdates);
    expect(f.consumer.showCountryViewportDetail).toHaveBeenCalledTimes(detailLoads);
    expect(mocks.maps).toHaveLength(1); expect(mocks.consumers).toHaveLength(1);
    expect(mocks.delivery).toHaveBeenCalledOnce();
    expect(screen.getByTestId('world-map')).toHaveAttribute('data-map-status', 'ready');
  });

  it('keeps zoom-dependent border widths on vector and exact borders when emphasis changes', async () => {
    const f = await mount(), map = mocks.maps[0];
    for (const id of ['operational-country-border', 'operational-detail-country-border']) {
      expect(map.setPaintProperty).toHaveBeenCalledWith(id, 'line-width', operationalCountryBorderWidth(false));
    }
    f.rerender(<MapHarness client={f.client} uiSettings={{...DEFAULT_GAME_UI_SETTINGS, emphasizeBorders: true}}/>);
    for (const id of ['operational-country-border', 'operational-detail-country-border']) {
      expect(map.setPaintProperty).toHaveBeenCalledWith(id, 'line-width', operationalCountryBorderWidth(true));
    }
    f.rerender(<MapHarness client={f.client} uiSettings={DEFAULT_GAME_UI_SETTINGS}/>);
    for (const id of ['operational-country-border', 'operational-detail-country-border']) {
      expect(map.setPaintProperty).toHaveBeenCalledWith(id, 'line-width', operationalCountryBorderWidth(false));
    }
    expect(mocks.maps).toHaveLength(1); expect(mocks.consumers).toHaveLength(1);
  });

  it('makes boundary sources, represented years and reuse licenses available in the map attribution', async () => {
    await mount();
    const attribution = mocks.maps[0].options.attributionControl as {compact: boolean; customAttribution: string[]};
    expect(attribution.compact).toBe(true);
    expect(attribution.customAttribution.join(' ')).toContain('https://www.geoboundaries.org');
    expect(attribution.customAttribution.join(' ')).toContain('한국 시군구: geoBoundaries·City Population, 2020');
    expect(attribution.customAttribution.join(' ')).toContain('https://creativecommons.org/licenses/by/3.0/');
    expect(attribution.customAttribution.join(' ')).toContain('WFP/OCHA · 자료 기준연도 2013/2019');
    expect(attribution.customAttribution.join(' ')).toContain('CC BY 4.0');
    expect(attribution.customAttribution.join(' ')).toContain('CC BY 3.0 IGO');
  });

  it('keeps the base map ready after one detail failure and clears the error after explicit retry', async () => {
    const f = await mount({debug: true, zoom: 7.3});
    vi.mocked(f.consumer.showCountryViewportDetail).mockRejectedValueOnce(Error('detail offline'));
    act(() => useGameSetupStore.getState().setHoveredCountry('AAA'));
    expect(await screen.findByRole('button', {name: '상세 지도 다시 시도'})).toBeInTheDocument();
    expect(screen.getByTestId('world-map')).toHaveAttribute('data-map-status', 'ready');
    expect(screen.getByText(/기본 지도는 계속 사용할 수 있습니다/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', {name: '상세 지도 다시 시도'}));
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
    await waitFor(() => expect(f.consumer.showCountryViewportDetail).toHaveBeenCalledTimes(2));
    expect(f.consumer.showCountryDetail).not.toHaveBeenCalled();
    expect(mocks.maps).toHaveLength(1);
  });

  it('requires a map remount when detail state publication leaves the consumer needing resynchronization', async () => {
    const f = await mount({debug: true, zoom: 7.3}), world = f.client.getSnapshot().world, stats = f.consumer.getUpdateStats();
    vi.spyOn(f.consumer, 'getUpdateStats').mockReturnValue({...stats, resyncRequired: true});
    vi.mocked(f.consumer.setDebugBoundaries).mockClear().mockImplementation(() => {throw Error('map requires resynchronization');});
    vi.mocked(f.consumer.showCountryViewportDetail).mockRejectedValueOnce(Error('feature state write failed'));
    act(() => useGameSetupStore.getState().setHoveredCountry('AAA'));
    await screen.findByRole('button', {name: '지도 다시 불러오기'});
    expect(screen.getByTestId('world-map')).toHaveAttribute('data-map-status', 'error');
    expect(screen.getByText('현재 세계 상태를 지도에 반영하지 못했습니다.')).toBeInTheDocument();
    expect(screen.queryByRole('button', {name: '상세 지도 다시 시도'})).not.toBeInTheDocument();
    expect(f.consumer.setDebugBoundaries).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', {name: '지도 다시 불러오기'}));
    expect(f.consumer.dispose).toHaveBeenCalledOnce();
    expect(mocks.maps[0].remove).toHaveBeenCalledOnce();
    await act(async () => {mocks.maps[1].fire('load');});
    await waitFor(() => expect(screen.getByTestId('world-map')).toHaveAttribute('data-map-status', 'ready'));
    expect(mocks.createConsumer).toHaveBeenLastCalledWith(expect.objectContaining({world}));
    // A recovered map still starts at world zoom, so optional exact detail stays lazy.
    expect(mocks.consumers[1].showCountryViewportDetail).not.toHaveBeenCalled();
    expect(mocks.consumers[1].showCountryDetail).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
    expect(f.client.getSnapshot().world).toBe(world);
  });

  it.each(['failure', 'success'] as const)('ignores a previous hover’s late %s after a new hover finishes', async outcome => {
    const f = await mount({debug: true, zoom: 7.3}), previous = deferred<CountryDetail>();
    vi.mocked(f.consumer.showCountryViewportDetail).mockReturnValueOnce(previous.promise);
    if (outcome === 'success') vi.mocked(f.consumer.showCountryViewportDetail).mockRejectedValueOnce(Error('current detail offline'));
    act(() => useGameSetupStore.getState().setHoveredCountry('AAA'));
    await waitFor(() => expect(f.consumer.showCountryViewportDetail).toHaveBeenCalledWith('AAA', f.map.bounds, expect.any(AbortSignal)));
    const oldSignal = vi.mocked(f.consumer.showCountryViewportDetail).mock.calls[0][2]!;
    act(() => useGameSetupStore.getState().setHoveredCountry('BBB'));
    await waitFor(() => expect(f.consumer.showCountryViewportDetail).toHaveBeenLastCalledWith('BBB', f.map.bounds, expect.any(AbortSignal)));
    expect(oldSignal.aborted).toBe(true);
    if (outcome === 'success') await screen.findByRole('button', {name: '상세 지도 다시 시도'});
    else await waitFor(() => expect(screen.queryByText(/상세 지도를 불러오는 중/)).not.toBeInTheDocument());
    await act(async () => {if (outcome === 'success') previous.resolve(empty()); else previous.reject(Error('old detail offline'));});
    expect(screen.getByTestId('world-map')).toHaveAttribute('data-map-status', 'ready');
    expect(screen.queryByRole('button', {name: '상세 지도 다시 시도'}) !== null).toBe(outcome === 'success');
  });

  it('marks an unapplied world as stale and remounts only the map at the current authoritative snapshot on retry', async () => {
    const f = await mount();
    vi.mocked(f.consumer.updateWorld).mockRejectedValueOnce(Error('exact geometry offline'));
    let next!: WorldStateV3;
    act(() => {next = f.publish('BBB');});
    await screen.findByRole('button', {name: '지도 다시 불러오기'});
    expect(screen.getByTestId('world-map')).toHaveAttribute('data-map-status', 'error');
    expect(screen.getByTestId('world-map')).toHaveAttribute('data-map-applied-revision', '0');
    expect(screen.getByText('현재 세계 상태를 지도에 반영하지 못했습니다.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', {name: '지도 다시 불러오기'}));
    expect(f.consumer.dispose).toHaveBeenCalledOnce();
    expect(mocks.maps[0].remove).toHaveBeenCalledOnce();
    await act(async () => {mocks.maps[1].fire('load');});
    await waitFor(() => expect(screen.getByTestId('world-map')).toHaveAttribute('data-map-status', 'ready'));
    expect(mocks.createConsumer).toHaveBeenLastCalledWith(expect.objectContaining({world: next}));
    expect(screen.getByTestId('world-map')).toHaveAttribute('data-map-applied-revision', '1');
    expect(f.client.getSnapshot().world).toBe(next);
    expect(mocks.labelUpdates[1]).toHaveBeenLastCalledWith(next, f.client.getSnapshot().counts);
  });

  it.each(['BBB', null] as const)('invalidates obsolete hover %s during sync while preserving the world readiness guard', async selected => {
    const f = await mount({debug: true, zoom: 7.3}), detail = deferred<CountryDetail>(), sync = deferred<void>();
    const published: string[] = [];
    vi.mocked(f.consumer.showCountryViewportDetail).mockImplementation(async (id, _bounds, signal) => {
      const data = id === 'AAA' ? await detail.promise : empty();
      if (!signal?.aborted) published.push(id);
      return data;
    });
    act(() => useGameSetupStore.getState().setHoveredCountry('AAA'));
    await waitFor(() => expect(f.consumer.showCountryViewportDetail).toHaveBeenCalledWith('AAA', f.map.bounds, expect.any(AbortSignal)));
    const clears = vi.mocked(f.consumer.clearDetail).mock.calls.length;
    vi.mocked(f.consumer.updateWorld).mockReturnValueOnce(sync.promise);
    act(() => {f.publish('BBB');});
    await waitFor(() => expect(screen.getByTestId('world-map')).toHaveAttribute('data-map-status', 'loading'));
    expect(f.consumer.clearDetail).toHaveBeenCalledTimes(clears);
    act(() => {
      if (selected) useGameSetupStore.getState().setHoveredCountry(selected);
      else useGameSetupStore.getState().setHoveredCountry(null);
    });
    await act(async () => detail.resolve(empty()));
    await waitFor(() => expect(published).toEqual(selected ? ['BBB'] : []));
    expect(screen.getByTestId('world-map')).toHaveAttribute('data-map-status', 'loading');
    await act(async () => sync.resolve());
    await waitFor(() => expect(screen.getByTestId('world-map')).toHaveAttribute('data-map-status', 'ready'));
    if (selected) await waitFor(() => expect(published).toEqual(['BBB']));
    else expect(published).toEqual([]);
  });

  it.each(['loaded', 'pending'] as const)('keeps %s country geometry through occupation, undo and redo without reloading it', async state => {
    const f = await mount({debug: true, zoom: 7.3}), detail = deferred<CountryDetail>();
    if (state === 'pending') vi.mocked(f.consumer.showCountryViewportDetail).mockReturnValueOnce(detail.promise);
    act(() => useGameSetupStore.getState().setHoveredCountry('AAA'));
    await waitFor(() => expect(f.consumer.showCountryViewportDetail).toHaveBeenCalledExactlyOnceWith('AAA', f.map.bounds, expect.any(AbortSignal)));
    const clears = vi.mocked(f.consumer.clearDetail).mock.calls.length;
    for (const [index, controller] of (['BBB', 'AAA', 'BBB'] as const).entries()) {
      act(() => {f.publish(controller);});
      await waitFor(() => expect(screen.getByTestId('world-map')).toHaveAttribute('data-map-applied-revision', String(index + 1)));
      expect(screen.getByTestId('world-map')).toHaveAttribute('data-map-status', 'ready');
    }
    if (state === 'pending') await act(async () => detail.resolve(empty()));
    expect(f.consumer.showCountryViewportDetail).toHaveBeenCalledExactlyOnceWith('AAA', f.map.bounds, expect.any(AbortSignal));
    expect(f.consumer.showCountryDetail).not.toHaveBeenCalled();
    expect(f.consumer.clearDetail).toHaveBeenCalledTimes(clears);
    expect(mocks.maps).toHaveLength(1); expect(mocks.consumers).toHaveLength(1);
  });

  it('does not publish an older world completion while a newer occupation/undo update is pending', async () => {
    const f = await mount(), first = deferred<void>(), second = deferred<void>();
    vi.mocked(f.consumer.updateWorld).mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    let occupied!: WorldStateV3, restored!: WorldStateV3;
    act(() => {occupied = f.publish('BBB');});
    act(() => {restored = f.publish('AAA');});
    await act(async () => first.resolve());
    expect(screen.getByTestId('world-map')).toHaveAttribute('data-map-status', 'loading');
    expect(screen.getByTestId('world-map')).toHaveAttribute('data-map-applied-revision', '0');
    expect(mocks.labelUpdates[0]).not.toHaveBeenCalledWith(occupied, expect.anything());
    await act(async () => second.resolve());
    await waitFor(() => expect(screen.getByTestId('world-map')).toHaveAttribute('data-map-applied-revision', '2'));
    expect(mocks.labelUpdates[0]).toHaveBeenLastCalledWith(restored, f.client.getSnapshot().counts);
    act(() => {f.publish('BBB');});
    await waitFor(() => expect(screen.getByTestId('world-map')).toHaveAttribute('data-map-applied-revision', '3'));
    expect(vi.mocked(f.consumer.updateWorld).mock.calls.slice(-3).map(([world, change]) => [world.revision, change?.worldRevision])).toEqual([[1, 1], [2, 2], [3, 3]]);
    expect(screen.getByTestId('world-map')).toHaveAttribute('data-map-status', 'ready');
  });

  it('ignores pending world completion after unmount', async () => {
    const f = await mount(), pending = deferred<void>();
    vi.mocked(f.consumer.updateWorld).mockReturnValueOnce(pending.promise);
    act(() => {f.publish('BBB');}); f.unmount();
    const count = mocks.labelUpdates[0].mock.calls.length;
    await act(async () => pending.resolve());
    expect(mocks.labelUpdates[0]).toHaveBeenCalledTimes(count);
    expect(f.consumer.dispose).toHaveBeenCalledOnce();
    expect(mocks.maps[0].remove).toHaveBeenCalledOnce();
  });

  it('keeps a base-map failure visible even when an old idle notification arrives', async () => {
    const f = fixture(); render(<MapHarness client={f.client}/>);
    mocks.maps[0].triggerRepaint.mockImplementation(() => {});
    await act(async () => {mocks.maps[0].fire('load');});
    await waitFor(() => expect(mocks.labelUpdates).toHaveLength(1));
    act(() => mocks.maps[0].fire('error', {error: Error('tile worker failed')}));
    act(() => mocks.maps[0].fire('idle'));
    expect(screen.getByTestId('world-map')).toHaveAttribute('data-map-status', 'error');
    expect(screen.getByRole('button', {name: '지도 다시 불러오기'})).toBeInTheDocument();
  });
});
