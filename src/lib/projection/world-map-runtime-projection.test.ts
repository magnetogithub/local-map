import {describe,expect,it} from "vitest";
import {createCommandUiDemoWorldState} from "../planning/command-ui-runtime";
import {createWorldStateV2,deserializeWorldStateV2,serializeWorldStateV2} from "../world/world-state-v2";
import {createTerritoryEntity} from "../world/territory-entity";
import {deriveCanonicalTopologyEdgeId} from "../world/canonical-topology";
import {createTopologyState, type TopologyEdge} from "../world/topology-state";
import {createWorldMapRuntimeProjection,DEFAULT_NEW_COUNTRY_MAP_COLORS,shouldApplyWorldMapRuntimeProjection} from "./world-map-runtime-projection";

describe("11-10 WorldMap runtime projection",()=>{
  it("offers a broad, duplicate-free palette for countries without a seeded color",()=>{
    expect(DEFAULT_NEW_COUNTRY_MAP_COLORS.length).toBeGreaterThanOrEqual(24);
    expect(new Set(DEFAULT_NEW_COUNTRY_MAP_COLORS).size).toBe(DEFAULT_NEW_COUNTRY_MAP_COLORS.length);
  });

  it("keeps seeded country colors through an ownership change",()=>{
    const before=createCommandUiDemoWorldState();
    const colors={AAA:"#88494a",BBB:"#7895c4"};
    const changedId=before.territoryOrder[0];
    const original=createWorldMapRuntimeProjection(before,undefined,colors);
    const after=createWorldStateV2({
      ...before,revision:before.revision+1,
      territoriesById:{...before.territoriesById,
        [changedId]:createTerritoryEntity({...before.territoriesById[changedId],ownerCountryId:before.countriesById.BBB.id})},
    });
    const updated=createWorldMapRuntimeProjection(after,original,colors);
    const feature=(features:readonly unknown[],id:string)=>features.find(item=>(item as {id:string}).id===id) as {properties:{mapColor:string}};

    for(const resolution of ["countriesLow","countriesHigh"] as const){
      expect(feature(original[resolution].features,changedId).properties.mapColor).toBe("#88494a");
      expect(feature(updated[resolution].features,changedId).properties.mapColor).toBe("#7895c4");
    }
  });

  it("hydrates the v2 store seed and derives selectable geometry and focus from one revision",()=>{
    const original=createCommandUiDemoWorldState();
    const state=deserializeWorldStateV2(JSON.parse(JSON.stringify(serializeWorldStateV2(original))));
    const map=createWorldMapRuntimeProjection(state);
    const owned=map.countriesLow.features as Array<{properties:{countryId:string|null;projectionRevision:number}}>;

    expect(state.revision).toBe(0);
    expect(map.appliedRevision).toBe(state.revision);
    expect(owned.filter(feature=>feature.properties.countryId==="AAA")).toHaveLength(2);
    expect(owned.every(feature=>feature.properties.projectionRevision===state.revision)).toBe(true);
    expect(map.focusByCountryId.AAA.center).toEqual([1.5,0.5]);
    expect(map.focusByCountryId.BBB.center).toEqual([4.5,0.5]);
  });

  it("applies a committed revision and rejects stale map artifacts",()=>{
    const before=createCommandUiDemoWorldState();
    const after=createWorldStateV2({...before,revision:before.revision+1});
    const previous=createWorldMapRuntimeProjection(before);
    const current=createWorldMapRuntimeProjection(after,previous);

    expect(shouldApplyWorldMapRuntimeProjection(previous.appliedRevision,current)).toBe(true);
    expect(shouldApplyWorldMapRuntimeProjection(current.appliedRevision,previous)).toBe(false);
    expect(current.countriesHigh.features).toHaveLength(current.countriesLow.features.length);
    expect(current.appliedRevision).toBe(1);
    expect(current.countriesLow.features[0]).toBe(previous.countriesLow.features[0]);
    expect(current.mapSources.low.featureCollection.features[0])
      .toBe(previous.mapSources.low.featureCollection.features[0]);
  });

  it("replaces only the owning country's features when its display name changes",()=>{
    const before=createCommandUiDemoWorldState();
    const previous=createWorldMapRuntimeProjection(before);
    const renamed=createWorldStateV2({...before,revision:1,countriesById:{...before.countriesById,AAA:{
      ...before.countriesById.AAA,
      names:{...before.countriesById.AAA.names,mapKo:"Renamed AAA",shortKo:"Renamed AAA"},
    }}});
    const current=createWorldMapRuntimeProjection(renamed,previous);
    const oldById=new Map((previous.countriesLow.features as Array<{id:string;properties:{ownerCountryId:string|null}}>).map(feature=>[feature.id,feature]));
    const nextFeatures=current.countriesLow.features as Array<{id:string;properties:{ownerCountryId:string|null;displayName:string|null}}>;
    expect(nextFeatures.filter(feature=>feature.properties.ownerCountryId==="AAA").every(feature=>feature.properties.displayName==="Renamed AAA")).toBe(true);
    expect(nextFeatures.filter(feature=>feature.properties.ownerCountryId==="AAA").every(feature=>feature!==oldById.get(feature.id))).toBe(true);
    expect(nextFeatures.filter(feature=>feature.properties.ownerCountryId==="BBB").every(feature=>feature===oldById.get(feature.id))).toBe(true);
  });

  it("keeps unaffected map-source feature references across an ownership patch",()=>{
    const before=createCommandUiDemoWorldState();
    const [changedId,stableId]=before.territoryOrder;
    const changed=before.territoriesById[changedId];
    const after=createWorldStateV2({
      ...before,
      revision:before.revision+1,
      territoriesById:{
        ...before.territoriesById,
        [changedId]:createTerritoryEntity({...changed,ownerCountryId:before.countriesById.BBB.id}),
      },
    });
    const previous=createWorldMapRuntimeProjection(before);
    const current=createWorldMapRuntimeProjection(after,previous);
    const byId=(features:readonly unknown[])=>new Map(features.map(item=>{
      const feature=item as {id:string;properties:{countryId:string|null}};
      return [feature.id,feature] as const;
    }));

    for(const resolution of ["low","high"] as const){
      const sourceBefore=byId(previous.mapSources[resolution].featureCollection.features);
      const sourceAfter=byId(current.mapSources[resolution].featureCollection.features);
      expect(sourceAfter.get(changedId)).not.toBe(sourceBefore.get(changedId));
      expect(sourceAfter.get(stableId)).toBe(sourceBefore.get(stableId));
      const fillBefore=byId(previous[resolution==="low"?"countriesLow":"countriesHigh"].features);
      const fillAfter=byId(current[resolution==="low"?"countriesLow":"countriesHigh"].features);
      expect(fillAfter.get(changedId)?.properties.countryId).toBe("BBB");
      expect(fillAfter.get(stableId)).toBe(fillBefore.get(stableId));
    }
    expect(current.appliedRevision).toBe(after.revision);
  });

  it("does not render an artificial antimeridian coast cut",()=>{
    const before=createCommandUiDemoWorldState();
    const territoryIds=[before.territoryOrder[0],null] as const;
    const edge=(coordinates:readonly (readonly [number,number])[]):TopologyEdge=>({
      id:deriveCanonicalTopologyEdgeId(territoryIds,coordinates),territoryIds,classification:"coast",coordinates,
    });
    const cut=edge([[-180,65],[-180,69]]);
    const coast=edge([[170,65],[171,66]]);
    const state={...before,topology:createTopologyState([cut,coast])};
    const borders=createWorldMapRuntimeProjection(state).bordersHigh.features as Array<{properties:{topologyEdgeId:string}}>;
    expect(borders.map(feature=>feature.properties.topologyEdgeId)).not.toContain(cut.id);
    expect(borders.map(feature=>feature.properties.topologyEdgeId)).toContain(coast.id);
  });

  it("updates only borders whose territory ownership changed",()=>{
    const before=createCommandUiDemoWorldState();
    const [firstId,secondId]=before.territoryOrder;
    const edge=(territoryId:typeof firstId,longitude:number):TopologyEdge=>{
      const coordinates=[[longitude,0],[longitude,1]] as const;
      const territoryIds=[territoryId,null] as const;
      return {id:deriveCanonicalTopologyEdgeId(territoryIds,coordinates),territoryIds,classification:"coast",coordinates};
    };
    const firstEdge=edge(firstId,0),secondEdge=edge(secondId,2);
    const initial=createWorldStateV2({...before,topology:createTopologyState([firstEdge,secondEdge])});
    const oldProjection=createWorldMapRuntimeProjection(initial);
    const next=createWorldStateV2({
      ...initial,revision:1,
      territoriesById:{...initial.territoriesById,
        [firstId]:createTerritoryEntity({...initial.territoriesById[firstId],ownerCountryId:initial.countriesById.BBB.id})},
    });
    const newProjection=createWorldMapRuntimeProjection(next,oldProjection);
    const oldBorders=oldProjection.bordersLow.features as Array<{properties:{topologyEdgeId:string;countryId:string}}>,
      newBorders=newProjection.bordersLow.features as typeof oldBorders;
    expect(newBorders.find(feature=>feature.properties.topologyEdgeId===firstEdge.id)?.properties.countryId).toBe("BBB");
    expect(newBorders.find(feature=>feature.properties.topologyEdgeId===secondEdge.id))
      .toBe(oldBorders.find(feature=>feature.properties.topologyEdgeId===secondEdge.id));
    expect(newProjection.bordersLow).toBe(newProjection.bordersHigh);
  });
});
