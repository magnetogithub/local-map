import {describe,expect,it} from "vitest";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import {performance} from "node:perf_hooks";
import metadata from "../../src/data/countries-2020.json";
import type {Country} from "../../src/types/country";
import {
  applyCountryReplacement,
  createWorldState,
  replaceCountryNames,
  rollbackCountryReplacement,
  type CapitalFeature,
  type CountryEntity,
  type CountryGeometryFeature,
  type WorldState,
} from "../../src/lib/test-only/legacy-v1/world-state";
import {updateCountryMapSources,type CountryMapArtifactCollections} from "../../src/lib/test-only/legacy-v1/country-map-artifacts";

const read=<T,>(file:string)=>JSON.parse(fs.readFileSync(path.join(process.cwd(),file),"utf8")) as T;
const geometry=read<{features:CountryGeometryFeature[]}>("public/data/maps/countries-10m.geojson");
const capitals=read<{features:CapitalFeature[]}>("public/data/maps/capitals-2020.geojson");
type ProvinceFixture={features:Array<{properties:{countryId:string;iso3:string;nameKo:string;nameEn:string;mapLabelKo:string;mapColor:string;center:[number,number]};geometry:CountryEntity["geometry"]}>};
const provinceFixture=read<ProvinceFixture>("public/data/maps/china-province-countries-test.geojson");
const seed=createWorldState(metadata as Country[],geometry.features,capitals.features);
const provinceCountries:CountryEntity[]=provinceFixture.features.map(({properties,geometry:countryGeometry})=>({
  id:properties.countryId,iso3:properties.iso3,
  names:{shortKo:properties.nameKo,officialKo:properties.nameKo,mapKo:properties.mapLabelKo,english:properties.nameEn,searchAliases:[properties.countryId,properties.nameKo,properties.nameEn]},
  geometry:countryGeometry,mapColor:properties.mapColor,playable:true,unitType:"sovereign-country",capital:null,
  presentation:{flagCode:"CN",region:"Eastern Asia",center:properties.center,defaultZoom:5,labelRank:4},
}));
const synthetic:CountryEntity={id:"SYN-9-2",iso3:"SYN",names:{shortKo:"새나라",officialKo:"새나라",mapKo:"새나라",english:"Synthetic",searchAliases:["SYN-9-2","Synthetic"]},geometry:{type:"Polygon",coordinates:[[[0,0],[1,0],[1,1],[0,1],[0,0]]]},mapColor:"#ffffff",playable:false,unitType:"sovereign-country",capital:null,presentation:{flagCode:"",region:"Synthetic",center:[.5,.5],defaultZoom:4,labelRank:4}};
const hash=(value:unknown)=>crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
const retained=(before:WorldState,after:WorldState)=>Object.keys(before.countriesById).filter(id=>after.countriesById[id]===before.countriesById[id]).length;
const p=(values:number[],q:number)=>values.slice().sort((a,b)=>a-b)[Math.ceil(values.length*q)-1];
const run=(operation:()=>WorldState)=>{
  for(let i=0;i<5;i++)operation();
  const times:number[]=[],hashes:string[]=[],retainedEntities:number[]=[];
  for(let i=0;i<20;i++){const start=performance.now(),result=operation();times.push(performance.now()-start);hashes.push(hash(result));retainedEntities.push(retained(seed,result))}
  return {runs:20,p50Ms:p(times,.5),p95Ms:p(times,.95),minMs:Math.min(...times),maxMs:Math.max(...times),uniqueOutputHashes:new Set(hashes).size,outputHash:hashes[0],retainedEntitiesMin:Math.min(...retainedEntities),retainedEntitiesMax:Math.max(...retainedEntities)};
};

describe("9-2 current dynamic baseline",()=>{
  it("measures deterministic state transitions and exact rollback",()=>{
    const rename=run(()=>replaceCountryNames(seed,"AUS",{...seed.countriesById.AUS.names,mapKo:"호주연방"}));
    const create=run(()=>applyCountryReplacement(seed,{removeCountryIds:[],upsertCountries:[synthetic]}).state);
    const remove=run(()=>applyCountryReplacement(seed,{removeCountryIds:["AUS"],upsertCountries:[]}).state);
    const split=run(()=>applyCountryReplacement(seed,{removeCountryIds:["CHN"],upsertCountries:provinceCountries}).state);
    const rollback=run(()=>{const applied=applyCountryReplacement(seed,{removeCountryIds:["CHN"],upsertCountries:provinceCountries});return rollbackCountryReplacement(applied.state,applied.rollback)});
    const empty={type:"FeatureCollection" as const,features:[]};
    const collections={countries:empty,borders:empty,curvedLabels:empty,pointLabels:empty,capitals:empty,glyphLabelFills:empty,glyphLabelOutlines:empty} as unknown as CountryMapArtifactCollections;
    let setDataCalls=0;const source={setData:()=>{setDataCalls++}};
    updateCountryMapSources({countries:source,borders:source,curvedLabels:source,pointLabels:source,capitals:source,glyphLabelFills:source,glyphLabelOutlines:source},collections);
    const result={seedCountryCount:Object.keys(seed.countriesById).length,seedHash:hash(seed),rename,create,delete:remove,split31:split,rollback,rollbackHashMatchesSeed:rollback.outputHash===hash(seed),artifactAdapterSetDataCalls:setDataCalls,pureWorldStateTransitionSetDataCalls:0,worldMapDebugSplitSetDataCallsByInspection:8,worldMapDebugRollbackSetDataCallsByInspection:8};
    console.log("PROMPT_09_2_BENCHMARK",JSON.stringify(result));
    expect([rename,create,remove,split,rollback].every(value=>value.uniqueOutputHashes===1)).toBe(true);
    expect(result.rollbackHashMatchesSeed).toBe(true);
    expect(setDataCalls).toBe(7);
    expect(split.retainedEntitiesMin).toBe(Object.keys(seed.countriesById).length-1);
  },120_000);
});
