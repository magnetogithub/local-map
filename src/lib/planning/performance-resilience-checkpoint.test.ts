import {describe, expect, it} from "vitest";

import type {CountryDissolveV2Command} from "../commands/country-dissolve-v2";
import type {CountryEstablishV2Command} from "../commands/country-establish-v2";
import type {CountrySplitV2Command} from "../commands/country-split-v2";
import {createLabelProjection, runPureGlyphWorker} from "../projection/label-projection-checkpoint";
import {
  createProjectionCoordinator,
  type ProjectionAdapter,
} from "../projection/map-projection-checkpoint";
import {createCountryEntity} from "../world/country-entity";
import type {ActiveCountryId} from "../world/country-id";
import {createTopologyState} from "../world/topology-state";
import {createTerritoryEntity, type TerritoryGeometry} from "../world/territory-entity";
import {deriveTerritoryId, type TerritoryId} from "../world/territory-id";
import {
  createWorldStateV2,
  WORLD_STATE_V2_SCHEMA_VERSION,
  type WorldStateV2,
} from "../world/world-state-v2";
import {
  checkpointWorldContentHash,
  createWorldHistory,
  recordHistoryEntry,
} from "./history-persistence-checkpoint";
import {planCountryDissolve} from "./country-dissolve-planner";
import {planCountryEstablish} from "./country-establish-planner";
import {planCountrySplit} from "./country-split-planner";
import {
  applyWorkerResultWithFailureGuard,
  injectProjectionFailureAndRetry,
  measurePlannerOperations,
  redoHistoryWithRevisionGuard,
  summarizeIncrementalHashDeltas,
  undoHistoryWithRevisionGuard,
} from "./performance-resilience-checkpoint";
import type {PlannerContext} from "./planner-boundary";
import type {WorldPatchV2} from "./world-patch-v2";

const activeCountryId = (countryId: string) => countryId as ActiveCountryId;
const hash = (character: string) => character.repeat(64);
const context: PlannerContext = {committedCommandIds: new Set()};

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

const country = (id: string) => createCountryEntity({
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
  ownerCountryId: string | null,
  x: number,
) => createTerritoryEntity({
  id: deriveTerritoryId({
    kind: "seed",
    seedVersion: "10-118-test",
    sourceFeatureId,
  }),
  ownerCountryId: ownerCountryId === null ? null : activeCountryId(ownerCountryId),
  geometry: rectangle(x),
  properties: {sourceFeatureId},
});

const world = (
  revision: number,
  territoryOwners: readonly (string | null)[] = ["AAA", "AAA", "BBB"],
): WorldStateV2 => {
  const territories = territoryOwners.map((owner, index) =>
    territory(`territory-${index}`, owner, index * 2)
  );
  return createWorldStateV2({
    schemaVersion: WORLD_STATE_V2_SCHEMA_VERSION,
    seedVersion: "10-118-test",
    policyVersion: "world-policy-v1",
    revision,
    countriesById: {
      AAA: country("AAA"),
      BBB: country("BBB"),
      CCC: country("CCC"),
    },
    countryOrder: [activeCountryId("AAA"), activeCountryId("BBB"), activeCountryId("CCC")],
    retiredCountryIds: [],
    territoriesById: Object.fromEntries(territories.map((entry) => [entry.id, entry])),
    territoryOrder: territories.map(({id}) => id),
    topology: createTopologyState([]),
    hashRoots: {
      countriesRootHash: hash("a"),
      presentationRootHash: hash("b"),
      territoriesRootHash: hash("c"),
      topologyRootHash: hash("d"),
    },
  });
};

const identity = (id: string) => ({
  id,
  names: {
    shortKo: id,
    officialKo: `${id} Republic`,
    mapKo: id,
    english: `${id} Republic`,
    searchAliases: [id],
  },
  politicalStatus: "sovereign" as const,
  presentationOverride: null,
  moduleVersions: {core: 1, names: 1},
});

const establishCommand = (state: WorldStateV2): CountryEstablishV2Command => ({
  type: "country.establish",
  commandId: "establish-ddd",
  expectedRevision: state.revision,
  payload: {
    country: identity("DDD"),
    territoryIds: [state.territoryOrder[2]],
  },
});

const dissolveCommand = (state: WorldStateV2): CountryDissolveV2Command => ({
  type: "country.dissolve",
  commandId: "dissolve-aaa",
  expectedRevision: state.revision,
  payload: {
    sourceCountryId: "AAA",
    territoryDispositions: state.territoryOrder.slice(0, 2).map((territoryId) => ({
      territoryId,
      disposition: {type: "transfer", targetCountryId: "BBB"},
    })),
  },
});

const splitCommand = (state: WorldStateV2): CountrySplitV2Command => ({
  type: "country.split",
  commandId: "split-aaa",
  expectedRevision: state.revision,
  payload: {
    sourceCountryId: "AAA",
    resultCountries: [
      {
        country: identity("XAA"),
        territorySources: [{kind: "territory-id", territoryId: state.territoryOrder[0]}],
      },
      {
        country: identity("XAB"),
        territorySources: [{kind: "territory-id", territoryId: state.territoryOrder[1]}],
      },
    ],
  },
});

const fakePatch = (
  before: WorldStateV2,
  after: WorldStateV2,
  territoryIds: readonly TerritoryId[],
): WorldPatchV2 => ({
  kind: "world.patch.v2",
  schemaVersion: 1,
  commandId: "checkpoint-patch",
  beforeRevision: before.revision,
  afterRevision: after.revision,
  beforeContentHash: checkpointWorldContentHash(before),
  afterContentHash: checkpointWorldContentHash(after),
  entityDeltas: {countryIds: [], territoryIds, topologyEdgeIds: []},
  entityChangeSets: {
    countries: {created: [], updated: [], deleted: []},
    territories: {created: [], updated: territoryIds, deleted: []},
    topologyEdges: {created: [], updated: [], deleted: []},
  },
  moduleHashDeltas: {
    country: null,
    territory: {beforeRootHash: hash("c"), afterRootHash: hash("e")},
    ownership: {beforeRootHash: hash("c"), afterRootHash: hash("e")},
    geometry: null,
    topology: null,
    presentation: null,
  },
  moduleLeafHashDeltas: {
    countryCore: [],
    countryPresentation: [],
    territoryGeometry: [],
    territoryOwnership: territoryIds.map((id) => ({
      id,
      beforeLeafHash: hash("1"),
      afterLeafHash: hash("2"),
    })),
    topologyEdge: [],
  },
  plannerPatch: {kind: "territory.transfer"},
});

describe("10-113~10-118 performance and resilience checkpoint", () => {
  it("summarizes incremental hash deltas without requiring a full leaf rebuild", () => {
    const before = world(70);
    const after = world(71, ["BBB", "AAA", "BBB"]);
    const patch = fakePatch(before, after, [before.territoryOrder[0]]);

    const summary = summarizeIncrementalHashDeltas(patch, 9);

    expect(summary.changedRootCount).toBe(2);
    expect(summary.changedLeafCount).toBe(1);
    expect(summary.leafTouchRatio).toBeLessThan(1);
    expect(summary.avoidedFullLeafRebuild).toBe(true);
  });

  it("keeps establish split and dissolve planner timing bounded to minimal iterations", () => {
    const splitState = world(70);
    const establishState = world(70, ["AAA", "AAA", null]);
    const dissolveState = world(70);

    const summary = measurePlannerOperations({
      establish: () => planCountryEstablish(establishState, establishCommand(establishState), context),
      split: () => planCountrySplit(splitState, splitCommand(splitState), context),
      dissolve: () => planCountryDissolve(dissolveState, dissolveCommand(dissolveState), context),
    });

    expect(summary.failedOperationNames).toEqual([]);
    expect(summary.timings.map(({name}) => name).sort()).toEqual(["dissolve", "establish", "split"]);
    expect(summary.timings.every(({iterations, elapsedMs}) => iterations === 1 && elapsedMs >= 0))
      .toBe(true);
  });

  it("rejects stale undo redo races without mutating history or state", () => {
    const before = world(70);
    const after = world(71, ["BBB", "AAA", "BBB"]);
    const history = recordHistoryEntry(
      createWorldHistory(before.revision),
      fakePatch(before, after, [before.territoryOrder[0]]),
      before,
      after,
    );

    const staleUndo = undoHistoryWithRevisionGuard(history, after, 999);
    const validUndo = undoHistoryWithRevisionGuard(history, after, after.revision);
    const staleRedo = redoHistoryWithRevisionGuard(validUndo.history, validUndo.state, 999);

    expect(staleUndo.staleRejected).toBe(true);
    expect(staleUndo.history).toBe(history);
    expect(staleUndo.state).toBe(after);
    expect(validUndo.staleRejected).toBe(false);
    expect(staleRedo.staleRejected).toBe(true);
    expect(staleRedo.history).toBe(validUndo.history);
    expect(staleRedo.state).toBe(validUndo.state);
  });

  it("retains the last good projection on failure and recovers on latest revision retry", () => {
    const before = world(70);
    const committed = world(71, ["BBB", "AAA", "BBB"]);
    const latest = world(72, ["BBB", "BBB", "BBB"]);
    const adapter: ProjectionAdapter = {
      name: "injected-map",
      build: (state) => ({revision: state.revision}),
      applyPatch: () => {
        throw new Error("injected projection failure");
      },
      artifactHash: (value) => `artifact:${(value as {revision: number}).revision}`,
    };
    const coordinator = createProjectionCoordinator(before, [adapter]);

    const result = injectProjectionFailureAndRetry(
      coordinator,
      [adapter],
      fakePatch(before, committed, [before.territoryOrder[0]]),
      committed,
      latest,
    );

    expect(result.failedProjectionNames).toEqual(["injected-map"]);
    expect(result.retainedRevision).toBe(before.revision);
    expect(result.retainedArtifactHash).toBe("artifact:70");
    expect(result.retriedRevision).toBe(latest.revision);
    expect(result.recovered).toBe(true);
  });

  it("keeps point fallback labels when worker failure is injected and accepts a later result", () => {
    const projection = createLabelProjection(world(70));
    const job = projection.jobs[0];

    const failed = applyWorkerResultWithFailureGuard(projection, () => {
      throw new Error("injected worker failure");
    });
    const recovered = applyWorkerResultWithFailureGuard(failed.projection, () =>
      runPureGlyphWorker(job)
    );

    expect(failed.failureCount).toBe(1);
    expect(failed.accepted).toBe(false);
    expect(failed.projection.pointFallbacksByLabelId.size).toBe(projection.jobs.length);
    expect(recovered.failureCount).toBe(0);
    expect(recovered.accepted).toBe(true);
    expect(recovered.projection.glyphsByLabelId.has(job.jobId)).toBe(true);
  });
});
