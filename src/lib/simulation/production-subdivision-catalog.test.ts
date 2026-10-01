import {describe, expect, it} from "vitest";

import {createCountrySearchProjection} from "../projection/country-search-index-patch";
import {createProductionInitialWorldStateV2} from "../world/initial-world-state-v2";
import {testWorldState} from "../../stores/world-state-store-v2-fixture";
import {createInitialSimulationState} from "./initial-simulation-state";
import {loadProductionSubdivisionCatalog} from "./production-subdivision-catalog.server";
import {createResolvedTurnPlan} from "./resolved-turn-plan";
import {buildSimulationContext, serializeSimulationContext} from "./simulation-context";
import {createProductionSubdivisionCatalog} from "./subdivision-catalog";
import {compileWorldEffects, createSequentialCommandIdAllocator} from "./world-effect-compiler";

describe("12-R3 production subdivision catalog", () => {
  it("loads the versioned CHN and USA boundary sets and keeps geometry out of API context", () => {
    const serialized = loadProductionSubdivisionCatalog();
    const catalog = createProductionSubdivisionCatalog(serialized);
    expect(catalog.listCountry("CHN")).toHaveLength(31);
    expect(catalog.listCountry("USA")).toHaveLength(50);
    const world = testWorldState(["USA", "BBB"]);
    const context = buildSimulationContext({
      simulation: createInitialSimulationState(world, "USA"),
      world,
      countrySearchProjection: createCountrySearchProjection(world),
      subdivisionCatalog: catalog,
      scenarioId: "fixture",
      scenarioStartDate: "2020-01-01",
      targetDate: "2020-02-01",
    });
    expect(context.subdivisions).toHaveLength(50);
    expect(serializeSimulationContext(context)).not.toContain("coordinates");
  }, 60_000);

  it("compiles production subdivision references and fails closed for unsupported or mismatched data", () => {
    const catalog = createProductionSubdivisionCatalog(loadProductionSubdivisionCatalog());
    const world = createProductionInitialWorldStateV2().worldState;
    const state = catalog.listCountry("USA")[0];
    const effect = {
      effectId: "effect.independence",
      type: "country.established" as const,
      causedByEventId: "event.independence",
      sourceCountryId: "USA",
      territoryIds: [],
      subdivisionRefs: [state.ref],
      newCountryRef: "country.independent",
      displayName: "독립국",
    };
    expect(compileWorldEffects({effects: [effect], world, expectedWorldRevision: 0, subdivisionCatalog: catalog, allocator: createSequentialCommandIdAllocator("turn.production")} ).commandCount).toBe(3);
    expect(() => compileWorldEffects({effects: [{...effect, subdivisionRefs: [{...state.ref, sourceVersion: "wrong-v1"}]}], world, expectedWorldRevision: 0, subdivisionCatalog: catalog, allocator: createSequentialCommandIdAllocator("turn.mismatch")})).toThrowError(expect.objectContaining({code: "SUBDIVISION_VERSION_MISMATCH"}));
    const unsupportedWorld = testWorldState(["AAA", "BBB"]);
    expect(() => compileWorldEffects({effects: [{...effect, sourceCountryId: "AAA"}], world: unsupportedWorld, expectedWorldRevision: 0, subdivisionCatalog: catalog, allocator: createSequentialCommandIdAllocator("turn.unsupported")})).toThrowError(expect.objectContaining({code: "SUBDIVISION_DATA_UNAVAILABLE"}));
  }, 180_000);

  it("rejects a partial geometry asset before exposing a catalog", () => {
    const serialized = loadProductionSubdivisionCatalog();
    const broken = structuredClone(serialized);
    (broken.assets[0].features[0] as unknown as {geometry: unknown}).geometry = null;
    expect(() => createProductionSubdivisionCatalog(broken)).toThrow();
  }, 60_000);

  it("creates three independent northeast Chinese provinces with one shared partition", () => {
    const catalog = createProductionSubdivisionCatalog(loadProductionSubdivisionCatalog());
    const world = createProductionInitialWorldStateV2().worldState;
    const simulation = createInitialSimulationState(world, "KOR");
    const subdivisions = catalog.listCountry("CHN");
    const ids = ["CHN-HL", "CHN-JL", "CHN-LN"];
    const resolution = {
      contractVersion: "turn-resolution.v1",
      baseSimulationRevision: 0,
      baseWorldRevision: 0,
      period: {startDate: "2020-01-01", endDate: "2020-02-01"},
      playerActionOutcomes: [],
      events: [{
        eventId: "event.northeast-independence",
        date: "2020-01-15",
        title: "동북 3성 독립",
        publicNarrative: "동북 3성이 각각 독립 국가를 수립했다.",
        actorCountryIds: ["CHN", "KOR"],
        relatedFactIds: [],
        relatedSituationIds: [],
        causes: [],
        outcomeCategory: "territorial",
        significance: "transformative",
      }],
      factMutations: [],
      situationMutations: [],
      scheduledConsequences: [],
      worldEffects: ids.map((subdivisionId, index) => ({
        effectId: `effect.northeast.${index}`,
        type: "country.established",
        causedByEventId: "event.northeast-independence",
        sourceCountryId: "CHN",
        territoryIds: [],
        subdivisionRefs: [subdivisions.find((entry) =>
          entry.ref.subdivisionId === subdivisionId)!.ref],
        newCountryRef: `new.northeast.${index}`,
        displayName: subdivisionId,
      })),
      advisorSummary: "동북 3성의 독립이 지도에 반영되었다.",
      unresolvedQuestions: [],
    };

    const plan = createResolvedTurnPlan({
      turnId: "turn.northeast-independence",
      simulation,
      world,
      resolution,
      subdivisionCatalog: catalog,
    });
    expect(plan.nextWorldState.countriesById.CHN).toBeDefined();
    expect(plan.nextWorldState.countryOrder).toHaveLength(world.countryOrder.length + 3);
    expect(plan.nextWorldState.revision).toBe(world.revision + 1);
    expect(plan.compiledWorldEffects.commandCount).toBe(5);
  }, 300_000);
});
