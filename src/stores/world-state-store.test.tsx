import {act, render, screen} from "@testing-library/react";
import {describe, expect, it} from "vitest";
import {
  createWorldStateStore,
  selectWorldCountryOrder,
  selectWorldRevision,
  useWorldStateSelector,
} from "./world-state-store";
import {
  replaceCountry,
  testCommit,
  testCountry,
  testWorldState,
} from "./world-state-store-v2-fixture";

describe("9-6 canonical WorldState store", () => {
  it("exposes a read-only store surface and canonical selectors", () => {
    const controller = createWorldStateStore(testWorldState(["AAA", "BBB"]));

    expect(Object.keys(controller.store).sort()).toEqual([
      "getInitialState",
      "getState",
      "subscribe",
    ]);
    expect(selectWorldRevision(controller.store.getState())).toBe(0);
    expect(selectWorldCountryOrder(controller.store.getState())).toEqual(["AAA", "BBB"]);
  });

  it("publishes one subscriber notification for one country revision", () => {
    const controller = createWorldStateStore(testWorldState(["AAA", "BBB"]));
    const notifications: Array<[number, number]> = [];
    const unsubscribe = controller.store.subscribe((state, previous) => {
      notifications.push([previous.revision, state.revision]);
    });
    const next = replaceCountry(controller.store.getState(), testCountry("AAA", "Renamed AAA"));

    controller.replaceWorldState(next, testCommit(next));
    controller.replaceWorldState(next, testCommit(next));
    unsubscribe();

    expect(notifications).toEqual([[0, 1]]);
    expect(controller.store.getState()).toBe(next);
  });

  it("does not rerender an unrelated UI selector after a country rename", () => {
    const controller = createWorldStateStore(testWorldState(["AAA", "BBB"]));
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
      const next = replaceCountry(controller.store.getState(), testCountry("AAA", "Renamed AAA"));
      controller.replaceWorldState(next, testCommit(next));
    });

    expect(screen.getByTestId("order")).toHaveTextContent("AAA,BBB");
    expect(screen.getByTestId("revision")).toHaveTextContent("1");
    expect(orderRenders).toBe(1);
    expect(revisionRenders).toBe(2);
  });

  it("rejects a distinct state that reuses the current revision", () => {
    const controller = createWorldStateStore(testWorldState(["AAA", "BBB"]));
    const invalid = {
      ...controller.store.getState(),
      countriesById: {...controller.store.getState().countriesById},
    };

    expect(() =>
      controller.replaceWorldState(invalid, testCommit(invalid)),
    ).toThrow(/requires the next revision/);
    expect(controller.store.getState().revision).toBe(0);
  });
});
