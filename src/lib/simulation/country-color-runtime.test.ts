// @vitest-environment node
import fs from 'node:fs';
import {afterEach,beforeAll,describe,expect,it,vi} from 'vitest';
import {readCatalogConsumerMetadata,type CatalogConsumerMetadata} from '../map/catalog-consumer-contract';
import {catalogContractForConsumer,createCatalogMapConsumerProjection} from '../projection/catalog-map-consumer-projection';
import {updateCatalogColorProjection,createCatalogProjectionUpdater} from '../projection/catalog-color-projection';
import {createCatalogMapConsumer,type CatalogMapPort} from '../map/catalog-map-consumer';
import type {CatalogVectorDelivery} from '../map/catalog-vector-delivery';
import {createCatalogRuntime,readCatalogRuntimePair,type CatalogRuntimePair} from './catalog-runtime';
import {createCatalogTurnPlan} from './catalog-turn-plan';
import {createSimulationStateV2,MAX_COUNTRY_PRESENTATION_AUTHORITIES} from './simulation-state-v2';
import {transitionWorldStateV3} from '../world/world-state-v3';
import {allocateCountryMapColor,colorContrast,mapColorPresentation} from '../world/country-map-color';
import {buildSimulationContext} from './simulation-context';
import {validateResolutionAgainstContext} from './server/context-resolution-validator';
import type {TurnResolutionV1} from './turn-resolution';
import {validateTurnResolution} from './semantic-validator';
import {MAX_PRESENTATION_HISTORY_IDS} from './presentation-grant-validation';
import {parseSimulationContextV1} from './simulation-context';

function colorContext(pair:CatalogRuntimePair,endDate='2020-01-02'){
  const p=createCatalogMapConsumerProjection(pair.world,metadata);
  return parseSimulationContextV1(buildSimulationContext({world:pair.world,simulation:pair.simulation,countrySearchProjection:p.search,
    subdivisionCatalog:{listCountry:()=>[],inspect:()=>null,materialize:()=>null},scenarioId:'2020-otl',scenarioStartDate:'2020-01-01',targetDate:endDate}));
}
function grantedResolution(pair:CatalogRuntimePair,kind:'authoritative-event'|'scheduled-consequence'|'queued-action',id:string){
  const r=resolution(pair,'RUS','#CC0000');r.events[0].causes=[{kind,id}];
  if(kind==='queued-action')r.playerActionOutcomes=[{outcomeId:'outcome.color',actionId:id,status:'succeeded',evidenceEventId:'event.color',summary:'Color decision',remainingConditions:[]}];
  r.worldEffects.unshift({effectId:'effect.grant',causedByEventId:'event.color',type:'countryPresentationAuthority.granted',authority:{
    id:'cpa:color',actorCountryId:'RUS',targetCountryId:'RUS',allowedMapColors:['#CC0000'],validFrom:'2020-01-02',validTo:null,sourceEventId:'event.color'}});
  return r;
}
function pastPair(){
  return {...seed,simulation:createSimulationStateV2({...seed.simulation,playerCountryId:'RUS',eventLog:[event('event.past','RUS','2020-01-01')]},seed.world)};
}
function agree(pair:CatalogRuntimePair,r:TurnResolutionV1,ok:boolean){
  const server=validateResolutionAgainstContext(r,colorContext(pair,r.period.endDate));
  const local=validateTurnResolution(r,pair.simulation,pair.world);
  expect(server.ok,JSON.stringify(server.issues)).toBe(ok);expect(local.ok,JSON.stringify(local.issues)).toBe(ok);
  return server;
}

describe('Review F shared presentation authority regressions',()=>{
  it.each(['authority','reference'] as const)('rejects %s lifecycle evidence on server and local',kind=>{
    const source={...event('event.lifecycle','RUS','2020-01-01'),...(kind==='authority'?{
      authorityLifecycle:{authorityId:'cpa:old',operation:'expired' as const,reason:'date-expired' as const,previousActorCountryId:'RUS',previousTargetCountryId:'RUS'}}:{
      referenceLifecycle:{referenceId:'fact.old',kind:'fact' as const,operation:'ended' as const,reason:'retired-actor' as const}})};
    const pair={...seed,simulation:createSimulationStateV2({...seed.simulation,playerCountryId:'RUS',eventLog:[source]},seed.world)};
    agree(pair,grantedResolution(pair,'authoritative-event',source.eventId),false);
  });
  it('rejects a consequence due by turn end but after the grant event',()=>{
    const pair=pastPair();const simulation=createSimulationStateV2({...pair.simulation,scheduledConsequences:[{consequenceId:'consequence.future',earliestDate:'2020-01-03',deadlineDate:null,
      actorCountryIds:['RUS'],situationId:null,triggerSummary:'Future color mandate',sourceEventId:'event.past',status:'scheduled'}]},pair.world);
    const r=grantedResolution({...pair,simulation},'scheduled-consequence','consequence.future');r.period.endDate='2020-01-04';
    agree({...pair,simulation},r,false);
  });
  it.each(['scheduled','due','resolved','cancelled'] as const)('only accepts a pending/due consequence at causal date: %s',status=>{
    const pair=pastPair();const simulation=createSimulationStateV2({...pair.simulation,scheduledConsequences:[{consequenceId:'consequence.color',earliestDate:'2020-01-02',deadlineDate:null,
      actorCountryIds:['RUS'],situationId:null,triggerSummary:'Color mandate',sourceEventId:'event.past',status}]},pair.world);
    agree({...pair,simulation},grantedResolution({...pair,simulation},'scheduled-consequence','consequence.color'),status==='scheduled'||status==='due');
  });
  it('approves an actual past event and commits grant before color; rejects reverse order',()=>{
    vi.stubEnv('NODE_ENV','production');const pair=pastPair(),r=grantedResolution(pair,'authoritative-event','event.past');agree(pair,r,true);
    const runtime=createCatalogRuntime(pair,catalog);expect(runtime.commit(createCatalogTurnPlan({turnId:'turn.past',...pair,resolution:r,catalog})).world.countriesById.RUS.mapColor).toBe('#CC0000');
    agree(pair,{...r,worldEffects:[...r.worldEffects].reverse()},false);
  });
  it('approves an actual pending actor action, rejecting another actor or completed action',()=>{
    for(const [actor,status,ok] of [['RUS','queued',true],['AUT','queued',false],['RUS','resolved',false]] as const){
      const pending={actionId:'action.color',actorCountryId:actor,submittedAtDate:'2020-01-01',text:'Choose a new color',visibility:'public' as const,status};
      // Use the actual pending-status vocabulary for a completed action.
      const simulation=createSimulationStateV2({...seed.simulation,playerCountryId:actor,queuedActions:[pending]},seed.world);
      const pair={...seed,simulation},r=grantedResolution(pair,'queued-action','action.color');if(!ok&&status==='resolved')r.playerActionOutcomes=[];
      agree(pair,r,ok);
    }
  });
  it('rejects unknown and future authoritative sources in both adapters',()=>{
    const pair=pastPair();agree(pair,grantedResolution(pair,'authoritative-event','event.missing'),false);
    const future={...pair,simulation:{...pair.simulation,eventLog:[event('event.future','RUS','2020-01-03')]}};
    agree(future,grantedResolution(future,'authoritative-event','event.future'),false);
  });
  it('rejects expired ID reuse even when its lifecycle event is outside recentEvents',()=>{
    const pair=pastPair();const ended={...event('event.expired','RUS','2020-01-01'),authorityLifecycle:{authorityId:'cpa:color',operation:'expired' as const,reason:'date-expired' as const,previousActorCountryId:'RUS',previousTargetCountryId:'RUS'}};
    const simulation=createSimulationStateV2({...pair.simulation,eventLog:[ended,...Array.from({length:21},(_,i)=>event(`event.past.${String(i).padStart(2,'0')}`,'RUS','2020-01-01'))]},pair.world);
    const c=colorContext({...pair,simulation});expect(c.recentEvents.some(e=>(e as {eventId:string}).eventId===ended.eventId)).toBe(false);
    expect(c.presentationAuthorityHistory?.ids).toContain('cpa:color');
    agree({...pair,simulation},grantedResolution({...pair,simulation},'authoritative-event','event.past.20'),false);
  });
  it('rejects duplicate grants, authority collection overflow and bounded history exhaustion consistently',()=>{
    const pair=pastPair(),r=grantedResolution(pair,'authoritative-event','event.past');agree(pair,{...r,worldEffects:[r.worldEffects[0],{...r.worldEffects[0],effectId:'effect.duplicate'},r.worldEffects[1]]},false);
    const authorities=Object.fromEntries(Array.from({length:MAX_COUNTRY_PRESENTATION_AUTHORITIES},(_,i)=>{const id=`cpa:existing.${String(i).padStart(3,'0')}`;return [id,{id,actorCountryId:'RUS',targetCountryId:'RUS',allowedMapColors:['#CC0000'],validFrom:'2020-01-01',validTo:null,sourceEventId:'event.past'}];}));
    const simulation=createSimulationStateV2({...pair.simulation,countryPresentationAuthoritiesById:authorities,countryPresentationAuthorityOrder:Object.keys(authorities).sort()},pair.world);
    agree({...pair,simulation},grantedResolution({...pair,simulation},'authoritative-event','event.past'),false);
    for(const count of [MAX_PRESENTATION_HISTORY_IDS,MAX_PRESENTATION_HISTORY_IDS+1]){
      const history=Array.from({length:count},(_,i)=>({...event(`event.history.${i}`,'RUS','2020-01-01'),authorityLifecycle:{authorityId:`cpa:old.${i}`,operation:'expired' as const,reason:'date-expired' as const,previousActorCountryId:'RUS',previousTargetCountryId:'RUS'}}));
      const simulation=createSimulationStateV2({...pair.simulation,eventLog:[...history,event('event.zz','RUS','2020-01-01')]},pair.world);
      agree({...pair,simulation},grantedResolution({...pair,simulation},'authoritative-event','event.zz'),false);
    }
  });
  it('rejects mismatched actor/target/source/dates/colors in both validators',()=>{
    const pair=pastPair(),r=grantedResolution(pair,'authoritative-event','event.past'),grant=r.worldEffects[0];if(grant.type!=='countryPresentationAuthority.granted')throw new Error('fixture');
    for(const patch of [{targetCountryId:'AUT'},{actorCountryId:'AUT',targetCountryId:'AUT'},{sourceEventId:'event.past'},{validFrom:'2020-01-01'},{validTo:'2020-01-01'},{allowedMapColors:['#FFFFFF']},{allowedMapColors:['#cc0000']},{allowedMapColors:['#CC0000','#CC0000']}]){
      const bad={...r,worldEffects:[{...grant,authority:{...grant.authority,...patch}},r.worldEffects[1]]};
      expect(validateResolutionAgainstContext(bad,colorContext(pair)).ok).toBe(false);
      let accepted=false;try{accepted=validateTurnResolution(bad,pair.simulation,pair.world).ok;}catch{/* strict schema rejection */}expect(accepted).toBe(false);
    }
  });
});

describe('Review F real presentation intent allocation and atomic history',()=>{
  it.skipIf(!process.env.PROMPT14_COLOR_EVIDENCE)('validates captured production browser choice/debug responses against the server contract',()=>{
    const evidence=JSON.parse(fs.readFileSync(process.env.PROMPT14_COLOR_EVIDENCE!,'utf8'));
    expect(evidence.status).toBe('pass');expect(evidence.turns).toHaveLength(6);
    vi.stubEnv('NODE_ENV','production');
    for(const turn of evidence.turns){
      const context=parseSimulationContextV1(turn.context),server=validateResolutionAgainstContext(turn.resolution,context);
      expect(server.ok,JSON.stringify(server.issues)).toBe(turn.expectedValidation);
      if(server.ok){
        const effects=server.resolution!.worldEffects;expect(effects[0]).toMatchObject({type:'countryPresentationAuthority.granted',authority:{allowedMapColors:[turn.selectedColor]}});
        expect(effects[1]).toMatchObject({type:'country.changeMapColor',mapColor:turn.selectedColor});
      }
    }
  });
  it.each(['#cc0000',null])('commits explicit choice %s through server normalization and local atomic plan',requestedMapColor=>{
    vi.stubEnv('NODE_ENV','production');const pair=pastPair(),r=grantedResolution(pair,'authoritative-event','event.past');
    const g=r.worldEffects[0];if(g.type!=='countryPresentationAuthority.granted')throw new Error('fixture');
    const {allowedMapColors:ignored,...authority}=g.authority;void ignored;
    r.worldEffects=[{effectId:'effect.choose',causedByEventId:'event.color',type:'country.chooseMapColor',requestedMapColor,authority}];
    const c=colorContext(pair),server=validateResolutionAgainstContext(r,c);expect(server.ok,JSON.stringify(server.issues)).toBe(true);
    const reverse=validateResolutionAgainstContext(r,{...c,countryMapColors:[...c.countryMapColors!].reverse()});expect(reverse.resolution).toEqual(server.resolution);
    const plan=createCatalogTurnPlan({turnId:'turn.choice',...pair,resolution:r,catalog});expect(plan.resolution).toEqual(server.resolution);
    const selected=allocateCountryMapColor('RUS',Object.values(pair.world.countriesById).map(c=>c.mapColor),requestedMapColor??undefined);
    const runtime=createCatalogRuntime(pair,catalog),observer=vi.fn();runtime.store.subscribe(observer);const committed=runtime.commit(plan);
    expect(committed.world.countriesById.RUS.id).toBe('RUS');expect(committed.world.countriesById.RUS.mapColor).toBe(selected);
    expect(committed.simulation.countryPresentationAuthoritiesById['cpa:color'].allowedMapColors).toEqual([selected]);
    expect(plan.resolution.worldEffects[1]).toMatchObject({type:'country.changeMapColor',mapColor:selected,authorityId:'cpa:color'});
    expect(observer).toHaveBeenCalledTimes(1);expect(runtime.undo().world.countriesById.RUS.mapColor).toBe(pair.world.countriesById.RUS.mapColor);
    expect(runtime.redo().world.countriesById.RUS.mapColor).toBe(selected);
    const consumedRuntime=createCatalogRuntime(pair,catalog);expect(consumedRuntime.commit(createCatalogTurnPlan({turnId:'turn.normalized',...pair,resolution:server.resolution,catalog})).world.countriesById.RUS.mapColor).toBe(selected);
    if(requestedMapColor===null)expect(Object.values(pair.world.countriesById).map(c=>c.mapColor)).not.toContain(selected);
    const invalid={...r,worldEffects:[...r.worldEffects,{effectId:'effect.bad',causedByEventId:'event.color',type:'country.changeMapColor' as const,countryId:'AUT',actorCountryId:'RUS',authorityId:'cpa:color',mapColor:'#FFFFFF'}]};
    const rollback=createCatalogRuntime(pair,catalog),before=rollback.getSnapshot(),notify=vi.fn();rollback.store.subscribe(notify);
    expect(()=>rollback.commit(createCatalogTurnPlan({turnId:'turn.rollback',...pair,resolution:invalid,catalog}))).toThrow();expect(rollback.getSnapshot()).toBe(before);expect(notify).not.toHaveBeenCalled();
  });
  it('retains initiator seed color for a merger without explicit color intent',()=>{
    const pair=pastPair(),r=resolution(pair,'RUS','#CC0000');r.events=[{...event('event.merge','RUS'),outcomeCategory:'treaty',actorCountryIds:['RUS','AUT'],causes:[{kind:'authoritative-event',id:'event.past'}]}];
    r.worldEffects=[{effectId:'effect.merge',causedByEventId:'event.merge',type:'countries.merged',initiatorCountryId:'RUS',absorbedCountryIds:['AUT']}];
    agree(pair,r,true);const runtime=createCatalogRuntime(pair,catalog),after=runtime.commit(createCatalogTurnPlan({turnId:'turn.keep-color',...pair,resolution:r,catalog}));
    expect(after.world.countriesById.RUS.mapColor).toBe(pair.world.countriesById.RUS.mapColor);expect(after.world.countriesById.RUS.id).toBe('RUS');
    expect(after.simulation.countryPresentationAuthorityOrder).toEqual([]);expect(runtime.undo().world.countriesById.AUT).toBeDefined();expect(runtime.redo().world.countriesById.RUS.id).toBe('RUS');
  });
  it.each(['#ffffff',null])('merges with explicit presentation choice %s while preserving initiator identity and history',requestedMapColor=>{
    const base=pastPair(),simulation=createSimulationStateV2({...base.simulation,playerCountryId:'AUT',eventLog:[event('event.past','AUT','2020-01-01')]},base.world),pair={...base,simulation};
    const r=resolution(pair,'AUT','#FFFFFF');r.events=[{...event('event.merge','AUT'),actorCountryIds:['AUT','HUN'],outcomeCategory:'treaty',causes:[{kind:'authoritative-event',id:'event.past'}]}];
    r.worldEffects=[{effectId:'effect.merge',causedByEventId:'event.merge',type:'countries.merged',initiatorCountryId:'AUT',absorbedCountryIds:['HUN']},
      {effectId:'effect.choose',causedByEventId:'event.merge',type:'country.chooseMapColor',requestedMapColor,authority:{id:'cpa:merge',actorCountryId:'AUT',targetCountryId:'AUT',validFrom:'2020-01-02',validTo:null,sourceEventId:'event.merge'}}];
    const server=agree(pair,r,true),plan=createCatalogTurnPlan({turnId:'turn.merge-choice',...pair,resolution:server.resolution,catalog});
    const runtime=createCatalogRuntime(pair,catalog),after=runtime.commit(plan),selected=allocateCountryMapColor('AUT',Object.values(pair.world.countriesById).map(c=>c.mapColor),requestedMapColor??undefined);
    expect(after.world.countriesById.AUT.id).toBe('AUT');expect(after.simulation.playerCountryId).toBe('AUT');expect(after.world.countriesById.AUT.mapColor).toBe(selected);
    expect(after.world.countriesById.HUN).toBeUndefined();expect(after.simulation.countryPresentationAuthoritiesById['cpa:merge'].allowedMapColors).toEqual([selected]);
    expect(runtime.undo().world.countriesById.HUN).toBeDefined();expect(runtime.redo().world.countriesById.AUT.mapColor).toBe(selected);
  });
  it('cannot enlarge the host single-color grant or bypass evidence using a production debug directive',()=>{
    vi.stubEnv('NODE_ENV','production');const pair=pastPair(),r=grantedResolution(pair,'authoritative-event','event.past'),g=r.worldEffects[0];if(g.type!=='countryPresentationAuthority.granted')throw new Error('fixture');
    const {allowedMapColors:ignored,...authority}=g.authority;void ignored;
    const intent={effectId:'effect.choose',causedByEventId:'event.color',type:'country.chooseMapColor' as const,requestedMapColor:null,authority};
    expect(validateResolutionAgainstContext({...r,worldEffects:[{...intent,authority:{...authority,allowedMapColors:['#FFFFFF']}}]},colorContext(pair)).ok).toBe(false);
    const extra={effectId:'effect.extra',causedByEventId:'event.color',type:'country.changeMapColor' as const,actorCountryId:'RUS',countryId:'RUS',authorityId:'cpa:color',mapColor:'#FFFFFF'};
    agree(pair,{...r,worldEffects:[intent,extra]},false);
    const noEvidence={...r,events:[{...r.events[0],causes:[]}],worldEffects:[intent]};agree(pair,noEvidence,false);
    expect(()=>createCatalogTurnPlan({turnId:'turn.no-evidence',...pair,resolution:noEvidence,catalog})).toThrow(/UNGROUNDED/);
    const missingPalette=validateResolutionAgainstContext({...r,worldEffects:[intent]},{...colorContext(pair),countryMapColors:undefined});expect(missingPalette.ok).toBe(false);
  });
});

let seed:CatalogRuntimePair,metadata:CatalogConsumerMetadata,catalog:ReturnType<typeof catalogContractForConsumer>;
beforeAll(()=>{
  const freeze=JSON.parse(fs.readFileSync('data/catalogs/prompt14/frozen-catalog-ref.json','utf8'));
  metadata=readCatalogConsumerMetadata(JSON.parse(fs.readFileSync(`public/data/territory-catalog/${freeze.ref.catalogVersion}/consumer-metadata.json`,'utf8')),freeze.ref);
  catalog=catalogContractForConsumer(metadata);seed=readCatalogRuntimePair(fs.readFileSync(`data/catalogs/prompt14/${freeze.ref.catalogVersion}/migration-pair.json`,'utf8'),catalog);
});
afterEach(()=>vi.unstubAllEnvs());
const event=(id:string,countryId:string,date='2020-01-02')=>({eventId:id,date,title:'국가 색상 변경',publicNarrative:'새 국가 색상을 채택했습니다.',actorCountryIds:[countryId],relatedFactIds:[],relatedSituationIds:[],causes:[],outcomeCategory:'domestic' as const,significance:'notable' as const});
function authorized(countryId:string,color:string){
  const source=event('event.mandate',countryId,'2020-01-01');
  const simulation=createSimulationStateV2({...seed.simulation,playerCountryId:countryId,eventLog:[source],countryPresentationAuthoritiesById:{'cpa:color':{
    id:'cpa:color',actorCountryId:countryId,targetCountryId:countryId,allowedMapColors:[color],validFrom:'2020-01-01',validTo:null,sourceEventId:source.eventId}},countryPresentationAuthorityOrder:['cpa:color']},seed.world);
  return {...seed,simulation};
}
function resolution(pair:CatalogRuntimePair,countryId:string,color:string):TurnResolutionV1 {
  return {contractVersion:'turn-resolution.v1',baseSimulationRevision:pair.simulation.revision,baseWorldRevision:pair.world.revision,
    period:{startDate:pair.simulation.currentDate,endDate:'2020-01-02'},playerActionOutcomes:[],events:[event('event.color',countryId)],factMutations:[],situationMutations:[],scheduledConsequences:[],
    worldEffects:[{effectId:'effect.color',causedByEventId:'event.color',type:'country.changeMapColor',actorCountryId:countryId,countryId,mapColor:color,authorityId:'cpa:color'}],advisorSummary:'색상 변경이 적용되었습니다.',unresolvedQuestions:[]};
}
function mockMap(){
  const states=vi.fn(),sources=new Map<string,{setData:ReturnType<typeof vi.fn>;updateData:ReturnType<typeof vi.fn>}>(),layers=new Map();
  const map:CatalogMapPort={addSource:id=>sources.set(id,{setData:vi.fn(),updateData:vi.fn()}),removeSource:id=>sources.delete(id),getSource:id=>sources.get(id),
    addLayer:layer=>layers.set(layer.id,layer),removeLayer:id=>layers.delete(id),getLayer:id=>layers.get(id),setFeatureState:states,on:vi.fn(),off:vi.fn()};
  const delivery={metadata,source:{type:'vector',tiles:['https://example.test/{z}/{x}/{y}']},observeEdges:()=>()=>{}} as unknown as CatalogVectorDelivery;
  return {states,sources,layers,map,delivery};
}
describe('14-16 production color atomic commit, affected projection and history',()=>{
  it.each([['RUS','#CC0000'],['AUT','#FFFFFF']] as const)('applies %s %s and restores exact state/projection without source updates', (countryId,color)=>{
    vi.stubEnv('NODE_ENV','production');const pair=authorized(countryId,color),runtime=createCatalogRuntime(pair,catalog),m=mockMap(),consumer=createCatalogMapConsumer({...m,world:pair.world});
    consumer.selectCountry(countryId);consumer.hoverCountry(countryId);const initial=consumer.getProjection(),oldColor=pair.world.countriesById[countryId].mapColor;
    runtime.store.subscribe(next=>consumer.updateWorld(next.world));m.states.mockClear();
    const plan=createCatalogTurnPlan({turnId:'turn.color',world:pair.world,simulation:pair.simulation,resolution:resolution(pair,countryId,color),catalog});
    const after=runtime.commit(plan);expect(after.world.countriesById[countryId].mapColor).toBe(color);expect(after.world.catalogRef).toBe(pair.world.catalogRef);
    expect(after.world.territoriesById).toBe(pair.world.territoriesById);
    const affected=initial.presentedByCountry[countryId];
    expect(m.states.mock.calls.filter(([target])=>target.source==='world-territory-catalog').map(([target])=>target.id).sort()).toEqual([...affected].sort());
    for(const [,state]of m.states.mock.calls.filter(([t])=>t.source==='world-territory-catalog'))expect(state).toMatchObject({mapColor:color,selected:true,hover:true});
    const next=consumer.getProjection();for(const key of ['labels','capitals','territoryById','focusByCountryId'] as const)expect(next[key]).toBe(initial[key]);
    expect(next.search.entriesById).toBe(initial.search.entriesById);expect(next.search.revision).toBe(next.world.revision);expect(next.panel.inputById).toBe(initial.panel.inputById);expect(next.panel.appliedRevision).toBe(next.world.revision);
    const untouched=pair.world.territoryOrder.find(id=>!affected.includes(id))!;expect(next.featuresById[untouched]).toBe(initial.featuresById[untouched]);
    expect(runtime.undo().world.countriesById[countryId].mapColor).toBe(oldColor);expect(consumer.getProjection().featuresById[affected[0]].mapColor).toBe(oldColor);
    expect(runtime.redo().world.countriesById[countryId].mapColor).toBe(color);expect(consumer.getProjection().featuresById[affected[0]].mapColor).toBe(color);
    for(const s of m.sources.values()){expect(s.setData).not.toHaveBeenCalled();expect(s.updateData).not.toHaveBeenCalled();}
    const ink=mapColorPresentation(color);expect(colorContrast(color,ink.labelColor)).toBeGreaterThan(4.5);expect(colorContrast(color,ink.selectionColor)).toBeGreaterThan(4.5);
    consumer.dispose();
  });
  it('uses controller color and updates controlled foreign territory while leaving foreign-controlled owned territory alone',()=>{
    const rus=seed.world.territoryOrder.find(id=>seed.world.territoriesById[id].ownerCountryId==='RUS')!,aut=seed.world.territoryOrder.find(id=>seed.world.territoriesById[id].ownerCountryId==='AUT')!;
    const world=transitionWorldStateV3(seed.world,catalog,{territories:{[rus]:{...seed.world.territoriesById[rus],controllerCountryId:'AUT' as never},[aut]:{...seed.world.territoriesById[aut],controllerCountryId:'RUS' as never}}});
    const initial=createCatalogMapConsumerProjection(world,metadata),next=transitionWorldStateV3(world,catalog,{countries:{RUS:{...world.countriesById.RUS,mapColor:'#CC0000'}}});
    expect(initial.featuresById[rus].mapColor).toBe(world.countriesById.AUT.mapColor);
    const delta=updateCatalogColorProjection(initial,next)!;expect(delta.changedFeatureIds).toContain(aut);expect(delta.changedFeatureIds).not.toContain(rus);
    expect(delta.projection.featuresById[aut].mapColor).toBe('#CC0000');expect(delta.projection.featuresById[rus]).toBe(initial.featuresById[rus]);
  });
  it('rejects unauthorized production color, stale revision and mixed invalid effects without publishing any pair',()=>{
    vi.stubEnv('NODE_ENV','production');const pair=authorized('RUS','#CC0000'),runtime=createCatalogRuntime(pair,catalog),before=runtime.getSnapshot(),observer=vi.fn();runtime.store.subscribe(observer);
    for(const r of [{...resolution(pair,'RUS','#CC0000'),baseWorldRevision:999},resolution(pair,'RUS','#FFFFFF'),
      {...resolution(pair,'RUS','#CC0000'),worldEffects:[...resolution(pair,'RUS','#CC0000').worldEffects,{effectId:'bad',causedByEventId:'event.color',type:'country.changeMapColor',countryId:'AUT',actorCountryId:'RUS',mapColor:'#FFFFFF',authorityId:'cpa:color'}]}]){
      expect(()=>runtime.commit(createCatalogTurnPlan({turnId:'turn.bad',simulation:pair.simulation,world:pair.world,resolution:r,catalog}))).toThrow();expect(runtime.getSnapshot()).toBe(before);
    }expect(observer).not.toHaveBeenCalled();
    const project=createCatalogProjectionUpdater(metadata),a=project(pair.world),b=project(transitionWorldStateV3(pair.world,catalog,{countries:{RUS:{...pair.world.countriesById.RUS,mapColor:'#CC0000'}}}));expect(b.labels).toBe(a.labels);
  });
});

describe('14-17 authority, grants, identity and production/debug paths',()=>{
  it('grants and uses a bounded authority in a single normal production turn, with server/local agreement',()=>{
    vi.stubEnv('NODE_ENV','production');const runtime=createCatalogRuntime(seed,catalog);runtime.selectPlayer('RUS');runtime.replacePendingActions([{actionId:'action.color',actorCountryId:'RUS',submittedAtDate:'2020-01-01',text:'국가 색상을 빨간색으로 변경',visibility:'public',status:'queued'}]);
    const pair=runtime.getSnapshot(),r=resolution(pair,'RUS','#CC0000');r.events[0].causes=[{kind:'queued-action',id:'action.color'}];
    r.playerActionOutcomes=[{outcomeId:'outcome.color',actionId:'action.color',status:'succeeded',evidenceEventId:'event.color',summary:'색상 변경',remainingConditions:[]}];
    r.worldEffects.unshift({effectId:'effect.grant',causedByEventId:'event.color',type:'countryPresentationAuthority.granted',authority:{id:'cpa:color',actorCountryId:'RUS',targetCountryId:'RUS',allowedMapColors:['#CC0000'],validFrom:'2020-01-02',validTo:null,sourceEventId:'event.color'}});
    const p=createCatalogMapConsumerProjection(pair.world,metadata),context=buildSimulationContext({world:pair.world,simulation:pair.simulation,countrySearchProjection:p.search,subdivisionCatalog:{listCountry:()=>[],inspect:()=>null,materialize:()=>null},scenarioId:'2020-otl',scenarioStartDate:'2020-01-01',targetDate:'2020-01-02'});
    expect(validateResolutionAgainstContext(r,context).ok).toBe(true);
    const after=runtime.commit(createCatalogTurnPlan({turnId:'turn.grant',world:pair.world,simulation:pair.simulation,resolution:r,catalog}));
    expect(after.world.countriesById.RUS.mapColor).toBe('#CC0000');expect(after.simulation.countryPresentationAuthorityOrder).toEqual(['cpa:color']);
    expect(runtime.undo().simulation.countryPresentationAuthorityOrder).toEqual([]);expect(runtime.redo().simulation.countryPresentationAuthorityOrder).toEqual(['cpa:color']);
    const reversed={...r,worldEffects:[...r.worldEffects].reverse()};expect(validateResolutionAgainstContext(reversed,context).ok).toBe(false);
  });
  it('merge presentation explicitly changes the surviving initiator name/color without allocating another identity',()=>{
    const pair=authorized('AUT','#FFFFFF');const treaty={...event('event.treaty','AUT','2020-01-01'),actorCountryIds:['AUT','HUN'],outcomeCategory:'treaty' as const};
    const simulation=createSimulationStateV2({...pair.simulation,eventLog:[...pair.simulation.eventLog,treaty]},pair.world),r=resolution({...pair,simulation},'AUT','#FFFFFF');
    r.events=[{...event('event.merge','AUT'),actorCountryIds:['AUT','HUN'],outcomeCategory:'treaty',causes:[{kind:'authoritative-event',id:treaty.eventId}]}];
    r.worldEffects=[{effectId:'merge',causedByEventId:'event.merge',type:'countries.merged',initiatorCountryId:'AUT',absorbedCountryIds:['HUN']},
      {effectId:'rename',causedByEventId:'event.merge',type:'country.renamed',countryId:'AUT',displayName:'오스트리아-헝가리'},
      {...r.worldEffects[0],causedByEventId:'event.merge'}];
    const runtime=createCatalogRuntime({...pair,simulation},catalog),after=runtime.commit(createCatalogTurnPlan({turnId:'turn.merge',world:pair.world,simulation,resolution:r,catalog}));
    expect(after.world.countriesById.AUT.id).toBe('AUT');expect(after.world.countriesById.AUT.names.mapKo).toBe('오스트리아-헝가리');expect(after.world.countriesById.AUT.mapColor).toBe('#FFFFFF');
    expect(after.world.countriesById.HUN).toBeUndefined();expect(after.simulation.playerCountryId).toBe('AUT');expect(after.world.countryOrder).toHaveLength(pair.world.countryOrder.length-1);
    expect(runtime.undo().world.countriesById.HUN).toBeDefined();expect(runtime.redo().world.countriesById.AUT.mapColor).toBe('#FFFFFF');
  });
  it('a marked debug action waives only development authority, never production authority',()=>{
    const simulation=createSimulationStateV2({...seed.simulation,playerCountryId:'RUS',queuedActions:[{actionId:'action.debug',actorCountryId:'RUS',submittedAtDate:'2020-01-01',text:'[DEBUG_WORLD_EFFECT] set red',visibility:'public',status:'queued'}]},seed.world);
    const pair={...seed,simulation},r=resolution(pair,'RUS','#CC0000');r.events[0].causes=[{kind:'queued-action',id:'action.debug'}];r.playerActionOutcomes=[{outcomeId:'outcome.debug',actionId:'action.debug',status:'succeeded',evidenceEventId:'event.color',summary:'색상 변경',remainingConditions:[]}];
    vi.stubEnv('NODE_ENV','development');expect(createCatalogTurnPlan({turnId:'turn.debug',world:pair.world,simulation,resolution:r,catalog}).nextWorldState.countriesById.RUS.mapColor).toBe('#CC0000');
    vi.stubEnv('NODE_ENV','production');expect(()=>createCatalogTurnPlan({turnId:'turn.debug',world:pair.world,simulation,resolution:r,catalog})).toThrow(/AUTHORITY/);
    expect(validateResolutionAgainstContext(r,colorContext(pair),{debugWorldEffectActionIds:new Set(['action.debug'])}).ok).toBe(false);
  });
});
