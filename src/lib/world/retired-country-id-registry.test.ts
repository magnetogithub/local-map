import {describe, expect, expectTypeOf, it} from "vitest";

import {
  createCountryIdRegistry,
  issueCountryId,
  type ActiveCountryId,
  type RetiredCountryId,
} from "./country-id";
import {
  confirmCountryIdDeletion,
  restoreCountryIdForUndo,
} from "./retired-country-id-registry";

describe("10-16 retiredCountryIds registry", () => {
  const registry = () =>
    createCountryIdRegistry({
      activeCountryIds: ["AAA", "BBB"],
      retiredCountryIds: ["OLD"],
    });

  it("moves a confirmed deletion from active to retired without mutating the input", () => {
    const before = registry();
    const deletion = confirmCountryIdDeletion("AAA" as ActiveCountryId, before);

    expect([...deletion.registry.activeCountryIds]).toEqual(["BBB"]);
    expect(new Set(deletion.registry.retiredCountryIds)).toEqual(new Set(["OLD", "AAA"]));
    expect(deletion.countryId).toBe("AAA");
    expectTypeOf(deletion.countryId).toEqualTypeOf<RetiredCountryId>();
    expect(new Set(before.activeCountryIds)).toEqual(new Set(["AAA", "BBB"]));
    expect(new Set(before.retiredCountryIds)).toEqual(new Set(["OLD"]));
  });

  it("rejects issuing a new country with a confirmed retired ID", () => {
    const deletion = confirmCountryIdDeletion("AAA" as ActiveCountryId, registry());

    expect(() => issueCountryId("AAA", deletion.registry)).toThrowError(
      expect.objectContaining({code: "country-id-retired"}),
    );
  });

  it("allows explicit undo to restore the same ID as active", () => {
    const deletion = confirmCountryIdDeletion("AAA" as ActiveCountryId, registry());
    const restored = restoreCountryIdForUndo(deletion.countryId, deletion.registry);

    expect(restored.countryId).toBe("AAA");
    expectTypeOf(restored.countryId).toEqualTypeOf<ActiveCountryId>();
    expect(new Set(restored.registry.activeCountryIds)).toEqual(new Set(["AAA", "BBB"]));
    expect(new Set(restored.registry.retiredCountryIds)).toEqual(new Set(["OLD"]));
  });

  it("still rejects generic issuance after undo restoration", () => {
    const deletion = confirmCountryIdDeletion("AAA" as ActiveCountryId, registry());
    const restored = restoreCountryIdForUndo(deletion.countryId, deletion.registry);

    expect(() => issueCountryId("AAA", restored.registry)).toThrowError(
      expect.objectContaining({code: "country-id-active"}),
    );
  });

  it("rejects deletion of an unknown or already-retired ID", () => {
    expect(() => confirmCountryIdDeletion("ZZZ" as ActiveCountryId, registry())).toThrowError(
      expect.objectContaining({code: "country-id-not-active"}),
    );
    expect(() => confirmCountryIdDeletion("OLD" as ActiveCountryId, registry())).toThrowError(
      expect.objectContaining({code: "country-id-already-retired"}),
    );
  });

  it("rejects undo restoration unless the ID is retired", () => {
    expect(() => restoreCountryIdForUndo("AAA" as RetiredCountryId, registry())).toThrowError(
      expect.objectContaining({code: "country-id-not-retired"}),
    );
    expect(() => restoreCountryIdForUndo("ZZZ" as RetiredCountryId, registry())).toThrowError(
      expect.objectContaining({code: "country-id-not-retired"}),
    );
  });
});
