import {describe, expect, it} from "vitest";

import {parseTerritoryPartitionV2Command} from "../commands/territory-partition-v2";
import {countryCoreLeafHash} from "../world/country-core-hash";
import {createCountryEntity} from "../world/country-entity";
import {issueCountryId, createCountryIdRegistry} from "../world/country-id";
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
  DEFAULT_TERRITORY_PARTITION_POLICY,
  planTerritoryPartition,
} from "./territory-partition-planner";

const registry = createCountryIdRegistry({activeCountryIds: [], retiredCountryIds: []});
const countryA = createCountryEntity({
  id: issueCountryId("AAA", registry),
  names: {shortKo: "A", officialKo: "A", mapKo: "A", english: "A", searchAliases: ["AAA"]},
  politicalStatus: "sovereign",
  presentationOverride: null,
  moduleVersions: {core: 1, names: 1},
});
const countryB = createCountryEntity({
  id: issueCountryId("BBB", registry),
  names: {shortKo: "B", officialKo: "B", mapKo: "B", english: "B", searchAliases: ["BBB"]},
  politicalStatus: "sovereign",
  presentationOverride: null,
  moduleVersions: {core: 1, names: 1},
});
const sourceId = deriveTerritoryId({kind: "seed", seedVersion: "partition-v1", sourceFeatureId: "source"});
const neighborId = deriveTerritoryId({kind: "seed", seedVersion: "partition-v1", sourceFeatureId: "neighbor"});

const rectangle = (left: number, bottom: number, right: number, top: number): TerritoryGeometry => ({
  type: "Polygon",
  coordinates: [[[left, bottom], [right, bottom], [right, top], [left, top], [left, bottom]]],
});

const geometryPolicy = {
  coordinatePrecision: DEFAULT_TERRITORY_PARTITION_POLICY.coordinatePrecision,
  exteriorRingWinding: DEFAULT_TERRITORY_PARTITION_POLICY.exteriorRingWinding,
};

const fixture = () => {
  const countriesById = {AAA: countryA, BBB: countryB};
  const source = createTerritoryEntity({
    id: sourceId,
    ownerCountryId: countryA.id,
    geometry: rectangle(0, 0, 10, 10),
    properties: {region: "source", population: 100},
  });
  const neighbor = createTerritoryEntity({
    id: neighborId,
    ownerCountryId: countryB.id,
    geometry: rectangle(10, 0, 20, 10),
    properties: {region: "neighbor"},
  });
  const territoriesById = {[source.id]: source, [neighbor.id]: neighbor};
  const topology = buildCanonicalTopology(territoriesById);
  return createWorldStateV2({
    schemaVersion: WORLD_STATE_V2_SCHEMA_VERSION,
    seedVersion: "partition-v1",
    policyVersion: DEFAULT_TERRITORY_PARTITION_POLICY.version,
    revision: 13,
    countriesById,
    countryOrder: [countryA.id, countryB.id],
    retiredCountryIds: [],
    territoriesById,
    territoryOrder: [source.id, neighbor.id],
    topology,
    hashRoots: {
      countriesRootHash: buildDomainRootHash("countries", Object.fromEntries(
        Object.entries(countriesById).map(([id, country]) => [id, countryCoreLeafHash(country)]),
      )),
      presentationRootHash: buildDomainRootHash("presentation", Object.fromEntries(
        Object.entries(countriesById).map(([id, country]) => [
          id,
          countryPresentationLeafHash(country, DEFAULT_TERRITORY_PARTITION_POLICY.version),
        ]),
      )),
      territoriesRootHash: buildDomainRootHash("territories", Object.fromEntries(
        Object.entries(territoriesById).flatMap(([id, territory]) => [
          [`geometry:${id}`, territoryGeometryLeafHash(territory, geometryPolicy)],
          [`ownership:${id}`, territoryOwnershipLeafHash(territory)],
        ]),
      )),
      topologyRootHash: buildDomainRootHash("topology", Object.fromEntries(
        Object.entries(topology.edgesById).map(([id, edge]) => [id, topologyEdgeLeafHash(edge)]),
      )),
    },
  });
};

const command = (
  west: TerritoryGeometry = rectangle(0, 0, 5, 10),
  east: TerritoryGeometry = rectangle(5, 0, 10, 10),
  keys = ["west", "east"],
) => parseTerritoryPartitionV2Command({
  commandId: "partition-source",
  type: "territory.partition",
  expectedRevision: 13,
  payload: {
    sourceTerritoryId: sourceId,
    partitions: [
      {partitionKey: keys[0], geometry: west},
      {partitionKey: keys[1], geometry: east},
    ],
  },
});

describe("10-67 territory.partition planner", () => {
  it("atomically replaces the source with deterministic partitions and rebuilt topology", () => {
    const state = fixture();
    const before = JSON.stringify(state);
    const result = planTerritoryPartition(state, command(), {committedCommandIds: new Set()});

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const westId = deriveTerritoryId({kind: "partition", sourceTerritoryId: sourceId, partitionKey: "west"});
    const eastId = deriveTerritoryId({kind: "partition", sourceTerritoryId: sourceId, partitionKey: "east"});
    const next = result.plan.nextState;

    expect(next.revision).toBe(14);
    expect(next.territoriesById[sourceId]).toBeUndefined();
    expect(next.territoryOrder).toEqual([eastId, westId, neighborId].sort());
    expect(next.territoriesById[westId]).toMatchObject({
      id: westId,
      ownerCountryId: "AAA",
      properties: {region: "source", population: 100},
    });
    expect(next.territoriesById[eastId].ownerCountryId).toBe("AAA");
    expect(Object.values(next.topology.edgesById).some(({territoryIds}) =>
      territoryIds.includes(westId) && territoryIds.includes(eastId))).toBe(true);
    expect(Object.values(next.topology.edgesById).some(({territoryIds}) =>
      territoryIds.includes(sourceId))).toBe(false);
    expect(result.plan.patch.measurements).toEqual({
      sourceArea: 100,
      partitionAreaSum: 100,
      unionArea: 100,
      gapArea: 0,
      overlapArea: 0,
      outsideSourceArea: 0,
      areaConservationError: 0,
    });
    expect(result.plan.patch.policyVersion).toBe(DEFAULT_TERRITORY_PARTITION_POLICY.version);
    expect(next.countriesById).toBe(state.countriesById);
    expect(next.countryOrder).toBe(state.countryOrder);
    expect(next.hashRoots.countriesRootHash).toBe(state.hashRoots.countriesRootHash);
    expect(next.hashRoots.presentationRootHash).toBe(state.hashRoots.presentationRootHash);
    expect(next.hashRoots.territoriesRootHash).not.toBe(state.hashRoots.territoriesRootHash);
    expect(next.hashRoots.topologyRootHash).not.toBe(state.hashRoots.topologyRootHash);
    expect(() => createWorldStateV2(next)).not.toThrow();
    expect(JSON.stringify(state)).toBe(before);
  });

  it.each([
    ["gap", command(rectangle(0, 0, 4, 10), rectangle(5, 0, 10, 10)), "partition-gap"],
    ["overlap", command(rectangle(0, 0, 6, 10), rectangle(5, 0, 10, 10)), "partition-overlap"],
    ["outside area", command(rectangle(0, 0, 5, 10), rectangle(5, 0, 11, 10)), "partition-outside-source"],
    ["duplicate key", command(undefined, undefined, ["west", "west"]), "partition-key-duplicate"],
  ])("rejects a partition with %s", (_label, invalidCommand, code) => {
    const state = fixture();
    const result = planTerritoryPartition(state, invalidCommand, {committedCommandIds: new Set()});

    expect(result).toEqual(expect.objectContaining({
      ok: false,
      error: expect.objectContaining({code}),
    }));
    expect(state.revision).toBe(13);
    expect(state.territoriesById[sourceId]).toBeDefined();
  });

  it("rejects a partition below the policy minimum area", () => {
    const policy = {...DEFAULT_TERRITORY_PARTITION_POLICY, minimumPartitionArea: 0.1};
    const result = planTerritoryPartition(
      fixture(),
      command(rectangle(0, 0, 0.005, 10), rectangle(0.005, 0, 10, 10)),
      {committedCommandIds: new Set()},
      policy,
    );

    expect(result).toEqual(expect.objectContaining({
      ok: false,
      error: expect.objectContaining({code: "partition-area-below-minimum"}),
    }));
  });

  it("accepts numerical area drift only inside the policy tolerance", () => {
    const policy = {
      ...DEFAULT_TERRITORY_PARTITION_POLICY,
      coordinatePrecision: 12,
      booleanAreaTolerance: 1e-8,
    };
    const result = planTerritoryPartition(
      fixture(),
      command(rectangle(0, 0, 5, 10), rectangle(5.0000000005, 0, 10, 10)),
      {committedCommandIds: new Set()},
      policy,
    );

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.plan.patch.measurements.gapArea).toBeLessThanOrEqual(1e-8);
  });
});
