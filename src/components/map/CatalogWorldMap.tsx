'use client';
import {useEffect,useRef,useState} from 'react';
import * as maplibre from 'maplibre-gl';
import {createCatalogMapConsumer,CATALOG_MAP_LAYER_IDS,CATALOG_ADMINISTRATIVE_DETAIL_ZOOM} from '@/lib/map/catalog-map-consumer';
import {registerCatalogTileProtocol,type CatalogVectorDelivery} from '@/lib/map/catalog-vector-delivery';
import type {CatalogRuntime} from '@/lib/simulation/catalog-runtime';
import type {CatalogMapConsumerProjection} from '@/lib/projection/catalog-map-consumer-projection';
import {useGameSetupStore} from '@/stores/game-setup-store';
import {MAP_OPTIONS} from '@/lib/map/map-config';
import {nearestWrappedLongitude} from '@/lib/map/country-camera';
import type {GameUiSettings} from '@/lib/game-ui/ui-settings';
import {DEFAULT_GAME_UI_SETTINGS} from '@/lib/game-ui/ui-settings';
import {applyCatalogMapUiSettings} from '@/lib/game-ui/catalog-map-ui-settings-adapter';
import {mountCatalogLabelRenderer,CATALOG_GLYPH_IDS} from '@/lib/map/catalog-label-renderer';
export function CatalogWorldMap({runtime,delivery,mapProjection,uiSettings}:{runtime:CatalogRuntime;delivery:CatalogVectorDelivery;mapProjection:CatalogMapConsumerProjection;uiSettings?:GameUiSettings}){
  const container=useRef<HTMLDivElement>(null),consumer=useRef<ReturnType<typeof createCatalogMapConsumer>|null>(null),mapRef=useRef<maplibre.Map|null>(null);
  const projectionRef=useRef(mapProjection);
  const labelsRef=useRef<Awaited<ReturnType<typeof mountCatalogLabelRenderer>>|null>(null);
  const [status,setStatus]=useState<'loading'|'ready'|'error'>('loading');
  const [territorySelection,setTerritorySelection]=useState<string|null>(null);
  const selected=useGameSetupStore(s=>s.selectedCountryId),hover=useGameSetupStore(s=>s.hoveredCountryId),player=useGameSetupStore(s=>s.playerCountryId);
  const interactionRef=useRef({selected,hover,player});
  const settingsRef=useRef(uiSettings);
  useEffect(()=>{projectionRef.current=mapProjection;interactionRef.current={selected,hover,player};settingsRef.current=uiSettings;},[mapProjection,selected,hover,player,uiSettings]);
  useEffect(()=>{
    if(!container.current)return;
    let disposed=false,projectionBuilds=0,pairNotifications=0;const labelAbort=new AbortController();const unregister=registerCatalogTileProtocol(maplibre,delivery);
    const map=new maplibre.Map({container:container.current,style:{version:8,glyphs:'/fonts/{fontstack}/{range}.pbf',sources:{},layers:[{id:'sea-background',type:'background',paint:{'background-color':'#b8d2da'}}]},...MAP_OPTIONS,maxTileCacheSize:256,localIdeographFontFamily:'Noto Sans KR Local'});mapRef.current=map;
    map.addControl(new maplibre.NavigationControl(),'top-left');
    const syncDetailVisibility=()=>{
      if(map.getLayer(CATALOG_MAP_LAYER_IDS.administrativeEdges))map.setLayoutProperty(CATALOG_MAP_LAYER_IDS.administrativeEdges,'visibility',map.getZoom()>=CATALOG_ADMINISTRATIVE_DETAIL_ZOOM?'visible':'none');
    };
    map.on('zoom',syncDetailVisibility);
    const syncInteraction=()=>{const countries=runtime.getSnapshot().world.countriesById;consumer.current?.selectCountry(countries[interactionRef.current.selected??'']?interactionRef.current.selected:null);consumer.current?.hoverCountry(countries[interactionRef.current.hover??'']?interactionRef.current.hover:null);};
    map.once('load',()=>{
      if(disposed)return;
      consumer.current=createCatalogMapConsumer({map,delivery:{...delivery,source:{...delivery.source,attribution:'Natural Earth'}},world:runtime.getSnapshot().world,onTerritorySelect:setTerritorySelection,onSelect:id=>{const store=useGameSetupStore.getState();if(id)store.selectCountry(id);else store.clearSelectedCountry();},onHover:id=>{useGameSetupStore.getState().setHoveredCountry(id);map.getCanvas().style.cursor=id?'pointer':'';}});projectionBuilds++;
      applyCatalogMapUiSettings(map,settingsRef.current??DEFAULT_GAME_UI_SETTINGS);
      syncDetailVisibility();
      map.addLayer({id:'catalog-player-highlight',type:'line',source:'world-territory-catalog','source-layer':'territories',paint:{'line-color':['coalesce',['feature-state','selectionColor'],'#C1882E'],'line-width':2},filter:['in',['get','territoryId'],['literal',projectionRef.current.ownedByCountry[interactionRef.current.player??'']??[]]]});
      syncInteraction();
      void mountCatalogLabelRenderer(map,runtime.getSnapshot().world,labelAbort.signal).then(labels=>{if(disposed){labels.dispose();return;}labelsRef.current=labels;labels.updateWorld(runtime.getSnapshot().world);labels.visibility((settingsRef.current??DEFAULT_GAME_UI_SETTINGS).showCountryLabels);map.once('idle',()=>{if(!disposed)setStatus('ready');});map.triggerRepaint();}).catch(()=>{if(!disposed)setStatus('error');});
      const sourceIdentities=new WeakMap<object,number>();let nextIdentity=0;
      const debug={projectionRevision:()=>consumer.current?.getProjection().appliedRevision,territoryFeatures:()=>Object.entries(consumer.current?.getProjection().featuresById??{}).map(([id,f])=>({id,...f})),selectedCountry:()=>useGameSetupStore.getState().selectedCountryId,labelFeatures:()=>Object.fromEntries([...(labelsRef.current?.collections().entries()??[])].map(([id,c])=>[id,c.features.map(f=>({id:f.id,...f.properties}))])),sourceIdentity:(id:string)=>{const s=map.getSource(id);if(!s)return null;if(!sourceIdentities.has(s))sourceIdentities.set(s,++nextIdentity);return sourceIdentities.get(s);},getSnapshot:()=>({worldSchema:runtime.getSnapshot().world.schemaVersion,simulationSchema:runtime.getSnapshot().simulation.schemaVersion,date:runtime.getSnapshot().simulation.currentDate,worldRevision:runtime.getSnapshot().world.revision,catalogRef:delivery.bootstrap.catalogRef,
        pairNotifications,simulationRevision:runtime.getSnapshot().simulation.revision,playerCountryId:runtime.getSnapshot().simulation.playerCountryId,uiPlayerCountryId:useGameSetupStore.getState().playerCountryId,canUndo:runtime.canUndo(),canRedo:runtime.canRedo(),authorityOrder:runtime.getSnapshot().simulation.territorialControlAuthorityOrder,eventCount:runtime.getSnapshot().simulation.eventLog.length,
        projectionBuilds:consumer.current?.getUpdateStats().fullProjectionBuilds??projectionBuilds,...consumer.current?.getUpdateStats(),...labelsRef.current?.stats(),...delivery.counters()}),
        jumpTo:(center:[number,number],zoom:number)=>map.jumpTo({center,zoom}),project:(position:[number,number])=>{const p=map.project(position);return [p.x,p.y];},
        selectCountry:(id:string)=>useGameSetupStore.getState().selectCountry(id),focusCountry:(id:string)=>focus(new CustomEvent('pax:focus-country',{detail:id})),
        renderedTerritoryIds:()=>map.queryRenderedFeatures(undefined,{layers:[CATALOG_MAP_LAYER_IDS.fill]}).map(f=>String(f.id)),renderedLabelIds:()=>map.queryRenderedFeatures(undefined,{layers:[CATALOG_GLYPH_IDS.fills,CATALOG_GLYPH_IDS.fallback,CATALOG_GLYPH_IDS.point].filter(id=>!!map.getLayer(id))}).map(f=>String(f.properties.countryId)),
        countryFocus:(id:string)=>projectionRef.current.focusByCountryId[id],ready:()=>map.loaded()&&!map.isMoving()&&!!labelsRef.current?.ready(),restart:()=>runtime.restart(),
        territoryState:(id:string)=>consumer.current?.getProjection().featuresById[id],countryControl:(id:string)=>consumer.current?.getCountryPanel(id),inspectMap:()=>map};
      window.__PAX_CATALOG_DEBUG__=debug;
    });
    const unsubscribe=runtime.store.subscribe((next,previous)=>{pairNotifications++;if(next.world!==previous.world&&consumer.current){consumer.current.updateWorld(next.world);labelsRef.current?.updateWorld(next.world);projectionBuilds++;syncInteraction();}});
    const focus=(event:Event)=>{const id=(event as CustomEvent<string>).detail,p=projectionRef.current.focusByCountryId[id];if(p)map.flyTo({center:[nearestWrappedLongitude(p.center[0],map.getCenter().lng),p.center[1]],zoom:p.zoom,duration:settingsRef.current?.reduceMotion?0:900});};
    window.addEventListener('pax:focus-country',focus);
    const onError=()=>{if(!disposed)setStatus('error');};map.on('error',onError);
    const resize=new ResizeObserver(()=>map.resize());resize.observe(container.current);
    return()=>{disposed=true;labelAbort.abort();unsubscribe();resize.disconnect();window.removeEventListener('pax:focus-country',focus);map.off('zoom',syncDetailVisibility);labelsRef.current?.dispose();labelsRef.current=null;consumer.current?.dispose();consumer.current=null;map.remove();unregister();mapRef.current=null;delete window.__PAX_CATALOG_DEBUG__;};
  },[runtime,delivery]);
  useEffect(()=>{consumer.current?.selectCountry(selected);consumer.current?.hoverCountry(hover);const map=mapRef.current;if(map?.getLayer('catalog-player-highlight'))map.setFilter('catalog-player-highlight',['in',['get','territoryId'],['literal',mapProjection.ownedByCountry[player??'']??[]]]);},[selected,hover,player,mapProjection]);
  useEffect(()=>{const map=mapRef.current;if(map)applyCatalogMapUiSettings(map,uiSettings??DEFAULT_GAME_UI_SETTINGS);labelsRef.current?.visibility((uiSettings??DEFAULT_GAME_UI_SETTINGS).showCountryLabels);},[uiSettings,status]);
  const selection=territorySelection?mapProjection.featuresById[territorySelection]:null;
  const name=(id:string|null)=>id?mapProjection.world.countriesById[id]?.names.shortKo??'없음':'없음';
  return <section className="map-wrap" aria-label="2020년 세계 지도"><div ref={container} className="map" data-testid="world-map" data-map-status={status}/>{status!=='ready'&&<div className="map-status" role={status==='error'?'alert':'status'}><div className="box">{status==='loading'?'지도 데이터를 불러오는 중입니다':'지도 데이터를 불러오지 못했습니다. 새로고침 후 다시 시도하세요.'}</div></div>}<div className="legend"><span><i style={{background:'#fff'}}/>선택</span><span><i style={{background:'#c1882e'}}/>플레이 국가</span><span><i style={{background:'#40285E'}}/>점령</span><span>금색 점선: 점령 전선</span>{selection&&<span data-testid="territory-control-detail">소유: {name(selection.ownerCountryId)} · 통제: {name(selection.controllerCountryId)}{selection.occupied?' · 점령 중':''}</span>}</div></section>;
}
declare global{interface Window{__PAX_CATALOG_DEBUG__?:{
  projectionRevision:()=>number|undefined;territoryFeatures:()=>{id:string;countryId:string|null;ownerCountryId:string|null;mapColor:string}[];selectedCountry:()=>string|null;labelFeatures:()=>Record<string,Record<string,unknown>[]>;sourceIdentity:(id:string)=>number|null|undefined;
  getSnapshot:()=>Record<string,unknown>;territoryState:(id:string)=>unknown;countryControl:(id:string)=>unknown;jumpTo:(center:[number,number],zoom:number)=>unknown;project:(position:[number,number])=>number[];selectCountry:(id:string)=>void;focusCountry:(id:string)=>void;renderedTerritoryIds:()=>string[];renderedLabelIds:()=>string[];countryFocus:(id:string)=>{center:readonly[number,number];zoom:number}|undefined;ready:()=>boolean;restart:()=>unknown;inspectMap:()=>maplibre.Map;
}}}
