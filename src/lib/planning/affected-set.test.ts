import {describe, expect, it} from "vitest";

import {createCountryEntity} from "../world/country-entity";
import {createCountryIdRegistry, issueCountryId} from "../world/country-id";
import {buildDomainRootHash} from "../world/domain-hash-root";
import {buildCanonicalTopology} from "../world/canonical-topology";
import {territoryGeometryLeafHash} from "../world/territory-geometry-hash";
import {createTerritoryEntity, type TerritoryGeometry} from "../world/territory-entity";
import {deriveTerritoryId} from "../world/territory-id";
import {territoryOwnershipLeafHash} from "../world/territory-ownership-hash";
import {topologyEdgeLeafHash} from "../world/topology-edge-hash";
import {createWorldStateV2, WORLD_STATE_V2_SCHEMA_VERSION} from "../world/world-state-v2";
import {calculateAffectedSet} from "./affected-set";
import type {CommandBatchPatch} from "./command-batch-planner";
import type {TerritoryTransferPatch} from "./territory-transfer-planner";

const registry = createCountryIdRegistry({activeCountryIds: [], retiredCountryIds: []});
const countryA = issueCountryId("AAA", registry);
const countryB = issueCountryId("BBB", registry);
const countryC = issueCountryId("CCC", registry);

const country = (id: typeof countryA) => createCountryEntity({
  id,
  names: {shortKo: id, officialKo: id, mapKo: id, english: id, searchAliases: [id]},
  politicalStatus: "sovereign",
  presentationOverride: null,
  moduleVersions: {core: 1},
});

const territoryId = (name: string) =>
  deriveTerritoryId({kind: "seed", seedVersion: "affected-v1", sourceFeatureId: name});

const westId = territoryId("west");
const centerId = territoryId("center");
const eastId = territoryId("east");
const remoteId = territoryId("remote");

const rectangle = (left: number, right: number): TerritoryGeometry => ({
  type: "Polygon",
  coordinates: [[[left, 0], [right, 0], [right, 10], [left, 10], [left, 0]]],
});

const fixture = () => {
  const countriesById = {
    AAA: country(countryA),
    BBB: country(countryB),
    CCC: country(countryC),
  };
  const territoriesById = {
    [westId]: createTerritoryEntity({
      id: westId,
      ownerCountryId: countryA,
      geometry: rectangle(0, 10),
      properties: {},
    }),
    [centerId]: createTerritoryEntity({
      id: centerId,
      ownerCountryId: countryA,
      geometry: rectangle(10, 20),
      properties: {},
    }),
    [eastId]: createTerritoryEntity({
      id: eastId,
      ownerCountryId: countryB,
      geometry: rectangle(20, 30),
      properties: {},
    }),
    [remoteId]: createTerritoryEntity({
      id: remoteId,
      ownerCountryId: countryC,
      geometry: rectangle(100, 110),
      properties: {},
    }),
  };
  const topology = buildCanonicalTopology(territoriesById);
  const geometryPolicy = {coordinatePrecision: 9, exteriorRingWinding: "counterclockwise" as const};

  return createWorldStateV2({
    schemaVersion: WORLD_STATE_V2_SCHEMA_VERSION,
    seedVersion: "affected-v1",
    policyVersion: "world-policy-v1",
    revision: 21,
    countriesById,
    countryOrder: [countryA, countryB, countryC],
    retiredCountryIds: [],
    territoriesById,
    territoryOrder: [westId, centerId, eastId, remoteId],
    topology,
    hashRoots: {
      countriesRootHash: buildDomainRootHash("countries", {}),
      presentationRootHash: buildDomainRootHash("presentation", {}),
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

const edgeIdsTouching = (
  state: ReturnType<typeof fixture>,
  territoryId: string,
) => Object.values(state.topology.edgesById)
  .filter(({territoryIds}) => territoryIds.includes(territoryId as never))
  .map(({id}) => id)
  .sort();

describe("10-76 affected set calculation", () => {
  it("includes direct and neighbor Territory impacts without unrelated remote IDs", () => {
    const state = fixture();
    const patch: TerritoryTransferPatch = {
      kind: "territory.transfer",
      territoryId: centerId,
      beforeOwnerCountryId: countryA,
      afterOwnerCountryId: countryB,
      measurements: {
        areaBefore: 100,
        areaAfter: 100,
        areaDifference: 0,
        geometryHashBefore: "before",
        geometryHashAfter: "after",
      },
    };

    const affected = calculateAffectedSet({beforeState: state, patch});

    expect(affected.countryIds).toEqual(["AAA", "BBB"]);
    expect(affected.directTerritoryIds).toEqual([centerId]);
    expect(affected.territoryIds).toEqual([centerId, eastId, westId].sort());
    expect(affected.territoryIds).not.toContain(remoteId);
    expect(affected.topologyEdgeIds).toEqual([
      ...new Set([
        ...edgeIdsTouching(state, westId),
        ...edgeIdsTouching(state, centerId),
        ...edgeIdsTouching(state, eastId),
      ]),
    ].sort());
    expect(affected.topologyEdgeIds).not.toEqual(
      expect.arrayContaining(edgeIdsTouching(state, remoteId)),
    );
  });

  it("recursively unions command.batch child patch impacts", () => {
    const state = fixture();
    const patch: CommandBatchPatch = {
      kind: "command.batch",
      commandPatches: [
        {kind: "country.create", countryId: "DDD"},
        {
          kind: "territory.transfer",
          territoryId: westId,
          beforeOwnerCountryId: countryA,
          afterOwnerCountryId: countryB,
          measurements: {
            areaBefore: 100,
            areaAfter: 100,
            areaDifference: 0,
            geometryHashBefore: "before",
            geometryHashAfter: "after",
          },
        },
      ],
    };

    const affected = calculateAffectedSet({beforeState: state, patch});

    expect(affected.countryIds).toEqual(["AAA", "BBB", "DDD"]);
    expect(affected.directTerritoryIds).toEqual([westId]);
    expect(affected.territoryIds).toEqual([centerId, westId].sort());
    expect(affected.territoryIds).not.toContain(eastId);
    expect(affected.territoryIds).not.toContain(remoteId);
  });
});
