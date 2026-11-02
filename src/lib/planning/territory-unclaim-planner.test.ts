import {describe, expect, it} from "vitest";

import {parseTerritoryUnclaimV2Command} from "../commands/territory-unclaim-v2";
import {countryCoreLeafHash} from "../world/country-core-hash";
import {createCountryEntity} from "../world/country-entity";
import {createCountryIdRegistry, issueCountryId, type ActiveCountryId} from "../world/country-id";
import {countryPresentationLeafHash} from "../world/country-presentation-hash";
import {buildDomainRootHash} from "../world/domain-hash-root";
import {territoryGeometryLeafHash} from "../world/territory-geometry-hash";
import {createTerritoryEntity, type TerritoryGeometry} from "../world/territory-entity";
import {deriveTerritoryId, type TerritoryId} from "../world/territory-id";
import {territoryOwnershipLeafHash} from "../world/territory-ownership-hash";
import {createTopologyState} from "../world/topology-state";
import {createWorldStateV2, WORLD_STATE_V2_SCHEMA_VERSION} from "../world/world-state-v2";
import {planTerritoryUnclaim} from "./territory-unclaim-planner";

const registry = createCountryIdRegistry({activeCountryIds: [], retiredCountryIds: []});
const countryAId = issueCountryId("AAA", registry);
const countryBId = issueCountryId("BBB", registry);
const createCountry = (id: ActiveCountryId) => createCountryEntity({
  id,
  names: {shortKo: id, officialKo: id, mapKo: id, english: id, searchAliases: [id]},
  politicalStatus: "sovereign",
  presentationOverride: null,
  moduleVersions: {core: 1, names: 1},
});
const countryA = createCountry(countryAId);
const countryB = createCountry(countryBId);
const territory = (sourceFeatureId: string) =>
  deriveTerritoryId({kind: "seed", seedVersion: "unclaim-v1", sourceFeatureId});
const northId = territory("north");
const southId = territory("south");
const freeId = territory("free");
const unknownId = territory("unknown");
const geometryHashPolicy = {coordinatePrecision: 9, exteriorRingWinding: "counterclockwise" as const};

const square = (left: number): TerritoryGeometry => ({
  type: "Polygon",
  coordinates: [[[left, 0], [left + 1, 0], [left + 1, 1], [left, 1], [left, 0]]],
});

const fixture = () => {
  const north = createTerritoryEntity({
    id: northId,
    ownerCountryId: countryAId,
    geometry: square(0),
    properties: {region: "north"},
  });
  const south = createTerritoryEntity({
    id: southId,
    ownerCountryId: countryBId,
    geometry: square(2),
    properties: {region: "south"},
  });
  const free = createTerritoryEntity({
    id: freeId,
    ownerCountryId: null,
    geometry: square(4),
    properties: {region: "free"},
  });
  const countriesById = {AAA: countryA, BBB: countryB};
  const territoriesById = {[north.id]: north, [south.id]: south, [free.id]: free};
  return createWorldStateV2({
    schemaVersion: WORLD_STATE_V2_SCHEMA_VERSION,
    seedVersion: "unclaim-v1",
    policyVersion: "world-policy-v1",
    revision: 15,
    countriesById,
    countryOrder: [countryAId, countryBId],
    retiredCountryIds: [],
    territoriesById,
    territoryOrder: [north.id, south.id, free.id],
    topology: createTopologyState([]),
    hashRoots: {
      countriesRootHash: buildDomainRootHash("countries", {
        AAA: countryCoreLeafHash(countryA),
        BBB: countryCoreLeafHash(countryB),
      }),
      presentationRootHash: buildDomainRootHash("presentation", {
        AAA: countryPresentationLeafHash(countryA, "world-policy-v1"),
        BBB: countryPresentationLeafHash(countryB, "world-policy-v1"),
      }),
      territoriesRootHash: buildDomainRootHash("territories", Object.fromEntries(
        Object.entries(territoriesById).flatMap(([id, value]) => [
          [`geometry:${id}`, territoryGeometryLeafHash(value, geometryHashPolicy)],
          [`ownership:${id}`, territoryOwnershipLeafHash(value)],
        ]),
      )),
      topologyRootHash: buildDomainRootHash("topology", {}),
    },
  });
};

const command = (
  territoryIds: TerritoryId[] = [southId, northId],
  overrides: Partial<{commandId: string; expectedRevision: number}> = {},
) => parseTerritoryUnclaimV2Command({
  commandId: overrides.commandId ?? "unclaim-territories",
  type: "territory.unclaim",
  expectedRevision: overrides.expectedRevision ?? 15,
  payload: {territoryIds},
});

describe("10-69 territory.unclaim planner", () => {
  it("atomically clears all requested owners and changes only ownership state", () => {
    const state = fixture();
    const northBefore = state.territoriesById[northId];
    const southBefore = state.territoriesById[southId];
    const northGeometryHash = territoryGeometryLeafHash(northBefore, geometryHashPolicy);
    const southGeometryHash = territoryGeometryLeafHash(southBefore, geometryHashPolicy);
    const before = JSON.stringify(state);
    const result = planTerritoryUnclaim(state, command(), {committedCommandIds: new Set()});

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const next = result.plan.nextState;
    expect(next.revision).toBe(16);
    expect(next.territoriesById[northId].ownerCountryId).toBeNull();
    expect(next.territoriesById[southId].ownerCountryId).toBeNull();
    expect(next.territoriesById[northId].geometry).toBe(northBefore.geometry);
    expect(next.territoriesById[northId].properties).toBe(northBefore.properties);
    expect(next.territoriesById[southId].geometry).toBe(southBefore.geometry);
    expect(next.territoriesById[southId].properties).toBe(southBefore.properties);
    expect(territoryGeometryLeafHash(next.territoriesById[northId], geometryHashPolicy))
      .toBe(northGeometryHash);
    expect(territoryGeometryLeafHash(next.territoriesById[southId], geometryHashPolicy))
      .toBe(southGeometryHash);
    expect(next.territoriesById[freeId]).toBe(state.territoriesById[freeId]);
    expect(next.countriesById).toBe(state.countriesById);
    expect(next.countryOrder).toBe(state.countryOrder);
    expect(next.territoryOrder).toBe(state.territoryOrder);
    expect(next.topology).toBe(state.topology);
    expect(next.hashRoots.countriesRootHash).toBe(state.hashRoots.countriesRootHash);
    expect(next.hashRoots.presentationRootHash).toBe(state.hashRoots.presentationRootHash);
    expect(next.hashRoots.topologyRootHash).toBe(state.hashRoots.topologyRootHash);
    expect(next.hashRoots.territoriesRootHash).not.toBe(state.hashRoots.territoriesRootHash);
    expect(result.plan.patch).toEqual({
      kind: "territory.unclaim",
      alreadyUnclaimedPolicy: "reject",
      ownershipChanges: [
        {territoryId: northId, beforeOwnerCountryId: countryAId, afterOwnerCountryId: null},
        {territoryId: southId, beforeOwnerCountryId: countryBId, afterOwnerCountryId: null},
      ],
    });
    expect(() => createWorldStateV2(next)).not.toThrow();
    expect(JSON.stringify(state)).toBe(before);
  });

  it.each([
    ["already-unclaimed Territory", command([northId, freeId]), "territory-already-unclaimed"],
    ["unknown Territory", command([northId, unknownId]), "territory-not-found"],
    ["duplicate Territory", command([northId, northId]), "territory-id-duplicate"],
  ])("rejects an atomic request containing %s", (_label, invalidCommand, code) => {
    const state = fixture();
    const before = JSON.stringify(state);
    const result = planTerritoryUnclaim(state, invalidCommand, {committedCommandIds: new Set()});

    expect(result).toEqual(expect.objectContaining({
      ok: false,
      error: expect.objectContaining({code}),
    }));
    expect(JSON.stringify(state)).toBe(before);
  });

  it("applies revision and duplicate-command gates before ownership semantics", () => {
    const state = fixture();
    const stale = command([freeId], {expectedRevision: 14});
    const duplicate = command([freeId], {commandId: "already-committed"});

    expect(planTerritoryUnclaim(state, stale, {committedCommandIds: new Set()})).toEqual(
      expect.objectContaining({ok: false, error: expect.objectContaining({code: "stale-revision"})}),
    );
    expect(planTerritoryUnclaim(
      state,
      duplicate,
      {committedCommandIds: new Set([duplicate.commandId])},
    )).toEqual(
      expect.objectContaining({ok: false, error: expect.objectContaining({code: "duplicate-command-id"})}),
    );
  });
});
