import {beforeEach, describe, expect, it} from "vitest";

import {
  type CountryPanelProjection,
} from "../lib/projection/country-panel-projection";
import type {CountrySearchProjection} from "../lib/projection/country-search-index-patch";
import type {ActiveCountryId} from "../lib/world/country-id";
import {useGameSetupStore} from "./game-setup-store";

const activeCountryId = (countryId: string) => countryId as ActiveCountryId;
const revision = 11;

const baseCountryPanelProjection: CountryPanelProjection = Object.freeze({
  revision,
  appliedRevision: revision,
  coreById: new Map([[
    activeCountryId("FRA"),
    Object.freeze({countryId: activeCountryId("FRA"), iso3: "FRA"}),
  ]]),
  inputById: new Map([[
    activeCountryId("FRA"),
    Object.freeze({
      nameKo: "France",
      nameEn: "France",
      capitalKo: "Paris",
      capitalEn: "Paris",
      flagCode: "fr",
      region: "Europe",
    }),
  ]]),
  playableById: new Map([[activeCountryId("FRA"), true]]),
});

const baseCountrySearchProjection: CountrySearchProjection = Object.freeze({
  revision,
  fullRebuildCount: 0,
  entriesById: new Map([[
    activeCountryId("FRA"),
    Object.freeze({
      countryId: activeCountryId("FRA"),
      shortKo: "France",
      officialKo: "France",
      mapKo: "France",
      english: "France",
      searchAliases: ["FRA"],
      playable: true,
    }),
  ]]),
});

const withPlayablePolicy = (
  countryId: string,
  playable: boolean,
): CountryPanelProjection => {
  const playableById = new Map(baseCountryPanelProjection.playableById);
  playableById.set(activeCountryId(countryId), playable);
  return Object.freeze({
    ...baseCountryPanelProjection,
    revision: baseCountryPanelProjection.revision + 1,
    appliedRevision: baseCountryPanelProjection.appliedRevision + 1,
    playableById,
  });
};

const withoutCountry = (countryId: string): CountryPanelProjection => {
  const activeId = activeCountryId(countryId);
  const coreById = new Map(baseCountryPanelProjection.coreById);
  const inputById = new Map(baseCountryPanelProjection.inputById);
  const playableById = new Map(baseCountryPanelProjection.playableById);
  coreById.delete(activeId);
  inputById.delete(activeId);
  playableById.delete(activeId);
  return Object.freeze({
    revision: baseCountryPanelProjection.revision + 1,
    appliedRevision: baseCountryPanelProjection.appliedRevision + 1,
    coreById,
    inputById,
    playableById,
  });
};

describe("10-91 player country policy projection", () => {
  beforeEach(() => {
    useGameSetupStore.getState().resetGameSetup();
    useGameSetupStore.getState().setCountrySearchProjection(baseCountrySearchProjection);
    useGameSetupStore.getState().setCountryPanelProjection(baseCountryPanelProjection);
  });

  it("rejects player confirmation when the playable module marks the country unplayable", () => {
    useGameSetupStore.getState().setCountryPanelProjection(withPlayablePolicy("FRA", false));

    useGameSetupStore.getState().confirmPlayerCountry("FRA");

    expect(useGameSetupStore.getState().playerCountryId).toBeNull();
  });

  it("keeps player selection in memory and resets it when a new session initializes", () => {
    useGameSetupStore.getState().confirmPlayerCountry("FRA");

    expect(useGameSetupStore.getState().playerCountryId).toBe("FRA");

    useGameSetupStore.getState().initializeSession();

    expect(useGameSetupStore.getState().playerCountryId).toBeNull();
  });

  it("clears the in-memory player country when a panel projection deletes that country", () => {
    useGameSetupStore.setState({playerCountryId: activeCountryId("FRA")});

    useGameSetupStore.getState().setCountryPanelProjection(withoutCountry("FRA"));

    expect(useGameSetupStore.getState().playerCountryId).toBeNull();
  });

  it("starts a new session without selecting a country", () => {
    useGameSetupStore.getState().setCountryPanelProjection(withPlayablePolicy("FRA", false));

    useGameSetupStore.getState().initializeSession();

    expect(useGameSetupStore.getState().playerCountryId).toBeNull();
  });
});
