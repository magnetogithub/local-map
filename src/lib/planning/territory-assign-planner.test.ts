import {describe, expect, it} from "vitest";

import {parseTerritoryAssignV2Command} from "../commands/territory-assign-v2";
import {countryCoreLeafHash} from "../world/country-core-hash";
import {createCountryEntity} from "../world/country-entity";
import {createCountryIdRegistry, issueCountryId} from "../world/country-id";
import {countryPresentationLeafHash} from "../world/country-presentation-hash";
import {buildDomainRootHash} from "../world/domain-hash-root";
import {territoryGeometryLeafHash} from "../world/territory-geometry-hash";
import {createTerritoryEntity} from "../world/territory-entity";
import {deriveTerritoryId} from "../world/territory-id";
import {territoryOwnershipLeafHash} from "../world/territory-ownership-hash";
import {createTopologyState} from "../world/topology-state";
import {createWorldStateV2, WORLD_STATE_V2_SCHEMA_VERSION} from "../world/world-state-v2";
import {planTerritoryAssign} from "./territory-assign-planner";

const targetCountryId = issueCountryId(
  "AAA",
  createCountryIdRegistry({activeCountryIds: [], retiredCountryIds: []}),
);
const country = createCountryEntity({
  id: targetCountryId,
  names: {shortKo: "A", officialKo: "A", mapKo: "A", english: "A", searchAliases: ["AAA"]},
  politicalStatus: "sovereign",
  presentationOverride: null,
  moduleVersions: {core: 1, names: 1},
});
const unclaimedId = deriveTerritoryId({kind: "seed", seedVersion: "assign-v1", sourceFeatureId: "free"});
const occupiedId = deriveTerritoryId({kind: "seed", seedVersion: "assign-v1", sourceFeatureId: "owned"});
const unknownId = deriveTerritoryId({kind: "seed", seedVersion: "assign-v1", sourceFeatureId: "unknown"});
const geometryHashPolicy = {coordinatePrecision: 9, exteriorRingWinding: "counterclockwise" as const};

const fixture = () => {
  const unclaimed = createTerritoryEntity({
    id: unclaimedId,
    ownerCountryId: null,
    geometry: {type: "Polygon", coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]]},
    properties: {region: "free"},
  });
  const occupied = createTerritoryEntity({
    id: occupiedId,
    ownerCountryId: targetCountryId,
    geometry: {type: "Polygon", coordinates: [[[2, 0], [3, 0], [3, 1], [2, 1], [2, 0]]]},
    properties: {region: "owned"},
  });
  const countriesById = {AAA: country};
  const territoriesById = {[unclaimed.id]: unclaimed, [occupied.id]: occupied};
  return createWorldStateV2({
    schemaVersion: WORLD_STATE_V2_SCHEMA_VERSION,
    seedVersion: "assign-v1",
    policyVersion: "world-policy-v1",
    revision: 14,
    countriesById,
    countryOrder: [targetCountryId],
    retiredCountryIds: ["OLD" as never],
    territoriesById,
    territoryOrder: [unclaimed.id, occupied.id],
    topology: createTopologyState([]),
    hashRoots: {
      countriesRootHash: buildDomainRootHash("countries", {AAA: countryCoreLeafHash(country)}),
      presentationRootHash: buildDomainRootHash("presentation", {
        AAA: countryPresentationLeafHash(country, "world-policy-v1"),
      }),
      territoriesRootHash: buildDomainRootHash("territories", Object.fromEntries(
        Object.entries(territoriesById).flatMap(([id, territory]) => [
          [`geometry:${id}`, territoryGeometryLeafHash(territory, geometryHashPolicy)],
          [`ownership:${id}`, territoryOwnershipLeafHash(territory)],
        ]),
      )),
      topologyRootHash: buildDomainRootHash("topology", {}),
    },
  });
};

const command = (
  territoryId = unclaimedId,
  targetCountry = "AAA",
  overrides: Partial<{commandId: string; expectedRevision: number}> = {},
) => parseTerritoryAssignV2Command({
  commandId: overrides.commandId ?? "assign-free-territory",
  type: "territory.assign",
  expectedRevision: overrides.expectedRevision ?? 14,
  payload: {territoryId, targetCountryId: targetCountry},
});

describe("10-68 territory.assign planner", () => {
  it("assigns an unclaimed Territory and changes only ownership state", () => {
    const state = fixture();
    const territoryBefore = state.territoriesById[unclaimedId];
    const geometryHashBefore = territoryGeometryLeafHash(territoryBefore, geometryHashPolicy);
    const ownershipHashBefore = territoryOwnershipLeafHash(territoryBefore);
    const before = JSON.stringify(state);
    const result = planTerritoryAssign(state, command(), {committedCommandIds: new Set()});

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const next = result.plan.nextState;
    const territoryAfter = next.territoriesById[unclaimedId];
    expect(next.revision).toBe(15);
    expect(territoryAfter.ownerCountryId).toBe("AAA");
    expect(territoryAfter.geometry).toBe(territoryBefore.geometry);
    expect(territoryAfter.properties).toBe(territoryBefore.properties);
    expect(territoryGeometryLeafHash(territoryAfter, geometryHashPolicy)).toBe(geometryHashBefore);
    expect(territoryOwnershipLeafHash(territoryAfter)).not.toBe(ownershipHashBefore);
    expect(next.territoriesById[occupiedId]).toBe(state.territoriesById[occupiedId]);
    expect(next.countriesById).toBe(state.countriesById);
    expect(next.countryOrder).toBe(state.countryOrder);
    expect(next.territoryOrder).toBe(state.territoryOrder);
    expect(next.topology).toBe(state.topology);
    expect(next.hashRoots.countriesRootHash).toBe(state.hashRoots.countriesRootHash);
    expect(next.hashRoots.presentationRootHash).toBe(state.hashRoots.presentationRootHash);
    expect(next.hashRoots.topologyRootHash).toBe(state.hashRoots.topologyRootHash);
    expect(next.hashRoots.territoriesRootHash).not.toBe(state.hashRoots.territoriesRootHash);
    expect(result.plan.patch).toEqual({
      kind: "territory.assign",
      territoryId: unclaimedId,
      beforeOwnerCountryId: null,
      afterOwnerCountryId: targetCountryId,
    });
    expect(() => createWorldStateV2(next)).not.toThrow();
    expect(JSON.stringify(state)).toBe(before);
  });

  it.each([
    ["occupied Territory", command(occupiedId), "territory-already-owned"],
    ["unknown Territory", command(unknownId), "territory-not-found"],
    ["unknown target", command(unclaimedId, "ZZZ"), "country-not-found"],
    ["retired target", command(unclaimedId, "OLD"), "country-id-retired"],
  ])("rejects %s without mutating state", (_label, invalidCommand, code) => {
    const state = fixture();
    const before = JSON.stringify(state);
    const result = planTerritoryAssign(state, invalidCommand, {committedCommandIds: new Set()});

    expect(result).toEqual(expect.objectContaining({
      ok: false,
      error: expect.objectContaining({code}),
    }));
    expect(JSON.stringify(state)).toBe(before);
  });

  it("applies revision and duplicate-command gates before assignment semantics", () => {
    const state = fixture();
    const stale = command(occupiedId, "ZZZ", {expectedRevision: 13});
    const duplicate = command(occupiedId, "ZZZ", {commandId: "already-committed"});

    expect(planTerritoryAssign(state, stale, {committedCommandIds: new Set()})).toEqual(
      expect.objectContaining({ok: false, error: expect.objectContaining({code: "stale-revision"})}),
    );
    expect(planTerritoryAssign(
      state,
      duplicate,
      {committedCommandIds: new Set([duplicate.commandId])},
    )).toEqual(
      expect.objectContaining({ok: false, error: expect.objectContaining({code: "duplicate-command-id"})}),
    );
  });
});
