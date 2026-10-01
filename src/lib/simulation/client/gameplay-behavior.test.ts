import {describe, expect, it} from "vitest";

import {checkpointWorldContentHash} from "../../planning/history-persistence-checkpoint";
import {createCommandUiDemoWorldState} from "../../planning/command-ui-runtime";
import {createInitialSimulationState} from "../initial-simulation-state";
import {queuePlayerAction} from "../queued-player-action";
import {createResolvedTurnPlan} from "../resolved-turn-plan";
import {createSimulationStateV1} from "../simulation-state";
import type {SubdivisionCatalog} from "../subdivision-catalog";
import {SIMULATION_CONTRACT_VERSION} from "../simulation-contract-primitives";

const catalog: SubdivisionCatalog = Object.freeze({listCountry: () => [], inspect: () => null, materialize: () => null});

function fakeProviderResolution(actionText: string, status: "failed" | "partially_succeeded") {
  const world = createCommandUiDemoWorldState();
  const initial = createInitialSimulationState(world, "AAA");
  const actionId = "action.behavior";
  const simulation = createSimulationStateV1({...initial, queuedActions: queuePlayerAction([], {actionId, playerCountryId: "AAA", submittedAtDate: initial.currentDate, text: actionText})}, world);
  const resolution = {
    contractVersion: SIMULATION_CONTRACT_VERSION,
    baseSimulationRevision: 0,
    baseWorldRevision: 0,
    period: {startDate: "2020-01-01", endDate: "2020-02-01"},
    playerActionOutcomes: [{outcomeId: "outcome.behavior", actionId, status, evidenceEventId: "event.behavior", summary: status === "failed" ? "권한과 지지가 없어 요구가 실행되지 않았습니다." : "교역 논의가 일부 진전됐습니다.", remainingConditions: []}],
    events: [{eventId: "event.behavior", date: "2020-01-15", title: "행동 검토", publicNarrative: "관련국이 제안을 검토하고 공식 입장을 발표했습니다.", actorCountryIds: ["AAA"], relatedFactIds: [], relatedSituationIds: [], causes: [{kind: "queued-action" as const, id: actionId}], outcomeCategory: "diplomatic" as const, significance: "minor" as const}],
    factMutations: [], situationMutations: [], scheduledConsequences: [], worldEffects: [],
    advisorSummary: "즉시 발생한 국경 변화는 없습니다.", unresolvedQuestions: [],
  };
  return {world, simulation, resolution};
}

describe("12-41 gameplay behavior with a deterministic fake provider", () => {
  it("treats an unauthorized 50-state split request as a failed in-world action, not direct editing", () => {
    const fixture = fakeProviderResolution("미국을 50개 국가로 분할한다", "failed");
    const before = checkpointWorldContentHash(fixture.world);
    const plan = createResolvedTurnPlan({turnId: "turn.unauthorized", ...fixture, subdivisionCatalog: catalog});
    expect(plan.resolution.playerActionOutcomes[0].status).toBe("failed");
    expect(plan.changeSummary.worldEffectCount).toBe(0);
    expect(checkpointWorldContentHash(plan.nextWorldState)).toBe(before);
  });

  it("allows uncertain trade progress without inventing a map effect or guaranteed success", () => {
    const fixture = fakeProviderResolution("상대국과 무역 협정을 추진한다", "partially_succeeded");
    const plan = createResolvedTurnPlan({turnId: "turn.trade", ...fixture, subdivisionCatalog: catalog});
    expect(plan.resolution.playerActionOutcomes[0].status).not.toBe("succeeded");
    expect(plan.resolution.worldEffects).toEqual([]);
    expect(plan.nextWorldState).toBe(fixture.world);
  });
});
