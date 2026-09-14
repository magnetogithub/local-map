"use client";

import {useStore} from "zustand";
import {createStore, type StoreApi} from "zustand/vanilla";
import {
  assertWorldState,
  type CountryEntity,
  type WorldState,
} from "@/lib/world/world-state";

type Primitive = string | number | boolean | bigint | symbol | null | undefined;
export type DeepReadonly<T> = T extends Primitive | ((...args: never[]) => unknown)
  ? T
  : T extends readonly (infer Item)[]
    ? readonly DeepReadonly<Item>[]
    : {readonly [Key in keyof T]: DeepReadonly<T[Key]>};

export type WorldStateSnapshot = DeepReadonly<WorldState>;
export type CountryEntitySnapshot = DeepReadonly<CountryEntity>;
export type WorldStateSelector<Selected> = (state: WorldStateSnapshot) => Selected;
export type ReadonlyWorldStateStore = Pick<
  StoreApi<WorldState>,
  "getState" | "getInitialState" | "subscribe"
>;

export type WorldStateStoreController = {
  readonly store: ReadonlyWorldStateStore;
  replaceWorldState(nextState: WorldState): void;
};

export const selectWorldState = (state: WorldStateSnapshot) => state;
export const selectWorldRevision = (state: WorldStateSnapshot) => state.revision;
export const selectWorldCountriesById = (state: WorldStateSnapshot) => state.countriesById;
export const selectWorldCountryOrder = (state: WorldStateSnapshot) => state.countryOrder;

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

export function createWorldStateStore(initialState: WorldState): WorldStateStoreController {
  assertWorldState(initialState);
  const writableStore = createStore<WorldState>()(() => initialState);
  const store: ReadonlyWorldStateStore = {
    getState: writableStore.getState,
    getInitialState: writableStore.getInitialState,
    subscribe: writableStore.subscribe,
  };

  return {
    store,
    replaceWorldState(nextState) {
      const currentState = writableStore.getState();
      if (Object.is(nextState, currentState)) return;
      assertWorldState(nextState);
      if (nextState.revision !== currentState.revision + 1) {
        throw new Error(
          `WorldState store requires the next revision: ${nextState.revision} !== ${currentState.revision + 1}`,
        );
      }
      writableStore.setState(nextState, true);
    },
  };
}

export function useWorldStateSelector<Selected>(
  store: ReadonlyWorldStateStore,
  selector: WorldStateSelector<Selected>,
): Selected {
  return useStore(store, selector as (state: WorldState) => Selected);
}
