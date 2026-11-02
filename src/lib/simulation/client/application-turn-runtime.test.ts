import {describe, expect, it} from "vitest";

import {createCommandUiDemoWorldState} from "../../planning/command-ui-runtime";
import {createWorldStateStore, type WorldStateStoreController} from "../../../stores/world-state-store";
import {createInitialSimulationState} from "../initial-simulation-state";
import {queuePlayerAction} from "../queued-player-action";
import {createResolvedTurnPlan} from "../resolved-turn-plan";
import {createSimulationStateV1} from "../simulation-state";
import type {SubdivisionCatalog} from "../subdivision-catalog";
import {SIMULATION_CONTRACT_VERSION} from "../simulation-contract-primitives";
import {createApplicationTurnRuntime} from "./application-turn-runtime";
import {restoreGameRuntimeSave, serializeGameRuntimeSave} from "../simulation-persistence";

const catalog: SubdivisionCatalog = Object.freeze({listCountry: () => [], inspect: () => null, materialize: () => null});

const fixture = (withWorldEffect = false) => {
  const world = createCommandUiDemoWorldState();
  const seed = createInitialSimulationState(world, "AAA");
  const simulation = createSimulationStateV1({...seed, queuedActions: queuePlayerAction([], {actionId: "action.atomic", playerCountryId: "AAA", submittedAtDate: seed.currentDate, text: "회담을 제안한다."})}, world);
  const resolution = {
    contractVersion: SIMULATION_CONTRACT_VERSION,
    baseSimulationRevision: 0, baseWorldRevision: 0,
    period: {startDate: "2020-01-01", endDate: "2020-02-01"},
    playerActionOutcomes: [{outcomeId: "outcome.atomic", actionId: "action.atomic", status: "delayed", evidenceEventId: "event.atomic", summary: "협상이 이어집니다.", remainingConditions: []}],
    events: [{eventId: "event.atomic", date: "2020-01-20", title: "외교 회담", publicNarrative: "대표단이 회담을 열었습니다.", actorCountryIds: ["AAA"], relatedFactIds: [], relatedSituationIds: [], causes: [{kind: "queued-action", id: "action.atomic"}], outcomeCategory: "diplomatic", significance: "minor"}],
    factMutations: [], situationMutations: [], scheduledConsequences: [], worldEffects: withWorldEffect ? [{effectId: "effect.atomic-rename", type: "country.renamed", causedByEventId: "event.atomic", countryId: "AAA", displayName: "Renamed AAA"}] : [], advisorSummary: "국경 변화는 없습니다.", unresolvedQuestions: [],
  };
  const plan = createResolvedTurnPlan({turnId: "turn.atomic", simulation, world, resolution, subdivisionCatalog: catalog});
  return {world, simulation, plan};
};

describe("12-R5 application-level atomic turn coordinator", () => {
  it("preflight failure leaves simulation, world, history, and event log identities unchanged", () => {
    const value = fixture();
    const base = createWorldStateStore(value.world);
    const failing = Object.freeze({...base, preflightSimulationSnapshot() { throw new Error("injected preflight"); }}) as WorldStateStoreController;
    const runtime = createApplicationTurnRuntime(value.simulation, value.world, failing);
    const before = runtime.getSnapshot();
    expect(() => runtime.commit(value.plan)).toThrow(/injected preflight/);
    expect(runtime.getSnapshot()).toBe(before);
    expect(base.getState()).toBe(value.world);
    expect(runtime.getHistory()).toMatchObject({pointer: 0, entries: []});
    expect(runtime.getSnapshot().simulation.eventLog).toBe(value.simulation.eventLog);
  });

  it("isolates a failing world subscriber, continues later subscribers, and commits one canonical pair", () => {
    const value = fixture(true);
    const worldController = createWorldStateStore(value.world);
    const runtime = createApplicationTurnRuntime(value.simulation, value.world, worldController);
    const observed: number[] = [];
    worldController.subscribeDomain(() => { throw new Error("injected world subscriber"); });
    worldController.subscribeDomain((notification) => observed.push(notification.nextState.revision));
    const committed = runtime.commit(value.plan);
    expect(runtime.getSnapshot()).toBe(committed);
    expect(worldController.getState()).toBe(committed.world);
    expect(runtime.getHistory().pointer).toBe(1);
    expect(observed).toEqual([committed.world.revision]);
    expect(worldController.getSubscriberFailures()).toEqual([
      expect.objectContaining({channel: "domain", message: "injected world subscriber"}),
    ]);
  });

  it("isolates an application subscriber failure and delivers the committed revision pair to later observers", () => {
    const value = fixture(true);
    const worldController = createWorldStateStore(value.world);
    const runtime = createApplicationTurnRuntime(value.simulation, value.world, worldController);
    const observed: unknown[] = [];
    runtime.subscribe(() => { throw new Error("injected application subscriber"); });
    runtime.subscribe((notification) => observed.push(notification.next.revisions));
    const committed = runtime.commit(value.plan);
    expect(observed).toEqual([committed.revisions]);
    expect(runtime.getHistory().pointer).toBe(1);
    expect(runtime.getSnapshot().simulation.eventLog).toBe(committed.simulation.eventLog);
    expect(runtime.getSubscriberFailures()).toEqual([
      expect.objectContaining({kind: "commit", message: "injected application subscriber"}),
    ]);
  });

  it("rolls back both sides and history when world publication fails during commit, undo, or redo", () => {
    const value = fixture(true);
    const base = createWorldStateStore(value.world);
    let failKind: "commit" | "undo" | "redo" | null = "commit";
    const failing = Object.freeze({...base, publishSimulationSnapshot(next: typeof value.world, turnId: string, kind: "commit" | "undo" | "redo") {
      if (kind === failKind) throw new Error(`injected ${kind} publish`);
      base.publishSimulationSnapshot(next, turnId, kind);
    }}) as WorldStateStoreController;
    const runtime = createApplicationTurnRuntime(value.simulation, value.world, failing);
    const beforeCommit = runtime.getSnapshot();
    expect(() => runtime.commit(value.plan)).toThrow(/injected commit publish/);
    expect(runtime.getSnapshot()).toBe(beforeCommit);
    expect(base.getState()).toBe(value.world);
    expect(runtime.getHistory().pointer).toBe(0);
    expect(runtime.getSnapshot().simulation.eventLog).toBe(value.simulation.eventLog);

    failKind = null;
    const committed = runtime.commit(value.plan);
    failKind = "undo";
    expect(() => runtime.undo()).toThrow(/injected undo publish/);
    expect(runtime.getSnapshot()).toBe(committed);
    expect(base.getState()).toBe(committed.world);
    expect(runtime.getHistory().pointer).toBe(1);

    failKind = null;
    const undone = runtime.undo();
    failKind = "redo";
    expect(() => runtime.redo()).toThrow(/injected redo publish/);
    expect(runtime.getSnapshot()).toBe(undone);
    expect(base.getState()).toBe(undone.world);
    expect(runtime.getHistory().pointer).toBe(0);
  });

  it("keeps a completed canonical pair when a later persistence operation fails", () => {
    const value = fixture();
    const worldController = createWorldStateStore(value.world);
    const runtime = createApplicationTurnRuntime(value.simulation, value.world, worldController);
    const committed = runtime.commit(value.plan);
    expect(() => { throw new Error("SIMULATION_STORAGE_WRITE_FAILED"); }).toThrow();
    expect(runtime.getSnapshot()).toBe(committed);
    expect(worldController.getState()).toBe(committed.world);
  });

  it("restores reload-safe undo and redo pairs and persists the moved pointer", () => {
    const value = fixture();
    const firstController = createWorldStateStore(value.world);
    const first = createApplicationTurnRuntime(value.simulation, value.world, firstController);
    first.commit(value.plan);
    const restored = restoreGameRuntimeSave(
      serializeGameRuntimeSave(first),
      value.world,
      value.simulation,
    );
    expect(restored.recoveredFromCorrupt).toBe(false);

    const secondController = createWorldStateStore(restored.current.world);
    const second = createApplicationTurnRuntime(
      restored.current.simulation,
      restored.current.world,
      secondController,
      {summaries: restored.turnHistory, pointer: restored.historyPointer, undo: restored.undo, redo: restored.redo},
    );
    expect(second.canUndo()).toBe(true);
    const undone = second.undo();
    expect(undone.simulation.currentDate).toBe(value.simulation.currentDate);
    expect(second.canRedo()).toBe(true);

    const afterUndoReload = restoreGameRuntimeSave(
      serializeGameRuntimeSave(second),
      value.world,
      value.simulation,
    );
    const thirdController = createWorldStateStore(afterUndoReload.current.world);
    const third = createApplicationTurnRuntime(
      afterUndoReload.current.simulation,
      afterUndoReload.current.world,
      thirdController,
      {summaries: afterUndoReload.turnHistory, pointer: afterUndoReload.historyPointer, undo: afterUndoReload.undo, redo: afterUndoReload.redo},
    );
    expect(third.canRedo()).toBe(true);
    expect(third.redo().simulation.currentDate).toBe(value.plan.nextSimulationState.currentDate);
    expect(third.canRedo()).toBe(false);
  });

  it("keeps a persisted restore pair and pointer unchanged when restored undo publication fails", () => {
    const value = fixture(true);
    const firstController = createWorldStateStore(value.world);
    const first = createApplicationTurnRuntime(value.simulation, value.world, firstController);
    first.commit(value.plan);
    const restored = restoreGameRuntimeSave(serializeGameRuntimeSave(first), value.world, value.simulation);
    const base = createWorldStateStore(restored.current.world);
    const failing = Object.freeze({...base, publishSimulationSnapshot() { throw new Error("injected restored undo publish"); }}) as WorldStateStoreController;
    const runtime = createApplicationTurnRuntime(
      restored.current.simulation,
      restored.current.world,
      failing,
      {summaries: restored.turnHistory, pointer: restored.historyPointer, undo: restored.undo, redo: restored.redo},
    );
    const before = runtime.getSnapshot();
    const persistenceBefore = runtime.getPersistenceState();
    expect(() => runtime.undo()).toThrow(/injected restored undo publish/);
    expect(runtime.getSnapshot()).toBe(before);
    expect(base.getState()).toBe(before.world);
    expect(runtime.getPersistenceState()).toEqual(persistenceBefore);
    expect(runtime.canUndo()).toBe(true);
    expect(runtime.canRedo()).toBe(false);
  });
});
