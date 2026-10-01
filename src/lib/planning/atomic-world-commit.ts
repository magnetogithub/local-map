import {assertSha256Hex} from "../world/domain-hash-root";
import {commitHash as computeCommitHash} from "../world/purpose-hashes";
import {worldContentHash} from "../world/world-content-hash";
import type {WorldStateV2} from "../world/world-state-v2";
import type {WorldPatchV2} from "./world-patch-v2";

export type AtomicWorldCommitMetadata = Readonly<{
  commandId: string;
  revision: number;
  worldContentHash: string;
  previousCommitHash: string | null;
  commitHash: string;
}>;

export type AtomicWorldCommitNotification = Readonly<{
  previousState: WorldStateV2;
  nextState: WorldStateV2;
  commit: AtomicWorldCommitMetadata;
}>;

export type AtomicWorldDomainSubscriber = (
  notification: AtomicWorldCommitNotification,
) => void;

export type AtomicWorldCommitStore = Readonly<{
  getState(): WorldStateV2;
  getCommitHash(): string | null;
  getCommittedCommandIds(): ReadonlySet<string>;
  replaceWorldState(nextState: WorldStateV2, commit: AtomicWorldCommitMetadata): void;
}>;

export type AtomicWorldCommitMemoryStore = AtomicWorldCommitStore & Readonly<{
  subscribeDomain(subscriber: AtomicWorldDomainSubscriber): () => void;
}>;

export type AtomicWorldCommitMemoryStoreOptions = Readonly<{
  failCommit?: (notification: AtomicWorldCommitNotification) => void;
}>;

export type AtomicWorldCommit = Readonly<{
  kind: "atomic-world-commit";
  commandId: string;
  beforeRevision: number;
  afterRevision: number;
  beforeContentHash: string;
  afterContentHash: string;
  previousCommitHash: string | null;
  commitHash: string;
  patch: WorldPatchV2;
  nextState: WorldStateV2;
}>;

export type CommitVerifiedWorldPatchInput = Readonly<{
  store: AtomicWorldCommitStore;
  nextState: WorldStateV2;
  patch: WorldPatchV2;
}>;

export class AtomicWorldCommitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AtomicWorldCommitError";
  }
}

export function createAtomicWorldCommitMemoryStore(
  initialState: WorldStateV2,
  initialCommitHash: string | null = null,
  initialCommittedCommandIds: Iterable<string> = [],
  options: AtomicWorldCommitMemoryStoreOptions = {},
): AtomicWorldCommitMemoryStore {
  if (initialCommitHash !== null) {
    assertSha256Hex(initialCommitHash, "AtomicWorldCommitMemoryStore initialCommitHash");
  }
  let state = initialState;
  let currentCommitHash = initialCommitHash;
  const committedCommandIds = new Set(initialCommittedCommandIds);
  const subscribers = new Set<AtomicWorldDomainSubscriber>();

  return Object.freeze({
    getState: () => state,
    getCommitHash: () => currentCommitHash,
    getCommittedCommandIds: () => new Set(committedCommandIds),
    replaceWorldState(nextState, commit) {
      const previousState = state;
      const previousCommitHash = currentCommitHash;
      const previousCommittedCommandIds = new Set(committedCommandIds);
      const notification = Object.freeze({previousState, nextState, commit});
      options.failCommit?.(notification);

      state = nextState;
      currentCommitHash = commit.commitHash;
      committedCommandIds.add(commit.commandId);
      try {
        for (const subscriber of subscribers) {
          subscriber(notification);
        }
      } catch (error) {
        state = previousState;
        currentCommitHash = previousCommitHash;
        committedCommandIds.clear();
        for (const commandId of previousCommittedCommandIds) {
          committedCommandIds.add(commandId);
        }
        throw error;
      }
    },
    subscribeDomain(subscriber) {
      subscribers.add(subscriber);
      return () => {
        subscribers.delete(subscriber);
      };
    },
  });
}

const contentHash = (state: WorldStateV2) => {
  const {
    countriesRootHash,
    presentationRootHash,
    territoriesRootHash,
    topologyRootHash,
  } = state.hashRoots;
  assertSha256Hex(countriesRootHash, "AtomicWorldCommit countriesRootHash");
  assertSha256Hex(presentationRootHash, "AtomicWorldCommit presentationRootHash");
  assertSha256Hex(territoriesRootHash, "AtomicWorldCommit territoriesRootHash");
  assertSha256Hex(topologyRootHash, "AtomicWorldCommit topologyRootHash");
  return worldContentHash({
    schemaVersion: state.schemaVersion,
    seedVersion: state.seedVersion,
    policyVersion: state.policyVersion,
    hashRoots: {
      countriesRootHash,
      presentationRootHash,
      territoriesRootHash,
      topologyRootHash,
    },
  });
};

export function commitVerifiedWorldPatch({
  store,
  nextState,
  patch,
}: CommitVerifiedWorldPatchInput): AtomicWorldCommit {
  const currentState = store.getState();
  if (currentState.revision !== patch.beforeRevision) {
    throw new AtomicWorldCommitError(
      `Current revision ${currentState.revision} does not match patch beforeRevision ${patch.beforeRevision}`,
    );
  }
  if (store.getCommittedCommandIds().has(patch.commandId)) {
    throw new AtomicWorldCommitError(`CommandId has already been committed: ${patch.commandId}`);
  }
  if (nextState.revision !== patch.afterRevision) {
    throw new AtomicWorldCommitError(
      `Next state revision ${nextState.revision} does not match patch afterRevision ${patch.afterRevision}`,
    );
  }
  assertSha256Hex(patch.beforeContentHash, "AtomicWorldCommit beforeContentHash");
  assertSha256Hex(patch.afterContentHash, "AtomicWorldCommit afterContentHash");
  const currentContentHash = contentHash(currentState);
  if (currentContentHash !== patch.beforeContentHash) {
    throw new AtomicWorldCommitError(
      "Current state content hash does not match patch beforeContentHash",
    );
  }
  const nextContentHash = contentHash(nextState);
  if (nextContentHash !== patch.afterContentHash) {
    throw new AtomicWorldCommitError(
      "Next state content hash does not match patch afterContentHash",
    );
  }
  const previousCommitHash = store.getCommitHash();
  if (previousCommitHash !== null) {
    assertSha256Hex(previousCommitHash, "AtomicWorldCommit previousCommitHash");
  }
  const nextCommitHash = computeCommitHash({
    revision: patch.afterRevision,
    worldContentHash: patch.afterContentHash,
    policyVersion: nextState.policyVersion,
    previousCommitHash,
  });

  store.replaceWorldState(nextState, {
    commandId: patch.commandId,
    revision: patch.afterRevision,
    worldContentHash: patch.afterContentHash,
    previousCommitHash,
    commitHash: nextCommitHash,
  });

  return Object.freeze({
    kind: "atomic-world-commit",
    commandId: patch.commandId,
    beforeRevision: patch.beforeRevision,
    afterRevision: patch.afterRevision,
    beforeContentHash: patch.beforeContentHash,
    afterContentHash: patch.afterContentHash,
    previousCommitHash,
    commitHash: nextCommitHash,
    patch,
    nextState,
  });
}
