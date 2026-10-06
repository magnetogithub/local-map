// @vitest-environment node
import fs from 'node:fs';
import {beforeAll,expect,it} from 'vitest';
import {prepareProductionCatalogSeed} from '../world/production-catalog-seed.server';
import {readCatalogConsumerMetadata} from '../map/catalog-consumer-contract';
import {catalogContractForConsumer} from '../projection/catalog-map-consumer-projection';
import {createCountrySearchProjection} from '../projection/country-search-index-patch';
import {createCatalogRuntime,readCatalogRuntimePair,type CatalogRuntimePair} from './catalog-runtime';
import {createSimulationStateV2} from './simulation-state-v2';
import {buildSimulationContext} from './simulation-context';
import {loadCatalogRegionIndex} from './catalog-region.server';
import {createCatalogTurnPlan} from './catalog-turn-plan';
import {validateResolutionAgainstContext} from './server/context-resolution-validator';
import {executeReadOnlySimulationTool} from './server/simulation-tools';
import {OpenAIResponsesSimulationProvider} from './server/openai-responses-provider';
import type {OpenAIResponsesRequest} from './server/openai-responses-transport';
import {createSimulationTurnPost} from '../../app/api/simulation/turn/route';
const index=loadCatalogRegionIndex();
let seed:CatalogRuntimePair,catalog:ReturnType<typeof catalogContractForConsumer>;
beforeAll(()=>{const p=prepareProductionCatalogSeed();catalog=catalogContractForConsumer(readCatalogConsumerMetadata(JSON.parse(fs.readFileSync(`public${p.bootstrap.metadata.path}`,'utf8')),p.bootstrap.catalogRef));seed=readCatalogRuntimePair(p.serializedPair,catalog);});
it('returns a directly usable territorial effect target for the Korean frontier without fabricated subdivision references',()=>{
  const context=buildSimulationContext({simulation:seed.simulation,world:seed.world,countrySearchProjection:createCountrySearchProjection(seed.world),subdivisionCatalog:{listCountry:()=>[],inspect:()=>null,materialize:()=>null},scenarioId:'2020-otl',scenarioStartDate:'2020-01-01',targetDate:'2020-01-08'});
  const result=executeReadOnlySimulationTool('find_border_territories',{countryId:'PRK',neighborCountryId:'KOR',cap:512},context,index) as {ok:boolean;territoryIds:string[];effectTarget:{territoryIds:string[];regionRefs:null}};
  expect(result.ok).toBe(true);
  expect(result.territoryIds).toHaveLength(2);
  expect(result.effectTarget).toEqual({territoryIds:result.territoryIds,regionRefs:null});
  expect(result.territoryIds.every(id=>seed.world.territoriesById[id].ownerCountryId==='PRK')).toBe(true);
});
const ground={eventId:'event.ground',date:'2020-01-01',title:'Treaty',publicNarrative:'Bounded treaty authority',actorCountryIds:['KOR','CHN'],relatedFactIds:[],relatedSituationIds:[],causes:[],outcomeCategory:'treaty',significance:'notable'};
function fixture(){
 const region=index.search('CHN','Guangdong')[0];expect(region).toBeDefined();
 const authority={id:'tca:region',actorCountryId:'KOR',targetCountryId:'CHN',allowedTerritoryIds:region.territoryIds,allowedOperations:['occupy'],validFrom:'2020-01-01',validTo:null,sourceEventId:ground.eventId};
 const simulation=createSimulationStateV2({...seed.simulation,playerCountryId:'KOR',eventLog:[ground],territorialControlAuthoritiesById:{[authority.id]:authority},territorialControlAuthorityOrder:[authority.id]},seed.world);
 const pair={...seed,simulation};const context=buildSimulationContext({simulation,world:pair.world,countrySearchProjection:createCountrySearchProjection(pair.world),subdivisionCatalog:{listCountry:()=>[],inspect:()=>null,materialize:()=>null},scenarioId:'2020-otl',scenarioStartDate:'2020-01-01',targetDate:'2020-01-02'});
 const effect={effectId:'effect.occupy',causedByEventId:'event.operation',type:'territory.occupy',actorCountryId:'KOR',targetCountryId:'CHN',authorityId:authority.id,territoryIds:[],regionRefs:[{countryId:'CHN',reference:region.ref}]};
 const resolution={contractVersion:'turn-resolution.v1',baseSimulationRevision:simulation.revision,baseWorldRevision:pair.world.revision,period:context.period,playerActionOutcomes:[],events:[{...ground,eventId:'event.operation',date:'2020-01-02',causes:[{kind:'authoritative-event',id:ground.eventId}],outcomeCategory:'military'}],factMutations:[],situationMutations:[],scheduledConsequences:[],worldEffects:[effect],advisorSummary:'Resolved region',unresolvedQuestions:[]};
 return {region,pair,context,effect,resolution};
}
const toolEvents=(id:string,name:string,args:unknown)=>{const item={type:'function_call',call_id:id,name,arguments:JSON.stringify(args)};return [{type:'response.output_item.added',item:{...item,arguments:''}},{type:'response.function_call_arguments.done',call_id:id,arguments:item.arguments},{type:'response.output_item.done',item},{type:'response.completed',response:{id:`response.${id}`}}];};
it('looks up a real name outside clipped context through provider tools and route validation, then plans and atomically commits',async()=>{
 const {region,pair,context,resolution}=fixture();expect(context.subdivisions).toEqual([]);
 const requests:OpenAIResponsesRequest[]=[];
 const transport={async *stream(request:OpenAIResponsesRequest){requests.push(request);const n=requests.length;let events;
   if(n===1)events=toolEvents('lookup','find_region',{countryId:'CHN',query:'Guangdong'});
   else if(n===2){expect(JSON.stringify(request.input)).toContain(region.ref.subdivisionId);events=toolEvents('resolve','resolve_region',{countryId:'CHN',reference:region.ref,operation:'occupy',cap:512});}
   else {expect(JSON.stringify(request.input)).toContain(region.territoryIds[0]);events=toolEvents('submit','submit_turn_resolution',resolution);}for(const event of events)yield event;
 }};
 const provider=new OpenAIResponsesSimulationProvider({apiKey:'fixture',model:'fixture',timeoutMs:5000,maxRetries:0,maxToolIterations:4,maxToolCalls:8,debugMode:false},transport);
 const post=createSimulationTurnPost({createProvider:()=>provider});const response=await post(new Request('http://localhost/api/simulation/turn',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({turnId:'turn.region',context})}));
 expect(response.status).toBe(200);const events=(await response.text()).trim().split('\n').map(line=>JSON.parse(line));const ready=events.find(e=>e.type==='resolution.ready');expect(ready,JSON.stringify(events)).toBeDefined();
 const runtime=createCatalogRuntime(pair,catalog);let notifications=0;runtime.store.subscribe(()=>notifications++);
 const plan=createCatalogTurnPlan({...pair,catalog,regionIndex:index,turnId:'turn.region',resolution:ready.resolution});const next=runtime.commit(plan);expect(notifications).toBe(1);
 for(const id of region.territoryIds){expect(next.world.territoriesById[id].ownerCountryId).toBe('CHN');expect(next.world.territoriesById[id].controllerCountryId).toBe('KOR');}
 expect(plan.changeSummary.changedTerritoryIds).toEqual(region.territoryIds);expect(next.world.catalogRef).toEqual(pair.world.catalogRef);expect(runtime.undo().world.territoriesById[region.territoryIds[0]].controllerCountryId).toBe('CHN');expect(runtime.redo().world.territoriesById[region.territoryIds[0]].controllerCountryId).toBe('KOR');
});
it('rejects ambiguity, missing references, roots, caps, unsupported operations and out-of-authority regions without mutation',()=>{
 const {region,pair,context,resolution,effect}=fixture(),runtime=createCatalogRuntime(pair,catalog);
 expect(executeReadOnlySimulationTool('find_region',{countryId:'USA',query:'Carolina'},context,index)).toMatchObject({ok:false,code:'AMBIGUOUS_REGION'});
 expect(executeReadOnlySimulationTool('find_region',{countryId:'CHN',query:'NoSuchRegion'},context,index)).toMatchObject({ok:false,code:'UNKNOWN_REGION'});
 expect(()=>index.resolve('CHN',region.ref,'occupy',0)).toThrow();expect(()=>index.resolve('CHN',region.ref,'geometry')).toThrow();expect(()=>index.resolve('USA',region.ref,'occupy')).toThrow();
 expect(()=>executeReadOnlySimulationTool('resolve_region',{countryId:'CHN',reference:region.ref,operation:'occupy',cap:513},context,index)).toThrow();
 expect(validateResolutionAgainstContext(resolution,{...context,regionCatalog:{...context.regionCatalog!,topologyRoot:'0'.repeat(64) as never}},{regionIndex:index}).ok).toBe(false);
 for(const reference of [{...region.ref,sourceVersion:'0'.repeat(64)},index.search('CHN','Zhejiang')[0].ref]){
   const bad={...resolution,worldEffects:[{...effect,regionRefs:[{countryId:'CHN',reference}]}]};
   expect(validateResolutionAgainstContext(bad,context,{regionIndex:index}).ok).toBe(false);
   expect(()=>createCatalogTurnPlan({...pair,catalog,regionIndex:index,turnId:'turn.bad',resolution:bad})).toThrow();expect(runtime.getSnapshot().world).toBe(pair.world);
 }
 for(const badEffect of [{...effect,regionRefs:Array.from({length:9},()=>({countryId:'CHN',reference:region.ref}))},{...effect,territoryIds:[index.search('CHN','Zhejiang')[0].territoryIds[0]]}]){
  const bad={...resolution,worldEffects:[badEffect]};expect(validateResolutionAgainstContext(bad,context,{regionIndex:index}).ok).toBe(false);expect(()=>createCatalogTurnPlan({...pair,catalog,regionIndex:index,turnId:'turn.cap-or-mismatch',resolution:bad})).toThrow();expect(runtime.getSnapshot().world).toBe(pair.world);
 }
});
it('retains original source-region identity after legal ownership changes',()=>{
 const {region,pair,resolution,effect}=fixture(),runtime=createCatalogRuntime(pair,catalog);
 const simulation=createSimulationStateV2({...pair.simulation,territorialControlAuthoritiesById:{'tca:region':{...pair.simulation.territorialControlAuthoritiesById['tca:region'],actorCountryId:'CHN',targetCountryId:'KOR',allowedOperations:['transfer']}}},pair.world);
 const transferRuntime=createCatalogRuntime({...pair,simulation},catalog);
 const next=transferRuntime.commit(createCatalogTurnPlan({...pair,simulation,catalog,regionIndex:index,turnId:'turn.transfer',resolution:{...resolution,worldEffects:[{...effect,actorCountryId:'CHN',targetCountryId:'KOR',type:'territory.transferOwnership',newOwnerCountryId:'KOR',controllerPolicy:'new-owner'}]}}));
 expect(runtime.getSnapshot().world).toBe(pair.world);
 for(const id of region.territoryIds)expect(next.world.territoriesById[id].ownerCountryId).toBe('KOR');
 expect(index.resolve('CHN',region.ref,'occupy').territoryIds).toEqual(region.territoryIds);expect(catalog.territoriesById[region.territoryIds[0]].sourceCountryId).toBe('CHN');
});
