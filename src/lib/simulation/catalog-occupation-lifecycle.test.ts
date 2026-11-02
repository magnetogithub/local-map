import {beforeAll,describe,it,expect,vi} from 'vitest';import fs from 'node:fs';
import * as serializer from '../world/canonical-serializer';import * as worldModule from '../world/world-state-v3';
import {prepareProductionCatalogSeed} from '../world/production-catalog-seed.server';import {readCatalogConsumerMetadata} from '../map/catalog-consumer-contract';import {catalogContractForConsumer} from '../projection/catalog-map-consumer-projection';
import {readCatalogRuntimePair,createCatalogRuntime,type CatalogRuntimePair} from './catalog-runtime';import {createSimulationStateV2} from './simulation-state-v2';import {createCatalogTurnPlan} from './catalog-turn-plan';import {worldV3RuntimeContentHash} from '../world/world-v3-runtime-hash';
import {buildSimulationContext,parseSimulationContextV1,serializeSimulationContext} from './simulation-context';
import {createCountrySearchProjection} from '../projection/country-search-index-patch';
import {validateResolutionAgainstContext} from './server/context-resolution-validator';
import {createCommittedTurnReport} from './client/turn-report';
import {createNewsProjection} from '../game-ui/news-projection';
import {createCatalogProjectionUpdater} from '../projection/catalog-color-projection';
let seed:CatalogRuntimePair,catalog:ReturnType<typeof catalogContractForConsumer>,ids:string[];
beforeAll(()=>{const p=prepareProductionCatalogSeed();catalog=catalogContractForConsumer(readCatalogConsumerMetadata(JSON.parse(fs.readFileSync(`public${p.bootstrap.metadata.path}`,'utf8')),p.bootstrap.catalogRef));seed=readCatalogRuntimePair(p.serializedPair,catalog);ids=seed.world.territoryOrder.filter(id=>seed.world.territoriesById[id].ownerCountryId==='CHN').slice(0,3);});
const event=(id='event.operation',date='2020-01-02')=>({eventId:id,date,title:'영토 변경',publicNarrative:'검증된 영토 변경',actorCountryIds:['CHN','KOR'],relatedFactIds:[],relatedSituationIds:[],causes:[{kind:'authoritative-event',id:'event.ground'}],outcomeCategory:'military',significance:'notable'});
const ground=()=>({...event('event.ground','2020-01-01'),causes:[]});
const authority=(actor='KOR',target='CHN',operations=['occupy'])=>({id:'tca:scope',actorCountryId:actor,targetCountryId:target,allowedTerritoryIds:ids,allowedOperations:operations,validFrom:'2020-01-01',validTo:null,sourceEventId:'event.ground'});
const pair=()=>({...seed,simulation:createSimulationStateV2({...seed.simulation,playerCountryId:'KOR',eventLog:[ground()],territorialControlAuthoritiesById:{'tca:scope':authority()},territorialControlAuthorityOrder:['tca:scope']},seed.world)});
const resolution=(p:CatalogRuntimePair,effects:unknown[]=[],events:unknown[]=[event()])=>({contractVersion:'turn-resolution.v1',baseSimulationRevision:p.simulation.revision,baseWorldRevision:p.world.revision,period:{startDate:p.simulation.currentDate,endDate:'2020-01-02'},playerActionOutcomes:[],events,factMutations:[],situationMutations:[],scheduledConsequences:[],worldEffects:effects,advisorSummary:'검증 결과',unresolvedQuestions:[]});
const occupy=()=>({effectId:'effect.occupy',causedByEventId:'event.operation',type:'territory.occupy',actorCountryId:'KOR',targetCountryId:'CHN',authorityId:'tca:scope',territoryIds:ids});
describe('14-12 aggregate effects and authority lifecycle',()=>{
  it('commits only causally marked development occupation without an existing authority and restores it on undo',()=>{
    const action={actionId:'action.debug',actorCountryId:'KOR',submittedAtDate:'2020-01-01',text:'[DEBUG_WORLD_EFFECT] 접경 지역 점령',visibility:'public',status:'queued'};
    const p={...seed,simulation:createSimulationStateV2({...seed.simulation,playerCountryId:'KOR',queuedActions:[action]},seed.world)};
    const e={...event(),causes:[{kind:'queued-action',id:action.actionId}]},effect={...occupy(),authorityId:'tca:debug'};
    const r={...resolution(p,[effect],[e]),playerActionOutcomes:[{outcomeId:'outcome.debug',actionId:action.actionId,status:'succeeded',evidenceEventId:e.eventId,summary:'접경 지역 점령',remainingConditions:[]}]};
    const previous=process.env.NODE_ENV;
    try {
      Reflect.set(process.env,'NODE_ENV','test');
      const runtime=createCatalogRuntime(p,catalog),next=runtime.commit(createCatalogTurnPlan({...p,turnId:'turn.debug',catalog,resolution:r}));
      expect(next.world.territoriesById[ids[0]].ownerCountryId).toBe('CHN');
      expect(next.world.territoriesById[ids[0]].controllerCountryId).toBe('KOR');
      expect(next.simulation.territorialControlAuthorityOrder).toEqual([]);
      expect(runtime.undo().world.territoriesById[ids[0]].controllerCountryId).toBe('CHN');
      const unmarked={...p,simulation:createSimulationStateV2({...p.simulation,queuedActions:[{...action,text:'접경 지역 점령'}]},p.world)};
      expect(()=>createCatalogTurnPlan({...unmarked,turnId:'turn.unmarked',catalog,resolution:r})).toThrow('INVALID_AUTHORITY');
      const invalid={...r,worldEffects:[effect,{...effect,effectId:'effect.invalid',territoryIds:[`territory:catalog:${'0'.repeat(64)}`]}]};
      expect(()=>createCatalogTurnPlan({...p,turnId:'turn.invalid',catalog,resolution:invalid})).toThrow();
      expect(runtime.getSnapshot().world.territoriesById[ids[0]].controllerCountryId).toBe('CHN');
      Reflect.set(process.env,'NODE_ENV','production');
      expect(()=>createCatalogTurnPlan({...p,turnId:'turn.production',catalog,resolution:r})).toThrow('INVALID_AUTHORITY');
    } finally {if(previous===undefined)Reflect.deleteProperty(process.env,'NODE_ENV');else Reflect.set(process.env,'NODE_ENV',previous);}
  });
  it('continues a second turn after narrative undo/redo with current search/panel revision and shared entries',()=>{
    const p=pair(),runtime=createCatalogRuntime(p,catalog),metadata=readCatalogConsumerMetadata(JSON.parse(fs.readFileSync(`public/data/territory-catalog/${p.world.catalogRef.catalogVersion}/consumer-metadata.json`,'utf8')),p.world.catalogRef),project=createCatalogProjectionUpdater(metadata),initial=project(p.world);
    runtime.commit(createCatalogTurnPlan({...p,turnId:'turn.narrative',catalog,resolution:resolution(p,[],[])}));runtime.undo();const redo=runtime.redo(),projection=project(redo.world);
    expect(projection.search.entriesById).toBe(initial.search.entriesById);expect(projection.search.revision).toBe(redo.world.revision);expect(projection.panel.appliedRevision).toBe(redo.world.revision);
    expect(()=>buildSimulationContext({simulation:redo.simulation,world:redo.world,countrySearchProjection:projection.search,subdivisionCatalog:{listCountry:()=>[],inspect:()=>null,materialize:()=>null},scenarioId:'2020-otl',scenarioStartDate:'2020-01-01',targetDate:'2020-01-03'})).not.toThrow();
  });
  it('hashes only three changed mutable leaves during commit and reuses restored roots without full world serialization',()=>{
    const p=pair(),runtime=createCatalogRuntime(p,catalog);worldV3RuntimeContentHash(p.world);
    const encode=vi.spyOn(serializer,'canonicalSerialize'),full=vi.spyOn(worldModule,'worldStateV3ContentHash'),serialize=vi.spyOn(worldModule,'serializeWorldStateV3');
    try{const plan=createCatalogTurnPlan({...p,turnId:'turn.incremental-hash',catalog,resolution:resolution(p,[occupy()])});runtime.commit(plan);runtime.undo();runtime.redo();
      expect(full).not.toHaveBeenCalled();expect(serialize).not.toHaveBeenCalled();
      const leaves=encode.mock.calls.filter(([value])=>typeof value==='object'&&value!==null&&'namespace'in value&&value.namespace==='world-v3-runtime-leaf.v1');expect(leaves).toHaveLength(3);
      expect(encode.mock.calls.some(([value])=>typeof value==='object'&&value!==null&&'schemaVersion'in value&&value.schemaVersion===3)).toBe(false);
    }finally{encode.mockRestore();full.mockRestore();serialize.mockRestore();}
  });
  it('connects bounded actual context authorities, server validation and committed occupation news/results',()=>{
    const p=pair(),context=buildSimulationContext({simulation:p.simulation,world:p.world,countrySearchProjection:createCountrySearchProjection(p.world),subdivisionCatalog:{listCountry:()=>[],inspect:()=>null,materialize:()=>null},scenarioId:'2020-otl',scenarioStartDate:'2020-01-01',targetDate:'2020-01-02'});
    expect(parseSimulationContextV1(context).territorialControlAuthorities).toHaveLength(1);expect(serializeSimulationContext(context)).not.toMatch(/"(?:coordinates|FeatureCollection|topology|geometry)"\s*:/);
    const r=resolution(p,[occupy()]);expect(validateResolutionAgainstContext(r,context).ok).toBe(true);
    expect(validateResolutionAgainstContext(resolution(p,[{...occupy(),authorityId:'tca:unknown'}]),context).ok).toBe(false);
    const plan=createCatalogTurnPlan({...p,turnId:'turn.news',catalog,resolution:r}),report=createCommittedTurnReport(plan),news=createNewsProjection({simulation:plan.nextSimulationState,report,selectedEventId:'event.operation',acknowledgedEventIds:new Set()});
    expect(report.mapChanges.join(' ')).toContain('3개 영토');expect(news.selected?.mapChangeAvailable).toBe(true);expect(news.turnResult?.mapChanges).toEqual(report.mapChanges);
  });
  it('commits partial occupation once, shares untouched entities and restores pair/authorities through undo/redo',()=>{
    const p=pair(),runtime=createCatalogRuntime(p,catalog),seen:CatalogRuntimePair[]=[];runtime.store.subscribe(v=>seen.push(v));const plan=createCatalogTurnPlan({...p,turnId:'turn.occupy',catalog,resolution:resolution(p,[occupy()])});
    const next=runtime.commit(plan);expect(seen).toHaveLength(1);expect(plan.changeSummary.changedTerritoryIds).toEqual(ids);expect(plan.compiledWorldEffects.commandCount).toBe(1);
    for(const id of ids){expect(next.world.territoriesById[id].ownerCountryId).toBe('CHN');expect(next.world.territoriesById[id].controllerCountryId).toBe('KOR');}
    const unaffected=seed.world.territoryOrder.find(id=>!ids.includes(id))!;expect(next.world.territoriesById[unaffected]).toBe(p.world.territoriesById[unaffected]);expect(next.world.countriesById).toBe(p.world.countriesById);expect(next.world.catalogRef).toBe(p.world.catalogRef);
    expect(runtime.undo().world.territoriesById[ids[0]].controllerCountryId).toBe('CHN');const redo=runtime.redo();expect(redo.world.territoriesById[ids[0]].controllerCountryId).toBe('KOR');expect(redo.simulation.territorialControlAuthoritiesById).toEqual(next.simulation.territorialControlAuthoritiesById);
    expect(worldV3RuntimeContentHash(runtime.undo().world)).toBe(worldV3RuntimeContentHash(p.world));
  });
  it('rejects missing authority, invalid aggregate tail and tampered commits without partial state or notifications',()=>{
    const p=pair(),runtime=createCatalogRuntime(p,catalog);let notifications=0;runtime.store.subscribe(()=>notifications++);
    const bad={...occupy(),effectId:'effect.bad',authorityId:'tca:unknown'};expect(()=>createCatalogTurnPlan({...p,turnId:'turn.bad',catalog,resolution:resolution(p,[occupy(),bad])})).toThrow();expect(runtime.getSnapshot().world).toBe(p.world);expect(notifications).toBe(0);
    const plan=createCatalogTurnPlan({...p,turnId:'turn.good',catalog,resolution:resolution(p,[occupy()])});expect(()=>runtime.commit({...plan,afterWorldHash:'0'.repeat(64)})).toThrow();expect(runtime.getSnapshot().simulation).toBe(p.simulation);
  });
  it('expires active authorities with typed history, preserves historical grant event and restores expiry on undo',()=>{
    const p=pair();p.simulation=createSimulationStateV2({...p.simulation,territorialControlAuthoritiesById:{'tca:scope':{...authority(),validTo:'2020-01-01'}}},p.world);
    const runtime=createCatalogRuntime(p,catalog),next=runtime.commit(createCatalogTurnPlan({...p,turnId:'turn.expiry',catalog,resolution:resolution(p,[],[])}));expect(next.simulation.territorialControlAuthorityOrder).toEqual([]);expect(next.simulation.eventLog[0]).toEqual(ground());expect(next.simulation.eventLog.at(-1)?.authorityLifecycle?.operation).toBe('expired');expect(runtime.undo().simulation.territorialControlAuthorityOrder).toEqual(['tca:scope']);
  });
  it('allows a grounded bounded same-turn grant but rejects self-issued ungrounded grants and historical lifecycle reuse',()=>{
    const p=pair();p.simulation=createSimulationStateV2({...p.simulation,territorialControlAuthoritiesById:{},territorialControlAuthorityOrder:[]},p.world);
    const grant={effectId:'effect.grant',causedByEventId:'event.operation',type:'territorialAuthority.granted',authority:{...authority(),validFrom:'2020-01-02',sourceEventId:'event.operation'}};
    const plan=createCatalogTurnPlan({...p,turnId:'turn.grant',catalog,resolution:resolution(p,[grant,occupy()])});expect(plan.nextWorldState.territoriesById[ids[0]].controllerCountryId).toBe('KOR');expect(plan.nextSimulationState.eventLog.some(e=>e.authorityLifecycle?.operation==='granted')).toBe(true);
    expect(()=>createCatalogTurnPlan({...p,turnId:'turn.ungrounded',catalog,resolution:resolution(p,[grant],[{...event(),causes:[]}])})).toThrow(/GRANT/);
    expect(()=>createCatalogTurnPlan({...p,turnId:'turn.forge',catalog,resolution:resolution(p,[],[{...event(),authorityLifecycle:{authorityId:'tca:forge',operation:'granted',reason:'validated-turn-grant',previousActorCountryId:null,previousTargetCountryId:null}}])})).toThrow(/HOST_OWNED|Unrecognized key/);
  });
  it('keeps merge initiator AUT identity, rewrites actual player/action/reference fields and invalidates self authority',()=>{
    const world=seed.world,source={...ground(),actorCountryIds:['AUT','HUN','CHN']},a={...authority('HUN','CHN'),id:'tca:safe'},self={...authority('HUN','AUT'),id:'tca:self',allowedTerritoryIds:world.territoryOrder.filter(id=>world.territoriesById[id].ownerCountryId==='AUT').slice(0,1)};
    const simulation=createSimulationStateV2({...seed.simulation,playerCountryId:'HUN',eventLog:[source],queuedActions:[{actionId:'action.merge',actorCountryId:'HUN',submittedAtDate:'2020-01-01',text:'합병 협상',visibility:'public',status:'queued'}],
      factsById:{'fact.treaty':{factId:'fact.treaty',kind:'treaty-or-negotiation',actorCountryIds:['AUT','HUN'],publicSummary:'협상',startDate:'2020-01-01',status:'active',sourceEventId:source.eventId}},factOrder:['fact.treaty'],
      situationsById:{'situation.merge':{situationId:'situation.merge',type:'unification-negotiation',participantCountryIds:['AUT','HUN'],stage:'협상',stakes:'통합',startedByEventId:source.eventId,lastUpdatedByEventId:source.eventId,unresolvedQuestion:'합병 여부',status:'active'}},situationOrder:['situation.merge'],
      scheduledConsequences:[{consequenceId:'consequence.merge',earliestDate:'2020-01-02',deadlineDate:null,actorCountryIds:['AUT','HUN'],situationId:'situation.merge',triggerSummary:'협상 결과',sourceEventId:source.eventId,status:'scheduled'}],
      territorialControlAuthoritiesById:{[a.id]:a,[self.id]:self},territorialControlAuthorityOrder:[a.id,self.id]},world);
    const p={...seed,simulation},mergeEvent={...event(),actorCountryIds:['AUT','HUN'],outcomeCategory:'treaty'},r={...resolution(p,[{effectId:'effect.merge',causedByEventId:'event.operation',type:'countries.merged',initiatorCountryId:'AUT',absorbedCountryIds:['HUN']}],[mergeEvent]),playerActionOutcomes:[{outcomeId:'outcome.merge',actionId:'action.merge',status:'succeeded',evidenceEventId:mergeEvent.eventId,summary:'합병',remainingConditions:[]}]};
    const runtime=createCatalogRuntime(p,catalog),plan=createCatalogTurnPlan({...p,turnId:'turn.merge',catalog,resolution:r}),next=runtime.commit(plan);
    expect(next.world.countriesById.AUT).toBe(world.countriesById.AUT);expect(next.world.countriesById.HUN).toBeUndefined();expect(next.world.retiredCountryIds.has('HUN' as never)).toBe(true);expect(next.simulation.playerCountryId).toBe('AUT');expect(next.simulation.queuedActions[0].actorCountryId).toBe('AUT');
    expect(next.simulation.factsById['fact.treaty'].status).toBe('ended');expect(next.simulation.situationsById['situation.merge'].status).toBe('resolved');expect(next.simulation.scheduledConsequences[0].status).toBe('cancelled');expect(next.simulation.eventLog[0]).toEqual(source);
    expect(next.simulation.territorialControlAuthoritiesById['tca:safe'].actorCountryId).toBe('AUT');expect(next.simulation.territorialControlAuthoritiesById['tca:self']).toBeUndefined();expect(next.simulation.eventLog.some(e=>e.authorityLifecycle?.reason==='self-reference')).toBe(true);
    expect(runtime.undo().simulation.playerCountryId).toBe('HUN');expect(runtime.redo().simulation.playerCountryId).toBe('AUT');
  });
  it('dissolves to a successor while preserving third-party control and rejects retiring the player without a successor',()=>{
    const p=pair(),r=resolution(p,[occupy(),{effectId:'effect.dissolve',causedByEventId:'event.operation',type:'country.dissolved',countryId:'CHN',successorCountryId:'USA'}]);const plan=createCatalogTurnPlan({...p,turnId:'turn.dissolve',catalog,resolution:r});expect(plan.nextWorldState.countriesById.CHN).toBeUndefined();expect(plan.nextWorldState.territoriesById[ids[0]].ownerCountryId).toBe('USA');expect(plan.nextWorldState.territoriesById[ids[0]].controllerCountryId).toBe('KOR');
    expect(()=>createCatalogTurnPlan({...p,turnId:'turn.no-player',catalog,resolution:resolution(p,[{effectId:'effect.no-player',causedByEventId:'event.operation',type:'country.dissolved',countryId:'KOR',successorCountryId:null}])})).toThrow(/PLAYER_WITHOUT/);
  });
});
