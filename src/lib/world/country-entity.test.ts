import {describe, expect, expectTypeOf, it} from "vitest";

import {createCountryEntity, type CountryEntity} from "./country-entity";
import {issueCountryId, createCountryIdRegistry} from "./country-id";
import {createCountryNames} from "./country-names";

const input = () => ({
  id: issueCountryId(
    "EXA",
    createCountryIdRegistry({activeCountryIds: [], retiredCountryIds: []}),
  ),
  names: createCountryNames({
    shortKo: "가상국",
    officialKo: "가상국 공화국",
    mapKo: "가상국",
    english: "Example Republic",
    searchAliases: ["EXA"],
  }),
  politicalStatus: "sovereign" as const,
  presentationOverride: null,
  moduleVersions: {core: 1, names: 1},
});

describe("10-8 CountryEntity core", () => {
  it("contains only the five minimal core fields", () => {
    const country = createCountryEntity(input());

    expect(Object.keys(country).sort()).toEqual([
      "id",
      "moduleVersions",
      "names",
      "politicalStatus",
      "presentationOverride",
    ]);
    expectTypeOf<keyof CountryEntity>().toEqualTypeOf<
      "id" | "names" | "politicalStatus" | "presentationOverride" | "moduleVersions"
    >();
  });

  it.each(["geometry", "territoryGeometry", "economy", "diplomacy", "focusTree"])(
    "rejects the forbidden core field %s",
    (field) => {
      expect(() => createCountryEntity({...input(), [field]: {}})).toThrow(/unknown or missing/);
    },
  );

  it("keeps names modular and freezes module versions", () => {
    const source = input();
    const country = createCountryEntity(source);

    source.moduleVersions.core = 99;

    expect(country.names).toEqual(input().names);
    expect(country.moduleVersions.core).toBe(1);
    expect(Object.isFrozen(country)).toBe(true);
    expect(Object.isFrozen(country.moduleVersions)).toBe(true);
  });

  it.each([-1, 1.5, Number.NaN])("rejects an invalid module version: %s", (version) => {
    expect(() => createCountryEntity({...input(), moduleVersions: {core: version}})).toThrow(
      /module version/,
    );
  });

  it.each(["presentation", "initialPresentation"])(
    "rejects the duplicate presentation path %s",
    (field) => {
      expect(() => createCountryEntity({...input(), [field]: {center: [0, 0]}})).toThrow(
        /unknown or missing/,
      );
    },
  );
});
