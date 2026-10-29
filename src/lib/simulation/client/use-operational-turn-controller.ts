'use client';
import {useEffect, useRef, useState} from 'react';
import {useStore} from 'zustand';
import type {OperationalGameClient} from './operational-game-client';
import {OPERATIONAL_GAME_HEADER} from '../operational-game-protocol';
import {streamSimulationTurn} from './ndjson-turn-client';
import {initialTurnClientState, reduceHostTurnEvent, markTurnCommitted} from './turn-state-machine';
import {targetDateForPreset, targetDateForCustomInput, type TimeAdvancePreset} from './turn-request';
import {activePlayerActionCount, assertPlayerActionsCanAdvance, isActivePlayerAction} from '../queued-player-action';
import {MAX_ACTIVE_PLAYER_ACTIONS, SimulationContractError} from '../simulation-contract-primitives';

export function useOperationalTurnController(client: OperationalGameClient) {
  const snapshot = useStore(client.store, s => s);
  const [actionDraft, setActionDraft] = useState(''), [turn, setTurn] = useState(initialTurnClientState), [pending, setPending] = useState(false);
  const abort = useRef<AbortController | null>(null), active = useRef(false), last = useRef<{preset?: TimeAdvancePreset; date?: string} | null>(null);
  useEffect(() => () => abort.current?.abort(), []);
  const fail = (error: unknown, failureSource: 'command' | 'turn') => setTurn(s => ({...(failureSource === 'command' ? initialTurnClientState() : s), phase: 'failed', failureSource, draft: '', errorCode: error instanceof SimulationContractError ? error.code : error instanceof Error ? error.message : 'NETWORK_ERROR'}));
  const command = async (input: Parameters<OperationalGameClient['request']>[0]) => {
    if (active.current) return false;
    active.current = true; last.current = null; setPending(true);
    try {await client.request(input); setTurn(initialTurnClientState()); return true;}
    catch (error) {fail(error, 'command'); try {await client.read();} catch { /* Preserve the actionable command error. */ } return false;}
    finally {active.current = false; setPending(false);}
  };
  const run = async (selection: {preset?: TimeAdvancePreset; date?: string}) => {
    if (active.current) return;
    active.current = true; setPending(true); last.current = selection;
    const controller = new AbortController(); abort.current = controller;
    let state = initialTurnClientState(), turnId: string | undefined;
    setTurn({...state, phase: 'requesting'});
    try {
      const base = client.getSnapshot();
      assertPlayerActionsCanAdvance(base.simulation.queuedActions);
      const targetDate = selection.preset ? targetDateForPreset(base.simulation, selection.preset) : targetDateForCustomInput(base.simulation.currentDate, selection.date!);
      const prepared = await client.request({operation: 'prepare-turn', targetDate}); turnId = prepared.turnId;
      controller.signal.throwIfAborted();
      await streamSimulationTurn({turnId, context: prepared.context}, controller.signal, event => {state = reduceHostTurnEvent(state, event); setTurn(state);}, fetch, {[OPERATIONAL_GAME_HEADER]: client.sessionId});
      const next = await client.read();
      if (next.simulation.history.lastCommittedTurnId === turnId && state.phase === 'committing') {last.current = null; setTurn(markTurnCommitted(state));}
    } catch (error) {
      // A disconnect can happen after the atomic commit. Reconcile before exposing Retry.
      try {
        const next = await client.read();
        if (turnId && next.simulation.history.lastCommittedTurnId === turnId) {last.current = null; setTurn({...state, phase: 'committed', draft: '', errorCode: null}); return;}
      } catch { /* The previous visible pair stays intact until a successful read. */ }
      if (controller.signal.aborted) setTurn(s => ({...s, phase: 'cancelled', draft: '', errorCode: 'CANCELLED'})); else fail(error, 'turn');
    } finally {abort.current = null; active.current = false; setPending(false);}
  };
  return {snapshot, actionDraft, setActionDraft, queuedActions: snapshot.simulation.queuedActions.filter(isActivePlayerAction), turn, report: snapshot.report, lifecycleNotice: null,
    running: pending, canQueue: !pending && !!actionDraft.trim() && activePlayerActionCount(snapshot.simulation.queuedActions) < MAX_ACTIVE_PLAYER_ACTIONS, canUndo: !pending && snapshot.canUndo, canRedo: !pending && snapshot.canRedo,
    queueAction: () => {if (!active.current && actionDraft.trim() && activePlayerActionCount(client.getSnapshot().simulation.queuedActions) < MAX_ACTIVE_PLAYER_ACTIONS) void command({operation: 'queue', text: actionDraft}).then(queued => {if (queued) setActionDraft('');});},
    cancelAction: (actionId: string) => {void command({operation: 'cancel-action', actionId});},
    advance: (preset: TimeAdvancePreset) => run({preset}), advanceToDate: (date: string) => run({date}), stop: () => abort.current?.abort(),
    retry: async () => {if (last.current && (turn.phase === 'failed' || turn.phase === 'cancelled')) await run(last.current);},
    undo: () => {void command({operation: 'undo'});}, redo: () => {void command({operation: 'redo'});}};
}
