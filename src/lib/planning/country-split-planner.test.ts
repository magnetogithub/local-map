import {describe, expect, it} from "vitest";

import {parseCountrySplitV2Command} from "../commands/country-split-v2";
import {buildCanonicalTopology} from "../world/canonical-topology";
import {countryCoreLeafHash} from "../world/country-core-hash";
import {createCountryEntity} from "../world/country-entity";
import {createCountryIdRegistry, issueCountryId, retireCountryId} from "../world/country-id";
import {countryPresentationLeafHash} from "../world/country-presentation-hash";
import {buildDomainRootHash} from "../world/domain-hash-root";
import {territoryGeometryLeafHash} from "../world/territory-geometry-hash";
import {createTerritoryEntity} from "../world/territory-entity";
import {deriveTerritoryId} from "../world/territory-id";
import {territoryOwnershipLeafHash} from "../world/territory-ownership-hash";
import {topologyEdgeLeafHash} from "../world/topology-edge-hash";
import {createWorldStateV2, WORLD_STATE_V2_SCHEMA_VERSION} from "../world/world-state-v2";
import {planCountrySplit} from "./country-split-planner";

const registry = createCountryIdRegistry({activeCountryIds: [], retiredCountryIds: []});
const country = (id: string) => createCountryEntity({
  id: issueCountryId(id, registry),
  names: {shortKo: id, officialKo: id, mapKo: id, english: id, searchAliases: [id]},
  politicalStatus: "sovereign",
  presentationOverride: null,
  moduleVersions: {core: 1, names: 1},
});
const source = country("AAA");
const neighbor = country("BBB");
const retired = retireCountryId(issueCountryId("OLD", registry));
const northId = deriveTerritoryId({kind: "seed", seedVersion: "split-v1", sourceFeatureId: "north"});
const southId = deriveTerritoryId({kind: "seed", seedVersion: "split-v1", sourceFeatureId: "south"});
const neighborId = deriveTerritoryId({kind: "seed", seedVersion: "split-v1", sourceFeatureId: "neighbor"});
const geometryPolicy = {coordinatePrecision: 6, exteriorRingWinding: "counterclockwise" as const};

const rectangle = (left: number, bottom: number, right: number, top: number) => ({
  type: "Polygon" as const,
  coordinates: [[[left, bottom], [right, bottom], [right, top], [left, top], [left, bottom]]],
});

const fixture = () => {
  const countriesById = {AAA: source, BBB: neighbor};
  const north = createTerritoryEntity({
    id: northId,
    ownerCountryId: source.id,
    geometry: rectangle(0, 5, 10, 10),
    properties: {region: "north"},
  });
  const south = createTerritoryEntity({
    id: southId,
    ownerCountryId: source.id,
    geometry: rectangle(0, 0, 10, 5),
    properties: {region: "south"},
  });
  const external = createTerritoryEntity({
    id: neighborId,
    ownerCountryId: neighbor.id,
    geometry: rectangle(10, 0, 20, 10),
    properties: {region: "neighbor"},
  });
  const territoriesById = {[north.id]: north, [south.id]: south, [external.id]: external};
  const topology = buildCanonicalTopology(territoriesById);
  return createWorldStateV2({
    schemaVersion: WORLD_STATE_V2_SCHEMA_VERSION,
    seedVersion: "split-v1",
    policyVersion: "world-policy-v1",
    revision: 21,
    countriesById,
    countryOrder: [source.id, neighbor.id],
    retiredCountryIds: [retired],
    territoriesById,
    territoryOrder: [north.id, south.id, external.id],
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
  names: {shortKo: id, officialKo: id, mapKo: id, english: id, searchAliases: [id]},
  politicalStatus: "sovereign" as const,
  presentationOverride: null,
  moduleVersions: {core: 1, names: 1},
});

const command = (overrides: Record<string, unknown> = {}) => parseCountrySplitV2Command({
  commandId: "split-aaa",
  type: "country.split",
  expectedRevision: 21,
  payload: {
    sourceCountryId: "AAA",
    resultCountries: [
      {country: identity("CCC"), territorySources: [{kind: "territory-id", territoryId: northId}]},
      {country: identity("DDD"), territorySources: [{kind: "territory-id", territoryId: southId}]},
    ],
    ...overrides,
  },
});

describe("10-72 country.split planner", () => {
  it("atomically creates results, retires the source, and reallocates all source Territory ownership", () => {
    const state = fixture();
    const before = JSON.stringify(state);
    const beforeGeometryHashes = Object.fromEntries(state.territoryOrder.map((id) => [
      id,
      territoryGeometryLeafHash(state.territoriesById[id], geometryPolicy),
    ]));
    const result = planCountrySplit(state, command(), {committedCommandIds: new Set()});

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const next = result.plan.nextState;
    expect(next.revision).toBe(22);
    expect(next.countryOrder).toEqual(["BBB", "CCC", "DDD"]);
    expect(next.countriesById.AAA).toBeUndefined();
    expect(next.retiredCountryIds.has(retireCountryId(source.id))).toBe(true);
    expect(next.territoriesById[northId].ownerCountryId).toBe("CCC");
    expect(next.territoriesById[southId].ownerCountryId).toBe("DDD");
    expect(next.territoriesById[neighborId]).toBe(state.territoriesById[neighborId]);
    expect(result.plan.patch.measurements).toEqual({
      sourceTerritoryCount: 2,
      assignedTerritoryCount: 2,
      sourceArea: 100,
      assignedArea: 100,
      gapArea: 0,
      overlapArea: 0,
    });
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

  it.each([
    ["unknown source", {sourceCountryId: "ZZZ"}, "country-not-found"],
    ["retired source", {sourceCountryId: "OLD"}, "country-id-retired"],
    ["active result", {
      resultCountries: [
        {country: identity("BBB"), territorySources: [{kind: "territory-id", territoryId: northId}]},
        {country: identity("DDD"), territorySources: [{kind: "territory-id", territoryId: southId}]},
      ],
    }, "country-id-active"],
    ["retired result", {
      resultCountries: [
        {country: identity("OLD"), territorySources: [{kind: "territory-id", territoryId: northId}]},
        {country: identity("DDD"), territorySources: [{kind: "territory-id", territoryId: southId}]},
      ],
    }, "country-id-retired"],
    ["duplicate result", {
      resultCountries: [
        {country: identity("CCC"), territorySources: [{kind: "territory-id", territoryId: northId}]},
        {country: identity("CCC"), territorySources: [{kind: "territory-id", territoryId: southId}]},
      ],
    }, "split-result-country-duplicate"],
    ["ownership gap", {
      resultCountries: [
        {country: identity("CCC"), territorySources: [{kind: "territory-id", territoryId: northId}]},
        {country: identity("DDD"), territorySources: [{kind: "territory-id", territoryId: northId}]},
      ],
    }, "territory-source-duplicate"],
    ["foreign Territory", {
      resultCountries: [
        {country: identity("CCC"), territorySources: [{kind: "territory-id", territoryId: northId}]},
        {country: identity("DDD"), territorySources: [{kind: "territory-id", territoryId: neighborId}]},
      ],
    }, "territory-not-owned-by-source"],
  ])("rejects %s", (_label, overrides, code) => {
    const result = planCountrySplit(fixture(), command(overrides), {committedCommandIds: new Set()});
    expect(result).toEqual(expect.objectContaining({
      ok: false,
      error: expect.objectContaining({code}),
    }));
  });

  it("rejects missing source coverage when every referenced Territory is otherwise valid", () => {
    const state = fixture();
    const extraId = deriveTerritoryId({kind: "seed", seedVersion: "split-v1", sourceFeatureId: "extra"});
    const extra = createTerritoryEntity({
      id: extraId,
      ownerCountryId: source.id,
      geometry: rectangle(20, 0, 21, 1),
      properties: {},
    });
    const expanded = createWorldStateV2({
      ...state,
      territoriesById: {...state.territoriesById, [extraId]: extra},
      territoryOrder: [...state.territoryOrder, extraId],
    });
    const result = planCountrySplit(expanded, command(), {committedCommandIds: new Set()});
    expect(result).toEqual(expect.objectContaining({
      ok: false,
      error: expect.objectContaining({code: "territory-source-missing"}),
    }));
  });

  it("defers batch-local partition results to the stage 10-74 resolver", () => {
    const split = command({
      resultCountries: [
        {country: identity("CCC"), territorySources: [
          {kind: "partition-result", commandId: "partition", partitionKey: "north"},
        ]},
        {country: identity("DDD"), territorySources: [{kind: "territory-id", territoryId: southId}]},
      ],
    });
    const result = planCountrySplit(fixture(), split, {committedCommandIds: new Set()});
    expect(result).toEqual(expect.objectContaining({
      ok: false,
      error: expect.objectContaining({code: "partition-result-unresolved"}),
    }));
  });
});
