import {describe, expect, it, vi} from "vitest";

import {planWithSemanticGuards} from "./planner-boundary";
import {successfulPlan} from "./plan-result";
import {countryCreateCommandFixture, plannerStateFixture} from "./planner-test-fixture";

describe("10-57~10-59 planner boundary", () => {
  it("rejects stale revision before planning without retry or merge", () => {
    const state = plannerStateFixture();
    const command = countryCreateCommandFixture("BBB", {expectedRevision: state.revision - 1});
    const planner = vi.fn(() => successfulPlan({
      commandId: command.commandId,
      baseRevision: state.revision,
      nextState: state,
      patch: null,
    }));
    const result = planWithSemanticGuards(state, command, {committedCommandIds: new Set()}, planner);

    expect(result).toEqual(expect.objectContaining({
      ok: false,
      error: expect.objectContaining({code: "stale-revision"}),
    }));
    expect(planner).not.toHaveBeenCalled();
  });

  it("returns an idempotency conflict for a committed commandId", () => {
    const state = plannerStateFixture();
    const command = countryCreateCommandFixture();
    const planner = vi.fn();
    const result = planWithSemanticGuards(
      state,
      command,
      {committedCommandIds: new Set([command.commandId])},
      planner,
    );

    expect(result).toEqual(expect.objectContaining({
      ok: false,
      error: expect.objectContaining({code: "duplicate-command-id"}),
    }));
    expect(planner).not.toHaveBeenCalled();
  });

  it("does not mutate state or committed-command context during dry-run", () => {
    const state = plannerStateFixture();
    const command = countryCreateCommandFixture();
    const committedCommandIds = new Set<string>();
    const snapshot = JSON.stringify(state);
    const result = planWithSemanticGuards(
      state,
      command,
      {committedCommandIds},
      () => successfulPlan({
        commandId: command.commandId,
        baseRevision: state.revision,
        nextState: state,
        patch: null,
      }),
    );

    expect(result.ok).toBe(true);
    expect(JSON.stringify(state)).toBe(snapshot);
    expect(committedCommandIds.size).toBe(0);
  });
});
