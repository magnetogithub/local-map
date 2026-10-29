'use client';
import {useCallback, useEffect, useRef, useState} from 'react';
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
  const [baseStatus, setBaseStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [worldStatus, setWorldStatus] = useState<'syncing' | 'ready' | 'error'>('syncing');
  const [detailStatus, setDetailStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [mapAttempt, setMapAttempt] = useState(0), [detailAttempt, setDetailAttempt] = useState(0);
  const [appliedRevision, setAppliedRevision] = useState<number | null>(null);
  const [territory, setTerritory] = useState<string | null>(null);
  const status = baseStatus === 'error' || worldStatus === 'error' ? 'error'
    : baseStatus === 'ready' && worldStatus === 'ready' ? 'ready' : 'loading';
  const ready = status === 'ready';
  const applySettings = useCallback(() => {
    const map = mapRef.current, settings = live.current.uiSettings;
    labels.current?.visibility(settings.showCountryLabels);
    if (map?.getLayer('operational-capitals')) map.setLayoutProperty('operational-capitals', 'visibility', settings.showCapitalMarkers ? 'visible' : 'none');
    if (map?.getLayer(L.country)) map.setPaintProperty(L.country, 'line-width', settings.emphasizeBorders ? 1.6 : .8);
  }, []);
  useEffect(() => {
    if (!container.current) return;
    const abort = new AbortController(); let disposed = false, baseFailed = false, worldRequest = 0;
    let capitalCountryOrder = client.getSnapshot().world.countryOrder;
    setBaseStatus('loading'); setWorldStatus('syncing'); setDetailStatus('idle'); setAppliedRevision(null);
    const map = new maplibre.Map({container: container.current, style: {version: 8, glyphs: '/fonts/{fontstack}/{range}.pbf', sources: {}, layers: [{id: 'sea-background', type: 'background', paint: {'background-color': '#b8d2da'}}]}, ...MAP_OPTIONS, maxTileCacheSize: 256, localIdeographFontFamily: 'Noto Sans KR Local'});
    mapRef.current = map; map.addControl(new maplibre.NavigationControl(), 'top-left');
    const fail = (error: unknown) => {if (!disposed && !abort.signal.aborted) {baseFailed = true; console.error('Operational map failed', error); setBaseStatus('error');}};
    map.on('error', event => fail(event.error));
    const interaction = () => {
      const store = useGameSetupStore.getState(), countries = client.getSnapshot().world.countriesById;
      consumer.current?.selectCountry(store.selectedCountryId && countries[store.selectedCountryId] ? store.selectedCountryId : null);
      consumer.current?.hoverCountry(store.hoveredCountryId && countries[store.hoveredCountryId] ? store.hoveredCountryId : null);
    };
    const synchronize = async (next: ReturnType<OperationalGameClient['getSnapshot']>, useDelta = false): Promise<void> => {
      const mounted = consumer.current;
      if (!mounted || disposed) return;
      const request = ++worldRequest;
      setWorldStatus('syncing');
      try {
        await mounted.updateWorld(next.world, useDelta ? next.stateChange ?? undefined : undefined);
        if (disposed || request !== worldRequest) return;
        const latest = client.getSnapshot();
        if (latest.world !== next.world) {await synchronize(latest); return;}
        labels.current?.updateWorld(next.world, next.counts);
        const capitals = map.getSource('operational-capitals') as maplibre.GeoJSONSource | undefined;
        if (capitalCountryOrder !== next.world.countryOrder) {
          capitals?.setData({type: 'FeatureCollection', features: live.current.presentation.capitals.features.filter(f => next.world.countriesById[f.id]).map(f => ({...f, geometry: {...f.geometry, coordinates: [...f.geometry.coordinates]}}))});
          capitalCountryOrder = next.world.countryOrder;
        }
        interaction(); setAppliedRevision(next.world.revision); setWorldStatus('ready');
      } catch (error) {
        if (!disposed && !abort.signal.aborted && request === worldRequest) {
          console.error('Operational world synchronization failed', error); setWorldStatus('error');
        }
      }
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
      await synchronize(client.getSnapshot()); applySettings();
      map.once('idle', () => {if (!disposed && !baseFailed) setBaseStatus('ready');}); map.triggerRepaint();
    })().catch(fail);});
    const unsubscribe = client.store.subscribe((next, previous) => {
      if (next.world !== previous.world && consumer.current) void synchronize(next, true);
    });
    const focus = (event: Event) => {
      const p = live.current.presentation.focusByCountryId[(event as CustomEvent<string>).detail];
      if (p) map.flyTo({center: [nearestWrappedLongitude(p.center[0], map.getCenter().lng), p.center[1]], zoom: p.zoom, duration: live.current.uiSettings.reduceMotion ? 0 : 900});
    };
    window.addEventListener('pax:focus-country', focus);
    const resize = new ResizeObserver(() => map.resize()); resize.observe(container.current);
    return () => {disposed = true; abort.abort(); unsubscribe(); resize.disconnect(); window.removeEventListener('pax:focus-country', focus); labels.current?.dispose(); labels.current = null; consumer.current?.dispose(); consumer.current = null; map.remove(); mapRef.current = null;};
  }, [applySettings, client, mapAttempt]);
  useEffect(() => {
    if (!ready) return;
    const countries = client.getSnapshot().world.countriesById;
    try {
      consumer.current?.selectCountry(selected && countries[selected] ? selected : null);
      consumer.current?.hoverCountry(hovered && countries[hovered] ? hovered : null);
    } catch (error) {console.error('Operational map interaction failed', error); setWorldStatus('error');}
  }, [client, selected, hovered, ready]);
  useEffect(() => {
    const current = consumer.current;
    if (!current || !ready) return;
    let disposed = false;
    const target = selected && client.getSnapshot().world.countriesById[selected] ? selected : null;
    if (target) {
      setDetailStatus('loading');
      void current.showCountryDetail(target).then(() => {
        if (!disposed) setDetailStatus('ready');
      }).catch(error => {
        if (!disposed) {console.error('Country detail failed', error); setDetailStatus('error');}
      });
    } else {
      try {current.clearDetail(); setDetailStatus('idle');}
      catch (error) {console.error('Country detail clear failed', error); setWorldStatus('error');}
    }
    return () => {
      disposed = true;
      // Invalidate pending source writes while selection or world readiness changes.
      try {current.clearDetail();} catch { /* The map may already be disposed or require resync. */ }
    };
  }, [client, selected, ready, detailAttempt]);
  useEffect(applySettings, [applySettings, uiSettings, status]);
  const cell = ready && territory ? presentation.world.territoriesById[territory] : null;
  const name = (id: string | null) => id ? presentation.world.countriesById[id]?.names.shortKo ?? id : '없음';
  return <section className="map-wrap" aria-label="2020년 세계 지도"><div ref={container} className="map" data-testid="world-map" data-map-status={status} data-map-base-status={baseStatus} data-map-world-status={worldStatus} data-map-applied-revision={appliedRevision ?? undefined}/>
    {status !== 'ready' && <div className="map-status" role={status === 'error' ? 'alert' : 'status'}><div className="box">{status === 'error' ? <>{worldStatus === 'error' ? '현재 세계 상태를 지도에 반영하지 못했습니다.' : '지도 데이터를 불러오지 못했습니다.'}<button type="button" onClick={() => setMapAttempt(value => value + 1)}>지도 다시 불러오기</button></> : baseStatus === 'loading' ? '지도 데이터를 불러오는 중입니다' : '현재 세계 상태를 지도에 반영하는 중입니다'}</div></div>}
    {ready && detailStatus === 'loading' && <div className="detail-status" role="status">선택한 국가의 상세 지도를 불러오는 중입니다.</div>}
    {ready && detailStatus === 'error' && <div className="detail-status error" role="alert">선택한 국가의 상세 지도를 불러오지 못했습니다. 기본 지도는 계속 사용할 수 있습니다.<button type="button" onClick={() => setDetailAttempt(value => value + 1)}>상세 지도 다시 시도</button></div>}
    <div className="legend"><span><i style={{background: '#fff'}}/>선택</span><span>점령색: 현재 통제국</span><span>금색 점선: 현재 전선</span>{cell && <span data-testid="territory-control-detail">소유: {name(cell.ownerCountryId)} · 통제: {name(cell.controllerCountryId)}{cell.ownerCountryId !== cell.controllerCountryId ? ' · 점령 중' : ''}</span>}</div></section>;
}
