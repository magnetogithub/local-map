"use client";

import {useCallback, useEffect, useMemo, useRef, useState} from "react";

import type {CountrySearchProjection} from "@/lib/projection/country-search-index-patch";
import type {AtomicTurnSnapshot} from "@/lib/simulation/atomic-turn-runtime";
import {
  createApplicationTurnRuntime,
  type ApplicationTurnRuntime,
} from "@/lib/simulation/client/application-turn-runtime";
import {streamSimulationTurn} from "@/lib/simulation/client/ndjson-turn-client";
import {createCommittedTurnReport, type TurnReport} from "@/lib/simulation/client/turn-report";
import {
  buildFrozenTurnRequest,
  targetDateForCustomInput,
  targetDateForPreset,
  type TimeAdvancePreset,
} from "@/lib/simulation/client/turn-request";
import {
  initialTurnClientState,
  markTurnCommitted,
  reduceHostTurnEvent,
  type TurnClientState,
} from "@/lib/simulation/client/turn-state-machine";
import {createInitialSimulationState} from "@/lib/simulation/initial-simulation-state";
import {cancelQueuedPlayerAction, queuePlayerAction} from "@/lib/simulation/queued-player-action";
import {createResolvedTurnPlan} from "@/lib/simulation/resolved-turn-plan";
import {
  createProductionSubdivisionCatalog,
  type SerializedProductionSubdivisionCatalog,
} from "@/lib/simulation/subdivision-catalog";
import type {TurnResolutionV1} from "@/lib/simulation/turn-resolution";
import type {ActiveCountryId} from "@/lib/world/country-id";
import type {WorldStateStoreController} from "@/stores/world-state-store";

type AdvanceSelection =
  | Readonly<{kind: "preset"; preset: TimeAdvancePreset}>
  | Readonly<{kind: "custom"; targetDate: string}>;

export type SimulationTurnController = Readonly<{
  snapshot: AtomicTurnSnapshot | null;
  actionDraft: string;
  setActionDraft(value: string): void;
  queuedActions: AtomicTurnSnapshot["simulation"]["queuedActions"];
  turn: TurnClientState;
  report: TurnReport | null;
  lifecycleNotice: string | null;
  running: boolean;
  canQueue: boolean;
  canUndo: boolean;
  canRedo: boolean;
  queueAction(): void;
  cancelAction(actionId: string): void;
  advance(preset: TimeAdvancePreset): Promise<void>;
  advanceToDate(targetDate: string): Promise<void>;
  stop(): void;
  retry(): Promise<void>;
  undo(): void;
  redo(): void;
}>;

type Options = Readonly<{
  worldController: WorldStateStoreController;
  countrySearchProjection: CountrySearchProjection;
  serializedSubdivisionCatalog: SerializedProductionSubdivisionCatalog;
  playerCountryId: ActiveCountryId | null;
  syncPlayerCountry(countryId: ActiveCountryId): void;
  streamTurn?: typeof streamSimulationTurn;
}>;

const RUNNING_PHASES: ReadonlySet<TurnClientState["phase"]> = new Set([
  "requesting",
  "looking_up",
  "repairing",
  "committing",
]);

export function useSimulationTurnController({
  worldController,
  countrySearchProjection,
  serializedSubdivisionCatalog,
  playerCountryId,
  syncPlayerCountry,
  streamTurn = streamSimulationTurn,
}: Options): SimulationTurnController {
  const subdivisionCatalog = useMemo(
    () => createProductionSubdivisionCatalog(serializedSubdivisionCatalog),
    [serializedSubdivisionCatalog],
  );
  const runtimeRef = useRef<ApplicationTurnRuntime | null>(null);
  const seedWorldRef = useRef(worldController.getState());
  const abortRef = useRef<AbortController | null>(null);
  const actionSequence = useRef(0);
  const lastAdvance = useRef<AdvanceSelection>({kind: "preset", preset: "month"});
  const [snapshot, setSnapshot] = useState<AtomicTurnSnapshot | null>(null);
  const [actionDraft, setActionDraft] = useState("");
  const [turn, setTurn] = useState(initialTurnClientState);
  const [report, setReport] = useState<TurnReport | null>(null);
  const [lifecycleNotice, setLifecycleNotice] = useState<string | null>(null);

  const activeSnapshot = snapshot ?? runtimeRef.current?.getSnapshot() ?? null;
  const running = RUNNING_PHASES.has(turn.phase);

  useEffect(() => {
    if (
      playerCountryId
      && runtimeRef.current?.getSnapshot().simulation.playerCountryId === playerCountryId
    ) return;

    abortRef.current?.abort();
    runtimeRef.current = null;
    setSnapshot(null);
    setReport(null);
    setTurn(initialTurnClientState());
    if (!playerCountryId) {
      setLifecycleNotice(null);
      return;
    }

    const seedWorld = seedWorldRef.current;
    const fallbackCountryId = seedWorld.countriesById[playerCountryId]
      ? playerCountryId
      : seedWorld.countryOrder[0];
    const simulation = createInitialSimulationState(seedWorld, fallbackCountryId);
    if (fallbackCountryId !== playerCountryId) syncPlayerCountry(fallbackCountryId);
    const runtime = createApplicationTurnRuntime(simulation, seedWorld, worldController);
    runtimeRef.current = runtime;
    worldController.hydrateSimulationSnapshot(seedWorld);
    setSnapshot(runtime.getSnapshot());
    setLifecycleNotice("선택한 국가로 새 시뮬레이션을 시작했습니다.");
    return () => abortRef.current?.abort();
  }, [playerCountryId, syncPlayerCountry, worldController]);

  const queueAction = useCallback(() => {
    const runtime = runtimeRef.current;
    if (!runtime || running || !actionDraft.trim()) return;
    const current = runtime.getSnapshot();
    actionSequence.current += 1;
    const actions = queuePlayerAction(current.simulation.queuedActions, {
      actionId: `action.${current.simulation.turnNumber}.${actionSequence.current}`,
      playerCountryId: current.simulation.playerCountryId,
      submittedAtDate: current.simulation.currentDate,
      text: actionDraft,
    });
    setSnapshot(runtime.replacePendingActions(actions));
    setActionDraft("");
  }, [actionDraft, running]);

  const cancelAction = useCallback((actionId: string) => {
    const runtime = runtimeRef.current;
    if (!runtime || running) return;
    const current = runtime.getSnapshot();
    setSnapshot(runtime.replacePendingActions(cancelQueuedPlayerAction(
      current.simulation.queuedActions,
      actionId,
      current.simulation.playerCountryId,
    )));
  }, [running]);

  const runAdvance = useCallback(async (selection: AdvanceSelection) => {
    const runtime = runtimeRef.current;
    if (!runtime || running || abortRef.current !== null) return;
    const base = runtime.getSnapshot();
    const targetDate = selection.kind === "preset"
      ? targetDateForPreset(base.simulation, selection.preset)
      : targetDateForCustomInput(base.simulation.currentDate, selection.targetDate);
    const turnId = `turn.${base.simulation.turnNumber + 1}.${base.simulation.revision}`;
    const request = buildFrozenTurnRequest({
      turnId,
      targetDate,
      simulation: base.simulation,
      world: base.world,
      countrySearchProjection,
      subdivisionCatalog,
      scenarioId: "2020-otl",
      scenarioStartDate: "2020-01-01",
    });
    const controller = new AbortController();
    abortRef.current = controller;
    lastAdvance.current = selection;
    setReport(null);
    setTurn(Object.freeze({...initialTurnClientState(), turnId, phase: "requesting"}));
    let localState = initialTurnClientState();
    let resolution: TurnResolutionV1 | null = null;
    try {
      await streamTurn(
        {turnId: request.turnId, context: request.context},
        controller.signal,
        (event) => {
          localState = reduceHostTurnEvent(localState, event);
          if (event.type === "resolution.ready") resolution = event.resolution;
          setTurn(localState);
        },
      );
      if (!resolution || controller.signal.aborted) return;
      const current = runtime.getSnapshot();
      if (
        current.revisions.simulationRevision !== request.revisions.simulation
        || current.revisions.worldRevision !== request.revisions.world
      ) throw new Error("STALE_STATE");
      const plan = createResolvedTurnPlan({
        turnId,
        simulation: current.simulation,
        world: current.world,
        resolution,
        subdivisionCatalog,
      });
      const next = runtime.commit(plan);
      syncPlayerCountry(next.simulation.playerCountryId);
      setSnapshot(next);
      setReport(createCommittedTurnReport(plan));
      setTurn(markTurnCommitted(localState));
    } catch (error) {
      if (controller.signal.aborted) {
        setTurn((state) => Object.freeze({
          ...state,
          phase: "cancelled",
          draft: "",
          errorCode: "CANCELLED",
        }));
      } else {
        setTurn((state) => Object.freeze({
          ...state,
          phase: "failed",
          draft: "",
          errorCode: error instanceof Error ? error.message : "NETWORK_ERROR",
        }));
      }
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
    }
  }, [countrySearchProjection, running, streamTurn, subdivisionCatalog, syncPlayerCountry]);

  const advance = useCallback(
    (preset: TimeAdvancePreset) => runAdvance({kind: "preset", preset}),
    [runAdvance],
  );
  const advanceToDate = useCallback(
    (targetDate: string) => runAdvance({kind: "custom", targetDate}),
    [runAdvance],
  );
  const stop = useCallback(() => abortRef.current?.abort(), []);
  const retry = useCallback(() => runAdvance(lastAdvance.current), [runAdvance]);

  const undo = useCallback(() => {
    const runtime = runtimeRef.current;
    if (!runtime || running || !runtime.canUndo()) return;
    const next = runtime.undo();
    syncPlayerCountry(next.simulation.playerCountryId);
    setSnapshot(next);
    setReport(null);
    setTurn(initialTurnClientState());
  }, [running, syncPlayerCountry]);

  const redo = useCallback(() => {
    const runtime = runtimeRef.current;
    if (!runtime || running || !runtime.canRedo()) return;
    const next = runtime.redo();
    syncPlayerCountry(next.simulation.playerCountryId);
    setSnapshot(next);
    setReport(null);
    setTurn(initialTurnClientState());
  }, [running, syncPlayerCountry]);

  return Object.freeze({
    snapshot: activeSnapshot,
    actionDraft,
    setActionDraft,
    queuedActions: activeSnapshot?.simulation.queuedActions.filter((action) => action.status === "queued") ?? [],
    turn,
    report,
    lifecycleNotice,
    running,
    canQueue: !running && actionDraft.trim().length > 0,
    canUndo: !running && (runtimeRef.current?.canUndo() ?? false),
    canRedo: !running && (runtimeRef.current?.canRedo() ?? false),
    queueAction,
    cancelAction,
    advance,
    advanceToDate,
    stop,
    retry,
    undo,
    redo,
  });
}
