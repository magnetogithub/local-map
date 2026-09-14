import type {WorldStateV2} from "../world/world-state-v2";

export const PLANNING_ERROR_CODES = [
  "stale-revision",
  "duplicate-command-id",
  "country-id-active",
  "country-id-retired",
] as const;

export type PlanningErrorCode = (typeof PLANNING_ERROR_CODES)[number];

export type PlanningError = Readonly<{
  kind: "planning-error";
  code: PlanningErrorCode;
  commandId: string;
  message: string;
}>;

export type SuccessfulPlan<Patch = unknown> = Readonly<{
  commandId: string;
  baseRevision: number;
  nextState: WorldStateV2;
  patch: Patch;
}>;

export type PlanResult<Patch = unknown> =
  | Readonly<{ok: true; plan: SuccessfulPlan<Patch>}>
  | Readonly<{ok: false; error: PlanningError}>;

export const planningError = (
  code: PlanningErrorCode,
  commandId: string,
  message: string,
): PlanResult<never> => Object.freeze({
  ok: false,
  error: Object.freeze({kind: "planning-error", code, commandId, message}),
});

export const successfulPlan = <Patch>(
  plan: SuccessfulPlan<Patch>,
): PlanResult<Patch> => Object.freeze({ok: true, plan: Object.freeze(plan)});
