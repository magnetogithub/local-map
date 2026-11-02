import {describe, expect, it} from "vitest";

import {createCountryIdRegistry, issueCountryId, type ActiveCountryId} from "./country-id";
import {addCountryToOrder, createCountryOrder, removeCountryFromOrder} from "./country-order";

const active = (value: string) =>
  issueCountryId(
    value,
    createCountryIdRegistry({activeCountryIds: [], retiredCountryIds: []}),
  );

describe("10-14 deterministic countryOrder", () => {
  const AAA = active("AAA");
  const BBB = active("BBB");
  const CCC = active("CCC");

  it("creates one canonical order regardless of input insertion order", () => {
    expect(createCountryOrder([CCC, AAA, BBB])).toEqual([AAA, BBB, CCC]);
    expect(createCountryOrder([BBB, CCC, AAA])).toEqual([AAA, BBB, CCC]);
  });

  it("does not depend on record insertion order", () => {
    const forward: Record<string, true> = {};
    const reverse: Record<string, true> = {};
    for (const id of [AAA, BBB, CCC]) forward[id] = true;
    for (const id of [CCC, BBB, AAA]) reverse[id] = true;

    expect(createCountryOrder(Object.keys(forward) as ActiveCountryId[])).toEqual(
      createCountryOrder(Object.keys(reverse) as ActiveCountryId[]),
    );
  });

  it("uses the same deterministic rule when countries are created", () => {
    const first = addCountryToOrder(addCountryToOrder(createCountryOrder([BBB]), CCC), AAA);
    const second = addCountryToOrder(addCountryToOrder(createCountryOrder([BBB]), AAA), CCC);

    expect(first).toEqual([AAA, BBB, CCC]);
    expect(second).toEqual(first);
    expect(Object.isFrozen(first)).toBe(true);
  });

  it("removes a country without changing the relative canonical order", () => {
    expect(removeCountryFromOrder(createCountryOrder([CCC, AAA, BBB]), BBB)).toEqual([
      AAA,
      CCC,
    ]);
  });

  it("rejects duplicate creation and deletion of an absent country", () => {
    const order = createCountryOrder([AAA, BBB]);

    expect(() => addCountryToOrder(order, AAA)).toThrowError(
      expect.objectContaining({code: "duplicate-country-order-id"}),
    );
    expect(() => removeCountryFromOrder(order, CCC)).toThrowError(
      expect.objectContaining({code: "missing-country-order-id"}),
    );
  });
});
