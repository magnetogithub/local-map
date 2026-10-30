import type {Map as MapLibreMap, GeoJSONSource} from 'maplibre-gl';
import type {FeatureCollection, Geometry} from 'geojson';
import type {WorldStateV3} from '../world/world-state-v3';
import type {OperationalControlCounts} from '../simulation/operational-game-protocol';
import {mapColorPresentation} from '../world/country-map-color';

type Collection = FeatureCollection<Geometry, Record<string, unknown>>;
const ids = {fills: 'operational-label-fills', outlines: 'operational-label-outlines', points: 'operational-label-points'};
/** Reuse the approved shaped country names. Renames use current text at the approved anchor. */
export async function mountOperationalCountryLabels(map: MapLibreMap, initial: WorldStateV3, signal: AbortSignal) {
  const response = await fetch('/api/world/labels', {signal});
  if (!response.ok) throw Error('LABEL_SEED_UNAVAILABLE');
  const seed = await response.json() as {placements: Collection; fills: Collection; outlines: Collection};
  const seedNames = new Map(seed.placements.features.map(f => [String(f.properties.countryId), String(f.properties.mapLabelKo)]));
  signal.throwIfAborted();
  // GeoJSONWrapper parses string IDs as integers. Source-local numeric IDs
  // survive worker tiling and match the feature-state keys used by GPU paint.
  const withIds = (data: Collection): Collection => ({...data, features: data.features.map((f, i) => ({...f, id: i + 1}))});
  const collections = {fills: withIds(seed.fills), outlines: withIds(seed.outlines.features.length ? seed.outlines : seed.fills), points: withIds(seed.placements)};
  for (const f of collections.points.features) f.properties = {...f.properties, currentText: initial.countriesById[String(f.properties.countryId)]?.names.mapKo ?? ''};
  const features = Object.values(collections).flatMap(data => data.features);
  const countryIds = [...new Set(features.map(f => String(f.properties.countryId)))].sort();
  const initialColors = new Map<string, string | undefined>();
  for (const id of countryIds) initialColors.set(id, initial.countriesById[id]?.mapColor);
  const pointMinZooms = [...new Set(collections.points.features.map(f => f.properties.minZoom ?? 1).filter((value): value is number => typeof value === 'number' && Number.isFinite(value)))].sort((a, b) => a - b);
  // These indexes and caches live only as long as the mounted seed sources and retain one entry per seed country.
  const colorTargets = new Map<string, {source: string; id: string | number}[]>();
  const opacityTargets = new Map<number, {source: string; id: string | number}[]>();
  for (const kind of ['fills', 'outlines'] as const) for (const f of collections[kind].features) {
    const countryId = String(f.properties.countryId), targets = colorTargets.get(countryId) ?? [];
    targets.push({source: ids[kind], id: f.id!}); colorTargets.set(countryId, targets);
    const minZoom = f.properties.minZoom ?? 1;
    if (typeof minZoom === 'number' && Number.isFinite(minZoom)) {
      const opacity = opacityTargets.get(minZoom) ?? [];
      opacity.push({source: ids[kind], id: f.id!}); opacityTargets.set(minZoom, opacity);
    }
  }
  const glyphMinZooms = [...opacityTargets.keys()].sort((a, b) => a - b);
  const appliedColors = new Map<string, string>(), appliedPalettes = new Map<string, {color: string; halo: string}>();
  const defaultPalette = {color: '#FFFFFF', halo: '#53615F'};
  for (const [kind, id] of Object.entries(ids)) map.addSource(id, {type: 'geojson', data: collections[kind as keyof typeof ids]});
  map.addLayer({id: ids.outlines, type: 'line', source: ids.outlines, minzoom: 1, paint: {'line-color': ['coalesce', ['feature-state', 'halo'], '#53615F'], 'line-width': 1.5, 'line-opacity': ['coalesce', ['feature-state', 'visibleOpacity'], 0]}});
  map.addLayer({id: ids.fills, type: 'fill', source: ids.fills, minzoom: 1, paint: {'fill-color': ['coalesce', ['feature-state', 'color'], '#FFFFFF'], 'fill-opacity': ['coalesce', ['feature-state', 'visibleOpacity'], 0]}});
  map.addLayer({id: ids.points, type: 'symbol', source: ids.points, layout: {'text-field': ['get', 'currentText'], 'text-font': ['Open Sans Regular'], 'text-size': 14, 'text-max-width': 10, 'text-allow-overlap': false}, paint: {'text-color': '#FFFFFF', 'text-halo-color': '#53615F', 'text-halo-width': 1.5}});
  let visible = true, disposed = false;
  let hidden: string[] = [], renamed: string[] = [], filterWorldKey = '', appliedWorldKey: string | undefined;
  let appliedPointWorldKey: string | undefined, appliedPointZoomBucket: number | undefined, appliedGlyphZoomBucket: number | undefined;
  const bucket = (thresholds: readonly number[], zoom: number) => {
    let lower = 0, upper = thresholds.length;
    while (lower < upper) {const middle = (lower + upper) >>> 1; if (thresholds[middle] <= zoom) lower = middle + 1; else upper = middle;}
    return lower;
  };
  const pointFilter = (zoom: number) => {
    const nextBucket = bucket(pointMinZooms, zoom);
    if (nextBucket === appliedPointZoomBucket && filterWorldKey === appliedPointWorldKey) return;
    map.setFilter(ids.points, ['all', ['!', ['in', ['get', 'countryId'], ['literal', hidden]]], ['<=', ['coalesce', ['get', 'minZoom'], 1], zoom], ['any', ['==', ['get', 'placementMode'], 'small-country-point'], ['in', ['get', 'countryId'], ['literal', renamed]]]]);
    appliedPointZoomBucket = nextBucket; appliedPointWorldKey = filterWorldKey;
  };
  const glyphOpacity = (zoom: number) => {
    const nextBucket = bucket(glyphMinZooms, zoom), previous = appliedGlyphZoomBucket ?? 0;
    if (nextBucket === previous && appliedGlyphZoomBucket !== undefined) return;
    // Composite step(zoom) paint is sampled at integer bucket zooms by MapLibre.
    // Source-only feature state preserves every exact fractional threshold and
    // updates paint buffers without rebuilding the shaped glyph geometry.
    for (let i = Math.min(previous, nextBucket); i < Math.max(previous, nextBucket); i++) {
      for (const target of opacityTargets.get(glyphMinZooms[i])!) map.setFeatureState(target, {visibleOpacity: nextBucket > previous ? 1 : 0});
    }
    appliedGlyphZoomBucket = nextBucket;
  };
  const syncZoom = () => {
    if (disposed) return;
    const zoom = map.getZoom(); glyphOpacity(zoom); pointFilter(zoom);
  };
  const updateWorld = (next: WorldStateV3, control: OperationalControlCounts) => {
    if (disposed) return;
    const currentName = (id: string) => next.countriesById[id]?.names.mapKo ?? '';
    if (collections.points.features.some(f => f.properties.currentText !== currentName(String(f.properties.countryId)))) {
      collections.points = {...collections.points, features: collections.points.features.map(f => ({...f, properties: {...f.properties, currentText: currentName(String(f.properties.countryId))}}))};
      (map.getSource(ids.points) as GeoJSONSource).setData(collections.points);
    }
    for (const [id, targets] of colorTargets) {
      const country = next.countriesById[id];
      if (!country || appliedColors.get(id) === country.mapColor) continue;
      const presentation = mapColorPresentation(country.mapColor), previous = appliedPalettes.get(id) ?? defaultPalette;
      const palette = country.mapColor === initialColors.get(id) ? defaultPalette : {color: presentation.labelColor, halo: presentation.labelHaloColor};
      if (previous.color !== palette.color || previous.halo !== palette.halo) for (const target of targets) map.setFeatureState(target, palette);
      appliedColors.set(id, country.mapColor); appliedPalettes.set(id, palette);
    }
    hidden = countryIds.filter(id => !next.countriesById[id] || control[id]?.owned === 0);
    renamed = countryIds.filter(id => next.countriesById[id] && currentName(id) !== seedNames.get(id));
    filterWorldKey = JSON.stringify([hidden, renamed]);
    if (filterWorldKey !== appliedWorldKey) {
      for (const id of [ids.fills, ids.outlines]) map.setFilter(id, ['!', ['in', ['get', 'countryId'], ['literal', [...hidden, ...renamed]]]]);
      appliedWorldKey = filterWorldKey;
    }
    syncZoom();
  };
  // Symbol opacity does not remove collision boxes. Only the small placement
  // source retains a zoom filter so hidden points cannot block visible labels.
  map.on('zoom', syncZoom); updateWorld(initial, {});
  return {updateWorld, visibility: (value: boolean) => {if (disposed || value === visible) return; visible = value; for (const id of Object.values(ids)) map.setLayoutProperty(id, 'visibility', visible ? 'visible' : 'none');},
    dispose: () => {if (disposed) return; disposed = true; map.off('zoom', syncZoom); initialColors.clear(); colorTargets.clear(); opacityTargets.clear(); appliedColors.clear(); appliedPalettes.clear(); for (const id of Object.values(ids).reverse()) {if (map.getLayer(id)) map.removeLayer(id); if (map.getSource(id)) map.removeSource(id);}}};
}
