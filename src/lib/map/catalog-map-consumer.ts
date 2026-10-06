import type {LayerSpecification,SourceSpecification} from 'maplibre-gl';
import type {WorldStateV3} from '../world/world-state-v3';
import {createCatalogMapConsumerProjection,updateCatalogMapConsumerProjection,catalogHitTerritory,catalogCountryPanelView,CATALOG_MAP_SOURCE_ID} from '../projection/catalog-map-consumer-projection';
import {mapLibreFeatureTarget} from './render-feature-ref';
import {diffMapSourceFeatures,type IdFeatureCollection} from './map-source-incremental-adapter';
import type {CatalogVectorDelivery,CatalogEdgeIncidence} from './catalog-vector-delivery';
import {fetchCatalogVectorDelivery,registerCatalogTileProtocol,type CatalogFetch} from './catalog-vector-delivery';
import {updateCatalogColorProjection,catalogColorFeatureState} from '../projection/catalog-color-projection';
type HitFeature=Parameters<typeof catalogHitTerritory>[1];
type MapEvent={features?:HitFeature[]};
export const CATALOG_ADMINISTRATIVE_DETAIL_ZOOM=4;
export const CATALOG_MAP_LAYER_IDS={fill:'catalog-territory-fill',edges:'catalog-territory-edges',administrativeEdges:'catalog-administrative-edges',occupation:'catalog-territory-occupation',front:'catalog-occupation-front',hover:'catalog-territory-hover',selected:'catalog-territory-selected',labels:'catalog-country-labels',capitals:'catalog-capitals'} as const;
const labelSource='catalog-country-labels',capitalSource='catalog-capitals';
export type CatalogMapPort={
  addSource:(id:string,source:SourceSpecification)=>unknown;removeSource:(id:string)=>unknown;
  addLayer:(layer:LayerSpecification)=>unknown;removeLayer:(id:string)=>unknown;
  getSource:(id:string)=>unknown;getLayer:(id:string)=>unknown;
  setFeatureState:(target:{source:string;sourceLayer?:string;id:string},state:Record<string,unknown>)=>unknown;
  on:(event:string,layer:string,listener:(event:MapEvent)=>void)=>unknown;off:(event:string,layer:string,listener:(event:MapEvent)=>void)=>unknown;
};
/** Explicit opt-in consumer; production's V2 store/bootstrap is not mounted here. */
export function createCatalogMapConsumer(input:{map:CatalogMapPort;delivery:CatalogVectorDelivery;world:WorldStateV3;onSelect?:(countryId:string|null)=>void;onHover?:(countryId:string|null)=>void;onTerritorySelect?:(id:string|null)=>void}){
  const {map,delivery}=input;let currentInput=input.world,projection=createCatalogMapConsumerProjection(input.world,delivery.metadata),selected:string|null=null,hovered:string|null=null,disposed=false;
  const fullProjectionBuilds=1;let colorProjectionUpdates=0;
  for(const id of [CATALOG_MAP_SOURCE_ID,labelSource,capitalSource])if(map.getSource(id))throw new Error('Catalog consumer source already exists');
  for(const id of Object.values(CATALOG_MAP_LAYER_IDS))if(map.getLayer(id))throw new Error('Catalog consumer layer already exists');
  const collections=(p:typeof projection)=>({labels:{type:'FeatureCollection',features:[...p.labels.pointFallbacksByLabelId.values()].map(f=>{
    const properties:Record<string,unknown>={...f.properties};delete properties.projectionRevision;
    return {...f,properties};
  })} as unknown as IdFeatureCollection,
    capitals:{type:'FeatureCollection',features:p.capitals.features} as unknown as IdFeatureCollection});
  const initial=collections(projection);map.addSource(CATALOG_MAP_SOURCE_ID,delivery.source);map.addSource(labelSource,{type:'geojson',data:initial.labels});map.addSource(capitalSource,{type:'geojson',data:initial.capitals});
  const L=CATALOG_MAP_LAYER_IDS;
  // Match each fill's antialiased outline to its color to cover subpixel seams.
  // Visible administrative and national boundaries belong to the edge layers.
  map.addLayer({id:L.fill,type:'fill',source:CATALOG_MAP_SOURCE_ID,'source-layer':'territories',paint:{'fill-color':['coalesce',['feature-state','mapColor'],'#D6D3C7'],'fill-outline-color':['coalesce',['feature-state','mapColor'],'#D6D3C7'],'fill-antialias':true}});
  map.addLayer({id:L.administrativeEdges,type:'line',source:CATALOG_MAP_SOURCE_ID,'source-layer':'edges',minzoom:CATALOG_ADMINISTRATIVE_DETAIL_ZOOM,filter:['==',['get','boundaryClass'],'administrative'],paint:{'line-color':'#FFFFFF','line-opacity':['interpolate',['linear'],['zoom'],2.2,0,3,0.22,5,0.52],'line-width':['interpolate',['linear'],['zoom'],2.2,0.25,5,0.85,7,1]}});
  map.addLayer({id:L.edges,type:'line',source:CATALOG_MAP_SOURCE_ID,'source-layer':'edges',filter:['!=',['get','boundaryClass'],'administrative'],paint:{'line-color':'#53615F','line-width':['case',['==',['get','boundaryClass'],'administrative'],0.3,0.8]}});
  map.addLayer({id:L.occupation,type:'fill',source:CATALOG_MAP_SOURCE_ID,'source-layer':'territories',paint:{'fill-color':'#40285E','fill-opacity':['case',['boolean',['feature-state','occupied'],false],0.18,0]}});
  map.addLayer({id:L.front,type:'line',source:CATALOG_MAP_SOURCE_ID,'source-layer':'edges',paint:{'line-color':'#D9A43C','line-width':2,'line-dasharray':[3,2],'line-opacity':['case',['boolean',['feature-state','front'],false],1,0]}});
  for(const [id,key]of [[L.hover,'hover'],[L.selected,'selected']] as const)map.addLayer({id,type:'fill',source:CATALOG_MAP_SOURCE_ID,'source-layer':'territories',paint:{'fill-color':['coalesce',['feature-state','selectionColor'],'#FFFFFF'],'fill-opacity':['case',['boolean',['feature-state',key],false],0.18,0]}});
  map.addLayer({id:L.labels,type:'symbol',source:labelSource,layout:{'text-field':['get','text'],'text-font':['Open Sans Regular'],'text-size':12},paint:{'text-color':['coalesce',['feature-state','labelColor'],'#FFFFFF'],'text-halo-color':['coalesce',['feature-state','labelHaloColor'],'#53615F'],'text-halo-width':1.5}});
  map.addLayer({id:L.capitals,type:'circle',source:capitalSource,paint:{'circle-radius':2,'circle-color':'#34464D'}});
  const apply=(ids:readonly string[],state:Record<string,unknown>)=>{for(const id of ids)map.setFeatureState(mapLibreFeatureTarget(projection.featuresById[id].ref),state);};
  const featureState=(id:string)=>{const {ref,...state}=projection.featuresById[id];void ref;return {...state,...catalogColorFeatureState(state.mapColor),hover:projection.featuresById[id].countryId===hovered&&hovered!==null,selected:projection.featuresById[id].countryId===selected&&selected!==null};};
  for(const id of projection.world.territoryOrder)apply([id],featureState(id));
  const labelColors=(ids:readonly string[])=>{for(const id of ids){const country=projection.world.countriesById[id];if(country)map.setFeatureState({source:labelSource,id:`catalog-label:${id}`},catalogColorFeatureState(country.mapColor));}};
  labelColors(projection.world.countryOrder);
  const edgesByTerritory=new Map<string,Set<string>>(),edges=new Map<string,CatalogEdgeIncidence>(),edgeStates=new Map<string,boolean>();
  let edgeUpdates=0,territoryUpdates=0;
  const applyEdges=(ids:Iterable<string>)=>{for(const id of ids){const e=edges.get(id)!;const a=e.left?projection.featuresById[e.left]:null,b=e.right?projection.featuresById[e.right]:null;
    const front=!!(a&&b&&(a.occupied||b.occupied)&&((a.controllerCountryId??a.ownerCountryId)!==(b.controllerCountryId??b.ownerCountryId)));
    if(edgeStates.get(id)===front)continue;edgeStates.set(id,front);map.setFeatureState({source:CATALOG_MAP_SOURCE_ID,sourceLayer:'edges',id},{front});edgeUpdates++;
  }};
  const stopEdges=delivery.observeEdges(batch=>{for(const e of batch){edges.set(e.id,e);for(const t of [e.left,e.right])if(t){const ids=edgesByTerritory.get(t)??new Set();ids.add(e.id);edgesByTerritory.set(t,ids);}}applyEdges(batch.map(e=>e.id));});
  const setInteraction=(kind:'hover'|'selected',id:string|null)=>{
    if(disposed)throw new Error('Catalog consumer is disposed');if(id!==null&&!projection.world.countriesById[id])throw new Error('Country is not active');
    const old=kind==='hover'?hovered:selected;if(old===id)return;
    if(old)apply(projection.presentedByCountry[old]??[],{[kind]:false});if(id)apply(projection.presentedByCountry[id]??[],{[kind]:true});
    if(kind==='hover')hovered=id;else selected=id;
  };
  const click=(event:MapEvent)=>{const hit=event.features?.map(f=>catalogHitTerritory(projection,f)).find(Boolean);setInteraction('selected',hit?.countryId??null);input.onSelect?.(hit?.countryId??null);input.onTerritorySelect?.(hit?.territoryId??null);};
  const move=(event:MapEvent)=>{const hit=event.features?.map(f=>catalogHitTerritory(projection,f)).find(Boolean);setInteraction('hover',hit?.countryId??null);input.onHover?.(hit?.countryId??null);};
  const leave=()=>{setInteraction('hover',null);input.onHover?.(null);};
  map.on('click',L.fill,click);map.on('mousemove',L.fill,move);map.on('mouseleave',L.fill,leave);
  return Object.freeze({
    getUpdateStats:()=>({fullProjectionBuilds,colorProjectionUpdates,...projection.projectionStats,territoryUpdates,edgeUpdates,indexedEdges:edges.size}),
    getProjection:()=>projection,getCountryPanel:(id:string|null)=>catalogCountryPanelView(projection,id),selectCountry:(id:string|null)=>setInteraction('selected',id),hoverCountry:(id:string|null)=>setInteraction('hover',id),
    updateWorld:(world:WorldStateV3)=>{
      if(disposed)throw new Error('Catalog consumer is disposed');if(world===currentInput||world===projection.world)return;if(world.revision<=projection.appliedRevision)throw new Error('Stale catalog projection revision');
      const color=updateCatalogColorProjection(projection,world);
      if(color){projection=color.projection;currentInput=world;colorProjectionUpdates++;for(const id of color.changedFeatureIds)apply([id],featureState(id));territoryUpdates+=color.changedFeatureIds.length;labelColors(color.changedCountryIds);return;}
      const previous=projection,update=updateCatalogMapConsumerProjection(previous,world),next=update.projection;projection=next;currentInput=world;
      if(selected&&!next.world.countriesById[selected]){selected=null;input.onSelect?.(null);}if(hovered&&!next.world.countriesById[hovered]){hovered=null;input.onHover?.(null);}
      for(const id of update.changedFeatureIds)apply([id],featureState(id));territoryUpdates+=update.changedFeatureIds.length;
      applyEdges(new Set(update.changedFeatureIds.flatMap(id=>[...edgesByTerritory.get(id)??[]])));
      const old=collections(previous),values=collections(next);
      for(const [source,a,b]of [[labelSource,old.labels,values.labels],[capitalSource,old.capitals,values.capitals]] as const){
        const {diff,changedIds}=diffMapSourceFeatures(a,b,source);if(!changedIds.length)continue;
        const port=map.getSource(source) as {updateData:(diff:import('maplibre-gl').GeoJSONSourceDiff)=>unknown}|undefined;
        if(!port||typeof port.updateData!=='function')throw new Error('Catalog incremental presentation source is missing');port.updateData(diff);
      }
      labelColors(next.world.countryOrder.filter(id=>previous.world.countriesById[id]?.mapColor!==next.world.countriesById[id].mapColor));
    },
    dispose:()=>{if(disposed)return;stopEdges();map.off('click',L.fill,click);map.off('mousemove',L.fill,move);map.off('mouseleave',L.fill,leave);for(const id of Object.values(L).reverse())if(map.getLayer(id))map.removeLayer(id);for(const id of [capitalSource,labelSource,CATALOG_MAP_SOURCE_ID])if(map.getSource(id))map.removeSource(id);disposed=true;},
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
