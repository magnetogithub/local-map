import {describe, expect, it} from "vitest";

import {createCountryEntity} from "../world/country-entity";
import type {ActiveCountryId} from "../world/country-id";
import type {WorldPatchV2} from "../planning/world-patch-v2";
import {createTopologyState} from "../world/topology-state";
import {createTerritoryEntity, type TerritoryGeometry} from "../world/territory-entity";
import {deriveTerritoryId} from "../world/territory-id";
import {
  createWorldStateV2,
  WORLD_STATE_V2_SCHEMA_VERSION,
  type WorldStateV2,
} from "../world/world-state-v2";
import {
  applySynchronizedMapSourcesPatch,
  applyProjectionCoordinatorPatch,
  createProjectionCoordinator,
  createSynchronizedMapSources,
  mapSourceTerritoryOwnerSignature,
  retryFailedProjections,
  synchronizedMapSourcesAdapter,
  type ProjectionAdapter,
} from "./map-projection-checkpoint";

const activeCountryId = (countryId: "AAA" | "BBB") => countryId as ActiveCountryId;

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

const territory = (
  sourceFeatureId: string,
  ownerCountryId: "AAA" | "BBB" | null,
  x: number,
) => {
  const id = deriveTerritoryId({
    kind: "seed",
    seedVersion: "10-99-test",
    sourceFeatureId,
  });
  return createTerritoryEntity({
    id,
    ownerCountryId,
    geometry: rectangle(x),
    properties: {sourceFeatureId},
  });
};

const world = (
  revision: number,
  firstOwner: "AAA" | "BBB" | null = "AAA",
): WorldStateV2 => {
  const first = territory("first", firstOwner, 0);
  const second = territory("second", "BBB", 2);
  return createWorldStateV2({
    schemaVersion: WORLD_STATE_V2_SCHEMA_VERSION,
    seedVersion: "10-99-test",
    policyVersion: "world-policy-v1",
    revision,
    countriesById: {
      AAA: country("AAA"),
      BBB: country("BBB"),
    },
    countryOrder: [activeCountryId("AAA"), activeCountryId("BBB")],
    retiredCountryIds: ["OLD" as never],
    territoriesById: {
      [first.id]: first,
      [second.id]: second,
    },
    territoryOrder: [first.id, second.id],
    topology: createTopologyState([]),
    hashRoots: {
      countriesRootHash: null,
      presentationRootHash: null,
      territoriesRootHash: null,
      topologyRootHash: null,
    },
  });
};

const patch = (
  beforeRevision: number,
  afterRevision: number,
  commandId = `patch-${beforeRevision}-${afterRevision}`,
): WorldPatchV2 => ({
  kind: "world.patch.v2",
  schemaVersion: 1,
  commandId,
  beforeRevision,
  afterRevision,
  beforeContentHash: "0".repeat(64),
  afterContentHash: "1".repeat(64),
  entityDeltas: {countryIds: [], territoryIds: [], topologyEdgeIds: []},
  entityChangeSets: {
    countries: {created: [], updated: [], deleted: []},
    territories: {created: [], updated: [], deleted: []},
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
  plannerPatch: {kind: "territory.transfer"},
});

const uiAdapter = (failCommandId: string | null = null): ProjectionAdapter => Object.freeze({
  name: "ui",
  build: (state) => ({revision: state.revision}),
  applyPatch: (_current, worldPatch, state) => {
    if (worldPatch.commandId === failCommandId) throw new Error("injected ui projection failure");
    return {revision: state.revision};
  },
  artifactHash: (value) => `ui:${(value as {revision: number}).revision}`,
});

describe("10-96~10-99 map projection checkpoint", () => {
  it("builds low/high sources from the same committed Territory-owner set", () => {
    const sources = createSynchronizedMapSources(world(30));

    expect(sources.low.meta.appliedRevision).toBe(30);
    expect(sources.high.meta.appliedRevision).toBe(30);
    expect(sources.low.meta.artifactHash).toBe(sources.high.meta.artifactHash);
    expect(mapSourceTerritoryOwnerSignature(sources.low))
      .toEqual(mapSourceTerritoryOwnerSignature(sources.high));
    expect(mapSourceTerritoryOwnerSignature(sources.low).some((entry) => entry.includes("OLD")))
      .toBe(false);
    expect(sources.low.featureCollection.features.every(({properties}) =>
      properties.territoryId && "ownerCountryId" in properties && "countryId" in properties
    )).toBe(true);
  });

  it("replaces only changed territory features in both source resolutions", () => {
    const before = world(30);
    const after = world(31, "BBB");
    const firstId = before.territoryOrder[0];
    const secondId = before.territoryOrder[1];
    const sources = createSynchronizedMapSources(before);
    const transfer = patch(30, 31);
    const changedPatch: WorldPatchV2 = {
      ...transfer,
      entityChangeSets: {
        ...transfer.entityChangeSets,
        territories: {created: [], updated: [firstId], deleted: []},
      },
    };
    const next = applySynchronizedMapSourcesPatch(sources, changedPatch, after);

    for (const resolution of ["low", "high"] as const) {
      const oldFeatures = new Map(sources[resolution].featureCollection.features.map((feature) => [feature.id, feature]));
      const newFeatures = new Map(next[resolution].featureCollection.features.map((feature) => [feature.id, feature]));
      expect(newFeatures.get(firstId)).not.toBe(oldFeatures.get(firstId));
      expect(newFeatures.get(firstId)?.properties.ownerCountryId).toBe("BBB");
      expect(newFeatures.get(secondId)).toBe(oldFeatures.get(secondId));
      expect(newFeatures.get(secondId)?.geometry).toBe(oldFeatures.get(secondId)?.geometry);
      expect(next[resolution].meta.appliedRevision).toBe(31);
    }
    expect(next.low.meta.artifactHash).toBe(next.high.meta.artifactHash);
    expect(mapSourceTerritoryOwnerSignature(next.low)).toEqual(mapSourceTerritoryOwnerSignature(next.high));
    expect(() => applySynchronizedMapSourcesPatch(next, changedPatch, after)).toThrow(/beforeRevision/);
  });

  it("rejects stale patches before any projection is applied", () => {
    const before = world(30);
    const after = world(31, "BBB");
    const coordinator = createProjectionCoordinator(
      before,
      [synchronizedMapSourcesAdapter, uiAdapter()],
    );

    const result = applyProjectionCoordinatorPatch(
      coordinator,
      [synchronizedMapSourcesAdapter, uiAdapter()],
      patch(29, 31),
      after,
    );

    expect(result.staleRejected).toBe(true);
    expect(result.coordinator).toBe(coordinator);
    expect(result.coordinator.records.get("map")?.meta.appliedRevision).toBe(30);
  });

  it("keeps the last good projection on failure and retries against the latest revision", () => {
    const before = world(30);
    const after = world(31, "BBB");
    const adapters = [synchronizedMapSourcesAdapter, uiAdapter("fail-ui")];
    const coordinator = createProjectionCoordinator(before, adapters);

    const failed = applyProjectionCoordinatorPatch(
      coordinator,
      adapters,
      patch(30, 31, "fail-ui"),
      after,
    );

    expect(failed.staleRejected).toBe(false);
    expect(failed.failedProjectionNames).toEqual(["ui"]);
    expect(failed.coordinator.records.get("map")?.meta.appliedRevision).toBe(31);
    expect(failed.coordinator.records.get("ui")?.meta.appliedRevision).toBe(30);
    expect(failed.coordinator.records.get("ui")?.status).toBe("failed");
    expect(before.revision).toBe(30);
    expect(after.revision).toBe(31);

    const retried = retryFailedProjections(
      failed.coordinator,
      [synchronizedMapSourcesAdapter, uiAdapter()],
      after,
    );

    expect(retried.records.get("ui")?.status).toBe("ready");
    expect(retried.records.get("ui")?.meta.appliedRevision).toBe(31);
    expect(retried.records.get("map")?.meta.appliedRevision).toBe(31);
  });
});
