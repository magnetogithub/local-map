import type {FeatureCollection} from 'geojson';
import type {LayerSpecification,SourceSpecification} from 'maplibre-gl';
import type {WorldStateV3} from '../world/world-state-v3';
import {createCatalogMapConsumerProjection,catalogHitTerritory,catalogCountryPanelView,CATALOG_MAP_SOURCE_ID} from '../projection/catalog-map-consumer-projection';
import {mapLibreFeatureTarget} from './render-feature-ref';
import type {CatalogVectorDelivery} from './catalog-vector-delivery';
import {fetchCatalogVectorDelivery,registerCatalogTileProtocol,type CatalogFetch} from './catalog-vector-delivery';
type HitFeature=Parameters<typeof catalogHitTerritory>[1];
type MapEvent={features?:HitFeature[]};
export const CATALOG_MAP_LAYER_IDS={fill:'catalog-territory-fill',edges:'catalog-territory-edges',hover:'catalog-territory-hover',selected:'catalog-territory-selected',labels:'catalog-country-labels',capitals:'catalog-capitals'} as const;
const labelSource='catalog-country-labels',capitalSource='catalog-capitals';
export type CatalogMapPort={
  addSource:(id:string,source:SourceSpecification)=>unknown;removeSource:(id:string)=>unknown;
  addLayer:(layer:LayerSpecification)=>unknown;removeLayer:(id:string)=>unknown;
  getSource:(id:string)=>unknown;getLayer:(id:string)=>unknown;
  setFeatureState:(target:{source:string;sourceLayer?:string;id:string},state:Record<string,unknown>)=>unknown;
  on:(event:string,layer:string,listener:(event:MapEvent)=>void)=>unknown;off:(event:string,layer:string,listener:(event:MapEvent)=>void)=>unknown;
};
/** Explicit opt-in consumer; production's V2 store/bootstrap is not mounted here. */
export function createCatalogMapConsumer(input:{map:CatalogMapPort;delivery:CatalogVectorDelivery;world:WorldStateV3;onSelect?:(countryId:string|null)=>void;onHover?:(countryId:string|null)=>void}){
  const {map,delivery}=input;let currentInput=input.world,projection=createCatalogMapConsumerProjection(input.world,delivery.metadata),selected:string|null=null,hovered:string|null=null,disposed=false;
  for(const id of [CATALOG_MAP_SOURCE_ID,labelSource,capitalSource])if(map.getSource(id))throw new Error('Catalog consumer source already exists');
  for(const id of Object.values(CATALOG_MAP_LAYER_IDS))if(map.getLayer(id))throw new Error('Catalog consumer layer already exists');
  const collections=()=>({labels:{type:'FeatureCollection',features:[...projection.labels.pointFallbacksByLabelId.values()]} as unknown as FeatureCollection,
    capitals:{type:'FeatureCollection',features:projection.capitals.features} as unknown as FeatureCollection});
  const initial=collections();map.addSource(CATALOG_MAP_SOURCE_ID,delivery.source);map.addSource(labelSource,{type:'geojson',data:initial.labels});map.addSource(capitalSource,{type:'geojson',data:initial.capitals});
  const L=CATALOG_MAP_LAYER_IDS;
  map.addLayer({id:L.fill,type:'fill',source:CATALOG_MAP_SOURCE_ID,'source-layer':'territories',paint:{'fill-color':['coalesce',['feature-state','mapColor'],'#D6D3C7']}});
  map.addLayer({id:L.edges,type:'line',source:CATALOG_MAP_SOURCE_ID,'source-layer':'edges',paint:{'line-color':'#53615F','line-width':['case',['==',['get','boundaryClass'],'administrative'],0.3,0.8]}});
  for(const [id,key,color]of [[L.hover,'hover','#FFFFFF'],[L.selected,'selected','#FFE9A6']] as const)map.addLayer({id,type:'fill',source:CATALOG_MAP_SOURCE_ID,'source-layer':'territories',paint:{'fill-color':color,'fill-opacity':['case',['boolean',['feature-state',key],false],0.35,0]}});
  map.addLayer({id:L.labels,type:'symbol',source:labelSource,layout:{'text-field':['get','text'],'text-font':['Open Sans Regular'],'text-size':12},paint:{'text-color':'#FFFFFF','text-halo-color':'#53615F','text-halo-width':1}});
  map.addLayer({id:L.capitals,type:'circle',source:capitalSource,paint:{'circle-radius':2,'circle-color':'#34464D'}});
  const apply=(ids:readonly string[],state:Record<string,unknown>)=>{for(const id of ids)map.setFeatureState(mapLibreFeatureTarget(projection.featuresById[id].ref),state);};
  const featureState=(id:string)=>{const {ref,...state}=projection.featuresById[id];void ref;return {...state,hover:projection.featuresById[id].countryId===hovered&&hovered!==null,selected:projection.featuresById[id].countryId===selected&&selected!==null};};
  for(const id of projection.world.territoryOrder)apply([id],featureState(id));
  const setInteraction=(kind:'hover'|'selected',id:string|null)=>{
    if(disposed)throw new Error('Catalog consumer is disposed');if(id!==null&&!projection.world.countriesById[id])throw new Error('Country is not active');
    const old=kind==='hover'?hovered:selected;if(old===id)return;
    if(old)apply(projection.presentedByCountry[old]??[],{[kind]:false});if(id)apply(projection.presentedByCountry[id]??[],{[kind]:true});
    if(kind==='hover')hovered=id;else selected=id;
  };
  const click=(event:MapEvent)=>{const hit=event.features?.map(f=>catalogHitTerritory(projection,f)).find(Boolean);setInteraction('selected',hit?.countryId??null);input.onSelect?.(hit?.countryId??null);};
  const move=(event:MapEvent)=>{const hit=event.features?.map(f=>catalogHitTerritory(projection,f)).find(Boolean);setInteraction('hover',hit?.countryId??null);input.onHover?.(hit?.countryId??null);};
  const leave=()=>{setInteraction('hover',null);input.onHover?.(null);};
  map.on('click',L.fill,click);map.on('mousemove',L.fill,move);map.on('mouseleave',L.fill,leave);
  return Object.freeze({
    getProjection:()=>projection,getCountryPanel:(id:string|null)=>catalogCountryPanelView(projection,id),selectCountry:(id:string|null)=>setInteraction('selected',id),hoverCountry:(id:string|null)=>setInteraction('hover',id),
    updateWorld:(world:WorldStateV3)=>{
      if(disposed)throw new Error('Catalog consumer is disposed');if(world===currentInput||world===projection.world)return;if(world.revision<=projection.appliedRevision)throw new Error('Stale catalog projection revision');
      const previous=projection,next=createCatalogMapConsumerProjection(world,delivery.metadata);projection=next;currentInput=world;
      if(selected&&!next.world.countriesById[selected]){selected=null;input.onSelect?.(null);}if(hovered&&!next.world.countriesById[hovered]){hovered=null;input.onHover?.(null);}
      for(const id of next.world.territoryOrder){const a=previous.featuresById[id],b=next.featuresById[id];if(a.ownerCountryId!==b.ownerCountryId||a.controllerCountryId!==b.controllerCountryId||a.mapColor!==b.mapColor)apply([id],featureState(id));}
      const values=collections();for(const [source,data]of [[labelSource,values.labels],[capitalSource,values.capitals]] as const){const port=map.getSource(source) as {setData:(data:FeatureCollection)=>unknown}|undefined;if(!port)throw new Error('Catalog presentation source is missing');port.setData(data);}
    },
    dispose:()=>{if(disposed)return;map.off('click',L.fill,click);map.off('mousemove',L.fill,move);map.off('mouseleave',L.fill,leave);for(const id of Object.values(L).reverse())if(map.getLayer(id))map.removeLayer(id);for(const id of [capitalSource,labelSource,CATALOG_MAP_SOURCE_ID])if(map.getSource(id))map.removeSource(id);disposed=true;},
  });
}

/** Call after MapLibre's style is loaded. This opt-in entry point never changes the production store. */
export async function mountCatalogMapConsumer(input:Omit<Parameters<typeof createCatalogMapConsumer>[0],'delivery'>&{
  protocolApi:Parameters<typeof registerCatalogTileProtocol>[0];fetcher?:CatalogFetch;signal?:AbortSignal;
}){
  const delivery=await fetchCatalogVectorDelivery(input.world.catalogRef,input.fetcher,input.signal);
  input.signal?.throwIfAborted();const unregister=registerCatalogTileProtocol(input.protocolApi,delivery);
  try{
    const consumer=createCatalogMapConsumer({...input,delivery});let disposed=false;
    return Object.freeze({...consumer,dispose:()=>{if(disposed)return;consumer.dispose();unregister();disposed=true;}});
  }catch(error){unregister();throw error;}
}
