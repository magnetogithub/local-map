import {describe, expect, it} from "vitest";

import {parseCountryDeleteV2Command} from "../lib/commands/country-delete-v2";
import {calculateAffectedSet} from "../lib/planning/affected-set";
import {planCountryCreate} from "../lib/planning/country-create-planner";
import {planCountryDelete} from "../lib/planning/country-delete-planner";
import {countryCreateCommandFixture, plannerStateFixture} from "../lib/planning/planner-test-fixture";
import {buildWorldPatchV2} from "../lib/planning/world-patch-v2";
import {
  applyCountrySearchIndexPatch,
  createCountrySearchProjection,
  type CountrySearchProjection,
} from "../lib/projection/country-search-index-patch";
import {createCountryCapitalProjection} from "../lib/projection/country-capital-projection";
import {createCountryPanelProjection} from "../lib/projection/country-panel-projection";
import type {ActiveCountryId} from "../lib/world/country-id";
import type {WorldStateV2} from "../lib/world/world-state-v2";
import {useGameSetupStore} from "./game-setup-store";

type SuccessfulPlan = Readonly<{
  commandId: string;
  nextState: WorldStateV2;
  patch: unknown;
}>;

const activeCountryId = (countryId: string) => countryId as ActiveCountryId;

const worldPatch = (beforeState: WorldStateV2, plan: SuccessfulPlan) =>
  buildWorldPatchV2({
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

const createBbb = (state: WorldStateV2) => {
  const result = planCountryCreate(
    state,
    countryCreateCommandFixture("BBB"),
    {committedCommandIds: new Set()},
  );
  if (!result.ok) throw new Error("create fixture failed");
  return result.plan;
};

const deleteAaa = (state: WorldStateV2) => {
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

const commitProjection = (
  projection: CountrySearchProjection,
  beforeState: WorldStateV2,
  plan: SuccessfulPlan,
) => applyCountrySearchIndexPatch(
  projection,
  worldPatch(beforeState, plan),
  plan.nextState,
).projection;

const countryPanelProjection = (state: WorldStateV2) =>
  createCountryPanelProjection(
    state,
    createCountryCapitalProjection(state, {}),
    Object.freeze(Object.fromEntries(state.countryOrder.map((countryId) => [
      countryId,
      Object.freeze({
        countryId,
        iso3: countryId,
        flagCode: countryId.toLowerCase(),
        region: "fixture",
      }),
    ]))),
  );

describe("10-88 projection-revision country selection", () => {
  it("allows a newly projected active country and records the projection revision", () => {
    const beforeState = plannerStateFixture();
    const createPlan = createBbb(beforeState);
    const projection = commitProjection(
      createCountrySearchProjection(beforeState),
      beforeState,
      createPlan,
    );

    useGameSetupStore.setState({
      selectedCountryId: null,
      selectedCountryProjectionRevision: null,
      isCountryPanelOpen: false,
      countrySearchProjection: projection,
    });

    useGameSetupStore.getState().selectCountry("BBB");

    expect(useGameSetupStore.getState().selectedCountryId).toBe("BBB");
    expect(useGameSetupStore.getState().selectedCountryProjectionRevision)
      .toBe(projection.revision);
    expect(useGameSetupStore.getState().isCountryPanelOpen).toBe(true);
  });

  it("rejects a retired country that is absent from the current projection revision", () => {
    const beforeState = plannerStateFixture();
    const createPlan = createBbb(beforeState);
    const afterCreateProjection = commitProjection(
      createCountrySearchProjection(beforeState),
      beforeState,
      createPlan,
    );
    const deletePlan = deleteAaa(createPlan.nextState);
    const afterDeleteProjection = commitProjection(
      afterCreateProjection,
      createPlan.nextState,
      deletePlan,
    );

    useGameSetupStore.setState({
      selectedCountryId: activeCountryId("BBB"),
      selectedCountryProjectionRevision: afterCreateProjection.revision,
      isCountryPanelOpen: true,
      countrySearchProjection: afterDeleteProjection,
    });

    useGameSetupStore.getState().selectCountry("AAA");

    expect(useGameSetupStore.getState().selectedCountryId).toBe("BBB");
    expect(useGameSetupStore.getState().selectedCountryProjectionRevision)
      .toBe(afterCreateProjection.revision);
    expect(afterDeleteProjection.entriesById.has("AAA" as never)).toBe(false);
  });

  it("rejects retired player-country confirmation even when the panel projection is stale", () => {
    const beforeState = plannerStateFixture();
    const createPlan = createBbb(beforeState);
    const afterCreateProjection = commitProjection(
      createCountrySearchProjection(beforeState),
      beforeState,
      createPlan,
    );
    const deletePlan = deleteAaa(createPlan.nextState);
    const afterDeleteProjection = commitProjection(
      afterCreateProjection,
      createPlan.nextState,
      deletePlan,
    );

    useGameSetupStore.setState({
      playerCountryId: null,
      countrySearchProjection: afterDeleteProjection,
      countryPanelProjection: countryPanelProjection(beforeState),
    });

    useGameSetupStore.getState().confirmPlayerCountry("AAA");

    expect(useGameSetupStore.getState().playerCountryId).toBeNull();
  });

  it("updates surviving selected-country projection revision on projection replacement", () => {
    const beforeState = plannerStateFixture();
    const createPlan = createBbb(beforeState);
    const afterCreateProjection = commitProjection(
      createCountrySearchProjection(beforeState),
      beforeState,
      createPlan,
    );

    useGameSetupStore.setState({
      selectedCountryId: activeCountryId("AAA"),
      selectedCountryProjectionRevision: beforeState.revision,
      isCountryPanelOpen: true,
      countrySearchProjection: createCountrySearchProjection(beforeState),
    });

    useGameSetupStore.getState().setCountrySearchProjection(afterCreateProjection);

    expect(useGameSetupStore.getState().selectedCountryId).toBe("AAA");
    expect(useGameSetupStore.getState().selectedCountryProjectionRevision)
      .toBe(afterCreateProjection.revision);
  });

  it("clears selected, hovered, and player IDs removed by a country deletion patch", () => {
    const beforeState = plannerStateFixture();
    const createPlan = createBbb(beforeState);
    const afterCreateProjection = commitProjection(
      createCountrySearchProjection(beforeState),
      beforeState,
      createPlan,
    );
    const deletePlan = deleteAaa(createPlan.nextState);
    const afterDeleteProjection = commitProjection(
      afterCreateProjection,
      createPlan.nextState,
      deletePlan,
    );

    useGameSetupStore.setState({
      selectedCountryId: activeCountryId("AAA"),
      selectedCountryProjectionRevision: afterCreateProjection.revision,
      hoveredCountryId: activeCountryId("AAA"),
      playerCountryId: activeCountryId("AAA"),
      isCountryPanelOpen: true,
      countrySearchProjection: afterCreateProjection,
    });

    useGameSetupStore.getState().setCountrySearchProjection(afterDeleteProjection);

    const state = useGameSetupStore.getState();
    expect(state.selectedCountryId).toBeNull();
    expect(state.selectedCountryProjectionRevision).toBeNull();
    expect(state.hoveredCountryId).toBeNull();
    expect(state.playerCountryId).toBeNull();
    expect(state.isCountryPanelOpen).toBe(false);
    expect([
      state.selectedCountryId,
      state.hoveredCountryId,
      state.playerCountryId,
    ].filter((countryId) =>
      countryId !== null && !afterDeleteProjection.entriesById.has(countryId as never),
    )).toHaveLength(0);
  });
});
