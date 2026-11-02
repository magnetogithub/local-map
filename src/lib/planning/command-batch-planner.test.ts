import {describe, expect, it} from "vitest";

import {parseCommandBatchV2Command} from "../commands/command-batch-v2";
import {deriveTerritoryId} from "../world/territory-id";
import {countryCreateCommandFixture, plannerStateFixture} from "./planner-test-fixture";
import {planCommandBatch} from "./command-batch-planner";

const context = () => ({committedCommandIds: new Set<string>()});

const batch = (commands: unknown[]) => parseCommandBatchV2Command({
  commandId: "batch-plan",
  type: "command.batch",
  expectedRevision: 7,
  payload: {commands},
});

describe("10-75 command batch failure propagation", () => {
  it("routes country.rename, country.establish, and country.delete planners", () => {
    const state = plannerStateFixture();
    const created = countryCreateCommandFixture("BBB");
    const renamed = {commandId: "rename-bbb", type: "country.rename", expectedRevision: 7, payload: {countryId: "BBB", changes: {english: "Renamed B"}}};
    const deleted = {commandId: "delete-bbb", type: "country.delete", expectedRevision: 7, payload: {countryId: "BBB"}};
    const result = planCommandBatch(state, batch([created, renamed, deleted]), context());
    expect(result.ok).toBe(true); if (!result.ok) return;
    expect(result.plan.patch.commandPatches).toEqual([
      {kind: "country.create", countryId: "BBB"},
      {kind: "country.rename", countryId: "BBB", changedFields: ["english"]},
      {kind: "country.delete", countryId: "BBB"},
    ]);
  });

  it("routes country.establish to its semantic planner instead of unsupported", () => {
    const missingTerritoryId = deriveTerritoryId({kind: "seed", seedVersion: "batch", sourceFeatureId: "missing"});
    const establish = {commandId: "establish-bbb", type: "country.establish", expectedRevision: 7, payload: {country: countryCreateCommandFixture("BBB").payload.country, territoryIds: [missingTerritoryId]}};
    const result = planCommandBatch(plannerStateFixture(), batch([establish]), context());
    expect(result).toEqual(expect.objectContaining({ok: false, error: expect.objectContaining({code: "territory-not-found"})}));
  });
  it("plans leaf commands in order and returns one aggregate patch on success", () => {
    const state = plannerStateFixture();

    const result = planCommandBatch(state, batch([
      countryCreateCommandFixture("BBB"),
      countryCreateCommandFixture("CCC"),
    ]), context());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.baseRevision).toBe(7);
    expect(result.plan.nextState.revision).toBe(9);
    expect(Object.keys(result.plan.nextState.countriesById).sort()).toEqual(["AAA", "BBB", "CCC"]);
    expect(result.plan.patch).toEqual({
      kind: "command.batch",
      commandPatches: [
        {kind: "country.create", countryId: "BBB"},
        {kind: "country.create", countryId: "CCC"},
      ],
    });
  });

  it("fails the whole batch without exposing partial next state or partial patches", () => {
    const state = plannerStateFixture();

    const result = planCommandBatch(state, batch([
      countryCreateCommandFixture("BBB"),
      countryCreateCommandFixture("BBB", {commandId: "create-BBB-again"}),
    ]), context());

    expect(result).toEqual({
      ok: false,
      error: {
        kind: "planning-error",
        code: "country-id-active",
        commandId: "create-BBB-again",
        message: "CountryId is already active: BBB",
      },
    });
    expect("plan" in result).toBe(false);
    expect(Object.keys(state.countriesById)).toEqual(["AAA"]);
    expect(state.revision).toBe(7);
  });
});
