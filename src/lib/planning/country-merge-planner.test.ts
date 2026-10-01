import {describe, expect, it} from "vitest";

import {parseCountryMergeV2Command} from "../commands/country-merge-v2";
import {buildCanonicalTopology} from "../world/canonical-topology";
import {countryCoreLeafHash} from "../world/country-core-hash";
import {createCountryEntity, type CountryEntity} from "../world/country-entity";
import {createCountryIdRegistry, issueCountryId, retireCountryId} from "../world/country-id";
import {countryPresentationLeafHash} from "../world/country-presentation-hash";
import {buildDomainRootHash} from "../world/domain-hash-root";
import {territoryGeometryLeafHash} from "../world/territory-geometry-hash";
import {createTerritoryEntity} from "../world/territory-entity";
import {deriveTerritoryId} from "../world/territory-id";
import {territoryOwnershipLeafHash} from "../world/territory-ownership-hash";
import {topologyEdgeLeafHash} from "../world/topology-edge-hash";
import {createWorldStateV2, WORLD_STATE_V2_SCHEMA_VERSION} from "../world/world-state-v2";
import {planCountryMerge} from "./country-merge-planner";

const registry = createCountryIdRegistry({activeCountryIds: [], retiredCountryIds: []});
const country = (
  id: string,
  input: Partial<Omit<CountryEntity, "id">> = {},
) => createCountryEntity({
  id: issueCountryId(id, registry),
  names: {
    shortKo: `${id}-short`,
    officialKo: `${id}-official`,
    mapKo: `${id}-map`,
    english: `${id}-english`,
    searchAliases: [id],
  },
  politicalStatus: "sovereign",
  presentationOverride: null,
  moduleVersions: {core: 1, names: 1},
  ...input,
});
const countryA = country("AAA", {moduleVersions: {core: 2, names: 1}});
const countryB = country("BBB", {
  politicalStatus: "disputed",
  moduleVersions: {core: 3, names: 4},
});
const countryC = country("CCC", {politicalStatus: "dependent"});
const retired = retireCountryId(issueCountryId("OLD", registry));
const territoryIds = {
  a: deriveTerritoryId({kind: "seed", seedVersion: "merge-v1", sourceFeatureId: "a"}),
  b: deriveTerritoryId({kind: "seed", seedVersion: "merge-v1", sourceFeatureId: "b"}),
  c: deriveTerritoryId({kind: "seed", seedVersion: "merge-v1", sourceFeatureId: "c"}),
};
const geometryPolicy = {coordinatePrecision: 6, exteriorRingWinding: "counterclockwise" as const};

const rectangle = (left: number, right: number) => ({
  type: "Polygon" as const,
  coordinates: [[[left, 0], [right, 0], [right, 10], [left, 10], [left, 0]]],
});

const fixture = () => {
  const countriesById = {AAA: countryA, BBB: countryB, CCC: countryC};
  const territoryA = createTerritoryEntity({
    id: territoryIds.a,
    ownerCountryId: countryA.id,
    geometry: rectangle(0, 5),
    properties: {region: "a"},
  });
  const territoryB = createTerritoryEntity({
    id: territoryIds.b,
    ownerCountryId: countryB.id,
    geometry: rectangle(5, 10),
    properties: {region: "b"},
  });
  const territoryC = createTerritoryEntity({
    id: territoryIds.c,
    ownerCountryId: countryC.id,
    geometry: rectangle(10, 15),
    properties: {region: "c"},
  });
  const territoriesById = {
    [territoryA.id]: territoryA,
    [territoryB.id]: territoryB,
    [territoryC.id]: territoryC,
  };
  const topology = buildCanonicalTopology(territoriesById);
  return createWorldStateV2({
    schemaVersion: WORLD_STATE_V2_SCHEMA_VERSION,
    seedVersion: "merge-v1",
    policyVersion: "world-policy-v1",
    revision: 30,
    countriesById,
    countryOrder: [countryA.id, countryB.id, countryC.id],
    retiredCountryIds: [retired],
    territoriesById,
    territoryOrder: [territoryA.id, territoryB.id, territoryC.id],
    topology,
    hashRoots: {
      countriesRootHash: buildDomainRootHash("countries", Object.fromEntries(
        Object.entries(countriesById).map(([id, value]) => [id, countryCoreLeafHash(value)]),
      )),
      presentationRootHash: buildDomainRootHash("presentation", Object.fromEntries(
        Object.entries(countriesById).map(([id, value]) => [
          id,
          countryPresentationLeafHash(value, "world-policy-v1"),
        ]),
      )),
      territoriesRootHash: buildDomainRootHash("territories", Object.fromEntries(
        Object.entries(territoriesById).flatMap(([id, value]) => [
          [`geometry:${id}`, territoryGeometryLeafHash(value, geometryPolicy)],
          [`ownership:${id}`, territoryOwnershipLeafHash(value)],
        ]),
      )),
      topologyRootHash: buildDomainRootHash("topology", Object.fromEntries(
        Object.entries(topology.edgesById).map(([id, edge]) => [id, topologyEdgeLeafHash(edge)]),
      )),
    },
  });
};

const identity = (id: string) => ({
  id,
  names: {
    shortKo: `${id}-short`,
    officialKo: `${id}-official`,
    mapKo: `${id}-map`,
    english: `${id}-english`,
    searchAliases: [id],
  },
  politicalStatus: "sovereign" as const,
  presentationOverride: null,
  moduleVersions: {core: 1, names: 1},
});

const command = (overrides: Record<string, unknown> = {}) => parseCountryMergeV2Command({
  commandId: "merge-a-b",
  type: "country.merge",
  expectedRevision: 30,
  payload: {
    sourceCountryIds: ["AAA", "BBB"],
    resultCountry: {kind: "new-country", country: identity("ABU")},
    metadataInheritance: {mode: "preserve-result"},
    ...overrides,
  },
});

describe("10-73 country.merge planner", () => {
  it("creates a new result, removes every source ID, and transfers all source Territory ownership", () => {
    const state = fixture();
    const before = JSON.stringify(state);
    const beforeGeometryHashes = Object.fromEntries(state.territoryOrder.map((id) => [
      id,
      territoryGeometryLeafHash(state.territoriesById[id], geometryPolicy),
    ]));
    const result = planCountryMerge(state, command(), {committedCommandIds: new Set()});

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const next = result.plan.nextState;
    expect(next.revision).toBe(31);
    expect(next.countryOrder).toEqual(["ABU", "CCC"]);
    expect(next.countriesById.AAA).toBeUndefined();
    expect(next.countriesById.BBB).toBeUndefined();
    expect(next.countriesById.ABU.names.shortKo).toBe("ABU-short");
    expect(next.retiredCountryIds.has(retireCountryId(countryA.id))).toBe(true);
    expect(next.retiredCountryIds.has(retireCountryId(countryB.id))).toBe(true);
    expect(next.territoriesById[territoryIds.a].ownerCountryId).toBe("ABU");
    expect(next.territoriesById[territoryIds.b].ownerCountryId).toBe("ABU");
    expect(next.territoriesById[territoryIds.c]).toBe(state.territoriesById[territoryIds.c]);
    expect(result.plan.patch).toEqual(expect.objectContaining({
      kind: "country.merge",
      resultCountryId: "ABU",
      removedSourceCountryIds: ["AAA", "BBB"],
      measurements: {sourceTerritoryCount: 2, resultOwnedSourceTerritoryCount: 2},
    }));
    expect(Object.fromEntries(next.territoryOrder.map((id) => [
      id,
      territoryGeometryLeafHash(next.territoriesById[id], geometryPolicy),
    ]))).toEqual(beforeGeometryHashes);
    expect(next.territoryOrder).toBe(state.territoryOrder);
    expect(next.topology).toBe(state.topology);
    expect(next.hashRoots.topologyRootHash).toBe(state.hashRoots.topologyRootHash);
    expect(next.hashRoots.countriesRootHash).not.toBe(state.hashRoots.countriesRootHash);
    expect(next.hashRoots.presentationRootHash).not.toBe(state.hashRoots.presentationRootHash);
    expect(next.hashRoots.territoriesRootHash).not.toBe(state.hashRoots.territoriesRootHash);
    expect(() => createWorldStateV2(next)).not.toThrow();
    expect(JSON.stringify(state)).toBe(before);
  });

  it("retains an existing source result and inherits only explicitly selected metadata fields", () => {
    const result = planCountryMerge(fixture(), command({
      resultCountry: {kind: "existing-country", countryId: "AAA"},
      metadataInheritance: {
        mode: "inherit-source",
        sourceCountryId: "BBB",
        fields: ["names", "moduleVersions"],
      },
    }), {committedCommandIds: new Set()});

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const next = result.plan.nextState;
    expect(next.countryOrder).toEqual(["AAA", "CCC"]);
    expect(next.countriesById.AAA.names).toEqual(countryB.names);
    expect(next.countriesById.AAA.moduleVersions).toEqual(countryB.moduleVersions);
    expect(next.countriesById.AAA.politicalStatus).toBe(countryA.politicalStatus);
    expect(next.countriesById.BBB).toBeUndefined();
    expect(next.retiredCountryIds.has(retireCountryId(countryA.id))).toBe(false);
    expect(next.retiredCountryIds.has(retireCountryId(countryB.id))).toBe(true);
    expect(next.territoriesById[territoryIds.a].ownerCountryId).toBe("AAA");
    expect(next.territoriesById[territoryIds.b].ownerCountryId).toBe("AAA");
    expect(result.plan.patch.removedSourceCountryIds).toEqual(["BBB"]);
  });

  it("merges sources into an existing non-source result without disturbing its Territory", () => {
    const state = fixture();
    const result = planCountryMerge(state, command({
      resultCountry: {kind: "existing-country", countryId: "CCC"},
    }), {committedCommandIds: new Set()});

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.nextState.countryOrder).toEqual(["CCC"]);
    expect(result.plan.nextState.territoriesById[territoryIds.a].ownerCountryId).toBe("CCC");
    expect(result.plan.nextState.territoriesById[territoryIds.b].ownerCountryId).toBe("CCC");
    expect(result.plan.nextState.territoriesById[territoryIds.c]).toBe(state.territoriesById[territoryIds.c]);
  });

  it.each([
    ["duplicate source", {sourceCountryIds: ["AAA", "AAA"]}, "merge-source-country-duplicate"],
    ["unknown source", {sourceCountryIds: ["AAA", "ZZZ"]}, "country-not-found"],
    ["retired source", {sourceCountryIds: ["AAA", "OLD"]}, "country-id-retired"],
    ["active new result", {resultCountry: {kind: "new-country", country: identity("CCC")}}, "country-id-active"],
    ["retired new result", {resultCountry: {kind: "new-country", country: identity("OLD")}}, "country-id-retired"],
    ["unknown existing result", {resultCountry: {kind: "existing-country", countryId: "ZZZ"}}, "country-not-found"],
    ["retired existing result", {resultCountry: {kind: "existing-country", countryId: "OLD"}}, "country-id-retired"],
    ["metadata from non-source", {
      metadataInheritance: {
        mode: "inherit-source",
        sourceCountryId: "CCC",
        fields: ["names"],
      },
    }, "merge-metadata-source-invalid"],
  ])("rejects %s", (_label, overrides, code) => {
    const result = planCountryMerge(fixture(), command(overrides), {committedCommandIds: new Set()});
    expect(result).toEqual(expect.objectContaining({
      ok: false,
      error: expect.objectContaining({code}),
    }));
  });
});
