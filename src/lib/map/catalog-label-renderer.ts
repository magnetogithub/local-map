import type {Map as MapLibreMap,GeoJSONSource,ExpressionSpecification} from 'maplibre-gl';
import type {Feature,FeatureCollection,Geometry} from 'geojson';
import type {WorldStateV3} from '../world/world-state-v3';
import {catalogColorFeatureState} from '../projection/catalog-color-projection';
import {POINT_LABEL_MIN_WORLD_UNITS} from './country-label-size';
import {diffMapSourceFeatures,type IdFeatureCollection} from './map-source-incremental-adapter';
export const CATALOG_GLYPH_IDS={fills:'catalog-country-glyph-fills',outlines:'catalog-country-glyph-outlines',fallback:'catalog-small-country-labels',point:'catalog-point-country-labels'} as const;
type Collection=FeatureCollection<Geometry,Record<string,unknown>>;
export async function mountCatalogLabelRenderer(map:MapLibreMap,initial:WorldStateV3,signal:AbortSignal){
  const response=await fetch('/api/world/labels',{signal});if(!response.ok)throw Error('LABEL_SEED_UNAVAILABLE');
  const seed=await response.json() as {placements:Collection;fills:Collection;outlines:Collection};signal.throwIfAborted();
  let world=initial,disposed=false,pending=0,layoutRequests=0,countryLayoutUpdates=0;const failures=new Set<string>();const generations=new Map<string,number>();
  const collections=new Map<string,Collection>();
  const addIds=(features:Feature[],kind:string):Collection=>({type:'FeatureCollection',features:features.map((f,i)=>{const id=`${kind}:${f.properties!.countryId}:${kind==='fallback'?0:f.properties!.glyphIndex??i}`;return {...f,properties:{...f.properties,text:world.countriesById[String(f.properties!.countryId)]?.names.mapKo,labelFeatureId:id},id};})});
  const owned=(w:WorldStateV3,id:string)=>w.territoryOrder.filter(t=>w.territoriesById[t].ownerCountryId===id);
  const geometryKey=(w:WorldStateV3,id:string)=>owned(w,id).join('|');
  const fingerprints=new Map(initial.countryOrder.map(id=>[id,`${initial.countriesById[id].names.mapKo}|${geometryKey(initial,id)}`]));
  const seedFingerprints=new Map(fingerprints);
  const assets={fills:addIds(seed.fills.features,'fill'),outlines:addIds(seed.outlines.features.length?seed.outlines.features:seed.fills.features.map(f=>({...f,properties:{...f.properties,role:'outline'}})),'outline'),fallback:addIds(seed.placements.features.filter(f=>f.properties.placementMode==='small-country-point'),'fallback')};
  const ids=CATALOG_GLYPH_IDS;
  const readable:ExpressionSpecification=['==',['get','readableFallback'],true];
  const pointTextSize=['interpolate',['exponential',2],['zoom'],...Array.from({length:10},(_,zoom)=>[zoom,['case',readable,14,['*',['max',POINT_LABEL_MIN_WORLD_UNITS,['get','fontSizeWorldUnits']],2**zoom]]]).flat()] as never;
  for(const kind of ['fills','outlines','fallback'] as const){collections.set(ids[kind],assets[kind]);map.addSource(ids[kind],{type:'geojson',data:assets[kind],promoteId:'labelFeatureId'});}
  map.addLayer({id:ids.outlines,type:'line',source:ids.outlines,minzoom:1,paint:{'line-color':['coalesce',['feature-state','labelHaloColor'],'#53615F'],'line-width':1.5}});
  map.addLayer({id:ids.fills,type:'fill',source:ids.fills,minzoom:1,paint:{'fill-color':['coalesce',['feature-state','labelColor'],'#FFFFFF'],'fill-opacity':1}});
  map.addLayer({id:ids.fallback,type:'symbol',source:ids.fallback,layout:{'text-field':['case',readable,['get','fallbackText'],['get','mapLabelKo']],'text-font':['Open Sans Regular'],'text-size':pointTextSize,'text-max-width':['case',readable,18,10],'text-rotate':['get','angle'],'text-rotation-alignment':'map','text-letter-spacing':['get','letterSpacing'],'text-allow-overlap':true,'text-keep-upright':true},paint:{'text-color':['coalesce',['feature-state','labelColor'],'#FFFFFF'],'text-halo-color':['coalesce',['feature-state','labelHaloColor'],'#53615F'],'text-halo-width':1.5}});
  const fallback=map.getLayer(ids.fallback)!.serialize();map.addLayer({...fallback,id:ids.point,layout:{...fallback.layout,'text-allow-overlap':false}} as Parameters<MapLibreMap['addLayer']>[0]);
  map.setLayoutProperty('catalog-country-labels','visibility','none');
  const filter=()=>{for(const id of Object.values(ids))map.setFilter(id,id===ids.fallback||id===ids.point?['all',['<=',['get','minZoom'],map.getZoom()],['==',['get','overlapAtClose'],id===ids.fallback]]:['all',['<=',['get','minZoom'],map.getZoom()],['!=',['get','readableFallback'],true]]);};filter();map.on('zoom',filter);
  for(const id of [ids.outlines,ids.fills,ids.fallback,ids.point])map.moveLayer(id,'catalog-capitals');
  const colors=(countryIds:readonly string[])=>{const selected=new Set(countryIds);for(const [source,collection] of collections)for(const f of collection.features){const id=String(f.properties.countryId),c=world.countriesById[id];if(c&&selected.has(id))map.setFeatureState({source,id:String(f.id)},c.mapColor===initial.countriesById[id]?.mapColor?{labelColor:'#FFFFFF',labelHaloColor:'#53615F'}:catalogColorFeatureState(c.mapColor));}};colors(world.countryOrder);
  const replace=(countryId:string,replacement:{placement:Feature;fills:Collection;outlines:Collection}|null)=>{
    for(const kind of ['fills','outlines','fallback'] as const){const source=ids[kind],before=collections.get(source)!;
      const features=replacement?(kind==='fallback'?(replacement.placement.properties?.placementMode==='small-country-point'?[replacement.placement]:[]):replacement[kind].features):[];
      const next:Collection={type:'FeatureCollection',features:[...before.features.filter(f=>f.properties.countryId!==countryId),...addIds(features,kind==='fills'?'fill':kind==='outlines'?'outline':'fallback').features]};
      const {diff,changedIds}=diffMapSourceFeatures(before as unknown as IdFeatureCollection,next as unknown as IdFeatureCollection,source);if(changedIds.length)(map.getSource(source) as GeoJSONSource).updateData(diff);collections.set(source,next);
    }colors([countryId]);
  };
  return {ready:()=>pending===0&&failures.size===0,stats:()=>({labelLayoutRequests:layoutRequests,labelCountryUpdates:countryLayoutUpdates,labelFailures:[...failures]}),collections:()=>collections,
    visibility:(visible:boolean)=>{for(const id of Object.values(ids))map.setLayoutProperty(id,'visibility',visible?'visible':'none');map.setLayoutProperty('catalog-country-labels','visibility','none');},
    updateWorld:(next:WorldStateV3)=>{
      const previous=world;world=next;
      const changedColors=next.countryOrder.filter(id=>previous.countriesById[id]?.mapColor!==next.countriesById[id].mapColor);colors(changedColors);
      const affected=new Set(next.countryOrder.filter(id=>previous.countriesById[id]?.names.mapKo!==next.countriesById[id].names.mapKo));
      for(const id of previous.countryOrder)if(!next.countriesById[id])affected.add(id);
      if(previous.territoriesById!==next.territoriesById)for(const id of next.territoryOrder){const a=previous.territoriesById[id],b=next.territoriesById[id];if(a.ownerCountryId!==b.ownerCountryId){if(a.ownerCountryId)affected.add(a.ownerCountryId);if(b.ownerCountryId)affected.add(b.ownerCountryId);}}
      for(const id of affected){
        const c=next.countriesById[id],fingerprint=c?`${c.names.mapKo}|${geometryKey(next,id)}`:null;
        if(fingerprint===fingerprints.get(id))continue;
        const generation=(generations.get(id)??0)+1;generations.set(id,generation);
        if(!c){fingerprints.delete(id);replace(id,null);continue;}fingerprints.set(id,fingerprint!);
        if(fingerprint===seedFingerprints.get(id)){replace(id,{placement:seed.placements.features.find(f=>f.properties.countryId===id)!,fills:{type:'FeatureCollection',features:seed.fills.features.filter(f=>f.properties.countryId===id)},outlines:{type:'FeatureCollection',features:(seed.outlines.features.length?seed.outlines.features:seed.fills.features.map(f=>({...f,properties:{...f.properties,role:'outline'}}))).filter(f=>f.properties.countryId===id)}});failures.delete(id);countryLayoutUpdates++;continue;}
        const territoryIds=owned(next,id);if(!territoryIds.length){replace(id,null);continue;}
        layoutRequests++;pending++;
        void fetch('/api/world/labels',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({catalogRef:next.catalogRef,countryId:id,text:c.names.mapKo,territoryIds}),signal}).then(async r=>{if(!r.ok)throw Error('LABEL_LAYOUT_FAILED');return r.json();}).then(result=>{if(!disposed&&generations.get(id)===generation){replace(id,result);failures.delete(id);countryLayoutUpdates++;}}).catch(error=>{if(!signal.aborted&&generations.get(id)===generation){failures.add(id);console.error('Catalog affected label failed',error);}}).finally(()=>pending--);
      }
    },dispose:()=>{disposed=true;map.off('zoom',filter);for(const id of Object.values(ids).reverse()){if(map.getLayer(id))map.removeLayer(id);if(map.getSource(id))map.removeSource(id);}}};
}
