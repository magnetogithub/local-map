// @vitest-environment node
import fs from 'node:fs';
import os from 'node:os';
import {it,expect,vi} from 'vitest';
import {readCatalogConsumerMetadata} from '../map/catalog-consumer-contract';
import {catalogContractForConsumer,createCatalogMapConsumerProjection} from '../projection/catalog-map-consumer-projection';
import {createCatalogMapConsumer,type CatalogMapPort} from '../map/catalog-map-consumer';
import type {CatalogVectorDelivery} from '../map/catalog-vector-delivery';
import {readCatalogRuntimePair,createCatalogRuntime} from './catalog-runtime';
import {createSimulationStateV2} from './simulation-state-v2';
import {createCatalogTurnPlan} from './catalog-turn-plan';
import {buildSimulationContext} from './simulation-context';
import type {TurnResolutionV1} from './turn-resolution';

it('measures large bounded occupation/color plans and rejects structural regressions',()=>{
  const freeze=JSON.parse(fs.readFileSync('data/catalogs/prompt14/frozen-catalog-ref.json','utf8'));
  const metadata=readCatalogConsumerMetadata(JSON.parse(fs.readFileSync(`public/data/territory-catalog/${freeze.ref.catalogVersion}/consumer-metadata.json`,'utf8')),freeze.ref),catalog=catalogContractForConsumer(metadata);
  const seed=readCatalogRuntimePair(fs.readFileSync(`data/catalogs/prompt14/${freeze.ref.catalogVersion}/migration-pair.json`,'utf8'),catalog);
  const target=Object.entries(seed.world.countryOrder.reduce<Record<string,number>>((counts,id)=>{counts[id]=seed.world.territoryOrder.filter(t=>seed.world.territoriesById[t].ownerCountryId===id).length;return counts;},{})).filter(([id])=>id!=='RUS').sort((a,b)=>b[1]-a[1])[0][0];
  const ids=seed.world.territoryOrder.filter(id=>seed.world.territoriesById[id].ownerCountryId===target).slice(0,512).sort();
  const source={eventId:'event.performance.source',date:'2020-01-01',title:'Existing conflict',publicNarrative:'Existing mandate.',actorCountryIds:['RUS',target],relatedFactIds:[],relatedSituationIds:[],causes:[],outcomeCategory:'military' as const,significance:'notable' as const};
  const simulation=createSimulationStateV2({...seed.simulation,playerCountryId:'RUS',eventLog:[source],territorialControlAuthoritiesById:{'tca:performance':{id:'tca:performance',actorCountryId:'RUS',targetCountryId:target,allowedTerritoryIds:ids,allowedOperations:['occupy'],validFrom:'2020-01-01',validTo:null,sourceEventId:source.eventId}},territorialControlAuthorityOrder:['tca:performance'],
    countryPresentationAuthoritiesById:{'cpa:performance':{id:'cpa:performance',actorCountryId:'RUS',targetCountryId:'RUS',allowedMapColors:['#CC0000'],validFrom:'2020-01-01',validTo:null,sourceEventId:source.eventId}},countryPresentationAuthorityOrder:['cpa:performance']},seed.world);
  const states=vi.fn(),setData=vi.fn(),updateData=vi.fn(),sources=new Map(),layers=new Map();
  const map:CatalogMapPort={addSource:id=>sources.set(id,{setData,updateData}),getSource:id=>sources.get(id),removeSource:id=>sources.delete(id),addLayer:l=>layers.set(l.id,l),getLayer:id=>layers.get(id),removeLayer:id=>layers.delete(id),setFeatureState:states,on:vi.fn(),off:vi.fn()};
  const delivery={metadata,source:{type:'vector',tiles:['https://example.test/{z}/{x}/{y}']},observeEdges:()=>()=>{}} as unknown as CatalogVectorDelivery;
  const consumer=createCatalogMapConsumer({map,delivery,world:seed.world}),runtime=createCatalogRuntime({...seed,simulation},catalog);runtime.store.subscribe(pair=>consumer.updateWorld(pair.world));
  const resolution:TurnResolutionV1={contractVersion:'turn-resolution.v1',baseSimulationRevision:simulation.revision,baseWorldRevision:seed.world.revision,period:{startDate:'2020-01-01',endDate:'2020-01-02'},playerActionOutcomes:[],events:[{...source,eventId:'event.performance',date:'2020-01-02',causes:[{kind:'authoritative-event',id:source.eventId}]}],factMutations:[],situationMutations:[],scheduledConsequences:[],
    worldEffects:[{effectId:'effect.performance',causedByEventId:'event.performance',type:'territory.occupy',actorCountryId:'RUS',targetCountryId:target,authorityId:'tca:performance',territoryIds:ids as never}],advisorSummary:'Benchmark',unresolvedQuestions:[]};
  const start=performance.now(),plan=createCatalogTurnPlan({turnId:'turn.performance',world:seed.world,simulation,resolution,catalog}),planMs=performance.now()-start;
  expect(plan.resolution.worldEffects).toHaveLength(1);expect(plan.nextWorldState.countriesById).toBe(seed.world.countriesById);
  expect(plan.nextWorldState.territoryOrder).toBe(seed.world.territoryOrder);expect(plan.nextWorldState.catalogRef).toBe(seed.world.catalogRef);
  const untouched=seed.world.territoryOrder.find(id=>!ids.includes(id))!;expect(plan.nextWorldState.territoriesById[untouched]).toBe(seed.world.territoriesById[untouched]);
  states.mockClear();const commitStart=performance.now();runtime.commit(plan);const occupationCommitMs=performance.now()-commitStart;
  expect(setData).not.toHaveBeenCalled();expect(updateData).not.toHaveBeenCalled();
  const occupiedCalls=states.mock.calls.filter(([t])=>t.source==='world-territory-catalog'&&t.sourceLayer==='territories');expect(occupiedCalls.map(([t])=>t.id).sort()).toEqual(ids);
  const current=runtime.getSnapshot(),color:TurnResolutionV1={...resolution,baseSimulationRevision:current.simulation.revision,baseWorldRevision:current.world.revision,period:{startDate:'2020-01-02',endDate:'2020-01-03'},events:[{...source,eventId:'event.performance.color',date:'2020-01-03',actorCountryIds:['RUS'],outcomeCategory:'domestic'}],worldEffects:[{effectId:'effect.color',causedByEventId:'event.performance.color',type:'country.changeMapColor',countryId:'RUS',actorCountryId:'RUS',authorityId:'cpa:performance',mapColor:'#CC0000'}]};
  const initialProjection=consumer.getProjection(),colorStart=performance.now(),colorPlan=createCatalogTurnPlan({turnId:'turn.performance.color',...current,resolution:color,catalog}),colorPlanMs=performance.now()-colorStart;
  expect(colorPlan.nextWorldState.territoriesById).toBe(current.world.territoriesById);states.mockClear();const colorCommitStart=performance.now();runtime.commit(colorPlan);const colorCommitMs=performance.now()-colorCommitStart;
  expect(consumer.getProjection().labels).toBe(initialProjection.labels);expect(setData).not.toHaveBeenCalled();expect(updateData).not.toHaveBeenCalled();
  expect(consumer.getUpdateStats().fullProjectionBuilds).toBe(1);
  const context=buildSimulationContext({world:current.world,simulation:current.simulation,countrySearchProjection:createCatalogMapConsumerProjection(current.world,metadata).search,subdivisionCatalog:{listCountry:()=>[],inspect:()=>null,materialize:()=>null},scenarioId:'2020-otl',scenarioStartDate:'2020-01-01',targetDate:'2020-01-03'});
  const text=JSON.stringify(context),listed=context.territoryDirectory.reduce((n,c)=>n+c.territoryIds.length,0);expect(listed).toBeLessThan(seed.world.territoryOrder.length);expect(text).not.toMatch(/"coordinates"|"Polygon"|"MultiPolygon"/);
  const result={status:'pass',environment:{node:process.version,platform:os.platform(),cpu:os.cpus()[0].model,totalMemory:os.totalmem()},catalogVersion:freeze.ref.catalogVersion,totalTerritories:seed.world.territoryOrder.length,target,occupiedTerritories:ids.length,
    occupation:{effects:1,planMs,commitMs:occupationCommitMs,affectedTerritoryCalls:occupiedCalls.length},color:{effects:1,planMs:colorPlanMs,commitMs:colorCommitMs,affectedTerritoryCalls:states.mock.calls.filter(([t])=>t.sourceLayer==='territories').length},stats:consumer.getUpdateStats(),wholeSourceSetDataCalls:setData.mock.calls.length,sourceUpdateDataCalls:updateData.mock.calls.length,context:{bytes:Buffer.byteLength(text),listedTerritories:listed,containsGeometry:false},sharedCollectionsVerified:true};
  const output=process.env.PROMPT14_PERFORMANCE_OUTPUT??'.tmp/prompt14-performance';
  fs.mkdirSync(output,{recursive:true});fs.writeFileSync(`${output}/runtime.json`,JSON.stringify(result,null,2));consumer.dispose();
});
