import {describe, expect, it} from "vitest";

import {
  assertPlainCommandDataTree,
  plainCommandDataV2Schema,
} from "./plain-command-data-v2";

describe("10-31~10-45 plain command data boundary", () => {
  it("accepts ordinary and null-prototype JSON-compatible trees", () => {
    const nullRecord = Object.assign(Object.create(null), {countryId: "AAA"});

    expect(plainCommandDataV2Schema.safeParse({payload: [nullRecord]}).success).toBe(true);
  });

  it.each([
    new Date(0),
    new Map(),
    new Set(),
    new Uint8Array(0),
    Object.create({inherited: true}),
  ])("rejects a custom-prototype or exotic object: %#", (input) => {
    expect(plainCommandDataV2Schema.safeParse(input).success).toBe(false);
  });

  it("rejects accessors without executing getters", () => {
    let getterCalls = 0;
    const input = {} as Record<string, unknown>;
    Object.defineProperty(input, "payload", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return {};
      },
    });

    expect(plainCommandDataV2Schema.safeParse(input).success).toBe(false);
    expect(getterCalls).toBe(0);
  });

  it("rejects symbol and non-enumerable properties at any depth", () => {
    const withSymbol = {nested: {}} as {nested: {[key: symbol]: unknown}};
    withSymbol.nested[Symbol("secret")] = true;
    const withHidden = {nested: {}};
    Object.defineProperty(withHidden.nested, "secret", {value: true, enumerable: false});

    expect(plainCommandDataV2Schema.safeParse(withSymbol).success).toBe(false);
    expect(plainCommandDataV2Schema.safeParse(withHidden).success).toBe(false);
  });

  it("rejects sparse arrays, decorated arrays, and circular references", () => {
    const sparse = Array(2) as unknown[];
    sparse[1] = "value";
    const decorated = ["value"] as unknown[] & {extra?: unknown};
    decorated.extra = true;
    const circular: {self?: unknown} = {};
    circular.self = circular;

    expect(plainCommandDataV2Schema.safeParse(sparse).success).toBe(false);
    expect(plainCommandDataV2Schema.safeParse(decorated).success).toBe(false);
    expect(plainCommandDataV2Schema.safeParse(circular).success).toBe(false);
  });

  it("allows repeated references that are not circular and never mutates input", () => {
    const shared = {countryId: "AAA"};
    const input = {left: shared, right: shared};
    const prototypeBefore = Object.getPrototypeOf(input);

    expect(() => assertPlainCommandDataTree(input)).not.toThrow();
    expect(input.left).toBe(shared);
    expect(input.right).toBe(shared);
    expect(Object.getPrototypeOf(input)).toBe(prototypeBefore);
  });
});
