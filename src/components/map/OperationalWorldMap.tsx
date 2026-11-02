'use client';
import {useCallback, useEffect, useRef, useState} from 'react';
import * as maplibre from 'maplibre-gl';
import type {OperationalGameClient} from '@/lib/simulation/client/operational-game-client';
import type {operationalGamePresentation} from '@/lib/projection/operational-game-presentation';
import {createOperationalMapConsumer, OPERATIONAL_MAP_LAYERS as L, OPERATIONAL_CHANGED_CELL_SOURCE_ID, OPERATIONAL_FRONT_SOURCE_ID, OPERATIONAL_PROVINCE_LOD_SOURCE_ID, OPERATIONAL_MICRO_LOD_SOURCE_ID, type OperationalMapConsumer} from '@/lib/map/operational-map-consumer';
import {mountOperationalPointerHover} from '@/lib/map/operational-pointer-hover';
import {OPERATIONAL_EXACT_CELL_SOURCE_ID, OPERATIONAL_EXACT_EDGE_SOURCE_ID} from '@/lib/map/operational-map-sources';
import {fetchOperationalVectorDelivery, type OperationalVectorDelivery} from '@/lib/map/operational-vector-delivery';
import {mountOperationalCountryLabels} from '@/lib/map/operational-country-labels';
import {useGameSetupStore} from '@/stores/game-setup-store';
import {MAP_OPTIONS} from '@/lib/map/map-config';
import {nearestWrappedLongitude} from '@/lib/map/country-camera';
import {DEFAULT_GAME_UI_SETTINGS, type GameUiSettings} from '@/lib/game-ui/ui-settings';
import {operationalCountryBorderWidth} from '@/lib/map/operational-boundary-style';

// Display revisions refresh the map bootstrap while retaining the game client.
const MAP_PRESENTATION_VERSION = 'chn-internal-lines-edc8c590e072774bd876';
const deliveries = new WeakMap<OperationalGameClient, {presentationVersion: string; delivery: Promise<OperationalVectorDelivery>}>();
type DebugFeature = Readonly<{id: string | number | null; layerId: string; source: string; sourceLayer: string | null; properties: Record<string, unknown>}>;
type OperationalMapDebug = Readonly<{
  jumpTo: (center: [number, number], zoom: number) => void;
  getCenter: () => [number, number];
  getZoom: () => number;
  project: (position: [number, number]) => [number, number];
  isRenderSettled: () => boolean;
  getUpdateStats: () => ReturnType<OperationalMapConsumer['getUpdateStats']> | null;
  getLayerState: (id: string) => Readonly<{id: string; type: string; source: string | null; sourceLayer: string | null; paint: unknown; filter: unknown; visibility: unknown}> | null;
  queryRenderedFeatures: (options?: {point?: [number, number]; layers?: string[]}) => DebugFeature[];
  queryRenderedFillIds: () => DebugFeature[];
  querySourceFeatureIds: (source: string, sourceLayer?: string) => (string | number)[];
  setDebugBoundaries: (enabled: boolean) => void;
  selectCountryDetail: (countryId: string | null) => void;
  getState: () => Readonly<{
    catalogRef: ReturnType<OperationalGameClient['getSnapshot']>['world']['catalogRef'];
    revision: number; simulationRevision: number;
    counts: Readonly<{countries: number; cells: number; edges: number | null}>;
    controlCounts: ReturnType<OperationalGameClient['getSnapshot']>['counts'];
    selectedCountryId: string | null; hoveredCountryId: string | null; debugBoundaries: boolean;
    baseStatus: string; worldStatus: string; detailStatus: string; appliedRevision: number | null;
  }>;
}>;
declare global {interface Window {__PAX_OPERATIONAL_DEBUG__?: OperationalMapDebug}}

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
  const [debugDetailMode, setDebugDetailMode] = useState(uiSettings.debugMapBoundaries);
  const debugBoundaryOverride = useRef<boolean | null>(null);
  const refreshDisplayLods = useRef<() => void>(() => {});
  const diagnosticStatus = useRef({baseStatus, worldStatus, detailStatus, appliedRevision});
  useEffect(() => {diagnosticStatus.current = {baseStatus, worldStatus, detailStatus, appliedRevision};}, [baseStatus, worldStatus, detailStatus, appliedRevision]);
  const [territory, setTerritory] = useState<string | null>(null);
  const status = baseStatus === 'error' || worldStatus === 'error' ? 'error'
    : baseStatus === 'ready' && worldStatus === 'ready' ? 'ready' : 'loading';
  const ready = status === 'ready';
  const applySettings = useCallback(() => {
    const map = mapRef.current, settings = live.current.uiSettings;
    labels.current?.visibility(settings.showCountryLabels);
    if (map?.getLayer('operational-capitals')) map.setLayoutProperty('operational-capitals', 'visibility', settings.showCapitalMarkers ? 'visible' : 'none');
    const mounted = consumer.current;
    const debug = debugBoundaryOverride.current ?? settings.debugMapBoundaries;
    if (mounted && !mounted.getUpdateStats().resyncRequired) mounted.setDebugBoundaries(debug);
    refreshDisplayLods.current();
    setDebugDetailMode(debug);
    for (const id of [L.country, L.detailCountry]) {
      if (map?.getLayer(id)) map.setPaintProperty(id, 'line-width', operationalCountryBorderWidth(settings.emphasizeBorders));
    }
  }, []);
  useEffect(() => {
    if (!container.current) return;
    const abort = new AbortController(); let disposed = false, baseFailed = false, worldRequest = 0;
    let stopDisplayLodView = () => {}, stopPointerHover = () => {};
    let capitalCountryOrder = client.getSnapshot().world.countryOrder;
    setBaseStatus('loading'); setWorldStatus('syncing'); setDetailStatus('idle'); setAppliedRevision(null);
    const map = new maplibre.Map({container: container.current, style: {version: 8, glyphs: '/fonts/{fontstack}/{range}.pbf', sources: {}, layers: [{id: 'sea-background', type: 'background', paint: {'background-color': '#b8d2da'}}]}, ...MAP_OPTIONS, maxTileCacheSize: 256, localIdeographFontFamily: 'Noto Sans KR Local',
      attributionControl: {compact: true, customAttribution: ['Natural Earth', '<a href="https://www.geoboundaries.org" target="_blank" rel="noopener noreferrer">geoBoundaries</a> (CC BY 4.0)',
        '한국 시군구: geoBoundaries·City Population, 2020 · <a href="https://creativecommons.org/licenses/by/3.0/" target="_blank" rel="noopener noreferrer">CC BY 3.0</a> (geoBoundaries 배포 CC BY 4.0)',
        '북한 시군구: WFP/OCHA · 자료 기준연도 2013/2019 · <a href="https://creativecommons.org/licenses/by/3.0/igo/" target="_blank" rel="noopener noreferrer">CC BY 3.0 IGO</a>',
        '중국 군·구: OpenStreetMap·Wambacher·geoBoundaries · 메타데이터 2017 / 처리 2021 (혼합 시점) · <a href="https://opendatacommons.org/licenses/odbl/1-0/" target="_blank" rel="noopener noreferrer">ODbL 1.0</a> · <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">© OpenStreetMap contributors</a>',
        '중국 성급선: OSM·geoBoundaries 원본과 미세 구역을 정합한 게임용 참고 표시 · 미확정 구간 보존']}});
    mapRef.current = map; map.addControl(new maplibre.NavigationControl(), 'top-left');
    let loadedDelivery: OperationalVectorDelivery | null = null;
    // Local browser QA can inspect rendering and use the ordinary selection UI.
    // This bridge exposes no command client, authoritative state, or game writes.
    const debugBridge: OperationalMapDebug | null = process.env.NODE_ENV === 'development' ? {
      jumpTo: (center, zoom) => {map.jumpTo({center, zoom});},
      getCenter: () => {const center = map.getCenter(); return [center.lng, center.lat];},
      getZoom: () => map.getZoom(),
      project: position => {const point = map.project(position); return [point.x, point.y];},
      isRenderSettled: () => {
        const state = diagnosticStatus.current;
        return !disposed && state.baseStatus === 'ready' && state.worldStatus === 'ready' && state.detailStatus !== 'loading'
          && !!consumer.current && !consumer.current.getUpdateStats().resyncRequired && map.loaded() && map.areTilesLoaded() && !map.isMoving()
          && [OPERATIONAL_EXACT_CELL_SOURCE_ID, OPERATIONAL_EXACT_EDGE_SOURCE_ID, OPERATIONAL_CHANGED_CELL_SOURCE_ID, OPERATIONAL_FRONT_SOURCE_ID, OPERATIONAL_PROVINCE_LOD_SOURCE_ID, OPERATIONAL_MICRO_LOD_SOURCE_ID].every(id => !map.getSource(id) || map.isSourceLoaded(id));
      },
      getUpdateStats: () => consumer.current?.getUpdateStats() ?? null,
      getLayerState: id => {
        const layer = map.getStyle()?.layers?.find(layer => layer.id === id);
        if (!layer) return null;
        return {id, type: layer.type, source: 'source' in layer && typeof layer.source === 'string' ? layer.source : null,
          sourceLayer: 'source-layer' in layer ? layer['source-layer'] ?? null : null,
          paint: layer.paint ? structuredClone(layer.paint) : {}, filter: 'filter' in layer ? structuredClone(layer.filter ?? null) : null,
          visibility: map.getLayoutProperty(id, 'visibility') ?? 'visible'};
      },
      queryRenderedFeatures: (options = {}) => {
        const layers = options.layers?.filter(id => !!map.getLayer(id));
        const features = options.point ? map.queryRenderedFeatures(options.point, {layers}) : map.queryRenderedFeatures({layers});
        return features.map(feature => ({id: feature.id ?? null, layerId: feature.layer.id, source: feature.source,
          sourceLayer: feature.sourceLayer ?? null, properties: {...feature.properties}}));
      },
      queryRenderedFillIds: () => {
        const layers = [L.fill, L.detailFill, L.changedFill].filter(id => !!map.getLayer(id));
        if (!layers.length) return [];
        return map.queryRenderedFeatures({layers}).map(feature => ({id: feature.id ?? null, layerId: feature.layer.id, source: feature.source,
          sourceLayer: feature.sourceLayer ?? null, properties: {...feature.properties}}));
      },
      querySourceFeatureIds: (source, sourceLayer) => [...new Set(map.querySourceFeatures(source, {sourceLayer}).flatMap(feature => feature.id === undefined ? [] : [feature.id]))],
      setDebugBoundaries: enabled => {debugBoundaryOverride.current = enabled; consumer.current?.setDebugBoundaries(enabled); refreshDisplayLods.current(); setDebugDetailMode(enabled);},
      selectCountryDetail: countryId => {
        const store = useGameSetupStore.getState();
        if (countryId === null) store.clearSelectedCountry();
        else {
          if (!client.getSnapshot().world.countriesById[countryId]) throw Error('UNKNOWN_DEBUG_COUNTRY');
          store.selectCountry(countryId);
        }
      },
      getState: () => {
        const snapshot = client.getSnapshot();
        return {catalogRef: {...snapshot.world.catalogRef}, revision: snapshot.world.revision, simulationRevision: snapshot.revisions.simulationRevision,
          counts: {countries: snapshot.world.countryOrder.length, cells: snapshot.world.territoryOrder.length, edges: loadedDelivery?.bootstrap.catalog.counts.edges ?? null},
          controlCounts: structuredClone(snapshot.counts), selectedCountryId: useGameSetupStore.getState().selectedCountryId, hoveredCountryId: useGameSetupStore.getState().hoveredCountryId,
          debugBoundaries: debugBoundaryOverride.current ?? live.current.uiSettings.debugMapBoundaries, ...diagnosticStatus.current};
      },
    } : null;
    if (debugBridge) window.__PAX_OPERATIONAL_DEBUG__ = debugBridge;
    const fail = (error: unknown) => {if (!disposed && !abort.signal.aborted) {baseFailed = true; console.error('Operational map failed', error); setBaseStatus('error');}};
    map.on('error', event => fail(event.error));
    const interaction = () => {
      const store = useGameSetupStore.getState(), countries = client.getSnapshot().world.countriesById;
      consumer.current?.selectCountry(store.selectedCountryId && countries[store.selectedCountryId] ? store.selectedCountryId : null);
      consumer.current?.hoverCountry(store.hoveredCountryId && countries[store.hoveredCountryId] ? store.hoveredCountryId : null);
      refreshDisplayLods.current();
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
      let cached = deliveries.get(client);
      if (cached?.presentationVersion !== MAP_PRESENTATION_VERSION) {
        cached = {presentationVersion: MAP_PRESENTATION_VERSION, delivery: fetchOperationalVectorDelivery(client.getSnapshot().world.catalogRef).catch(error => {deliveries.delete(client); throw error;})};
        deliveries.set(client, cached);
      }
      const loaded = await cached.delivery; abort.signal.throwIfAborted(); loadedDelivery = loaded;
      const mounted = await createOperationalMapConsumer({map, protocolApi: maplibre, delivery: loaded, world: client.getSnapshot().world, signal: abort.signal, externalHover: true,
        onTerritorySelect: setTerritory, onSelect: id => {const store = useGameSetupStore.getState(); if (id) store.selectCountry(id); else store.clearSelectedCountry();},
        onHover: id => {useGameSetupStore.getState().setHoveredCountry(id); map.getCanvas().style.cursor = id ? 'pointer' : '';}});
      if (disposed) {mounted.dispose(); return;} consumer.current = mounted;
      await mounted.updateWorld(client.getSnapshot().world);
      stopPointerHover = mountOperationalPointerHover(map, [L.changedFill, L.detailFill, L.fill], ordinal => {
        const world = mounted.getProjection().world, cell = world.territoriesById[world.territoryOrder[ordinal - 1]];
        const country = cell?.ownerCountryId ?? cell?.controllerCountryId ?? null;
        return country && world.countriesById[country] ? country : null;
      }, id => {
        if (mounted.getUpdateStats().resyncRequired) return;
        const store = useGameSetupStore.getState();
        if (store.hoveredCountryId !== id) {mounted.hoverCountry(id); store.setHoveredCountry(id); refreshDisplayLods.current();}
        map.getCanvas().style.cursor = id ? 'pointer' : '';
      });
      const lodViews: {synchronize: () => void; settle: () => void; load: () => void; sourceId: string}[] = [];
      for (const kind of ['province', 'micro'] as const) {
        const lod = kind === 'province' ? loaded.bootstrap?.provinceBoundaryLod : loaded.bootstrap?.microBoundaryLod;
        if (!lod) continue;
        const sourceId = kind === 'province' ? OPERATIONAL_PROVINCE_LOD_SOURCE_ID : OPERATIONAL_MICRO_LOD_SOURCE_ID;
        const isReady = () => kind === 'province' ? mounted.getUpdateStats().provinceDisplayLodReady : mounted.getUpdateStats().microDisplayLodReady;
        const setEnabled = (enabled: boolean) => kind === 'province' ? mounted.setProvinceBoundaryLodEnabled(enabled) : mounted.setMicroBoundaryLodEnabled(enabled);
        let loading: Promise<void> | undefined, activationReady = false;
        const eligible = () => {
          if (kind === 'micro' && !mounted.getUpdateStats().microDisplayLodInScope) return false;
          const z = map.getZoom(), bounds = map.getBounds(), [w, s, e, n] = lod.bounds;
          if (z < lod.minZoom || z >= lod.maxZoom || bounds.getSouth() > n || bounds.getNorth() < s) return false;
          const width = Math.abs(bounds.getEast() - bounds.getWest());
          if (width >= 360) return true;
          const west = ((bounds.getWest() + 180) % 360 + 360) % 360 - 180;
          return [-360, 0, 360].some(offset => west + offset <= e && west + width + offset >= w);
        };
        const synchronizeLod = () => {
          if (!disposed) setEnabled(eligible() && activationReady && isReady() && map.isSourceLoaded(sourceId));
        };
        const loadLod = () => {
          synchronizeLod();
          if (disposed || !eligible() || loading || isReady()) return;
          loading = (kind === 'province' ? mounted.loadProvinceBoundaryLod(abort.signal) : mounted.loadMicroBoundaryLod(abort.signal)).then(() => {if (!disposed) map.triggerRepaint();}).catch(error => {
            if (!disposed && !abort.signal.aborted) {setEnabled(false); console.warn(`${kind} display detail unavailable; original lines retained`, error);}
          }).finally(() => {loading = undefined;});
        };
        // Do not change visibility reentrantly inside Style.update/sourcedata.
        // Defer activation to idle so the next normal style/prepare pass uploads
        // the newly visible source before drawing it.
        const settle = () => {if (isReady() && map.isSourceLoaded(sourceId)) activationReady = true; synchronizeLod();};
        lodViews.push({synchronize: synchronizeLod, settle, load: loadLod, sourceId});
      }
      const synchronizeLods = () => lodViews.forEach(view => view.synchronize());
      const loadLods = () => lodViews.forEach(view => view.load());
      const settleLods = () => lodViews.forEach(view => view.settle());
      const sourceReady = (event: maplibre.MapSourceDataEvent) => {if (lodViews.some(view => view.sourceId === event.sourceId)) map.triggerRepaint();};
      map.on('move', synchronizeLods); map.on('moveend', loadLods); map.on('sourcedata', sourceReady); map.on('idle', settleLods);
      refreshDisplayLods.current = loadLods;
      stopDisplayLodView = () => {refreshDisplayLods.current = () => {}; map.off('move', synchronizeLods); map.off('moveend', loadLods); map.off('sourcedata', sourceReady); map.off('idle', settleLods);};
      loadLods();
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
    return () => {disposed = true; if (debugBridge && window.__PAX_OPERATIONAL_DEBUG__ === debugBridge) delete window.__PAX_OPERATIONAL_DEBUG__; abort.abort(); stopPointerHover(); stopDisplayLodView(); unsubscribe(); resize.disconnect(); window.removeEventListener('pax:focus-country', focus); labels.current?.dispose(); labels.current = null; consumer.current?.dispose(); consumer.current = null; map.remove(); mapRef.current = null;};
  }, [applySettings, client, mapAttempt]);
  useEffect(() => {
    if (!ready) return;
    const countries = client.getSnapshot().world.countriesById;
    try {
      consumer.current?.selectCountry(selected && countries[selected] ? selected : null);
      consumer.current?.hoverCountry(hovered && countries[hovered] ? hovered : null);
      refreshDisplayLods.current();
    } catch (error) {console.error('Operational map interaction failed', error); setWorldStatus('error');}
  }, [client, selected, hovered, ready]);
  useEffect(() => {
    const current = consumer.current, map = mapRef.current;
    if (!current || !map || baseStatus !== 'ready') return;
    let disposed = false, pending: AbortController | undefined, timer: ReturnType<typeof setTimeout> | undefined;
    // Selection is independent of debug inspection. Inspect only the country
    // under the pointer, using bounded shards when this catalog provides them.
    const target = hovered && client.getSnapshot().world.countriesById[hovered] && current.supportsCountryViewportDetail(hovered) ? hovered : null;
    const cancel = () => {if (timer !== undefined) clearTimeout(timer); timer = undefined; pending?.abort(); pending = undefined;};
    const clear = () => {if (current.getUpdateStats().selectedDetailCells) current.clearDetail();};
    const run = () => {
      timer = undefined;
      // Verified vector tiles already contain the complete gameplay partition.
      // Selection needs feature state, not a second national GeoJSON database.
      // Neighbor fine lines use the scoped vector tiles. Optional inspection
      // is limited to the hovered country's settled, enlarged viewport.
      if (!target || !debugDetailMode || map.getZoom() < 7) {clear(); setDetailStatus('idle'); return;}
      const request = new AbortController(); pending = request; setDetailStatus('loading');
      const bounds = map.getBounds();
      void current.showCountryViewportDetail(target, [bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()], request.signal).then(() => {
        if (!disposed && !request.signal.aborted) setDetailStatus('ready');
      }).catch(error => {
        if (!disposed && !request.signal.aborted) {
          console.error('Viewport detail failed', error);
          if (current.getUpdateStats().resyncRequired) setWorldStatus('error'); else setDetailStatus('error');
        }
      });
    };
    const moving = () => {cancel();};
    const settled = () => {
      cancel();
      if (!target || !debugDetailMode || map.getZoom() < 7) {clear(); setDetailStatus('idle'); return;}
      setDetailStatus('loading'); timer = setTimeout(run, 120);
    };
    map.on('movestart', moving); map.on('moveend', settled); settled();
    return () => {
      disposed = true; cancel(); map.off('movestart', moving); map.off('moveend', settled);
      try {clear();} catch { /* The map may already be disposed or require resync. */ }
    };
  }, [client, hovered, baseStatus, detailAttempt, debugDetailMode]);
  useEffect(applySettings, [applySettings, uiSettings, status]);
  const cell = ready && territory ? presentation.world.territoriesById[territory] : null;
  const name = (id: string | null) => id ? presentation.world.countriesById[id]?.names.shortKo ?? id : '없음';
  return <section className="map-wrap" aria-label="2020년 세계 지도"><div ref={container} className="map" data-testid="world-map" data-map-status={status} data-map-base-status={baseStatus} data-map-world-status={worldStatus} data-map-applied-revision={appliedRevision ?? undefined}/>
    {status !== 'ready' && <div className="map-status" role={status === 'error' ? 'alert' : 'status'}><div className="box">{status === 'error' ? <>{worldStatus === 'error' ? '현재 세계 상태를 지도에 반영하지 못했습니다.' : '지도 데이터를 불러오지 못했습니다.'}<button type="button" onClick={() => setMapAttempt(value => value + 1)}>지도 다시 불러오기</button></> : baseStatus === 'loading' ? '지도 데이터를 불러오는 중입니다' : '현재 세계 상태를 지도에 반영하는 중입니다'}</div></div>}
    {ready && detailStatus === 'loading' && <div className="detail-status" role="status">선택한 국가의 상세 지도를 불러오는 중입니다.</div>}
    {ready && detailStatus === 'error' && <div className="detail-status error" role="alert">선택한 국가의 상세 지도를 불러오지 못했습니다. 기본 지도는 계속 사용할 수 있습니다.<button type="button" onClick={() => setDetailAttempt(value => value + 1)}>상세 지도 다시 시도</button></div>}
    <div className="legend"><span><i style={{background: '#fff'}}/>선택</span><span>점령색: 현재 통제국</span><span>금색 점선: 점령 전선</span>{cell && <span data-testid="territory-control-detail">소유: {name(cell.ownerCountryId)} · 통제: {name(cell.controllerCountryId)}{cell.ownerCountryId !== cell.controllerCountryId ? ' · 점령 중' : ''}</span>}</div></section>;
}
