import {describe, expect, it} from "vitest";

import type {TurnReport} from "@/lib/simulation/client/turn-report";
import type {SimulationEventV1} from "@/lib/simulation/simulation-event";
import type {SimulationStateV1} from "@/lib/simulation/simulation-state";
import {createNewsProjection, filterNewsItems} from "./news-projection";

function event(eventId: string, date: string, significance: SimulationEventV1["significance"], narrative = `${eventId} narrative`): SimulationEventV1 {
  return {eventId, date, title: `${eventId} title`, publicNarrative: narrative, actorCountryIds: ["AAA", "BBB"], relatedFactIds: [], relatedSituationIds: [], causes: [], outcomeCategory: "diplomatic", significance};
}

const events = [
  event("old", "2020-01-02", "minor"),
  event("same-a", "2020-01-03", "major", "shared narrative"),
  event("same-b", "2020-01-03", "transformative"),
];
const simulation = {eventLog: events} as unknown as SimulationStateV1;
const report: TurnReport = {
  turnId: "turn-1",
  period: "2020-01-01 — 2020-01-03",
  outcomes: ["outcome"],
  events: events.slice(1).map((item) => ({eventId: item.eventId, date: item.date, title: item.title, narrative: item.publicNarrative, countryIds: item.actorCountryIds, category: item.outcomeCategory, significance: item.significance, hasMapChanges: item.eventId === "same-a"})),
  reactions: ["shared narrative", "unique reaction"],
  mapChanges: ["border changed"],
  continuing: ["talks continue"],
  advisorSummary: "advisor summary",
};

describe("13-24 and 13-27 news projection", () => {
  it("keeps latest-first ordering stable while preserving committed event fields", () => {
    const model = createNewsProjection({simulation, report, selectedEventId: "same-b", acknowledgedEventIds: new Set(["same-a"])});
    expect(model.items.map((item) => item.eventId)).toEqual(["same-a", "same-b", "old"]);
    expect(model.selected?.eventId).toBe("same-b");
    expect(model.items[0]).toMatchObject({date: "2020-01-03", significance: "major", category: "diplomatic", relatedCountryIds: ["AAA", "BBB"], acknowledged: true, mapChangeAvailable: true});
    expect(filterNewsItems(model.items, "transformative").map((item) => item.eventId)).toEqual(["same-b"]);
  });

  it("retains every result section and removes exact narrative duplication from reactions", () => {
    const result = createNewsProjection({simulation, report, selectedEventId: null, acknowledgedEventIds: new Set()}).turnResult;
    expect(result).toMatchObject({outcomes: ["outcome"], eventIds: ["same-a", "same-b"], reactions: ["unique reaction"], mapChanges: ["border changed"], continuing: ["talks continue"], advisorSummary: "advisor summary"});
  });
});
