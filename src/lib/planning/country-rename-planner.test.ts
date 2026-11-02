import {describe, expect, it} from "vitest";
import {parseCountryRenameV2Command} from "../commands/country-rename-v2";
import {planCountryRename} from "./country-rename-planner";
import {plannerStateFixture} from "./planner-test-fixture";

const command = (countryId = "AAA", expectedRevision = 7) => parseCountryRenameV2Command({
  commandId: "rename-aaa", type: "country.rename", expectedRevision,
  payload: {countryId, changes: {english: "Renamed Republic"}},
});

describe("10-61 country.rename planner", () => {
  it("changes only requested names, advances names version, and shares unrelated domains", () => {
    const state = plannerStateFixture(); const before = JSON.stringify(state);
    const result = planCountryRename(state, command(), {committedCommandIds: new Set()});
    expect(result.ok).toBe(true); if (!result.ok) return;
    const next = result.plan.nextState;
    expect(next.countriesById.AAA.names).toEqual({...state.countriesById.AAA.names, english: "Renamed Republic"});
    expect(next.countriesById.AAA.moduleVersions.names).toBe(2);
    expect(next.revision).toBe(8);
    expect(next.territoriesById).toBe(state.territoriesById); expect(next.topology).toBe(state.topology);
    expect(next.hashRoots.territoriesRootHash).toBe(state.hashRoots.territoriesRootHash);
    expect(next.hashRoots.topologyRootHash).toBe(state.hashRoots.topologyRootHash);
    expect(next.hashRoots.presentationRootHash).toBe(state.hashRoots.presentationRootHash);
    expect(next.hashRoots.countriesRootHash).not.toBe(state.hashRoots.countriesRootHash);
    expect(JSON.stringify(state)).toBe(before);
  });
  it.each([["OLD", "country-id-retired"], ["ZZZ", "country-not-found"]])("rejects %s", (id, code) => {
    expect(planCountryRename(plannerStateFixture(), command(id), {committedCommandIds: new Set()}))
      .toEqual(expect.objectContaining({ok: false, error: expect.objectContaining({code})}));
  });
  it("preserves revision and duplicate gates", () => {
    expect(planCountryRename(plannerStateFixture(), command("AAA", 6), {committedCommandIds: new Set()}))
      .toEqual(expect.objectContaining({ok: false, error: expect.objectContaining({code: "stale-revision"})}));
    expect(planCountryRename(plannerStateFixture(), command(), {committedCommandIds: new Set(["rename-aaa"])}))
      .toEqual(expect.objectContaining({ok: false, error: expect.objectContaining({code: "duplicate-command-id"})}));
  });
});
