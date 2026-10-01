import {describe, expect, it} from "vitest";

import {createCommandUiDemoWorldState} from "../planning/command-ui-runtime";
import {createAtomicTurnRuntime} from "./atomic-turn-runtime";
import {createInitialSimulationState} from "./initial-simulation-state";
import {queuePlayerAction} from "./queued-player-action";
import {createResolvedTurnPlan} from "./resolved-turn-plan";
import {createSimulationStateV1} from "./simulation-state";
import {
  restoreGameRuntimeSave,
  serializeGameRuntimeSave,
} from "./simulation-persistence";
import type {SubdivisionCatalog} from "./subdivision-catalog";
import {SIMULATION_CONTRACT_VERSION} from "./simulation-contract-primitives";

const catalog: SubdivisionCatalog = Object.freeze({listCountry: () => [], inspect: () => null, materialize: () => null});

const runtimeWithQueuedAction = () => {
  const world = createCommandUiDemoWorldState();
  const initial = createInitialSimulationState(world, "AAA");
  const simulation = createSimulationStateV1({...initial, queuedActions: queuePlayerAction([], {
    actionId: "action.persist",
    playerCountryId: "AAA",
    submittedAtDate: initial.currentDate,
    text: "외교 회담을 제안한다.",
  })}, world);
  return {world, simulation, runtime: createAtomicTurnRuntime(simulation, world)};
};

describe("12-R4 GameRuntimeSaveV1", () => {
  it("restores queued actions and rejects a corrupt or mismatched pair as one unit", () => {
    const fixture = runtimeWithQueuedAction();
    const serialized = serializeGameRuntimeSave(fixture.runtime);
    const restored = restoreGameRuntimeSave(serialized, fixture.world, fixture.simulation);
    expect(restored.recoveredFromCorrupt).toBe(false);
    expect(restored.current.simulation.queuedActions[0].text).toBe("외교 회담을 제안한다.");
    expect(restored.current.revisions).toEqual({simulationRevision: 0, worldRevision: 0});
    expect(restoreGameRuntimeSave("{broken", fixture.world, fixture.simulation).current.world).toBe(fixture.world);
    const mismatched = JSON.parse(serialized) as {current: {revisions: {worldRevision: number}}};
    mismatched.current.revisions.worldRevision += 1;
    const fallback = restoreGameRuntimeSave(JSON.stringify(mismatched), fixture.world, fixture.simulation);
    expect(fallback.recoveredFromCorrupt).toBe(true);
    expect(fallback.current.world).toBe(fixture.world);
    expect(fallback.current.simulation).toBe(fixture.simulation);
  });

  it("restores committed date, events, facts, situations, consequences, world, and bounded history", () => {
    const fixture = runtimeWithQueuedAction();
    const resolution = {
      contractVersion: SIMULATION_CONTRACT_VERSION,
      baseSimulationRevision: 0,
      baseWorldRevision: 0,
      period: {startDate: "2020-01-01", endDate: "2020-02-01"},
      playerActionOutcomes: [{outcomeId: "outcome.persist", actionId: "action.persist", status: "delayed", evidenceEventId: "event.persist", summary: "회담이 계속됩니다.", remainingConditions: []}],
      events: [{eventId: "event.persist", date: "2020-01-20", title: "외교 회담", publicNarrative: "대표단이 후속 회담을 열었습니다.", actorCountryIds: ["AAA"], relatedFactIds: ["fact.persist"], relatedSituationIds: ["situation.persist"], causes: [{kind: "queued-action", id: "action.persist"}], outcomeCategory: "diplomatic", significance: "minor"}],
      factMutations: [{mutationId: "mutation.fact.persist", operation: "upsert", causedByEventId: "event.persist", factId: null, fact: {factId: "fact.persist", kind: "diplomatic-relation", actorCountryIds: ["AAA"], publicSummary: "회담이 진행 중입니다.", startDate: "2020-01-20", status: "active", sourceEventId: "event.persist"}}],
      situationMutations: [{mutationId: "mutation.situation.persist", operation: "upsert", causedByEventId: "event.persist", situationId: null, situation: {situationId: "situation.persist", type: "diplomatic-process", participantCountryIds: ["AAA"], stage: "후속 회담", stakes: "외교 관계", startedByEventId: "event.persist", lastUpdatedByEventId: "event.persist", unresolvedQuestion: "합의할 것인가?", status: "active"}}],
      scheduledConsequences: [{consequenceId: "consequence.persist", earliestDate: "2020-03-01", deadlineDate: null, actorCountryIds: ["AAA"], situationId: "situation.persist", triggerSummary: "후속 회담을 검토합니다.", sourceEventId: "event.persist", status: "scheduled"}],
      worldEffects: [], advisorSummary: "회담이 이어집니다.", unresolvedQuestions: [],
    };
    fixture.runtime.commit(createResolvedTurnPlan({turnId: "turn.persist", simulation: fixture.simulation, world: fixture.world, resolution, subdivisionCatalog: catalog}));
    const restored = restoreGameRuntimeSave(serializeGameRuntimeSave(fixture.runtime), fixture.world, fixture.simulation);
    expect(restored.current.simulation.currentDate).toBe("2020-02-01");
    expect(restored.current.simulation.eventLog).toHaveLength(1);
    expect(restored.current.simulation.factsById["fact.persist"]).toBeDefined();
    expect(restored.current.simulation.situationsById["situation.persist"]).toBeDefined();
    expect(restored.current.simulation.scheduledConsequences).toHaveLength(1);
    expect(restored.current.world).toEqual(fixture.world);
    expect(restored.turnHistory).toHaveLength(1);
    expect(restored.undo).not.toBeNull();
  });
});
