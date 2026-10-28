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
  const withIds = (data: Collection, kind: string): Collection => ({...data, features: data.features.map((f, i) => ({...f, id: `${kind}:${i}`}))});
  const collections = {fills: withIds(seed.fills, 'fill'), outlines: withIds(seed.outlines.features.length ? seed.outlines : seed.fills, 'outline'), points: withIds(seed.placements, 'point')};
  for (const [kind, id] of Object.entries(ids)) map.addSource(id, {type: 'geojson', data: collections[kind as keyof typeof ids]});
  map.addLayer({id: ids.outlines, type: 'line', source: ids.outlines, minzoom: 1, paint: {'line-color': ['coalesce', ['feature-state', 'halo'], '#53615F'], 'line-width': 1.5}});
  map.addLayer({id: ids.fills, type: 'fill', source: ids.fills, minzoom: 1, paint: {'fill-color': ['coalesce', ['feature-state', 'color'], '#FFFFFF']}});
  map.addLayer({id: ids.points, type: 'symbol', source: ids.points, layout: {'text-field': ['get', 'currentText'], 'text-font': ['Open Sans Regular'], 'text-size': 14, 'text-max-width': 10, 'text-allow-overlap': false}, paint: {'text-color': '#FFFFFF', 'text-halo-color': '#53615F', 'text-halo-width': 1.5}});
  let world = initial, counts: OperationalControlCounts = {}, visible = true;
  const filter = () => {
    const hidden = initial.countryOrder.filter(id => !world.countriesById[id] || counts[id]?.owned === 0);
    const renamed = world.countryOrder.filter(id => world.countriesById[id].names.mapKo !== seedNames.get(id));
    for (const id of [ids.fills, ids.outlines]) map.setFilter(id, ['all', ['!', ['in', ['get', 'countryId'], ['literal', [...hidden, ...renamed]]]], ['<=', ['coalesce', ['get', 'minZoom'], 1], map.getZoom()]]);
    map.setFilter(ids.points, ['all', ['!', ['in', ['get', 'countryId'], ['literal', hidden]]], ['<=', ['coalesce', ['get', 'minZoom'], 1], map.getZoom()], ['any', ['==', ['get', 'placementMode'], 'small-country-point'], ['in', ['get', 'countryId'], ['literal', renamed]]]]);
  };
  const updateWorld = (next: WorldStateV3, control: OperationalControlCounts) => {
    const changedNames = next.countryOrder.some(id => next.countriesById[id].names.mapKo !== world.countriesById[id]?.names.mapKo);
    world = next; counts = control;
    if (changedNames || !(collections.points.features[0]?.properties.currentText)) {
      collections.points = {...collections.points, features: collections.points.features.map(f => ({...f, properties: {...f.properties, currentText: world.countriesById[String(f.properties.countryId)]?.names.mapKo ?? ''}}))};
      (map.getSource(ids.points) as GeoJSONSource).setData(collections.points);
    }
    for (const kind of ['fills', 'outlines'] as const) for (const f of collections[kind].features) {
      const c = world.countriesById[String(f.properties.countryId)];
      if (c) {const p = mapColorPresentation(c.mapColor), unchanged = c.mapColor === initial.countriesById[c.id]?.mapColor; map.setFeatureState({source: ids[kind], id: f.id!}, {color: unchanged ? '#FFFFFF' : p.labelColor, halo: unchanged ? '#53615F' : p.labelHaloColor});}
    }
    filter();
  };
  map.on('zoom', filter); updateWorld(initial, counts);
  return {updateWorld, visibility: (value: boolean) => {visible = value; for (const id of Object.values(ids)) map.setLayoutProperty(id, 'visibility', visible ? 'visible' : 'none');},
    dispose: () => {map.off('zoom', filter); for (const id of Object.values(ids).reverse()) {if (map.getLayer(id)) map.removeLayer(id); if (map.getSource(id)) map.removeSource(id);}}};
}
