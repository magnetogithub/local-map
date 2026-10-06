import {createStore} from 'zustand/vanilla';
import {createAtomicTurnRuntime,type AtomicTurnSnapshot,type AtomicWorldPort} from './atomic-turn-runtime';
import {createWorldStateV3,deserializeWorldStateV3,worldStateV3ContentHash,type WorldStateV3} from '../world/world-state-v3';
import {createSimulationStateV2,deserializeSimulationStateV2,simulationStateV2ContentHash,type SimulationStateV2} from './simulation-state-v2';
import {canonicalSerialize,canonicalStringify} from '../world/canonical-serializer';
import {sha256Hex} from '../world/sha256';
import {assertSafeSimulationData} from './simulation-contract-primitives';
import type {WorldGeometryCatalogContract} from '../world/world-geometry-catalog-ref';
import type {ResolvedTurnPlan} from './resolved-turn-plan';
import type {QueuedPlayerActionV1} from './queued-player-action';
import {worldV3RuntimeContentHash} from '../world/world-v3-runtime-hash';
import {isValidatedWorldStateV3,transitionWorldStateV3} from '../world/world-state-v3';

export type CatalogRuntimePair=AtomicTurnSnapshot<SimulationStateV2,WorldStateV3>;
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
  const worldPort:AtomicWorldPort<WorldStateV3>={validate:world=>{if(!isValidatedWorldStateV3(world,catalog))createWorldStateV3(world,catalog);},restoreWithRevision:(world,revision)=>transitionWorldStateV3(world,catalog,{},revision),contentHash:worldV3RuntimeContentHash};
  let engine=createAtomicTurnRuntime(seed.simulation,seed.world,{worldPort});
  const internal=createStore<CatalogRuntimePair>(()=>engine.getSnapshot());
  const subscriberFailures:string[]=[];
  const publish=()=>{const next=engine.getSnapshot();internal.setState(next,true);return next;};
  return Object.freeze({
    store:Object.freeze({getState:internal.getState,getInitialState:internal.getInitialState,subscribe:(listener:Parameters<typeof internal.subscribe>[0])=>internal.subscribe((next,previous)=>{try{listener(next,previous);}catch(error){subscriberFailures.push(String(error));if(subscriberFailures.length>64)subscriberFailures.shift();}})}),getSnapshot:internal.getState,
    getSubscriberFailures:()=>Object.freeze([...subscriberFailures]),
    isFreshSeed:()=>{const current=engine.getSnapshot();return current.simulation.turnNumber===0&&current.world.revision===seed.world.revision&&!engine.getHistory().entries.length;},
    replacePendingActions:(actions:readonly QueuedPlayerActionV1[])=>{engine.replacePendingActions(actions);return publish();},
    selectPlayer:(id:string)=>{const current=engine.getSnapshot();if(current.simulation.turnNumber!==0||current.world.revision!==seed.world.revision)throw new Error('Player selection requires a fresh seed');
      const simulation=createSimulationStateV2({...current.simulation,playerCountryId:id},current.world);engine=createAtomicTurnRuntime(simulation,current.world,{worldPort});return publish();},
    commit:(plan:ResolvedTurnPlan<SimulationStateV2,WorldStateV3>)=>{engine.commit(plan);return publish();},
    undo:()=>{engine.undo();return publish();},redo:()=>{engine.redo();return publish();},
    canUndo:()=>engine.getHistory().pointer>0,canRedo:()=>engine.getHistory().pointer<engine.getHistory().entries.length,
    restart:()=>{engine=createAtomicTurnRuntime(seed.simulation,seed.world,{worldPort});return publish();},
  });
}
export type CatalogRuntime=ReturnType<typeof createCatalogRuntime>;
