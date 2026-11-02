import {describe, expect, expectTypeOf, it} from "vitest";

import {planningError, successfulPlan, type PlanResult, type PlanningErrorCode} from "./plan-result";
import {plannerStateFixture} from "./planner-test-fixture";

describe("10-56 PlanResult and PlanningError", () => {
  it("uses a discriminated result with typed semantic error codes", () => {
    const result: PlanResult = planningError("stale-revision", "command-1", "stale");

    expect(result).toEqual({
      ok: false,
      error: {kind: "planning-error", code: "stale-revision", commandId: "command-1", message: "stale"},
    });
    expectTypeOf<PlanningErrorCode>().toEqualTypeOf<
      | "stale-revision"
      | "duplicate-command-id"
      | "country-id-active"
      | "country-id-retired"
      | "country-not-found"
      | "country-target-self"
      | "last-country-delete"
      | "country-has-territories"
      | "territory-not-found"
      | "territory-not-owned-by-source"
      | "territory-disposition-duplicate"
      | "territory-disposition-missing"
      | "policy-invalid"
      | "policy-version-mismatch"
      | "territory-id-collision"
      | "partition-key-duplicate"
      | "partition-geometry-invalid"
      | "partition-area-below-minimum"
      | "partition-gap"
      | "partition-overlap"
      | "partition-outside-source"
      | "territory-already-owned"
      | "territory-already-unclaimed"
      | "territory-id-duplicate"
      | "territory-geometry-invalid"
      | "territory-replace-overlap"
      | "territory-replace-gap"
      | "territory-unclaimed"
      | "partition-result-unresolved"
      | "batch-local-reference-unknown"
      | "batch-command-unsupported"
      | "split-result-country-duplicate"
      | "territory-source-duplicate"
      | "territory-source-missing"
      | "merge-source-country-duplicate"
      | "merge-metadata-source-invalid"
    >();
  });

  it("represents a successful immutable plan without throwing string conflicts", () => {
    const state = plannerStateFixture();
    const result = successfulPlan({
      commandId: "command-1",
      baseRevision: state.revision,
      nextState: state,
      patch: {kind: "noop"},
    });

    expect(result.ok).toBe(true);
    expect(Object.isFrozen(result)).toBe(true);
    if (result.ok) expect(Object.isFrozen(result.plan)).toBe(true);
  });
});
