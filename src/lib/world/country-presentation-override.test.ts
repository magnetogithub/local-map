import {describe, expect, expectTypeOf, it} from "vitest";

import {
  createCountryPresentationOverride,
  type CountryPresentationOverride,
} from "./country-presentation-override";

describe("10-9 CountryPresentationOverride", () => {
  it("creates one explicit override with policy provenance", () => {
    const center = [127.5, 36.5];
    const labelAnchor = [127.6, 36.6];
    const override = createCountryPresentationOverride({
      center,
      labelAnchor,
      defaultZoom: 5,
      labelScale: 0.9,
      policyVersion: "presentation-v1",
      reason: "Dense labels require a reviewed anchor.",
    });

    center[0] = 0;
    labelAnchor[1] = 0;

    expect(override).toEqual({
      center: [127.5, 36.5],
      labelAnchor: [127.6, 36.6],
      defaultZoom: 5,
      labelScale: 0.9,
      policyVersion: "presentation-v1",
      reason: "Dense labels require a reviewed anchor.",
    });
    expect(Object.isFrozen(override)).toBe(true);
    expect(Object.isFrozen(override.center)).toBe(true);
    expect(Object.isFrozen(override.labelAnchor)).toBe(true);
  });

  it.each(["presentation", "initialPresentation"])(
    "rejects the duplicate input path %s",
    (field) => {
      expect(() =>
        createCountryPresentationOverride({
          policyVersion: "presentation-v1",
          reason: "Reviewed exception.",
          center: [0, 0],
          [field]: {center: [1, 1]},
        }),
      ).toThrow(/unknown/);
    },
  );

  it("requires at least one manual value in addition to provenance", () => {
    expect(() =>
      createCountryPresentationOverride({
        policyVersion: "presentation-v1",
        reason: "No actual override.",
      }),
    ).toThrow(/at least one/);
  });

  it("requires a non-empty reason and policy version", () => {
    expect(() =>
      createCountryPresentationOverride({
        center: [0, 0],
        policyVersion: " ",
        reason: "Reviewed exception.",
      }),
    ).toThrow(/policyVersion/);
    expect(() =>
      createCountryPresentationOverride({
        center: [0, 0],
        policyVersion: "presentation-v1",
        reason: "",
      }),
    ).toThrow(/reason/);
  });

  it("keeps automatic presentation fields outside the override type", () => {
    expectTypeOf<keyof CountryPresentationOverride>().toEqualTypeOf<
      | "center"
      | "defaultZoom"
      | "labelAnchor"
      | "labelScale"
      | "policyVersion"
      | "reason"
    >();
  });
});
