import {describe, expect, it} from "vitest";

import {parseCountrySplitV2Command} from "../commands/country-split-v2";
import {buildCanonicalTopology} from "../world/canonical-topology";
import {countryCoreLeafHash} from "../world/country-core-hash";
import {createCountryEntity} from "../world/country-entity";
import {createCountryIdRegistry, issueCountryId} from "../world/country-id";
import {countryPresentationLeafHash} from "../world/country-presentation-hash";
import {buildDomainRootHash} from "../world/domain-hash-root";
import {territoryGeometryLeafHash} from "../world/territory-geometry-hash";
import {createTerritoryEntity, type TerritoryGeometry} from "../world/territory-entity";
import {deriveTerritoryId} from "../world/territory-id";
import {territoryOwnershipLeafHash} from "../world/territory-ownership-hash";
import {topologyEdgeLeafHash} from "../world/topology-edge-hash";
import {createWorldStateV2, WORLD_STATE_V2_SCHEMA_VERSION} from "../world/world-state-v2";
import {calculateAffectedSet} from "./affected-set";
import {commitVerifiedWorldPatch, createAtomicWorldCommitMemoryStore} from "./atomic-world-commit";
import {planCountrySplit} from "./country-split-planner";
import {buildWorldPatchV2} from "./world-patch-v2";

const geometryPolicy = {
  coordinatePrecision: 6,
  exteriorRingWinding: "counterclockwise" as const,
};

const rectangle = (index: number): TerritoryGeometry => ({
  type: "Polygon",
  coordinates: [[
    [index, 0],
    [index + 1, 0],
    [index + 1, 1],
    [index, 1],
    [index, 0],
  ]],
});

const identity = (id: string) => ({
  id,
  names: {shortKo: id, officialKo: id, mapKo: id, english: id, searchAliases: [id]},
  politicalStatus: "sovereign" as const,
  presentationOverride: null,
  moduleVersions: {core: 1, names: 1},
});

const countryHashRecord = <Value>(
  countriesById: Readonly<Record<string, Value>>,
  hash: (country: Value) => string,
) => Object.fromEntries(
  Object.entries(countriesById).map(([countryId, country]) => [countryId, hash(country)]),
);

const split31Fixture = () => {
  const registry = createCountryIdRegistry({activeCountryIds: [], retiredCountryIds: []});
  const sourceCountryId = issueCountryId("AAA", registry);
  const source = createCountryEntity(identity(sourceCountryId));
  const territoryIds = Array.from({length: 31}, (_unused, index) =>
    deriveTerritoryId({
      kind: "seed",
      seedVersion: "split-31-v1",
      sourceFeatureId: `territory-${index.toString().padStart(2, "0")}`,
    }));
  const territoriesById = Object.freeze(Object.fromEntries(
    territoryIds.map((territoryId, index) => [
      territoryId,
      createTerritoryEntity({
        id: territoryId,
        ownerCountryId: sourceCountryId,
        geometry: rectangle(index),
        properties: {index},
      }),
    ]),
  ));
  const countriesById = Object.freeze({[sourceCountryId]: source});
  const topology = buildCanonicalTopology(territoriesById);
  const state = createWorldStateV2({
    schemaVersion: WORLD_STATE_V2_SCHEMA_VERSION,
    seedVersion: "split-31-v1",
    policyVersion: "world-policy-v1",
    revision: 31,
    countriesById,
    countryOrder: [sourceCountryId],
    retiredCountryIds: [],
    territoriesById,
    territoryOrder: territoryIds,
    topology,
    hashRoots: {
      countriesRootHash: buildDomainRootHash(
        "countries",
        countryHashRecord(countriesById, countryCoreLeafHash),
      ),
      presentationRootHash: buildDomainRootHash(
        "presentation",
        countryHashRecord(
          countriesById,
          (country) => countryPresentationLeafHash(country, "world-policy-v1"),
        ),
      ),
      territoriesRootHash: buildDomainRootHash("territories", Object.fromEntries(
        Object.entries(territoriesById).flatMap(([territoryId, territory]) => [
          [`geometry:${territoryId}`, territoryGeometryLeafHash(territory, geometryPolicy)],
          [`ownership:${territoryId}`, territoryOwnershipLeafHash(territory)],
        ]),
      )),
      topologyRootHash: buildDomainRootHash("topology", Object.fromEntries(
        Object.entries(topology.edgesById).map(([edgeId, edge]) => [
          edgeId,
          topologyEdgeLeafHash(edge),
        ]),
      )),
    },
  });
  const command = parseCountrySplitV2Command({
    commandId: "split-aaa-31",
    type: "country.split",
    expectedRevision: 31,
    payload: {
      sourceCountryId,
      resultCountries: territoryIds.map((territoryId, index) => ({
        country: identity(`R${index.toString().padStart(2, "0")}`),
        territorySources: [{kind: "territory-id", territoryId}],
      })),
    },
  });
  return {command, state};
};

describe("10-83 domain subscriber notification", () => {
  it("notifies domain subscribers once for a 31-result country split commit", () => {
    const {command, state} = split31Fixture();
    const result = planCountrySplit(state, command, {committedCommandIds: new Set()});

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const patch = buildWorldPatchV2({
      commandId: result.plan.commandId,
      beforeState: state,
      afterState: result.plan.nextState,
      affectedSet: calculateAffectedSet({
        beforeState: state,
        afterState: result.plan.nextState,
        patch: result.plan.patch,
      }),
      plannerPatch: result.plan.patch,
    });
    const store = createAtomicWorldCommitMemoryStore(state);
    const notifications: Array<{
      previousRevision: number;
      nextRevision: number;
      changedCountryCount: number;
    }> = [];
    const unsubscribe = store.subscribeDomain(({previousState, nextState, commit}) => {
      notifications.push({
        previousRevision: previousState.revision,
        nextRevision: commit.revision,
        changedCountryCount: Object.keys(nextState.countriesById).length,
      });
    });

    commitVerifiedWorldPatch({
      store,
      nextState: result.plan.nextState,
      patch,
    });
    unsubscribe();

    expect(result.plan.patch.resultCountryIds).toHaveLength(31);
    expect(notifications).toEqual([{
      previousRevision: 31,
      nextRevision: 32,
      changedCountryCount: 31,
    }]);
  });
});
