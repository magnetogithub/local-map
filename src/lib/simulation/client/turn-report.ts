import type {WorldStateV2} from "../../world/world-state-v2";
import type {ResolvedTurnPlan} from "../resolved-turn-plan";
import type {SimulationEventV1} from "../simulation-event";

export type TurnReport = Readonly<{
  turnId: string;
  period: string;
  outcomes: readonly string[];
  events: readonly Readonly<{
    eventId: string;
    date: string;
    title: string;
    narrative: string;
    countryIds: readonly string[];
    category: SimulationEventV1["outcomeCategory"];
    significance: SimulationEventV1["significance"];
    hasMapChanges: boolean;
  }>[];
  reactions: readonly string[];
  mapChanges: readonly string[];
  continuing: readonly string[];
  advisorSummary: string;
}>;

const countryName = (world: WorldStateV2, id: string) => world.countriesById[id]?.names.shortKo ?? "변경된 국가";

export function createCommittedTurnReport(plan: ResolvedTurnPlan): TurnReport {
  const {resolution} = plan;
  const status = {succeeded: "성공", partially_succeeded: "부분 성공", failed: "실패", delayed: "지연", superseded: "대체됨"} as const;
  const mapChanges = resolution.worldEffects.map((effect) => {
    if (effect.type === "countries.unified") return `${effect.countryIds.map((id) => countryName(plan.baseWorldState, id)).join("·")}의 통합이 지도에 반영되었습니다.`;
    if (effect.type === "territories.transferred") return `${countryName(plan.baseWorldState, effect.fromCountryId)}에서 ${countryName(plan.baseWorldState, effect.toCountryId)}로 영토가 이전되었습니다.`;
    if (effect.type === "country.established") return "새 국가의 성립이 지도에 반영되었습니다.";
    if (effect.type === "country.dissolved") return `${countryName(plan.baseWorldState, effect.countryId)}의 해체가 지도에 반영되었습니다.`;
    if (effect.type === "country.renamed") return `${countryName(plan.baseWorldState, effect.countryId)}의 국호 변경이 반영되었습니다.`;
    return `${countryName(plan.baseWorldState, effect.sourceCountryId)}의 행정 구역 분할이 지도에 반영되었습니다.`;
  });
  return Object.freeze({
    turnId: plan.turnId,
    period: `${resolution.period.startDate} – ${resolution.period.endDate}`,
    outcomes: Object.freeze(resolution.playerActionOutcomes.map((outcome) => `${status[outcome.status]} — ${outcome.summary}`)),
    events: Object.freeze(resolution.events.map((event) => Object.freeze({
      eventId: event.eventId,
      date: event.date,
      title: event.title,
      narrative: event.publicNarrative,
      countryIds: Object.freeze([...event.actorCountryIds]),
      category: event.outcomeCategory,
      significance: event.significance,
      hasMapChanges: resolution.worldEffects.some((effect) => effect.causedByEventId === event.eventId),
    }))),
    reactions: Object.freeze(resolution.events.filter((event) => event.actorCountryIds.some((id) => id !== plan.baseSimulationState.playerCountryId)).map((event) => event.publicNarrative)),
    mapChanges: Object.freeze(mapChanges.length ? mapChanges : ["즉시 발생한 지도 변화가 없습니다."]),
    continuing: Object.freeze([...resolution.unresolvedQuestions]),
    advisorSummary: resolution.advisorSummary,
  });
}
