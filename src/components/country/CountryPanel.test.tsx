import fs from "node:fs";
import path from "node:path";
import {beforeEach, describe, expect, it} from "vitest";
import {fireEvent, render, screen} from "@testing-library/react";
import {CountryPanel} from "./CountryPanel";
import type {
  CountryPanelCoreProjectionEntry,
  CountryPanelInputProjectionEntry,
  CountryPanelProjection,
} from "@/lib/projection/country-panel-projection";
import type {CountrySearchProjection} from "@/lib/projection/country-search-index-patch";
import type {ActiveCountryId} from "@/lib/world/country-id";
import {useGameSetupStore} from "@/stores/game-setup-store";

const source = (relativePath: string) =>
  fs.readFileSync(path.join(process.cwd(), relativePath), "utf8");

const activeCountryId = (countryId: "FRA" | "JPN") => countryId as ActiveCountryId;

const countries = ["FRA", "JPN"] as const;

const countrySearchProjection: CountrySearchProjection = Object.freeze({
  revision: 3,
  entriesById: new Map(countries.map((countryId) => [
    activeCountryId(countryId),
    Object.freeze({
      countryId: activeCountryId(countryId),
      shortKo: countryId,
      officialKo: `${countryId} Republic`,
      mapKo: countryId,
      english: countryId,
      searchAliases: [countryId],
      playable: true,
    }),
  ])),
  fullRebuildCount: 0,
});

const countryPanelProjection: CountryPanelProjection = Object.freeze({
  revision: 3,
  appliedRevision: 3,
  coreById: new Map<ActiveCountryId, CountryPanelCoreProjectionEntry>([
    [activeCountryId("FRA"), Object.freeze({countryId: activeCountryId("FRA"), iso3: "FRA"})],
    [activeCountryId("JPN"), Object.freeze({countryId: activeCountryId("JPN"), iso3: "JPN"})],
  ]),
  inputById: new Map<ActiveCountryId, CountryPanelInputProjectionEntry>([
    [activeCountryId("FRA"), Object.freeze({
      nameKo: "France",
      nameEn: "France",
      capitalKo: "Paris",
      capitalEn: "Paris",
      flagCode: "fr",
      region: "Europe",
    })],
    [activeCountryId("JPN"), Object.freeze({
      nameKo: "Japan",
      nameEn: "Japan",
      capitalKo: "Tokyo",
      capitalEn: "Tokyo",
      flagCode: "jp",
      region: "Asia",
    })],
  ]),
  playableById: new Map([
    [activeCountryId("FRA"), true],
    [activeCountryId("JPN"), true],
  ]),
});

const hydrateFixtureProjections = () => {
  useGameSetupStore.getState().setCountrySearchProjection(countrySearchProjection);
  useGameSetupStore.getState().setCountryPanelProjection(countryPanelProjection);
};

describe("10-90 CountryPanel projection transition", () => {
  beforeEach(() => {
    localStorage.clear();
    useGameSetupStore.getState().resetGameSetup();
  });

  it("renders country panel fields from panel projections and confirms a single player", () => {
    hydrateFixtureProjections();
    useGameSetupStore.getState().selectCountry("FRA");

    render(<CountryPanel />);

    expect(screen.getByRole("heading", {name: "France"})).toBeInTheDocument();
    expect(screen.getAllByText("Paris")).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", {name: /France/}));
    expect(useGameSetupStore.getState().playerCountryId).toBe("FRA");
    useGameSetupStore.getState().confirmPlayerCountry("JPN");
    expect(useGameSetupStore.getState().playerCountryId).toBe("JPN");
  });

  it("has zero rejected CountryEntity or static countryById fallback in panel runtime", () => {
    const text = source("src/components/country/CountryPanel.tsx");

    expect(text).not.toContain("countryById");
    expect(text).not.toContain("country-index");
    expect(text).not.toContain("CountryEntity");
    expect(text).toContain("getCountryPanelView");
  });
});
