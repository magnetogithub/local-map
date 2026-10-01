import {z} from "zod";

import {
  DEFAULT_SIMULATION_START_DATE,
  daysBetween,
  isoCalendarDateSchema,
  MAX_TIME_ADVANCE_DAYS,
  SIMULATION_STATE_SCHEMA_VERSION,
  SimulationContractError,
} from "./simulation-contract-primitives";

export const simulationClockSchema = z.strictObject({
  schemaVersion: z.literal(SIMULATION_STATE_SCHEMA_VERSION),
  currentDate: isoCalendarDateSchema,
  turnNumber: z.number().int().nonnegative(),
  revision: z.number().int().nonnegative(),
});

export const revisionPairSchema = z.strictObject({
  simulationRevision: z.number().int().nonnegative(),
  worldRevision: z.number().int().nonnegative(),
});

export type SimulationClock = z.infer<typeof simulationClockSchema>;
export type RevisionPair = z.infer<typeof revisionPairSchema>;

export function createSimulationClock(
  scenarioStartDate: string = DEFAULT_SIMULATION_START_DATE,
): SimulationClock {
  return Object.freeze(simulationClockSchema.parse({
    schemaVersion: SIMULATION_STATE_SCHEMA_VERSION,
    currentDate: scenarioStartDate,
    turnNumber: 0,
    revision: 0,
  }));
}

export function advanceSimulationClock(
  clock: SimulationClock,
  targetDate: string,
): SimulationClock {
  const current = simulationClockSchema.parse(clock);
  isoCalendarDateSchema.parse(targetDate);
  const elapsedDays = daysBetween(current.currentDate, targetDate);
  if (elapsedDays <= 0 || elapsedDays > MAX_TIME_ADVANCE_DAYS) {
    throw new SimulationContractError(
      "INVALID_TIME_ADVANCE",
      `Time advance must be 1-${MAX_TIME_ADVANCE_DAYS} days`,
    );
  }
  return Object.freeze({
    ...current,
    currentDate: targetDate,
    turnNumber: current.turnNumber + 1,
    revision: current.revision + 1,
  });
}

export function assertCurrentRevisionPair(
  expected: RevisionPair,
  current: RevisionPair,
): void {
  const expectedPair = revisionPairSchema.parse(expected);
  const currentPair = revisionPairSchema.parse(current);
  if (
    expectedPair.simulationRevision !== currentPair.simulationRevision
    || expectedPair.worldRevision !== currentPair.worldRevision
  ) {
    throw new SimulationContractError(
      "STALE_REVISION_PAIR",
      `Stale revision pair ${expectedPair.simulationRevision}/${expectedPair.worldRevision}; current is ${currentPair.simulationRevision}/${currentPair.worldRevision}`,
    );
  }
}

