import {describe, expect, it} from "vitest";

import type {TurnReport} from "@/lib/simulation/client/turn-report";
import {initialMajorEventQueueState, majorEventQueueReducer} from "./major-event-queue";

const report: TurnReport = {
  turnId: "turn-2",
  period: "period",
  outcomes: [],
  events: [
    {eventId: "minor", date: "2020-01-01", title: "minor", narrative: "minor", countryIds: ["AAA"], category: "domestic", significance: "minor", hasMapChanges: false},
    {eventId: "late", date: "2020-01-03", title: "late", narrative: "late", countryIds: ["AAA"], category: "military", significance: "transformative", hasMapChanges: true},
    {eventId: "early-a", date: "2020-01-02", title: "early-a", narrative: "early-a", countryIds: ["AAA"], category: "diplomatic", significance: "major", hasMapChanges: false},
    {eventId: "early-b", date: "2020-01-02", title: "early-b", narrative: "early-b", countryIds: ["BBB"], category: "economic", significance: "major", hasMapChanges: false},
    {eventId: "notable", date: "2020-01-04", title: "notable", narrative: "notable", countryIds: ["AAA"], category: "other", significance: "notable", hasMapChanges: false},
  ],
  reactions: [], mapChanges: [], continuing: [], advisorSummary: "summary",
};

describe("13-25 major event queue", () => {
  it("queues only blocking severities by date and stable source order", () => {
    const state = majorEventQueueReducer(initialMajorEventQueueState, {type: "enqueue-report", report});
    expect(state.pending.map((entry) => entry.event.eventId)).toEqual(["early-a", "early-b", "late"]);
    expect(state.pending.map(({ordinal, total}) => [ordinal, total])).toEqual([[1, 3], [2, 3], [3, 3]]);
  });

  it("enqueues each report event once and acknowledges each event once", () => {
    const queued = majorEventQueueReducer(initialMajorEventQueueState, {type: "enqueue-report", report});
    expect(majorEventQueueReducer(queued, {type: "enqueue-report", report})).toBe(queued);
    const acknowledged = majorEventQueueReducer(queued, {type: "acknowledge-current"});
    expect(acknowledged.pending.map((entry) => entry.event.eventId)).toEqual(["early-b", "late"]);
    expect([...acknowledged.acknowledgedEventIds]).toEqual(["early-a"]);
    expect(majorEventQueueReducer(acknowledged, {type: "enqueue-report", report}).pending.map((entry) => entry.event.eventId)).toEqual(["early-b", "late"]);
  });

  it("does not block on minor or notable reports", () => {
    const nonBlocking = {...report, turnId: "turn-3", events: report.events.filter((entry) => entry.significance === "minor" || entry.significance === "notable")};
    expect(majorEventQueueReducer(initialMajorEventQueueState, {type: "enqueue-report", report: nonBlocking}).pending).toHaveLength(0);
  });
});
