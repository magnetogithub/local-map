import {describe,expect,it} from "vitest";
import {createWorldMapRuntimeProjection} from "../projection/world-map-runtime-projection";
import {createWorldStateStore} from "../../stores/world-state-store";
import {createCountryEntity} from "../world/country-entity";
import type {ActiveCountryId} from "../world/country-id";
import {createTerritoryEntity, type TerritoryGeometry} from "../world/territory-entity";
import {deriveTerritoryId} from "../world/territory-id";
import {createTopologyState} from "../world/topology-state";
import {createWorldStateV2} from "../world/world-state-v2";
import {createChinaProvinceDebugScenario} from "./china-province-debug-scenario";

const id=(value:string)=>value as ActiveCountryId;
const rectangle=(left:number,right:number):TerritoryGeometry=>({type:"Polygon",coordinates:[[[left,0],[right,0],[right,2],[left,2],[left,0]]]});
const country=(value:string)=>createCountryEntity({id:id(value),names:{shortKo:value,officialKo:value,mapKo:value,english:value,searchAliases:[value]},politicalStatus:"sovereign",presentationOverride:null,moduleVersions:{core:1,names:1}});

describe("11-11 China debug scenario v2 commit path",()=>{
  it("splits through the v2 planner and atomically restores the original v2 state",async()=>{
    const china=country("CHN"),neighbor=country("BBB");
    const chinaId=deriveTerritoryId({kind:"seed",seedVersion:"11-11",sourceFeatureId:"china"});
    const neighborId=deriveTerritoryId({kind:"seed",seedVersion:"11-11",sourceFeatureId:"neighbor"});
    const chinaTerritory=createTerritoryEntity({id:chinaId,ownerCountryId:china.id,geometry:rectangle(0,2),properties:{sourceFeatureId:"china"}});
    const neighborTerritory=createTerritoryEntity({id:neighborId,ownerCountryId:neighbor.id,geometry:rectangle(3,4),properties:{sourceFeatureId:"neighbor"}});
    const initial=createWorldStateV2({
      schemaVersion:2,seedVersion:"11-11",policyVersion:"world-policy-v1",revision:0,
      countriesById:{CHN:china,BBB:neighbor},countryOrder:[china.id,neighbor.id],retiredCountryIds:[],
      territoriesById:{[chinaId]:chinaTerritory,[neighborId]:neighborTerritory},territoryOrder:[chinaId,neighborId],
      topology:createTopologyState([]),
      hashRoots:{countriesRootHash:"a".repeat(64),presentationRootHash:"b".repeat(64),territoriesRootHash:"c".repeat(64),topologyRootHash:"d".repeat(64)},
    });
    const controller=createWorldStateStore(initial);
    const notifications:number[]=[];
    controller.subscribeDomain(({nextState})=>notifications.push(nextState.revision));
    const scenario=createChinaProvinceDebugScenario(controller,async()=>({features:[
      {properties:{countryId:"CHN-A",nameKo:"A",nameEn:"A",mapLabelKo:"A"},geometry:rectangle(0,1)},
      {properties:{countryId:"CHN-B",nameKo:"B",nameEn:"B",mapLabelKo:"B"},geometry:rectangle(1,2)},
    ]}));

    expect(await scenario.split()).toEqual({active:true,provinceCountryIds:["D01","D02"],countryIdBySourceId:{"CHN-A":"D01","CHN-B":"D02"}});
    const split=controller.getState();
    expect(split.revision).toBe(2);
    expect(split.countriesById.CHN).toBeUndefined();
    expect(split.retiredCountryIds.has("CHN" as never)).toBe(true);
    const mapProjection=createWorldMapRuntimeProjection(split);
    expect(mapProjection.countriesLow.features).toEqual(expect.arrayContaining([
      expect.objectContaining({properties:expect.objectContaining({countryId:"D01",projectionRevision:2})}),
      expect.objectContaining({properties:expect.objectContaining({countryId:"D02",projectionRevision:2})}),
    ]));
    expect(mapProjection.bordersLow.features).toEqual(expect.arrayContaining([
      expect.objectContaining({
        properties:expect.objectContaining({classification:"internal",countryId:"D01"}),
        geometry:expect.objectContaining({coordinates:[[1,0],[1,2]]}),
      }),
      expect.objectContaining({
        properties:expect.objectContaining({classification:"internal",countryId:"D02"}),
        geometry:expect.objectContaining({coordinates:[[1,0],[1,2]]}),
      }),
    ]));
    expect(await scenario.merge()).toEqual({active:true,mergedCountryId:"D03",sourceCountryIds:["D01","D02"]});
    const merged=controller.getState();
    expect(merged.revision).toBe(3);
    expect(merged.countriesById.D01).toBeUndefined();
    expect(merged.countriesById.D02).toBeUndefined();
    expect(merged.countriesById.D03?.names.english).toBe("China Union");
    expect(merged.territoryOrder.map(id=>merged.territoriesById[id].ownerCountryId)).toContain("D03");
    expect((createWorldMapRuntimeProjection(merged).bordersLow.features as Array<{properties:{classification:string}}>)
      .some(feature=>feature.properties.classification==="internal")).toBe(false);
    expect(await scenario.rollback()).toEqual({active:false,restoredCountryId:"CHN"});
    expect(controller.getState().revision).toBe(4);
    expect(controller.getState().countriesById.CHN).toBeDefined();
    expect(controller.getState().countriesById.D01).toBeUndefined();
    expect(notifications).toEqual([1,2,3,4]);
  });
});
