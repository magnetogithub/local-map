import {parseCountrySplitV2Command} from "../commands/country-split-v2";
import {parseCountryMergeV2Command} from "../commands/country-merge-v2";
import {calculateAffectedSet} from "../planning/affected-set";
import {commitVerifiedWorldPatch} from "../planning/atomic-world-commit";
import {planCountrySplit} from "../planning/country-split-planner";
import {planCountryMerge} from "../planning/country-merge-planner";
import {buildWorldPatchV2} from "../planning/world-patch-v2";
import type {WorldStateStoreController} from "../../stores/world-state-store";
import {buildDomainRootHash} from "../world/domain-hash-root";
import {createTerritoryEntity, type TerritoryGeometry} from "../world/territory-entity";
import {territoryGeometryLeafHash} from "../world/territory-geometry-hash";
import {territoryOwnershipLeafHash} from "../world/territory-ownership-hash";
import {deriveTerritoryId, type TerritoryId} from "../world/territory-id";
import {topologyEdgeLeafHash} from "../world/topology-edge-hash";
import {createTopologyState} from "../world/topology-state";
import type {WorldStateV2} from "../world/world-state-v2";
import {buildCanonicalTopology} from "../world/canonical-topology";

type ProvinceFeature = Readonly<{
  properties:Readonly<{countryId:string;nameKo:string;nameEn:string;mapLabelKo:string}>;
  geometry:TerritoryGeometry;
}>;
type ProvinceCollection = Readonly<{features:readonly ProvinceFeature[]}>;
type ProvinceFixtureLoader = ()=>Promise<ProvinceCollection>;

const defaultFixtureLoader:ProvinceFixtureLoader=async()=>{
  const response=await fetch("/data/maps/china-province-countries-test.geojson");
  if(!response.ok)throw new Error(`China province fixture HTTP ${response.status}`);
  return response.json() as Promise<ProvinceCollection>;
};

const geometryPolicy={coordinatePrecision:6,exteriorRingWinding:"counterclockwise" as const};
const compareText=(left:string,right:string)=>left<right?-1:left>right?1:0;

function fixtureHashRoots(state:WorldStateV2){
  const territoryHashes=Object.fromEntries(Object.entries(state.territoriesById).flatMap(([id,territory])=>[
    [`geometry:${id}`,territoryGeometryLeafHash(territory,geometryPolicy)],
    [`ownership:${id}`,territoryOwnershipLeafHash(territory)],
  ]));
  const topologyHashes=Object.fromEntries(Object.entries(state.topology.edgesById).map(([id,edge])=>[id,topologyEdgeLeafHash(edge)]));
  return {
    ...state.hashRoots,
    territoriesRootHash:buildDomainRootHash("territories",territoryHashes),
    topologyRootHash:buildDomainRootHash("topology",topologyHashes),
  };
}

function commitScenarioState(
  controller:WorldStateStoreController,
  commandId:string,
  nextState:WorldStateV2,
  plannerPatch:unknown,
){
  const beforeState=controller.getState();
  const patch=buildWorldPatchV2({
    commandId,beforeState,afterState:nextState,
    affectedSet:calculateAffectedSet({beforeState,afterState:nextState,patch:plannerPatch}),
    plannerPatch,
  });
  commitVerifiedWorldPatch({store:controller,nextState,patch});
}

export function createChinaProvinceDebugScenario(
  controller:WorldStateStoreController,
  loadFixture:ProvinceFixtureLoader=defaultFixtureLoader,
){
  let original:WorldStateV2|null=null;
  let provinceCountryIds:string[]=[];
  let countryIdBySourceId:Record<string,string>={};
  let mergedCountryId:string|null=null;

  return {
    snapshot:()=>({active:original!==null,provinceCountryIds:[...provinceCountryIds],countryIdBySourceId:{...countryIdBySourceId},mergedCountryId}),
    async split(){
      if(original)return {active:true as const,provinceCountryIds:[...provinceCountryIds],countryIdBySourceId:{...countryIdBySourceId}};
      const before=controller.getState();
      const sourceTerritoryIds=before.territoryOrder.filter(id=>before.territoriesById[id].ownerCountryId==="CHN");
      if(sourceTerritoryIds.length!==1)throw new Error("China debug fixture expects one CHN Territory");
      const sourceTerritoryId=sourceTerritoryIds[0];
      const provinces=[...(await loadFixture()).features].sort((left,right)=>compareText(left.properties.countryId,right.properties.countryId));
      if(provinces.length<2||new Set(provinces.map(feature=>feature.properties.countryId)).size!==provinces.length||provinces.some(feature=>!feature.properties.countryId.startsWith("CHN-")))throw new Error("China province fixture is invalid");
      const provinceTerritories=provinces.map(feature=>createTerritoryEntity({
        id:deriveTerritoryId({kind:"partition",sourceTerritoryId,partitionKey:feature.properties.countryId}),
        ownerCountryId:before.countriesById.CHN.id,
        geometry:feature.geometry,
        properties:{sourceFeatureId:feature.properties.countryId},
      }));
      const territoriesById={...before.territoriesById};
      delete territoriesById[sourceTerritoryId];
      for(const territory of provinceTerritories)territoriesById[territory.id]=territory;
      const provinceTopology=buildCanonicalTopology(Object.fromEntries(provinceTerritories.map(territory=>[territory.id,territory])));
      const topology=createTopologyState([
        ...Object.values(before.topology.edgesById).filter(edge=>!edge.territoryIds.includes(sourceTerritoryId)),
        ...Object.values(provinceTopology.edgesById),
      ]);
      const preparedInput={...before,revision:before.revision+1,territoriesById:Object.freeze(territoriesById),territoryOrder:Object.freeze([...before.territoryOrder.filter(id=>id!==sourceTerritoryId),...provinceTerritories.map(territory=>territory.id)]),topology};
      const prepared=Object.freeze({...preparedInput,hashRoots:Object.freeze(fixtureHashRoots(preparedInput))}) as WorldStateV2;
      const command=parseCountrySplitV2Command({
        commandId:`test-only-china-split-${prepared.revision}`,
        type:"country.split",
        expectedRevision:prepared.revision,
        payload:{
          sourceCountryId:"CHN",
          resultCountries:provinces.map((feature,index)=>({
            country:{
              names:{shortKo:feature.properties.nameKo,officialKo:feature.properties.nameKo,mapKo:feature.properties.mapLabelKo,english:feature.properties.nameEn,searchAliases:[feature.properties.countryId,feature.properties.nameKo]},
              politicalStatus:"sovereign",presentationOverride:null,moduleVersions:{core:1,names:1},
            },
            territorySources:[{kind:"territory-id",territoryId:provinceTerritories[index].id}],
          })),
        },
      });
      const planned=planCountrySplit(prepared,command,{committedCommandIds:controller.getCommittedCommandIds()});
      if(!planned.ok)throw new Error(planned.error.message);
      commitScenarioState(controller,`test-only-china-prepare-${prepared.revision}`,prepared,{
        kind:"territory.partition",sourceTerritoryId,partitionTerritoryIds:provinceTerritories.map(territory=>territory.id),
      });
      commitScenarioState(controller,command.commandId,planned.plan.nextState,planned.plan.patch);
      original=before;
      provinceCountryIds=provinceTerritories.map(territory=>planned.plan.patch.territoryOwnerChanges[territory.id]);
      countryIdBySourceId=Object.fromEntries(provinces.map((feature,index)=>[
        feature.properties.countryId,
        provinceCountryIds[index],
      ]));
      return {active:true as const,provinceCountryIds:[...provinceCountryIds],countryIdBySourceId:{...countryIdBySourceId}};
    },
    async merge(){
      if(!original)throw new Error("Split China before running the merge scenario");
      if(mergedCountryId)return {active:true as const,mergedCountryId,sourceCountryIds:[...provinceCountryIds]};
      const before=controller.getState();
      const sourceCountryIds=provinceCountryIds.filter(countryId=>before.countriesById[countryId]);
      if(sourceCountryIds.length<2)throw new Error("China province merge requires at least two active province countries");
      const command=parseCountryMergeV2Command({
        commandId:`test-only-china-merge-${before.revision+1}`,
        type:"country.merge",
        expectedRevision:before.revision,
        payload:{
          sourceCountryIds,
          resultCountry:{kind:"new-country",country:{
            names:{shortKo:"以묎뎅 ?곕갑",officialKo:"以묎뎅 ?곕갑",mapKo:"以묎뎅 ?곕갑",english:"China Union",searchAliases:["China Union"]},
            politicalStatus:"sovereign",presentationOverride:null,moduleVersions:{core:1,names:1},
          }},
          metadataInheritance:{mode:"preserve-result"},
        },
      });
      const planned=planCountryMerge(before,command,{committedCommandIds:controller.getCommittedCommandIds()});
      if(!planned.ok)throw new Error(planned.error.message);
      commitScenarioState(controller,command.commandId,planned.plan.nextState,planned.plan.patch);
      mergedCountryId=planned.plan.patch.resultCountryId;
      return {active:true as const,mergedCountryId,sourceCountryIds:[...sourceCountryIds]};
    },
    async rollback(){
      if(!original)return {active:false as const,restoredCountryId:"CHN" as const};
      const before=controller.getState();
      const restored=Object.freeze({...original,revision:before.revision+1}) as WorldStateV2;
      const removedTerritoryIds=before.territoryOrder.filter(id=>!restored.territoriesById[id]);
      const restoredTerritoryIds=restored.territoryOrder.filter(id=>!before.territoriesById[id]);
      const plannerPatch={
        kind:"command.batch",
        commandPatches:[
          {kind:"country.merge",sourceCountryIds:provinceCountryIds,resultCountryId:"CHN",territoryOwnerChanges:Object.fromEntries(removedTerritoryIds.map(id=>[id,"CHN"]))},
          {kind:"territory.partition",sourceTerritoryId:restoredTerritoryIds[0] as TerritoryId,partitionTerritoryIds:removedTerritoryIds},
        ],
      };
      commitScenarioState(controller,`test-only-china-rollback-${restored.revision}`,restored,plannerPatch);
      original=null;
      provinceCountryIds=[];
      countryIdBySourceId={};
      mergedCountryId=null;
      return {active:false as const,restoredCountryId:"CHN" as const};
    },
  };
}

