import {z} from "zod";

import type {ActiveCountryId} from "../world/country-id";
import {
  activeSituationSchema,
  scheduledConsequenceSchema,
  simulationFactSchema,
  type ActiveSituationV1,
  type ScheduledConsequenceV1,
  type SimulationFactV1,
} from "./narrative-state";
import {queuedPlayerActionSchema, type QueuedPlayerActionV1} from "./queued-player-action";
import {simulationEventSchema, type SimulationEventV1} from "./simulation-event";
import {
  countryIdSchema,
  assertSafeSimulationData,
  isoCalendarDateSchema,
  SIMULATION_STATE_SCHEMA_VERSION,
  simulationIdSchema,
} from "./simulation-contract-primitives";

export const simulationHistoryMetadataSchema = z.strictObject({
  lastCommittedTurnId: z.union([simulationIdSchema, z.null()]),
  committedTurnCount: z.number().int().nonnegative(),
});

export const simulationStateSchema = z.strictObject({
  schemaVersion: z.literal(SIMULATION_STATE_SCHEMA_VERSION),
  revision: z.number().int().nonnegative(),
  currentDate: isoCalendarDateSchema,
  turnNumber: z.number().int().nonnegative(),
  playerCountryId: countryIdSchema,
  queuedActions: z.array(queuedPlayerActionSchema).max(128),
  factsById: z.record(simulationIdSchema, simulationFactSchema),
  factOrder: z.array(simulationIdSchema).max(512),
  situationsById: z.record(simulationIdSchema, activeSituationSchema),
  situationOrder: z.array(simulationIdSchema).max(256),
  scheduledConsequences: z.array(scheduledConsequenceSchema).max(256),
  eventLog: z.array(simulationEventSchema).max(2_048),
  history: simulationHistoryMetadataSchema,
});

export type SimulationStateV1 = Readonly<{
  schemaVersion: typeof SIMULATION_STATE_SCHEMA_VERSION;
  revision: number;
  currentDate: string;
  turnNumber: number;
  playerCountryId: ActiveCountryId;
  queuedActions: readonly QueuedPlayerActionV1[];
  factsById: Readonly<Record<string, SimulationFactV1>>;
  factOrder: readonly string[];
  situationsById: Readonly<Record<string, ActiveSituationV1>>;
  situationOrder: readonly string[];
  scheduledConsequences: readonly ScheduledConsequenceV1[];
  eventLog: readonly SimulationEventV1[];
  history: Readonly<{lastCommittedTurnId: string | null; committedTurnCount: number}>;
}>;

/** Geometry-free reference port shared by the schema migration engines. */
export type SimulationWorldReferences = Readonly<{
  countriesById: Readonly<Record<string, unknown>>;
  retiredCountryIds: Iterable<string>;
}>;

export const parseSimulationStateV1 = (input: unknown): SimulationStateV1 => {
  assertSafeSimulationData(input);
  return freezeSimulationValue(
    simulationStateSchema.parse(input),
  ) as unknown as SimulationStateV1;
};

export function freezeSimulationValue<Value>(value: Value): Value {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  if (Array.isArray(value)) {
    value.forEach((entry) => freezeSimulationValue(entry));
    return Object.freeze(value);
  }
  Object.values(value).forEach((entry) => freezeSimulationValue(entry));
  return Object.freeze(value);
}

export const assertExactSimulationOrder = (
  record: Readonly<Record<string, unknown>>,
  order: readonly string[],
  context: string,
) => {
  const expected = Object.keys(record).sort();
  if (
    order.length !== expected.length
    || order.some((id, index) => id !== expected[index])
  ) {
    throw new Error(`${context} order must contain every id exactly once in canonical order`);
  }
};

export function assertSimulationStateInvariants(
  state: Omit<SimulationStateV1, "schemaVersion">,
  world: SimulationWorldReferences,
): void {
  const activeCountryIds = new Set(Object.keys(world.countriesById));
  const knownCountryIds = new Set<string>([
    ...activeCountryIds,
    ...world.retiredCountryIds,
  ]);
  if (!activeCountryIds.has(state.playerCountryId)) {
    throw new Error(`Simulation player country is not active: ${state.playerCountryId}`);
  }
  assertExactSimulationOrder(state.factsById, state.factOrder, "Simulation fact");
  assertExactSimulationOrder(state.situationsById, state.situationOrder, "Simulation situation");

  const actionIds = new Set<string>();
  for (const action of state.queuedActions) {
    if (actionIds.has(action.actionId)) throw new Error(`Duplicate action id: ${action.actionId}`);
    actionIds.add(action.actionId);
    if (action.submittedAtDate > state.currentDate) {
      throw new Error(`Action ${action.actionId} is dated after the simulation clock`);
    }
    const actorSet = action.status === "queued" || action.status === "resolving"
      ? activeCountryIds
      : knownCountryIds;
    if (!actorSet.has(action.actorCountryId)) {
      throw new Error(`Action ${action.actionId} references an invalid actor`);
    }
    if (
      (action.status === "queued" || action.status === "resolving")
      && action.actorCountryId !== state.playerCountryId
    ) {
      throw new Error(`Pending action ${action.actionId} must belong to the player country`);
    }
  }

  const eventIds = new Set<string>();
  let previousEventDate = "0000-01-01";
  for (const event of state.eventLog) {
    if (eventIds.has(event.eventId)) throw new Error(`Duplicate event id: ${event.eventId}`);
    eventIds.add(event.eventId);
    if (event.date < previousEventDate || event.date > state.currentDate) {
      throw new Error(`Event ${event.eventId} violates event log clock order`);
    }
    previousEventDate = event.date;
    for (const countryId of event.actorCountryIds) {
      if (!knownCountryIds.has(countryId)) {
        throw new Error(`Event ${event.eventId} references unknown country ${countryId}`);
      }
    }
  }

  for (const fact of Object.values(state.factsById)) {
    if (!eventIds.has(fact.sourceEventId)) {
      throw new Error(`Fact ${fact.factId} references unknown event ${fact.sourceEventId}`);
    }
    for (const countryId of fact.actorCountryIds) {
      const allowed = fact.status === "active" ? activeCountryIds : knownCountryIds;
      if (!allowed.has(countryId)) {
        throw new Error(`Fact ${fact.factId} references invalid country ${countryId}`);
      }
    }
  }
  for (const situation of Object.values(state.situationsById)) {
    for (const eventId of [situation.startedByEventId, situation.lastUpdatedByEventId]) {
      if (!eventIds.has(eventId)) {
        throw new Error(`Situation ${situation.situationId} references unknown event ${eventId}`);
      }
    }
    for (const countryId of situation.participantCountryIds) {
      const allowed = situation.status === "active" ? activeCountryIds : knownCountryIds;
      if (!allowed.has(countryId)) {
        throw new Error(
          `Situation ${situation.situationId} references invalid country ${countryId}`,
        );
      }
    }
  }
  const consequenceIds = new Set<string>();
  for (const consequence of state.scheduledConsequences) {
    if (consequenceIds.has(consequence.consequenceId)) {
      throw new Error(`Duplicate consequence id: ${consequence.consequenceId}`);
    }
    consequenceIds.add(consequence.consequenceId);
    if (!eventIds.has(consequence.sourceEventId)) {
      throw new Error(
        `Consequence ${consequence.consequenceId} references unknown event ${consequence.sourceEventId}`,
      );
    }
    if (consequence.situationId !== null && !state.situationsById[consequence.situationId]) {
      throw new Error(
        `Consequence ${consequence.consequenceId} references unknown situation ${consequence.situationId}`,
      );
    }
    for (const countryId of consequence.actorCountryIds) {
      if (!knownCountryIds.has(countryId)) {
        throw new Error(
          `Consequence ${consequence.consequenceId} references unknown country ${countryId}`,
        );
      }
    }
  }
}

export function createSimulationStateV1(
  input: unknown,
  world: SimulationWorldReferences,
): SimulationStateV1 {
  const state = parseSimulationStateV1(input);
  assertSimulationStateInvariants(state, world);
  return state;
}

