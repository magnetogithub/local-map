import {describe, expect, it} from "vitest";

import {buildDomainRootHash} from "../world/domain-hash-root";
import {createCountryEntity} from "../world/country-entity";
import type {ActiveCountryId} from "../world/country-id";
import type {WorldPatchV2} from "../planning/world-patch-v2";
import {createTopologyState} from "../world/topology-state";
import {createTerritoryEntity, type TerritoryGeometry} from "../world/territory-entity";
import {deriveTerritoryId, type TerritoryId} from "../world/territory-id";
import {
  createWorldStateV2,
  WORLD_STATE_V2_SCHEMA_VERSION,
  type WorldStateV2,
} from "../world/world-state-v2";
import {
  applyTerritoryPolygonIndexPatch,
  createTerritoryPolygonIndexProjection,
  getOwnerTerritoryPolygonBuckets,
  getTerritoryPolygonBucket,
} from "./territory-polygon-index";

const rectangle = (x: number): TerritoryGeometry => ({
  type: "Polygon",
  coordinates: [[
    [x, 0],
    [x + 1, 0],
    [x + 1, 1],
    [x, 1],
    [x, 0],
  ]],
});

const territoryId = (sourceFeatureId: string) =>
  deriveTerritoryId({kind: "seed", seedVersion: "10-92-test", sourceFeatureId});

const activeCountryId = (countryId: "AAA" | "BBB") => countryId as ActiveCountryId;

const territory = (
  id: TerritoryId,
  ownerCountryId: "AAA" | "BBB" | null,
  x: number,
) => createTerritoryEntity({
  id,
  ownerCountryId,
  geometry: rectangle(x),
  properties: {sourceFeatureId: id},
});

const country = (id: "AAA" | "BBB") => createCountryEntity({
  id: activeCountryId(id),
  names: {
    shortKo: id,
    officialKo: `${id} Republic`,
    mapKo: id,
    english: `${id} Republic`,
    searchAliases: [id],
  },
  politicalStatus: "sovereign",
  presentationOverride: null,
  moduleVersions: {core: 1, names: 1},
});

const multiTerritoryWorld = (): WorldStateV2 => {
  const alpha = territoryId("alpha");
  const beta = territoryId("beta");
  const gamma = territoryId("gamma");
  const territories = {
    [alpha]: territory(alpha, "AAA", 0),
    [beta]: territory(beta, "AAA", 2),
    [gamma]: territory(gamma, "BBB", 4),
  };
  return createWorldStateV2({
    schemaVersion: WORLD_STATE_V2_SCHEMA_VERSION,
    seedVersion: "10-92-test",
    policyVersion: "world-policy-v1",
    revision: 12,
    countriesById: {
      AAA: country("AAA"),
      BBB: country("BBB"),
    },
    countryOrder: [activeCountryId("AAA"), activeCountryId("BBB")],
    retiredCountryIds: [],
    territoriesById: territories,
    territoryOrder: [alpha, beta, gamma],
    topology: createTopologyState([]),
    hashRoots: {
      countriesRootHash: buildDomainRootHash("countries", {}),
      presentationRootHash: buildDomainRootHash("presentation", {}),
      territoriesRootHash: buildDomainRootHash("territories", {}),
      topologyRootHash: buildDomainRootHash("topology", {}),
    },
  });
};

const withTerritories = (
  previous: WorldStateV2,
  revision: number,
  territoriesById: WorldStateV2["territoriesById"],
  territoryOrder: readonly TerritoryId[],
) => createWorldStateV2({
  schemaVersion: WORLD_STATE_V2_SCHEMA_VERSION,
  seedVersion: previous.seedVersion,
  policyVersion: previous.policyVersion,
  revision,
  countriesById: previous.countriesById,
  countryOrder: previous.countryOrder,
  retiredCountryIds: previous.retiredCountryIds,
  territoriesById,
  territoryOrder,
  topology: createTopologyState([]),
  hashRoots: previous.hashRoots,
});

const polygonPatch = (
  beforeRevision: number,
  afterRevision: number,
  changes: WorldPatchV2["entityChangeSets"]["territories"],
): WorldPatchV2 => ({
  kind: "world.patch.v2",
  schemaVersion: 1,
  commandId: "10-93-polygon-patch",
  beforeRevision,
  afterRevision,
  beforeContentHash: "0".repeat(64),
  afterContentHash: "1".repeat(64),
  entityDeltas: {
    countryIds: [],
    territoryIds: [...changes.created, ...changes.updated, ...changes.deleted],
    topologyEdgeIds: [],
  },
  entityChangeSets: {
    countries: {created: [], updated: [], deleted: []},
    territories: changes,
    topologyEdges: {created: [], updated: [], deleted: []},
  },
  moduleHashDeltas: {
    country: null,
    territory: null,
    ownership: null,
    geometry: null,
    topology: null,
    presentation: null,
  },
  moduleLeafHashDeltas: {
    countryCore: [],
    countryPresentation: [],
    territoryGeometry: [],
    territoryOwnership: [],
    topologyEdge: [],
  },
  plannerPatch: {kind: "territory.replace"},
});

describe("10-92 Territory polygon index projection", () => {
  it("creates polygon feature buckets keyed by TerritoryId", () => {
    const state = multiTerritoryWorld();
    const projection = createTerritoryPolygonIndexProjection(state);
    const [alpha, beta] = state.territoryOrder;

    expect(projection.revision).toBe(12);
    expect(projection.bucketsByTerritoryId.size).toBe(3);
    expect(getTerritoryPolygonBucket(projection, alpha)?.features[0]).toMatchObject({
      type: "Feature",
      id: alpha,
      properties: {
        territoryId: alpha,
        ownerCountryId: "AAA",
      },
    });
    expect(getTerritoryPolygonBucket(projection, beta)?.features[0].geometry)
      .toBe(state.territoriesById[beta].geometry);
  });

  it("keeps multiple Territory polygon buckets for one owner country", () => {
    const state = multiTerritoryWorld();
    const projection = createTerritoryPolygonIndexProjection(state);

    const aaaBuckets = getOwnerTerritoryPolygonBuckets(projection, activeCountryId("AAA"));

    expect(aaaBuckets).toHaveLength(2);
    expect(aaaBuckets.map(({territoryId}) => territoryId)).toEqual([
      state.territoryOrder[0],
      state.territoryOrder[1],
    ]);
    expect(new Set(aaaBuckets.flatMap(({features}) => features.map(({id}) => id))).size).toBe(2);
    expect(aaaBuckets.every(({ownerCountryId}) => ownerCountryId === "AAA")).toBe(true);
  });

  it("applies polygon patches only to changed Territory features", () => {
    const before = multiTerritoryWorld();
    const projection = createTerritoryPolygonIndexProjection(before);
    const [alpha, beta, gamma] = before.territoryOrder;
    const delta = territoryId("delta");
    const alphaBucketBefore = getTerritoryPolygonBucket(projection, alpha);
    const betaBucketBefore = getTerritoryPolygonBucket(projection, beta);

    const after = withTerritories(
      before,
      13,
      {
        [alpha]: before.territoriesById[alpha],
        [beta]: territory(beta, "AAA", 20),
        [delta]: territory(delta, "AAA", 30),
      },
      [alpha, beta, delta],
    );
    const result = applyTerritoryPolygonIndexPatch(
      projection,
      polygonPatch(12, 13, {
        created: [delta],
        updated: [beta],
        deleted: [gamma],
      }),
      after,
    );

    expect(result.changedTerritoryIds).toEqual([delta, beta, gamma]);
    expect(result.projection.revision).toBe(13);
    expect(getTerritoryPolygonBucket(result.projection, alpha)).toBe(alphaBucketBefore);
    expect(getTerritoryPolygonBucket(result.projection, alpha)?.features[0])
      .toBe(alphaBucketBefore?.features[0]);
    expect(getTerritoryPolygonBucket(result.projection, beta)).not.toBe(betaBucketBefore);
    expect(getTerritoryPolygonBucket(result.projection, beta)?.features[0].geometry)
      .toBe(after.territoriesById[beta].geometry);
    expect(getTerritoryPolygonBucket(result.projection, gamma)).toBeNull();
    expect(getTerritoryPolygonBucket(result.projection, delta)?.ownerCountryId).toBe("AAA");
  });
});
