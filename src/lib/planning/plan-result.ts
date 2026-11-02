import type {WorldStateV2} from "../world/world-state-v2";

export const PLANNING_ERROR_CODES = [
  "stale-revision",
  "duplicate-command-id",
  "country-id-active",
  "country-id-retired",
  "country-not-found",
  "country-target-self",
  "last-country-delete",
  "country-has-territories",
  "territory-not-found",
  "territory-not-owned-by-source",
  "territory-disposition-duplicate",
  "territory-disposition-missing",
  "policy-invalid",
  "policy-version-mismatch",
  "territory-id-collision",
  "partition-key-duplicate",
  "partition-geometry-invalid",
  "partition-area-below-minimum",
  "partition-gap",
  "partition-overlap",
  "partition-outside-source",
  "territory-already-owned",
  "territory-already-unclaimed",
  "territory-id-duplicate",
  "territory-geometry-invalid",
  "territory-replace-overlap",
  "territory-replace-gap",
  "territory-unclaimed",
  "partition-result-unresolved",
  "batch-local-reference-unknown",
  "batch-command-unsupported",
  "split-result-country-duplicate",
  "territory-source-duplicate",
  "territory-source-missing",
  "merge-source-country-duplicate",
  "merge-metadata-source-invalid",
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
