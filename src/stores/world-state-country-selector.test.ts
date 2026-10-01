import {describe, expect, it} from "vitest";
import {
  createWorldStateStore,
  getCountryById,
  selectCountryById,
} from "./world-state-store";
import {
  addCountry,
  removeCountry,
  testCommit,
  testCountry,
  testWorldState,
} from "./world-state-store-v2-fixture";

describe("9-7 dynamic getCountryById selector", () => {
  it("returns a newly created country immediately from the committed revision", () => {
    const controller = createWorldStateStore(testWorldState(["USA"]));
    const synthetic = testCountry("D01");
    const selector = selectCountryById(synthetic.id);

    expect(getCountryById(controller.store.getState(), synthetic.id)).toBeNull();
    expect(selector(controller.store.getState())).toBeNull();

    const created = addCountry(controller.store.getState(), synthetic);
    controller.replaceWorldState(created, testCommit(created));

    expect(getCountryById(controller.store.getState(), synthetic.id)).toStrictEqual(synthetic);
    expect(selector(controller.store.getState())).toStrictEqual(synthetic);
  });

  it("returns null immediately after deletion without a static-index fallback", () => {
    const controller = createWorldStateStore(testWorldState(["USA"]));
    expect(getCountryById(controller.store.getState(), "USA")?.id).toBe("USA");

    const deleted = removeCountry(controller.store.getState(), "USA");
    controller.replaceWorldState(deleted, testCommit(deleted));

    expect(getCountryById(controller.store.getState(), "USA")).toBeNull();
    expect(selectCountryById("USA")(controller.store.getState())).toBeNull();
  });
});
