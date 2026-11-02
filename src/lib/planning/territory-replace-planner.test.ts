import {describe, expect, it} from "vitest";

import {parseTerritoryReplaceV2Command} from "../commands/territory-replace-v2";
import {countryCoreLeafHash} from "../world/country-core-hash";
import {createCountryEntity} from "../world/country-entity";
import {createCountryIdRegistry, issueCountryId} from "../world/country-id";
import {countryPresentationLeafHash} from "../world/country-presentation-hash";
import {buildDomainRootHash} from "../world/domain-hash-root";
import {buildCanonicalTopology} from "../world/canonical-topology";
import {territoryGeometryLeafHash} from "../world/territory-geometry-hash";
import {createTerritoryEntity, type TerritoryGeometry} from "../world/territory-entity";
import {deriveTerritoryId} from "../world/territory-id";
import {territoryOwnershipLeafHash} from "../world/territory-ownership-hash";
import {topologyEdgeLeafHash} from "../world/topology-edge-hash";
import {createWorldStateV2, WORLD_STATE_V2_SCHEMA_VERSION} from "../world/world-state-v2";
import {
  DEFAULT_TERRITORY_REPLACE_POLICY,
  planTerritoryReplace,
} from "./territory-replace-planner";

const countryId = issueCountryId(
  "AAA",
  createCountryIdRegistry({activeCountryIds: [], retiredCountryIds: []}),
);
const country = createCountryEntity({
  id: countryId,
  names: {shortKo: "A", officialKo: "A", mapKo: "A", english: "A", searchAliases: ["AAA"]},
  politicalStatus: "sovereign",
  presentationOverride: null,
  moduleVersions: {core: 1, names: 1},
});
const territory = (sourceFeatureId: string) =>
  deriveTerritoryId({kind: "seed", seedVersion: "replace-v1", sourceFeatureId});
const sourceId = territory("source");
const neighborId = territory("neighbor");
const remoteId = territory("remote");
const unknownId = territory("unknown");
const geometryHashPolicy = {
  coordinatePrecision: DEFAULT_TERRITORY_REPLACE_POLICY.coordinatePrecision,
  exteriorRingWinding: DEFAULT_TERRITORY_REPLACE_POLICY.exteriorRingWinding,
};

const rectangle = (left: number, right: number): TerritoryGeometry => ({
  type: "Polygon",
  coordinates: [[[left, 0], [right, 0], [right, 1], [left, 1], [left, 0]]],
});

const fixture = () => {
  const source = createTerritoryEntity({
    id: sourceId,
    ownerCountryId: countryId,
    geometry: rectangle(0, 1),
    properties: {region: "source"},
  });
  const neighbor = createTerritoryEntity({
    id: neighborId,
    ownerCountryId: countryId,
    geometry: rectangle(1, 2),
    properties: {region: "neighbor"},
  });
  const remote = createTerritoryEntity({
    id: remoteId,
    ownerCountryId: countryId,
    geometry: rectangle(10, 11),
    properties: {region: "remote"},
  });
  const territoriesById = {[source.id]: source, [neighbor.id]: neighbor, [remote.id]: remote};
  const topology = buildCanonicalTopology(territoriesById);
  return createWorldStateV2({
    schemaVersion: WORLD_STATE_V2_SCHEMA_VERSION,
    seedVersion: "replace-v1",
    policyVersion: DEFAULT_TERRITORY_REPLACE_POLICY.version,
    revision: 16,
    countriesById: {AAA: country},
    countryOrder: [countryId],
    retiredCountryIds: [],
    territoriesById,
    territoryOrder: [source.id, neighbor.id, remote.id],
    topology,
    hashRoots: {
      countriesRootHash: buildDomainRootHash("countries", {AAA: countryCoreLeafHash(country)}),
      presentationRootHash: buildDomainRootHash("presentation", {
        AAA: countryPresentationLeafHash(country, DEFAULT_TERRITORY_REPLACE_POLICY.version),
      }),
      territoriesRootHash: buildDomainRootHash("territories", Object.fromEntries(
        Object.entries(territoriesById).flatMap(([id, value]) => [
          [`geometry:${id}`, territoryGeometryLeafHash(value, geometryHashPolicy)],
          [`ownership:${id}`, territoryOwnershipLeafHash(value)],
        ]),
      )),
      topologyRootHash: buildDomainRootHash("topology", Object.fromEntries(
        Object.entries(topology.edgesById).map(([id, edge]) => [id, topologyEdgeLeafHash(edge)]),
      )),
    },
  });
};

const command = (
  geometry: TerritoryGeometry = rectangle(-0.2, 1),
  territoryId = sourceId,
) => parseTerritoryReplaceV2Command({
  commandId: "replace-source-geometry",
  type: "territory.replace",
  expectedRevision: 16,
  payload: {territoryId, geometry},
});

describe("10-70 territory.replace planner", () => {
  it("normalizes replacement geometry and recomputes only direct bbox candidates", () => {
    const state = fixture();
    const sourceBefore = state.territoriesById[sourceId];
    const remoteEdgesBefore = Object.values(state.topology.edgesById)
      .filter(({territoryIds}) => territoryIds.includes(remoteId));
    const before = JSON.stringify(state);
    const result = planTerritoryReplace(state, command({
      type: "Polygon",
      coordinates: [[[1, 1], [1, 0], [-0.2, 0], [-0.2, 1], [1, 1]]],
    }), {committedCommandIds: new Set()});

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const next = result.plan.nextState;
    expect(next.revision).toBe(17);
    expect(next.territoriesById[sourceId].geometry).toEqual(rectangle(-0.2, 1));
    expect(next.territoriesById[sourceId].ownerCountryId).toBe(sourceBefore.ownerCountryId);
    expect(next.territoriesById[sourceId].properties).toBe(sourceBefore.properties);
    expect(next.territoriesById[neighborId]).toBe(state.territoriesById[neighborId]);
    expect(next.territoriesById[remoteId]).toBe(state.territoriesById[remoteId]);
    expect(result.plan.patch.measurements).toEqual({
      overlapArea: 0,
      uncoveredSharedBoundaryLength: 0,
    });
    expect(result.plan.patch.recomputedTerritoryIds).toEqual([neighborId, sourceId].sort());
    const remoteEdgesAfter = Object.values(next.topology.edgesById)
      .filter(({territoryIds}) => territoryIds.includes(remoteId));
    expect(remoteEdgesAfter).toEqual(remoteEdgesBefore);
    expect(remoteEdgesAfter.every((edge, index) => edge === remoteEdgesBefore[index])).toBe(true);
    expect(next.countriesById).toBe(state.countriesById);
    expect(next.countryOrder).toBe(state.countryOrder);
    expect(next.territoryOrder).toBe(state.territoryOrder);
    expect(next.hashRoots.countriesRootHash).toBe(state.hashRoots.countriesRootHash);
    expect(next.hashRoots.presentationRootHash).toBe(state.hashRoots.presentationRootHash);
    expect(next.hashRoots.territoriesRootHash).not.toBe(state.hashRoots.territoriesRootHash);
    expect(next.hashRoots.topologyRootHash).not.toBe(state.hashRoots.topologyRootHash);
    expect(() => createWorldStateV2(next)).not.toThrow();
    expect(JSON.stringify(state)).toBe(before);
  });

  it.each([
    ["neighbor overlap", command(rectangle(-0.2, 1.1)), "territory-replace-overlap"],
    ["neighbor gap", command(rectangle(-0.2, 0.9)), "territory-replace-gap"],
    ["unknown Territory", command(rectangle(-0.2, 1), unknownId), "territory-not-found"],
  ])("rejects %s without exposing a partial state", (_label, invalidCommand, code) => {
    const state = fixture();
    const before = JSON.stringify(state);
    const result = planTerritoryReplace(state, invalidCommand, {committedCommandIds: new Set()});

    expect(result).toEqual(expect.objectContaining({
      ok: false,
      error: expect.objectContaining({code}),
    }));
    expect(JSON.stringify(state)).toBe(before);
  });

  it("rejects invalid geometry and a policy version that does not match WorldState", () => {
    const invalidGeometry = command({
      type: "Polygon",
      coordinates: [[[0, 0], [1, 1], [0, 1], [1, 0], [0, 0]]],
    });
    expect(planTerritoryReplace(
      fixture(),
      invalidGeometry,
      {committedCommandIds: new Set()},
    )).toEqual(expect.objectContaining({
      ok: false,
      error: expect.objectContaining({code: "territory-geometry-invalid"}),
    }));

    expect(planTerritoryReplace(
      fixture(),
      command(),
      {committedCommandIds: new Set()},
      {...DEFAULT_TERRITORY_REPLACE_POLICY, version: "other-policy"},
    )).toEqual(expect.objectContaining({
      ok: false,
      error: expect.objectContaining({code: "policy-version-mismatch"}),
    }));
  });
});
