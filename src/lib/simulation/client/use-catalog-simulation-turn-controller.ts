'use client';
import {useCallback,useEffect,useRef,useState} from 'react';
import {useStore} from 'zustand';
import type {CatalogRuntime} from '../catalog-runtime';
import {catalogContractForConsumer} from '../../projection/catalog-map-consumer-projection';
import type {CatalogConsumerMetadata} from '../../map/catalog-consumer-contract';
import type {CountrySearchProjection} from '../../projection/country-search-index-patch';
import {buildSimulationContext} from '../simulation-context';
import {queuePlayerAction,cancelQueuedPlayerAction,activePlayerActionCount,assertPlayerActionsCanAdvance,isActivePlayerAction} from '../queued-player-action';
import {MAX_ACTIVE_PLAYER_ACTIONS,SimulationContractError} from '../simulation-contract-primitives';
import {streamSimulationTurn} from './ndjson-turn-client';
import {initialTurnClientState,reduceHostTurnEvent,markTurnCommitted} from './turn-state-machine';
import {targetDateForPreset,targetDateForCustomInput,type TimeAdvancePreset} from './turn-request';
import {createCatalogTurnPlan} from '../catalog-turn-plan';
import {createCommittedTurnReport,type TurnReport} from './turn-report';
import type {ActiveCountryId} from '../../world/country-id';
import type {TurnResolutionV1} from '../turn-resolution';
import {readCatalogRegions,readResolutionRegionIndex} from './catalog-region-client';
export function useCatalogSimulationTurnController(input:{runtime:CatalogRuntime;metadata:CatalogConsumerMetadata;countrySearchProjection:CountrySearchProjection;playerCountryId:ActiveCountryId|null;syncPlayerCountry:(id:ActiveCountryId)=>void}){
  const snapshot=useStore(input.runtime.store,s=>s),[actionDraft,setActionDraft]=useState(''),[turn,setTurn]=useState(initialTurnClientState),[report,setReport]=useState<TurnReport|null>(null);
  const abort=useRef<AbortController|null>(null),sequence=useRef(0),last=useRef<{preset?:TimeAdvancePreset;date?:string}>({preset:'month'});
  const running=['requesting','looking_up','repairing','committing'].includes(turn.phase);
  useEffect(()=>()=>abort.current?.abort(),[]);
  const queueAction=()=>{if(running||abort.current||!actionDraft.trim())return;const current=input.runtime.getSnapshot();if(activePlayerActionCount(current.simulation.queuedActions)>=MAX_ACTIVE_PLAYER_ACTIONS)return;input.runtime.replacePendingActions(queuePlayerAction(current.simulation.queuedActions,{actionId:`action.${current.simulation.turnNumber}.${++sequence.current}`,playerCountryId:current.simulation.playerCountryId,submittedAtDate:current.simulation.currentDate,text:actionDraft}));setActionDraft('');};
  const cancelAction=(id:string)=>{if(!running&&!abort.current)input.runtime.replacePendingActions(cancelQueuedPlayerAction(snapshot.simulation.queuedActions,id,snapshot.simulation.playerCountryId));};
  const run=useCallback(async(selection:{preset?:TimeAdvancePreset;date?:string})=>{
    if(abort.current||!input.playerCountryId)return;
    const base=input.runtime.getSnapshot(),targetDate=selection.preset?targetDateForPreset(base.simulation,selection.preset):targetDateForCustomInput(base.simulation.currentDate,selection.date!);
    const turnId=`turn.${base.simulation.turnNumber+1}.${base.simulation.revision}`,controller=new AbortController();abort.current=controller;last.current=selection;setReport(null);setTurn({...initialTurnClientState(),turnId,phase:'requesting'});
    let state=initialTurnClientState(),resolution:TurnResolutionV1|null=null;
    try{
    assertPlayerActionsCanAdvance(base.simulation.queuedActions);
    const subdivisionCatalog=await readCatalogRegions(base.world,base.simulation.playerCountryId!,controller.signal);
    const context=buildSimulationContext({simulation:base.simulation,world:base.world,countrySearchProjection:input.countrySearchProjection,subdivisionCatalog,scenarioId:'2020-otl',scenarioStartDate:'2020-01-01',targetDate});
      await streamSimulationTurn({turnId,context},controller.signal,event=>{state=reduceHostTurnEvent(state,event);if(event.type==='resolution.ready')resolution=event.resolution;setTurn(state);});
      if(controller.signal.aborted||!resolution)return;
      if(input.runtime.getSnapshot()!==base)throw new Error('STALE_STATE');
      const regionIndex=await readResolutionRegionIndex(base.world,resolution,controller.signal);
      if(controller.signal.aborted)return;
      if(input.runtime.getSnapshot()!==base)throw Error('STALE_STATE');
      const plan=createCatalogTurnPlan({turnId,simulation:base.simulation,world:base.world,resolution,regionIndex,catalog:catalogContractForConsumer(input.metadata)});
      const next=input.runtime.commit(plan);input.syncPlayerCountry(next.simulation.playerCountryId);setReport(createCommittedTurnReport(plan));setTurn(markTurnCommitted(state));
    }catch(error){setTurn(s=>({...s,phase:controller.signal.aborted?'cancelled':'failed',draft:'',errorCode:controller.signal.aborted?'CANCELLED':error instanceof SimulationContractError?error.code:error instanceof Error?error.message:'NETWORK_ERROR'}));}
    finally{if(abort.current===controller)abort.current=null;}
  },[input]);
  return {snapshot,actionDraft,setActionDraft,queuedActions:snapshot.simulation.queuedActions.filter(isActivePlayerAction),turn,report,lifecycleNotice:null,running,canQueue:!running&&!!actionDraft.trim()&&activePlayerActionCount(snapshot.simulation.queuedActions)<MAX_ACTIVE_PLAYER_ACTIONS,canUndo:!running&&input.runtime.canUndo(),canRedo:!running&&input.runtime.canRedo(),queueAction,cancelAction,
    advance:(preset:TimeAdvancePreset)=>run({preset}),advanceToDate:(date:string)=>run({date}),stop:()=>abort.current?.abort(),retry:()=>run(last.current),undo:()=>{if(!running&&!abort.current){const restored=input.runtime.undo();input.syncPlayerCountry(restored.simulation.playerCountryId);setReport(null);setTurn(initialTurnClientState());}},redo:()=>{if(!running&&!abort.current){const restored=input.runtime.redo();input.syncPlayerCountry(restored.simulation.playerCountryId);setReport(null);setTurn(initialTurnClientState());}}};
}
