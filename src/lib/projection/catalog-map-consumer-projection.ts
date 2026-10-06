import {createWorldGeometryCatalogContract,assertWorldGeometryCatalogRefMatches} from '../world/world-geometry-catalog-ref';
import {createWorldStateV3,isValidatedWorldStateV3,type WorldStateV3} from '../world/world-state-v3';
import type {TerritoryId} from '../world/territory-id';
import type {ActiveCountryId} from '../world/country-id';
import type {CatalogConsumerMetadata,CatalogTerritoryMetadata} from '../map/catalog-consumer-contract';
import {type RenderFeatureRef} from '../map/render-feature-ref';
import {createCountrySearchProjection} from './country-search-index-patch';
import {createCountryPanelProjection,getCountryPanelView,type CountryPanelPresentationEntry} from './country-panel-projection';
import type {CountryCapitalFeature,CountryCapitalProjection} from './country-capital-projection';
import {deserializeLabelProjection,labelTextHash,type LabelJob} from './label-projection-checkpoint';
import {canonicalSerialize,canonicalStringify} from '../world/canonical-serializer';
import {sha256Hex} from '../world/sha256';
export const CATALOG_MAP_SOURCE_ID='world-territory-catalog';
const contracts=new WeakMap<CatalogConsumerMetadata,ReturnType<typeof createWorldGeometryCatalogContract>>();
export function catalogContractForConsumer(metadata:CatalogConsumerMetadata){let contract=contracts.get(metadata);if(!contract){contract=createWorldGeometryCatalogContract({ref:metadata.catalogRef,
  territoryOrder:metadata.territories.map(t=>t.id),territoriesById:Object.fromEntries(metadata.territories.map(t=>[t.id,{id:t.id,sourceCountryId:t.sourceCountryId}]))});contracts.set(metadata,contract);}return contract;}
export function catalogTerritoryRenderRef(id:TerritoryId):RenderFeatureRef{return {sourceType:'vector',sourceId:CATALOG_MAP_SOURCE_ID,sourceLayer:'territories',featureId:id};}
export function createCatalogMapConsumerProjection(input:WorldStateV3,metadata:CatalogConsumerMetadata,scope?:{countryIds:readonly string[];territoryIds:readonly TerritoryId[]}){
  assertWorldGeometryCatalogRefMatches(input.catalogRef,metadata.catalogRef);
  const contract=catalogContractForConsumer(metadata),world=isValidatedWorldStateV3(input,contract)?input:createWorldStateV3(input,contract),territoryById=new Map(metadata.territories.map(t=>[t.id,t]));
  const countryOrder=scope?world.countryOrder.filter(id=>scope.countryIds.includes(id)):world.countryOrder,territoryOrder=scope?.territoryIds??world.territoryOrder;
  const presentedByCountry:Record<string,TerritoryId[]>={},ownedByCountry:Record<string,TerritoryId[]>={},controlledByCountry:Record<string,TerritoryId[]>={};
  for(const id of countryOrder){presentedByCountry[id]=[];ownedByCountry[id]=[];controlledByCountry[id]=[];}
  const featuresById:Record<string,{ref:RenderFeatureRef;ownerCountryId:string|null;controllerCountryId:string|null;countryId:string|null;mapColor:string;occupied:boolean}>={};
  for(const id of territoryOrder){const t=world.territoriesById[id],countryId=t.ownerCountryId??t.controllerCountryId;
    if(t.ownerCountryId)ownedByCountry[t.ownerCountryId]?.push(id);if(t.controllerCountryId)controlledByCountry[t.controllerCountryId]?.push(id);if(countryId)presentedByCountry[countryId]?.push(id);
    featuresById[id]={ref:catalogTerritoryRenderRef(id),ownerCountryId:t.ownerCountryId,controllerCountryId:t.controllerCountryId,countryId,
      mapColor:(t.controllerCountryId??t.ownerCountryId)?world.countriesById[(t.controllerCountryId??t.ownerCountryId)!].mapColor:'#D6D3C7',occupied:t.controllerCountryId!==null&&t.controllerCountryId!==t.ownerCountryId};
  }
  const sourceCountries=new Map(metadata.countries.map(c=>[c.countryId,c])),focusByCountryId:Record<string,{center:readonly[number,number];zoom:number}>={},jobs:LabelJob[]=[];
  for(const countryId of countryOrder){const ids=presentedByCountry[countryId],country=world.countriesById[countryId],seed=sourceCountries.get(countryId),override=country.presentationOverride;
    const largest=ids.map(id=>territoryById.get(id)!).sort((a,b)=>b.area-a.area||(a.id<b.id?-1:1))[0];if(!largest)continue;
    const anchor=override?.labelAnchor??(seed&&ids.includes(seed.label.territoryId)?seed.label.anchor:largest.anchor);
    const bounds=ids.reduce((box,id)=>{const b=territoryById.get(id)!.bbox;return [Math.min(box[0],b[0]),Math.min(box[1],b[1]),Math.max(box[2],b[2]),Math.max(box[3],b[3])];},[Infinity,Infinity,-Infinity,-Infinity]);
    const span=Math.max(bounds[2]-bounds[0],bounds[3]-bounds[1]);focusByCountryId[countryId]={center:override?.center??anchor,zoom:override?.defaultZoom??Math.max(1,Math.min(7,Math.log2(360/Math.max(1,span))))};
    const labelTerritoryId=seed&&ids.includes(seed.label.territoryId)?seed.label.territoryId:largest.id;
    jobs.push({jobId:`catalog-label:${countryId}`,revision:world.revision,countryId,territoryId:labelTerritoryId,text:country.names.mapKo,anchor,priority:-largest.area,
      hashes:{territoryGeometryHash:sha256Hex(canonicalSerialize({geometryRoot:metadata.catalogRef.geometryRoot,territoryIds:ids,anchor})),textHash:labelTextHash(country.names.mapKo),fontHash:'font:runtime-default',policyHash:'catalog-country-label-v1'}});
  }
  const capitalFeatures:CountryCapitalFeature[]=[],presentation:Record<string,CountryPanelPresentationEntry>={};
  for(const c of metadata.countries){if(!countryOrder.includes(c.countryId as ActiveCountryId))continue;presentation[c.countryId]={countryId:c.countryId as ActiveCountryId,iso3:c.iso3,flagCode:c.flagCode,region:c.region};
    const p=c.capital;if(p&&world.countriesById[c.countryId]&&world.territoriesById[p.territoryId]?.ownerCountryId===c.countryId)capitalFeatures.push({type:'Feature',id:c.countryId as ActiveCountryId,
      properties:{countryId:c.countryId as ActiveCountryId,territoryId:p.territoryId,nameKo:p.nameKo,nameEn:p.nameEn,capitalType:p.capitalType,labelRank:p.labelRank},geometry:{type:'Point',coordinates:p.coordinates}});
  }
  const capitals:CountryCapitalProjection={revision:world.revision,appliedRevision:world.revision,features:capitalFeatures,featuresByCountryId:new Map(capitalFeatures.map(f=>[f.id,f])),omittedCountryIds:countryOrder.filter(id=>!capitalFeatures.some(f=>f.id===id))};
  const selectedWorld={...world,countryOrder,countriesById:Object.fromEntries(countryOrder.map(id=>[id,world.countriesById[id]]))};
  const panel=createCountryPanelProjection(selectedWorld,capitals,presentation),search=createCountrySearchProjection(selectedWorld),labels=deserializeLabelProjection({revision:world.revision,jobs});
  return Object.freeze({catalogRef:metadata.catalogRef,appliedRevision:world.revision,world,metadata,featuresById,territoryById:territoryById as ReadonlyMap<TerritoryId,CatalogTerritoryMetadata>,presentedByCountry,ownedByCountry,controlledByCountry,focusByCountryId,labels,capitals,panel,search,projectionStats:{fullBuilds:scope?0:1,countryRebuilds:countryOrder.length,territoryRebuilds:territoryOrder.length}});
}
export type CatalogMapConsumerProjection=ReturnType<typeof createCatalogMapConsumerProjection>;
/** Rebuild presentation only for changed legal owners/names. Controller changes have no label/capital work. */
export function updateCatalogMapConsumerProjection(previous:CatalogMapConsumerProjection,input:WorldStateV3){
  assertWorldGeometryCatalogRefMatches(previous.catalogRef,input.catalogRef);
  const contract=catalogContractForConsumer(previous.metadata),world=isValidatedWorldStateV3(input,contract)?input:createWorldStateV3(input,contract);
  const countries=new Set([...previous.world.countryOrder,...world.countryOrder].filter(id=>{const a=previous.world.countriesById[id],b=world.countriesById[id];return a!==b&&(!a||!b||canonicalStringify(a)!==canonicalStringify(b));}));
  const changedIds=world.territoryOrder.filter(id=>{const a=previous.world.territoriesById[id],b=world.territoriesById[id];return a.ownerCountryId!==b.ownerCountryId||a.controllerCountryId!==b.controllerCountryId;});
  const affected=new Set<TerritoryId>(changedIds),presentationCountries=new Set(countries);
  const groups={presentedByCountry:{...previous.presentedByCountry},ownedByCountry:{...previous.ownedByCountry},controlledByCountry:{...previous.controlledByCountry}};
  for(const country of countries)for(const id of [...previous.ownedByCountry[country]??[],...previous.controlledByCountry[country]??[]])affected.add(id);
  const bucket=(group:Record<string,TerritoryId[]>,id:TerritoryId,a:string|null,b:string|null)=>{
    if(a===b)return;if(a)group[a]=(group[a]??[]).filter(t=>t!==id);if(b)group[b]=[...(group[b]??[]),id].sort();
  };
  for(const id of changedIds){const a=previous.world.territoriesById[id],b=world.territoriesById[id];
    bucket(groups.ownedByCountry,id,a.ownerCountryId,b.ownerCountryId);bucket(groups.controlledByCountry,id,a.controllerCountryId,b.controllerCountryId);
    const old=a.ownerCountryId??a.controllerCountryId,next=b.ownerCountryId??b.controllerCountryId;bucket(groups.presentedByCountry,id,old,next);
    if(old!==next){if(old)presentationCountries.add(old);if(next)presentationCountries.add(next);}
    if(a.ownerCountryId!==b.ownerCountryId){if(a.ownerCountryId)presentationCountries.add(a.ownerCountryId);if(b.ownerCountryId)presentationCountries.add(b.ownerCountryId);}
  }
  for(const country of countries)for(const group of Object.values(groups)){if(!world.countriesById[country])delete group[country];else group[country]??=[];}
  const featuresById={...previous.featuresById},changedFeatureIds:TerritoryId[]=[];
  for(const id of [...affected].sort()){const t=world.territoriesById[id],a=featuresById[id],presented=t.controllerCountryId??t.ownerCountryId;
    const b={...a,ownerCountryId:t.ownerCountryId,controllerCountryId:t.controllerCountryId,countryId:t.ownerCountryId??t.controllerCountryId,mapColor:presented?world.countriesById[presented].mapColor:'#D6D3C7',occupied:t.controllerCountryId!==null&&t.controllerCountryId!==t.ownerCountryId};
    if(a.ownerCountryId!==b.ownerCountryId||a.controllerCountryId!==b.controllerCountryId||a.mapColor!==b.mapColor){featuresById[id]=b;changedFeatureIds.push(id);}
  }
  const scope=[...presentationCountries].sort(),scopeIds=[...new Set(scope.flatMap(id=>groups.presentedByCountry[id]??[]))].sort();
  const partial=createCatalogMapConsumerProjection(world,previous.metadata,{countryIds:scope,territoryIds:scopeIds});
  const mergeMap=<K,V>(old:ReadonlyMap<K,V>,next:ReadonlyMap<K,V>,key:(id:string)=>K)=>{const merged=new Map(old);for(const id of scope)merged.delete(key(id));for(const [id,v]of next)merged.set(id,v);return merged;};
  const pointFallbacksByLabelId=mergeMap(previous.labels.pointFallbacksByLabelId,partial.labels.pointFallbacksByLabelId,id=>`catalog-label:${id}`);
  const jobs=[...previous.labels.jobs.filter(j=>!presentationCountries.has(j.countryId)),...partial.labels.jobs].sort((a,b)=>a.countryId<b.countryId?-1:1);
  const labels={...previous.labels,revision:world.revision,appliedRevision:world.revision,pointFallbacksByLabelId,jobs};
  const capitalMap=mergeMap(previous.capitals.featuresByCountryId,partial.capitals.featuresByCountryId,id=>id as ActiveCountryId);
  const capitals={...previous.capitals,revision:world.revision,appliedRevision:world.revision,featuresByCountryId:capitalMap,features:[...capitalMap.values()].sort((a,b)=>a.id<b.id?-1:1),omittedCountryIds:world.countryOrder.filter(id=>!capitalMap.has(id))};
  const panel={...previous.panel,revision:world.revision,appliedRevision:world.revision,coreById:mergeMap(previous.panel.coreById,partial.panel.coreById,id=>id as ActiveCountryId),inputById:mergeMap(previous.panel.inputById,partial.panel.inputById,id=>id as ActiveCountryId),playableById:mergeMap(previous.panel.playableById,partial.panel.playableById,id=>id as ActiveCountryId)};
  const search={...previous.search,revision:world.revision,entriesById:mergeMap(previous.search.entriesById,partial.search.entriesById,id=>id as ActiveCountryId)};
  const focusByCountryId={...previous.focusByCountryId};for(const id of scope)delete focusByCountryId[id];Object.assign(focusByCountryId,partial.focusByCountryId);
  return Object.freeze({projection:Object.freeze({...previous,world,appliedRevision:world.revision,featuresById,...groups,labels,capitals,panel,search,focusByCountryId,projectionStats:{fullBuilds:previous.projectionStats.fullBuilds,countryRebuilds:previous.projectionStats.countryRebuilds+scope.length,territoryRebuilds:previous.projectionStats.territoryRebuilds+affected.size}}),changedFeatureIds,changedCountryIds:[...countries].sort()});
}
export function catalogCountryPanelView(projection:CatalogMapConsumerProjection,id:string|null){const view=getCountryPanelView(projection.panel,id);return view?Object.freeze({...view,catalogRef:projection.catalogRef,ownedTerritoryCount:projection.ownedByCountry[view.countryId].length,controlledTerritoryCount:projection.controlledByCountry[view.countryId].length}):null;}
export function catalogHitTerritory(projection:CatalogMapConsumerProjection,feature:{id?:string|number;source?:string;sourceLayer?:string;properties?:Record<string,unknown>}){
  if(feature.source!==CATALOG_MAP_SOURCE_ID||feature.sourceLayer!=='territories'||typeof feature.id!=='string'||feature.properties?.territoryId!==feature.id)return null;
  const state=projection.featuresById[feature.id];return state?{territoryId:feature.id as TerritoryId,countryId:state.countryId,ownerCountryId:state.ownerCountryId,controllerCountryId:state.controllerCountryId}:null;
}
