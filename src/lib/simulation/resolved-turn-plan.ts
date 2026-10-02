import {calculateAffectedSet} from "../planning/affected-set";
import {planRuntimeCommand} from "../planning/command-ui-runtime";
import {buildWorldPatchV2, type WorldPatchV2} from "../planning/world-patch-v2";
import {canonicalSerialize} from "../world/canonical-serializer";
import {checkpointWorldContentHash} from "../planning/history-persistence-checkpoint";
import {sha256Hex} from "../world/sha256";
import type {ActiveCountryId} from "../world/country-id";
import {createWorldStateV2, type WorldStateV2} from "../world/world-state-v2";
import {createSimulationStateV1, type SimulationStateV1} from "./simulation-state";
import type {SimulationStateV2} from "./simulation-state-v2";
import {validateTurnResolution} from "./semantic-validator";
import {DEBUG_WORLD_EFFECT_PREFIX} from "./debug-world-effect";
import type {SubdivisionCatalog} from "./subdivision-catalog";
import type {TurnResolutionV1} from "./turn-resolution";
import {
  compileWorldEffects,
  createSequentialCommandIdAllocator,
  type CompiledWorldEffects,
} from "./world-effect-compiler";

export type TurnChangeSummary = Readonly<{
  eventCount: number;
  factMutationCount: number;
  situationMutationCount: number;
  scheduledConsequenceCount: number;
  worldEffectCount: number;
  commandCount: number;
  changedCountryIds: readonly string[];
  changedTerritoryIds: readonly string[];
}>;

export type ResolvedTurnPlan<
  Simulation extends SimulationStateV1 | SimulationStateV2 = SimulationStateV1,
  World extends Readonly<{revision: number}> = WorldStateV2,
> = Readonly<{
  kind: "resolved-turn-plan.v1";
  turnId: string;
  baseSimulationState: Simulation;
  baseWorldState: World;
  nextSimulationState: Simulation;
  nextWorldState: World;
  resolution: TurnResolutionV1;
  compiledWorldEffects: CompiledWorldEffects;
  worldPatch: WorldPatchV2 | null;
  beforeSimulationHash: string;
  afterSimulationHash: string;
  beforeWorldHash: string;
  afterWorldHash: string;
  changeSummary: TurnChangeSummary;
}>;

export class ResolvedTurnPlanError extends Error {
  readonly code: "INVALID_RESOLUTION" | "WORLD_PLANNING_FAILED" | "LIVE_STATE_MUTATED";

  constructor(
    code: "INVALID_RESOLUTION" | "WORLD_PLANNING_FAILED" | "LIVE_STATE_MUTATED",
    message: string,
  ) {
    super(message);
    this.name = "ResolvedTurnPlanError";
    this.code = code;
  }
}

const simulationHash = (state: SimulationStateV1) => sha256Hex(canonicalSerialize(state));

const canonicalOrder = (record: Readonly<Record<string, unknown>>) =>
  Object.freeze(Object.keys(record).sort());

function resolveNextPlayerCountry(
  simulation: SimulationStateV1,
  nextWorld: WorldStateV2,
  resolution: TurnResolutionV1,
  compiled: CompiledWorldEffects,
): ActiveCountryId {
  if (nextWorld.countriesById[simulation.playerCountryId]) return simulation.playerCountryId;
  for (const effect of resolution.worldEffects) {
    if (effect.type === "countries.unified" && effect.countryIds.includes(simulation.playerCountryId)) {
      const countryId = compiled.allocatedCountryIdsByLocalRef[effect.newCountryRef];
      if (countryId) return countryId;
    }
    if (
      effect.type === "country.dissolved"
      && effect.countryId === simulation.playerCountryId
      && effect.successorCountryId !== null
    ) {
      return effect.successorCountryId as ActiveCountryId;
    }
    if (
      effect.type === "country.partitionedBySubdivisions"
      && effect.sourceCountryId === simulation.playerCountryId
    ) {
      const first = effect.partitions[0];
      const countryId = first
        ? compiled.allocatedCountryIdsByLocalRef[first.newCountryRef]
        : undefined;
      if (countryId) return countryId;
    }
  }
  throw new ResolvedTurnPlanError(
    "WORLD_PLANNING_FAILED",
    "Turn retired the player country without a deterministic successor",
  );
}

function planNextSimulationState(
  turnId: string,
  current: SimulationStateV1,
  nextWorld: WorldStateV2,
  resolution: TurnResolutionV1,
  compiled: CompiledWorldEffects,
): SimulationStateV1 {
  const outcomeActionIds = new Set(
    resolution.playerActionOutcomes.map((outcome) => outcome.actionId),
  );
  const queuedActions = current.queuedActions.map((action) =>
    outcomeActionIds.has(action.actionId)
      ? Object.freeze({...action, status: "resolved" as const})
      : action);
  const factsById: Record<string, SimulationStateV1["factsById"][string]> = {
    ...current.factsById,
  };
  for (const mutation of resolution.factMutations) {
    if (mutation.operation === "upsert") factsById[mutation.fact.factId] = mutation.fact;
    else factsById[mutation.factId] = Object.freeze({
      ...factsById[mutation.factId],
      status: "ended",
    });
  }
  const situationsById: Record<string, SimulationStateV1["situationsById"][string]> = {
    ...current.situationsById,
  };
  for (const mutation of resolution.situationMutations) {
    if (mutation.operation === "upsert") {
      situationsById[mutation.situation.situationId] = mutation.situation;
    } else {
      situationsById[mutation.situationId] = Object.freeze({
        ...situationsById[mutation.situationId],
        status: "resolved",
        lastUpdatedByEventId: mutation.causedByEventId,
      });
    }
  }
  const consequenceById = new Map(
    current.scheduledConsequences.map((entry) => [entry.consequenceId, entry]),
  );
  resolution.scheduledConsequences.forEach((entry) =>
    consequenceById.set(entry.consequenceId, entry));
  const scheduledConsequences = [...consequenceById.values()].sort((left, right) =>
    left.earliestDate.localeCompare(right.earliestDate)
    || left.consequenceId.localeCompare(right.consequenceId));
  const nextPlayerCountryId = resolveNextPlayerCountry(
    current,
    nextWorld,
    resolution,
    compiled,
  );
  return createSimulationStateV1({
    ...current,
    revision: current.revision + 1,
    currentDate: resolution.period.endDate,
    turnNumber: current.turnNumber + 1,
    playerCountryId: nextPlayerCountryId,
    queuedActions,
    factsById,
    factOrder: canonicalOrder(factsById),
    situationsById,
    situationOrder: canonicalOrder(situationsById),
    scheduledConsequences,
    eventLog: [...current.eventLog, ...resolution.events],
    history: {
      lastCommittedTurnId: turnId,
      committedTurnCount: current.history.committedTurnCount + 1,
    },
  }, nextWorld);
}

export function createResolvedTurnPlan(input: Readonly<{
  turnId: string;
  simulation: SimulationStateV1;
  world: WorldStateV2;
  resolution: unknown;
  subdivisionCatalog: SubdivisionCatalog;
  committedCommandIds?: ReadonlySet<string>;
}>): ResolvedTurnPlan {
  const simulationIdentity = input.simulation;
  const worldIdentity = input.world;
  const beforeSimulationHash = simulationHash(input.simulation);
  const beforeWorldHash = checkpointWorldContentHash(input.world);
  const debugWorldEffectActionIds = new Set(input.simulation.queuedActions
    .filter((action) => (
      action.status === "queued" || action.status === "resolving"
    ) && action.text.startsWith(DEBUG_WORLD_EFFECT_PREFIX))
    .map((action) => action.actionId));
  const validation = validateTurnResolution(input.resolution, input.simulation, input.world, {
    debugWorldEffectActionIds,
  });
  if (!validation.ok || validation.resolution === null) {
    const first = validation.issues[0];
    throw new ResolvedTurnPlanError(
      "INVALID_RESOLUTION",
      first ? `${first.code}: ${first.message}` : "Resolution validation failed",
    );
  }
  const resolution = validation.resolution;
  const compiled = compileWorldEffects({
    effects: resolution.worldEffects,
    world: input.world,
    expectedWorldRevision: resolution.baseWorldRevision,
    subdivisionCatalog: input.subdivisionCatalog,
    allocator: createSequentialCommandIdAllocator(input.turnId),
    preferredUnifiedCountryId: input.simulation.playerCountryId,
  });
  let nextWorldState = input.world;
  let worldPatch: WorldPatchV2 | null = null;
  if (compiled.batch !== null) {
    const planned = planRuntimeCommand(
      input.world,
      compiled.batch,
      input.committedCommandIds ?? new Set(),
    );
    if (!planned.ok) {
      throw new ResolvedTurnPlanError(
        "WORLD_PLANNING_FAILED",
        `${planned.error.code}: ${planned.error.message}`,
      );
    }
    nextWorldState = createWorldStateV2({
      ...planned.plan.nextState,
      revision: input.world.revision + 1,
    });
    const affectedSet = calculateAffectedSet({
      beforeState: input.world,
      afterState: nextWorldState,
      patch: planned.plan.patch,
    });
    worldPatch = buildWorldPatchV2({
      commandId: compiled.batch.commandId,
      beforeState: input.world,
      afterState: nextWorldState,
      affectedSet,
      plannerPatch: planned.plan.patch,
    });
  }
  const nextSimulationState = planNextSimulationState(
    input.turnId,
    input.simulation,
    nextWorldState,
    resolution,
    compiled,
  );
  if (
    input.simulation !== simulationIdentity
    || input.world !== worldIdentity
    || simulationHash(input.simulation) !== beforeSimulationHash
    || checkpointWorldContentHash(input.world) !== beforeWorldHash
  ) {
    throw new ResolvedTurnPlanError("LIVE_STATE_MUTATED", "Dry-run mutated live state");
  }
  const changedCountryIds = worldPatch?.entityDeltas.countryIds ?? [];
  const changedTerritoryIds = worldPatch?.entityDeltas.territoryIds ?? [];
  return Object.freeze({
    kind: "resolved-turn-plan.v1",
    turnId: input.turnId,
    baseSimulationState: input.simulation,
    baseWorldState: input.world,
    nextSimulationState,
    nextWorldState,
    resolution,
    compiledWorldEffects: compiled,
    worldPatch,
    beforeSimulationHash,
    afterSimulationHash: simulationHash(nextSimulationState),
    beforeWorldHash,
    afterWorldHash: checkpointWorldContentHash(nextWorldState),
    changeSummary: Object.freeze({
      eventCount: resolution.events.length,
      factMutationCount: resolution.factMutations.length,
      situationMutationCount: resolution.situationMutations.length,
      scheduledConsequenceCount: resolution.scheduledConsequences.length,
      worldEffectCount: resolution.worldEffects.length,
      commandCount: compiled.commandCount,
      changedCountryIds: Object.freeze(changedCountryIds.slice(0, 64)),
      changedTerritoryIds: Object.freeze(changedTerritoryIds.slice(0, 128)),
    }),
  });
}

