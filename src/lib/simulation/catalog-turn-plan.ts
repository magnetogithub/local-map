import {resolveCatalogRegionEffects,type CatalogRegionIndex} from './catalog-region';
import {parseTurnResolutionV1} from './turn-resolution';
import {validateTurnResolution} from './semantic-validator';
import {createSimulationStateV2,simulationStateV2ContentHash,type SimulationStateV2} from './simulation-state-v2';
import {transitionWorldStateV3,type WorldStateV3} from '../world/world-state-v3';
import {assertWorldGeometryCatalogRefMatches,type WorldGeometryCatalogContract} from '../world/world-geometry-catalog-ref';
import {createCountryEntityV3} from '../world/country-entity-v3';
import type {ResolvedTurnPlan} from './resolved-turn-plan';
import {worldV3RuntimeContentHash} from '../world/world-v3-runtime-hash';
import {planTerritorialControl} from '../planning/territorial-control-planner';
import {catalogLifecycleEvent,reconcileCatalogSimulation,territorialAuthorityScopeValid,type CountrySuccessors} from './catalog-authority-lifecycle';
import type {SimulationEventV1} from './simulation-event';
import {prepareCountryColorAuthorities} from './country-color-authority';
import {planCountryMapColors} from '../planning/country-map-color-planner';
import {DEBUG_WORLD_EFFECT_PREFIX,allowsDevelopmentWorldEffect} from './debug-world-effect';
import {isConsequenceAvailableAt} from './consequence-causality';

/** V3 commits never materialize geometry. Territory/authority planners are introduced by subsequent tasks. */
export function createCatalogTurnPlan(input:{turnId:string;simulation:SimulationStateV2;world:WorldStateV3;resolution:unknown;catalog:WorldGeometryCatalogContract;regionIndex?:CatalogRegionIndex}):ResolvedTurnPlan<SimulationStateV2,WorldStateV3>{
  if(input.regionIndex?.catalogRef)assertWorldGeometryCatalogRefMatches(input.world.catalogRef,input.regionIndex.catalogRef);
  const debugWorldEffectActionIds=new Set(input.simulation.queuedActions.filter(a=>allowsDevelopmentWorldEffect(['queued','resolving'].includes(a.status)&&a.text.startsWith(DEBUG_WORLD_EFFECT_PREFIX))).map(a=>a.actionId));
  const validation=validateTurnResolution(resolveCatalogRegionEffects(parseTurnResolutionV1(input.resolution),input.regionIndex),input.simulation,input.world,{debugWorldEffectActionIds});
  if(!validation.ok||!validation.resolution)throw new Error(validation.issues.map(i=>`${i.code}: ${i.message}`).join('; '));
  const r=validation.resolution;
  if(r.events.some(e=>e.authorityLifecycle||e.referenceLifecycle))throw Error('HOST_OWNED_LIFECYCLE_EVENT');
  const reachesDebug=(id:string,seen=new Set<string>()):boolean=>{if(seen.has(id))return false;seen.add(id);const event=r.events.find(e=>e.eventId===id);return event?.causes.some(c=>c.kind==='queued-action'?debugWorldEffectActionIds.has(c.id):c.kind==='resolution-event'?reachesDebug(c.id,seen):false)??false;};
  let world=input.world,frame=input.simulation,lastDate=input.simulation.currentDate;const changedCountries=new Set<string>(),changedTerritories=new Set<string>(),successors:Record<string,string|null>={},hostEvents:SimulationEventV1[]=[];
  const frameAt=(date:string)=>{
    const events=[...input.simulation.eventLog,...r.events.filter(e=>e.date<=date),...hostEvents.filter(e=>e.date<=date)].sort((a,b)=>a.date<b.date?-1:a.date>b.date?1:0);
    const reconciled=reconcileCatalogSimulation({simulation:{...frame,eventLog:events},world,successors,date,turnId:input.turnId});
    const known=new Set(events.map(e=>e.eventId));for(const e of reconciled.eventLog)if(!known.has(e.eventId)&&!hostEvents.some(h=>h.eventId===e.eventId))hostEvents.push(e);
    frame=createSimulationStateV2(reconciled,world);return frame;
  };
  for(const effect of r.worldEffects){const cause=r.events.find(e=>e.eventId===effect.causedByEventId)!;
    if(cause.date<lastDate)throw Error('EFFECT_CHRONOLOGY');lastDate=cause.date;frameAt(cause.date);
    if(effect.type==='countryPresentationAuthority.granted'){
      frame=prepareCountryColorAuthorities(frame,world,{...r,worldEffects:[effect]},cause.date);
      hostEvents.push(catalogLifecycleEvent({turnId:input.turnId,date:cause.date,actorIds:[effect.authority.actorCountryId],sourceEventId:cause.eventId,
        authority:{authorityId:effect.authority.id,operation:'granted',reason:'validated-turn-grant',previousActorCountryId:null,previousTargetCountryId:null}}));
    }else if(effect.type==='country.changeMapColor'){
      const {effectId,causedByEventId,type,...payload}=effect;void causedByEventId;
      const plan=planCountryMapColors({world,simulation:frame,date:cause.date,debugDirective:reachesDebug(cause.eventId),
        commands:[{commandId:effectId,type,expectedRevision:world.revision,payload}]});
      for(const id of plan.changedCountryIds)changedCountries.add(id);for(const id of plan.affectedTerritoryIds)changedTerritories.add(id);
      if(plan.changedCountryIds.length)world=transitionWorldStateV3(world,input.catalog,{countries:plan.countries},input.world.revision);
    }else if(effect.type==='territorialAuthority.granted'){
      const a=effect.authority,participants=[a.actorCountryId,...(a.targetCountryId?[a.targetCountryId]:[])];
      const grounded=cause.causes.some(c=>{
        if(c.kind==='authoritative-event'){const prior=input.simulation.eventLog.find(e=>e.eventId===c.id);return prior&&!prior.authorityLifecycle&&!prior.referenceLifecycle&&['military','territorial','treaty'].includes(prior.outcomeCategory)&&participants.every(id=>prior.actorCountryIds.includes(id));}
        if(c.kind==='scheduled-consequence'){const prior=input.simulation.scheduledConsequences.find(e=>e.consequenceId===c.id);return prior&&isConsequenceAvailableAt(prior,cause.date)&&participants.every(id=>prior.actorCountryIds.includes(id));}return false;
      })||Object.values(input.simulation.factsById).some(f=>f.status==='active'&&['scenario','conflict-or-war','treaty-or-negotiation','military-or-occupation'].includes(f.kind)&&participants.every(id=>f.actorCountryIds.includes(id)));
      if(!grounded||!cause.actorCountryIds.includes(a.actorCountryId)||a.sourceEventId!==cause.eventId||a.validFrom<cause.date||!territorialAuthorityScopeValid(a,world)||participants.some(id=>!world.countriesById[id]))throw Error('INVALID_AUTHORITY_GRANT');
      if(frame.territorialControlAuthoritiesById[a.id]||[...input.simulation.eventLog,...hostEvents].some(e=>e.authorityLifecycle?.authorityId===a.id))throw Error('DUPLICATE_AUTHORITY_ID');
      frame=createSimulationStateV2({...frame,territorialControlAuthoritiesById:{...frame.territorialControlAuthoritiesById,[a.id]:a},territorialControlAuthorityOrder:[...frame.territorialControlAuthorityOrder,a.id].sort()},world);
      hostEvents.push(catalogLifecycleEvent({turnId:input.turnId,date:cause.date,actorIds:participants,sourceEventId:cause.eventId,authority:{authorityId:a.id,operation:'granted',reason:'validated-turn-grant',previousActorCountryId:null,previousTargetCountryId:null}}));
    }else if(effect.type==='territory.occupy'||effect.type==='territory.liberate'||effect.type==='territory.transferOwnership'){
      if(!cause.actorCountryIds.includes(effect.actorCountryId))throw Error('INVALID_TERRITORIAL_ACTOR_CAUSE');
      const {effectId,causedByEventId,type,regionRefs,...payload}=effect;void causedByEventId;void regionRefs;
      const aggregate=planTerritorialControl({world,simulation:frame,date:cause.date,debugDirective:reachesDebug(cause.eventId),command:{commandId:effectId,type,expectedRevision:world.revision,payload:{...payload,expectedSimulationRevision:frame.revision}}});
      const territories=Object.fromEntries(aggregate.changes.map(c=>{changedTerritories.add(c.after.id);for(const id of [c.before.ownerCountryId,c.before.controllerCountryId,c.after.ownerCountryId,c.after.controllerCountryId])if(id)changedCountries.add(id);return [c.after.id,c.after];}));
      world=transitionWorldStateV3(world,input.catalog,{territories},input.world.revision);
    }else if(effect.type==='country.renamed'){
      const c=world.countriesById[effect.countryId];if(!c)throw Error('INACTIVE_COUNTRY');changedCountries.add(c.id);
      world=transitionWorldStateV3(world,input.catalog,{countries:{[c.id]:createCountryEntityV3({...c,names:{...c.names,shortKo:effect.displayName,officialKo:effect.displayName,mapKo:effect.displayName},moduleVersions:{...c.moduleVersions,names:c.moduleVersions.names+1}})}},input.world.revision);
    }else if(effect.type==='countries.merged'||effect.type==='countries.unified'||effect.type==='country.dissolved'){
      const initiator=effect.type==='countries.merged'?effect.initiatorCountryId:effect.type==='countries.unified'?input.simulation.playerCountryId:effect.successorCountryId;
      const absorbed=effect.type==='countries.merged'?effect.absorbedCountryIds:effect.type==='countries.unified'?effect.countryIds.filter(id=>id!==initiator):[effect.countryId];
      if(effect.type==='countries.unified'&&!effect.countryIds.includes(initiator!))throw Error('EXPLICIT_INITIATOR_REQUIRED');
      if(absorbed.includes(initiator!)||absorbed.some(id=>!world.countriesById[id])||(initiator!==null&&!world.countriesById[initiator]))throw Error('INVALID_COUNTRY_SUCCESSOR');
      if(effect.type==='country.dissolved'&&(!['territorial','military','treaty'].includes(cause.outcomeCategory)||!cause.causes.some(c=>c.kind==='authoritative-event'||c.kind==='scheduled-consequence')))throw Error('INVALID_DISSOLUTION_CAUSE');
      for(const id of absorbed){successors[id]=initiator;changedCountries.add(id);}if(initiator)changedCountries.add(initiator);
      const territories:Record<string,WorldStateV3['territoriesById'][string]>={};
      for(const id of world.territoryOrder){const t=world.territoriesById[id],owner=absorbed.includes(t.ownerCountryId!)?initiator:t.ownerCountryId;let controller=absorbed.includes(t.controllerCountryId!)?initiator:t.controllerCountryId;if(owner!==null&&controller===null)controller=owner;
        if(owner!==t.ownerCountryId||controller!==t.controllerCountryId){territories[id]={...t,ownerCountryId:owner as typeof t.ownerCountryId,controllerCountryId:controller as typeof t.controllerCountryId};changedTerritories.add(id);}}
      world=transitionWorldStateV3(world,input.catalog,{territories,countries:Object.fromEntries(absorbed.map(id=>[id,null]))},input.world.revision);
      if(effect.type==='countries.unified'){const c=world.countriesById[initiator!];world=transitionWorldStateV3(world,input.catalog,{countries:{[c.id]:{...c,names:{...c.names,mapKo:effect.displayName,shortKo:effect.displayName,officialKo:effect.displayName},moduleVersions:{...c.moduleVersions,names:c.moduleVersions.names+1}}}},input.world.revision);}
      frameAt(cause.date);
    }else throw Error('CATALOG_WORLD_EFFECT_NOT_READY');
  }
  if(world!==input.world)world=transitionWorldStateV3(world,input.catalog,{},input.world.revision+1);
  const facts={...frame.factsById},situations={...frame.situationsById};
  for(const m of r.factMutations){if(m.operation==='upsert')facts[m.fact.factId]=m.fact;else facts[m.factId]={...facts[m.factId],status:'ended'};}
  for(const m of r.situationMutations){if(m.operation==='upsert')situations[m.situation.situationId]=m.situation;else situations[m.situationId]={...situations[m.situationId],status:'resolved',lastUpdatedByEventId:m.causedByEventId};}
  const outcomes=new Set(r.playerActionOutcomes.map(o=>o.actionId)),consequences=new Map(frame.scheduledConsequences.map(c=>[c.consequenceId,c]));
  for(const c of r.scheduledConsequences)consequences.set(c.consequenceId,c);
  const simulation=createSimulationStateV2(reconcileCatalogSimulation({simulation:{...frame,revision:input.simulation.revision+1,currentDate:r.period.endDate,turnNumber:input.simulation.turnNumber+1,
    queuedActions:frame.queuedActions.map(a=>outcomes.has(a.actionId)&&a.status!=='cancelled'?{...a,status:'resolved'}:a),factsById:facts,factOrder:Object.keys(facts).sort(),situationsById:situations,situationOrder:Object.keys(situations).sort(),
    scheduledConsequences:[...consequences.values()].sort((a,b)=>a.earliestDate<b.earliestDate?-1:a.earliestDate>b.earliestDate?1:a.consequenceId<b.consequenceId?-1:1),eventLog:[...input.simulation.eventLog,...r.events,...hostEvents].sort((a,b)=>a.date<b.date?-1:a.date>b.date?1:0),
    history:{lastCommittedTurnId:input.turnId,committedTurnCount:input.simulation.history.committedTurnCount+1}},world,successors:successors as CountrySuccessors,date:r.period.endDate,turnId:input.turnId}),world);
  return Object.freeze({kind:'resolved-turn-plan.v1',turnId:input.turnId,baseSimulationState:input.simulation,baseWorldState:input.world,nextSimulationState:simulation,nextWorldState:world,resolution:r,
    compiledWorldEffects:{batch:null,allocatedCountryIdsByLocalRef:{},commandCount:r.worldEffects.length},worldPatch:null,
    beforeSimulationHash:simulationStateV2ContentHash(input.simulation),afterSimulationHash:simulationStateV2ContentHash(simulation),beforeWorldHash:worldV3RuntimeContentHash(input.world),afterWorldHash:worldV3RuntimeContentHash(world),
    changeSummary:{eventCount:r.events.length,factMutationCount:r.factMutations.length,situationMutationCount:r.situationMutations.length,scheduledConsequenceCount:r.scheduledConsequences.length,worldEffectCount:r.worldEffects.length,commandCount:r.worldEffects.length,changedCountryIds:[...changedCountries].sort(),changedTerritoryIds:[...changedTerritories].sort()}});
}
