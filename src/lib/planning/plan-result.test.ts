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
      "stale-revision" | "duplicate-command-id" | "country-id-active" | "country-id-retired"
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
