import type {ResolvedTurnPlan} from "../resolved-turn-plan";
import {
  createAtomicTurnRuntime,
  type AtomicTurnRuntime,
  type AtomicTurnSnapshot,
  type AtomicTurnNotification,
  type AtomicSubscriberFailure,
} from "../atomic-turn-runtime";
import type {QueuedPlayerActionV1} from "../queued-player-action";
import type {SimulationStateV1} from "../simulation-state";
import type {WorldStateV2} from "../../world/world-state-v2";
import {createWorldStateV2} from "../../world/world-state-v2";
import {createSimulationStateV1} from "../simulation-state";
import type {WorldStateStoreController} from "../../../stores/world-state-store";
import type {PersistedTurnSummary} from "../simulation-persistence";

export type ApplicationRuntimeRestoreState = Readonly<{
  summaries: readonly PersistedTurnSummary[];
  pointer: number;
  undo: AtomicTurnSnapshot | null;
  redo: AtomicTurnSnapshot | null;
}>;

export type ApplicationTurnRuntime = Readonly<{
  getSnapshot: AtomicTurnRuntime["getSnapshot"];
  getHistory: AtomicTurnRuntime["getHistory"];
  canUndo(): boolean;
  canRedo(): boolean;
  getPersistenceState(): ApplicationRuntimeRestoreState;
  replacePendingActions(actions: readonly QueuedPlayerActionV1[]): AtomicTurnSnapshot;
  commit(plan: ResolvedTurnPlan): AtomicTurnSnapshot;
  undo(): AtomicTurnSnapshot;
  redo(): AtomicTurnSnapshot;
  subscribe: AtomicTurnRuntime["subscribe"];
  getSubscriberFailures(): readonly AtomicSubscriberFailure[];
}>;

export function createApplicationTurnRuntime(
  initialSimulation: SimulationStateV1,
  initialWorld: WorldStateV2,
  worldController: WorldStateStoreController,
  restored: ApplicationRuntimeRestoreState = {summaries: [], pointer: 0, undo: null, redo: null},
): ApplicationTurnRuntime {
  let runtime = createAtomicTurnRuntime(initialSimulation, initialWorld);
  let summaries = Object.freeze([...restored.summaries]);
  let pointer = Math.min(restored.pointer, summaries.length);
  let persistedUndo = restored.undo;
  let persistedRedo = restored.redo;
  const subscribers = new Set<Parameters<AtomicTurnRuntime["subscribe"]>[0]>();
  const subscriberFailures: AtomicSubscriberFailure[] = [];
  const replaceRuntime = (next: AtomicTurnSnapshot) => {
    runtime = createAtomicTurnRuntime(next.simulation, next.world);
  };
  const notify = (notification: AtomicTurnNotification) => {
    [...subscribers].forEach((subscriber, subscriberIndex) => {
      try {
        subscriber(notification);
      } catch (error) {
        subscriberFailures.push(Object.freeze({
          kind: notification.kind,
          turnId: notification.turnId,
          subscriberIndex,
          message: error instanceof Error ? error.message : String(error),
        }));
      }
    });
  };
  const coordinate = (
    operation: (publisher: Parameters<AtomicTurnRuntime["commit"]>[1]) => AtomicTurnSnapshot,
  ) => operation((next, _previous, kind, turnId) => {
    worldController.preflightSimulationSnapshot(next.world);
    worldController.publishSimulationSnapshot(next.world, turnId, kind);
  });
  const restorePair = (target: AtomicTurnSnapshot, kind: "undo" | "redo") => {
    const current = runtime.getSnapshot();
    const world = createWorldStateV2({...target.world, revision: current.world.revision + 1});
    const simulation = createSimulationStateV1({...target.simulation, revision: current.simulation.revision + 1}, world);
    const next = Object.freeze({
      simulation,
      world,
      revisions: Object.freeze({simulationRevision: simulation.revision, worldRevision: world.revision}),
    });
    worldController.preflightSimulationSnapshot(world);
    worldController.publishSimulationSnapshot(world, `restored.${pointer}`, kind);
    replaceRuntime(next);
    return next;
  };
  const summaryFor = (plan: ResolvedTurnPlan): PersistedTurnSummary => Object.freeze({
    turnId: plan.turnId,
    startDate: plan.resolution.period.startDate,
    endDate: plan.resolution.period.endDate,
    advisorSummary: plan.resolution.advisorSummary,
    simulationRevision: plan.nextSimulationState.revision,
    worldRevision: plan.nextWorldState.revision,
    worldEffectCount: plan.resolution.worldEffects.length,
  });
  return Object.freeze({
    getSnapshot: () => runtime.getSnapshot(),
    getHistory: () => runtime.getHistory(),
    canUndo: () => runtime.getHistory().pointer > 0 || persistedUndo !== null,
    canRedo: () => runtime.getHistory().pointer < runtime.getHistory().entries.length || persistedRedo !== null,
    getPersistenceState: () => Object.freeze({summaries, pointer, undo: persistedUndo, redo: persistedRedo}),
    replacePendingActions: (actions) => runtime.replacePendingActions(actions),
    commit: (plan) => {
      worldController.preflightSimulationSnapshot(plan.nextWorldState);
      const before = runtime.getSnapshot();
      const next = coordinate((publisher) => runtime.commit(plan, publisher));
      summaries = Object.freeze([...summaries.slice(0, pointer), summaryFor(plan)]);
      pointer = summaries.length;
      persistedUndo = before;
      persistedRedo = null;
      notify(Object.freeze({kind: "commit", previous: before, next, turnId: plan.turnId}));
      return next;
    },
    undo: () => {
      const current = runtime.getSnapshot();
      const history = runtime.getHistory();
      const next = history.pointer > 0
        ? coordinate((publisher) => runtime.undo(publisher))
        : persistedUndo ? restorePair(persistedUndo, "undo") : current;
      if (next !== current) {
        persistedRedo = current;
        persistedUndo = null;
        pointer = Math.max(0, pointer - 1);
        notify(Object.freeze({kind: "undo", previous: current, next, turnId: `undo.${pointer}`}));
      }
      return next;
    },
    redo: () => {
      const current = runtime.getSnapshot();
      const history = runtime.getHistory();
      const next = history.pointer < history.entries.length
        ? coordinate((publisher) => runtime.redo(publisher))
        : persistedRedo ? restorePair(persistedRedo, "redo") : current;
      if (next !== current) {
        persistedUndo = current;
        persistedRedo = null;
        pointer = Math.min(summaries.length, pointer + 1);
        notify(Object.freeze({kind: "redo", previous: current, next, turnId: `redo.${pointer}`}));
      }
      return next;
    },
    subscribe(subscriber) {
      subscribers.add(subscriber);
      return () => subscribers.delete(subscriber);
    },
    getSubscriberFailures: () => Object.freeze([...subscriberFailures]),
  });
}
