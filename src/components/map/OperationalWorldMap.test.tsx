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
import {OperationalWorldMap} from './OperationalWorldMap';

type MapFixture = {
  fire(event: string, payload?: {error: Error}): void;
  remove: ReturnType<typeof vi.fn>;
  triggerRepaint: ReturnType<typeof vi.fn>;
};
const mocks = vi.hoisted(() => ({
  maps: [] as MapFixture[], consumers: [] as OperationalMapConsumer[],
  createConsumer: vi.fn(), delivery: vi.fn(), labels: vi.fn(),
  labelUpdates: [] as ReturnType<typeof vi.fn>[],
}));
vi.mock('maplibre-gl', () => {
  class FakeMap {
    private listeners = new Map<string, ((payload?: {error: Error}) => void)[]>();
    private onceListeners = new Map<string, ((payload?: {error: Error}) => void)[]>();
    private sources = new Map<string, {setData: ReturnType<typeof vi.fn>}>();
    private layers = new Set<string>();
    remove = vi.fn();
    triggerRepaint = vi.fn(() => queueMicrotask(() => this.fire('idle')));
    constructor() {mocks.maps.push(this);}
    fire(event: string, payload?: {error: Error}) {
      const once = this.onceListeners.get(event) ?? []; this.onceListeners.delete(event);
      for (const listener of [...this.listeners.get(event) ?? [], ...once]) listener(payload);
    }
    once(event: string, listener: (payload?: {error: Error}) => void) {this.onceListeners.set(event, [...this.onceListeners.get(event) ?? [], listener]);}
    on(event: string, listener: (payload?: {error: Error}) => void) {this.listeners.set(event, [...this.listeners.get(event) ?? [], listener]);}
    addControl() {}
    addSource(id: string) {this.sources.set(id, {setData: vi.fn()});}
    getSource(id: string) {return this.sources.get(id);}
    addLayer(layer: {id: string}) {this.layers.add(layer.id);}
    getLayer(id: string) {return this.layers.has(id);}
    setLayoutProperty() {}
    setPaintProperty() {}
    getCanvas() {return {style: {cursor: ''}};}
    getCenter() {return {lng: 0};}
    flyTo() {}
    resize() {}
  }
  return {Map: FakeMap, NavigationControl: class {}};
});
vi.mock('@/lib/map/operational-map-consumer', () => ({
  createOperationalMapConsumer: mocks.createConsumer, OPERATIONAL_MAP_LAYERS: {country: 'operational-country-border'},
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
function MapHarness({client}: {client: ReturnType<typeof fixture>['client']}) {
  const world = useStore(client.store, value => value.world);
  const presentation = useMemo(() => operationalGamePresentation(world, client.presentation), [client, world]);
  return <OperationalWorldMap client={client} presentation={presentation}/>;
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
    let projection = {world: input.world, appliedRevision: input.world.revision};
    const consumer: OperationalMapConsumer = {
      getProjection: () => projection, getUpdateStats: () => ({fullProjectionBuilds: 1, updates: 0, cellsUpdated: 0, edgesExamined: 0,
        exactCellsAdded: 0, exactFrontsAdded: 0, exactFrontsRemoved: 0, exactCells: 0, exactFronts: 0, resyncRequired: false}),
      selectCountry: vi.fn(), hoverCountry: vi.fn(),
      updateWorld: vi.fn(async world => {projection = {world, appliedRevision: world.revision};}),
      showCountryDetail: vi.fn(async () => empty()), showEdgeDetail: vi.fn(async () => ({type: 'FeatureCollection' as const, features: []})), clearDetail: vi.fn(), dispose: vi.fn(),
    };
    mocks.consumers.push(consumer); return consumer;
  });
});
afterEach(() => {cleanup(); useGameSetupStore.getState().resetGameSetup(); vi.restoreAllMocks(); vi.unstubAllGlobals();});

async function mount() {
  const f = fixture(), view = render(<MapHarness client={f.client}/>);
  await act(async () => {mocks.maps[0].fire('load');});
  await waitFor(() => expect(screen.getByTestId('world-map')).toHaveAttribute('data-map-status', 'ready'));
  return {...f, ...view, consumer: mocks.consumers[0]};
}

describe('F06 operational map recovery', () => {
  it('keeps the base map ready after one detail failure and clears the error after explicit retry', async () => {
    const f = await mount();
    vi.mocked(f.consumer.showCountryDetail).mockRejectedValueOnce(Error('detail offline'));
    act(() => useGameSetupStore.getState().selectCountry('AAA'));
    expect(await screen.findByRole('button', {name: '상세 지도 다시 시도'})).toBeInTheDocument();
    expect(screen.getByTestId('world-map')).toHaveAttribute('data-map-status', 'ready');
    expect(screen.getByText(/기본 지도는 계속 사용할 수 있습니다/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', {name: '상세 지도 다시 시도'}));
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
    expect(f.consumer.showCountryDetail).toHaveBeenCalledTimes(2);
    expect(mocks.maps).toHaveLength(1);
  });

  it.each(['failure', 'success'] as const)('ignores a previous selection’s late %s after a new selection finishes', async outcome => {
    const f = await mount(), previous = deferred<CountryDetail>();
    vi.mocked(f.consumer.showCountryDetail).mockReturnValueOnce(previous.promise);
    if (outcome === 'success') vi.mocked(f.consumer.showCountryDetail).mockRejectedValueOnce(Error('current detail offline'));
    act(() => useGameSetupStore.getState().selectCountry('AAA'));
    await waitFor(() => expect(f.consumer.showCountryDetail).toHaveBeenCalledWith('AAA'));
    act(() => useGameSetupStore.getState().selectCountry('BBB'));
    await waitFor(() => expect(f.consumer.showCountryDetail).toHaveBeenLastCalledWith('BBB'));
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

  it.each(['BBB', null] as const)('invalidates pending detail source writes when world sync pauses selection %s', async selected => {
    const f = await mount(), detail = deferred<CountryDetail>(), sync = deferred<void>();
    let request = 0;
    const published: string[] = [];
    vi.mocked(f.consumer.clearDetail).mockImplementation(() => {request++; published.length = 0;});
    vi.mocked(f.consumer.showCountryDetail).mockImplementation(async id => {
      const current = ++request, data = id === 'AAA' ? await detail.promise : empty();
      if (current === request) published.push(id);
      return data;
    });
    act(() => useGameSetupStore.getState().selectCountry('AAA'));
    await waitFor(() => expect(f.consumer.showCountryDetail).toHaveBeenCalledWith('AAA'));
    const clears = vi.mocked(f.consumer.clearDetail).mock.calls.length;
    vi.mocked(f.consumer.updateWorld).mockReturnValueOnce(sync.promise);
    act(() => {f.publish('BBB');});
    await waitFor(() => expect(screen.getByTestId('world-map')).toHaveAttribute('data-map-status', 'loading'));
    expect(f.consumer.clearDetail).toHaveBeenCalledTimes(clears + 1);
    act(() => {
      if (selected) useGameSetupStore.getState().selectCountry(selected);
      else useGameSetupStore.getState().clearSelectedCountry();
    });
    await act(async () => detail.resolve(empty()));
    expect(published).toEqual([]);
    expect(screen.getByTestId('world-map')).toHaveAttribute('data-map-status', 'loading');
    await act(async () => sync.resolve());
    await waitFor(() => expect(screen.getByTestId('world-map')).toHaveAttribute('data-map-status', 'ready'));
    if (selected) await waitFor(() => expect(published).toEqual(['BBB']));
    else expect(published).toEqual([]);
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
