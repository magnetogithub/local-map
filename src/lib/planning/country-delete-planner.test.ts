import {describe, expect, it} from "vitest";
import {parseCountryDeleteV2Command} from "../commands/country-delete-v2";
import {createTerritoryEntity} from "../world/territory-entity";
import {deriveTerritoryId} from "../world/territory-id";
import {createWorldStateV2} from "../world/world-state-v2";
import {planCountryDelete} from "./country-delete-planner";
import {countryCreateCommandFixture, plannerStateFixture} from "./planner-test-fixture";
import {planCountryCreate} from "./country-create-planner";

const command = (countryId = "AAA", expectedRevision = 8) => parseCountryDeleteV2Command({commandId: "delete-country", type: "country.delete", expectedRevision, payload: {countryId}});
const twoCountryState = () => { const result = planCountryCreate(plannerStateFixture(), countryCreateCommandFixture("BBB"), {committedCommandIds: new Set()}); if (!result.ok) throw new Error(); return result.plan.nextState; };
describe("10-63 country.delete planner", () => {
  it("removes and retires an empty active country while sharing territory and topology", () => {
    const state = twoCountryState(); const before = JSON.stringify(state);
    const result = planCountryDelete(state, command(), {committedCommandIds: new Set()});
    expect(result.ok).toBe(true); if (!result.ok) return;
    expect(result.plan.nextState.countryOrder).toEqual(["BBB"]); expect(result.plan.nextState.countriesById.AAA).toBeUndefined();
    expect(result.plan.nextState.retiredCountryIds.has("AAA" as never)).toBe(true);
    expect(result.plan.nextState.territoriesById).toBe(state.territoriesById); expect(result.plan.nextState.topology).toBe(state.topology);
    expect(JSON.stringify(state)).toBe(before);
  });
  it.each([["OLD", "country-id-retired"], ["ZZZ", "country-not-found"]])("rejects %s", (id, code) => {
    expect(planCountryDelete(twoCountryState(), command(id), {committedCommandIds: new Set()})).toEqual(expect.objectContaining({ok:false,error:expect.objectContaining({code})}));
  });
  it("rejects deleting the last country", () => {
    expect(planCountryDelete(plannerStateFixture(), command("AAA", 7), {committedCommandIds: new Set()})).toEqual(expect.objectContaining({ok:false,error:expect.objectContaining({code:"last-country-delete"})}));
  });
  it("rejects a country that still owns a Territory", () => {
    const base = twoCountryState();
    const territoryId = deriveTerritoryId({kind: "seed", seedVersion: "delete", sourceFeatureId: "owned"});
    const territory = createTerritoryEntity({id: territoryId, ownerCountryId: "AAA", geometry: {type: "Polygon", coordinates: [[[0,0],[1,0],[1,1],[0,0]]]}, properties: {}});
    const state = createWorldStateV2({...base, territoriesById: {[territoryId]: territory}, territoryOrder: [territoryId]});
    expect(planCountryDelete(state, command(), {committedCommandIds: new Set()})).toEqual(expect.objectContaining({ok:false,error:expect.objectContaining({code:"country-has-territories"})}));
  });
});
