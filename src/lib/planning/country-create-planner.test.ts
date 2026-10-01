import {describe, expect, it} from "vitest";

import {worldContentHash} from "../world/world-content-hash";
import {planCountryCreate} from "./country-create-planner";
import {countryCreateCommandFixture, plannerStateFixture} from "./planner-test-fixture";

const contentHash = (state: ReturnType<typeof plannerStateFixture>) => worldContentHash({
  schemaVersion: state.schemaVersion,
  seedVersion: state.seedVersion,
  policyVersion: state.policyVersion,
  hashRoots: {
    countriesRootHash: state.hashRoots.countriesRootHash!,
    presentationRootHash: state.hashRoots.presentationRootHash!,
    territoriesRootHash: state.hashRoots.territoriesRootHash!,
    topologyRootHash: state.hashRoots.topologyRootHash!,
  },
});

describe("10-57/60 country.create planner", () => {
  it("creates a territory-free country in deterministic order and leaves input untouched", () => {
    const state = plannerStateFixture();
    const command = countryCreateCommandFixture("BBB");
    const beforeHash = contentHash(state);
    const beforeSnapshot = JSON.stringify(state);
    const result = planCountryCreate(state, command, {committedCommandIds: new Set()});

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.nextState.countryOrder).toEqual(["AAA", "BBB"]);
    expect(result.plan.nextState.countriesById.BBB.id).toBe("BBB");
    expect(Object.values(result.plan.nextState.territoriesById)
      .filter(({ownerCountryId}) => ownerCountryId === "BBB")).toHaveLength(0);
    expect(result.plan.nextState.revision).toBe(state.revision + 1);
    expect(result.plan.nextState.territoriesById).toBe(state.territoriesById);
    expect(result.plan.nextState.topology).toBe(state.topology);
    expect(result.plan.nextState.hashRoots.territoriesRootHash).toBe(state.hashRoots.territoriesRootHash);
    expect(result.plan.nextState.hashRoots.topologyRootHash).toBe(state.hashRoots.topologyRootHash);
    expect(result.plan.nextState.hashRoots.countriesRootHash).not.toBe(state.hashRoots.countriesRootHash);
    expect(JSON.stringify(state)).toBe(beforeSnapshot);
    expect(contentHash(state)).toBe(beforeHash);
  });

  it("assigns the first available generated tag when the command omits an ID", () => {
    const state = plannerStateFixture();
    const fixture = countryCreateCommandFixture("BBB");
    const command = {
      ...fixture,
      payload: {country: {...fixture.payload.country, id: undefined}},
    };
    const result = planCountryCreate(state, command, {committedCommandIds: new Set()});

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.patch.countryId).toBe("D01");
    expect(result.plan.nextState.countriesById.D01.id).toBe("D01");
  });

  it.each([
    ["AAA", "country-id-active"],
    ["OLD", "country-id-retired"],
  ] as const)("rejects active or retired CountryId %s", (countryId, code) => {
    const result = planCountryCreate(
      plannerStateFixture(),
      countryCreateCommandFixture(countryId),
      {committedCommandIds: new Set()},
    );

    expect(result).toEqual(expect.objectContaining({
      ok: false,
      error: expect.objectContaining({code}),
    }));
  });

  it("applies revision and duplicate gates before CountryId semantics", () => {
    const state = plannerStateFixture();
    const stale = countryCreateCommandFixture("AAA", {expectedRevision: 6});
    const duplicate = countryCreateCommandFixture("AAA", {commandId: "already-committed"});

    expect(planCountryCreate(state, stale, {committedCommandIds: new Set()})).toEqual(
      expect.objectContaining({ok: false, error: expect.objectContaining({code: "stale-revision"})}),
    );
    expect(planCountryCreate(
      state,
      duplicate,
      {committedCommandIds: new Set([duplicate.commandId])},
    )).toEqual(
      expect.objectContaining({ok: false, error: expect.objectContaining({code: "duplicate-command-id"})}),
    );
  });
});
