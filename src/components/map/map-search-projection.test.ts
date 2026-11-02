import fs from "node:fs";
import path from "node:path";
import {describe, expect, it} from "vitest";

import {
  committedCountrySearchProjection,
  searchCommittedCountryProjection,
} from "@/lib/projection/committed-country-search-projection";
import {useGameSetupStore} from "@/stores/game-setup-store";

const source = (relativePath: string) =>
  fs.readFileSync(path.join(process.cwd(), relativePath), "utf8");

describe("10-87 search UI committed projection transition", () => {
  it("searches only the committed country projection", () => {
    expect(committedCountrySearchProjection.revision).toBe(0);
    expect(searchCommittedCountryProjection("France")[0]?.countryId).toBe("FRA");
    expect(searchCommittedCountryProjection("FRA")[0]?.countryId).toBe("FRA");
  });

  it("selects search results through projection-backed store validation", () => {
    useGameSetupStore.setState({
      selectedCountryId: null,
      isCountryPanelOpen: false,
      searchQuery: "",
      countrySearchProjection: committedCountrySearchProjection,
    });

    useGameSetupStore.getState().selectCountry("FRA");
    expect(useGameSetupStore.getState().selectedCountryId).toBe("FRA");
    useGameSetupStore.getState().selectCountry("NOT-A-COUNTRY");
    expect(useGameSetupStore.getState().selectedCountryId).toBe("FRA");
  });

  it("has zero static countryById runtime fallback in the search UI path", () => {
    const files = [
      "src/components/map/MapSearch.tsx",
      "src/stores/game-setup-store.ts",
      "src/lib/projection/committed-country-search-projection.ts",
    ];
    for (const file of files) {
      const text = source(file);
      expect(text).not.toContain("countryById");
      expect(text).not.toContain("country-index");
      expect(text).not.toContain("searchCountries(");
      expect(text).not.toContain("@/data/countries-2020.json");
    }
  });
});
