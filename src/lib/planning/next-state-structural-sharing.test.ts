import {describe, expect, it} from "vitest";

import {parseTerritoryTransferV2Command} from "../commands/territory-transfer-v2";
import {createCountryEntity} from "../world/country-entity";
import {createCountryIdRegistry, issueCountryId} from "../world/country-id";
import {buildDomainRootHash} from "../world/domain-hash-root";
import {buildCanonicalTopology} from "../world/canonical-topology";
import {territoryGeometryLeafHash} from "../world/territory-geometry-hash";
import {createTerritoryEntity, type TerritoryGeometry} from "../world/territory-entity";
import {deriveTerritoryId} from "../world/territory-id";
import {territoryOwnershipLeafHash} from "../world/territory-ownership-hash";
import {topologyEdgeLeafHash} from "../world/topology-edge-hash";
import {createWorldStateV2, type WorldStateV2, WORLD_STATE_V2_SCHEMA_VERSION} from "../world/world-state-v2";
import {calculateAffectedSet} from "./affected-set";
import {
  hasZeroUnnecessaryDeepClones,
  inspectNextStateStructuralSharing,
} from "./next-state-structural-sharing";
import {planTerritoryTransfer} from "./territory-transfer-planner";

const registry = createCountryIdRegistry({activeCountryIds: [], retiredCountryIds: []});
const sourceCountryId = issueCountryId("AAA", registry);
const targetCountryId = issueCountryId("BBB", registry);
const remoteCountryId = issueCountryId("CCC", registry);

const country = (id: typeof sourceCountryId) => createCountryEntity({
  id,
  names: {shortKo: id, officialKo: id, mapKo: id, english: id, searchAliases: [id]},
  politicalStatus: "sovereign",
  presentationOverride: null,
  moduleVersions: {core: 1},
});

const territoryId = (name: string) =>
  deriveTerritoryId({kind: "seed", seedVersion: "sharing-v1", sourceFeatureId: name});

const movedId = territoryId("moved");
const neighborId = territoryId("neighbor");
const remoteId = territoryId("remote");

const rectangle = (left: number, right: number): TerritoryGeometry => ({
  type: "Polygon",
  coordinates: [[[left, 0], [right, 0], [right, 10], [left, 10], [left, 0]]],
});

const fixture = () => {
  const countriesById = {
    AAA: country(sourceCountryId),
    BBB: country(targetCountryId),
    CCC: country(remoteCountryId),
  };
  const territoriesById = {
    [movedId]: createTerritoryEntity({
      id: movedId,
      ownerCountryId: sourceCountryId,
      geometry: rectangle(0, 10),
      properties: {role: "moved"},
    }),
    [neighborId]: createTerritoryEntity({
      id: neighborId,
      ownerCountryId: targetCountryId,
      geometry: rectangle(10, 20),
      properties: {role: "neighbor"},
    }),
    [remoteId]: createTerritoryEntity({
      id: remoteId,
      ownerCountryId: remoteCountryId,
      geometry: rectangle(100, 110),
      properties: {role: "remote"},
    }),
  };
  const topology = buildCanonicalTopology(territoriesById);
  const geometryPolicy = {coordinatePrecision: 9, exteriorRingWinding: "counterclockwise" as const};

  return createWorldStateV2({
    schemaVersion: WORLD_STATE_V2_SCHEMA_VERSION,
    seedVersion: "sharing-v1",
    policyVersion: "world-policy-v1",
    revision: 31,
    countriesById,
    countryOrder: [sourceCountryId, targetCountryId, remoteCountryId],
    retiredCountryIds: [],
    territoriesById,
    territoryOrder: [movedId, neighborId, remoteId],
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

const command = () => parseTerritoryTransferV2Command({
  commandId: "transfer-moved",
  type: "territory.transfer",
  expectedRevision: 31,
  payload: {
    source: {kind: "territory-id", territoryId: movedId},
    targetCountryId,
  },
});

describe("10-77 next state structural sharing", () => {
  it("reports zero unnecessary deep clones for unaffected entries", () => {
    const state = fixture();
    const result = planTerritoryTransfer(state, command(), {committedCommandIds: new Set()});

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const affectedSet = calculateAffectedSet({
      beforeState: state,
      afterState: result.plan.nextState,
      patch: result.plan.patch,
    });
    const report = inspectNextStateStructuralSharing(
      state,
      result.plan.nextState,
      affectedSet,
    );

    expect(report).toEqual({
      unaffectedCountryReferenceChanges: [],
      unaffectedTerritoryReferenceChanges: [],
      unaffectedTopologyEdgeReferenceChanges: [],
      deepCloneCount: 0,
    });
    expect(hasZeroUnnecessaryDeepClones(report)).toBe(true);
  });

  it("detects a cloned entry outside the affected set", () => {
    const state = fixture();
    const result = planTerritoryTransfer(state, command(), {committedCommandIds: new Set()});

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const affectedSet = calculateAffectedSet({
      beforeState: state,
      afterState: result.plan.nextState,
      patch: result.plan.patch,
    });
    const clonedRemote = Object.freeze({...result.plan.nextState.territoriesById[remoteId]});
    const badNextState: WorldStateV2 = Object.freeze({
      ...result.plan.nextState,
      territoriesById: Object.freeze({
        ...result.plan.nextState.territoriesById,
        [remoteId]: clonedRemote,
      }),
    });

    const report = inspectNextStateStructuralSharing(state, badNextState, affectedSet);

    expect(report.unaffectedTerritoryReferenceChanges).toEqual([remoteId]);
    expect(report.deepCloneCount).toBe(1);
    expect(hasZeroUnnecessaryDeepClones(report)).toBe(false);
  });
});
