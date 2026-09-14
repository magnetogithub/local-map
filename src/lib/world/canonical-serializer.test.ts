import {describe, expect, it, vi} from "vitest";

import {
  canonicalSerialize,
  canonicalStringify,
} from "./canonical-serializer";

const bytes = (value: unknown) => [...canonicalSerialize(value)];

describe("10-20 canonical primitive serializer", () => {
  it("produces the same bytes for every object insertion order", () => {
    const first = {
      zebra: null,
      alpha: {truth: true, count: 1234.5},
      list: ["한글", false, 0],
    };
    const second = {
      list: ["한글", false, -0],
      alpha: {count: 1234.5, truth: true},
      zebra: null,
    };

    expect(bytes(first)).toEqual(bytes(second));
    expect(canonicalStringify(first)).toBe(
      '{"alpha":{"count":1234.5,"truth":true},"list":["한글",false,0],"zebra":null}',
    );
  });

  it("never delegates number or key ordering to locale APIs", () => {
    const localeNumber = vi
      .spyOn(Number.prototype, "toLocaleString")
      .mockImplementation(() => {
        throw new Error("locale number formatting must not be called");
      });
    const localeCompare = vi.spyOn(String.prototype, "localeCompare").mockImplementation(() => {
      throw new Error("locale collation must not be called");
    });

    try {
      expect(canonicalStringify({ä: 1_234.5, z: 1e-7, a: true})).toBe(
        '{"a":true,"z":1e-7,"ä":1234.5}',
      );
    } finally {
      localeNumber.mockRestore();
      localeCompare.mockRestore();
    }
  });

  it("returns an exact UTF-8 byte sequence", () => {
    expect(bytes("한")).toEqual([34, 237, 149, 156, 34]);
    expect(new TextDecoder().decode(canonicalSerialize([null, true, false]))).toBe(
      "[null,true,false]",
    );
  });

  it.each([
    ["undefined", undefined],
    ["non-finite number", Number.POSITIVE_INFINITY],
    ["function", () => undefined],
    ["Map", new Map()],
    ["Date", new Date(0)],
    ["typed array", new Uint8Array([1])],
    ["symbol property", Object.assign({value: 1}, {[Symbol("hidden")]: 2})],
  ])("rejects unsupported runtime input: %s", (_name, value) => {
    expect(() => canonicalSerialize(value)).toThrow(/canonical/i);
  });

  it("rejects unsupported nested values and circular structures instead of omitting them", () => {
    expect(() => canonicalSerialize({valid: true, missing: undefined})).toThrow(/undefined/);
    expect(() => canonicalSerialize([1, , 3])).toThrow(/undefined/);

    const circular: {self?: unknown} = {};
    circular.self = circular;
    expect(() => canonicalSerialize(circular)).toThrow(/circular/);
  });
});
