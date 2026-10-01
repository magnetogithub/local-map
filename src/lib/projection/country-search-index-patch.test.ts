import {describe, expect, it} from "vitest";

import {parseCountryDeleteV2Command} from "../commands/country-delete-v2";
import {parseCountryRenameV2Command} from "../commands/country-rename-v2";
import {calculateAffectedSet} from "../planning/affected-set";
import {planCountryCreate} from "../planning/country-create-planner";
import {planCountryDelete} from "../planning/country-delete-planner";
import {planCountryRename} from "../planning/country-rename-planner";
import {countryCreateCommandFixture, plannerStateFixture} from "../planning/planner-test-fixture";
import {buildWorldPatchV2} from "../planning/world-patch-v2";
import type {ActiveCountryId} from "../world/country-id";
import type {WorldStateV2} from "../world/world-state-v2";
import {
  applyCountrySearchIndexPatch,
  createCountrySearchProjection,
  searchCountryProjection,
} from "./country-search-index-patch";

type SuccessfulPlan = Readonly<{
  commandId: string;
  nextState: WorldStateV2;
  patch: unknown;
}>;

const activeCountryId = (countryId: string) => countryId as ActiveCountryId;

const worldPatch = (
  beforeState: WorldStateV2,
  plan: SuccessfulPlan,
) => buildWorldPatchV2({
  commandId: plan.commandId,
  beforeState,
  afterState: plan.nextState,
  affectedSet: calculateAffectedSet({
    beforeState,
    afterState: plan.nextState,
    patch: plan.patch,
  }),
  plannerPatch: plan.patch,
});

const createCountry = (state: WorldStateV2) => {
  const result = planCountryCreate(
    state,
    countryCreateCommandFixture("BBB"),
    {committedCommandIds: new Set()},
  );
  if (!result.ok) throw new Error("create fixture failed");
  return result.plan;
};

const renameCountry = (state: WorldStateV2) => {
  const result = planCountryRename(
    state,
    parseCountryRenameV2Command({
      commandId: "rename-bbb",
      type: "country.rename",
      expectedRevision: state.revision,
      payload: {
        countryId: "BBB",
        changes: {
          english: "Projection Republic",
          searchAliases: ["Projected", "Patchable"],
        },
      },
    }),
    {committedCommandIds: new Set()},
  );
  if (!result.ok) throw new Error("rename fixture failed");
  return result.plan;
};

const deleteCountry = (state: WorldStateV2) => {
  const result = planCountryDelete(
    state,
    parseCountryDeleteV2Command({
      commandId: "delete-aaa",
      type: "country.delete",
      expectedRevision: state.revision,
      payload: {countryId: "AAA"},
    }),
    {committedCommandIds: new Set()},
  );
  if (!result.ok) throw new Error("delete fixture failed");
  return result.plan;
};

describe("10-86 country search index patch API", () => {
  it("adds a country search entry from country module deltas without a full rebuild", () => {
    const beforeState = plannerStateFixture();
    const projection = createCountrySearchProjection(beforeState, 1);
    const plan = createCountry(beforeState);
    const patch = worldPatch(beforeState, plan);

    const result = applyCountrySearchIndexPatch(projection, patch, plan.nextState);

    expect(result.operations).toEqual([{countryId: "BBB", kind: "add"}]);
    expect(result.fullRebuildCountDelta).toBe(0);
    expect(result.projection.fullRebuildCount).toBe(1);
    expect(result.projection.entriesById.get(activeCountryId("BBB"))?.english)
      .toBe("New Republic");
    expect(searchCountryProjection(result.projection, "new")[0]?.countryId).toBe("BBB");
  });

  it("updates a country search entry from country module deltas without a full rebuild", () => {
    const baseState = plannerStateFixture();
    const createPlan = createCountry(baseState);
    const projection = applyCountrySearchIndexPatch(
      createCountrySearchProjection(baseState),
      worldPatch(baseState, createPlan),
      createPlan.nextState,
    ).projection;
    const renamePlan = renameCountry(createPlan.nextState);
    const patch = worldPatch(createPlan.nextState, renamePlan);

    const result = applyCountrySearchIndexPatch(projection, patch, renamePlan.nextState);

    expect(result.operations).toEqual([{countryId: "BBB", kind: "update"}]);
    expect(result.fullRebuildCountDelta).toBe(0);
    expect(result.projection.fullRebuildCount).toBe(0);
    expect(result.projection.entriesById.get(activeCountryId("BBB"))?.english)
      .toBe("Projection Republic");
    expect(searchCountryProjection(result.projection, "patchable")[0]?.countryId).toBe("BBB");
  });

  it("deletes a country search entry from country module deltas without a full rebuild", () => {
    const baseState = plannerStateFixture();
    const createPlan = createCountry(baseState);
    const projection = applyCountrySearchIndexPatch(
      createCountrySearchProjection(baseState),
      worldPatch(baseState, createPlan),
      createPlan.nextState,
    ).projection;
    const deletePlan = deleteCountry(createPlan.nextState);
    const patch = worldPatch(createPlan.nextState, deletePlan);

    const result = applyCountrySearchIndexPatch(projection, patch, deletePlan.nextState);

    expect(result.operations).toEqual([{countryId: "AAA", kind: "delete"}]);
    expect(result.fullRebuildCountDelta).toBe(0);
    expect(result.projection.fullRebuildCount).toBe(0);
    expect(result.projection.entriesById.has(activeCountryId("AAA"))).toBe(false);
    expect(result.projection.entriesById.has(activeCountryId("BBB"))).toBe(true);
  });
});
