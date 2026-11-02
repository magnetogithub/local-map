// @vitest-environment node
import fs from 'node:fs';import {beforeAll,describe,it,expect,vi} from 'vitest';
import {prepareProductionCatalogSeed} from '../world/production-catalog-seed.server';import {readCatalogConsumerMetadata} from '../map/catalog-consumer-contract';import {catalogContractForConsumer} from '../projection/catalog-map-consumer-projection';
import {readCatalogRuntimePair,createCatalogRuntime,type CatalogRuntimePair} from './catalog-runtime';import {createSimulationStateV2} from './simulation-state-v2';import {createCatalogTurnPlan} from './catalog-turn-plan';import {validateTurnResolution} from './semantic-validator';
import {buildSimulationContext,parseSimulationContextV1} from './simulation-context';import {createCountrySearchProjection} from '../projection/country-search-index-patch';import {validateResolutionAgainstContext} from './server/context-resolution-validator';import type {ScheduledConsequenceV1} from './narrative-state';
let seed:CatalogRuntimePair,catalog:ReturnType<typeof catalogContractForConsumer>,ids:string[];
beforeAll(()=>{const p=prepareProductionCatalogSeed(),metadata=readCatalogConsumerMetadata(JSON.parse(fs.readFileSync(`public${p.bootstrap.metadata.path}`,'utf8')),p.bootstrap.catalogRef);catalog=catalogContractForConsumer(metadata);seed=readCatalogRuntimePair(p.serializedPair,catalog);ids=metadata.territories.filter(t=>t.sourceCountryId==='CHN').slice(0,3).map(t=>t.id);});
const event=(eventId:string,date:string,actors=['CHN','KOR'],causes:unknown[]=[],category='military')=>({eventId,date,actorCountryIds:actors,causes,outcomeCategory:category,title:'인과관계 검증',publicNarrative:'영토 관계를 검증했습니다.',relatedFactIds:[],relatedSituationIds:[],significance:'minor'});
function fixture(date:string,status:ScheduledConsequenceV1['status']='scheduled',kind='occupation'){
  const actors=kind==='merge'?['AUT','HUN']:kind==='color'?['KOR']:['CHN','KOR'],prior=event('event.prior','2020-01-01',actors),cause=event('event.grant',date,actors,[{kind:'scheduled-consequence',id:'consequence.future'}],kind==='occupation'?'military':'treaty');
  const simulation=createSimulationStateV2({...seed.simulation,playerCountryId:kind==='merge'?'HUN':'KOR',eventLog:[prior],scheduledConsequences:[{consequenceId:'consequence.future',earliestDate:'2020-01-15',deadlineDate:null,actorCountryIds:actors,situationId:null,triggerSummary:'예정 결과',sourceEventId:'event.prior',status}]},seed.world),pair={...seed,simulation};
  const grant={effectId:'effect.grant',causedByEventId:'event.grant',type:'territorialAuthority.granted',authority:{id:'tca:future',actorCountryId:'KOR',targetCountryId:'CHN',allowedTerritoryIds:ids,allowedOperations:['occupy'],validFrom:date,validTo:null,sourceEventId:'event.grant'}};
  const occupation={effectId:'effect.occupation',causedByEventId:'event.grant',type:'territory.occupy',actorCountryId:'KOR',targetCountryId:'CHN',authorityId:'tca:future',territoryIds:ids};
  const effects:unknown[]=kind==='merge'?[{effectId:'effect.merge',causedByEventId:'event.grant',type:'countries.merged',initiatorCountryId:'AUT',absorbedCountryIds:['HUN']}]:kind==='color'?[
    {effectId:'effect.color-grant',causedByEventId:'event.grant',type:'countryPresentationAuthority.granted',authority:{id:'cpa:future',actorCountryId:'KOR',targetCountryId:'KOR',allowedMapColors:['#FFFFFF'],validFrom:date,validTo:null,sourceEventId:'event.grant'}},
    {effectId:'effect.color',causedByEventId:'event.grant',type:'country.changeMapColor',actorCountryId:'KOR',countryId:'KOR',mapColor:'#FFFFFF',authorityId:'cpa:future'}]:[grant,occupation];
  const resolution={contractVersion:'turn-resolution.v1',baseSimulationRevision:simulation.revision,baseWorldRevision:seed.world.revision,period:{startDate:'2020-01-01',endDate:'2020-01-31'},playerActionOutcomes:[],events:[cause],factMutations:[],situationMutations:[],scheduledConsequences:[],worldEffects:effects,advisorSummary:'검증',unresolvedQuestions:[]};
  const context=buildSimulationContext({simulation,world:pair.world,countrySearchProjection:createCountrySearchProjection(pair.world),subdivisionCatalog:{listCountry:()=>[],inspect:()=>null,materialize:()=>null},scenarioId:'2020-otl',scenarioStartDate:'2020-01-01',targetDate:'2020-01-31'});
  return {pair,resolution,context};
}
describe('REVIEW E consequence date and atomic rollback',()=>{
  it.skipIf(!process.env.PROMPT14_REVIEW_E_EVIDENCE)('validates captured production responses against the server contract',()=>{
    const evidence=JSON.parse(fs.readFileSync(process.env.PROMPT14_REVIEW_E_EVIDENCE!,'utf8'));expect(evidence.status).toBe('pass');expect(evidence.turns).toHaveLength(5);
    for(const turn of evidence.turns){const context=parseSimulationContextV1(turn.context),validation=validateResolutionAgainstContext(turn.resolution,context);expect(validation.ok,JSON.stringify({stage:turn.stage,issues:validation.issues})).toBe(turn.expectedValidation);}
    for(const phase of evidence.phases.filter((p:{phase:string})=>p.phase.startsWith('future-'))){expect(phase.notificationDelta).toBe(0);expect(phase.calls).toEqual([]);expect(phase.partialChanges).toBe(0);}
    expect(evidence.phases.filter((p:{phase:string})=>p.phase.startsWith('merge-')).map((p:{snapshot:{playerCountryId:string;uiPlayerCountryId:string}})=>[p.snapshot.playerCountryId,p.snapshot.uiPlayerCountryId])).toEqual([['AUT','AUT'],['HUN','HUN'],['AUT','AUT']]);
  });
  it.each(['occupation','merge','color'])('rejects %s before Jan 15 while allowing Jan 15 and later',kind=>{
    for(const date of ['2020-01-02','2020-01-15','2020-01-16']){const f=fixture(date,'scheduled',kind),valid=date>='2020-01-15';
      expect(validateTurnResolution(f.resolution,f.pair.simulation,f.pair.world).ok).toBe(valid);expect(validateResolutionAgainstContext(f.resolution,f.context).ok).toBe(valid);
      const prepare=()=>createCatalogTurnPlan({...f.pair,catalog,turnId:'turn.consequence',resolution:f.resolution});if(valid)expect(prepare).not.toThrow();else expect(prepare).toThrow(/INVALID_CAUSALITY/);
    }
  });
  it.each(['due','cancelled','resolved'] as const)('checks consequence lifecycle state %s',status=>{
    const f=fixture('2020-01-15',status),valid=status==='due';expect(validateTurnResolution(f.resolution,f.pair.simulation,f.pair.world).ok).toBe(valid);
    const context={...f.context,dueConsequences:f.pair.simulation.scheduledConsequences};expect(validateResolutionAgainstContext(f.resolution,context).ok).toBe(valid);
  });
  it.each(['middle','last'])('rejects a future grant at aggregate %s without pair/history/map publication',position=>{
    const f=fixture('2020-01-02'),runtime=createCatalogRuntime(f.pair,catalog),notification=vi.fn(),mapUpdate=vi.fn();runtime.store.subscribe(notification);runtime.store.subscribe(mapUpdate);
    const rename={effectId:'effect.rename',causedByEventId:'event.valid',type:'country.renamed',countryId:'KOR',displayName:'변경 대한민국'};
    f.resolution.events.unshift(event('event.valid','2020-01-02',['KOR'],[],'domestic'));f.resolution.worldEffects=position==='middle'?[rename,...f.resolution.worldEffects]:[rename,f.resolution.worldEffects[0]];
    const before=runtime.getSnapshot();expect(()=>runtime.commit(createCatalogTurnPlan({...f.pair,catalog,turnId:'turn.invalid-aggregate',resolution:f.resolution}))).toThrow(/INVALID_CAUSALITY/);
    expect(runtime.getSnapshot()).toBe(before);expect(runtime.canUndo()).toBe(false);expect(runtime.canRedo()).toBe(false);expect(notification).not.toHaveBeenCalled();expect(mapUpdate).not.toHaveBeenCalled();
  });
});
