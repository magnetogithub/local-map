// @vitest-environment node
import {describe, expect, it} from 'vitest';
import {createCountryEntityV3} from '../../world/country-entity-v3';
import {createWorldStateV3} from '../../world/world-state-v3';
import {createWorldGeometryCatalogContract, readCatalogTerritoryId} from '../../world/world-geometry-catalog-ref';
import {createTerritoryEntityV3} from '../../world/territory-entity-v3';
import {OPERATIONAL_CATALOG_VERSION, type OperationalCell} from '../../world/operational-catalog';
import {createCountrySearchProjection} from '../../projection/country-search-index-patch';
import {createSimulationStateV2} from '../simulation-state-v2';
import {createCatalogRuntime} from '../catalog-runtime';
import {buildSimulationContext} from '../simulation-context';
import {createCatalogRegionIndex} from '../catalog-region';
import {selectOperationalFrontier, type OperationalFrontierCatalog} from '../operational-frontier.server';
import {validateOperationalFrontierEffects, type OperationalFrontierValidation} from '../operational-frontier-validation';
import {createCatalogTurnPlan} from '../catalog-turn-plan';
import {parseTurnResolutionV1} from '../turn-resolution';
import {validateResolutionAgainstContext} from './context-resolution-validator';
import {OpenAIResponsesSimulationProvider} from './openai-responses-provider';
import type {OpenAIResponsesRequest, OpenAIResponsesTransport} from './openai-responses-transport';
import {createSimulationTurnPost} from './simulation-turn-handler';
import {createSimulationToolManifest, executeReadOnlySimulationTool} from './simulation-tools';

const cellId = (n: number) => readCatalogTerritoryId(`territory:catalog:${n.toString(16).padStart(64, '0')}`);
const config = {apiKey:'fixture',model:'fixture',timeoutMs:5000,maxRetries:0,maxToolIterations:1,maxToolCalls:3,debugMode:false};
const lookupArgs = {actorCountryId:'AAA',targetCountryId:'BBB',operation:'occupy',extent:'near',direction:null,reference:null,regionQuery:null,cap:512};
const tools = (id: string, name: string, args: unknown) => {
  const item = {type:'function_call',call_id:id,name,arguments:JSON.stringify(args)};
  return [{type:'response.output_item.added',item:{...item,arguments:''}},{type:'response.function_call_arguments.done',call_id:id,arguments:item.arguments},{type:'response.output_item.done',item},{type:'response.completed',response:{id:`response.${id}`}}];
};
const collect = async <T>(source: AsyncIterable<T>) => {const all: T[] = []; for await (const value of source) all.push(value); return all;};

function fixture(operation: 'occupy' | 'liberate' | 'transfer' = 'occupy') {
  const ref = {catalogVersion:OPERATIONAL_CATALOG_VERSION,geometryRoot:'a'.repeat(64),topologyRoot:'b'.repeat(64),renderArtifactRoot:'c'.repeat(64),manifestPath:`/data/${OPERATIONAL_CATALOG_VERSION}/manifest.json`};
  const cells: OperationalCell[] = Array.from({length:9}, (_,i) => ({id:cellId(i+1),ordinal:i+1,sourceCountryId:(i===0?'AAA':i===8?'CCC':'BBB') as OperationalCell['sourceCountryId'],administrativeOrdinal:i===0?1:2,previousParentOrdinal:1}));
  const contract = createWorldGeometryCatalogContract({ref,territoryOrder:cells.map(c=>c.id),territoriesById:Object.fromEntries(cells.map(c=>[c.id,{id:c.id,sourceCountryId:c.sourceCountryId}]))});
  const countries = ['AAA','BBB','CCC'].map((id,i) => createCountryEntityV3({id,names:{shortKo:id,officialKo:id,mapKo:id,english:id,searchAliases:[]},politicalStatus:'sovereign',presentationOverride:null,moduleVersions:{core:1},mapColor:['#AABBCC','#DDEEFF','#CCBBAA'][i]}));
  const world = createWorldStateV3({schemaVersion:3,seedVersion:'fixture',policyVersion:'fixture',revision:7,countriesById:Object.fromEntries(countries.map(c=>[c.id,c])),countryOrder:countries.map(c=>c.id),retiredCountryIds:new Set(),catalogRef:ref,
    territoryOrder:cells.map(c=>c.id),territoriesById:Object.fromEntries(cells.map(c=>[c.id,createTerritoryEntityV3({id:c.id,sourceCountryId:c.sourceCountryId,ownerCountryId:operation==='liberate'&&c.sourceCountryId==='BBB'?'AAA':c.sourceCountryId,controllerCountryId:c.sourceCountryId})]))},contract);
  const catalog: OperationalFrontierCatalog = {ref:contract.ref,cell:key => {const c=typeof key==='number'?cells[key-1]:cells.find(c=>c.id===key);if(!c)throw Error('UNKNOWN_OPERATIONAL_CELL');return c;},
    neighbors:n => n===9?[]:[...(n>1?[n-1]:[]),...(n<8?[n+1]:[])],
    cellMetrics:key => {const ordinal=typeof key==='number'?key:cells.find(c=>c.id===key)!.ordinal;return {centroid:[(ordinal-1)*.09,0],areaKm2:100,diameterKm:14};},
    sharedBoundary:(a,b)=>({edgeOrdinal:Math.min(a,b),start:[(a+b-2)*.045,-.04],end:[(a+b-2)*.045,.04]}),
    administrativeParents:[1,2].map(ordinal=>({ordinal,parentKey:`parent.${ordinal}`,sourceCountryId:ordinal===1?'AAA':'BBB',kind:'administrative',adminId:`${ordinal}`,name:`Province ${ordinal}`,sourceFeatureId:`${ordinal}`,sourceVersion:'fixture',restorationId:`${ordinal}`,residualId:null,start:ordinal===1?0:1,count:ordinal===1?1:7})),
    administrativeMembership:key=>key==='parent.1'?cells.slice(0,1):cells.slice(1,8),
  };
  const reference = {catalogId:ref.catalogVersion,sourceVersion:ref.geometryRoot,subdivisionId:'region:fixture:BBB:province'};
  const region = {ref:reference,parentCountryId:'BBB',nameKo:'접경도',nameEn:'Frontier Province',aliases:[],territoryIds:cells.slice(1,8).map(c=>c.id),provenanceIds:['fixture']};
  const index = createCatalogRegionIndex([region],cells.map(c=>c.id),contract.ref);
  const ground = {eventId:'event.ground',date:'2020-01-01',title:'분쟁',publicNarrative:'기존 분쟁',actorCountryIds:['AAA','BBB'],relatedFactIds:[],relatedSituationIds:[],causes:[],outcomeCategory:'military',significance:'notable'};
  const authority = {id:'tca:frontier',actorCountryId:'AAA',targetCountryId:'BBB',allowedTerritoryIds:operation==='transfer'?[cellId(1)]:region.territoryIds,allowedOperations:[operation],validFrom:'2020-01-01',validTo:null,sourceEventId:ground.eventId};
  const simulation = createSimulationStateV2({schemaVersion:2,revision:2,currentDate:'2020-01-01',turnNumber:0,playerCountryId:'AAA',queuedActions:[{actionId:'action.frontier',actorCountryId:'AAA',submittedAtDate:'2020-01-01',text:'접경 인근을 점령하고 다음 진격을 준비한다',visibility:'public',status:'queued'}],factsById:{},factOrder:[],situationsById:{},situationOrder:[],scheduledConsequences:[],eventLog:[ground],history:{lastCommittedTurnId:null,committedTurnCount:0},territorialControlAuthoritiesById:{[authority.id]:authority},territorialControlAuthorityOrder:[authority.id],countryPresentationAuthoritiesById:{},countryPresentationAuthorityOrder:[]},world);
  const context = buildSimulationContext({simulation,world,countrySearchProjection:createCountrySearchProjection(world),subdivisionCatalog:{listCountry:()=>[],inspect:()=>null,materialize:()=>null},scenarioId:'fixture',scenarioStartDate:'2020-01-01',targetDate:'2020-01-02'});
  const scope = {catalogRef:ref,baseWorldRevision:world.revision,...lookupArgs,operation};
  const selected = selectOperationalFrontier(catalog,world,scope,index);
  const effect = {effectId:'effect.frontier',type:operation==='transfer'?'territory.transferOwnership':`territory.${operation}`,causedByEventId:'event.advance',actorCountryId:'AAA',targetCountryId:'BBB',authorityId:authority.id,territoryIds:selected.cellIds,regionRefs:null,frontierScope:selected.scope,...operation==='transfer'?{newOwnerCountryId:'BBB',controllerPolicy:'new-owner'}:{}};
  const resolution = parseTurnResolutionV1({contractVersion:'turn-resolution.v1',baseSimulationRevision:simulation.revision,baseWorldRevision:world.revision,period:context.period,playerActionOutcomes:[{outcomeId:'outcome.frontier',actionId:'action.frontier',status:'succeeded',evidenceEventId:'event.advance',summary:'접경 일부 변경',remainingConditions:[]}],events:[{...ground,eventId:'event.advance',date:'2020-01-02',causes:[{kind:'queued-action',id:'action.frontier'}]}],factMutations:[],situationMutations:[],scheduledConsequences:[],worldEffects:[effect],advisorSummary:'접경 일부가 변경되었습니다.',unresolvedQuestions:[]});
  const frontier: OperationalFrontierValidation = {world,resolve:(current,request)=>selectOperationalFrontier(catalog,current,request,index)};
  const pair = {world,simulation,revisions:{worldRevision:world.revision,simulationRevision:simulation.revision}};
  const provider = (transport: OpenAIResponsesTransport,debugMode=false,ordinaryResponses=config.maxToolIterations) => new OpenAIResponsesSimulationProvider({...config,debugMode,maxToolIterations:ordinaryResponses},transport,{loadOperationalCatalog:()=>catalog,loadRegionIndex:actual=>{expect(actual).toEqual(contract.ref);return index;}});
  return {world,simulation,contract,catalog,index,region,context,selected,effect,resolution,frontier,pair,provider};
}

describe('16-07 provider lookup, submit and host scope validation', () => {
  it('reports a mistaken frontier region as a failed lookup and can recover using verified default scope', async () => {
    const f=fixture(),requests:OpenAIResponsesRequest[]=[];
    const transport:OpenAIResponsesTransport={async *stream(request){
      requests.push(request);
      const outputs=request.input.filter(v=>typeof v==='object'&&v!==null&&'type'in v&&v.type==='function_call_output') as {output:string}[];
      let response;
      if(requests.length===1)response=tools('bad-region','find_frontier_territories',{...lookupArgs,regionQuery:'휴전선'});
      else if(requests.length===2){
        const output=JSON.parse(outputs.at(-1)!.output);
        expect(output).toMatchObject({ok:false,data:{ok:false,code:'UNKNOWN_REGION'}});
        expect(output.data.recovery.condition).toContain('explicitly required');
        expect(output.data.recovery.retryArguments).toEqual(lookupArgs);
        expect(output.data).not.toHaveProperty('effectTarget');
        response=tools('retry-default','find_frontier_territories',output.data.recovery.retryArguments);
      }else{
        const output=JSON.parse(outputs.at(-1)!.output);
        expect(output).toMatchObject({ok:true,data:{ok:true}});
        expect(output.data.effectTarget.territoryIds).toEqual(f.selected.cellIds);
        response=tools('submit-recovered','submit_turn_resolution',{...f.resolution,worldEffects:[{...f.effect,...output.data.effectTarget}]});
      }
      for(const event of response)yield event;
    }};
    const events=await collect(f.provider(transport,false,2).streamTurn({turnId:'turn.region-recovery',context:f.context,operationalWorld:f.world},new AbortController().signal));
    expect(events.at(-1)?.type).toBe('resolution.ready');
    expect(requests).toHaveLength(3);
    expect(requests[0].instructions).toContain('regionQuery:null and reference:null');
    expect(requests[0].instructions).toContain('A tool/argument failure alone is not an in-world military defeat');
    expect(requests[0].instructions).toContain('military failure remains possible');
  });

  it('still accepts a grounded ordinary failed attempt without forcing a territorial effect', async () => {
    const f=fixture();
    const failed={...f.resolution,worldEffects:[],
      playerActionOutcomes:f.resolution.playerActionOutcomes.map(outcome=>({...outcome,status:'failed',summary:'기존 분쟁 상황에서 진격 시도가 저지되었습니다.'})),
      advisorSummary:'지리 대상과 별개로 군사적 시도가 실패했습니다.'};
    const events=await collect(f.provider({async *stream(){yield* tools('submit-failure','submit_turn_resolution',failed);}})
      .streamTurn({turnId:'turn.normal-failure',context:f.context,operationalWorld:f.world},new AbortController().signal));
    expect(events.at(-1)?.type).toBe('resolution.ready');
    const ready=events.at(-1);
    if(ready?.type==='resolution.ready')expect(ready.resolution.worldEffects).toEqual([]);
  });

  it('uses one lookup and one submit within the existing budget, then plans and atomically commits exact cells', async () => {
    const f=fixture(),requests:OpenAIResponsesRequest[]=[];
    const transport:OpenAIResponsesTransport={async *stream(request){requests.push(request);let events;
      if(requests.length===1) events=tools('lookup','find_frontier_territories',lookupArgs);
      else {const outputs=request.input.filter(v=>typeof v==='object'&&v!==null&&'type'in v&&v.type==='function_call_output') as {output:string}[];const data=JSON.parse(outputs.at(-1)!.output).data;
        expect(data.ok).toBe(true);expect(data.effectTarget.frontierScope).toMatchObject({baseWorldRevision:7,actorCountryId:'AAA',targetCountryId:'BBB',operation:'occupy'});
        events=tools('submit','submit_turn_resolution',{...f.resolution,worldEffects:[{...f.effect,...data.effectTarget}]});}
      for(const event of events)yield event;
    }};
    const post=createSimulationTurnPost({createProvider:()=>f.provider(transport),resolveOperationalWorld:()=>f.world});
    const response=await post(new Request('http://localhost/api/simulation/turn',{method:'POST',body:JSON.stringify({turnId:'turn.frontier',context:f.context})}));
    const events=(await response.text()).trim().split('\n').map(line=>JSON.parse(line));
    const ready=events.find(e=>e.type==='resolution.ready');expect(ready,JSON.stringify(events)).toBeDefined();
    expect(requests).toHaveLength(2);expect(requests[1].tool_choice).toEqual({type:'function',name:'submit_turn_resolution'});
    expect(JSON.stringify(requests[0].input)).not.toContain('territoriesById');
    const runtime=createCatalogRuntime(f.pair,f.contract);let notifications=0;runtime.store.subscribe(()=>notifications++);
    const plan=createCatalogTurnPlan({...f.pair,turnId:'turn.frontier',catalog:f.contract,resolution:ready.resolution,regionIndex:f.index,frontier:f.frontier});
    const next=runtime.commit(plan);expect(notifications).toBe(1);expect(f.selected.cellIds.length).toBeLessThan(f.region.territoryIds.length);
    for(const id of f.world.territoryOrder){expect(next.world.territoriesById[id].ownerCountryId).toBe(f.world.territoriesById[id].ownerCountryId);expect(next.world.territoriesById[id].controllerCountryId).toBe(f.selected.cellIds.includes(id)?'AAA':f.world.territoriesById[id].controllerCountryId);}
    expect(runtime.undo().world.territoriesById[f.selected.cellIds[0]].controllerCountryId).toBe('BBB');
    expect(runtime.redo().world.territoriesById[f.selected.cellIds[0]].controllerCountryId).toBe('AAA');
  });

  it('repairs a whole-region substitution after lookup without increasing lookup or submit budgets', async () => {
    const f=fixture(),requests:OpenAIResponsesRequest[]=[];
    const provider=f.provider({async *stream(request){requests.push(request);const events=requests.length===1?tools('lookup','find_frontier_territories',lookupArgs):requests.length===2?tools('bad','submit_turn_resolution',{...f.resolution,worldEffects:[{...f.effect,territoryIds:[],regionRefs:[{countryId:'BBB',reference:f.region.ref}],frontierScope:null}]}):tools('fixed','submit_turn_resolution',f.resolution);for(const e of events)yield e;}});
    const events=await collect(provider.streamTurn({turnId:'turn.repair',context:f.context,operationalWorld:f.world},new AbortController().signal));
    expect(events.at(-1)?.type).toBe('resolution.ready');expect(requests).toHaveLength(3);
    expect(JSON.stringify(requests[2].input)).toContain('FRONTIER_SCOPE_REQUIRED');
    expect(requests.slice(1).every(r=>JSON.stringify(r.tool_choice)===JSON.stringify({type:'function',name:'submit_turn_resolution'}))).toBe(true);
  });

  it('rejects scope removal, subsets, expansion, altered bindings, stale revisions and unknown IDs before mutation', () => {
    const f=fixture(),runtime=createCatalogRuntime(f.pair,f.contract);let notifications=0;runtime.store.subscribe(()=>notifications++);
    const badEffects=[
      {...f.effect,frontierScope:null},
      {...f.effect,territoryIds:f.selected.cellIds.slice(1)},
      {...f.effect,territoryIds:f.region.territoryIds},
      {...f.effect,territoryIds:[cellId(999)]},
      {...f.effect,regionRefs:[{countryId:'BBB',reference:f.region.ref}]},
      {...f.effect,actorCountryId:'CCC'}, {...f.effect,targetCountryId:'CCC'}, {...f.effect,type:'territory.liberate'},
      {...f.effect,frontierScope:{...f.selected.scope,baseWorldRevision:6}},
      {...f.effect,frontierScope:{...f.selected.scope,catalogRef:{...f.world.catalogRef,topologyRoot:'f'.repeat(64)}}},
    ];
    for(const effect of badEffects){const resolution={...f.resolution,worldEffects:[effect]};expect(validateResolutionAgainstContext(resolution,f.context,{regionIndex:f.index,frontier:f.frontier}).ok).toBe(false);
      expect(()=>createCatalogTurnPlan({...f.pair,turnId:'turn.invalid',catalog:f.contract,resolution,regionIndex:f.index,frontier:f.frontier})).toThrow();}
    expect(notifications).toBe(0);expect(runtime.getSnapshot().world).toBe(f.world);expect(runtime.getSnapshot().simulation).toBe(f.simulation);
    expect(()=>createCatalogTurnPlan({...f.pair,turnId:'turn.no-resolver',catalog:f.contract,resolution:f.resolution})).toThrow('FRONTIER_RESOLVER_REQUIRED');
    const changedScope={...f.resolution,worldEffects:[{...f.effect,frontierScope:{...f.selected.scope,extent:'limited'}}]};
    expect(validateResolutionAgainstContext(changedScope,f.context,{regionIndex:f.index,frontier:{...f.frontier,issuedScopes:[f.selected.scope]}}).issues[0].message).toBe('FRONTIER_SELECTION_NOT_LOOKED_UP');
  });

  it('requires a successful lookup in this provider session, and refuses missing or stale host world before API work', async () => {
    const f=fixture(),requests:OpenAIResponsesRequest[]=[];
    const provider=f.provider({async *stream(request){requests.push(request);for(const e of tools(`submit.${requests.length}`,'submit_turn_resolution',f.resolution))yield e;}});
    const events=await collect(provider.streamTurn({turnId:'turn.no-lookup',context:f.context,operationalWorld:f.world},new AbortController().signal));
    expect(events.at(-1)).toMatchObject({type:'turn.failed',code:'REPAIR_FAILED'});expect(JSON.stringify(requests[1].input)).toContain('FRONTIER_SELECTION_NOT_LOOKED_UP');
    const count=requests.length;
    expect((await collect(provider.streamTurn({turnId:'turn.no-world',context:f.context},new AbortController().signal))).at(-1)).toMatchObject({type:'turn.failed',message:'FRONTIER_WORLD_REQUIRED'});
    expect((await collect(provider.streamTurn({turnId:'turn.stale-world',context:f.context,operationalWorld:{...f.world,revision:6}},new AbortController().signal))).at(-1)).toMatchObject({type:'turn.failed',message:'STALE_FRONTIER_REVISION'});
    expect(requests).toHaveLength(count);
    expect(executeReadOnlySimulationTool('find_border_territories',{countryId:'BBB',neighborCountryId:'AAA',cap:512},f.context,f.index)).toMatchObject({ok:false,code:'USE_CURRENT_FRONTIER_LOOKUP'});
  });

  it('enforces the combined 512 change cap across effects rather than allowing a split batch', () => {
    const f=fixture(),ids=Array.from({length:300},(_,i)=>cellId(i+1));
    const world={...f.world,territoriesById:Object.fromEntries(ids.map(id=>[id,createTerritoryEntityV3({id,sourceCountryId:'BBB',ownerCountryId:'BBB',controllerCountryId:'BBB'})]))};
    const resolution=parseTurnResolutionV1({...f.resolution,worldEffects:[1,2].map(n=>({...f.effect,effectId:`effect.${n}`,territoryIds:ids}))});
    expect(()=>validateOperationalFrontierEffects(resolution,world,{world,resolve:()=>({...f.selected,cellIds:ids})})).toThrow('FRONTIER_AGGREGATE_CAP');
  });

  it('preserves authority and production DEBUG restrictions while scope validation remains mandatory', () => {
    const f=fixture();
    const context={...f.context,territorialControlAuthorities:[]};
    expect(validateResolutionAgainstContext(f.resolution,context,{regionIndex:f.index,frontier:f.frontier}).ok).toBe(false);
    const debug={...context,queuedActions:context.queuedActions.map(a=>({...a,text:`[DEBUG_WORLD_EFFECT] ${a.text}`}))};
    const options={regionIndex:f.index,frontier:f.frontier,debugWorldEffectActionIds:new Set(['action.frontier'])};
    const previous=process.env.NODE_ENV;
    try{Reflect.set(process.env,'NODE_ENV','test');expect(validateResolutionAgainstContext(f.resolution,debug,options).ok).toBe(true);
      expect(validateResolutionAgainstContext({...f.resolution,worldEffects:[{...f.effect,territoryIds:f.region.territoryIds}]},debug,options).ok).toBe(false);
      Reflect.set(process.env,'NODE_ENV','production');expect(validateResolutionAgainstContext(f.resolution,debug,options).ok).toBe(false);
    }finally{if(previous===undefined)Reflect.deleteProperty(process.env,'NODE_ENV');else Reflect.set(process.env,'NODE_ENV',previous);}
  });

  it.each(['liberate','transfer'] as const)('binds and plans %s with its original owner/controller semantics', operation => {
    const f=fixture(operation);
    expect(validateResolutionAgainstContext(f.resolution,f.context,{regionIndex:f.index,frontier:f.frontier}).ok).toBe(true);
    const plan=createCatalogTurnPlan({...f.pair,turnId:`turn.${operation}`,catalog:f.contract,resolution:f.resolution,regionIndex:f.index,frontier:f.frontier});
    for(const id of f.selected.cellIds){const after=plan.nextWorldState.territoriesById[id];expect(after.ownerCountryId).toBe(operation==='transfer'?'BBB':'AAA');expect(after.controllerCountryId).toBe(after.ownerCountryId);}
  });

  it('accepts current state only from the host dependency, never a JSON world supplied by a caller', async () => {
    const f=fixture();let created=0;
    const make=()=>{created++;return f.provider({async *stream(){yield* [];}});};
    const request=(extra={})=>new Request('http://localhost/api/simulation/turn',{method:'POST',body:JSON.stringify({turnId:'turn.route',context:f.context,...extra})});
    expect((await createSimulationTurnPost({createProvider:make})(request())).status).toBe(409);
    expect((await createSimulationTurnPost({createProvider:make,resolveOperationalWorld:()=>({...f.world,revision:6})})(request())).status).toBe(409);
    expect((await createSimulationTurnPost({createProvider:make,resolveOperationalWorld:()=>f.world})(request({operationalWorld:f.world}))).status).toBe(400);
    expect(created).toBe(0);
  });

  it('keeps new lookup and submit scope JSON schemas strict, including required nullable properties', () => {
    const manifest=createSimulationToolManifest({operational:true});
    expect(manifest.some(t=>t.name==='find_frontier_territories')).toBe(true);expect(manifest.some(t=>t.name==='find_border_territories')).toBe(false);
    const lookup=manifest.find(t=>t.name==='find_frontier_territories')!;
    expect(lookup.parameters.required).toEqual(Object.keys(lookup.parameters.properties as object));
    let scopes=0;
    const walk=(value:unknown)=>{if(Array.isArray(value)){value.forEach(walk);return;}if(!value||typeof value!=='object')return;
      const obj=value as {properties?:Record<string,unknown>;required?:string[];additionalProperties?:boolean};
      if(obj.properties?.extent&&obj.properties?.baseWorldRevision){scopes++;expect(obj.additionalProperties).toBe(false);expect([...(obj.required??[])].sort()).toEqual(Object.keys(obj.properties).sort());}
      Object.values(value).forEach(walk);
    };
    walk(manifest.find(t=>t.name==='submit_turn_resolution')!.parameters);expect(scopes).toBeGreaterThan(0);
    expect(JSON.stringify(manifest)).not.toContain('"oneOf"');expect(JSON.stringify(manifest)).not.toContain('"allOf"');
  });
});
