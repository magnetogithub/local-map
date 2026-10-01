"use client";

import {create} from "zustand";
import {
  emptyCountryPanelProjection,
  isCountryPanelPlayable,
  type CountryPanelProjection,
} from "@/lib/projection/country-panel-projection";
import type {CountrySearchProjection} from "@/lib/projection/country-search-index-patch";
import type {ActiveCountryId} from "@/lib/world/country-id";

type State = {
  sessionInitialized: boolean;
  scenarioId: "2020-otl";
  scenarioDate: "2020-01-01";
  hoveredCountryId: ActiveCountryId | null;
  selectedCountryId: ActiveCountryId | null;
  selectedCountryProjectionRevision: number | null;
  playerCountryId: ActiveCountryId | null;
  searchQuery: string;
  isCountryPanelOpen: boolean;
  countrySearchProjection: CountrySearchProjection;
  countryPanelProjection: CountryPanelProjection;
  setHoveredCountry: (id: string | null) => void;
  selectCountry: (id: string) => void;
  clearSelectedCountry: () => void;
  confirmPlayerCountry: (id: string) => void;
  syncSimulationPlayerCountry: (id: ActiveCountryId) => void;
  setSearchQuery: (q: string) => void;
  setCountrySearchProjection: (projection: CountrySearchProjection) => void;
  setCountryPanelProjection: (projection: CountryPanelProjection) => void;
  initializeSession: () => void;
  resetGameSetup: () => void;
};

const emptyCountrySearchProjection: CountrySearchProjection = Object.freeze({
  revision: 0,
  entriesById: new Map(),
  fullRebuildCount: 0,
});

const initial = {
  sessionInitialized: false,
  scenarioId: "2020-otl" as const,
  scenarioDate: "2020-01-01" as const,
  hoveredCountryId: null,
  selectedCountryId: null,
  selectedCountryProjectionRevision: null,
  playerCountryId: null,
  searchQuery: "",
  isCountryPanelOpen: false,
  countrySearchProjection: emptyCountrySearchProjection,
  countryPanelProjection: emptyCountryPanelProjection,
};

const hasProjectionCountry = (projection: CountrySearchProjection, countryId: string | null) =>
  countryId !== null && projection.entriesById.has(countryId as never);

const isDynamicSimulationCountryId = (countryId: string | null) =>
  countryId !== null && /^D[0-9A-Z]{2}$/.test(countryId);

const activeProjectionCountryId = (
  projection: CountrySearchProjection,
  countryId: string | null,
): ActiveCountryId | null =>
  hasProjectionCountry(projection, countryId) ? countryId as ActiveCountryId : null;

const isProjectionCountryPlayable = (
  projection: CountryPanelProjection,
  countryId: string | null,
) => isCountryPanelPlayable(projection, countryId);

const keepPlayablePlayerCountry = (
  searchProjection: CountrySearchProjection,
  projection: CountryPanelProjection,
  countryId: string | null,
) => {
  const activeId = activeProjectionCountryId(searchProjection, countryId);
  return activeId !== null && isProjectionCountryPlayable(projection, activeId) ? activeId : null;
};

export const useGameSetupStore = create<State>((set, get) => ({
  ...initial,
  setHoveredCountry: (id) => set((state) => ({
    hoveredCountryId: activeProjectionCountryId(state.countrySearchProjection, id),
  })),
  selectCountry: (id) => {
    const projection = get().countrySearchProjection;
    const countryId = activeProjectionCountryId(projection, id);
    if (countryId !== null) {
      set({
        selectedCountryId: countryId,
        selectedCountryProjectionRevision: projection.revision,
        isCountryPanelOpen: true,
      });
    }
  },
  clearSelectedCountry: () => set({
    selectedCountryId: null,
    selectedCountryProjectionRevision: null,
    isCountryPanelOpen: false,
  }),
  confirmPlayerCountry: (id) => {
    const state = get();
    const activeId = activeProjectionCountryId(state.countrySearchProjection, id);
    if (activeId === null || !isProjectionCountryPlayable(state.countryPanelProjection, activeId)) {
      return;
    }
    set({playerCountryId: activeId});
  },
  syncSimulationPlayerCountry: (id) => {
    set({playerCountryId: id});
  },
  setSearchQuery: (searchQuery) => set({searchQuery}),
  setCountryPanelProjection: (countryPanelProjection) => set((state) => {
    const playerCountryId = isDynamicSimulationCountryId(state.playerCountryId)
      && !hasProjectionCountry(state.countrySearchProjection, state.playerCountryId)
      ? state.playerCountryId
      : keepPlayablePlayerCountry(state.countrySearchProjection, countryPanelProjection, state.playerCountryId);

    return {countryPanelProjection, playerCountryId};
  }),
  setCountrySearchProjection: (countrySearchProjection) => set((state) => {
    const selectedCountryId = activeProjectionCountryId(
      countrySearchProjection,
      state.selectedCountryId,
    );
    const hoveredCountryId = activeProjectionCountryId(
      countrySearchProjection,
      state.hoveredCountryId,
    );
    const playerCountryId = isDynamicSimulationCountryId(state.playerCountryId)
      && !hasProjectionCountry(countrySearchProjection, state.playerCountryId)
      ? state.playerCountryId
      : state.countryPanelProjection.revision === countrySearchProjection.revision
        ? keepPlayablePlayerCountry(countrySearchProjection, state.countryPanelProjection, state.playerCountryId)
        : activeProjectionCountryId(countrySearchProjection, state.playerCountryId);

    return {
      countrySearchProjection,
      hoveredCountryId,
      selectedCountryId,
      selectedCountryProjectionRevision: selectedCountryId === null
        ? null
        : countrySearchProjection.revision,
      playerCountryId,
      isCountryPanelOpen: selectedCountryId !== null && state.isCountryPanelOpen,
    };
  }),
  initializeSession: () => {
    if (get().sessionInitialized) return;
    set({
      sessionInitialized: true,
      hoveredCountryId: null,
      selectedCountryId: null,
      selectedCountryProjectionRevision: null,
      playerCountryId: null,
      searchQuery: "",
      isCountryPanelOpen: false,
    });
  },
  resetGameSetup: () => {
    set(initial);
  },
}));
