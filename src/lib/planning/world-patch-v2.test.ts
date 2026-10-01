import {describe, expect, it} from "vitest";

import {parseTerritoryTransferV2Command} from "../commands/territory-transfer-v2";
import {countryCoreLeafHash} from "../world/country-core-hash";
import {createCountryEntity} from "../world/country-entity";
import {createCountryIdRegistry, issueCountryId} from "../world/country-id";
import {countryPresentationLeafHash} from "../world/country-presentation-hash";
import {buildDomainRootHash} from "../world/domain-hash-root";
import {territoryGeometryLeafHash} from "../world/territory-geometry-hash";
import {createTerritoryEntity, type TerritoryGeometry} from "../world/territory-entity";
import {deriveTerritoryId} from "../world/territory-id";
import {territoryOwnershipLeafHash} from "../world/territory-ownership-hash";
import {createTopologyState} from "../world/topology-state";
import {worldContentHash} from "../world/world-content-hash";
import {createWorldStateV2, WORLD_STATE_V2_SCHEMA_VERSION, type WorldStateV2} from "../world/world-state-v2";
import {calculateAffectedSet} from "./affected-set";
import {planTerritoryTransfer} from "./territory-transfer-planner";
import {
  WorldPatchSetInvariantError,
  buildWorldPatchV2,
  validateWorldPatchV2EntityChangeSets,
} from "./world-patch-v2";

const registry = createCountryIdRegistry({activeCountryIds: [], retiredCountryIds: []});
const sourceCountryId = issueCountryId("AAA", registry);
const targetCountryId = issueCountryId("BBB", registry);

const country = (id: typeof sourceCountryId) => createCountryEntity({
  id,
  names: {shortKo: id, officialKo: id, mapKo: id, english: id, searchAliases: [id]},
  politicalStatus: "sovereign",
  presentationOverride: null,
  moduleVersions: {core: 1},
});

const territoryId = deriveTerritoryId({
  kind: "seed",
  seedVersion: "world-patch-v2",
  sourceFeatureId: "transfer-source",
});

const geometryPolicy = {
  coordinatePrecision: 9,
  exteriorRingWinding: "counterclockwise" as const,
};

const rectangle = (): TerritoryGeometry => ({
  type: "Polygon",
  coordinates: [[[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]]],
});

const contentHash = (state: WorldStateV2) => worldContentHash({
  schemaVersion: state.schemaVersion,
  seedVersion: state.seedVersion,
  policyVersion: state.policyVersion,
  hashRoots: {
    countriesRootHash: state.hashRoots.countriesRootHash!,
    presentationRootHash: state.hashRoots.presentationRootHash!,
    territoriesRootHash: state.hashRoots.territoriesRootHash!,
    topologyRootHash: state.hashRoots.topologyRootHash!,
  },
});

const fixture = () => {
  const countriesById = {
    AAA: country(sourceCountryId),
    BBB: country(targetCountryId),
  };
  const territory = createTerritoryEntity({
    id: territoryId,
    ownerCountryId: sourceCountryId,
    geometry: rectangle(),
    properties: {},
  });
  const territoriesById = {[territory.id]: territory};

  return createWorldStateV2({
    schemaVersion: WORLD_STATE_V2_SCHEMA_VERSION,
    seedVersion: "world-patch-v2",
    policyVersion: "world-policy-v1",
    revision: 11,
    countriesById,
    countryOrder: [sourceCountryId, targetCountryId],
    retiredCountryIds: [],
    territoriesById,
    territoryOrder: [territory.id],
    topology: createTopologyState([]),
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
      territoriesRootHash: buildDomainRootHash("territories", {
        [`geometry:${territory.id}`]: territoryGeometryLeafHash(territory, geometryPolicy),
        [`ownership:${territory.id}`]: territoryOwnershipLeafHash(territory),
      }),
      topologyRootHash: buildDomainRootHash("topology", {}),
    },
  });
};

const command = () => parseTerritoryTransferV2Command({
  commandId: "transfer-for-world-patch",
  type: "territory.transfer",
  expectedRevision: 11,
  payload: {
    source: {kind: "territory-id", territoryId},
    targetCountryId,
  },
});

describe("10-78 WorldPatch v2 type", () => {
  it("records before/after revision and content hash with separated module hash deltas", () => {
    const beforeState = fixture();
    const result = planTerritoryTransfer(beforeState, command(), {
      committedCommandIds: new Set(),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const afterState = result.plan.nextState;
    const affectedSet = calculateAffectedSet({
      beforeState,
      afterState,
      patch: result.plan.patch,
    });
    const patch = buildWorldPatchV2({
      commandId: result.plan.commandId,
      beforeState,
      afterState,
      affectedSet,
      plannerPatch: result.plan.patch,
    });

    expect(patch.kind).toBe("world.patch.v2");
    expect(patch.beforeRevision).toBe(11);
    expect(patch.afterRevision).toBe(12);
    expect(patch.beforeContentHash).toBe(contentHash(beforeState));
    expect(patch.afterContentHash).toBe(contentHash(afterState));
    expect(patch.afterContentHash).not.toBe(patch.beforeContentHash);
    expect(patch.entityDeltas).toEqual({
      countryIds: ["AAA", "BBB"],
      territoryIds: [territoryId],
      topologyEdgeIds: [],
    });
    expect(patch.entityChangeSets).toEqual({
      countries: {created: [], updated: [], deleted: []},
      territories: {created: [], updated: [territoryId], deleted: []},
      topologyEdges: {created: [], updated: [], deleted: []},
    });
    expect(patch.moduleHashDeltas.country).toBeNull();
    expect(patch.moduleHashDeltas.presentation).toBeNull();
    expect(patch.moduleHashDeltas.topology).toBeNull();
    expect(patch.moduleHashDeltas.geometry).toBeNull();
    expect(patch.moduleHashDeltas.territory).toEqual({
      beforeRootHash: beforeState.hashRoots.territoriesRootHash,
      afterRootHash: afterState.hashRoots.territoriesRootHash,
    });
    expect(patch.moduleHashDeltas.ownership).toEqual(patch.moduleHashDeltas.territory);
    expect(patch.moduleLeafHashDeltas.countryCore).toEqual([]);
    expect(patch.moduleLeafHashDeltas.countryPresentation).toEqual([]);
    expect(patch.moduleLeafHashDeltas.territoryGeometry).toEqual([]);
    expect(patch.moduleLeafHashDeltas.topologyEdge).toEqual([]);
    expect(patch.moduleLeafHashDeltas.territoryOwnership).toEqual([{
      id: territoryId,
      beforeLeafHash: territoryOwnershipLeafHash(beforeState.territoriesById[territoryId]),
      afterLeafHash: territoryOwnershipLeafHash(afterState.territoriesById[territoryId]),
    }]);
    expect(Object.isFrozen(patch)).toBe(true);
    expect(Object.isFrozen(patch.moduleLeafHashDeltas.territoryOwnership)).toBe(true);
    expect(Object.isFrozen(patch.entityChangeSets.territories.updated)).toBe(true);
    expect(Object.isFrozen(patch.moduleHashDeltas)).toBe(true);
    expect(Object.isFrozen(patch.entityDeltas.countryIds)).toBe(true);
  });

  it("rejects duplicate and contradictory WorldPatch entity set membership", () => {
    expect(() => validateWorldPatchV2EntityChangeSets({
      countries: {created: [sourceCountryId, sourceCountryId], updated: [], deleted: []},
      territories: {created: [], updated: [], deleted: []},
      topologyEdges: {created: [], updated: [], deleted: []},
    })).toThrow(WorldPatchSetInvariantError);

    expect(() => validateWorldPatchV2EntityChangeSets({
      countries: {created: [sourceCountryId], updated: [sourceCountryId], deleted: []},
      territories: {created: [], updated: [], deleted: []},
      topologyEdges: {created: [], updated: [], deleted: []},
    })).toThrow(/cannot be both created and updated/);

    expect(() => validateWorldPatchV2EntityChangeSets({
      countries: {created: [], updated: [], deleted: []},
      territories: {created: [territoryId], updated: [], deleted: [territoryId]},
      topologyEdges: {created: [], updated: [], deleted: []},
    })).toThrow(/cannot be both created and deleted/);
  });
});
