import {describe, expect, it} from "vitest";
import {parseCountryEstablishV2Command} from "../commands/country-establish-v2";
import {createTerritoryEntity} from "../world/territory-entity";
import {deriveTerritoryId} from "../world/territory-id";
import {createWorldStateV2} from "../world/world-state-v2";
import {planCountryEstablish} from "./country-establish-planner";
import {plannerStateFixture} from "./planner-test-fixture";

const tid = deriveTerritoryId({kind: "seed", seedVersion: "x", sourceFeatureId: "one"});
const missingTid = deriveTerritoryId({kind: "seed", seedVersion: "x", sourceFeatureId: "missing"});
const stateWithTerritory = (ownerCountryId: "AAA" | null = null) => {
  const state = plannerStateFixture();
  const territory = createTerritoryEntity({id: tid, ownerCountryId, geometry: {type: "Polygon", coordinates: [[[0,0],[1,0],[1,1],[0,0]]]}, properties: {}});
  return createWorldStateV2({...state, territoriesById: {[tid]: territory}, territoryOrder: [tid]});
};
const command = (territoryIds: string[] = [tid], id = "BBB") => parseCountryEstablishV2Command({
  commandId: "establish-bbb", type: "country.establish", expectedRevision: 7,
  payload: {country: {id, names: {shortKo: "B", officialKo: "BB", mapKo: "B", english: "B", searchAliases: []}, politicalStatus: "sovereign", presentationOverride: null, moduleVersions: {core: 1, names: 1}}, territoryIds},
});
describe("10-62 country.establish planner", () => {
  it("atomically creates a country and assigns explicit unclaimed territories", () => {
    const state = stateWithTerritory(); const before = JSON.stringify(state);
    const result = planCountryEstablish(state, command(), {committedCommandIds: new Set()});
    expect(result.ok).toBe(true); if (!result.ok) return;
    expect(result.plan.nextState.countriesById.BBB.id).toBe("BBB");
    expect(result.plan.nextState.territoriesById[tid].ownerCountryId).toBe("BBB");
    expect(result.plan.nextState.revision).toBe(8); expect(result.plan.nextState.topology).toBe(state.topology);
    expect(result.plan.nextState.territoriesById[tid].geometry).toBe(state.territoriesById[tid].geometry);
    expect(JSON.stringify(state)).toBe(before);
  });
  it.each([
    ["active id", () => command([tid], "AAA"), stateWithTerritory(), "country-id-active"],
    ["retired id", () => command([tid], "OLD"), stateWithTerritory(), "country-id-retired"],
    ["unknown territory", () => command([missingTid]), stateWithTerritory(), "territory-not-found"],
    ["duplicate territory", () => command([tid, tid]), stateWithTerritory(), "territory-id-duplicate"],
    ["owned territory", () => command(), stateWithTerritory("AAA"), "territory-already-owned"],
  ])("rejects %s without partial output", (_label, make, state, code) => {
    const result = planCountryEstablish(state, make(), {committedCommandIds: new Set()});
    expect(result).toEqual(expect.objectContaining({ok: false, error: expect.objectContaining({code})}));
    expect("plan" in result).toBe(false); expect(state.countriesById.BBB).toBeUndefined();
  });
});
