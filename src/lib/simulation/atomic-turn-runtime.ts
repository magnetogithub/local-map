import {createWorldStateV2, type WorldStateV2} from "../world/world-state-v2";
import {checkpointWorldContentHash} from "../planning/history-persistence-checkpoint";
import {
  assertSimulationStateInvariants,
  createSimulationStateV1,
  type SimulationStateV1,
} from "./simulation-state";
import {
  createSimulationStateV2,
  simulationStateV2ContentHash,
  type SimulationStateV2,
  type SimulationAuthorityWorldReferences,
} from "./simulation-state-v2";
import type {ResolvedTurnPlan} from "./resolved-turn-plan";
import type {QueuedPlayerActionV1} from "./queued-player-action";

export type TurnRevisionPair = Readonly<{
  simulationRevision: number;
  worldRevision: number;
}>;

type AtomicSimulation = SimulationStateV1 | SimulationStateV2;

/** Geometry-free world port; V3 adapters remain test-only until production cutover. */
export type AtomicWorldReferences = SimulationAuthorityWorldReferences & Readonly<{
  schemaVersion: number;
  revision: number;
}>;

export type AtomicWorldPort<World extends AtomicWorldReferences> = Readonly<{
  validate(state: World): void;
  restoreWithRevision(state: World, revision: number): World;
  contentHash(state: World): string;
}>;

export type AtomicTurnSnapshot<Simulation extends AtomicSimulation = SimulationStateV1, World extends AtomicWorldReferences = WorldStateV2> = Readonly<{
  simulation: Simulation;
  world: World;
  revisions: TurnRevisionPair;
}>;

export type CommittedTurnHistoryEntry<Simulation extends AtomicSimulation = SimulationStateV1, World extends AtomicWorldReferences = WorldStateV2> = Readonly<{
  turnId: string;
  beforeSimulation: Simulation;
  afterSimulation: Simulation;
  beforeWorld: World;
  afterWorld: World;
  plan: ResolvedTurnPlan<Simulation, World>;
}>;

export type AtomicTurnNotification<Simulation extends AtomicSimulation = SimulationStateV1, World extends AtomicWorldReferences = WorldStateV2> = Readonly<{
  kind: "commit" | "undo" | "redo";
  previous: AtomicTurnSnapshot<Simulation, World>;
  next: AtomicTurnSnapshot<Simulation, World>;
  turnId: string;
}>;

export type AtomicSubscriberFailure = Readonly<{
  kind: AtomicTurnNotification["kind"];
  turnId: string;
  subscriberIndex: number;
  message: string;
}>;

export type AtomicTurnRuntime<Simulation extends AtomicSimulation = SimulationStateV1, World extends AtomicWorldReferences = WorldStateV2> = Readonly<{
  getSnapshot(): AtomicTurnSnapshot<Simulation, World>;
  getHistory(): Readonly<{entries: readonly CommittedTurnHistoryEntry<Simulation, World>[]; pointer: number}>;
  replacePendingActions(actions: readonly QueuedPlayerActionV1[]): AtomicTurnSnapshot<Simulation, World>;
  commit(plan: ResolvedTurnPlan<Simulation, World>, publishPair?: AtomicPairPublisher<Simulation, World>): AtomicTurnSnapshot<Simulation, World>;
  undo(publishPair?: AtomicPairPublisher<Simulation, World>): AtomicTurnSnapshot<Simulation, World>;
  redo(publishPair?: AtomicPairPublisher<Simulation, World>): AtomicTurnSnapshot<Simulation, World>;
  subscribe(subscriber: (notification: AtomicTurnNotification<Simulation, World>) => void): () => void;
  getSubscriberFailures(): readonly AtomicSubscriberFailure[];
}>;

export type AtomicPairPublisher<Simulation extends AtomicSimulation = SimulationStateV1, World extends AtomicWorldReferences = WorldStateV2> = (
  next: AtomicTurnSnapshot<Simulation, World>,
  previous: AtomicTurnSnapshot<Simulation, World>,
  kind: AtomicTurnNotification["kind"],
  turnId: string,
) => void;

export type AtomicTurnRuntimeOptions<Simulation extends AtomicSimulation = SimulationStateV1, World extends AtomicWorldReferences = WorldStateV2> = Readonly<{
  beforePublish?: (notification: AtomicTurnNotification<Simulation, World>) => void;
  worldPort?: AtomicWorldPort<World>;
}>;

export class AtomicTurnCommitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AtomicTurnCommitError";
  }
}

const snapshot = <Simulation extends AtomicSimulation, World extends AtomicWorldReferences = WorldStateV2>(
  simulation: Simulation,
  world: World,
): AtomicTurnSnapshot<Simulation, World> => Object.freeze({
  simulation,
  world,
  revisions: Object.freeze({
    simulationRevision: simulation.revision,
    worldRevision: world.revision,
  }),
});

const legacyWorldPort: AtomicWorldPort<WorldStateV2> = Object.freeze({
  validate: (state) => {createWorldStateV2(state);},
  restoreWithRevision: (state, revision) => createWorldStateV2({...state, revision}),
  contentHash: checkpointWorldContentHash,
});

const createRuntimeSimulation = <Simulation extends AtomicSimulation, World extends AtomicWorldReferences = WorldStateV2>(
  target: Simulation,
  world: World,
): Simulation => (target.schemaVersion === 2
  ? createSimulationStateV2(target, world)
  : createSimulationStateV1(target, world)) as Simulation;

const assertFrozenSimulation = (value: unknown): void => {
  if (value === null || typeof value !== "object") return;
  if (!Object.isFrozen(value)) {
    throw new AtomicTurnCommitError("Simulation V2 snapshots must be deeply immutable; use createSimulationStateV2");
  }
  Object.values(value).forEach(assertFrozenSimulation);
};

const restoreSimulationWithNewRevision = <Simulation extends AtomicSimulation, World extends AtomicWorldReferences = WorldStateV2>(
  target: Simulation,
  world: World,
  currentRevision: number,
) => createRuntimeSimulation({...target, revision: currentRevision + 1}, world);

export function createAtomicTurnRuntime<Simulation extends AtomicSimulation, World extends AtomicWorldReferences = WorldStateV2>(
  initialSimulation: Simulation,
  initialWorld: World,
  options: AtomicTurnRuntimeOptions<Simulation, World> = {},
): AtomicTurnRuntime<Simulation, World> {
  if (initialWorld.schemaVersion !== 2 && initialSimulation.schemaVersion !== 2) {
    throw new AtomicTurnCommitError("A migrated world requires Simulation V2 as one schema pair");
  }
  if (!options.worldPort && initialWorld.schemaVersion !== 2) {
    throw new AtomicTurnCommitError("A non-legacy world requires an explicit validation/restoration port");
  }
  const worldPort = options.worldPort
    ?? legacyWorldPort as unknown as AtomicWorldPort<World>;
  assertSimulationStateInvariants(initialSimulation, initialWorld);
  if (initialSimulation.schemaVersion === 2) {
    worldPort.validate(initialWorld);
    createSimulationStateV2(initialSimulation, initialWorld);
    assertFrozenSimulation(initialSimulation);
  }
  let current = snapshot(initialSimulation, initialWorld);
  let entries: readonly CommittedTurnHistoryEntry<Simulation, World>[] = Object.freeze([]);
  let pointer = 0;
  const subscribers = new Set<(notification: AtomicTurnNotification<Simulation, World>) => void>();
  const subscriberFailures: AtomicSubscriberFailure[] = [];

  const publish = (
    kind: AtomicTurnNotification["kind"],
    turnId: string,
    next: AtomicTurnSnapshot<Simulation, World>,
    publishPair?: AtomicPairPublisher<Simulation, World>,
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
      const simulation = createRuntimeSimulation({
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
      if (current.simulation.schemaVersion === 2) {
        if (plan.nextSimulationState.schemaVersion !== 2) {
          throw new AtomicTurnCommitError("A runtime cannot change simulation schema version");
        }
        if (plan.nextWorldState.schemaVersion !== current.world.schemaVersion) {
          throw new AtomicTurnCommitError("A runtime cannot change world schema version");
        }
        worldPort.validate(plan.nextWorldState);
        createSimulationStateV2(plan.nextSimulationState, plan.nextWorldState);
        assertFrozenSimulation(plan.nextSimulationState);
        if (plan.nextSimulationState.revision !== current.simulation.revision + 1
          || plan.nextWorldState.revision !== current.world.revision
            + (plan.nextWorldState === current.world ? 0 : 1)) {
          throw new AtomicTurnCommitError("Simulation V2 plan has an invalid next revision pair");
        }
        if (plan.beforeSimulationHash !== simulationStateV2ContentHash(current.simulation)
          || plan.afterSimulationHash !== simulationStateV2ContentHash(plan.nextSimulationState)
          || plan.beforeWorldHash !== worldPort.contentHash(current.world)
          || plan.afterWorldHash !== worldPort.contentHash(plan.nextWorldState)) {
          throw new AtomicTurnCommitError("Simulation V2 plan pair content hash mismatch");
        }
      } else if (plan.nextSimulationState.schemaVersion !== 1) {
        throw new AtomicTurnCommitError("A runtime cannot change simulation schema version");
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
      const restoredWorld = worldPort.restoreWithRevision(
        entry.beforeWorld,
        current.world.revision + 1,
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
      const restoredWorld = worldPort.restoreWithRevision(
        entry.afterWorld,
        current.world.revision + 1,
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

