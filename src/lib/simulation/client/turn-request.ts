import type {CountrySearchProjection} from "../../projection/country-search-index-patch";
import type {WorldStateV2} from "../../world/world-state-v2";
import {buildSimulationContext} from "../simulation-context";
import type {SimulationStateV1} from "../simulation-state";
import type {SubdivisionCatalog} from "../subdivision-catalog";
import {
  daysBetween,
  isIsoCalendarDate,
  MAX_TIME_ADVANCE_DAYS,
  SimulationContractError,
} from "../simulation-contract-primitives";

export type TimeAdvancePreset = "day" | "week" | "month" | "next_event";

const addUtcDays = (date: string, days: number) => {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
};

export function targetDateForPreset(state: SimulationStateV1, preset: TimeAdvancePreset): string {
  if (preset === "day") return addUtcDays(state.currentDate, 1);
  if (preset === "week") return addUtcDays(state.currentDate, 7);
  if (preset === "month") return addUtcDays(state.currentDate, 30);
  return state.scheduledConsequences
    .filter((entry) => entry.status !== "cancelled" && entry.earliestDate > state.currentDate)
    .sort((left, right) => left.earliestDate.localeCompare(right.earliestDate))[0]?.earliestDate
    ?? addUtcDays(state.currentDate, 30);
}

export function targetDateForCustomInput(currentDate: string, targetDate: string): string {
  if (!isIsoCalendarDate(targetDate)) {
    throw new SimulationContractError(
      "INVALID_DATE",
      "Custom target date must be a valid ISO calendar date (YYYY-MM-DD)",
    );
  }
  const elapsedDays = daysBetween(currentDate, targetDate);
  if (elapsedDays <= 0 || elapsedDays > MAX_TIME_ADVANCE_DAYS) {
    throw new SimulationContractError(
      "INVALID_TIME_ADVANCE",
      `Custom target date must be 1-${MAX_TIME_ADVANCE_DAYS} days after the current date`,
    );
  }
  return targetDate;
}

export function buildFrozenTurnRequest(input: Readonly<{
  turnId: string;
  targetDate: string;
  simulation: SimulationStateV1;
  world: WorldStateV2;
  countrySearchProjection: CountrySearchProjection;
  subdivisionCatalog: SubdivisionCatalog;
  scenarioId: string;
  scenarioStartDate: string;
}>) {
  const context = buildSimulationContext({...input, targetDate: input.targetDate});
  return Object.freeze({
    turnId: input.turnId,
    context,
    frozenActionIds: Object.freeze(context.queuedActions.map((action) => action.actionId)),
    revisions: Object.freeze({...context.revisions}),
  });
}
