import {describe, expect, it} from "vitest";

import {createCatalogRuntime, type CatalogRuntimePair} from "./catalog-runtime";
import {createCatalogTurnPlan} from "./catalog-turn-plan";
import {createCommittedTurnReport} from "./client/turn-report";
import {
  activePlayerActionCount,
  assertPlayerActionsCanAdvance,
  cancelQueuedPlayerAction,
  isActivePlayerAction,
  MAX_LEGACY_ACTIVE_PLAYER_ACTIONS,
  MAX_RECENT_TERMINAL_PLAYER_ACTIONS,
  MAX_RETAINED_TERMINAL_PLAYER_ACTIONS,
  queuePlayerAction,
  queuedPlayerActionsSchema,
  retainPlayerActions,
  type QueuedPlayerActionV1,
} from "./queued-player-action";
import {
  MAX_ACTIVE_PLAYER_ACTIONS,
  MAX_SIMULATION_EVENT_CAUSES,
  MAX_SIMULATION_EVENTS,
} from "./simulation-contract-primitives";
import type {SimulationEventV1} from "./simulation-event";
import {createSimulationStateV2, simulationStateV2ContentHash} from "./simulation-state-v2";
import {createWorldGeometryCatalogContract, readCatalogTerritoryId} from "../world/world-geometry-catalog-ref";
import {createWorldStateV3} from "../world/world-state-v3";

const action = (
  actionId: string,
  status: QueuedPlayerActionV1["status"] = "queued",
): QueuedPlayerActionV1 => Object.freeze({
  actionId,
  actorCountryId: "AAA",
  submittedAtDate: "2020-01-01",
  text: `행동 ${actionId}의 원문과 요약`,
  visibility: "public",
  status,
});

const queueInput = (actionId: string, submittedAtDate = "2020-01-01") => ({
  actionId,
  playerCountryId: "AAA",
  submittedAtDate,
  text: `새 행동 ${actionId}`,
});

const event = (eventId: string, date = "2020-01-01"): SimulationEventV1 => ({
  eventId,
  date,
  title: "행동 기록",
  publicNarrative: "플레이 국가의 행동과 결과를 보존합니다.",
  actorCountryIds: ["AAA"],
  relatedFactIds: [],
  relatedSituationIds: [],
  causes: [],
  outcomeCategory: "domestic",
  significance: "notable",
});

/** Three validated cells exercise immutable production V3/V2 state without world assets. */
function fixture(actions: readonly QueuedPlayerActionV1[] = [], eventLog: readonly SimulationEventV1[] = []) {
  const countryIds = ["AAA", "BBB", "CCC"];
  const ids = countryIds.map((_, index) =>
    readCatalogTerritoryId(`territory:catalog:${(index + 1).toString(16).padStart(64, "0")}`));
  const catalog = createWorldGeometryCatalogContract({
    ref: {catalogVersion: "action-policy-v1", geometryRoot: "1".repeat(64), topologyRoot: "2".repeat(64),
      renderArtifactRoot: "3".repeat(64), manifestPath: "/data/territory-catalog/action-policy-v1/manifest.json"},
    territoryOrder: ids,
    territoriesById: Object.fromEntries(ids.map((id, index) => [id, {id, sourceCountryId: countryIds[index]}])),
  });
  const world = createWorldStateV3({
    schemaVersion: 3, seedVersion: "action-policy-seed", policyVersion: "action-policy", revision: 0,
    countryOrder: countryIds,
    countriesById: Object.fromEntries(countryIds.map((id, index) => [id, {
      id, names: {shortKo: id, officialKo: id, mapKo: id, english: id, searchAliases: []},
      politicalStatus: "sovereign", presentationOverride: null, moduleVersions: {core: 1, names: 1},
      mapColor: ["#334455", "#556677", "#778899"][index],
    }])),
    retiredCountryIds: new Set(), catalogRef: catalog.ref, territoryOrder: ids,
    territoriesById: Object.fromEntries(ids.map((id, index) => [id, {
      id, sourceCountryId: countryIds[index], ownerCountryId: countryIds[index], controllerCountryId: countryIds[index],
    }])),
  }, catalog);
  const simulation = createSimulationStateV2({
    schemaVersion: 2, revision: 0, currentDate: "2020-01-01", turnNumber: 0, playerCountryId: "AAA",
    queuedActions: actions, factsById: {}, factOrder: [], situationsById: {}, situationOrder: [],
    scheduledConsequences: [], eventLog, history: {lastCommittedTurnId: null, committedTurnCount: 0},
    territorialControlAuthoritiesById: {}, territorialControlAuthorityOrder: [],
    countryPresentationAuthoritiesById: {}, countryPresentationAuthorityOrder: [],
  }, world);
  const seed: CatalogRuntimePair = {world, simulation, revisions: {worldRevision: 0, simulationRevision: 0}};
  return {catalog, seed, runtime: createCatalogRuntime(seed, catalog)};
}

function turnPlan(f: ReturnType<typeof fixture>) {
  const pair = f.runtime.getSnapshot(), active = pair.simulation.queuedActions.filter(isActivePlayerAction);
  return createCatalogTurnPlan({
    ...pair, catalog: f.catalog, turnId: "turn.action-policy",
    resolution: {
      contractVersion: "turn-resolution.v1", baseSimulationRevision: pair.simulation.revision,
      baseWorldRevision: pair.world.revision, period: {startDate: pair.simulation.currentDate, endDate: "2020-01-02"},
      playerActionOutcomes: active.map(a => ({outcomeId: `outcome.${a.actionId}`, actionId: a.actionId,
        status: "succeeded", evidenceEventId: "event.resolved", summary: `처리 완료 ${a.actionId}`, remainingConditions: []})),
      events: [{...event("event.resolved", "2020-01-02"),
        causes: active.slice(0, MAX_SIMULATION_EVENT_CAUSES).map(a => ({kind: "queued-action", id: a.actionId}))}],
      factMutations: [], situationMutations: [], scheduledConsequences: [], worldEffects: [],
      advisorSummary: "등록한 행동을 처리했습니다.", unresolvedQuestions: [],
    },
  });
}

describe("F03 active player action policy", () => {
  it("accepts action 32, rejects action 33 without changing state, and recovers a slot after cancellation", () => {
    const f = fixture(Array.from({length: MAX_ACTIVE_PLAYER_ACTIONS - 1}, (_, i) => action(`action.${i}`)));
    f.runtime.replacePendingActions(queuePlayerAction(f.runtime.getSnapshot().simulation.queuedActions, queueInput("action.31")));
    const full = f.runtime.getSnapshot();
    expect(activePlayerActionCount(full.simulation.queuedActions)).toBe(32);
    expect(() => assertPlayerActionsCanAdvance(full.simulation.queuedActions)).not.toThrow();
    expect(() => f.runtime.replacePendingActions(queuePlayerAction(full.simulation.queuedActions, queueInput("action.32"))))
      .toThrowError(expect.objectContaining({code: "ACTION_QUEUE_LIMIT_REACHED"}));
    expect(f.runtime.getSnapshot()).toBe(full);

    f.runtime.replacePendingActions(cancelQueuedPlayerAction(full.simulation.queuedActions, "action.0", "AAA"));
    expect(activePlayerActionCount(f.runtime.getSnapshot().simulation.queuedActions)).toBe(31);
    f.runtime.replacePendingActions(queuePlayerAction(f.runtime.getSnapshot().simulation.queuedActions, queueInput("action.replacement")));
    expect(activePlayerActionCount(f.runtime.getSnapshot().simulation.queuedActions)).toBe(32);
    expect(full.simulation.queuedActions.find(a => a.actionId === "action.0")?.status).toBe("queued");
  });

  it.each([33, MAX_LEGACY_ACTIVE_PLAYER_ACTIONS])("loads %i legacy active actions, cancels down to 32, then commits all 32 outcomes", count => {
    const f = fixture(Array.from({length: count}, (_, i) => action(`legacy.${i}`, "resolving")));
    const original = f.runtime.getSnapshot(), originalHash = simulationStateV2ContentHash(original.simulation);
    expect(activePlayerActionCount(original.simulation.queuedActions)).toBe(count);
    expect(() => assertPlayerActionsCanAdvance(original.simulation.queuedActions))
      .toThrowError(expect.objectContaining({code: "ACTION_QUEUE_LIMIT_REACHED"}));
    expect(() => queuePlayerAction(original.simulation.queuedActions, queueInput("action.new")))
      .toThrowError(expect.objectContaining({code: "ACTION_QUEUE_LIMIT_REACHED"}));
    for (let i = 0; i < count - MAX_ACTIVE_PLAYER_ACTIONS; i++) {
      const current = f.runtime.getSnapshot();
      f.runtime.replacePendingActions(cancelQueuedPlayerAction(current.simulation.queuedActions, `legacy.${i}`, "AAA"));
    }
    const recovered = f.runtime.getSnapshot();
    expect(activePlayerActionCount(recovered.simulation.queuedActions)).toBe(32);
    expect(() => assertPlayerActionsCanAdvance(recovered.simulation.queuedActions)).not.toThrow();
    expect(() => cancelQueuedPlayerAction(recovered.simulation.queuedActions, `legacy.${count - 1}`, "AAA"))
      .toThrowError(expect.objectContaining({code: "ACTION_NOT_CANCELLABLE"}));
    const plan = turnPlan(f), next = f.runtime.commit(plan);
    expect(next.simulation.currentDate).toBe("2020-01-02");
    expect(plan.resolution.playerActionOutcomes).toHaveLength(32);
    expect(activePlayerActionCount(next.simulation.queuedActions)).toBe(0);
    f.runtime.replacePendingActions(queuePlayerAction(next.simulation.queuedActions, queueInput("action.after-legacy", next.simulation.currentDate)));
    expect(activePlayerActionCount(f.runtime.getSnapshot().simulation.queuedActions)).toBe(1);
    expect(simulationStateV2ContentHash(original.simulation)).toBe(originalHash);
    expect(original.simulation.queuedActions.every(a => a.status === "resolving")).toBe(true);
  });

  it("still rejects foreign cancellation and stored active counts beyond the legacy compatibility bound", () => {
    const legacy = Array.from({length: 33}, (_, i) => action(`legacy.${i}`, "resolving"));
    expect(() => cancelQueuedPlayerAction(legacy, "legacy.0", "BBB"))
      .toThrowError(expect.objectContaining({code: "INVALID_ACTION"}));
    expect(() => queuedPlayerActionsSchema.parse(Array.from({length: MAX_LEGACY_ACTIVE_PLAYER_ACTIONS + 1}, (_, i) => action(`legacy.${i}`))))
      .toThrow();
  });
});

describe("F04 bounded terminal player action retention", () => {
  it("preserves more than 128 referenced terminal records independently of the recent window", () => {
    const pinned = Array.from({length: 129}, (_, i) => action(`pinned.${i}`, 'resolved'));
    const recent = Array.from({length: 129}, (_, i) => action(`recent.${i}`, 'cancelled'));
    const events = Array.from({length: Math.ceil(pinned.length / MAX_SIMULATION_EVENT_CAUSES)}, (_, i) => ({
      ...event(`event.pinned.${i}`), causes: pinned.slice(i * MAX_SIMULATION_EVENT_CAUSES, (i + 1) * MAX_SIMULATION_EVENT_CAUSES)
        .map(a => ({kind: 'queued-action' as const, id: a.actionId})),
    }));
    const f = fixture([...pinned, ...recent], events);
    f.runtime.replacePendingActions(queuePlayerAction(f.runtime.getSnapshot().simulation.queuedActions, queueInput('action.new')));
    const retained = f.runtime.getSnapshot().simulation.queuedActions;
    expect(retained.filter(a => a.actionId.startsWith('pinned.'))).toEqual(pinned);
    expect(retained.filter(a => a.actionId.startsWith('recent.'))).toHaveLength(128);
    expect(retained.find(a => a.actionId === 'recent.0')).toBeUndefined();
    expect(activePlayerActionCount(retained)).toBe(1);
  });

  it("allows 130 registration/cancellation cycles, retains only the recent unreferenced terminal window, and permits another registration", () => {
    const f = fixture(), original = f.runtime.getSnapshot();
    for (let i = 0; i < 130; i++) {
      const id = `cycle.${i}`;
      f.runtime.replacePendingActions(queuePlayerAction(f.runtime.getSnapshot().simulation.queuedActions, queueInput(id)));
      f.runtime.replacePendingActions(cancelQueuedPlayerAction(f.runtime.getSnapshot().simulation.queuedActions, id, "AAA"));
    }
    const completed = f.runtime.getSnapshot();
    expect(activePlayerActionCount(completed.simulation.queuedActions)).toBe(0);
    expect(completed.simulation.queuedActions).toHaveLength(MAX_RECENT_TERMINAL_PLAYER_ACTIONS);
    expect(completed.simulation.queuedActions.some(a => a.actionId === "cycle.0")).toBe(false);
    expect(completed.simulation.queuedActions.at(-1)).toMatchObject({actionId: "cycle.129", actorCountryId: "AAA", status: "cancelled"});
    f.runtime.replacePendingActions(queuePlayerAction(completed.simulation.queuedActions, queueInput("cycle.next")));
    expect(activePlayerActionCount(f.runtime.getSnapshot().simulation.queuedActions)).toBe(1);
    expect(original.simulation.queuedActions).toEqual([]);
  });

  it("pins event causes and queued-action lifecycle references in addition to the recent terminal window", () => {
    const terminal = Array.from({length: MAX_RECENT_TERMINAL_PLAYER_ACTIONS + 4}, (_, i) =>
      action(`terminal.${i}`, i % 2 ? "cancelled" : "resolved"));
    const active = [action("active.queued"), action("active.resolving", "resolving")];
    const events: SimulationEventV1[] = [
      {...event("event.causes"), causes: [
        {kind: "queued-action", id: terminal[0].actionId}, {kind: "queued-action", id: terminal[1].actionId},
      ]},
      {...event("event.lifecycle"), referenceLifecycle: {referenceId: terminal[2].actionId, kind: "queued-action",
        operation: "cancelled", reason: "retired-actor"}},
    ];
    const before = [...terminal, ...active], serialized = JSON.stringify(before);
    const retained = retainPlayerActions(before, events);
    expect(retained.filter(isActivePlayerAction)).toEqual(active);
    expect(retained.filter(a => !isActivePlayerAction(a))).toHaveLength(MAX_RECENT_TERMINAL_PLAYER_ACTIONS + 3);
    for (const pinned of terminal.slice(0, 3)) expect(retained).toContainEqual(pinned);
    expect(retained.some(a => a.actionId === terminal[3].actionId)).toBe(false);
    expect(retained.at(-1)).toEqual(active[1]);
    expect(JSON.stringify(before)).toBe(serialized);
    expect(MAX_RETAINED_TERMINAL_PLAYER_ACTIONS)
      .toBe(MAX_SIMULATION_EVENTS * (MAX_SIMULATION_EVENT_CAUSES + 1) + MAX_RECENT_TERMINAL_PLAYER_ACTIONS);
    expect(retained.length).toBeLessThanOrEqual(MAX_RETAINED_TERMINAL_PLAYER_ACTIONS + MAX_LEGACY_ACTIVE_PLAYER_ACTIONS);
  });

  it("preserves old mixed snapshots, history plans, event references and reports through commit, undo, fresh registration, redo and restart", () => {
    const terminal = Array.from({length: 127}, (_, i) => action(`old.${i}`, "cancelled"));
    const oldEvent = {...event("event.old"), causes: [{kind: "queued-action" as const, id: terminal[0].actionId}]};
    const f = fixture([...terminal, action("action.commit")], [oldEvent]);
    const before = f.runtime.getSnapshot(), beforeHash = simulationStateV2ContentHash(before.simulation);
    const plan = turnPlan(f), report = createCommittedTurnReport(plan), committed = f.runtime.commit(plan);
    const entry = f.runtime.getHistory().entries[0];
    expect(entry.beforeSimulation).toBe(before.simulation);
    expect(entry.plan).toBe(plan);
    expect(entry.plan.resolution.playerActionOutcomes[0].actionId).toBe("action.commit");
    expect(report.outcomes).toEqual(["성공 — 처리 완료 action.commit"]);
    expect(report.events[0].eventId).toBe("event.resolved");
    expect(committed.simulation.queuedActions.find(a => a.actionId === "action.commit")?.status).toBe("resolved");
    for (const e of committed.simulation.eventLog) for (const cause of e.causes) {
      if (cause.kind === "queued-action") expect(committed.simulation.queuedActions.some(a => a.actionId === cause.id)).toBe(true);
    }

    const restored = f.runtime.undo();
    expect(restored.simulation.queuedActions).toEqual(before.simulation.queuedActions);
    f.runtime.replacePendingActions(queuePlayerAction(restored.simulation.queuedActions, queueInput("action.after-undo")));
    expect(activePlayerActionCount(f.runtime.getSnapshot().simulation.queuedActions)).toBe(2);
    expect(f.runtime.canRedo()).toBe(true);
    const redone = f.runtime.redo();
    expect(redone.simulation.currentDate).toBe("2020-01-02");
    expect(redone.simulation.queuedActions).toEqual(committed.simulation.queuedActions);
    expect(redone.simulation.eventLog).toEqual(committed.simulation.eventLog);
    expect(report.outcomes).toEqual(["성공 — 처리 완료 action.commit"]);
    const restarted = f.runtime.restart();
    expect(restarted.simulation).toBe(f.seed.simulation);
    expect(restarted.simulation.queuedActions).toEqual(before.simulation.queuedActions);
    expect(f.runtime.canUndo()).toBe(false);
    expect(simulationStateV2ContentHash(before.simulation)).toBe(beforeHash);
    expect(before.simulation.queuedActions).toHaveLength(128);
    expect(before.simulation.queuedActions.at(-1)?.status).toBe("queued");
  });
});
