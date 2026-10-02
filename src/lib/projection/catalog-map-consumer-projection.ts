import {createWorldGeometryCatalogContract,assertWorldGeometryCatalogRefMatches} from '../world/world-geometry-catalog-ref';
import {createWorldStateV3,type WorldStateV3} from '../world/world-state-v3';
import type {TerritoryId} from '../world/territory-id';
import type {ActiveCountryId} from '../world/country-id';
import type {CatalogConsumerMetadata,CatalogTerritoryMetadata} from '../map/catalog-consumer-contract';
import {type RenderFeatureRef} from '../map/render-feature-ref';
import {createCountrySearchProjection} from './country-search-index-patch';
import {createCountryPanelProjection,getCountryPanelView,type CountryPanelPresentationEntry} from './country-panel-projection';
import type {CountryCapitalFeature,CountryCapitalProjection} from './country-capital-projection';
import {deserializeLabelProjection,labelTextHash,type LabelJob} from './label-projection-checkpoint';
import {canonicalSerialize} from '../world/canonical-serializer';
import {sha256Hex} from '../world/sha256';
export const CATALOG_MAP_SOURCE_ID='world-territory-catalog';
export function catalogContractForConsumer(metadata:CatalogConsumerMetadata){return createWorldGeometryCatalogContract({ref:metadata.catalogRef,
  territoryOrder:metadata.territories.map(t=>t.id),territoriesById:Object.fromEntries(metadata.territories.map(t=>[t.id,{id:t.id,sourceCountryId:t.sourceCountryId}]))});}
export function catalogTerritoryRenderRef(id:TerritoryId):RenderFeatureRef{return {sourceType:'vector',sourceId:CATALOG_MAP_SOURCE_ID,sourceLayer:'territories',featureId:id};}
export function createCatalogMapConsumerProjection(input:WorldStateV3,metadata:CatalogConsumerMetadata){
  assertWorldGeometryCatalogRefMatches(input.catalogRef,metadata.catalogRef);
  const world=createWorldStateV3(input,catalogContractForConsumer(metadata)),territoryById=new Map(metadata.territories.map(t=>[t.id,t]));
  const presentedByCountry:Record<string,TerritoryId[]>={},ownedByCountry:Record<string,TerritoryId[]>={},controlledByCountry:Record<string,TerritoryId[]>={};
  for(const id of world.countryOrder){presentedByCountry[id]=[];ownedByCountry[id]=[];controlledByCountry[id]=[];}
  const featuresById:Record<string,{ref:RenderFeatureRef;ownerCountryId:string|null;controllerCountryId:string|null;countryId:string|null;mapColor:string;occupied:boolean}>={};
  for(const id of world.territoryOrder){const t=world.territoriesById[id],countryId=t.ownerCountryId??t.controllerCountryId;
    if(t.ownerCountryId)ownedByCountry[t.ownerCountryId].push(id);if(t.controllerCountryId)controlledByCountry[t.controllerCountryId].push(id);if(countryId)presentedByCountry[countryId].push(id);
    featuresById[id]={ref:catalogTerritoryRenderRef(id),ownerCountryId:t.ownerCountryId,controllerCountryId:t.controllerCountryId,countryId,
      mapColor:t.ownerCountryId?world.countriesById[t.ownerCountryId].mapColor:'#D6D3C7',occupied:t.controllerCountryId!==null&&t.controllerCountryId!==t.ownerCountryId};
  }
  const sourceCountries=new Map(metadata.countries.map(c=>[c.countryId,c])),focusByCountryId:Record<string,{center:readonly[number,number];zoom:number}>={},jobs:LabelJob[]=[];
  for(const countryId of world.countryOrder){const ids=presentedByCountry[countryId],country=world.countriesById[countryId],seed=sourceCountries.get(countryId),override=country.presentationOverride;
    const largest=ids.map(id=>territoryById.get(id)!).sort((a,b)=>b.area-a.area||(a.id<b.id?-1:1))[0];if(!largest)continue;
    const anchor=override?.labelAnchor??(seed&&ids.includes(seed.label.territoryId)?seed.label.anchor:largest.anchor);
    const bounds=ids.reduce((box,id)=>{const b=territoryById.get(id)!.bbox;return [Math.min(box[0],b[0]),Math.min(box[1],b[1]),Math.max(box[2],b[2]),Math.max(box[3],b[3])];},[Infinity,Infinity,-Infinity,-Infinity]);
    const span=Math.max(bounds[2]-bounds[0],bounds[3]-bounds[1]);focusByCountryId[countryId]={center:override?.center??anchor,zoom:override?.defaultZoom??Math.max(1,Math.min(7,Math.log2(360/Math.max(1,span))))};
    const labelTerritoryId=seed&&ids.includes(seed.label.territoryId)?seed.label.territoryId:largest.id;
    jobs.push({jobId:`catalog-label:${countryId}`,revision:world.revision,countryId,territoryId:labelTerritoryId,text:country.names.mapKo,anchor,priority:-largest.area,
      hashes:{territoryGeometryHash:sha256Hex(canonicalSerialize({geometryRoot:metadata.catalogRef.geometryRoot,territoryIds:ids,anchor})),textHash:labelTextHash(country.names.mapKo),fontHash:'font:runtime-default',policyHash:'catalog-country-label-v1'}});
  }
  const capitalFeatures:CountryCapitalFeature[]=[],presentation:Record<string,CountryPanelPresentationEntry>={};
  for(const c of metadata.countries){presentation[c.countryId]={countryId:c.countryId as ActiveCountryId,iso3:c.iso3,flagCode:c.flagCode,region:c.region};
    const p=c.capital;if(p&&world.countriesById[c.countryId]&&world.territoriesById[p.territoryId]?.ownerCountryId===c.countryId)capitalFeatures.push({type:'Feature',id:c.countryId as ActiveCountryId,
      properties:{countryId:c.countryId as ActiveCountryId,territoryId:p.territoryId,nameKo:p.nameKo,nameEn:p.nameEn,capitalType:p.capitalType,labelRank:p.labelRank},geometry:{type:'Point',coordinates:p.coordinates}});
  }
  const capitals:CountryCapitalProjection={revision:world.revision,appliedRevision:world.revision,features:capitalFeatures,featuresByCountryId:new Map(capitalFeatures.map(f=>[f.id,f])),omittedCountryIds:world.countryOrder.filter(id=>!capitalFeatures.some(f=>f.id===id))};
  const panel=createCountryPanelProjection(world,capitals,presentation),search=createCountrySearchProjection(world),labels=deserializeLabelProjection({revision:world.revision,jobs});
  return Object.freeze({catalogRef:metadata.catalogRef,appliedRevision:world.revision,world,metadata,featuresById,territoryById:territoryById as ReadonlyMap<TerritoryId,CatalogTerritoryMetadata>,presentedByCountry,ownedByCountry,controlledByCountry,focusByCountryId,labels,capitals,panel,search});
}
export type CatalogMapConsumerProjection=ReturnType<typeof createCatalogMapConsumerProjection>;
export function catalogCountryPanelView(projection:CatalogMapConsumerProjection,id:string|null){const view=getCountryPanelView(projection.panel,id);return view?Object.freeze({...view,catalogRef:projection.catalogRef,ownedTerritoryCount:projection.ownedByCountry[view.countryId].length,controlledTerritoryCount:projection.controlledByCountry[view.countryId].length}):null;}
export function catalogHitTerritory(projection:CatalogMapConsumerProjection,feature:{id?:string|number;source?:string;sourceLayer?:string;properties?:Record<string,unknown>}){
  if(feature.source!==CATALOG_MAP_SOURCE_ID||feature.sourceLayer!=='territories'||typeof feature.id!=='string'||feature.properties?.territoryId!==feature.id)return null;
  const state=projection.featuresById[feature.id];return state?{territoryId:feature.id as TerritoryId,countryId:state.countryId,ownerCountryId:state.ownerCountryId,controllerCountryId:state.controllerCountryId}:null;
}
