import crypto from "node:crypto";
import {createElement} from "react";
import {act, render, screen} from "@testing-library/react";
import {describe, expect, it, vi} from "vitest";
import {
  createWorldStateStore,
  getCountriesInOrder,
  selectCountriesInOrder,
  useWorldStateSelector,
} from "./world-state-store";
import {
  addCountry,
  removeCountry,
  testCommit,
  testCountry,
  testWorldState,
  withNextRevision,
} from "./world-state-store-v2-fixture";
import type {WorldStateV2} from "@/lib/world/world-state-v2";

const orderedIds = (state: WorldStateV2) => getCountriesInOrder(state).map((item) => item.id);
const orderHash = (state: WorldStateV2) =>
  crypto.createHash("sha256").update(JSON.stringify(orderedIds(state))).digest("hex");

const runSequence = (initial: WorldStateV2) => {
  const created = addCountry(initial, testCountry("NEW"));
  const deletion = removeCountry(created, "BBB");
  const rolledBack = withNextRevision(created, deletion.revision + 1);

  return {
    ids: [initial, created, deletion, rolledBack].map(orderedIds),
    hashes: [initial, created, deletion, rolledBack].map(orderHash),
  };
};

describe("9-8 deterministic country iteration selector", () => {
  it("follows countryOrder instead of countriesById insertion order", () => {
    const state = testWorldState(["CCC", "AAA", "BBB"], ["AAA", "BBB", "CCC"]);
    const first = getCountriesInOrder(state);
    const second = getCountriesInOrder(state);

    expect(Object.keys(state.countriesById)).toEqual(["AAA", "BBB", "CCC"]);
    expect(first.map((item) => item.id)).toEqual(["AAA", "BBB", "CCC"]);
    expect(Object.is(first, second)).toBe(true);
    expect(selectCountriesInOrder(state).map((item) => item.id)).toEqual([
      "AAA",
      "BBB",
      "CCC",
    ]);
  });

  it("keeps create, delete, and rollback order hashes deterministic", () => {
    const first = runSequence(testWorldState(["AAA", "BBB", "CCC"]));
    const second = runSequence(testWorldState(["CCC", "AAA", "BBB"], ["AAA", "BBB", "CCC"]));

    expect(first.ids).toEqual([
      ["AAA", "BBB", "CCC"],
      ["AAA", "BBB", "CCC", "NEW"],
      ["AAA", "CCC", "NEW"],
      ["AAA", "BBB", "CCC", "NEW"],
    ]);
    expect(second.ids).toEqual(first.ids);
    expect(second.hashes).toEqual(first.hashes);
  });

  it("updates a real React selector through create, delete, and rollback without render loops", () => {
    const controller = createWorldStateStore(
      testWorldState(["CCC", "AAA", "BBB"], ["AAA", "BBB", "CCC"]),
    );
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    let renders = 0;

    function CountryListProbe() {
      renders += 1;
      const countries = useWorldStateSelector(controller.store, selectCountriesInOrder);
      return createElement(
        "output",
        {"data-testid": "country-list"},
        countries.map((item) => item.id).join(","),
      );
    }

    try {
      render(createElement(CountryListProbe));
      expect(screen.getByTestId("country-list")).toHaveTextContent("AAA,BBB,CCC");

      const created = addCountry(controller.store.getState(), testCountry("NEW"));
      act(() => controller.replaceWorldState(created, testCommit(created)));
      expect(screen.getByTestId("country-list")).toHaveTextContent("AAA,BBB,CCC,NEW");

      const deletion = removeCountry(controller.store.getState(), "BBB");
      act(() => controller.replaceWorldState(deletion, testCommit(deletion, testCommit(created).commitHash)));
      expect(screen.getByTestId("country-list")).toHaveTextContent("AAA,CCC,NEW");

      const rollbackState = withNextRevision(created, deletion.revision + 1);
      act(() =>
        controller.replaceWorldState(
          rollbackState,
          testCommit(rollbackState, testCommit(deletion).commitHash),
        ),
      );
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
