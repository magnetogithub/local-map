import {createSynchronizedMapSources,reconcileSynchronizedMapSources,type SynchronizedMapSources} from "./map-projection-checkpoint";
import {createTopologyBorderArtifactProjection} from "./topology-border-artifact";
import {canonicalStringify} from "../world/canonical-serializer";
import type {WorldStateV2} from "../world/world-state-v2";

type FeatureCollection = Readonly<{type:"FeatureCollection";features:readonly unknown[]}>;

export type WorldMapRuntimeProjection = Readonly<{
  appliedRevision:number;
  countriesLow:FeatureCollection;
  countriesHigh:FeatureCollection;
  bordersLow:FeatureCollection;
  bordersHigh:FeatureCollection;
  focusByCountryId:Readonly<Record<string,Readonly<{center:readonly [number,number];zoom:number}>>>;
  mapSources:SynchronizedMapSources;
}>;

const collection=(features:readonly unknown[]):FeatureCollection=>({type:"FeatureCollection",features});

export const DEFAULT_NEW_COUNTRY_MAP_COLORS=Object.freeze([
  "#a9c6b5","#c9ae95","#9ebdd0","#c2b1cf","#c8bd83","#9fc7c4",
  "#d2a6a1","#9eafc2","#b8c58b","#b59a76","#8fb5a4","#aaa9c5",
  "#d0aa78","#91a9c7","#b6c99c","#c69aaa","#87b7ba","#c1ad86",
  "#9fa0c3","#a7c68b","#d0a08b","#82aca1","#b8a1c7","#c5b96f",
  "#8fa7b2","#bc9f91","#94bc91","#b29abb","#c3a86f","#82b6aa",
  "#b998a3","#a3b57f",
]);

export function createWorldMapRuntimeProjection(state:WorldStateV2,previous?:WorldMapRuntimeProjection,countryMapColorSeeds:Readonly<Record<string,string>>={}):WorldMapRuntimeProjection {
  const synchronized=previous&&state.revision>previous.appliedRevision
    ?reconcileSynchronizedMapSources(previous.mapSources,state)
    :createSynchronizedMapSources(state);
  const colorByCountryId=new Map<string,string>(state.countryOrder.map(id=>{
    const hash=[...id].reduce((value,character)=>(Math.imul(value,31)+character.charCodeAt(0))>>>0,0);
    return [id,countryMapColorSeeds[id]??DEFAULT_NEW_COUNTRY_MAP_COLORS[hash%DEFAULT_NEW_COUNTRY_MAP_COLORS.length]];
  }));
  const fill=(resolution:"low"|"high")=>{
    const previousFeatures=new Map((previous?.[resolution==="low"?"countriesLow":"countriesHigh"].features??[]).map(item=>{
      const feature=item as {id:string;properties:{mapColor:string;ownerCountryId:string|null};geometry:unknown};
      return [feature.id,feature] as const;
    }));
    return collection(synchronized[resolution].featureCollection.features.map(feature=>{
      const mapColor=colorByCountryId.get(feature.properties.ownerCountryId??"")??"#d6d3c7";
      const old=previousFeatures.get(feature.id);
      if(old&&old.geometry===feature.geometry&&old.properties.ownerCountryId===feature.properties.ownerCountryId&&old.properties.mapColor===mapColor)return old;
      return {...feature,properties:{...feature.properties,mapColor}};
    }));
  };
  const borderProjection=createTopologyBorderArtifactProjection(state.topology,state.revision);
  const previousBorders=new Map((previous?.bordersHigh.features??[]).map(item=>{
    const feature=item as {properties:{countryId:string;topologyEdgeId:string;classification:string;territoryIds:unknown};geometry:{coordinates:unknown}};
    return [`${feature.properties.topologyEdgeId}:${feature.properties.countryId}`,feature] as const;
  }));
  const borders=collection([...borderProjection.borderFeatures,...borderProjection.coastFeatures].filter(feature=>
    feature.properties.artifactKind!=="coast" || !feature.geometry.coordinates.every(([longitude])=>Math.abs(Math.abs(longitude)-180)<1e-6)
  ).flatMap(feature=>{
    const owners=[...new Set(feature.properties.territoryIds.map(id=>id===null?null:state.territoriesById[id]?.ownerCountryId??null))].filter((id):id is NonNullable<typeof id>=>id!==null);
    if(feature.properties.classification==="internal"&&owners.length<=1)return [];
    return owners.map(countryId=>{
      const old=previousBorders.get(`${feature.id}:${countryId}`);
      if(old&&old.properties.classification===feature.properties.classification&&
        canonicalStringify(old.properties.territoryIds)===canonicalStringify(feature.properties.territoryIds)&&
        (old.geometry.coordinates===feature.geometry.coordinates||
        canonicalStringify(old.geometry.coordinates)===canonicalStringify(feature.geometry.coordinates)))return old;
      return {...feature,id:`${feature.id}:${countryId}`,properties:{...feature.properties,countryId,topologyEdgeId:feature.id,projectionRevision:state.revision}};
    });
  }));
  const focusByCountryId:Record<string,{center:readonly [number,number];zoom:number}>={};
  for(const countryId of state.countryOrder){
    const override=state.countriesById[countryId].presentationOverride;
    const positions=state.territoryOrder.filter(id=>state.territoriesById[id].ownerCountryId===countryId).flatMap(id=>{
      const geometry=state.territoriesById[id].geometry;
      const polygons=geometry.type==="Polygon"?[geometry.coordinates]:geometry.coordinates;
      return polygons.flatMap(polygon=>[...polygon[0]]);
    });
    if(!positions.length&&!override?.center)continue;
    const bounds=positions.reduce((result,point)=>({
      west:Math.min(result.west,point[0]),east:Math.max(result.east,point[0]),
      south:Math.min(result.south,point[1]),north:Math.max(result.north,point[1]),
    }),{west:Infinity,east:-Infinity,south:Infinity,north:-Infinity});
    const center=override?.center??([(bounds.west+bounds.east)/2,(bounds.south+bounds.north)/2] as const);
    const span=positions.length?Math.max(bounds.east-bounds.west,bounds.north-bounds.south):10;
    focusByCountryId[countryId]={center,zoom:override?.defaultZoom??Math.max(2,Math.min(7,Math.log2(360/Math.max(span,1))))};
  }
  return Object.freeze({
    appliedRevision:state.revision,
    countriesLow:fill("low"),
    countriesHigh:fill("high"),
    bordersLow:borders,
    bordersHigh:borders,
    focusByCountryId:Object.freeze(focusByCountryId),
    mapSources:synchronized,
  });
}

export function shouldApplyWorldMapRuntimeProjection(currentRevision:number,next:WorldMapRuntimeProjection){
  return next.appliedRevision>currentRevision;
}
