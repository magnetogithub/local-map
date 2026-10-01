import {describe, expect, it} from "vitest";

import {createCountrySearchProjection} from "../projection/country-search-index-patch";
import {createProductionInitialWorldStateV2} from "../world/initial-world-state-v2";
import {createInitialSimulationState} from "./initial-simulation-state";
import {
  buildSimulationContext,
  serializeSimulationContext,
  SIMULATION_CONTEXT_LIMITS,
  SimulationContextError,
} from "./simulation-context";
import type {SubdivisionCatalog, SubdivisionCatalogSummary} from "./subdivision-catalog";
import {createProductionSubdivisionCatalog} from "./subdivision-catalog";
import {loadProductionSubdivisionCatalog} from "./production-subdivision-catalog.server";
import {executeReadOnlySimulationTool} from "./server/simulation-tools";
import {validateResolutionAgainstContext} from "./server/context-resolution-validator";
import {createResolvedTurnPlan} from "./resolved-turn-plan";
import {SIMULATION_CONTRACT_VERSION} from "./simulation-contract-primitives";
import {removeCountry, replaceCountry, testWorldState} from "../../stores/world-state-store-v2-fixture";

const noSubdivisions: SubdivisionCatalog = Object.freeze({listCountry: () => [], inspect: () => null, materialize: () => null});
const syntheticSubdivisionCatalog = (count: number): SubdivisionCatalog => {
  const entries: readonly SubdivisionCatalogSummary[] = Object.freeze(Array.from(
    {length: count},
    (_value, index) => {
      const canonicalIndex = count - index;
      const subdivisionId = `AAA-${canonicalIndex.toString().padStart(3, "0")}`;
      return Object.freeze({
        ref: Object.freeze({catalogId: "synthetic-v1", sourceVersion: "fixture-v1", subdivisionId}),
        parentCountryId: "AAA",
        nameKo: `세분 ${canonicalIndex}`,
        nameEn: `Subdivision ${canonicalIndex}`,
        materializable: true,
      });
    },
  ));
  return Object.freeze({
    listCountry: (countryId: string) => countryId === "AAA" ? entries : [],
    inspect: (ref) => entries.find((entry) => entry.ref.subdivisionId === ref.subdivisionId) ?? null,
    materialize: () => null,
  });
};
const build = (world: ReturnType<typeof testWorldState>, playerCountryId: string) => buildSimulationContext({
  simulation: createInitialSimulationState(world, playerCountryId),
  world,
  countrySearchProjection: createCountrySearchProjection(world),
  subdivisionCatalog: noSubdivisions,
  scenarioId: "fixture",
  scenarioStartDate: "2020-01-01",
  targetDate: "2020-02-01",
});

describe("12-R1 production country and ownership directories", () => {
  it("finds first-turn foreign counterparts without geometry and remains below the route budget", () => {
    const world = createProductionInitialWorldStateV2().worldState;
    const context = buildSimulationContext({
      simulation: createInitialSimulationState(world, "AUT"),
      world,
      countrySearchProjection: createCountrySearchProjection(world),
      subdivisionCatalog: noSubdivisions,
      scenarioId: "2020-otl",
      scenarioStartDate: "2020-01-01",
      targetDate: "2020-02-01",
    });
    expect(executeReadOnlySimulationTool("find_country", {query: "독일"}, context)).toEqual(expect.arrayContaining([expect.objectContaining({countryId: "DEU"})]));
    expect(executeReadOnlySimulationTool("find_country", {query: "미국"}, context)).toEqual(expect.arrayContaining([expect.objectContaining({countryId: "USA"})]));
    expect(executeReadOnlySimulationTool("inspect_country_territories", {countryId: "USA"}, context)).toEqual(expect.objectContaining({countryId: "USA"}));
    const serialized = serializeSimulationContext(context);
    expect(serialized).not.toMatch(/coordinates|FeatureCollection|topology|MapLibre/i);
    expect(new TextEncoder().encode(serialized).byteLength).toBeLessThan(SIMULATION_CONTEXT_LIMITS.requestBytes);
  }, 120_000);

  it("tracks rename and retirement from the committed revision", () => {
    const original = testWorldState(["AAA", "BBB"]);
    const renamed = replaceCountry(original, Object.freeze({
      ...original.countriesById.BBB,
      names: Object.freeze({...original.countriesById.BBB.names, shortKo: "새 나국", english: "New Bland"}),
    }));
    const renamedContext = build(renamed, "AAA");
    expect(executeReadOnlySimulationTool("find_country", {query: "새 나국"}, renamedContext)).toEqual([expect.objectContaining({countryId: "BBB"})]);
    const retired = removeCountry(renamed, "BBB");
    const retiredContext = build(retired, "AAA");
    expect(executeReadOnlySimulationTool("find_country", {query: "BBB"}, retiredContext)).toEqual([]);
  });

  it("fails closed instead of clipping an oversized active directory", () => {
    const world = testWorldState(["AAA"]);
    const oversized = {...world, countryOrder: Array.from({length: SIMULATION_CONTEXT_LIMITS.countryDirectory + 1}, () => world.countryOrder[0])};
    expect(() => buildSimulationContext({
      simulation: createInitialSimulationState(world, "AAA"),
      world: oversized as typeof world,
      countrySearchProjection: createCountrySearchProjection(world),
      subdivisionCatalog: noSubdivisions,
      scenarioId: "fixture",
      scenarioStartDate: "2020-01-01",
      targetDate: "2020-02-01",
    })).toThrowError(expect.objectContaining<Partial<SimulationContextError>>({code: "SIMULATION_CONTEXT_TOO_LARGE"}));
  });

  it("clips only subdivision summaries at the deterministic bound with explicit metadata", () => {
    const world = testWorldState(["AAA"]);
    const createContext = (count: number) => buildSimulationContext({
      simulation: createInitialSimulationState(world, "AAA"),
      world,
      countrySearchProjection: createCountrySearchProjection(world),
      subdivisionCatalog: syntheticSubdivisionCatalog(count),
      scenarioId: "fixture",
      scenarioStartDate: "2020-01-01",
      targetDate: "2020-02-01",
    });
    const exact = createContext(SIMULATION_CONTEXT_LIMITS.subdivisions);
    expect(exact.subdivisions).toHaveLength(128);
    expect(exact.metadata.clipped).not.toEqual(expect.arrayContaining([
      expect.objectContaining({section: "subdivisions"}),
    ]));

    const oversized = createContext(SIMULATION_CONTEXT_LIMITS.subdivisions + 2);
    expect(oversized.subdivisions).toHaveLength(128);
    expect(oversized.metadata.clipped).toContainEqual({
      section: "subdivisions",
      omittedCount: 2,
      reason: "bounded to 128 canonical items",
    });
    const ids = oversized.subdivisions.map((entry) => entry.subdivisionId);
    expect(ids).toEqual([...ids].sort());
    expect(ids.at(0)).toBe("AAA-001");
    expect(ids.at(-1)).toBe("AAA-128");
    const serialized = serializeSimulationContext(oversized);
    expect(serialized).toBe(serializeSimulationContext(createContext(130)));
    expect(serialized).not.toMatch(/geometry|coordinates|FeatureCollection|topology/i);
    expect(new TextEncoder().encode(serialized).byteLength).toBeLessThan(SIMULATION_CONTEXT_LIMITS.requestBytes);
  });

  it("lets AUT discover all production CHN and USA subdivisions without exposing geometry", () => {
    const world = createProductionInitialWorldStateV2().worldState;
    const simulation = createInitialSimulationState(world, "AUT");
    const catalog = createProductionSubdivisionCatalog(loadProductionSubdivisionCatalog());
    const createContext = () => buildSimulationContext({
      simulation,
      world,
      countrySearchProjection: createCountrySearchProjection(world),
      subdivisionCatalog: catalog,
      scenarioId: "2020-otl",
      scenarioStartDate: "2020-01-01",
      targetDate: "2020-02-01",
    });
    const context = createContext();
    const china = executeReadOnlySimulationTool("find_country", {query: "CHN"}, context) as {countryId: string}[];
    const usa = executeReadOnlySimulationTool("find_country", {query: "USA"}, context) as {countryId: string}[];
    expect(china).toEqual([expect.objectContaining({countryId: "CHN"})]);
    expect(usa).toEqual([expect.objectContaining({countryId: "USA"})]);
    const chinaSubdivisions = executeReadOnlySimulationTool("list_country_subdivisions", {countryId: china[0].countryId}, context) as typeof context.subdivisions;
    const usaSubdivisions = executeReadOnlySimulationTool("list_country_subdivisions", {countryId: usa[0].countryId}, context) as typeof context.subdivisions;
    expect(chinaSubdivisions).toHaveLength(31);
    expect(usaSubdivisions).toHaveLength(50);
    const serialized = serializeSimulationContext(context);
    expect(serialized).toBe(serializeSimulationContext(createContext()));
    expect(serialized).not.toMatch(/coordinates|FeatureCollection|topology|geometry/i);
    expect(new TextEncoder().encode(serialized).byteLength).toBeLessThan(SIMULATION_CONTEXT_LIMITS.requestBytes);

    const subdivision = chinaSubdivisions[0];
    const resolution = {
      contractVersion: SIMULATION_CONTRACT_VERSION,
      baseSimulationRevision: 0,
      baseWorldRevision: 0,
      period: context.period,
      playerActionOutcomes: [],
      events: [{eventId: "event.china-independence", date: context.period.endDate, title: "Regional independence", publicNarrative: "A Chinese subdivision declared independence after a negotiated transition.", actorCountryIds: ["AUT", "CHN"], relatedFactIds: [], relatedSituationIds: [], causes: [], outcomeCategory: "territorial", significance: "transformative"}],
      factMutations: [], situationMutations: [], scheduledConsequences: [],
      worldEffects: [{effectId: "effect.china-independence", type: "country.established", causedByEventId: "event.china-independence", sourceCountryId: "CHN", territoryIds: [], subdivisionRefs: [{catalogId: subdivision.catalogId, sourceVersion: subdivision.sourceVersion, subdivisionId: subdivision.subdivisionId}], newCountryRef: "new.china-region", displayName: "Independent Region"}],
      advisorSummary: "A regional independence transition changed the map.", unresolvedQuestions: [],
    };
    expect(validateResolutionAgainstContext(resolution, context).ok).toBe(true);
    expect(() => createResolvedTurnPlan({turnId: "turn.china-independence", simulation, world, resolution, subdivisionCatalog: catalog})).not.toThrow();

    const missingReference = structuredClone(resolution);
    missingReference.worldEffects[0].subdivisionRefs[0].subdivisionId = "missing-subdivision";
    expect(validateResolutionAgainstContext(missingReference, context).ok).toBe(false);
    expect(() => createResolvedTurnPlan({turnId: "turn.invalid-subdivision", simulation, world, resolution: missingReference, subdivisionCatalog: catalog})).toThrow();
  }, 180_000);
});
