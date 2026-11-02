import {describe, expect, it} from "vitest";

import {createWorldMapRuntimeProjection} from "@/lib/projection/world-map-runtime-projection";
import {createInitialSimulationState} from "@/lib/simulation/initial-simulation-state";
import type {SimulationEventV1} from "@/lib/simulation/simulation-event";
import {testWorldState} from "@/stores/world-state-store-v2-fixture";
import {createEconomyProjection, createPoliticsProjection} from "./country-management-projection";

const event = (
  eventId: string,
  category: SimulationEventV1["outcomeCategory"],
  actorCountryIds: SimulationEventV1["actorCountryIds"],
): SimulationEventV1 => ({
  eventId,
  date: "2020-01-02",
  title: `${category} 사건`,
  publicNarrative: `${category} 사건의 공개 기록입니다.`,
  actorCountryIds,
  relatedFactIds: [],
  relatedSituationIds: [],
  causes: [],
  outcomeCategory: category,
  significance: "notable",
});

describe("13-14 and 13-15 country management projections", () => {
  it("uses the canonical country while keeping unavailable politics fields null", () => {
    const world = testWorldState(["AAA", "BBB"]);
    const model = createPoliticsProjection({
      world,
      mapProjection: createWorldMapRuntimeProjection(world),
      countryId: world.countryOrder[0],
      simulation: null,
    });
    expect(model.country).toMatchObject({countryId: "AAA", code: "AAA"});
    expect(model.country.mapColor).toMatch(/^#[0-9a-f]{6}$/i);
    expect(model).toMatchObject({
      dataAvailable: false,
      regimeName: null,
      leaderName: null,
      domesticSituation: null,
      recentDomesticEvents: [],
    });
  });

  it("filters real domestic and economic events by category and player country", () => {
    const world = testWorldState(["AAA", "BBB"]);
    const initial = createInitialSimulationState(world, "AAA");
    const simulation = {
      ...initial,
      eventLog: [
        event("event.domestic.aaa", "domestic", ["AAA"]),
        event("event.domestic.bbb", "domestic", ["BBB"]),
        event("event.economic.aaa", "economic", ["AAA", "BBB"]),
      ],
    };
    const input = {
      world,
      mapProjection: createWorldMapRuntimeProjection(world),
      countryId: world.countryOrder[0],
      simulation,
    };
    expect(createPoliticsProjection(input).recentDomesticEvents.map(({eventId}) => eventId))
      .toEqual(["event.domestic.aaa"]);
    const economy = createEconomyProjection(input);
    expect(economy.recentEconomicEvents.map(({eventId}) => eventId))
      .toEqual(["event.economic.aaa"]);
    expect(economy.population).toBeNull();
    expect(economy.metrics).toEqual([
      {key: "production", label: "생산", value: null, unit: null, dataAvailable: false},
      {key: "finance", label: "재정", value: null, unit: null, dataAvailable: false},
      {key: "trade", label: "무역", value: null, unit: null, dataAvailable: false},
    ]);
  });

  it("rejects a retired or unknown country rather than creating placeholder data", () => {
    const world = testWorldState(["AAA"]);
    expect(() => createEconomyProjection({
      world,
      mapProjection: createWorldMapRuntimeProjection(world),
      countryId: "ZZZ" as typeof world.countryOrder[number],
      simulation: null,
    })).toThrow(/not active/);
  });
});
