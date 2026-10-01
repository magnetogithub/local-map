import {z} from "zod";

import {canonicalStringify} from "../world/canonical-serializer";
import {checkpointWorldContentHash} from "../planning/history-persistence-checkpoint";
import {
  deserializeWorldStateV2,
  serializeWorldStateV2,
  type SerializedWorldStateV2,
  type WorldStateV2,
} from "../world/world-state-v2";
import type {
  AtomicTurnRuntime,
  AtomicTurnSnapshot,
  CommittedTurnHistoryEntry,
} from "./atomic-turn-runtime";
import {
  createSimulationStateV1,
  simulationStateSchema,
  type SimulationStateV1,
} from "./simulation-state";
import {assertSafeSimulationData, simulationIdSchema} from "./simulation-contract-primitives";
import {sha256Hex} from "../world/sha256";

export const SIMULATION_SAVE_SCHEMA_VERSION = 1 as const;
export const MAX_PERSISTED_TURN_HISTORY = 50;
export const GAME_RUNTIME_SAVE_SCHEMA_VERSION = 1 as const;
export const GAME_RUNTIME_STORAGE_KEY = "pax-local:game-runtime:v1";
export const MAX_GAME_RUNTIME_SAVE_BYTES = 64 * 1024 * 1024;

const persistedTurnSummarySchema = z.strictObject({
  turnId: simulationIdSchema,
  startDate: z.string(),
  endDate: z.string(),
  advisorSummary: z.string().max(1_200),
  simulationRevision: z.number().int().nonnegative(),
  worldRevision: z.number().int().nonnegative(),
  worldEffectCount: z.number().int().nonnegative(),
});

const simulationSaveSchema = z.strictObject({
  schemaVersion: z.literal(SIMULATION_SAVE_SCHEMA_VERSION),
  simulation: simulationStateSchema,
  worldLink: z.strictObject({
    schemaVersion: z.literal(2),
    seedVersion: z.string().min(1),
    revision: z.number().int().nonnegative(),
    contentHash: z.string().regex(/^[a-f0-9]{64}$/),
  }),
  turnHistory: z.array(persistedTurnSummarySchema).max(MAX_PERSISTED_TURN_HISTORY),
});

export type PersistedTurnSummary = z.infer<typeof persistedTurnSummarySchema>;

export type RestoredSimulationRuntime = Readonly<{
  simulation: SimulationStateV1;
  world: WorldStateV2;
  turnHistory: readonly PersistedTurnSummary[];
  recoveredFromCorrupt: boolean;
}>;

const summarizeHistory = (
  entries: readonly CommittedTurnHistoryEntry[],
): readonly PersistedTurnSummary[] => Object.freeze(
  entries.slice(-MAX_PERSISTED_TURN_HISTORY).map((entry) => Object.freeze({
    turnId: entry.turnId,
    startDate: entry.plan.resolution.period.startDate,
    endDate: entry.plan.resolution.period.endDate,
    advisorSummary: entry.plan.resolution.advisorSummary,
    simulationRevision: entry.afterSimulation.revision,
    worldRevision: entry.afterWorld.revision,
    worldEffectCount: entry.plan.resolution.worldEffects.length,
  })),
);

export function serializeSimulationRuntime(input: Readonly<{
  simulation: SimulationStateV1;
  world: WorldStateV2;
  turnHistory: readonly CommittedTurnHistoryEntry[];
}>): string {
  const save = simulationSaveSchema.parse({
    schemaVersion: SIMULATION_SAVE_SCHEMA_VERSION,
    simulation: input.simulation,
    worldLink: {
      schemaVersion: input.world.schemaVersion,
      seedVersion: input.world.seedVersion,
      revision: input.world.revision,
      contentHash: checkpointWorldContentHash(input.world),
    },
    turnHistory: summarizeHistory(input.turnHistory),
  });
  return canonicalStringify(save);
}

export function restoreSimulationRuntime(
  raw: string | null,
  currentWorld: WorldStateV2,
  fallbackSimulation: SimulationStateV1,
): RestoredSimulationRuntime {
  const fallback = Object.freeze({
    simulation: fallbackSimulation,
    world: currentWorld,
    turnHistory: Object.freeze([]),
    recoveredFromCorrupt: true,
  });
  if (!raw) return fallback;
  try {
    const input = JSON.parse(raw) as unknown;
    assertSafeSimulationData(input);
    const save = simulationSaveSchema.parse(input);
    if (
      save.worldLink.seedVersion !== currentWorld.seedVersion
      || save.worldLink.revision !== currentWorld.revision
      || save.worldLink.contentHash !== checkpointWorldContentHash(currentWorld)
    ) {
      return fallback;
    }
    return Object.freeze({
      simulation: createSimulationStateV1(save.simulation, currentWorld),
      world: currentWorld,
      turnHistory: Object.freeze(save.turnHistory.map((entry) => Object.freeze(entry))),
      recoveredFromCorrupt: false,
    });
  } catch {
    return fallback;
  }
}

const persistedStatePairSchema = z.strictObject({
  simulation: simulationStateSchema,
  world: z.unknown(),
  revisions: z.strictObject({
    simulationRevision: z.number().int().nonnegative(),
    worldRevision: z.number().int().nonnegative(),
  }),
  worldContentHash: z.string().regex(/^[a-f0-9]{64}$/),
});

const gameRuntimeSaveSchema = z.strictObject({
  schemaVersion: z.literal(GAME_RUNTIME_SAVE_SCHEMA_VERSION),
  playerCountryId: z.string().min(3).max(3),
  current: persistedStatePairSchema,
  history: z.strictObject({
    summaries: z.array(persistedTurnSummarySchema).max(MAX_PERSISTED_TURN_HISTORY),
    pointer: z.number().int().nonnegative(),
    undo: z.union([persistedStatePairSchema, z.null()]),
    redo: z.union([persistedStatePairSchema, z.null()]),
  }),
  saveHash: z.string().regex(/^[a-f0-9]{64}$/),
});

type PersistedStatePair = z.infer<typeof persistedStatePairSchema>;
export type RestoredGameRuntimeSave = Readonly<{
  current: AtomicTurnSnapshot;
  turnHistory: readonly PersistedTurnSummary[];
  historyPointer: number;
  undo: AtomicTurnSnapshot | null;
  redo: AtomicTurnSnapshot | null;
  recoveredFromCorrupt: boolean;
}>;

const persistPair = (simulation: SimulationStateV1, world: WorldStateV2): PersistedStatePair => persistedStatePairSchema.parse({
  simulation,
  world: serializeWorldStateV2(world),
  revisions: {simulationRevision: simulation.revision, worldRevision: world.revision},
  worldContentHash: checkpointWorldContentHash(world),
});

const hashCanonical = (value: unknown) =>
  sha256Hex(new TextEncoder().encode(canonicalStringify(value)));

const pairHashInput = (pair: PersistedStatePair) => ({
  revisions: pair.revisions,
  worldContentHash: pair.worldContentHash,
  simulation: pair.simulation,
});

export function serializeGameRuntimeSave(runtime: AtomicTurnRuntime): string {
  const current = runtime.getSnapshot();
  const history = runtime.getHistory();
  const applicationState = "getPersistenceState" in runtime
    ? (runtime as AtomicTurnRuntime & {getPersistenceState(): Readonly<{summaries: readonly PersistedTurnSummary[]; pointer: number; undo: AtomicTurnSnapshot | null; redo: AtomicTurnSnapshot | null}>}).getPersistenceState()
    : null;
  const undoEntry = history.pointer > 0 ? history.entries[history.pointer - 1] : null;
  const redoEntry = history.pointer < history.entries.length ? history.entries[history.pointer] : null;
  const currentPair = persistPair(current.simulation, current.world);
  const saveWithoutHash = {
    schemaVersion: GAME_RUNTIME_SAVE_SCHEMA_VERSION,
    playerCountryId: current.simulation.playerCountryId,
    current: currentPair,
    history: {
      summaries: applicationState?.summaries ?? summarizeHistory(history.entries),
      pointer: applicationState?.pointer ?? history.pointer,
      undo: applicationState?.undo
        ? persistPair(applicationState.undo.simulation, applicationState.undo.world)
        : undoEntry ? persistPair(undoEntry.beforeSimulation, undoEntry.beforeWorld) : null,
      redo: applicationState?.redo
        ? persistPair(applicationState.redo.simulation, applicationState.redo.world)
        : redoEntry ? persistPair(redoEntry.afterSimulation, redoEntry.afterWorld) : null,
    },
  };
  const save = gameRuntimeSaveSchema.parse({
    ...saveWithoutHash,
    saveHash: hashCanonical({
      playerCountryId: saveWithoutHash.playerCountryId,
      current: pairHashInput(currentPair),
      historyPointer: applicationState?.pointer ?? history.pointer,
    }),
  });
  const serialized = canonicalStringify(save);
  if (new TextEncoder().encode(serialized).byteLength > MAX_GAME_RUNTIME_SAVE_BYTES) {
    throw new Error("SIMULATION_SAVE_QUOTA_EXCEEDED");
  }
  return serialized;
}

const restorePair = (raw: PersistedStatePair): AtomicTurnSnapshot => {
  const world = deserializeWorldStateV2(raw.world as SerializedWorldStateV2);
  if (
    world.revision !== raw.revisions.worldRevision
    || checkpointWorldContentHash(world) !== raw.worldContentHash
  ) throw new Error("Saved world revision or content hash mismatch");
  const simulation = createSimulationStateV1(raw.simulation, world);
  if (simulation.revision !== raw.revisions.simulationRevision) {
    throw new Error("Saved simulation revision mismatch");
  }
  return Object.freeze({simulation, world, revisions: Object.freeze({...raw.revisions})});
};

export function restoreGameRuntimeSave(
  raw: string | null,
  fallbackWorld: WorldStateV2,
  fallbackSimulation: SimulationStateV1,
): RestoredGameRuntimeSave {
  const fallback = Object.freeze({
    current: Object.freeze({
      simulation: fallbackSimulation,
      world: fallbackWorld,
      revisions: Object.freeze({simulationRevision: fallbackSimulation.revision, worldRevision: fallbackWorld.revision}),
    }),
    turnHistory: Object.freeze([]),
    historyPointer: 0,
    undo: null,
    redo: null,
    recoveredFromCorrupt: true,
  });
  if (!raw) return fallback;
  try {
    if (new TextEncoder().encode(raw).byteLength > MAX_GAME_RUNTIME_SAVE_BYTES) return fallback;
    const input = JSON.parse(raw) as unknown;
    assertSafeSimulationData(input);
    const save = gameRuntimeSaveSchema.parse(input);
    const expectedHash = hashCanonical({
      playerCountryId: save.playerCountryId,
      current: pairHashInput(save.current),
      historyPointer: save.history.pointer,
    });
    if (save.saveHash !== expectedHash) return fallback;
    const current = restorePair(save.current);
    if (current.simulation.playerCountryId !== save.playerCountryId) return fallback;
    return Object.freeze({
      current,
      turnHistory: Object.freeze(save.history.summaries.map((entry) => Object.freeze(entry))),
      historyPointer: save.history.pointer,
      undo: save.history.undo ? restorePair(save.history.undo) : null,
      redo: save.history.redo ? restorePair(save.history.redo) : null,
      recoveredFromCorrupt: false,
    });
  } catch {
    return fallback;
  }
}

