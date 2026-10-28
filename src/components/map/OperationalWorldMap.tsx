'use client';
import {useEffect, useRef, useState} from 'react';
import * as maplibre from 'maplibre-gl';
import type {OperationalGameClient} from '@/lib/simulation/client/operational-game-client';
import type {operationalGamePresentation} from '@/lib/projection/operational-game-presentation';
import {createOperationalMapConsumer, OPERATIONAL_MAP_LAYERS as L, type OperationalMapConsumer} from '@/lib/map/operational-map-consumer';
import {fetchOperationalVectorDelivery, type OperationalVectorDelivery} from '@/lib/map/operational-vector-delivery';
import {mountOperationalCountryLabels} from '@/lib/map/operational-country-labels';
import {useGameSetupStore} from '@/stores/game-setup-store';
import {MAP_OPTIONS} from '@/lib/map/map-config';
import {nearestWrappedLongitude} from '@/lib/map/country-camera';
import {DEFAULT_GAME_UI_SETTINGS, type GameUiSettings} from '@/lib/game-ui/ui-settings';

const deliveries = new WeakMap<OperationalGameClient, Promise<OperationalVectorDelivery>>();
export function OperationalWorldMap({client, presentation, uiSettings = DEFAULT_GAME_UI_SETTINGS}: {
  client: OperationalGameClient; presentation: ReturnType<typeof operationalGamePresentation>; uiSettings?: GameUiSettings;
}) {
  const container = useRef<HTMLDivElement>(null), mapRef = useRef<maplibre.Map | null>(null), consumer = useRef<OperationalMapConsumer | null>(null);
  const labels = useRef<Awaited<ReturnType<typeof mountOperationalCountryLabels>> | null>(null);
  const live = useRef({presentation, uiSettings});
  useEffect(() => {live.current = {presentation, uiSettings};}, [presentation, uiSettings]);
  const selected = useGameSetupStore(s => s.selectedCountryId), hovered = useGameSetupStore(s => s.hoveredCountryId);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading'), [territory, setTerritory] = useState<string | null>(null);
  const ready = status === 'ready';
  const applySettings = () => {
    const map = mapRef.current, settings = live.current.uiSettings;
    labels.current?.visibility(settings.showCountryLabels);
    if (map?.getLayer('operational-capitals')) map.setLayoutProperty('operational-capitals', 'visibility', settings.showCapitalMarkers ? 'visible' : 'none');
    if (map?.getLayer(L.country)) map.setPaintProperty(L.country, 'line-width', settings.emphasizeBorders ? 1.6 : .8);
  };
  useEffect(() => {
    if (!container.current) return;
    const abort = new AbortController(); let disposed = false;
    setStatus('loading');
    const map = new maplibre.Map({container: container.current, style: {version: 8, glyphs: '/fonts/{fontstack}/{range}.pbf', sources: {}, layers: [{id: 'sea-background', type: 'background', paint: {'background-color': '#b8d2da'}}]}, ...MAP_OPTIONS, maxTileCacheSize: 256, localIdeographFontFamily: 'Noto Sans KR Local'});
    mapRef.current = map; map.addControl(new maplibre.NavigationControl(), 'top-left');
    const fail = (error: unknown) => {if (!disposed && !abort.signal.aborted) {console.error('Operational map failed', error); setStatus('error');}};
    map.on('error', event => fail(event.error));
    const interaction = () => {
      const store = useGameSetupStore.getState(), countries = client.getSnapshot().world.countriesById;
      consumer.current?.selectCountry(store.selectedCountryId && countries[store.selectedCountryId] ? store.selectedCountryId : null);
      consumer.current?.hoverCountry(store.hoveredCountryId && countries[store.hoveredCountryId] ? store.hoveredCountryId : null);
    };
    map.once('load', () => {void (async () => {
      let delivery = deliveries.get(client);
      if (!delivery) {delivery = fetchOperationalVectorDelivery(client.getSnapshot().world.catalogRef).catch(error => {deliveries.delete(client); throw error;}); deliveries.set(client, delivery);}
      const loaded = await delivery; abort.signal.throwIfAborted();
      const mounted = await createOperationalMapConsumer({map, protocolApi: maplibre, delivery: loaded, world: client.getSnapshot().world, signal: abort.signal,
        onTerritorySelect: setTerritory, onSelect: id => {const store = useGameSetupStore.getState(); if (id) store.selectCountry(id); else store.clearSelectedCountry();},
        onHover: id => {useGameSetupStore.getState().setHoveredCountry(id); map.getCanvas().style.cursor = id ? 'pointer' : '';}});
      if (disposed) {mounted.dispose(); return;} consumer.current = mounted;
      await mounted.updateWorld(client.getSnapshot().world);
      map.addSource('operational-capitals', {type: 'geojson', data: {type: 'FeatureCollection', features: live.current.presentation.capitals.features.map(f => ({...f, geometry: {...f.geometry, coordinates: [...f.geometry.coordinates]}}))}});
      map.addLayer({id: 'operational-capitals', type: 'circle', source: 'operational-capitals', paint: {'circle-radius': 2, 'circle-color': '#34464D'}});
      const text = await mountOperationalCountryLabels(map, client.getSnapshot().world, abort.signal);
      if (disposed) {text.dispose(); return;} labels.current = text;
      text.updateWorld(client.getSnapshot().world, client.getSnapshot().counts); applySettings(); interaction();
      map.once('idle', () => {if (!disposed) setStatus('ready');}); map.triggerRepaint();
    })().catch(fail);});
    const unsubscribe = client.store.subscribe((next, previous) => {
      if (next.world !== previous.world && consumer.current) void consumer.current.updateWorld(next.world, next.stateChange ?? undefined).then(() => {if (!disposed) {
        labels.current?.updateWorld(next.world, next.counts);
        const capitals = map.getSource('operational-capitals') as maplibre.GeoJSONSource | undefined;
        if (next.world.countryOrder.length !== previous.world.countryOrder.length) capitals?.setData({type: 'FeatureCollection', features: live.current.presentation.capitals.features.filter(f => next.world.countriesById[f.id]).map(f => ({...f, geometry: {...f.geometry, coordinates: [...f.geometry.coordinates]}}))});
        interaction();
      }}).catch(fail);
    });
    const focus = (event: Event) => {
      const p = live.current.presentation.focusByCountryId[(event as CustomEvent<string>).detail];
      if (p) map.flyTo({center: [nearestWrappedLongitude(p.center[0], map.getCenter().lng), p.center[1]], zoom: p.zoom, duration: live.current.uiSettings.reduceMotion ? 0 : 900});
    };
    window.addEventListener('pax:focus-country', focus);
    const resize = new ResizeObserver(() => map.resize()); resize.observe(container.current);
    return () => {disposed = true; abort.abort(); unsubscribe(); resize.disconnect(); window.removeEventListener('pax:focus-country', focus); labels.current?.dispose(); labels.current = null; consumer.current?.dispose(); consumer.current = null; map.remove(); mapRef.current = null;};
  }, [client]);
  useEffect(() => {consumer.current?.selectCountry(selected); consumer.current?.hoverCountry(hovered);}, [selected, hovered, status]);
  useEffect(() => {
    const current = consumer.current;
    if (!current) return;
    if (selected) void current.showCountryDetail(selected).catch(error => {console.error('Country detail failed', error); setStatus('error');});
    else current.clearDetail();
  }, [selected, ready]);
  useEffect(applySettings, [uiSettings, status]);
  const cell = territory ? presentation.world.territoriesById[territory] : null;
  const name = (id: string | null) => id ? presentation.world.countriesById[id]?.names.shortKo ?? id : '없음';
  return <section className="map-wrap" aria-label="2020년 세계 지도"><div ref={container} className="map" data-testid="world-map" data-map-status={status}/>
    {status !== 'ready' && <div className="map-status" role={status === 'error' ? 'alert' : 'status'}><div className="box">{status === 'loading' ? '지도 데이터를 불러오는 중입니다' : '지도 데이터를 불러오지 못했습니다. 새로고침 후 다시 시도하세요.'}</div></div>}
    <div className="legend"><span><i style={{background: '#fff'}}/>선택</span><span>점령색: 현재 통제국</span><span>금색 점선: 현재 전선</span>{cell && <span data-testid="territory-control-detail">소유: {name(cell.ownerCountryId)} · 통제: {name(cell.controllerCountryId)}{cell.ownerCountryId !== cell.controllerCountryId ? ' · 점령 중' : ''}</span>}</div></section>;
}
