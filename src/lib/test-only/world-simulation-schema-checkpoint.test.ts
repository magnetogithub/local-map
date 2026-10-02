import fs from "node:fs";
import path from "node:path";
import {describe, expect, it} from "vitest";

import {canonicalStringify} from "../world/canonical-serializer";
import {serializeWorldStateV2} from "../world/world-state-v2";
import {createWorldStateV3, worldStateV3ContentHash, type WorldStateV3} from "../world/world-state-v3";
import {createWorldGeometryCatalogContract} from "../world/world-geometry-catalog-ref";
import {sha256Hex} from "../world/sha256";
import {createAtomicTurnRuntime} from "../simulation/atomic-turn-runtime";
import {createInitialSimulationState} from "../simulation/initial-simulation-state";
import {createSimulationStateV1, type SimulationStateV1} from "../simulation/simulation-state";
import {createSimulationStateV2, simulationStateV2ContentHash, type SimulationStateV2} from "../simulation/simulation-state-v2";
import type {ResolvedTurnPlan} from "../simulation/resolved-turn-plan";
import {parseTurnResolutionV1} from "../simulation/turn-resolution";
import {createWorldV3SyntheticFixture} from "./world-v3-synthetic-fixture";
import {
  createMigratedSchemaRuntime, createWorldV3AtomicPort, deserializeMigratedSchemaPair,
  prepareWorldSimulationSchemaMigration, serializeMigratedSchemaPair,
} from "./world-simulation-schema-checkpoint";

const initialEvent = {
  eventId: "event.seed", date: "2020-01-01", title: "Seed event", publicNarrative: "A starting condition was recorded.",
  actorCountryIds: ["AAA", "BBB"], relatedFactIds: [], relatedSituationIds: [], causes: [],
  outcomeCategory: "territorial", significance: "notable",
};

const fixture = () => {
  const f = createWorldV3SyntheticFixture();
  const legacySimulation = createSimulationStateV1({
    ...createInitialSimulationState(f.legacy, "AAA"), eventLog: [initialEvent],
    queuedActions: [{actionId: "action.1", actorCountryId: "AAA", submittedAtDate: "2020-01-01",
      text: "Negotiate a mandate", status: "queued", visibility: "public"}],
    factsById: {"fact.seed": {factId: "fact.seed", kind: "territorial-claim", actorCountryIds: ["AAA"],
      publicSummary: "Claim recorded", startDate: "2020-01-01", status: "active", sourceEventId: "event.seed"}},
    factOrder: ["fact.seed"],
    situationsById: {"situation.seed": {situationId: "situation.seed", type: "war", participantCountryIds: ["AAA", "BBB"],
      stage: "Negotiation", stakes: "Control", startedByEventId: "event.seed", lastUpdatedByEventId: "event.seed",
      unresolvedQuestion: "Will a mandate be granted?", status: "active"}}, situationOrder: ["situation.seed"],
    scheduledConsequences: [{consequenceId: "consequence.seed", earliestDate: "2020-03-01", deadlineDate: null,
      actorCountryIds: ["AAA"], situationId: "situation.seed", triggerSummary: "Review mandate",
      sourceEventId: "event.seed", status: "scheduled"}],
    history: {lastCommittedTurnId: "turn.seed", committedTurnCount: 1},
  }, f.legacy);
  const input = {legacyWorld: f.legacy, legacySimulation, catalog: f.catalog, mapping: f.mapping,
    countryMapColors: f.countryMapColors, validateCanonicalCoverage: f.validateCanonicalCoverage};
  const pair = prepareWorldSimulationSchemaMigration(input);
  return {...f, legacySimulation, input, pair};
};

const plannedFixture = () => {
  const f = fixture();
  const territoryId = f.targetIds[0];
  const world = createWorldStateV3({...f.pair.world, revision: f.pair.world.revision + 1,
    countriesById: {...f.pair.world.countriesById, AAA: {...f.pair.world.countriesById.AAA, mapColor: "#CC0000"}},
    territoriesById: {...f.pair.world.territoriesById,
      [territoryId]: {...f.pair.world.territoriesById[territoryId], controllerCountryId: "BBB"}},
  }, f.catalog);
  const simulation = createSimulationStateV2({...f.pair.simulation, revision: 1, turnNumber: 1,
    currentDate: "2020-02-01", queuedActions: [],
    eventLog: [...f.pair.simulation.eventLog, {...initialEvent, eventId: "event.mandate", date: "2020-01-15"}],
    territorialControlAuthoritiesById: {"tca:mandate": {id: "tca:mandate", actorCountryId: "BBB", targetCountryId: "AAA",
      allowedTerritoryIds: [territoryId], allowedOperations: ["occupy"], validFrom: "2020-01-15", validTo: null,
      sourceEventId: "event.mandate"}}, territorialControlAuthorityOrder: ["tca:mandate"],
    countryPresentationAuthoritiesById: {"cpa:mandate": {id: "cpa:mandate", actorCountryId: "AAA", targetCountryId: "AAA",
      allowedMapColors: ["#CC0000"], validFrom: "2020-01-15", validTo: "2020-03-01", sourceEventId: "event.mandate"}},
    countryPresentationAuthorityOrder: ["cpa:mandate"],
    history: {lastCommittedTurnId: "turn.checkpoint", committedTurnCount: 2},
  }, world);
  // Synthetic schema state transition only; this does not implement later occupation/color planners.
  const plan: ResolvedTurnPlan<SimulationStateV2, WorldStateV3> = Object.freeze({
    kind: "resolved-turn-plan.v1", turnId: "turn.checkpoint",
    baseSimulationState: f.pair.simulation, baseWorldState: f.pair.world,
    nextSimulationState: simulation, nextWorldState: world,
    resolution: parseTurnResolutionV1({contractVersion: "turn-resolution.v1", baseSimulationRevision: 0,
      baseWorldRevision: f.pair.world.revision, period: {startDate: "2020-01-01", endDate: "2020-02-01"},
      playerActionOutcomes: [], events: [], factMutations: [], situationMutations: [], scheduledConsequences: [],
      worldEffects: [], advisorSummary: "Synthetic schema transition", unresolvedQuestions: []}),
    compiledWorldEffects: {batch: null, allocatedCountryIdsByLocalRef: {}, commandCount: 0}, worldPatch: null,
    beforeWorldHash: worldStateV3ContentHash(f.pair.world), afterWorldHash: worldStateV3ContentHash(world),
    beforeSimulationHash: simulationStateV2ContentHash(f.pair.simulation), afterSimulationHash: simulationStateV2ContentHash(simulation),
    changeSummary: {eventCount: 1, factMutationCount: 0, situationMutationCount: 0, scheduledConsequenceCount: 0,
      worldEffectCount: 0, commandCount: 0, changedCountryIds: ["AAA"], changedTerritoryIds: [territoryId]},
  });
  return {...f, plan};
};

describe("14-5 schema pair preparation and offline snapshots", () => {
  it("migrates the complete pair without touching the legacy world, simulation, or mapping", () => {
    const f = fixture();
    const before = canonicalStringify({world: serializeWorldStateV2(f.legacy), simulation: f.legacySimulation, mapping: f.mapping});
    const again = prepareWorldSimulationSchemaMigration(f.input);
    expect(again).toEqual(f.pair);
    expect(f.pair.world.schemaVersion).toBe(3);
    expect(f.pair.simulation.schemaVersion).toBe(2);
    expect(f.pair.revisions).toEqual({worldRevision: 7, simulationRevision: 0});
    expect({...f.pair.simulation, schemaVersion: 1,
      territorialControlAuthoritiesById: undefined, territorialControlAuthorityOrder: undefined,
      countryPresentationAuthoritiesById: undefined, countryPresentationAuthorityOrder: undefined,
    }).toEqual({...f.legacySimulation, territorialControlAuthoritiesById: undefined, territorialControlAuthorityOrder: undefined,
      countryPresentationAuthoritiesById: undefined, countryPresentationAuthorityOrder: undefined});
    expect(canonicalStringify({world: serializeWorldStateV2(f.legacy), simulation: f.legacySimulation, mapping: f.mapping})).toBe(before);
  });

  it("fails atomically when mapping, coverage, colors, or simulation references fail", () => {
    const f = fixture();
    const sourceBytes = canonicalStringify({world: serializeWorldStateV2(f.legacy), simulation: f.legacySimulation});
    for (const patch of [
      {mapping: f.mapping.slice(1)},
      {validateCanonicalCoverage: () => {throw new Error("coverage proof failed");}},
      {countryMapColors: {AAA: "#123456"}},
      {legacySimulation: {...f.legacySimulation, playerCountryId: "ZZZ"} as SimulationStateV1},
      {legacySimulation: {...f.legacySimulation, factsById: {
        "fact.seed": {...f.legacySimulation.factsById["fact.seed"], factId: "fact.wrong"}}}},
    ]) {
      expect(() => prepareWorldSimulationSchemaMigration({...f.input, ...patch})).toThrow();
      expect(canonicalStringify({world: serializeWorldStateV2(f.legacy), simulation: f.legacySimulation})).toBe(sourceBytes);
    }
  });

  it("produces byte-identical populated and empty pair round trips without immutable geometry", () => {
    const f = plannedFixture();
    const populated = {world: f.plan.nextWorldState, simulation: f.plan.nextSimulationState,
      revisions: {worldRevision: 8, simulationRevision: 1}};
    for (const pair of [f.pair, populated]) {
      const raw = serializeMigratedSchemaPair(pair, f.catalog);
      const restored = deserializeMigratedSchemaPair(raw, f.catalog);
      expect(restored).toEqual(pair);
      expect(serializeMigratedSchemaPair(restored, f.catalog)).toBe(raw);
      expect(raw).not.toMatch(/"(?:coordinates|geometryRef|geometry|topology|hashRoots)":/);
      // Root references belong to snapshots, and geometry/topology asset bytes do not.
      expect(JSON.parse(raw).world.catalogRef).toEqual(f.catalog.ref);
    }
  });

  it("rejects tampered hash, revision pair, catalog root and authority references as one snapshot", () => {
    const f = plannedFixture();
    const raw = serializeMigratedSchemaPair({world: f.plan.nextWorldState, simulation: f.plan.nextSimulationState,
      revisions: {worldRevision: 8, simulationRevision: 1}}, f.catalog);
    const mutations: ((saved: ReturnType<typeof JSON.parse>) => void)[] = [
      saved => {saved.world.countriesById.AAA.mapColor = "#FFFFFF";},
      saved => {saved.world.revision += 1;},
      saved => {saved.revisions.simulationRevision += 1;},
      saved => {saved.pairContentHash = "0".repeat(64);},
      saved => {saved.world.catalogRef.geometryRoot = "0".repeat(64);},
      saved => {saved.simulation.simulation.eventLog = [];},
      saved => {saved.simulation.simulation.territorialControlAuthoritiesById["tca:mandate"].allowedTerritoryIds = [f.legacyIds[0]];},
      saved => {saved.extra = true;},
    ];
    for (const mutate of mutations) {
      const saved = JSON.parse(raw);
      mutate(saved);
      expect(() => deserializeMigratedSchemaPair(JSON.stringify(saved), f.catalog)).toThrow();
    }
  });

  it("requires an explicit V3 adapter and rejects a mixed V3/V1 schema pair", () => {
    const f = fixture();
    expect(() => createAtomicTurnRuntime(f.pair.simulation, f.pair.world)).toThrow(/explicit/);
    expect(() => createAtomicTurnRuntime(f.legacySimulation, f.pair.world,
      {worldPort: createWorldV3AtomicPort(f.catalog)})).toThrow(/schema pair/);
    const catalog = createWorldGeometryCatalogContract({...f.catalog,
      ref: {...f.catalog.ref, geometryRoot: "0".repeat(64)}});
    expect(() => createMigratedSchemaRuntime(f.pair, catalog)).toThrow(/mismatch/);
  });
});

describe("14-5 World V3 / Simulation V2 with the existing atomic runtime", () => {
  it("restores owner/controller/color/catalog ref, all authorities, narrative and history together", () => {
    const f = plannedFixture();
    const runtime = createMigratedSchemaRuntime(f.pair, f.catalog);
    const observed: string[] = [];
    runtime.subscribe(({kind, next}) => {
      expect(next.revisions).toEqual({worldRevision: next.world.revision, simulationRevision: next.simulation.revision});
      expect(next.world.catalogRef).toEqual(f.catalog.ref);
      observed.push(kind);
    });
    const after = runtime.commit(f.plan);
    expect(after.world.territoriesById[f.targetIds[0]].controllerCountryId).toBe("BBB");
    expect(after.world.countriesById.AAA.mapColor).toBe("#CC0000");
    expect(after.simulation.history.committedTurnCount).toBe(2);
    expect(runtime.getHistory().entries[0].beforeWorld).toBe(f.pair.world);
    const undo = runtime.undo();
    expect({...undo.world, revision: f.pair.world.revision}).toEqual(f.pair.world);
    expect({...undo.simulation, revision: f.pair.simulation.revision}).toEqual(f.pair.simulation);
    const redo = runtime.redo();
    expect({...redo.world, revision: after.world.revision}).toEqual(after.world);
    expect({...redo.simulation, revision: after.simulation.revision}).toEqual(after.simulation);
    expect(redo.revisions).toEqual({worldRevision: 10, simulationRevision: 3});
    expect(observed).toEqual(["commit", "undo", "redo"]);
    expect(deserializeMigratedSchemaPair(serializeMigratedSchemaPair(redo, f.catalog), f.catalog)).toEqual(redo);
  });

  it("rejects stale plans, invalid final references, wrong hash and catalog mismatch before publication", () => {
    const f = plannedFixture();
    const runtime = createMigratedSchemaRuntime(f.pair, f.catalog);
    const initial = runtime.getSnapshot();
    const observer = {calls: 0};
    runtime.subscribe(() => {observer.calls++;});
    for (const patch of [
      {baseWorldState: createWorldStateV3(f.pair.world, f.catalog)},
      {beforeWorldHash: "0".repeat(64)}, {afterSimulationHash: "0".repeat(64)},
      {nextWorldState: {...f.plan.nextWorldState, catalogRef: {...f.catalog.ref, topologyRoot: "0".repeat(64)}}},
      {nextSimulationState: {...f.plan.nextSimulationState, territorialControlAuthoritiesById: {
        "tca:mandate": {...f.plan.nextSimulationState.territorialControlAuthoritiesById["tca:mandate"],
          allowedTerritoryIds: [f.legacyIds[0]]}}}},
    ]) {
      expect(() => runtime.commit({...f.plan, ...patch})).toThrow();
      expect(runtime.getSnapshot()).toBe(initial);
      expect(runtime.getHistory()).toEqual({entries: [], pointer: 0});
      expect(observer.calls).toBe(0);
    }
  });

  it("rolls back world, simulation, and history when commit/undo/redo publication fails", () => {
    const f = plannedFixture();
    const runtime = createMigratedSchemaRuntime(f.pair, f.catalog);
    const fail = () => {throw new Error("publication failure");};
    const initial = runtime.getSnapshot();
    expect(() => runtime.commit(f.plan, fail)).toThrow();
    expect(runtime.getSnapshot()).toBe(initial);
    expect(runtime.getHistory().pointer).toBe(0);
    const after = runtime.commit(f.plan);
    expect(() => runtime.undo(fail)).toThrow();
    expect(runtime.getSnapshot()).toBe(after);
    expect(runtime.getHistory().pointer).toBe(1);
    const undo = runtime.undo();
    expect(() => runtime.redo(fail)).toThrow();
    expect(runtime.getSnapshot()).toBe(undo);
    expect(runtime.getHistory().pointer).toBe(0);
    runtime.redo();
    expect(runtime.getHistory().pointer).toBe(1);
  });

  it("keeps both pair and history intact when catalog validation fails during undo", () => {
    const f = plannedFixture();
    const port = createWorldV3AtomicPort(f.catalog);
    let allowRestore = true;
    const runtime = createAtomicTurnRuntime(f.pair.simulation, f.pair.world, {worldPort: {
      ...port, restoreWithRevision(state, revision) {
        if (!allowRestore) throw new Error("catalog unavailable");
        return port.restoreWithRevision(state, revision);
      },
    }});
    const after = runtime.commit(f.plan);
    allowRestore = false;
    expect(() => runtime.undo()).toThrow(/catalog unavailable/);
    expect(runtime.getSnapshot()).toBe(after);
    expect(runtime.getHistory().pointer).toBe(1);
    allowRestore = true;
    runtime.undo();
    expect(runtime.getHistory().pointer).toBe(0);
  });

  it("retains subscriber isolation, pending action authorities, and redo branching", () => {
    const f = plannedFixture();
    const runtime = createMigratedSchemaRuntime(f.pair, f.catalog);
    runtime.subscribe(() => {throw new Error("observer failure");});
    runtime.commit(f.plan);
    expect(runtime.getSubscriberFailures()).toHaveLength(1);
    const before = runtime.undo();
    const world = createWorldStateV3({...f.plan.nextWorldState, revision: before.world.revision + 1}, f.catalog);
    const simulation = createSimulationStateV2({...f.plan.nextSimulationState, revision: before.simulation.revision + 1}, world);
    runtime.commit({...f.plan, turnId: "turn.branch", baseWorldState: before.world, baseSimulationState: before.simulation,
      nextWorldState: world, nextSimulationState: simulation, beforeWorldHash: worldStateV3ContentHash(before.world),
      afterWorldHash: worldStateV3ContentHash(world), beforeSimulationHash: simulationStateV2ContentHash(before.simulation),
      afterSimulationHash: simulationStateV2ContentHash(simulation)});
    expect(runtime.getHistory().entries.map(entry => entry.turnId)).toEqual(["turn.branch"]);
    expect(runtime.redo()).toBe(runtime.getSnapshot());
    const replaced = runtime.replacePendingActions([]);
    expect(replaced.simulation.territorialControlAuthorityOrder).toEqual(["tca:mandate"]);
    expect(replaced.simulation.countryPresentationAuthorityOrder).toEqual(["cpa:mandate"]);
  });
});

describe("14-5 checkpoint evidence and production authority", () => {
  it("keeps production bootstrap/store/resolver/application runtime on the legacy pair", () => {
    const f = fixture();
    expect(createInitialSimulationState(f.legacy, "AAA").schemaVersion).toBe(1);
    const files = ["src/lib/world/initial-world-state-v2.ts", "src/stores/world-state-store.ts",
      "src/lib/simulation/client/application-turn-runtime.ts", "src/lib/simulation/initial-simulation-state.ts",
      "src/lib/simulation/client/use-simulation-turn-controller.ts"];
    for (const file of files) {
      const content = fs.readFileSync(file, "utf8");
      expect(content).not.toMatch(/createWorldStateV3|createSimulationStateV2|createMigratedSchemaRuntime|test-only\//);
    }
    expect(fs.readFileSync("src/lib/simulation/resolved-turn-plan.ts", "utf8")).toContain("simulation: SimulationStateV1;");
    expect(fs.readFileSync("src/stores/world-state-store.ts", "utf8")).toContain("getState(): WorldStateV2;");
  });

  it("measures independent deterministic schema pair artifacts for the checkpoint report", () => {
    const first = fixture();
    const second = fixture();
    const firstBytes = serializeMigratedSchemaPair(first.pair, first.catalog);
    const secondBytes = serializeMigratedSchemaPair(second.pair, second.catalog);
    expect(firstBytes).toBe(secondBytes);
    const encoder = new TextEncoder();
    const evidence = {
      scope: "test-only synthetic catalog; no production catalog generation/cutover",
      schemaVersions: {sourceWorld: first.legacy.schemaVersion, sourceSimulation: first.legacySimulation.schemaVersion,
        targetWorld: first.pair.world.schemaVersion, targetSimulation: first.pair.simulation.schemaVersion},
      countryCount: first.pair.world.countryOrder.length, legacyTerritoryCount: first.legacy.territoryOrder.length,
      targetTerritoryCount: first.pair.world.territoryOrder.length, mappingEntryCount: first.mapping.length,
      authorityCountsAfterMigration: {territorial: first.pair.simulation.territorialControlAuthorityOrder.length,
        presentation: first.pair.simulation.countryPresentationAuthorityOrder.length},
      catalogRef: first.pair.world.catalogRef, pairByteLength: encoder.encode(firstBytes).byteLength,
      pairSha256: sha256Hex(encoder.encode(firstBytes)),
      worldContentHash: worldStateV3ContentHash(first.pair.world),
      simulationContentHash: simulationStateV2ContentHash(first.pair.simulation), independentRunsByteIdentical: true,
      productionFilesVerified: ["src/lib/world/initial-world-state-v2.ts", "src/stores/world-state-store.ts",
        "src/lib/simulation/client/application-turn-runtime.ts", "src/lib/simulation/initial-simulation-state.ts",
        "src/lib/simulation/client/use-simulation-turn-controller.ts", "src/lib/simulation/resolved-turn-plan.ts"],
    };
    if (process.env.PROMPT14_WRITE_SCHEMA_EVIDENCE === "1") {
      fs.writeFileSync(path.join(process.cwd(), ".prompt14-5-evidence.tmp.json"), `${JSON.stringify(evidence, null, 2)}\n`);
    }
  });
});
