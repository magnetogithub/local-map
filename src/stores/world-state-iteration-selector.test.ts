import crypto from "node:crypto";
import {createElement} from "react";
import {act, render, screen} from "@testing-library/react";
import {describe, expect, it, vi} from "vitest";
import {
  applyCountryReplacement,
  rollbackCountryReplacement,
  type CountryEntity,
  type WorldState,
} from "@/lib/world/world-state";
import {
  createWorldStateStore,
  getCountriesInOrder,
  selectCountriesInOrder,
  useWorldStateSelector,
} from "./world-state-store";

const country = (id: string): CountryEntity => ({
  id,
  iso3: id,
  names: {
    shortKo: id,
    officialKo: id,
    mapKo: id,
    english: id,
    searchAliases: [id],
  },
  geometry: {
    type: "Polygon",
    coordinates: [[[0, 0], [2, 0], [2, 2], [0, 0]]],
  },
  mapColor: "#ffffff",
  playable: true,
  unitType: "sovereign-country",
  capital: null,
  presentation: {
    flagCode: id,
    region: "Test",
    center: [1, 1],
    defaultZoom: 4,
    labelRank: 1,
  },
});

const entities = {
  AAA: country("AAA"),
  BBB: country("BBB"),
  CCC: country("CCC"),
  NEW: country("NEW"),
};

const initialWorldState = (recordOrder: readonly (keyof typeof entities)[]): WorldState => ({
  schemaVersion: 1,
  revision: 0,
  countriesById: Object.fromEntries(
    recordOrder.filter((id) => id !== "NEW").map((id) => [id, entities[id]]),
  ),
  countryOrder: ["AAA", "BBB", "CCC"],
});

const orderedIds = (state: WorldState) => getCountriesInOrder(state).map((item) => item.id);
const orderHash = (state: WorldState) =>
  crypto.createHash("sha256").update(JSON.stringify(orderedIds(state))).digest("hex");

const runSequence = (initial: WorldState) => {
  const created = applyCountryReplacement(initial, {
    removeCountryIds: [],
    upsertCountries: [entities.NEW],
  }).state;
  const deletion = applyCountryReplacement(created, {
    removeCountryIds: ["BBB"],
    upsertCountries: [],
  });
  const rolledBack = rollbackCountryReplacement(deletion.state, deletion.rollback);

  return {
    ids: [initial, created, deletion.state, rolledBack].map(orderedIds),
    hashes: [initial, created, deletion.state, rolledBack].map(orderHash),
    rolledBackByReference: rolledBack === created,
  };
};

describe("9-8 deterministic country iteration selector", () => {
  it("follows countryOrder instead of countriesById insertion order", () => {
    const state = initialWorldState(["CCC", "AAA", "BBB"]);
    const first = getCountriesInOrder(state);
    const second = getCountriesInOrder(state);

    expect(Object.keys(state.countriesById)).toEqual(["CCC", "AAA", "BBB"]);
    expect(first.map((item) => item.id)).toEqual(["AAA", "BBB", "CCC"]);
    expect(Object.is(first, second)).toBe(true);
    expect(selectCountriesInOrder(state).map((item) => item.id)).toEqual([
      "AAA",
      "BBB",
      "CCC",
    ]);
  });

  it("keeps create, delete, and rollback order hashes deterministic", () => {
    const first = runSequence(initialWorldState(["AAA", "BBB", "CCC"]));
    const second = runSequence(initialWorldState(["CCC", "AAA", "BBB"]));

    expect(first.ids).toEqual([
      ["AAA", "BBB", "CCC"],
      ["AAA", "BBB", "CCC", "NEW"],
      ["AAA", "CCC", "NEW"],
      ["AAA", "BBB", "CCC", "NEW"],
    ]);
    expect(second.ids).toEqual(first.ids);
    expect(second.hashes).toEqual(first.hashes);
    expect(first.rolledBackByReference).toBe(true);
    expect(second.rolledBackByReference).toBe(true);
  });

  it("updates a real React selector through create, delete, and rollback without render loops", () => {
    const controller = createWorldStateStore(initialWorldState(["CCC", "AAA", "BBB"]));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    let renders = 0;

    function CountryListProbe() {
      renders += 1;
      const countries = useWorldStateSelector(controller.store, selectCountriesInOrder);
      return createElement("output", {"data-testid": "country-list"}, countries.map((item) => item.id).join(","));
    }

    try {
      render(createElement(CountryListProbe));
      expect(screen.getByTestId("country-list")).toHaveTextContent("AAA,BBB,CCC");

      const created = applyCountryReplacement(controller.store.getState(), {
        removeCountryIds: [],
        upsertCountries: [entities.NEW],
      }).state;
      act(() => controller.replaceWorldState(created));
      expect(screen.getByTestId("country-list")).toHaveTextContent("AAA,BBB,CCC,NEW");

      const deletion = applyCountryReplacement(controller.store.getState(), {
        removeCountryIds: ["BBB"],
        upsertCountries: [],
      });
      act(() => controller.replaceWorldState(deletion.state));
      expect(screen.getByTestId("country-list")).toHaveTextContent("AAA,CCC,NEW");

      const rollbackBefore = rollbackCountryReplacement(deletion.state, deletion.rollback);
      const rollbackState: WorldState = {
        ...rollbackBefore,
        revision: deletion.state.revision + 1,
      };
      act(() => controller.replaceWorldState(rollbackState));
      expect(screen.getByTestId("country-list")).toHaveTextContent("AAA,BBB,CCC,NEW");

      const diagnostics = [...consoleError.mock.calls, ...consoleWarn.mock.calls]
        .flat()
        .map(String)
        .join("\n");
      expect(diagnostics).not.toMatch(/getSnapshot should be cached|Maximum update depth exceeded/i);
      expect(renders).toBe(4);
    } finally {
      consoleError.mockRestore();
      consoleWarn.mockRestore();
    }
  });
});
