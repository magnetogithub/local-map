import fs from "node:fs";
import path from "node:path";
import {describe, expect, it} from "vitest";

import {createCountrySearchProjection} from "../projection/country-search-index-patch";
import {checkpointWorldContentHash} from "../planning/history-persistence-checkpoint";
import {createCommandUiDemoWorldState} from "../planning/command-ui-runtime";
import {canonicalSerialize} from "../world/canonical-serializer";
import {createImmutableReadonlySet} from "../world/immutable-readonly-set";
import {sha256Hex} from "../world/sha256";
import {deriveTerritoryId} from "../world/territory-id";
import {createTopologyState} from "../world/topology-state";
import {createWorldStateV2, WORLD_STATE_V2_SCHEMA_VERSION} from "../world/world-state-v2";
import {
  removeCountry,
  testCountry,
  testWorldState,
} from "../../stores/world-state-store-v2-fixture";
import {createAtomicTurnRuntime} from "./atomic-turn-runtime";
import {createInitialSimulationState} from "./initial-simulation-state";
import {createResolvedTurnPlan} from "./resolved-turn-plan";
import {
  buildSimulationContext,
  serializeSimulationContext,
} from "./simulation-context";
import {
  assertSimulationStateInvariants,
  createSimulationStateV1,
} from "./simulation-state";
import {
  MAX_PERSISTED_TURN_HISTORY,
  restoreSimulationRuntime,
  serializeSimulationRuntime,
} from "./simulation-persistence";
import {
  createSubdivisionCatalogTestAdapter,
  type SubdivisionCatalog,
  type SupportedSubdivisionFixture,
} from "./subdivision-catalog";
import {SIMULATION_CONTRACT_VERSION} from "./simulation-contract-primitives";
import {
  compileWorldEffects,
  createSequentialCommandIdAllocator,
} from "./world-effect-compiler";

const readFixture = (file: string) => JSON.parse(
  fs.readFileSync(path.join(process.cwd(), file), "utf8"),
) as SupportedSubdivisionFixture;

const chinaFixture = readFixture("public/data/maps/china-province-countries-test.geojson");
const usaFixture = readFixture("public/data/maps/usa-state-countries-test.geojson");
const subdivisionCatalog = createSubdivisionCatalogTestAdapter([chinaFixture, usaFixture]);
const emptyCatalog: SubdivisionCatalog = Object.freeze({
  listCountry: () => Object.freeze([]),
  inspect: () => null,
  materialize: () => null,
});

const createUsaSubdivisionWorld = () => {
  const polygons = usaFixture.features.flatMap((feature) => {
    const geometry = feature.geometry as {
      type: "Polygon" | "MultiPolygon";
      coordinates: unknown[];
    };
    return geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;
  });
  const territoryId = deriveTerritoryId({
    kind: "seed",
    seedVersion: usaFixture.scenario,
    sourceFeatureId: "USA",
  });
  const hash = (namespace: string) => sha256Hex(canonicalSerialize({namespace}));
  return createWorldStateV2({
    schemaVersion: WORLD_STATE_V2_SCHEMA_VERSION,
    seedVersion: usaFixture.scenario,
    policyVersion: "world-policy-v1",
    revision: 0,
    countriesById: {USA: testCountry("USA", "미국")},
    countryOrder: [testCountry("USA").id],
    retiredCountryIds: createImmutableReadonlySet([]),
    territoriesById: {
      [territoryId]: {
        id: territoryId,
        ownerCountryId: testCountry("USA").id,
        geometry: {type: "MultiPolygon", coordinates: polygons},
        properties: {sourceFeatureId: "USA"},
      },
    },
    territoryOrder: [territoryId],
    topology: createTopologyState([]),
    hashRoots: {
      countriesRootHash: hash("countries"),
      presentationRootHash: hash("presentation"),
      territoriesRootHash: hash("territories"),
      topologyRootHash: hash("topology"),
    },
  });
};

const queuedAction = (actionId = "action.1") => ({
  actionId,
  actorCountryId: "AAA",
  submittedAtDate: "2020-01-01",
  text: "공동 협상을 제안한다.",
  visibility: "public" as const,
  status: "queued" as const,
});

const event = (overrides: Record<string, unknown> = {}) => ({
  eventId: "event.turn-1",
  date: "2020-01-15",
  title: "외교 협상",
  publicNarrative: "대표단이 회담 결과를 발표했습니다.",
  actorCountryIds: ["AAA", "BBB"],
  relatedFactIds: [],
  relatedSituationIds: [],
  causes: [{kind: "queued-action", id: "action.1"}],
  outcomeCategory: "diplomatic",
  significance: "notable",
  ...overrides,
});

const resolution = (overrides: Record<string, unknown> = {}) => ({
  contractVersion: SIMULATION_CONTRACT_VERSION,
  baseSimulationRevision: 0,
  baseWorldRevision: 0,
  period: {startDate: "2020-01-01", endDate: "2020-02-01"},
  playerActionOutcomes: [{
    outcomeId: "outcome.1",
    actionId: "action.1",
    status: "delayed",
    evidenceEventId: "event.turn-1",
    summary: "협상은 계속 진행됩니다.",
    remainingConditions: ["상대국의 비준이 필요합니다."],
  }],
  events: [event()],
  factMutations: [],
  situationMutations: [],
  scheduledConsequences: [],
  worldEffects: [],
  advisorSummary: "이번 기간에는 국경 변화가 없습니다.",
  unresolvedQuestions: [],
  ...overrides,
});

const initialWithAction = () => {
  const world = createCommandUiDemoWorldState();
  const initial = createInitialSimulationState(world, "AAA");
  return {
    world,
    simulation: createSimulationStateV1({
      ...initial,
      queuedActions: [queuedAction()],
    }, world),
  };
};

const negotiationResolution = () => resolution({
  events: [event({
    relatedFactIds: ["fact.negotiation"],
    relatedSituationIds: ["situation.negotiation"],
  })],
  factMutations: [{
    mutationId: "mutation.fact-1",
    operation: "upsert",
    causedByEventId: "event.turn-1",
    factId: null,
    fact: {
      factId: "fact.negotiation",
      kind: "treaty-or-negotiation",
      actorCountryIds: ["AAA", "BBB"],
      publicSummary: "양국 통합 협상이 진행 중입니다.",
      startDate: "2020-01-15",
      status: "active",
      sourceEventId: "event.turn-1",
    },
  }],
  situationMutations: [{
    mutationId: "mutation.situation-1",
    operation: "upsert",
    causedByEventId: "event.turn-1",
    situationId: null,
    situation: {
      situationId: "situation.negotiation",
      type: "unification-negotiation",
      participantCountryIds: ["AAA", "BBB"],
      stage: "협상 개시",
      stakes: "양국의 제도 통합",
      startedByEventId: "event.turn-1",
      lastUpdatedByEventId: "event.turn-1",
      unresolvedQuestion: "양국 의회가 조약을 비준할 것인가?",
      status: "active",
    },
  }],
});

const ratificationResolution = (simulationRevision: number, worldRevision: number) => ({
  contractVersion: SIMULATION_CONTRACT_VERSION,
  baseSimulationRevision: simulationRevision,
  baseWorldRevision: worldRevision,
  period: {startDate: "2020-02-01", endDate: "2020-03-01"},
  playerActionOutcomes: [],
  events: [{
    eventId: "event.ratification",
    date: "2020-02-20",
    title: "통일 조약 비준",
    publicNarrative: "양국 의회가 통일 조약을 비준했습니다.",
    actorCountryIds: ["AAA", "BBB"],
    relatedFactIds: ["fact.negotiation"],
    relatedSituationIds: ["situation.negotiation"],
    causes: [{kind: "authoritative-event", id: "event.turn-1"}],
    outcomeCategory: "treaty",
    significance: "transformative",
  }],
  factMutations: [{
    mutationId: "mutation.fact-end",
    operation: "end",
    causedByEventId: "event.ratification",
    factId: "fact.negotiation",
    fact: null,
  }],
  situationMutations: [{
    mutationId: "mutation.situation-resolve",
    operation: "resolve",
    causedByEventId: "event.ratification",
    situationId: "situation.negotiation",
    situation: null,
  }],
  scheduledConsequences: [],
  worldEffects: [{
    effectId: "effect.unify",
    type: "countries.unified",
    causedByEventId: "event.ratification",
    countryIds: ["AAA", "BBB"],
    newCountryRef: "country.union",
    displayName: "공동 연방",
  }],
  advisorSummary: "통일 조약이 비준되어 양국이 하나의 연방으로 통합됐습니다.",
  unresolvedQuestions: [],
});

describe("12-11 SimulationStateV1 container", () => {
  it("enforces active/retired references, canonical orders, clock, and linkages", () => {
    const world = testWorldState(["AAA", "BBB"]);
    const initial = createInitialSimulationState(world, "AAA");
    expect(() => assertSimulationStateInvariants(initial, world)).not.toThrow();
    expect(() => createSimulationStateV1({...initial, playerCountryId: "ZZZ"}, world)).toThrow(
      /not active/,
    );
    expect(() => createSimulationStateV1({
      ...initial,
      factsById: {
        "fact.1": {
          factId: "fact.1",
          kind: "scenario",
          actorCountryIds: ["AAA"],
          publicSummary: "테스트 사실",
          startDate: "2020-01-01",
          status: "active",
          sourceEventId: "event.missing",
        },
      },
      factOrder: ["fact.wrong"],
    }, world)).toThrow(/order/);
    const retiredWorld = removeCountry(testWorldState(["AAA", "BBB"]), "BBB");
    expect(() => createSimulationStateV1({
      ...initial,
      playerCountryId: "AAA",
      eventLog: [{...event(), actorCountryIds: ["BBB"], date: "2020-01-01", causes: []}],
    }, retiredWorld)).not.toThrow();
    expect(() => createSimulationStateV1({
      ...initial,
      eventLog: [{...event(), date: "2020-01-02", causes: []}],
    }, world)).toThrow(/clock order/);
  });
});

describe("12-12 initial simulation seed", () => {
  it("initializes every active country without a core allowlist", () => {
    const world = testWorldState(["AAA", "BBB", "CCC"]);
    for (const countryId of world.countryOrder) {
      expect(createInitialSimulationState(world, countryId)).toMatchObject({
        currentDate: "2020-01-01",
        turnNumber: 0,
        playerCountryId: countryId,
        history: {lastCommittedTurnId: null, committedTurnCount: 0},
      });
    }
    expect(() => createInitialSimulationState(world, "ZZZ")).toThrow(/inactive/);
  });
});

describe("12-13 SimulationContextV1", () => {
  it("is canonical, compact, and excludes geometry/topology/projection/history images", () => {
    const world = testWorldState(["AAA", "BBB"]);
    const initial = createInitialSimulationState(world, "AAA");
    const simulation = createSimulationStateV1({
      ...initial,
      queuedActions: [queuedAction()],
      eventLog: Array.from({length: 25}, (_, index) => ({
        ...event(),
        eventId: `event.seed-${index.toString().padStart(2, "0")}`,
        date: "2020-01-01",
        causes: [],
      })),
    }, world);
    const projection = createCountrySearchProjection(world);
    const context = buildSimulationContext({
      simulation,
      world,
      countrySearchProjection: projection,
      subdivisionCatalog: emptyCatalog,
      scenarioId: "2020-otl",
      scenarioStartDate: "2020-01-01",
      targetDate: "2020-02-01",
    });
    const first = serializeSimulationContext(context);
    const second = serializeSimulationContext(buildSimulationContext({
      simulation,
      world,
      countrySearchProjection: projection,
      subdivisionCatalog: emptyCatalog,
      scenarioId: "2020-otl",
      scenarioStartDate: "2020-01-01",
      targetDate: "2020-02-01",
    }));
    expect(first).toBe(second);
    expect(first).not.toMatch(/geometry|topology|projection|beforeImage|undo/i);
    expect(context.recentEvents).toHaveLength(20);
    expect(context.metadata.clipped).toContainEqual(expect.objectContaining({
      section: "recentEvents",
      omittedCount: 5,
    }));
  });
});

describe("12-14 SubdivisionCatalog boundary", () => {
  it("deterministically exposes the checked-in China and US fixtures", () => {
    const china = subdivisionCatalog.listCountry("CHN");
    const usa = subdivisionCatalog.listCountry("USA");
    expect(china).toHaveLength(31);
    expect(usa).toHaveLength(50);
    expect([...usa].map((entry) => entry.ref.subdivisionId)).toEqual(
      [...usa].map((entry) => entry.ref.subdivisionId).sort(),
    );
    expect(usa.every((entry) => entry.materializable)).toBe(true);
    expect(subdivisionCatalog.materialize(usa[0].ref)?.geometry.type).toMatch(/Polygon/);
    expect(subdivisionCatalog).not.toHaveProperty("importGeoJson");
  });
});

describe("12-15 and 12-16 world effect compiler", () => {
  it("injects command ids/revisions and reports stale or unknown refs with typed errors", () => {
    const world = testWorldState(["AAA", "BBB"]);
    const compiled = compileWorldEffects({
      effects: [{
        effectId: "effect.rename",
        type: "country.renamed",
        causedByEventId: "event.1",
        countryId: "AAA",
        displayName: "새 이름",
      }],
      world,
      expectedWorldRevision: 0,
      subdivisionCatalog: emptyCatalog,
      allocator: createSequentialCommandIdAllocator("turn.rename"),
    });
    expect(compiled.batch?.expectedRevision).toBe(0);
    expect(compiled.batch?.payload.commands[0]).toMatchObject({
      commandId: expect.stringContaining("turn.rename"),
      expectedRevision: 0,
      type: "country.rename",
    });
    expect(() => compileWorldEffects({
      effects: [],
      world,
      expectedWorldRevision: 1,
      subdivisionCatalog: emptyCatalog,
      allocator: createSequentialCommandIdAllocator("turn.stale"),
    })).toThrowError(expect.objectContaining({code: "STALE_WORLD_REVISION"}));
    expect(() => compileWorldEffects({
      effects: [{
        effectId: "effect.unknown",
        type: "country.renamed",
        causedByEventId: "event.1",
        countryId: "ZZZ",
        displayName: "없는 국가",
      }],
      world,
      expectedWorldRevision: 0,
      subdivisionCatalog: emptyCatalog,
      allocator: createSequentialCommandIdAllocator("turn.unknown"),
    })).toThrowError(expect.objectContaining({code: "UNKNOWN_COUNTRY"}));
  });

  it("allocates new country ids on the host and rejects self merge and empty dissolution", () => {
    const world = testWorldState(["AAA", "BBB"]);
    const compiled = compileWorldEffects({
      effects: [{
        effectId: "effect.unify",
        type: "countries.unified",
        causedByEventId: "event.1",
        countryIds: ["AAA", "BBB"],
        newCountryRef: "country.union",
        displayName: "공동 연방",
      }],
      world,
      expectedWorldRevision: 0,
      subdivisionCatalog: emptyCatalog,
      allocator: createSequentialCommandIdAllocator("turn.unify"),
    });
    expect(compiled.allocatedCountryIdsByLocalRef["country.union"]).toMatch(/^D[A-Z0-9]{2}$/);
    expect(JSON.stringify(compiled.batch)).not.toContain("newCountryRef");
    const playerLed = compileWorldEffects({
      effects: [{
        effectId: "effect.player-unify",
        type: "countries.unified",
        causedByEventId: "event.1",
        countryIds: ["AAA", "BBB"],
        newCountryRef: "country.player-union",
        displayName: "Player Union",
      }],
      world,
      expectedWorldRevision: 0,
      subdivisionCatalog: emptyCatalog,
      allocator: createSequentialCommandIdAllocator("turn.player-unify"),
      preferredUnifiedCountryId: world.countryOrder[0],
    });
    expect(playerLed.allocatedCountryIdsByLocalRef["country.player-union"]).toBe("AAA");
    expect(playerLed.batch?.payload.commands).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "country.merge",
        payload: expect.objectContaining({
          resultCountry: {kind: "existing-country", countryId: "AAA"},
        }),
      }),
      expect.objectContaining({type: "country.rename"}),
    ]));
    expect(() => compileWorldEffects({
      effects: [{
        effectId: "effect.self",
        type: "countries.unified",
        causedByEventId: "event.1",
        countryIds: ["AAA", "AAA"],
        newCountryRef: "country.self",
        displayName: "잘못된 통합",
      }],
      world,
      expectedWorldRevision: 0,
      subdivisionCatalog: emptyCatalog,
      allocator: createSequentialCommandIdAllocator("turn.self"),
    })).toThrowError(expect.objectContaining({code: "SELF_MERGE"}));
  });
});

describe("12-17 subdivision compiler", () => {
  it("creates exactly 50 deterministic US result countries and fails closed on version mismatch", () => {
    const world = testWorldState(["USA", "BBB"]);
    const states = subdivisionCatalog.listCountry("USA");
    const effect = {
      effectId: "effect.partition-usa",
      type: "country.partitionedBySubdivisions" as const,
      causedByEventId: "event.partition",
      sourceCountryId: "USA",
      partitions: states.map((state, index) => ({
        newCountryRef: `state.${index}`,
        displayName: state.nameKo,
        subdivisionRefs: [state.ref],
      })),
    };
    const compiled = compileWorldEffects({
      effects: [effect],
      world,
      expectedWorldRevision: 0,
      subdivisionCatalog,
      allocator: createSequentialCommandIdAllocator("turn.partition-usa"),
    });
    expect(Object.keys(compiled.allocatedCountryIdsByLocalRef)).toHaveLength(50);
    const split = compiled.batch?.payload.commands[1] as {payload?: {resultCountries?: unknown[]}};
    expect(split.payload?.resultCountries).toHaveLength(50);
    expect(() => compileWorldEffects({
      effects: [{
        ...effect,
        partitions: effect.partitions.map((partition, index) => index === 0
          ? {
              ...partition,
              subdivisionRefs: [{...partition.subdivisionRefs[0], sourceVersion: "wrong-v1"}],
            }
          : partition),
      }],
      world,
      expectedWorldRevision: 0,
      subdivisionCatalog,
      allocator: createSequentialCommandIdAllocator("turn.bad-version"),
    })).toThrowError(expect.objectContaining({code: "SUBDIVISION_VERSION_MISMATCH"}));
  }, 30_000);
});

describe("12-18 through 12-22 deterministic turn runtime", () => {
  it("commits failed diplomacy and delayed negotiation without map effects", () => {
    const {world, simulation} = initialWithAction();
    const failurePlan = createResolvedTurnPlan({
      turnId: "turn.failed-diplomacy",
      simulation,
      world,
      subdivisionCatalog: emptyCatalog,
      resolution: resolution({
        playerActionOutcomes: [{
          ...resolution().playerActionOutcomes[0],
          status: "failed",
          summary: "상대국이 제안을 거절했습니다.",
          remainingConditions: [],
        }],
      }),
    });
    expect(failurePlan.nextWorldState).toBe(world);
    expect(failurePlan.worldPatch).toBeNull();

    const delayedPlan = createResolvedTurnPlan({
      turnId: "turn.negotiation",
      simulation,
      world,
      subdivisionCatalog: emptyCatalog,
      resolution: negotiationResolution(),
    });
    expect(delayedPlan.nextSimulationState.factsById).toHaveProperty("fact.negotiation");
    expect(delayedPlan.nextWorldState).toBe(world);
  });

  it("dry-runs, atomically commits, and undo/redoes a ratified unification", () => {
    const {world, simulation} = initialWithAction();
    const runtime = createAtomicTurnRuntime(simulation, world);
    const firstPlan = createResolvedTurnPlan({
      turnId: "turn.negotiation",
      simulation,
      world,
      subdivisionCatalog: emptyCatalog,
      resolution: negotiationResolution(),
    });
    runtime.commit(firstPlan);
    const beforeUnion = runtime.getSnapshot();
    const beforeWorldHash = checkpointWorldContentHash(beforeUnion.world);
    const unionPlan = createResolvedTurnPlan({
      turnId: "turn.ratification",
      simulation: beforeUnion.simulation,
      world: beforeUnion.world,
      subdivisionCatalog: emptyCatalog,
      resolution: ratificationResolution(
        beforeUnion.simulation.revision,
        beforeUnion.world.revision,
      ),
    });
    expect(runtime.getSnapshot()).toBe(beforeUnion);
    const notifications: string[] = [];
    runtime.subscribe((notification) => notifications.push(
      `${notification.next.revisions.simulationRevision}/${notification.next.revisions.worldRevision}`,
    ));
    const committed = runtime.commit(unionPlan);
    expect(notifications).toHaveLength(1);
    expect(committed.simulation.currentDate).toBe("2020-03-01");
    expect(committed.simulation.eventLog.at(-1)?.eventId).toBe("event.ratification");
    const unionEffect = unionPlan.resolution.worldEffects.find((effect) =>
      effect.type === "countries.unified");
    expect(committed.world.countriesById.AAA?.names.shortKo).toBe(unionEffect?.displayName);
    expect(committed.world.countriesById.BBB).toBeUndefined();
    expect(committed.simulation.playerCountryId).toBe("AAA");
    expect(committed.world.countriesById[committed.simulation.playerCountryId]).toBeDefined();
    const committedContentHash = checkpointWorldContentHash(committed.world);

    const undone = runtime.undo();
    expect(undone.simulation.currentDate).toBe("2020-02-01");
    expect(undone.simulation.eventLog.at(-1)?.eventId).toBe("event.turn-1");
    expect(undone.world.countriesById.AAA).toBeDefined();
    expect(undone.world.countriesById.BBB).toBeDefined();
    expect(checkpointWorldContentHash(undone.world)).toBe(beforeWorldHash);

    const redone = runtime.redo();
    expect(redone.simulation.currentDate).toBe("2020-03-01");
    expect(redone.world.countriesById.AAA).toBeDefined();
    expect(checkpointWorldContentHash(redone.world)).toBe(committedContentHash);
    expect(redone.world.revision).toBeGreaterThan(committed.world.revision);
  });

  it("keeps both states unchanged when compilation or publish fails", () => {
    const {world, simulation} = initialWithAction();
    expect(() => createResolvedTurnPlan({
      turnId: "turn.bad-effect",
      simulation,
      world,
      subdivisionCatalog: emptyCatalog,
      resolution: resolution({
        worldEffects: [{
          effectId: "effect.bad-rename",
          type: "country.renamed",
          causedByEventId: "event.turn-1",
          countryId: "ZZZ",
          displayName: "없는 국가",
        }],
      }),
    })).toThrow();
    const runtime = createAtomicTurnRuntime(simulation, world, {
      beforePublish: () => {
        throw new Error("injected publish failure");
      },
    });
    const plan = createResolvedTurnPlan({
      turnId: "turn.publish-failure",
      simulation,
      world,
      subdivisionCatalog: emptyCatalog,
      resolution: resolution(),
    });
    const before = runtime.getSnapshot();
    expect(() => runtime.commit(plan)).toThrow(/injected/);
    expect(runtime.getSnapshot()).toBe(before);
    expect(runtime.getHistory().entries).toHaveLength(0);
  });

  it("serializes and restores clock, actions, events, facts, situations, and world linkage", () => {
    const {world, simulation} = initialWithAction();
    const runtime = createAtomicTurnRuntime(simulation, world);
    const plan = createResolvedTurnPlan({
      turnId: "turn.persist",
      simulation,
      world,
      subdivisionCatalog: emptyCatalog,
      resolution: negotiationResolution(),
    });
    const committed = runtime.commit(plan);
    const raw = serializeSimulationRuntime({
      simulation: committed.simulation,
      world: committed.world,
      turnHistory: runtime.getHistory().entries,
    });
    const restored = restoreSimulationRuntime(raw, committed.world, simulation);
    expect(restored.recoveredFromCorrupt).toBe(false);
    expect(restored.simulation.currentDate).toBe("2020-02-01");
    expect(restored.simulation.queuedActions[0].status).toBe("resolved");
    expect(restored.simulation.eventLog).toHaveLength(1);
    expect(restored.simulation.factsById).toHaveProperty("fact.negotiation");
    expect(restored.simulation.situationsById).toHaveProperty("situation.negotiation");
    expect(restored.turnHistory).toHaveLength(1);
    expect(restored.world).toBe(committed.world);
    const corrupt = restoreSimulationRuntime("{not-json", committed.world, simulation);
    expect(corrupt.recoveredFromCorrupt).toBe(true);
    expect(corrupt.world).toBe(committed.world);
    expect(corrupt.simulation).toBe(simulation);
    expect(MAX_PERSISTED_TURN_HISTORY).toBe(50);
  });
});

describe("12-22 subdivision independence fixture", () => {
  it("compiles a materialized subdivision establishment without exposing geometry in the effect", () => {
    const world = testWorldState(["USA", "BBB"]);
    const alaska = subdivisionCatalog.listCountry("USA")[0];
    const effect = {
      effectId: "effect.alaska",
      type: "country.established" as const,
      causedByEventId: "event.independence",
      sourceCountryId: "USA",
      territoryIds: [],
      subdivisionRefs: [alaska.ref],
      newCountryRef: "country.alaska",
      displayName: "알래스카 공화국",
    };
    expect(JSON.stringify(effect)).not.toContain("coordinates");
    const compiled = compileWorldEffects({
      effects: [effect],
      world,
      expectedWorldRevision: 0,
      subdivisionCatalog,
      allocator: createSequentialCommandIdAllocator("turn.alaska"),
    });
    expect(compiled.commandCount).toBe(3);
    expect(compiled.batch?.payload.commands.map((command) =>
      (command as {type: string}).type)).toEqual([
      "territory.partition",
      "territory.unclaim",
      "country.establish",
    ]);
  }, 30_000);

  it("dry-runs and atomically commits a subdivision-based new country", () => {
    const world = createUsaSubdivisionWorld();
    const base = createInitialSimulationState(world, "USA");
    const simulation = createSimulationStateV1({
      ...base,
      queuedActions: [{
        actionId: "action.independence",
        actorCountryId: "USA",
        submittedAtDate: "2020-01-01",
        text: "알래스카의 독립 국민투표를 승인한다.",
        visibility: "public",
        status: "queued",
      }],
    }, world);
    const alaska = subdivisionCatalog.listCountry("USA")[0];
    const independenceResolution = {
      contractVersion: SIMULATION_CONTRACT_VERSION,
      baseSimulationRevision: 0,
      baseWorldRevision: 0,
      period: {startDate: "2020-01-01", endDate: "2020-02-01"},
      playerActionOutcomes: [{
        outcomeId: "outcome.independence",
        actionId: "action.independence",
        status: "succeeded",
        evidenceEventId: "event.independence",
        summary: "독립 절차가 완료됐습니다.",
        remainingConditions: [],
      }],
      events: [{
        eventId: "event.independence",
        date: "2020-01-20",
        title: "알래스카 독립 승인",
        publicNarrative: "국민투표와 비준 절차를 거쳐 알래스카가 독립했습니다.",
        actorCountryIds: ["USA"],
        relatedFactIds: [],
        relatedSituationIds: [],
        causes: [{kind: "queued-action", id: "action.independence"}],
        outcomeCategory: "territorial",
        significance: "transformative",
      }],
      factMutations: [],
      situationMutations: [],
      scheduledConsequences: [],
      worldEffects: [{
        effectId: "effect.alaska",
        type: "country.established",
        causedByEventId: "event.independence",
        sourceCountryId: "USA",
        territoryIds: [],
        subdivisionRefs: [alaska.ref],
        newCountryRef: "country.alaska",
        displayName: "알래스카 공화국",
      }],
      advisorSummary: "알래스카가 독립국으로 수립됐습니다.",
      unresolvedQuestions: [],
    };
    const plan = createResolvedTurnPlan({
      turnId: "turn.alaska-independence",
      simulation,
      world,
      resolution: independenceResolution,
      subdivisionCatalog,
    });
    expect(plan.nextWorldState.countryOrder).toHaveLength(2);
    expect(plan.nextWorldState.territoryOrder).toHaveLength(50);
    const newCountryId = plan.compiledWorldEffects
      .allocatedCountryIdsByLocalRef["country.alaska"];
    expect(plan.nextWorldState.countriesById[newCountryId]).toBeDefined();
    expect(plan.nextWorldState.territoryOrder.filter((territoryId) =>
      plan.nextWorldState.territoriesById[territoryId].ownerCountryId === newCountryId))
      .toHaveLength(1);
    const runtime = createAtomicTurnRuntime(simulation, world);
    const committed = runtime.commit(plan);
    expect(committed.world).toBe(plan.nextWorldState);
    expect(committed.simulation.currentDate).toBe("2020-02-01");
  }, 90_000);
});

describe("persistence retention serialization helper", () => {
  it("uses deterministic hashes for fixture evidence", () => {
    expect(sha256Hex(canonicalSerialize({china: 31, usa: 50}))).toMatch(/^[a-f0-9]{64}$/);
    expect(createImmutableReadonlySet(["A", "A"]).size).toBe(1);
    expect(deriveTerritoryId({
      kind: "seed",
      seedVersion: "fixture",
      sourceFeatureId: "USA",
    })).toContain("territory:seed:");
  });
});

