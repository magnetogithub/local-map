import type {SimulationPresentation as SimulationStateV1} from './runtime-view';
import type {NewsItemViewModel, NewsViewModel} from "./contracts";
import type {TurnReport} from "@/lib/simulation/client/turn-report";
import type {CountryId} from "@/lib/world/country-id";

export type NewsFilter = "all" | NewsItemViewModel["significance"];

export type ProjectedNewsItem = NewsItemViewModel & Readonly<{
  mapChangeAvailable: boolean;
}>;

export type TurnResultViewModel = Readonly<{
  turnId: string;
  period: string;
  outcomes: readonly string[];
  eventIds: readonly string[];
  reactions: readonly string[];
  mapChanges: readonly string[];
  continuing: readonly string[];
  advisorSummary: string;
}>;

export type GameNewsViewModel = Omit<NewsViewModel, "items"> & Readonly<{
  items: readonly ProjectedNewsItem[];
  selected: ProjectedNewsItem | null;
  turnResult: TurnResultViewModel | null;
}>;

export function filterNewsItems(items: readonly ProjectedNewsItem[], filter: NewsFilter) {
  return filter === "all" ? items : items.filter((item) => item.significance === filter);
}

export function createNewsProjection(input: Readonly<{
  simulation: SimulationStateV1;
  report: TurnReport | null;
  selectedEventId: string | null;
  acknowledgedEventIds: ReadonlySet<string>;
}>): GameNewsViewModel {
  const reportEvents = new Map(input.report?.events.map((event) => [event.eventId, event]) ?? []);
  const items = Object.freeze(input.simulation.eventLog
    .map((event, stableIndex) => ({event, stableIndex}))
    .sort((left, right) => right.event.date.localeCompare(left.event.date) || left.stableIndex - right.stableIndex)
    .map(({event}) => Object.freeze({
      eventId: event.eventId,
      date: event.date,
      title: event.title,
      narrative: event.publicNarrative,
      category: event.outcomeCategory,
      significance: event.significance,
      relatedCountryIds: Object.freeze(event.actorCountryIds.map((countryId) => countryId as CountryId)),
      acknowledged: input.acknowledgedEventIds.has(event.eventId),
      mapChangeAvailable: reportEvents.get(event.eventId)?.hasMapChanges ?? false,
    })));
  const selectedEventId = input.selectedEventId && items.some((item) => item.eventId === input.selectedEventId)
    ? input.selectedEventId
    : items[0]?.eventId ?? null;
  const eventNarratives = new Set(input.report?.events.map((event) => event.narrative) ?? []);
  const turnResult = input.report === null ? null : Object.freeze({
    turnId: input.report.turnId,
    period: input.report.period,
    outcomes: Object.freeze([...input.report.outcomes]),
    eventIds: Object.freeze(input.report.events.map((event) => event.eventId)),
    reactions: Object.freeze(input.report.reactions.filter((reaction) => !eventNarratives.has(reaction))),
    mapChanges: Object.freeze([...input.report.mapChanges]),
    continuing: Object.freeze([...input.report.continuing]),
    advisorSummary: input.report.advisorSummary,
  });
  return Object.freeze({
    dataAvailable: items.length > 0,
    unavailableReason: items.length > 0 ? null : "아직 기록된 국제 사건이 없습니다.",
    items,
    selectedEventId,
    selected: items.find((item) => item.eventId === selectedEventId) ?? null,
    turnResult,
  });
}
