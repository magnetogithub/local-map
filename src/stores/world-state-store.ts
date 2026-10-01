"use client";

import {useStore} from "zustand";
import {createStore, type StoreApi} from "zustand/vanilla";
import type {
  AtomicWorldCommitMetadata,
  AtomicWorldDomainSubscriber,
} from "@/lib/planning/atomic-world-commit";
import {
  assertWorldStateV2,
  type WorldStateV2,
} from "@/lib/world/world-state-v2";
import type {CountryEntity} from "@/lib/world/country-entity";
import type {TerritoryEntity} from "@/lib/world/territory-entity";
import {checkpointWorldContentHash} from "@/lib/planning/history-persistence-checkpoint";
import {commitHash as computeCommitHash} from "@/lib/world/purpose-hashes";

type Primitive = string | number | boolean | bigint | symbol | null | undefined;
export type DeepReadonly<T> = T extends Primitive | ((...args: never[]) => unknown)
  ? T
  : T extends readonly (infer Item)[]
    ? readonly DeepReadonly<Item>[]
    : {readonly [Key in keyof T]: DeepReadonly<T[Key]>};

export type WorldStateSnapshot = DeepReadonly<WorldStateV2>;
export type CountryEntitySnapshot = DeepReadonly<CountryEntity>;
export type TerritoryEntitySnapshot = DeepReadonly<TerritoryEntity>;
export type WorldStateSelector<Selected> = (state: WorldStateSnapshot) => Selected;
export type ReadonlyWorldStateStore = Pick<
  StoreApi<WorldStateV2>,
  "getState" | "getInitialState" | "subscribe"
>;

export type WorldSubscriberFailure = Readonly<{
  channel: "zustand" | "domain";
  revision: number;
  subscriberIndex: number;
  message: string;
}>;

export type WorldStateStoreController = {
  readonly store: ReadonlyWorldStateStore;
  getState(): WorldStateV2;
  getCommitHash(): string | null;
  getCommittedCommandIds(): ReadonlySet<string>;
  replaceWorldState(nextState: WorldStateV2, commit: AtomicWorldCommitMetadata): void;
  publishSimulationSnapshot(nextState: WorldStateV2, turnId: string, kind: "commit" | "undo" | "redo"): void;
  preflightSimulationSnapshot(nextState: WorldStateV2): void;
  hydrateSimulationSnapshot(nextState: WorldStateV2): void;
  subscribeDomain(subscriber: AtomicWorldDomainSubscriber): () => void;
  getSubscriberFailures(): readonly WorldSubscriberFailure[];
};

export const selectWorldState = (state: WorldStateSnapshot) => state;
export const selectWorldRevision = (state: WorldStateSnapshot) => state.revision;
export const selectWorldCountriesById = (state: WorldStateSnapshot) => state.countriesById;
export const selectWorldCountryOrder = (state: WorldStateSnapshot) => state.countryOrder;
export const selectWorldTerritoriesById = (state: WorldStateSnapshot) => state.territoriesById;
export const selectWorldTerritoryOrder = (state: WorldStateSnapshot) => state.territoryOrder;

export function getCountryById(
  state: WorldStateSnapshot,
  countryId: string,
): CountryEntitySnapshot | null {
  return state.countriesById[countryId] ?? null;
}

export const selectCountryById = (
  countryId: string,
): WorldStateSelector<CountryEntitySnapshot | null> =>
  (state) => getCountryById(state, countryId);

export function getTerritoryById(
  state: WorldStateSnapshot,
  territoryId: string,
): TerritoryEntitySnapshot | null {
  return state.territoriesById[territoryId] ?? null;
}

export const selectTerritoryById = (
  territoryId: string,
): WorldStateSelector<TerritoryEntitySnapshot | null> =>
  (state) => getTerritoryById(state, territoryId);

const countriesInOrderBySnapshot = new WeakMap<
  WorldStateSnapshot,
  readonly CountryEntitySnapshot[]
>();

export function getCountriesInOrder(
  state: WorldStateSnapshot,
): readonly CountryEntitySnapshot[] {
  const cached = countriesInOrderBySnapshot.get(state);
  if (cached) return cached;

  const countries = state.countryOrder.map((countryId) => {
    const country = state.countriesById[countryId];
    if (!country) {
      throw new Error(`countryOrder references an unknown country id: ${countryId}`);
    }
    return country;
  });
  countriesInOrderBySnapshot.set(state, countries);
  return countries;
}

export const selectCountriesInOrder: WorldStateSelector<readonly CountryEntitySnapshot[]> =
  getCountriesInOrder;

const territoriesInOrderBySnapshot = new WeakMap<
  WorldStateSnapshot,
  readonly TerritoryEntitySnapshot[]
>();

export function getTerritoriesInOrder(
  state: WorldStateSnapshot,
): readonly TerritoryEntitySnapshot[] {
  const cached = territoriesInOrderBySnapshot.get(state);
  if (cached) return cached;

  const territories = state.territoryOrder.map((territoryId) => {
    const territory = state.territoriesById[territoryId];
    if (!territory) {
      throw new Error(`territoryOrder references an unknown territory id: ${territoryId}`);
    }
    return territory;
  });
  territoriesInOrderBySnapshot.set(state, territories);
  return territories;
}

export const selectTerritoriesInOrder: WorldStateSelector<readonly TerritoryEntitySnapshot[]> =
  getTerritoriesInOrder;

export function createWorldStateStore(
  initialState: WorldStateV2,
  initialCommitHash: string | null = null,
  initialCommittedCommandIds: Iterable<string> = [],
): WorldStateStoreController {
  assertWorldStateV2(initialState);
  const writableStore = createStore<WorldStateV2>()(() => initialState);
  const store: ReadonlyWorldStateStore = {
    getState: writableStore.getState,
    getInitialState: writableStore.getInitialState,
    subscribe: writableStore.subscribe,
  };
  let currentCommitHash = initialCommitHash;
  const committedCommandIds = new Set(initialCommittedCommandIds);
  const subscribers = new Set<AtomicWorldDomainSubscriber>();
  const subscriberFailures: WorldSubscriberFailure[] = [];

  const controller: WorldStateStoreController = {
    store,
    getState: writableStore.getState,
    getCommitHash: () => currentCommitHash,
    getCommittedCommandIds: () => new Set(committedCommandIds),
    replaceWorldState(nextState, commit) {
      const currentState = writableStore.getState();
      if (Object.is(nextState, currentState)) return;
      assertWorldStateV2(nextState);
      if (nextState.revision !== currentState.revision + 1) {
        throw new Error(
          `WorldState store requires the next revision: ${nextState.revision} !== ${currentState.revision + 1}`,
        );
      }
      if (commit.revision !== nextState.revision) {
        throw new Error(
          `WorldState store commit revision mismatch: ${commit.revision} !== ${nextState.revision}`,
        );
      }
      if (commit.previousCommitHash !== currentCommitHash) {
        throw new Error("WorldState store rejected a stale commit hash");
      }
      if (committedCommandIds.has(commit.commandId)) {
        throw new Error(`WorldState store rejected a duplicate command id: ${commit.commandId}`);
      }
      let zustandFailure: unknown = null;
      try {
        writableStore.setState(nextState, true);
      } catch (error) {
        if (!Object.is(writableStore.getState(), nextState)) throw error;
        zustandFailure = error;
      }
      currentCommitHash = commit.commitHash;
      committedCommandIds.add(commit.commandId);
      if (zustandFailure !== null) subscriberFailures.push(Object.freeze({
        channel: "zustand",
        revision: nextState.revision,
        subscriberIndex: 0,
        message: zustandFailure instanceof Error ? zustandFailure.message : String(zustandFailure),
      }));
      const notification = Object.freeze({previousState: currentState, nextState, commit});
      [...subscribers].forEach((subscriber, subscriberIndex) => {
        try {
          subscriber(notification);
        } catch (error) {
          subscriberFailures.push(Object.freeze({
            channel: "domain",
            revision: nextState.revision,
            subscriberIndex,
            message: error instanceof Error ? error.message : String(error),
          }));
        }
      });
    },
    preflightSimulationSnapshot(nextState) {
      const currentState = writableStore.getState();
      if (Object.is(nextState, currentState)) return;
      assertWorldStateV2(nextState);
      if (nextState.revision !== currentState.revision + 1) {
        throw new Error("Simulation snapshot must advance the world revision exactly once");
      }
    },
    publishSimulationSnapshot(nextState, turnId, kind) {
      const currentState = writableStore.getState();
      if (Object.is(nextState, currentState)) return;
      controller.preflightSimulationSnapshot(nextState);
      const previousCommitHash = currentCommitHash;
      const contentHash = checkpointWorldContentHash(nextState);
      const commandId = `simulation.${turnId}.${kind}.${nextState.revision}`;
      const nextCommitHash = computeCommitHash({
        revision: nextState.revision,
        worldContentHash: contentHash,
        policyVersion: nextState.policyVersion,
        previousCommitHash,
      });
      controller.replaceWorldState(nextState, {
        commandId,
        revision: nextState.revision,
        worldContentHash: contentHash,
        previousCommitHash,
        commitHash: nextCommitHash,
      });
    },
    hydrateSimulationSnapshot(nextState) {
      assertWorldStateV2(nextState);
      writableStore.setState(nextState, true);
      currentCommitHash = null;
      committedCommandIds.clear();
    },
    subscribeDomain(subscriber) {
      subscribers.add(subscriber);
      return () => {
        subscribers.delete(subscriber);
      };
    },
    getSubscriberFailures: () => Object.freeze([...subscriberFailures]),
  };

  return Object.freeze(controller);
}

export function useWorldStateSelector<Selected>(
  store: ReadonlyWorldStateStore,
  selector: WorldStateSelector<Selected>,
): Selected {
  return useStore(store, selector as (state: WorldStateV2) => Selected);
}
