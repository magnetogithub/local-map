import {describe,expect,it} from "vitest";
import type {GeoJSONSourceDiff} from "maplibre-gl";
import {createCommandUiDemoWorldState} from "../planning/command-ui-runtime";
import {createWorldStateV2} from "../world/world-state-v2";
import {createTerritoryEntity} from "../world/territory-entity";
import {deriveTerritoryId} from "../world/territory-id";
import {deriveCanonicalTopologyEdgeId} from "../world/canonical-topology";
import {createTopologyState,type TopologyEdge} from "../world/topology-state";
import {createWorldMapRuntimeProjection,type WorldMapRuntimeProjection} from "../projection/world-map-runtime-projection";
import {MAP_SOURCE_IDS as S} from "./map-config";
import {
  assertUniqueMapSourceIds,diffMapSourceFeatures,MapSourceIncrementalController,
  type IdFeature,type IdFeatureCollection,type IncrementalGeoJSONSource,type RuntimeMapSourceId,
} from "./map-source-incremental-adapter";

const base=createCommandUiDemoWorldState();
const firstId=base.territoryOrder.find(id=>base.territoriesById[id].ownerCountryId==="AAA")!;
const secondId=base.territoryOrder.find(id=>base.territoriesById[id].ownerCountryId==="BBB")!;
const initial=createWorldMapRuntimeProjection(base);
const collection=(features:readonly IdFeature[]):IdFeatureCollection=>({type:"FeatureCollection",features:[...features]});
const fill=(projection:WorldMapRuntimeProjection)=>projection.countriesLow as IdFeatureCollection;
const border=(projection:WorldMapRuntimeProjection)=>projection.bordersLow as IdFeatureCollection;
const nextWorld=(territoriesById:typeof base.territoriesById,territoryOrder:readonly typeof firstId[])=>
  createWorldStateV2({...base,revision:base.revision+1,territoriesById,territoryOrder});

class MockSource implements IncrementalGeoJSONSource {
  setCalls:IdFeatureCollection[]=[];
  updateCalls:GeoJSONSourceDiff[]=[];
  data:IdFeatureCollection=collection([]);
  failNextUpdate=false;
  nextGetData:Promise<IdFeatureCollection>|null=null;
  setData(data:IdFeatureCollection){this.setCalls.push(data);this.data=collection(data.features)}
  updateData(diff:GeoJSONSourceDiff){
    if(this.failNextUpdate){this.failNextUpdate=false;throw new Error("injected update failure")}
    this.updateCalls.push(diff);
    const features=new Map(this.data.features.map(feature=>[feature.id,feature]));
    for(const id of diff.remove??[])features.delete(String(id));
    for(const feature of diff.add??[])features.set(String(feature.id),feature as IdFeature);
    for(const update of diff.update??[]){
      const previous=features.get(String(update.id));
      if(!previous)continue;
      const properties=update.removeAllProperties?{}:{...previous.properties};
      for(const {key,value} of update.addOrUpdateProperties??[])properties[key]=value;
      features.set(String(update.id),{...previous,geometry:update.newGeometry??previous.geometry,properties});
    }
    this.data=collection([...features.values()]);
  }
  async getData(){const pending=this.nextGetData;this.nextGetData=null;return pending??this.data}
}

const withCountryName=(revision:number,displayName:string)=>createWorldStateV2({
  ...base,
  revision,
  countriesById:{
    ...base.countriesById,
    AAA:{...base.countriesById.AAA,names:{...base.countriesById.AAA.names,shortKo:displayName,officialKo:displayName,mapKo:displayName,english:displayName}},
  },
});

const sources=()=>{
  const byId=new Map<RuntimeMapSourceId,MockSource>([
    [S.countriesLow,new MockSource()],[S.bordersLow,new MockSource()],
  ]);
  return {byId,getSource:(id:RuntimeMapSourceId)=>byId.get(id)};
};

describe("11-10 incremental MapLibre source adapter",()=>{
  it("uses unique territory and edge-owner IDs while preserving countryId properties",()=>{
    const first=base.territoriesById[firstId],second=base.territoriesById[secondId];
    const territoryIds=[firstId,secondId] as const;
    const coordinates=[[0,0],[1,1]] as const;
    const edge:TopologyEdge={id:deriveCanonicalTopologyEdgeId(territoryIds,coordinates),territoryIds,classification:"internal",coordinates};
    const state=createWorldStateV2({...base,topology:createTopologyState([edge]),territoriesById:{
      ...base.territoriesById,[firstId]:createTerritoryEntity({...first,ownerCountryId:base.countriesById.AAA.id}),
      [secondId]:createTerritoryEntity({...second,ownerCountryId:base.countriesById.BBB.id}),
    }});
    const projection=createWorldMapRuntimeProjection(state);
    assertUniqueMapSourceIds(fill(projection),S.countriesLow);
    assertUniqueMapSourceIds(border(projection),S.bordersLow);
    expect(fill(projection).features.find(feature=>feature.id===firstId)?.properties.countryId).toBe("AAA");
    expect(border(projection).features.map(feature=>feature.id).sort()).toEqual([`${edge.id}:AAA`,`${edge.id}:BBB`]);
    expect(border(projection).features.map(feature=>feature.properties.countryId).sort()).toEqual(["AAA","BBB"]);
    expect(()=>assertUniqueMapSourceIds(collection([fill(projection).features[0],fill(projection).features[0]]),S.countriesLow)).toThrow(/duplicate/);
  });

  it("diffs territory creation, ownership transfer, geometry replacement and deletion by ID",()=>{
    const oldFeature=fill(initial).features.find(feature=>feature.id===firstId)!;
    const stable=fill(initial).features.find(feature=>feature.id===secondId)!;
    const newId=deriveTerritoryId({kind:"seed",seedVersion:"11-10-incremental",sourceFeatureId:"added"});
    const geometry={type:"Polygon" as const,coordinates:[[[8,0],[9,0],[9,1],[8,1],[8,0]]]};
    const added=createTerritoryEntity({id:newId,ownerCountryId:base.countriesById.BBB.id,geometry,properties:{sourceFeatureId:"added"}});
    const transferred=createTerritoryEntity({...base.territoriesById[firstId],ownerCountryId:base.countriesById.BBB.id});
    const changed=createWorldMapRuntimeProjection(nextWorld({...base.territoriesById,[firstId]:transferred,[newId]:added},[...base.territoryOrder,newId]),initial);
    const transferDiff=diffMapSourceFeatures(fill(initial),fill(changed),S.countriesLow);
    expect(transferDiff.diff.add?.map(feature=>feature.id)).toEqual([newId]);
    expect(transferDiff.diff.update?.map(update=>update.id)).toEqual([firstId]);
    expect(transferDiff.diff.update?.[0].newGeometry).toBeUndefined();
    expect(transferDiff.changedIds).not.toContain(secondId);
    expect(fill(changed).features.find(feature=>feature.id===secondId)).toBe(stable);

    const reshaped=createTerritoryEntity({...base.territoriesById[firstId],geometry});
    const afterGeometry=createWorldMapRuntimeProjection(nextWorld({...base.territoriesById,[firstId]:reshaped},base.territoryOrder),initial);
    const geometryDiff=diffMapSourceFeatures(fill(initial),fill(afterGeometry),S.countriesLow);
    expect(geometryDiff.diff.update?.[0]).toMatchObject({id:firstId,newGeometry:geometry});
    expect(geometryDiff.changedIds).not.toContain(secondId);

    const afterDelete=createWorldMapRuntimeProjection(nextWorld(Object.fromEntries(Object.entries(base.territoriesById).filter(([id])=>id!==firstId)),base.territoryOrder.filter(id=>id!==firstId)),initial);
    const deleteDiff=diffMapSourceFeatures(fill(initial),fill(afterDelete),S.countriesLow);
    expect(deleteDiff.diff.remove).toEqual([firstId]);
    expect(deleteDiff.changedIds).not.toContain(secondId);
    expect(oldFeature.properties.countryId).toBe("AAA");
  });

  it("diffs only affected border IDs when an edge changes",()=>{
    const edge=(territoryId:typeof firstId,longitude:number):TopologyEdge=>{
      const territoryIds=[territoryId,null] as const,coordinates=[[longitude,0],[longitude,1]] as const;
      return {id:deriveCanonicalTopologyEdgeId(territoryIds,coordinates),territoryIds,classification:"coast",coordinates};
    };
    const changedEdge=edge(firstId,0),stableEdge=edge(secondId,2),replacement=edge(firstId,0.5);
    const beforeState=createWorldStateV2({...base,topology:createTopologyState([changedEdge,stableEdge])});
    const afterState=createWorldStateV2({...beforeState,revision:1,topology:createTopologyState([replacement,stableEdge])});
    const before=createWorldMapRuntimeProjection(beforeState),after=createWorldMapRuntimeProjection(afterState,before);
    const diff=diffMapSourceFeatures(border(before),border(after),S.bordersLow);
    expect(diff.diff.remove).toEqual([`${changedEdge.id}:AAA`]);
    expect(diff.diff.add?.map(feature=>feature.id)).toEqual([`${replacement.id}:AAA`]);
    expect(diff.changedIds).not.toContain(`${stableEdge.id}:BBB`);
    expect(border(after).features.find(feature=>feature.id===`${stableEdge.id}:BBB`))
      .toBe(border(before).features.find(feature=>feature.id===`${stableEdge.id}:BBB`));
  });

  it("uses setData only for first load/recreation and updateData only for changed IDs",async()=>{
    const {byId,getSource}=sources(),controller=new MapSourceIncrementalController();
    expect(controller.synchronize(initial,getSource)).toBe(true);
    const high=new MockSource(),highBorder=new MockSource();
    byId.set(S.countriesHigh,high);byId.set(S.bordersHigh,highBorder);
    expect(controller.synchronize(initial,getSource)).toBe(true);
    expect(high.setCalls).toHaveLength(1);
    expect(byId.get(S.countriesLow)!.setCalls).toHaveLength(1);

    const changed=createWorldMapRuntimeProjection(nextWorld({
      ...base.territoriesById,
      [firstId]:createTerritoryEntity({...base.territoriesById[firstId],ownerCountryId:base.countriesById.BBB.id}),
    },base.territoryOrder),initial);
    expect(controller.synchronize(changed,getSource)).toBe(true);
    for(const id of [S.countriesLow,S.countriesHigh] as const){
      const source=byId.get(id)!;
      expect(source.setCalls).toHaveLength(1);
      expect(source.updateCalls).toHaveLength(1);
      expect(source.updateCalls[0].update?.map(update=>update.id)).toEqual([firstId]);
    }
    for(const id of [S.bordersLow,S.bordersHigh] as const)expect(byId.get(id)!.updateCalls).toHaveLength(0);
    expect(await controller.verify(getSource)).toBe(true);
    expect(controller.synchronize(initial,getSource)).toBe(false);
    expect(controller.snapshot().revision).toBe(1);

    const replacement=new MockSource();byId.set(S.countriesHigh,replacement);
    controller.synchronize(changed,getSource);
    expect(replacement.setCalls).toHaveLength(1);
    expect(byId.get(S.countriesLow)!.setCalls).toHaveLength(1);
  });

  it("applies and verifies a country-name-only revision with property updateData diffs",async()=>{
    const renamed=createWorldMapRuntimeProjection(withCountryName(1,"Renamed AAA"),initial);
    const propertyDiff=diffMapSourceFeatures(fill(initial),fill(renamed),S.countriesLow);
    const affected=fill(initial).features.filter(feature=>feature.properties.ownerCountryId==="AAA").map(feature=>feature.id);
    expect(propertyDiff.changedIds).toEqual(affected);
    expect(propertyDiff.diff.update).toHaveLength(affected.length);
    expect(propertyDiff.diff.update?.every(update=>update.newGeometry===undefined&&update.removeAllProperties===true)).toBe(true);
    expect(propertyDiff.diff.update?.every(update=>update.addOrUpdateProperties?.some(property=>property.key==="displayName"&&property.value==="Renamed AAA"))).toBe(true);

    const {byId,getSource}=sources(),controller=new MapSourceIncrementalController();
    controller.synchronize(initial,getSource);
    controller.synchronize(renamed,getSource);
    expect(byId.get(S.countriesLow)!.setCalls).toHaveLength(1);
    expect(byId.get(S.countriesLow)!.updateCalls).toHaveLength(1);
    expect(byId.get(S.bordersLow)!.updateCalls).toHaveLength(0);
    expect(await controller.verify(getSource)).toBe(true);
    expect(controller.snapshot()).toMatchObject({revision:1,resyncRequired:false,error:null});
  });

  it("keeps a stale asynchronous verification from failing a newer revision",async()=>{
    const {byId,getSource}=sources(),controller=new MapSourceIncrementalController();
    controller.synchronize(initial,getSource);
    let release!: (data:IdFeatureCollection)=>void;
    byId.get(S.countriesLow)!.nextGetData=new Promise(resolve=>{release=resolve});
    const staleVerification=controller.verify(getSource);
    const renamed=createWorldMapRuntimeProjection(withCountryName(1,"Renamed AAA"),initial);
    controller.synchronize(renamed,getSource);
    release(fill(initial));
    expect(await staleVerification).toBe(false);
    expect(controller.snapshot()).toMatchObject({revision:1,resyncRequired:false,error:null});
    expect(await controller.verify(getSource)).toBe(true);
  });

  it("round-trips a property-only commit, undo, and redo through monotonic revisions",async()=>{
    const {byId,getSource}=sources(),controller=new MapSourceIncrementalController();
    const committed=createWorldMapRuntimeProjection(withCountryName(1,"Renamed AAA"),initial);
    const undone=createWorldMapRuntimeProjection(withCountryName(2,base.countriesById.AAA.names.mapKo),committed);
    const redone=createWorldMapRuntimeProjection(withCountryName(3,"Renamed AAA"),undone);
    for(const projection of [initial,committed,undone,redone])controller.synchronize(projection,getSource);
    const low=byId.get(S.countriesLow)!;
    expect(low.setCalls).toHaveLength(1);
    expect(low.updateCalls).toHaveLength(3);
    expect(low.data.features.find(feature=>feature.properties.ownerCountryId==="AAA")?.properties.displayName).toBe("Renamed AAA");
    expect(controller.snapshot()).toMatchObject({revision:3,resyncRequired:false,error:null});
    expect(await controller.verify(getSource)).toBe(true);
  });

  it("requires explicit resynchronization after an update failure",()=>{
    const {byId,getSource}=sources(),controller=new MapSourceIncrementalController();
    controller.synchronize(initial,getSource);
    const changed=createWorldMapRuntimeProjection(nextWorld({
      ...base.territoriesById,
      [firstId]:createTerritoryEntity({...base.territoriesById[firstId],ownerCountryId:base.countriesById.BBB.id}),
    },base.territoryOrder),initial);
    byId.get(S.countriesLow)!.failNextUpdate=true;
    expect(()=>controller.synchronize(changed,getSource)).toThrow(/resynchronization required/);
    expect(controller.snapshot()).toMatchObject({revision:0,resyncRequired:true,error:"injected update failure"});
    expect(()=>controller.synchronize(changed,getSource)).toThrow(/resynchronization required/);
    expect(byId.get(S.countriesLow)!.setCalls).toHaveLength(1);
    controller.resynchronize(changed,getSource);
    expect(controller.snapshot()).toMatchObject({revision:1,resyncRequired:false,error:null});
    expect(byId.get(S.countriesLow)!.setCalls).toHaveLength(2);
  });

  it("coalesces rapid commit and undo-like rollback from the last applied source without a full replacement",async()=>{
    const {byId,getSource}=sources(),controller=new MapSourceIncrementalController();
    controller.synchronize(initial,getSource);
    const transferred=createWorldMapRuntimeProjection(nextWorld({
      ...base.territoriesById,
      [firstId]:createTerritoryEntity({...base.territoriesById[firstId],ownerCountryId:base.countriesById.BBB.id}),
    },base.territoryOrder),initial);
    const rolledBackState=createWorldStateV2({...base,revision:2});
    const rolledBack=createWorldMapRuntimeProjection(rolledBackState,transferred);
    controller.synchronize(transferred,getSource);
    controller.synchronize(rolledBack,getSource);
    const low=byId.get(S.countriesLow)!;
    expect(low.setCalls).toHaveLength(1);
    expect(low.updateCalls.map(diff=>diff.update?.map(update=>update.id))).toEqual([[firstId],[firstId]]);
    expect(low.data.features.find(feature=>feature.id===firstId)?.properties.ownerCountryId).toBe("AAA");
    expect(controller.snapshot().revision).toBe(2);
    expect(await controller.verify(getSource)).toBe(true);
    expect(controller.synchronize(transferred,getSource)).toBe(false);
  });

  it("sends only changed border IDs to updateData",()=>{
    const edge=(territoryId:typeof firstId,longitude:number):TopologyEdge=>{
      const territoryIds=[territoryId,null] as const,coordinates=[[longitude,0],[longitude,1]] as const;
      return {id:deriveCanonicalTopologyEdgeId(territoryIds,coordinates),territoryIds,classification:"coast",coordinates};
    };
    const first=edge(firstId,0),stable=edge(secondId,2),replacement=edge(firstId,0.5);
    const beforeState=createWorldStateV2({...base,topology:createTopologyState([first,stable])});
    const afterState=createWorldStateV2({...beforeState,revision:1,topology:createTopologyState([replacement,stable])});
    const before=createWorldMapRuntimeProjection(beforeState),after=createWorldMapRuntimeProjection(afterState,before);
    const {byId,getSource}=sources(),controller=new MapSourceIncrementalController();
    controller.synchronize(before,getSource);
    controller.synchronize(after,getSource);
    const borderSource=byId.get(S.bordersLow)!;
    expect(borderSource.setCalls).toHaveLength(1);
    expect(borderSource.updateCalls).toHaveLength(1);
    expect(borderSource.updateCalls[0].remove).toEqual([`${first.id}:AAA`]);
    expect(borderSource.updateCalls[0].add?.map(feature=>feature.id)).toEqual([`${replacement.id}:AAA`]);
    expect(controller.snapshot().sources[S.bordersLow]?.changedIds).toEqual([`${first.id}:AAA`,`${replacement.id}:AAA`]);
    expect(byId.get(S.countriesLow)!.updateCalls).toHaveLength(0);
  });

  it("accepts MapLibre polygon winding normalization but flags missing source updates",async()=>{
    const {byId,getSource}=sources(),controller=new MapSourceIncrementalController();
    controller.synchronize(initial,getSource);
    const low=byId.get(S.countriesLow)!;
    const original=low.data.features[0];
    if(original.geometry.type!=="Polygon")throw new Error("Expected polygon fixture");
    const reversed={...original,geometry:{...original.geometry,coordinates:original.geometry.coordinates.map(ring=>[...ring].reverse())}} as IdFeature;
    low.data=collection([reversed,...low.data.features.slice(1)]);
    expect(await controller.verify(getSource)).toBe(true);
    low.data=collection(low.data.features.slice(1));
    expect(await controller.verify(getSource)).toBe(false);
    expect(controller.snapshot()).toMatchObject({resyncRequired:true});
  });
});
