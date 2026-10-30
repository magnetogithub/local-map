// @vitest-environment node
import {afterEach, describe, expect, it, vi} from 'vitest';
import {createExpression, createPropertyExpression, latest, validateStyleMin} from '@maplibre/maplibre-gl-style-spec';
import type {StylePropertySpecification, StyleSpecification} from '@maplibre/maplibre-gl-style-spec';
import geojsonvt from 'geojson-vt';
import {GeoJSONWrapper} from '@maplibre/vt-pbf';
import type {FeatureCollection, Geometry} from 'geojson';
import type {FilterSpecification, LayerSpecification, Map as MapLibreMap, SourceSpecification} from 'maplibre-gl';
import type {WorldStateV3} from '../world/world-state-v3';
import {mountOperationalCountryLabels} from './operational-country-labels';

type Collection = FeatureCollection<Geometry, Record<string, unknown>>;
const ids = {fills: 'operational-label-fills', outlines: 'operational-label-outlines', points: 'operational-label-points'};
function world(): WorldStateV3 {
  return {countryOrder: ['AAA', 'BBB', 'CCC'], countriesById: {
    AAA: {id: 'AAA', names: {mapKo: 'Alpha'}, mapColor: '#FF0000'},
    BBB: {id: 'BBB', names: {mapKo: 'Beta'}, mapColor: '#0000FF'},
    CCC: {id: 'CCC', names: {mapKo: 'Gamma'}, mapColor: '#00FF00'},
  }} as unknown as WorldStateV3;
}
function changeCountry(before: WorldStateV3, id: string, patch: {mapColor?: string; mapKo?: string}): WorldStateV3 {
  const country = before.countriesById[id];
  return {...before, countriesById: {...before.countriesById, [id]: {...country,
    ...(patch.mapColor ? {mapColor: patch.mapColor} : {}), names: {...country.names, ...(patch.mapKo ? {mapKo: patch.mapKo} : {})}}}};
}
function fixture() {
  const feature = (countryId: string, properties: Record<string, unknown> = {}) => ({type: 'Feature' as const,
    properties: {countryId, ...properties}, geometry: {type: 'Point' as const, coordinates: [0, 0]}});
  const seed = {
    placements: {type: 'FeatureCollection', features: [feature('AAA', {mapLabelKo: 'Alpha', minZoom: 1}),
      feature('BBB', {mapLabelKo: 'Beta', minZoom: 2.35, placementMode: 'small-country-point'}),
      feature('CCC', {mapLabelKo: 'Gamma', placementMode: 'small-country-point'})]},
    fills: {type: 'FeatureCollection', features: [feature('AAA', {minZoom: 1}), feature('AAA', {minZoom: 1}),
      feature('BBB', {minZoom: 2.35}), feature('CCC', {minZoom: 1.125})]},
    outlines: {type: 'FeatureCollection', features: []},
  };
  const sources = new Map<string, {data: Collection; setData: ReturnType<typeof vi.fn>}>();
  const layers = new Map<string, LayerSpecification>(), filters = new Map<string, FilterSpecification>();
  const states = new Map<string, Record<string, unknown>>(), listeners = new Map<string, () => void>();
  let zoom = 1;
  const map = {
    addSource: (id: string, spec: SourceSpecification) => {
      const source: {data: Collection; setData: ReturnType<typeof vi.fn>} = {data: (spec as {data: Collection}).data, setData: vi.fn((data: Collection) => {source.data = data;})};
      sources.set(id, source);
    },
    getSource: (id: string) => sources.get(id), removeSource: vi.fn((id: string) => sources.delete(id)),
    addLayer: (layer: LayerSpecification) => layers.set(layer.id, layer), getLayer: (id: string) => layers.get(id), removeLayer: vi.fn((id: string) => layers.delete(id)),
    setFilter: vi.fn((id: string, filter: FilterSpecification) => filters.set(id, filter)),
    setFeatureState: vi.fn((target: {source: string; id: string | number}, state: Record<string, unknown>) => {
      const key = `${target.source}:${target.id}`; states.set(key, {...states.get(key), ...state});
    }),
    setLayoutProperty: vi.fn(), getZoom: () => zoom,
    on: vi.fn((event: string, listener: () => void) => listeners.set(event, listener)),
    off: vi.fn((event: string, listener: () => void) => {if (listeners.get(event) === listener) listeners.delete(event);}),
  };
  vi.stubGlobal('fetch', vi.fn(async () => ({ok: true, json: async () => structuredClone(seed)})));
  const visible = (kind: keyof typeof ids, index: number) => {
    const expression = createExpression(filters.get(ids[kind]));
    if (expression.result !== 'success') throw Error(JSON.stringify(expression.value));
    const feature = sources.get(ids[kind])!.data.features[index];
    if (!expression.value.evaluate({zoom}, {type: 'Point', properties: feature.properties})) return false;
    if (kind === 'points') return true;
    const property = kind === 'fills' ? 'fill-opacity' : 'line-opacity';
    const opacity = createExpression((layers.get(ids[kind])!.paint as Record<string, unknown>)[property]);
    if (opacity.result !== 'success') throw Error(JSON.stringify(opacity.value));
    return opacity.value.evaluate({zoom}, {type: 'Point', properties: feature.properties}, states.get(`${ids[kind]}:${feature.id}`)) > 0;
  };
  return {map, sources, layers, filters, states, listeners, visible,
    zoomTo: (next: number) => {zoom = next; listeners.get('zoom')?.();},
    mount: (initial = world()) => mountOperationalCountryLabels(map as unknown as MapLibreMap, initial, new AbortController().signal),
  };
}
afterEach(() => vi.unstubAllGlobals());

describe('operational country label update workload', () => {
  it('skips duplicate initial/world/zoom work and uses each exact seed minZoom threshold in either direction', async () => {
    const f = fixture(), initial = world(), mounted = await f.mount(initial);
    expect(f.map.setFeatureState).toHaveBeenCalledTimes(4); expect(f.map.setFilter).toHaveBeenCalledTimes(3);
    expect(f.map.setFeatureState.mock.calls.every(([, state]) => state.visibleOpacity === 1 && Object.keys(state).length === 1)).toBe(true);
    f.map.setFeatureState.mockClear(); f.map.setFilter.mockClear();
    expect(f.sources.get(ids.points)!.setData).not.toHaveBeenCalled();
    mounted.updateWorld(initial, {}); mounted.updateWorld({...initial}, {});
    f.zoomTo(1.01); f.zoomTo(1.124999999);
    expect(f.map.setFilter).not.toHaveBeenCalled(); expect(f.map.setFeatureState).not.toHaveBeenCalled();
    expect(f.sources.get(ids.points)!.setData).not.toHaveBeenCalled(); expect(f.visible('fills', 3)).toBe(false);
    f.zoomTo(1.125); expect(f.map.setFilter).not.toHaveBeenCalled(); expect(f.visible('fills', 3)).toBe(true);
    expect(f.visible('outlines', 3)).toBe(true); expect(f.map.setFeatureState).toHaveBeenCalledTimes(2);
    expect(f.map.setFeatureState.mock.calls.every(([target]) => target.id === 4)).toBe(true);
    f.zoomTo(1.13); f.zoomTo(2.349999999); expect(f.map.setFilter).not.toHaveBeenCalled(); expect(f.visible('points', 1)).toBe(false);
    expect(f.map.setFeatureState).toHaveBeenCalledTimes(2);
    f.zoomTo(2.35); expect(f.map.setFilter).toHaveBeenCalledTimes(1); expect(f.visible('points', 1)).toBe(true);
    expect(f.visible('fills', 2)).toBe(true); expect(f.map.setFeatureState).toHaveBeenCalledTimes(4);
    f.zoomTo(2.349999999); expect(f.map.setFilter).toHaveBeenCalledTimes(2); expect(f.visible('points', 1)).toBe(false);
    expect(f.visible('outlines', 2)).toBe(false);
    f.zoomTo(1.124999999); expect(f.map.setFilter).toHaveBeenCalledTimes(2); expect(f.visible('fills', 3)).toBe(false);
    f.zoomTo(.999999999); expect(f.map.setFilter).toHaveBeenCalledTimes(3); expect(f.visible('points', 2)).toBe(false);
    expect(f.visible('fills', 0)).toBe(false);
    f.zoomTo(1); expect(f.map.setFilter).toHaveBeenCalledTimes(4); expect(f.visible('points', 2)).toBe(true);
    expect(f.visible('fills', 0)).toBe(true);
    expect(f.map.setFilter.mock.calls.every(([id]) => id === ids.points)).toBe(true);
    expect(f.sources.get(ids.points)!.setData).not.toHaveBeenCalled(); mounted.dispose();
  });

  it('uses renderer-valid source-only opacity and keeps symbol collision visibility in its filter', async () => {
    const f = fixture(), mounted = await f.mount();
    const specifications = {fills: latest.paint_fill['fill-opacity'], outlines: latest.paint_line['line-opacity']};
    for (const kind of ['fills', 'outlines'] as const) {
      const property = kind === 'fills' ? 'fill-opacity' : 'line-opacity';
      const value = (f.layers.get(ids[kind])!.paint as Record<string, unknown>)[property];
      const compiled = createPropertyExpression(value, specifications[kind] as StylePropertySpecification);
      expect(compiled.result).toBe('success');
      if (compiled.result !== 'success') throw Error(JSON.stringify(compiled.value));
      expect(compiled.value.kind).toBe('source');
      if (compiled.value.kind !== 'source') throw Error('Label opacity must use the source-only GPU binder');
      expect(compiled.value.isStateDependent).toBe(true);
      expect(JSON.stringify(value)).not.toContain('zoom');
    }
    expect(f.layers.get(ids.points)!.paint).not.toHaveProperty('text-opacity');
    expect(f.map.on).toHaveBeenCalledTimes(1); // Only the tiny symbol source needs a collision-aware zoom filter.
    const style = {version: 8, glyphs: 'https://example.invalid/fonts/{fontstack}/{range}.pbf',
      sources: Object.fromEntries([...f.sources].map(([id, source]) => [id, {type: 'geojson', data: source.data}])),
      layers: [...f.layers.values()].map(layer => ({...layer, filter: f.filters.get(layer.id)}))} as StyleSpecification;
    expect(validateStyleMin(style).map(error => error.message)).toEqual([]); mounted.dispose();
  });

  it('keeps feature-state IDs through the actual GeoJSON worker wrapper', async () => {
    const f = fixture(), mounted = await f.mount();
    for (const kind of ['fills', 'outlines', 'points'] as const) {
      const source = f.sources.get(ids[kind])!.data;
      expect(source.features.map(feature => feature.id)).toEqual(source.features.map((_, index) => index + 1));
      const tile = geojsonvt(source, {}).getTile(0, 0, 0); expect(tile).not.toBeNull();
      const wrapped = new GeoJSONWrapper(tile!.features, {extent: 4096, version: 2});
      const wrappedIds = Array.from({length: wrapped.length}, (_, index) => wrapped.feature(index).id);
      expect(wrappedIds).toEqual(source.features.map(feature => feature.id));
      if (kind !== 'points') {
        const key = `${ids[kind]}:${wrappedIds[0]}`;
        expect(f.states.get(key)?.visibleOpacity).toBe(1);
      }
    }
    mounted.dispose();
  });

  it('updates rename, retirement and owned-zero conditions without using controlled counts as ownership', async () => {
    const f = fixture(), initial = world(), mounted = await f.mount(initial); f.zoomTo(3);
    f.map.setFilter.mockClear(); const pointSource = f.sources.get(ids.points)!; pointSource.setData.mockClear();
    const renamed = changeCountry(initial, 'AAA', {mapKo: 'New Alpha'}); mounted.updateWorld(renamed, {});
    expect(f.map.setFilter).toHaveBeenCalledTimes(3); expect(pointSource.setData).toHaveBeenCalledOnce();
    expect(f.visible('fills', 0)).toBe(false); expect(f.visible('points', 0)).toBe(true);
    expect(pointSource.data.features[0].properties.currentText).toBe('New Alpha');
    const retired = {...renamed, countryOrder: renamed.countryOrder.filter(id => id !== 'BBB'), countriesById: {AAA: renamed.countriesById.AAA, CCC: renamed.countriesById.CCC}};
    mounted.updateWorld(retired, {}); expect(f.map.setFilter).toHaveBeenCalledTimes(6);
    expect(f.visible('fills', 2)).toBe(false); expect(f.visible('points', 1)).toBe(false);
    expect(pointSource.data.features[1].properties.currentText).toBe('');
    mounted.updateWorld(retired, {AAA: {owned: 0, controlled: 7, occupied: 0}});
    expect(f.map.setFilter).toHaveBeenCalledTimes(9); expect(f.visible('points', 0)).toBe(false);
    mounted.updateWorld(retired, {AAA: {owned: 2, controlled: 0, occupied: 2}});
    expect(f.map.setFilter).toHaveBeenCalledTimes(12); expect(f.visible('points', 0)).toBe(true);
    mounted.updateWorld(retired, {AAA: {owned: 3, controlled: 4, occupied: 1}});
    expect(f.map.setFilter).toHaveBeenCalledTimes(12); expect(pointSource.setData).toHaveBeenCalledTimes(2); mounted.dispose();
  });

  it('writes a changed label palette once per country feature and restores defaults through undo and redo', async () => {
    const f = fixture(), initial = world(), mounted = await f.mount(initial), pointSource = f.sources.get(ids.points)!;
    f.map.setFilter.mockClear(); f.map.setFeatureState.mockClear(); pointSource.setData.mockClear();
    const white = changeCountry(initial, 'AAA', {mapColor: '#FFFFFF'}); mounted.updateWorld(white, {});
    expect(f.map.setFeatureState).toHaveBeenCalledTimes(4);
    for (const [target, state] of f.map.setFeatureState.mock.calls) {
      expect(target.source).not.toBe(ids.points); expect([1, 2]).toContain(target.id);
      expect(state).toEqual({color: '#172E35', halo: '#FFFFFF'});
    }
    mounted.updateWorld(white, {}); mounted.updateWorld(changeCountry(white, 'AAA', {mapColor: '#FFFFFE'}), {});
    expect(f.map.setFeatureState).toHaveBeenCalledTimes(4); // Equal presentations also need no writes.
    mounted.updateWorld(initial, {}); expect(f.map.setFeatureState).toHaveBeenCalledTimes(8);
    expect(f.map.setFeatureState.mock.calls.slice(-4).every(([, state]) => state.color === '#FFFFFF' && state.halo === '#53615F')).toBe(true);
    mounted.updateWorld(white, {}); expect(f.map.setFeatureState).toHaveBeenCalledTimes(12);
    expect(f.map.setFilter).not.toHaveBeenCalled(); expect(pointSource.setData).not.toHaveBeenCalled(); mounted.dispose();
  });

  it('hides seed countries already retired before mounting and applies current text and color when they return', async () => {
    const f = fixture(), complete = world(), initial = {...complete, countryOrder: complete.countryOrder.filter(id => id !== 'BBB'),
      countriesById: {AAA: complete.countriesById.AAA, CCC: complete.countriesById.CCC}}, mounted = await f.mount(initial); f.zoomTo(3);
    expect(f.visible('fills', 2)).toBe(false); expect(f.visible('points', 1)).toBe(false);
    expect(f.sources.get(ids.points)!.data.features[1].properties.currentText).toBe('');
    f.map.setFeatureState.mockClear(); mounted.updateWorld(complete, {});
    expect(f.visible('fills', 2)).toBe(true); expect(f.visible('points', 1)).toBe(true);
    expect(f.sources.get(ids.points)!.data.features[1].properties.currentText).toBe('Beta');
    expect(f.map.setFeatureState).toHaveBeenCalledTimes(2); mounted.dispose();
  });

  it('initializes empty first-point text in source data, skips repeated visibility and cleans up on disposal', async () => {
    const f = fixture(), complete = world(), initial = {...complete, countryOrder: complete.countryOrder.filter(id => id !== 'AAA'),
      countriesById: {BBB: complete.countriesById.BBB, CCC: complete.countriesById.CCC}}, mounted = await f.mount(initial);
    const pointSource = f.sources.get(ids.points)!;
    expect(pointSource.data.features[0].properties.currentText).toBe('');
    mounted.updateWorld(initial, {}); expect(pointSource.setData).not.toHaveBeenCalled();
    mounted.visibility(true); expect(f.map.setLayoutProperty).not.toHaveBeenCalled();
    mounted.visibility(false); mounted.visibility(false); expect(f.map.setLayoutProperty).toHaveBeenCalledTimes(3);
    mounted.visibility(true); expect(f.map.setLayoutProperty).toHaveBeenCalledTimes(6);
    const zoomListener = f.listeners.get('zoom')!, filterCalls = f.map.setFilter.mock.calls.length;
    mounted.dispose(); mounted.dispose(); f.zoomTo(5); zoomListener(); mounted.updateWorld(complete, {}); mounted.visibility(false);
    expect(f.map.off).toHaveBeenCalledOnce(); expect(f.sources.size).toBe(0); expect(f.layers.size).toBe(0);
    expect(f.map.removeSource).toHaveBeenCalledTimes(3); expect(f.map.removeLayer).toHaveBeenCalledTimes(3);
    expect(f.map.setFilter).toHaveBeenCalledTimes(filterCalls); expect(f.map.setLayoutProperty).toHaveBeenCalledTimes(6);
  });
});
