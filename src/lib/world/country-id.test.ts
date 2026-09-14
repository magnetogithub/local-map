import {describe, expect, expectTypeOf, it} from "vitest";

import {
  createCountryIdRegistry,
  issueCountryId,
  retireCountryId,
  type ActiveCountryId,
  type RetiredCountryId,
} from "./country-id";

describe("10-6 CountryId lifecycle", () => {
  const expectInvalidCountryId = (operation: () => unknown) => {
    try {
      operation();
      throw new Error("Expected invalid CountryId rejection");
    } catch (error) {
      expect(error).toMatchObject({code: "invalid-country-id"});
    }
  };

  it.each([undefined, null, 42, "", "   "])("rejects an empty or non-string ID: %s", (value) => {
    const registry = createCountryIdRegistry({activeCountryIds: [], retiredCountryIds: []});
    expect(() => issueCountryId(value, registry)).toThrow(/non-empty string/);
  });

  it.each([" AAA ", "AAA ", "\tAAA", "AAA\n"])(
    "rejects surrounding whitespace instead of normalizing it: %j",
    (value) => {
      const registry = createCountryIdRegistry({
        activeCountryIds: ["AAA"],
        retiredCountryIds: [],
      });

      expectInvalidCountryId(() => issueCountryId(value, registry));
    },
  );

  it("rejects a whitespace variant of a retired ID as invalid input", () => {
    const registry = createCountryIdRegistry({
      activeCountryIds: [],
      retiredCountryIds: ["OLD"],
    });

    expectInvalidCountryId(() => issueCountryId(" OLD ", registry));
  });

  it("rejects surrounding whitespace in active registry input", () => {
    expectInvalidCountryId(() =>
      createCountryIdRegistry({activeCountryIds: [" AAA "], retiredCountryIds: []}),
    );
  });

  it("rejects surrounding whitespace in retired registry input", () => {
    expectInvalidCountryId(() =>
      createCountryIdRegistry({activeCountryIds: [], retiredCountryIds: [" OLD "]}),
    );
  });

  it("issues a canonical ID without changing its value", () => {
    const registry = createCountryIdRegistry({
      activeCountryIds: ["BBB"],
      retiredCountryIds: ["OLD"],
    });

    const issued = issueCountryId("AAA", registry);

    expect(issued).toBe("AAA");
    expectTypeOf(issued).toEqualTypeOf<ActiveCountryId>();
  });

  it("rejects an already-active ID", () => {
    const registry = createCountryIdRegistry({
      activeCountryIds: ["AAA"],
      retiredCountryIds: [],
    });

    expect(() => issueCountryId("AAA", registry)).toThrow(/already active/);
  });

  it("rejects reissuing a retired ID", () => {
    const registry = createCountryIdRegistry({
      activeCountryIds: [],
      retiredCountryIds: ["OLD"],
    });

    expect(() => issueCountryId("OLD", registry)).toThrow(/retired.*cannot be reissued/);
  });

  it("rejects a registry that marks one ID active and retired", () => {
    expect(() =>
      createCountryIdRegistry({
        activeCountryIds: ["AAA"],
        retiredCountryIds: ["AAA"],
      }),
    ).toThrow(/both active and retired/);
  });

  it("transitions only an active ID to the retired type without changing its value", () => {
    const active = issueCountryId(
      "AAA",
      createCountryIdRegistry({activeCountryIds: [], retiredCountryIds: []}),
    );

    const retired = retireCountryId(active);

    expect(retired).toBe("AAA");
    expectTypeOf(retired).toEqualTypeOf<RetiredCountryId>();
    expectTypeOf<ActiveCountryId>().not.toEqualTypeOf<RetiredCountryId>();
  });

  it("does not expose mutable active or retired Set storage", () => {
    const registry = createCountryIdRegistry({
      activeCountryIds: ["AAA"],
      retiredCountryIds: ["OLD"],
    });
    const activeMutation = registry.activeCountryIds as unknown as {
      delete?: (value: ActiveCountryId) => boolean;
      clear?: () => void;
    };
    const retiredMutation = registry.retiredCountryIds as unknown as {
      delete?: (value: RetiredCountryId) => boolean;
      clear?: () => void;
    };

    activeMutation.clear?.();
    retiredMutation.delete?.("OLD" as RetiredCountryId);

    expect("add" in registry.activeCountryIds).toBe(false);
    expect("delete" in registry.retiredCountryIds).toBe(false);
    expect(() => issueCountryId("AAA", registry)).toThrowError(
      expect.objectContaining({code: "country-id-active"}),
    );
    expect(() => issueCountryId("OLD", registry)).toThrowError(
      expect.objectContaining({code: "country-id-retired"}),
    );
  });

  it("copies source iterables into an immutable registry snapshot", () => {
    const activeSource = new Set(["AAA"]);
    const retiredSource = new Set(["OLD"]);
    const registry = createCountryIdRegistry({
      activeCountryIds: activeSource,
      retiredCountryIds: retiredSource,
    });

    activeSource.clear();
    retiredSource.clear();
    activeSource.add("NEW");
    retiredSource.add("OTHER");

    expect([...registry.activeCountryIds]).toEqual(["AAA"]);
    expect([...registry.retiredCountryIds]).toEqual(["OLD"]);
  });
});
