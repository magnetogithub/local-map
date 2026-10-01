import {beforeAll, describe, expect, it} from "vitest";

import type {AtomicWorldCommitStore} from "@/lib/planning/atomic-world-commit";
import {createProductionInitialWorldStateV2} from "@/lib/world/initial-world-state-v2";
import {createWorldStateV2, type WorldStateV2} from "@/lib/world/world-state-v2";
import {createWorldStateStore} from "./world-state-store";

const hash = (digit: string) => digit.repeat(64);

describe("11-3 WorldStateV2 store boundary", () => {
  let initialState: WorldStateV2;

  beforeAll(() => {
    initialState = createProductionInitialWorldStateV2().worldState;
  }, 180_000);

  const nextRevision = (state: WorldStateV2) =>
    createWorldStateV2({...state, revision: state.revision + 1});

  it("advances revision through committed v2 replacement and notifies subscribers", () => {
    const controller = createWorldStateStore(initialState);
    const atomicStore: AtomicWorldCommitStore = controller;
    const nextState = nextRevision(initialState);
    const notifications: unknown[] = [];
    controller.subscribeDomain((notification) => notifications.push(notification));

    controller.replaceWorldState(nextState, {
      commandId: "command-1",
      revision: nextState.revision,
      worldContentHash: hash("1"),
      previousCommitHash: null,
      commitHash: hash("2"),
    });

    expect(controller.getState()).toBe(nextState);
    expect(atomicStore.getState()).toBe(nextState);
    expect(controller.store.getState()).toBe(nextState);
    expect(controller.getCommitHash()).toBe(hash("2"));
    expect(controller.getCommittedCommandIds().has("command-1")).toBe(true);
    expect(notifications).toHaveLength(1);
  }, 180_000);

  it("rejects stale replacement attempts", () => {
    const controller = createWorldStateStore(initialState);
    const first = nextRevision(initialState);
    controller.replaceWorldState(first, {
      commandId: "command-1",
      revision: first.revision,
      worldContentHash: hash("1"),
      previousCommitHash: null,
      commitHash: hash("2"),
    });
    const stale = nextRevision(first);

    expect(() =>
      controller.replaceWorldState(stale, {
        commandId: "command-2",
        revision: stale.revision,
        worldContentHash: hash("3"),
        previousCommitHash: null,
        commitHash: hash("4"),
      }),
    ).toThrow(/stale commit hash/);
    expect(controller.getState()).toBe(first);
  }, 180_000);

  it("exposes read-only snapshots without direct writable store mutation", () => {
    const controller = createWorldStateStore(initialState);
    const snapshot = controller.store.getState();

    expect("setState" in controller.store).toBe(false);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.countriesById)).toBe(true);
    expect(Object.isFrozen(snapshot.countryOrder)).toBe(true);
    expect(Object.isFrozen(snapshot.territoriesById)).toBe(true);
    expect(Object.isFrozen(snapshot.territoryOrder)).toBe(true);
    expect(() => {
      (snapshot as {revision: number}).revision = 99;
    }).toThrow();
    expect(controller.store.getState().revision).toBe(0);
  }, 180_000);
});
