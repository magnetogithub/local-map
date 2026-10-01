import {z} from "zod";

import {COUNTRY_ID_PATTERN} from "../world/country-id";

export const SIMULATION_CONTRACT_VERSION = "turn-resolution.v1" as const;
export const SIMULATION_STATE_SCHEMA_VERSION = 1 as const;
export const DEFAULT_SIMULATION_START_DATE = "2020-01-01" as const;
export const MAX_TIME_ADVANCE_DAYS = 366;

export const MAX_ID_LENGTH = 64;
export const MAX_TITLE_LENGTH = 160;
export const MAX_SUMMARY_LENGTH = 1_200;
export const MAX_NARRATIVE_LENGTH = 4_000;
export const MAX_PLAYER_ACTION_LENGTH = 2_000;

export type SimulationContractErrorCode =
  | "INVALID_DATE"
  | "INVALID_TIME_ADVANCE"
  | "STALE_REVISION_PAIR"
  | "INVALID_ACTION"
  | "DUPLICATE_ACTION_ID"
  | "ACTION_NOT_CANCELLABLE"
  | "INVALID_REFERENCE"
  | "INVALID_CAUSALITY"
  | "INVALID_RESOLUTION";

export class SimulationContractError extends Error {
  readonly code: SimulationContractErrorCode;

  constructor(code: SimulationContractErrorCode, message: string) {
    super(message);
    this.name = "SimulationContractError";
    this.code = code;
  }
}

const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export function isIsoCalendarDate(value: string): boolean {
  if (!ISO_DATE_PATTERN.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day;
}

export const isoCalendarDateSchema = z.string().refine(isIsoCalendarDate, {
  message: "Expected a valid ISO calendar date (YYYY-MM-DD)",
});

export const simulationIdSchema = z.string()
  .min(1)
  .max(MAX_ID_LENGTH)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/, "Expected a canonical simulation id");

export const countryIdSchema = z.string()
  .regex(COUNTRY_ID_PATTERN, "Expected an active three-character CountryId");

export const boundedTitleSchema = z.string().trim().min(1).max(MAX_TITLE_LENGTH);
export const boundedSummarySchema = z.string().trim().min(1).max(MAX_SUMMARY_LENGTH);
export const boundedNarrativeSchema = z.string().trim().min(1).max(MAX_NARRATIVE_LENGTH);

export const nullableSimulationIdSchema = z.union([simulationIdSchema, z.null()]);
export const nullableCountryIdSchema = z.union([countryIdSchema, z.null()]);

export const compareCanonicalText = (left: string, right: string) =>
  left < right ? -1 : left > right ? 1 : 0;

export function dateToEpochDay(value: string): number {
  if (!isIsoCalendarDate(value)) {
    throw new SimulationContractError("INVALID_DATE", `Invalid ISO calendar date: ${value}`);
  }
  const [year, month, day] = value.split("-").map(Number);
  return Math.floor(Date.UTC(year, month - 1, day) / 86_400_000);
}

export function daysBetween(startDate: string, endDate: string): number {
  return dateToEpochDay(endDate) - dateToEpochDay(startDate);
}

const PROTOTYPE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/** Fails closed before schema parsing so prototype keys cannot be silently stripped. */
export function assertSafeSimulationData(
  value: unknown,
  path = "$",
  ancestors: Set<object> = new Set(),
): void {
  if (value === null || typeof value !== "object") return;
  if (ancestors.has(value)) throw new TypeError(`${path} contains a circular reference`);
  const prototype = Object.getPrototypeOf(value);
  if (Array.isArray(value)) {
    if (prototype !== Array.prototype) throw new TypeError(`${path} must be a plain array`);
  } else if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${path} must be a plain object`);
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw new TypeError(`${path} must not contain symbol properties`);
  }
  ancestors.add(value);
  try {
    for (const key of Object.keys(value)) {
      if (PROTOTYPE_KEYS.has(key)) throw new TypeError(`${path}.${key} is forbidden`);
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
        throw new TypeError(`${path}.${key} must be an enumerable data property`);
      }
      assertSafeSimulationData(descriptor.value, `${path}.${key}`, ancestors);
    }
  } finally {
    ancestors.delete(value);
  }
}

