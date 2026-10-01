import {parseCountryMergeV2Command} from "../commands/country-merge-v2";
import {parseCountrySplitV2Command} from "../commands/country-split-v2";
import {calculateAffectedSet} from "../planning/affected-set";
import {commitVerifiedWorldPatch} from "../planning/atomic-world-commit";
import {planCountryMerge} from "../planning/country-merge-planner";
import {planCountrySplit} from "../planning/country-split-planner";
import {buildWorldPatchV2} from "../planning/world-patch-v2";
import {buildCanonicalTopology} from "../world/canonical-topology";
import {buildDomainRootHash} from "../world/domain-hash-root";
import {createTerritoryEntity, type TerritoryGeometry} from "../world/territory-entity";
import {territoryGeometryLeafHash} from "../world/territory-geometry-hash";
import {territoryOwnershipLeafHash} from "../world/territory-ownership-hash";
import {deriveTerritoryId, type TerritoryId} from "../world/territory-id";
import {topologyEdgeLeafHash} from "../world/topology-edge-hash";
import {createTopologyState} from "../world/topology-state";
import type {WorldStateV2} from "../world/world-state-v2";
import type {WorldStateStoreController} from "../../stores/world-state-store";

type StateFeature = Readonly<{
  properties: Readonly<{
    countryId: string;
    stateCode: string;
    nameKo: string;
    nameEn: string;
    mapLabelKo: string;
  }>;
  geometry: TerritoryGeometry;
}>;
type StateCollection = Readonly<{features: readonly StateFeature[]}>;
type StateFixtureLoader = () => Promise<StateCollection>;

const defaultFixtureLoader: StateFixtureLoader = async () => {
  const response = await fetch("/data/maps/usa-state-countries-test.geojson");
  if (!response.ok) throw new Error(`USA state fixture HTTP ${response.status}`);
  return response.json() as Promise<StateCollection>;
};

const geometryPolicy = {
  coordinatePrecision: 6,
  exteriorRingWinding: "counterclockwise" as const,
};
const compareText = (left: string, right: string) => left < right ? -1 : left > right ? 1 : 0;

function fixtureHashRoots(state: WorldStateV2) {
  const territoryHashes = Object.fromEntries(Object.entries(state.territoriesById).flatMap(
    ([id, territory]) => [
      [`geometry:${id}`, territoryGeometryLeafHash(territory, geometryPolicy)],
      [`ownership:${id}`, territoryOwnershipLeafHash(territory)],
    ],
  ));
  const topologyHashes = Object.fromEntries(Object.entries(state.topology.edgesById).map(
    ([id, edge]) => [id, topologyEdgeLeafHash(edge)],
  ));
  return {
    ...state.hashRoots,
    territoriesRootHash: buildDomainRootHash("territories", territoryHashes),
    topologyRootHash: buildDomainRootHash("topology", topologyHashes),
  };
}

function commitScenarioState(
  controller: WorldStateStoreController,
  commandId: string,
  nextState: WorldStateV2,
  plannerPatch: unknown,
) {
  const beforeState = controller.getState();
  const patch = buildWorldPatchV2({
    commandId,
    beforeState,
    afterState: nextState,
    affectedSet: calculateAffectedSet({beforeState, afterState: nextState, patch: plannerPatch}),
    plannerPatch,
  });
  commitVerifiedWorldPatch({store: controller, nextState, patch});
}

export function createUsaStateDebugScenario(
  controller: WorldStateStoreController,
  loadFixture: StateFixtureLoader = defaultFixtureLoader,
) {
  let original: WorldStateV2 | null = null;
  let stateCountryIds: string[] = [];
  let countryIdBySourceId: Record<string, string> = {};
  let mergedCountryId: string | null = null;

  return {
    snapshot: () => ({
      active: original !== null,
      stateCountryIds: [...stateCountryIds],
      countryIdBySourceId: {...countryIdBySourceId},
      mergedCountryId,
    }),
    async split() {
      if (original) return {
        active: true as const,
        stateCountryIds: [...stateCountryIds],
        countryIdBySourceId: {...countryIdBySourceId},
      };
      const before = controller.getState();
      const sourceTerritoryIds = before.territoryOrder.filter(
        (id) => before.territoriesById[id].ownerCountryId === "USA",
      );
      if (sourceTerritoryIds.length !== 1) {
        throw new Error("USA state debug fixture expects one USA Territory");
      }
      const sourceTerritoryId = sourceTerritoryIds[0];
      const states = [...(await loadFixture()).features].sort(
        (left, right) => compareText(left.properties.countryId, right.properties.countryId),
      );
      if (
        states.length !== 50 ||
        new Set(states.map((feature) => feature.properties.countryId)).size !== states.length ||
        states.some((feature) => !/^USA-[A-Z]{2}$/.test(feature.properties.countryId))
      ) {
        throw new Error("USA state fixture must contain exactly 50 unique states");
      }
      const stateTerritories = states.map((feature) => createTerritoryEntity({
        id: deriveTerritoryId({
          kind: "partition",
          sourceTerritoryId,
          partitionKey: feature.properties.countryId,
        }),
        ownerCountryId: before.countriesById.USA.id,
        geometry: feature.geometry,
        properties: {sourceFeatureId: feature.properties.countryId},
      }));
      const territoriesById = {...before.territoriesById};
      delete territoriesById[sourceTerritoryId];
      for (const territory of stateTerritories) territoriesById[territory.id] = territory;
      const stateTopology = buildCanonicalTopology(Object.fromEntries(
        stateTerritories.map((territory) => [territory.id, territory]),
      ));
      const topology = createTopologyState([
        ...Object.values(before.topology.edgesById).filter(
          (edge) => !edge.territoryIds.includes(sourceTerritoryId),
        ),
        ...Object.values(stateTopology.edgesById),
      ]);
      const preparedInput = {
        ...before,
        revision: before.revision + 1,
        territoriesById: Object.freeze(territoriesById),
        territoryOrder: Object.freeze([
          ...before.territoryOrder.filter((id) => id !== sourceTerritoryId),
          ...stateTerritories.map((territory) => territory.id),
        ]),
        topology,
      };
      const prepared = Object.freeze({
        ...preparedInput,
        hashRoots: Object.freeze(fixtureHashRoots(preparedInput)),
      }) as WorldStateV2;
      const command = parseCountrySplitV2Command({
        commandId: `test-only-usa-split-${prepared.revision}`,
        type: "country.split",
        expectedRevision: prepared.revision,
        payload: {
          sourceCountryId: "USA",
          resultCountries: states.map((feature, index) => ({
            country: {
              names: {
                shortKo: feature.properties.nameKo,
                officialKo: feature.properties.nameKo,
                mapKo: feature.properties.mapLabelKo,
                english: feature.properties.nameEn,
                searchAliases: [feature.properties.countryId, feature.properties.stateCode],
              },
              politicalStatus: "sovereign",
              presentationOverride: null,
              moduleVersions: {core: 1, names: 1},
            },
            territorySources: [{kind: "territory-id", territoryId: stateTerritories[index].id}],
          })),
        },
      });
      const planned = planCountrySplit(prepared, command, {
        committedCommandIds: controller.getCommittedCommandIds(),
      });
      if (!planned.ok) throw new Error(planned.error.message);
      commitScenarioState(
        controller,
        `test-only-usa-prepare-${prepared.revision}`,
        prepared,
        {
          kind: "territory.partition",
          sourceTerritoryId,
          partitionTerritoryIds: stateTerritories.map((territory) => territory.id),
        },
      );
      commitScenarioState(controller, command.commandId, planned.plan.nextState, planned.plan.patch);
      original = before;
      stateCountryIds = stateTerritories.map(
        (territory) => planned.plan.patch.territoryOwnerChanges[territory.id],
      );
      countryIdBySourceId = Object.fromEntries(states.map((feature, index) => [
        feature.properties.countryId,
        stateCountryIds[index],
      ]));
      return {
        active: true as const,
        stateCountryIds: [...stateCountryIds],
        countryIdBySourceId: {...countryIdBySourceId},
      };
    },
    async merge() {
      if (!original) throw new Error("Split the USA before running the merge scenario");
      if (mergedCountryId) return {
        active: true as const,
        mergedCountryId,
        sourceCountryIds: [...stateCountryIds],
      };
      const before = controller.getState();
      const sourceCountryIds = stateCountryIds.filter((countryId) => before.countriesById[countryId]);
      if (sourceCountryIds.length !== 50) {
        throw new Error("USA state merge requires 50 active state countries");
      }
      const command = parseCountryMergeV2Command({
        commandId: `test-only-usa-merge-${before.revision + 1}`,
        type: "country.merge",
        expectedRevision: before.revision,
        payload: {
          sourceCountryIds,
          resultCountry: {
            kind: "new-country",
            country: {
              names: {
                shortKo: "United States Union",
                officialKo: "United States Union",
                mapKo: "United States Union",
                english: "United States Union",
                searchAliases: ["United States Union"],
              },
              politicalStatus: "sovereign",
              presentationOverride: null,
              moduleVersions: {core: 1, names: 1},
            },
          },
          metadataInheritance: {mode: "preserve-result"},
        },
      });
      const planned = planCountryMerge(before, command, {
        committedCommandIds: controller.getCommittedCommandIds(),
      });
      if (!planned.ok) throw new Error(planned.error.message);
      commitScenarioState(controller, command.commandId, planned.plan.nextState, planned.plan.patch);
      mergedCountryId = planned.plan.patch.resultCountryId;
      return {active: true as const, mergedCountryId, sourceCountryIds: [...sourceCountryIds]};
    },
    async rollback() {
      if (!original) return {active: false as const, restoredCountryId: "USA" as const};
      const before = controller.getState();
      const restored = Object.freeze({...original, revision: before.revision + 1}) as WorldStateV2;
      const removedTerritoryIds = before.territoryOrder.filter(
        (id) => !restored.territoriesById[id],
      );
      const restoredTerritoryIds = restored.territoryOrder.filter(
        (id) => !before.territoriesById[id],
      );
      const plannerPatch = {
        kind: "command.batch",
        commandPatches: [
          {
            kind: "country.merge",
            sourceCountryIds: stateCountryIds,
            resultCountryId: "USA",
            territoryOwnerChanges: Object.fromEntries(
              removedTerritoryIds.map((id) => [id, "USA"]),
            ),
          },
          {
            kind: "territory.partition",
            sourceTerritoryId: restoredTerritoryIds[0] as TerritoryId,
            partitionTerritoryIds: removedTerritoryIds,
          },
        ],
      };
      commitScenarioState(
        controller,
        `test-only-usa-rollback-${restored.revision}`,
        restored,
        plannerPatch,
      );
      original = null;
      stateCountryIds = [];
      countryIdBySourceId = {};
      mergedCountryId = null;
      return {active: false as const, restoredCountryId: "USA" as const};
    },
  };
}
