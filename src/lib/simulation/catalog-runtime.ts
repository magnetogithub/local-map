import {createStore} from 'zustand/vanilla';
import {createAtomicTurnRuntime,type AtomicTurnSnapshot,type AtomicWorldPort} from './atomic-turn-runtime';
import {createWorldStateV3,deserializeWorldStateV3,worldStateV3ContentHash,type WorldStateV3} from '../world/world-state-v3';
import {createSimulationStateV2,deserializeSimulationStateV2,simulationStateV2ContentHash,type SimulationStateV2} from './simulation-state-v2';
import {canonicalSerialize,canonicalStringify} from '../world/canonical-serializer';
import {sha256Hex} from '../world/sha256';
import {assertSafeSimulationData} from './simulation-contract-primitives';
import {assertWorldGeometryCatalogRefMatches,type WorldGeometryCatalogContract} from '../world/world-geometry-catalog-ref';
import type {ResolvedTurnPlan} from './resolved-turn-plan';
import type {QueuedPlayerActionV1} from './queued-player-action';
import {worldV3RuntimeContentHash} from '../world/world-v3-runtime-hash';
import {isValidatedWorldStateV3,transitionWorldStateV3} from '../world/world-state-v3';
import {createOperationalStateChange} from '../world/operational-state-change';
import type {OperationalStateChange} from '../world/operational-catalog';

export type CatalogRuntimePair=AtomicTurnSnapshot<SimulationStateV2,WorldStateV3>;
export type CatalogRuntimeChange=Readonly<{
  kind:'commit'|'undo'|'redo'|'restart'|'catalog-transition'|'pending-actions'|'player';
  previous:CatalogRuntimePair;
  next:CatalogRuntimePair;
  stateChange:OperationalStateChange|null;
  changedCountryIds:readonly string[];
  requiresFullRefresh:boolean;
}>;
export function readCatalogRuntimePair(raw:string,catalog:WorldGeometryCatalogContract):CatalogRuntimePair{
  const saved=JSON.parse(raw);assertSafeSimulationData(saved);
  if(saved.format!=='world-simulation-schema-pair.v1'||Object.keys(saved).some(k=>!['format','world','simulation','revisions','pairContentHash'].includes(k)))throw new Error('Invalid production schema pair');
  const world=deserializeWorldStateV3(saved.world,catalog),simulation=deserializeSimulationStateV2(canonicalStringify(saved.simulation),world);
  if(saved.revisions.worldRevision!==world.revision||saved.revisions.simulationRevision!==simulation.revision)throw new Error('Production pair revision mismatch');
  const hash=sha256Hex(canonicalSerialize({namespace:'world-simulation-schema-pair.v1',revisions:saved.revisions,worldContentHash:worldStateV3ContentHash(world),simulationContentHash:simulationStateV2ContentHash(simulation)}));
  if(hash!==saved.pairContentHash)throw new Error('Production pair content hash mismatch');
  return Object.freeze({world,simulation,revisions:Object.freeze({...saved.revisions})});
}
export function createCatalogRuntime(seed:CatalogRuntimePair,catalog:WorldGeometryCatalogContract){
  const catalogs=new Map([[catalog.ref.catalogVersion,catalog]]);
  const catalogFor=(world:WorldStateV3)=>{const found=catalogs.get(world.catalogRef.catalogVersion);if(!found)throw Error('UNKNOWN_SNAPSHOT_CATALOG');assertWorldGeometryCatalogRefMatches(world.catalogRef,found.ref);return found;};
  const validateWorld=(world:WorldStateV3)=>{const found=catalogFor(world);if(!isValidatedWorldStateV3(world,found))createWorldStateV3(world,found);};
  const worldPort:AtomicWorldPort<WorldStateV3>={validate:validateWorld,restoreWithRevision:(world,revision)=>transitionWorldStateV3(world,catalogFor(world),{},revision),contentHash:worldV3RuntimeContentHash};
  let restartSeed=seed;
  let engine=createAtomicTurnRuntime(seed.simulation,seed.world,{worldPort});
  const internal=createStore<CatalogRuntimePair>(()=>engine.getSnapshot());
  const subscriberFailures:string[]=[];
  const changeSubscribers=new Set<(change:CatalogRuntimeChange)=>void>();
  let lastChange:CatalogRuntimeChange|null=null;
  const publish=(kind:CatalogRuntimeChange['kind'],next=engine.getSnapshot())=>{
    const previous=internal.getState();if(next===previous)return next;
    const sameCatalog=(Object.keys(previous.world.catalogRef) as (keyof typeof previous.world.catalogRef)[]).every(key=>previous.world.catalogRef[key]===next.world.catalogRef[key]);
    const requiresFullRefresh=!sameCatalog||kind==='restart';
    const changedCountryIds=new Set<string>(previous.world.countriesById===next.world.countriesById?[]:[...new Set([...previous.world.countryOrder,...next.world.countryOrder])].filter(id=>previous.world.countriesById[id]!==next.world.countriesById[id]));
    // Preparation runs inside the atomic engine's publisher for commit/undo/redo:
    // a failed delta preflight rolls the pair and history pointer back together.
    const stateChange=requiresFullRefresh?null:createOperationalStateChange(previous.world,next.world);
    for(const cell of stateChange?.cells??[])for(const countryId of [cell.before.ownerCountryId,cell.before.controllerCountryId,cell.after.ownerCountryId,cell.after.controllerCountryId])if(countryId!==null)changedCountryIds.add(countryId);
    const change:CatalogRuntimeChange=Object.freeze({kind,previous,next,requiresFullRefresh,stateChange,changedCountryIds:Object.freeze([...changedCountryIds].sort())});
    lastChange=change;internal.setState(next,true);
    for(const listener of [...changeSubscribers])try{listener(change);}catch(error){subscriberFailures.push(String(error));if(subscriberFailures.length>64)subscriberFailures.shift();}
    return next;
  };
  return Object.freeze({
    store:Object.freeze({getState:internal.getState,getInitialState:internal.getInitialState,subscribe:(listener:Parameters<typeof internal.subscribe>[0])=>internal.subscribe((next,previous)=>{try{listener(next,previous);}catch(error){subscriberFailures.push(String(error));if(subscriberFailures.length>64)subscriberFailures.shift();}})}),getSnapshot:internal.getState,
    getSubscriberFailures:()=>Object.freeze([...subscriberFailures]),
    getLastChange:()=>lastChange,
    subscribeChanges:(listener:(change:CatalogRuntimeChange)=>void)=>{changeSubscribers.add(listener);return()=>{changeSubscribers.delete(listener);};},
    getHistory:()=>engine.getHistory(),getInitialSnapshot:()=>restartSeed,
    getCatalogRef:()=>engine.getSnapshot().world.catalogRef,
    getCatalogForSnapshot:(world:WorldStateV3)=>catalogFor(world),
    transitionCatalog:(input:Readonly<{expected:CatalogRuntimePair;next:CatalogRuntimePair;catalog:WorldGeometryCatalogContract;initialSeed:CatalogRuntimePair}>)=>{
      if(input.expected!==engine.getSnapshot())throw Error('STALE_CATALOG_TRANSITION');
      if(input.expected.world.catalogRef.catalogVersion===input.catalog.ref.catalogVersion)throw Error('CATALOG_ALREADY_ACTIVE');
      if(catalogs.has(input.catalog.ref.catalogVersion))assertWorldGeometryCatalogRefMatches(input.catalog.ref,catalogs.get(input.catalog.ref.catalogVersion)!.ref);
      for(const pair of [input.next,input.initialSeed]){
        if(pair.revisions.worldRevision!==pair.world.revision||pair.revisions.simulationRevision!==pair.simulation.revision)throw Error('INVALID_CATALOG_TRANSITION_REVISIONS');
        assertWorldGeometryCatalogRefMatches(pair.world.catalogRef,input.catalog.ref);
        if(!isValidatedWorldStateV3(pair.world,input.catalog))createWorldStateV3(pair.world,input.catalog);
        createSimulationStateV2(pair.simulation,pair.world);
      }
      const previous=catalogs.get(input.catalog.ref.catalogVersion);
      catalogs.set(input.catalog.ref.catalogVersion,input.catalog);
      try{engine.transitionCatalogSnapshot(input.expected,input.next);}catch(error){if(previous)catalogs.set(input.catalog.ref.catalogVersion,previous);else catalogs.delete(input.catalog.ref.catalogVersion);throw error;}
      restartSeed=input.initialSeed;return publish('catalog-transition');
    },
    isFreshSeed:()=>{const current=engine.getSnapshot();return current.simulation.turnNumber===0&&current.world.revision===restartSeed.world.revision&&!engine.getHistory().entries.length;},
    replacePendingActions:(actions:readonly QueuedPlayerActionV1[])=>{engine.replacePendingActions(actions);return publish('pending-actions');},
    selectPlayer:(id:string)=>{const current=engine.getSnapshot();if(current.simulation.turnNumber!==0||current.world.revision!==restartSeed.world.revision)throw new Error('Player selection requires a fresh seed');
      const simulation=createSimulationStateV2({...current.simulation,playerCountryId:id},current.world);engine=createAtomicTurnRuntime(simulation,current.world,{worldPort});return publish('player');},
    commit:(plan:ResolvedTurnPlan<SimulationStateV2,WorldStateV3>)=>engine.commit(plan,next=>{publish('commit',next);}),
    undo:()=>engine.undo(next=>{publish('undo',next);}),redo:()=>engine.redo(next=>{publish('redo',next);}),
    canUndo:()=>engine.getHistory().pointer>0,canRedo:()=>engine.getHistory().pointer<engine.getHistory().entries.length,
    restart:()=>{engine=createAtomicTurnRuntime(restartSeed.simulation,restartSeed.world,{worldPort});return publish('restart');},
  });
}
export type CatalogRuntime=ReturnType<typeof createCatalogRuntime>;
