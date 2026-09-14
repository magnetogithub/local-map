import {act, render, screen} from "@testing-library/react";
import {describe, expect, it} from "vitest";
import {
  replaceCountryNames,
  type CountryEntity,
  type WorldState,
} from "@/lib/world/world-state";
import {
  createWorldStateStore,
  selectWorldCountryOrder,
  selectWorldRevision,
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

const initialWorldState = (): WorldState => ({
  schemaVersion: 1,
  revision: 0,
  countriesById: {AAA: country("AAA"), BBB: country("BBB")},
  countryOrder: ["AAA", "BBB"],
});

describe("9-6 canonical WorldState store", () => {
  it("exposes a read-only store surface and canonical selectors", () => {
    const controller = createWorldStateStore(initialWorldState());

    expect(Object.keys(controller.store).sort()).toEqual([
      "getInitialState",
      "getState",
      "subscribe",
    ]);
    expect(selectWorldRevision(controller.store.getState())).toBe(0);
    expect(selectWorldCountryOrder(controller.store.getState())).toEqual(["AAA", "BBB"]);
  });

  it("publishes one subscriber notification for one country revision", () => {
    const controller = createWorldStateStore(initialWorldState());
    const notifications: Array<[number, number]> = [];
    const unsubscribe = controller.store.subscribe((state, previous) => {
      notifications.push([previous.revision, state.revision]);
    });
    const next = replaceCountryNames(controller.store.getState(), "AAA", {
      ...controller.store.getState().countriesById.AAA.names,
      mapKo: "Renamed AAA",
    });

    controller.replaceWorldState(next);
    controller.replaceWorldState(next);
    unsubscribe();

    expect(notifications).toEqual([[0, 1]]);
    expect(controller.store.getState()).toBe(next);
  });

  it("does not rerender an unrelated UI selector after a country rename", () => {
    const controller = createWorldStateStore(initialWorldState());
    let orderRenders = 0;
    let revisionRenders = 0;

    function OrderProbe() {
      orderRenders += 1;
      const order = useWorldStateSelector(controller.store, selectWorldCountryOrder);
      return <output data-testid="order">{order.join(",")}</output>;
    }

    function RevisionProbe() {
      revisionRenders += 1;
      const revision = useWorldStateSelector(controller.store, selectWorldRevision);
      return <output data-testid="revision">{revision}</output>;
    }

    render(
      <>
        <OrderProbe />
        <RevisionProbe />
      </>,
    );
    act(() => {
      controller.replaceWorldState(
        replaceCountryNames(controller.store.getState(), "AAA", {
          ...controller.store.getState().countriesById.AAA.names,
          mapKo: "Renamed AAA",
        }),
      );
    });

    expect(screen.getByTestId("order")).toHaveTextContent("AAA,BBB");
    expect(screen.getByTestId("revision")).toHaveTextContent("1");
    expect(orderRenders).toBe(1);
    expect(revisionRenders).toBe(2);
  });

  it("rejects a distinct state that reuses the current revision", () => {
    const controller = createWorldStateStore(initialWorldState());
    const invalid = {
      ...controller.store.getState(),
      countriesById: {...controller.store.getState().countriesById},
    };

    expect(() => controller.replaceWorldState(invalid)).toThrow(/requires the next revision/);
    expect(controller.store.getState().revision).toBe(0);
  });
});
