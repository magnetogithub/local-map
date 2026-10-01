import {describe, expect, it} from "vitest";

import {createCountryEntity} from "../world/country-entity";
import type {ActiveCountryId} from "../world/country-id";
import {createTopologyState} from "../world/topology-state";
import {createTerritoryEntity, type TerritoryGeometry} from "../world/territory-entity";
import {deriveTerritoryId} from "../world/territory-id";
import {
  createWorldStateV2,
  WORLD_STATE_V2_SCHEMA_VERSION,
  type WorldStateV2,
} from "../world/world-state-v2";
import type {WorldPatchV2} from "./world-patch-v2";
import {
  checkpointWorldContentHash,
  createDomainBeforeImage,
  createWorldHistory,
  deserializeWorldStateV2,
  migratePrompt09SaveToWorldStateV2,
  recordHistoryEntry,
  redoHistory,
  serializeWorldStateV2,
  undoHistory,
} from "./history-persistence-checkpoint";

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

const country = (id: "AAA" | "BBB", name: string = id) => createCountryEntity({
  id: activeCountryId(id),
  names: {
    shortKo: name,
    officialKo: `${name} Republic`,
    mapKo: name,
    english: `${id} Republic`,
    searchAliases: [id, name],
  },
  politicalStatus: "sovereign",
  presentationOverride: null,
  moduleVersions: {core: 1, names: 1},
});

const territory = (ownerCountryId: "AAA" | "BBB", x = 0) => {
  const id = deriveTerritoryId({
    kind: "seed",
    seedVersion: "10-112-test",
    sourceFeatureId: "alpha",
  });
  return createTerritoryEntity({
    id,
    ownerCountryId,
    geometry: rectangle(x),
    properties: {sourceFeatureId: "alpha"},
  });
};

const world = (
  revision: number,
  ownerCountryId: "AAA" | "BBB" = "AAA",
  name = "AAA",
): WorldStateV2 => {
  const alpha = territory(ownerCountryId);
  return createWorldStateV2({
    schemaVersion: WORLD_STATE_V2_SCHEMA_VERSION,
    seedVersion: "10-112-test",
    policyVersion: "world-policy-v1",
    revision,
    countriesById: {
      AAA: country("AAA", name),
      BBB: country("BBB"),
    },
    countryOrder: [activeCountryId("AAA"), activeCountryId("BBB")],
    retiredCountryIds: [],
    territoriesById: {[alpha.id]: alpha},
    territoryOrder: [alpha.id],
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
  before: WorldStateV2,
  after: WorldStateV2,
  commandId: string,
): WorldPatchV2 => {
  const territoryId = before.territoryOrder[0];
  return {
    kind: "world.patch.v2",
    schemaVersion: 1,
    commandId,
    beforeRevision: before.revision,
    afterRevision: after.revision,
    beforeContentHash: "0".repeat(64),
    afterContentHash: "1".repeat(64),
    entityDeltas: {
      countryIds: [],
      territoryIds: [territoryId],
      topologyEdgeIds: [],
    },
    entityChangeSets: {
      countries: {created: [], updated: [], deleted: []},
      territories: {created: [], updated: [territoryId], deleted: []},
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
    plannerPatch: {kind: "territory.transfer", ownerCountryId: "BBB"},
  };
};

describe("10-107~10-112 history and persistence checkpoint", () => {
  it("records only affected domain before-images without artifact snapshots", () => {
    const before = world(50, "AAA");
    const after = world(51, "BBB");
    const image = createDomainBeforeImage(before, after, patch(before, after, "transfer").entityChangeSets);

    expect(Object.keys(image.countriesById)).toHaveLength(0);
    expect(Object.keys(image.territoriesById)).toEqual([before.territoryOrder[0]]);
    expect(Object.keys(image.topologyEdgesById)).toHaveLength(0);
    expect(JSON.stringify(image)).not.toContain("FeatureCollection");
    expect(JSON.stringify(image)).not.toContain("glyph");
    expect(JSON.stringify(image)).not.toContain("inverse");
  });

  it("undo applies the before-image as a new revision and restores content hash without decreasing revision", () => {
    const before = world(50, "AAA");
    const after = world(51, "BBB");
    const history = recordHistoryEntry(createWorldHistory(before.revision), patch(before, after, "transfer"), before, after);

    const undone = undoHistory(history, after);

    expect(undone.state.revision).toBe(52);
    expect(checkpointWorldContentHash(undone.state)).toBe(checkpointWorldContentHash(before));
    expect(undone.history.pointer).toBe(0);
    expect(undone.history.currentRevision).toBe(52);
  });

  it("redo reapplies the after-image as a new revision with the same content hash as first apply", () => {
    const before = world(50, "AAA");
    const after = world(51, "BBB");
    const history = recordHistoryEntry(createWorldHistory(before.revision), patch(before, after, "transfer"), before, after);
    const undone = undoHistory(history, after);

    const redone = redoHistory(undone.history, undone.state);

    expect(redone.state.revision).toBe(53);
    expect(checkpointWorldContentHash(redone.state)).toBe(checkpointWorldContentHash(after));
    expect(redone.history.pointer).toBe(1);
    expect(redone.history.currentRevision).toBe(53);
    expect(redone.history.historyHash).toBe(history.historyHash);
  });

  it("keeps history pointer hash and store revision aligned through apply undo redo", () => {
    const before = world(50, "AAA");
    const after = world(51, "BBB");
    const applied = recordHistoryEntry(createWorldHistory(before.revision), patch(before, after, "transfer"), before, after);
    const undone = undoHistory(applied, after);
    const redone = redoHistory(undone.history, undone.state);

    expect(applied.pointer).toBe(1);
    expect(undone.history.pointer).toBe(0);
    expect(redone.history.pointer).toBe(1);
    expect(redone.history.currentRevision).toBe(redone.state.revision);
    expect(redone.history.historyHash).not.toBe(undone.history.historyHash);
  });

  it("serializes only WorldState v2 domain modules and rejects transient fields", () => {
    const state = world(50, "AAA");
    const serialized = serializeWorldStateV2(state);
    const roundTripped = deserializeWorldStateV2(serialized);

    expect(roundTripped).toEqual(state);
    expect(JSON.stringify(serialized)).not.toContain("maplibre");
    expect(JSON.stringify(serialized)).not.toContain("Worker");
    expect(JSON.stringify(serialized)).not.toContain("cache");
    expect(() => deserializeWorldStateV2({
      ...serialized,
      maplibre: {},
    } as never)).toThrow(/transient/);
  });

  it("migrates Prompt 09 saves safely and ignores deleted or unknown country IDs", () => {
    const fallback = world(50, "AAA");
    const migrated = migratePrompt09SaveToWorldStateV2({
      promptVersion: 9,
      selectedCountryId: "UNKNOWN",
      playerCountryId: "AAA",
      deletedCountryIds: ["OLD", "BBB"],
    }, fallback);

    expect(migrated.worldState).toBe(fallback);
    expect(migrated.ignoredCountryIds).toEqual(["OLD", "UNKNOWN"]);
  });
});
