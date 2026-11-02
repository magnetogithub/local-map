import {describe, expect, it, vi} from "vitest";

import {calculateAffectedSet} from "./affected-set";
import {
  type AtomicWorldCommitMetadata,
  AtomicWorldCommitError,
  commitVerifiedWorldPatch,
  createAtomicWorldCommitMemoryStore,
} from "./atomic-world-commit";
import {planCountryCreate} from "./country-create-planner";
import {countryCreateCommandFixture, plannerStateFixture} from "./planner-test-fixture";
import {buildWorldPatchV2} from "./world-patch-v2";

const hash = (suffix: string) => `${"0".repeat(63)}${suffix}`;

const createCountryPatch = () => {
  const beforeState = plannerStateFixture();
  const plan = planCountryCreate(
    beforeState,
    countryCreateCommandFixture("BBB"),
    {committedCommandIds: new Set()},
  );

  expect(plan.ok).toBe(true);
  if (!plan.ok) throw new Error("fixture planning failed");
  const patch = buildWorldPatchV2({
    commandId: plan.plan.commandId,
    beforeState,
    afterState: plan.plan.nextState,
    affectedSet: calculateAffectedSet({
      beforeState,
      afterState: plan.plan.nextState,
      patch: plan.plan.patch,
    }),
    plannerPatch: plan.plan.patch,
  });

  return {beforeState, plan: plan.plan, patch};
};

describe("10-81/10-82 atomic WorldPatch commit", () => {
  it("applies a verified next state and advances revision plus commitHash exactly once", () => {
    const {beforeState, plan, patch} = createCountryPatch();
    let storedState = beforeState;
    let storedCommitHash: string | null = hash("a");
    const committedCommandIds = new Set<string>();
    const replaceWorldState = vi.fn((
      nextState,
      commit: AtomicWorldCommitMetadata,
    ) => {
      storedState = nextState;
      storedCommitHash = commit.commitHash;
      committedCommandIds.add(commit.commandId);
    });
    const store = {
      getState: vi.fn(() => storedState),
      getCommitHash: vi.fn(() => storedCommitHash),
      getCommittedCommandIds: vi.fn(() => new Set(committedCommandIds)),
      replaceWorldState,
    };

    const commit = commitVerifiedWorldPatch({
      store,
      nextState: plan.nextState,
      patch,
    });

    expect(store.getState).toHaveBeenCalledTimes(1);
    expect(store.getCommitHash).toHaveBeenCalledTimes(1);
    expect(replaceWorldState).toHaveBeenCalledTimes(1);
    expect(replaceWorldState).toHaveBeenCalledWith(
      plan.nextState,
      expect.objectContaining({
        commandId: "create-BBB",
        revision: 8,
        worldContentHash: patch.afterContentHash,
        previousCommitHash: hash("a"),
      }),
    );
    expect(storedState).toBe(plan.nextState);
    expect(storedCommitHash).toBe(commit.commitHash);
    expect(commit.kind).toBe("atomic-world-commit");
    expect(commit.commandId).toBe("create-BBB");
    expect(commit.beforeRevision).toBe(7);
    expect(commit.afterRevision).toBe(8);
    expect(commit.beforeContentHash).toBe(patch.beforeContentHash);
    expect(commit.afterContentHash).toBe(patch.afterContentHash);
    expect(commit.previousCommitHash).toBe(hash("a"));
    expect(commit.commitHash).toMatch(/^[0-9a-f]{64}$/);
    expect(commit.commitHash).not.toBe(patch.afterContentHash);
    expect(commit.patch).toBe(patch);
    expect(commit.nextState).toBe(plan.nextState);
    expect(commit.patch.plannerPatch).toEqual({kind: "country.create", countryId: "BBB"});
  });

  it("rejects revision mismatches before mutating the store", () => {
    const {plan, patch} = createCountryPatch();
    const store = {
      getState: () => plan.nextState,
      getCommitHash: vi.fn(() => null),
      getCommittedCommandIds: vi.fn(() => new Set<string>()),
      replaceWorldState: vi.fn(),
    };

    expect(() => commitVerifiedWorldPatch({
      store,
      nextState: plan.nextState,
      patch,
    })).toThrow(AtomicWorldCommitError);
    expect(store.getCommittedCommandIds).not.toHaveBeenCalled();
    expect(store.getCommitHash).not.toHaveBeenCalled();
    expect(store.replaceWorldState).not.toHaveBeenCalled();
  });

  it("rejects content hash mismatches before mutating the store", () => {
    const {beforeState, plan, patch} = createCountryPatch();
    const tamperedPatch = {
      ...patch,
      afterContentHash: patch.beforeContentHash,
    };
    const store = {
      getState: () => beforeState,
      getCommitHash: vi.fn(() => null),
      getCommittedCommandIds: vi.fn(() => new Set<string>()),
      replaceWorldState: vi.fn(),
    };

    expect(() => commitVerifiedWorldPatch({
      store,
      nextState: plan.nextState,
      patch: tamperedPatch,
    })).toThrow(AtomicWorldCommitError);
    expect(store.getCommittedCommandIds).toHaveBeenCalledTimes(1);
    expect(store.getCommitHash).not.toHaveBeenCalled();
    expect(store.replaceWorldState).not.toHaveBeenCalled();
  });

  it("rejects invalid previous commit hashes before mutating the store", () => {
    const {beforeState, plan, patch} = createCountryPatch();
    const store = {
      getState: () => beforeState,
      getCommitHash: () => "not-a-hash",
      getCommittedCommandIds: () => new Set<string>(),
      replaceWorldState: vi.fn(),
    };

    expect(() => commitVerifiedWorldPatch({
      store,
      nextState: plan.nextState,
      patch,
    })).toThrow(/previousCommitHash/);
    expect(store.replaceWorldState).not.toHaveBeenCalled();
  });

  it("rejects duplicate commandId commits before mutating state or history", () => {
    const {beforeState, plan, patch} = createCountryPatch();
    const committedCommandIds = new Set([patch.commandId]);
    const store = {
      getState: () => beforeState,
      getCommitHash: vi.fn(() => null),
      getCommittedCommandIds: vi.fn(() => new Set(committedCommandIds)),
      replaceWorldState: vi.fn((
        _nextState,
        commit: AtomicWorldCommitMetadata,
      ) => {
        committedCommandIds.add(commit.commandId);
      }),
    };

    expect(() => commitVerifiedWorldPatch({
      store,
      nextState: plan.nextState,
      patch,
    })).toThrow(/already been committed/);
    expect(committedCommandIds).toEqual(new Set([patch.commandId]));
    expect(store.getCommitHash).not.toHaveBeenCalled();
    expect(store.replaceWorldState).not.toHaveBeenCalled();
  });

  it("keeps memory store state and history unchanged for stale plans and duplicate commandIds", () => {
    const {beforeState, plan, patch} = createCountryPatch();
    const staleStore = createAtomicWorldCommitMemoryStore(plan.nextState);

    expect(() => commitVerifiedWorldPatch({
      store: staleStore,
      nextState: plan.nextState,
      patch,
    })).toThrow(AtomicWorldCommitError);
    expect(staleStore.getState()).toBe(plan.nextState);
    expect(staleStore.getCommittedCommandIds().size).toBe(0);

    const duplicateStore = createAtomicWorldCommitMemoryStore(
      beforeState,
      null,
      [patch.commandId],
    );
    expect(() => commitVerifiedWorldPatch({
      store: duplicateStore,
      nextState: plan.nextState,
      patch,
    })).toThrow(/already been committed/);
    expect(duplicateStore.getState()).toBe(beforeState);
    expect([...duplicateStore.getCommittedCommandIds()]).toEqual([patch.commandId]);
  });

  it("keeps state, patch, and history immutable when executor failure is injected", () => {
    const {beforeState, plan, patch} = createCountryPatch();
    const patchBeforeFailure = JSON.stringify(patch);
    const injected = new Error("injected commit failure");
    const store = createAtomicWorldCommitMemoryStore(
      beforeState,
      null,
      [],
      {failCommit: () => { throw injected; }},
    );

    expect(() => commitVerifiedWorldPatch({
      store,
      nextState: plan.nextState,
      patch,
    })).toThrow(injected);
    expect(store.getState()).toBe(beforeState);
    expect(store.getCommitHash()).toBeNull();
    expect(store.getCommittedCommandIds().size).toBe(0);
    expect(JSON.stringify(patch)).toBe(patchBeforeFailure);
  });

  it("rolls back state and history when a subscriber throws during commit notification", () => {
    const {beforeState, plan, patch} = createCountryPatch();
    const subscriberError = new Error("subscriber failed");
    const store = createAtomicWorldCommitMemoryStore(beforeState);
    store.subscribeDomain(() => {
      throw subscriberError;
    });

    expect(() => commitVerifiedWorldPatch({
      store,
      nextState: plan.nextState,
      patch,
    })).toThrow(subscriberError);
    expect(store.getState()).toBe(beforeState);
    expect(store.getCommitHash()).toBeNull();
    expect(store.getCommittedCommandIds().size).toBe(0);
  });
});
