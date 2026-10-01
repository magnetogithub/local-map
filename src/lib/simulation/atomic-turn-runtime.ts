import {createWorldStateV2, type WorldStateV2} from "../world/world-state-v2";
import {
  assertSimulationStateInvariants,
  createSimulationStateV1,
  type SimulationStateV1,
} from "./simulation-state";
import type {ResolvedTurnPlan} from "./resolved-turn-plan";
import type {QueuedPlayerActionV1} from "./queued-player-action";

export type TurnRevisionPair = Readonly<{
  simulationRevision: number;
  worldRevision: number;
}>;

export type AtomicTurnSnapshot = Readonly<{
  simulation: SimulationStateV1;
  world: WorldStateV2;
  revisions: TurnRevisionPair;
}>;

export type CommittedTurnHistoryEntry = Readonly<{
  turnId: string;
  beforeSimulation: SimulationStateV1;
  afterSimulation: SimulationStateV1;
  beforeWorld: WorldStateV2;
  afterWorld: WorldStateV2;
  plan: ResolvedTurnPlan;
}>;

export type AtomicTurnNotification = Readonly<{
  kind: "commit" | "undo" | "redo";
  previous: AtomicTurnSnapshot;
  next: AtomicTurnSnapshot;
  turnId: string;
}>;

export type AtomicSubscriberFailure = Readonly<{
  kind: AtomicTurnNotification["kind"];
  turnId: string;
  subscriberIndex: number;
  message: string;
}>;

export type AtomicTurnRuntime = Readonly<{
  getSnapshot(): AtomicTurnSnapshot;
  getHistory(): Readonly<{entries: readonly CommittedTurnHistoryEntry[]; pointer: number}>;
  replacePendingActions(actions: readonly QueuedPlayerActionV1[]): AtomicTurnSnapshot;
  commit(plan: ResolvedTurnPlan, publishPair?: AtomicPairPublisher): AtomicTurnSnapshot;
  undo(publishPair?: AtomicPairPublisher): AtomicTurnSnapshot;
  redo(publishPair?: AtomicPairPublisher): AtomicTurnSnapshot;
  subscribe(subscriber: (notification: AtomicTurnNotification) => void): () => void;
  getSubscriberFailures(): readonly AtomicSubscriberFailure[];
}>;

export type AtomicPairPublisher = (
  next: AtomicTurnSnapshot,
  previous: AtomicTurnSnapshot,
  kind: AtomicTurnNotification["kind"],
  turnId: string,
) => void;

export type AtomicTurnRuntimeOptions = Readonly<{
  beforePublish?: (notification: AtomicTurnNotification) => void;
}>;

export class AtomicTurnCommitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AtomicTurnCommitError";
  }
}

const snapshot = (
  simulation: SimulationStateV1,
  world: WorldStateV2,
): AtomicTurnSnapshot => Object.freeze({
  simulation,
  world,
  revisions: Object.freeze({
    simulationRevision: simulation.revision,
    worldRevision: world.revision,
  }),
});

const restoreWorldWithNewRevision = (
  target: WorldStateV2,
  currentRevision: number,
) => createWorldStateV2({...target, revision: currentRevision + 1});

const restoreSimulationWithNewRevision = (
  target: SimulationStateV1,
  world: WorldStateV2,
  currentRevision: number,
) => createSimulationStateV1({...target, revision: currentRevision + 1}, world);

export function createAtomicTurnRuntime(
  initialSimulation: SimulationStateV1,
  initialWorld: WorldStateV2,
  options: AtomicTurnRuntimeOptions = {},
): AtomicTurnRuntime {
  assertSimulationStateInvariants(initialSimulation, initialWorld);
  let current = snapshot(initialSimulation, initialWorld);
  let entries: readonly CommittedTurnHistoryEntry[] = Object.freeze([]);
  let pointer = 0;
  const subscribers = new Set<(notification: AtomicTurnNotification) => void>();
  const subscriberFailures: AtomicSubscriberFailure[] = [];

  const publish = (
    kind: AtomicTurnNotification["kind"],
    turnId: string,
    next: AtomicTurnSnapshot,
    publishPair?: AtomicPairPublisher,
  ) => {
    const notification = Object.freeze({kind, previous: current, next, turnId});
    options.beforePublish?.(notification);
    const previous = current;
    current = next;
    try {
      publishPair?.(next, previous, kind, turnId);
    } catch (error) {
      current = previous;
      throw error;
    }
    [...subscribers].forEach((subscriber, subscriberIndex) => {
      try {
        subscriber(notification);
      } catch (error) {
        subscriberFailures.push(Object.freeze({
          kind,
          turnId,
          subscriberIndex,
          message: error instanceof Error ? error.message : String(error),
        }));
      }
    });
    return current;
  };

  return Object.freeze({
    getSnapshot: () => current,
    getHistory: () => Object.freeze({entries, pointer}),
    replacePendingActions(actions) {
      const simulation = createSimulationStateV1({
        ...current.simulation,
        queuedActions: actions,
      }, current.world);
      current = snapshot(simulation, current.world);
      return current;
    },
    commit(plan, publishPair) {
      if (
        current.simulation !== plan.baseSimulationState
        || current.world !== plan.baseWorldState
      ) {
        throw new AtomicTurnCommitError("ResolvedTurnPlan is stale for the current snapshot");
      }
      if (entries.slice(0, pointer).some((entry) => entry.turnId === plan.turnId)) {
        throw new AtomicTurnCommitError(`Turn has already been committed: ${plan.turnId}`);
      }
      const next = snapshot(plan.nextSimulationState, plan.nextWorldState);
      const entry = Object.freeze({
        turnId: plan.turnId,
        beforeSimulation: current.simulation,
        afterSimulation: next.simulation,
        beforeWorld: current.world,
        afterWorld: next.world,
        plan,
      });
      const nextEntries = Object.freeze([...entries.slice(0, pointer), entry]);
      const previousEntries = entries;
      const previousPointer = pointer;
      try {
        entries = nextEntries;
        pointer = nextEntries.length;
        const result = publish("commit", plan.turnId, next, publishPair);
        return result;
      } catch (error) {
        entries = previousEntries;
        pointer = previousPointer;
        throw error;
      }
    },
    undo(publishPair) {
      if (pointer <= 0) return current;
      const entry = entries[pointer - 1];
      const restoredWorld = restoreWorldWithNewRevision(
        entry.beforeWorld,
        current.world.revision,
      );
      const restoredSimulation = restoreSimulationWithNewRevision(
        entry.beforeSimulation,
        restoredWorld,
        current.simulation.revision,
      );
      const previousPointer = pointer;
      try {
        pointer -= 1;
        return publish("undo", entry.turnId, snapshot(restoredSimulation, restoredWorld), publishPair);
      } catch (error) {
        pointer = previousPointer;
        throw error;
      }
    },
    redo(publishPair) {
      if (pointer >= entries.length) return current;
      const entry = entries[pointer];
      const restoredWorld = restoreWorldWithNewRevision(
        entry.afterWorld,
        current.world.revision,
      );
      const restoredSimulation = restoreSimulationWithNewRevision(
        entry.afterSimulation,
        restoredWorld,
        current.simulation.revision,
      );
      const previousPointer = pointer;
      try {
        pointer += 1;
        return publish("redo", entry.turnId, snapshot(restoredSimulation, restoredWorld), publishPair);
      } catch (error) {
        pointer = previousPointer;
        throw error;
      }
    },
    subscribe(subscriber) {
      subscribers.add(subscriber);
      return () => subscribers.delete(subscriber);
    },
    getSubscriberFailures: () => Object.freeze([...subscriberFailures]),
  });
}

