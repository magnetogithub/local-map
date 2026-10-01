import type {ActiveCountryId} from "../world/country-id";
import type {WorldStateV2} from "../world/world-state-v2";
import {
  createSimulationStateV1,
  type SimulationStateV1,
} from "./simulation-state";
import {
  DEFAULT_SIMULATION_START_DATE,
  SIMULATION_STATE_SCHEMA_VERSION,
} from "./simulation-contract-primitives";

export function createInitialSimulationState(
  world: WorldStateV2,
  playerCountryId: string,
  scenarioStartDate: string = DEFAULT_SIMULATION_START_DATE,
): SimulationStateV1 {
  if (!world.countriesById[playerCountryId]) {
    throw new Error(`Simulation cannot start with an inactive player country: ${playerCountryId}`);
  }
  return createSimulationStateV1({
    schemaVersion: SIMULATION_STATE_SCHEMA_VERSION,
    revision: 0,
    currentDate: scenarioStartDate,
    turnNumber: 0,
    playerCountryId: playerCountryId as ActiveCountryId,
    queuedActions: [],
    factsById: {},
    factOrder: [],
    situationsById: {},
    situationOrder: [],
    scheduledConsequences: [],
    eventLog: [],
    history: {
      lastCommittedTurnId: null,
      committedTurnCount: 0,
    },
  }, world);
}

