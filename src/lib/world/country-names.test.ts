import {describe, expect, it} from "vitest";

import {
  createCountryNames,
  replaceCountryNamesModule,
  updateCountryNames,
} from "./country-names";

const input = () => ({
  shortKo: "가상국",
  officialKo: "가상국 공화국",
  mapKo: "가상국",
  english: "Example Republic",
  searchAliases: ["EXA", "Example"],
});

describe("10-7 CountryNames module", () => {
  it("creates an immutable independent names module", () => {
    const source = input();
    const names = createCountryNames(source);

    source.searchAliases[0] = "MUTATED";
    source.searchAliases.push("LATE");

    expect(names).toEqual(input());
    expect(Object.isFrozen(names)).toBe(true);
    expect(Object.isFrozen(names.searchAliases)).toBe(true);
  });

  it.each([
    {...input(), shortKo: ""},
    {...input(), officialKo: "   "},
    {...input(), mapKo: ""},
    {...input(), english: ""},
    {...input(), searchAliases: ["EXA", ""]},
  ])("rejects empty name and alias fields", (value) => {
    expect(() => createCountryNames(value)).toThrow(/non-empty/);
  });

  it("updates only supplied name fields without mutating the current module", () => {
    const current = createCountryNames(input());

    const next = updateCountryNames(current, {
      mapKo: "새 가상국",
      searchAliases: ["NEW"],
    });

    expect(current).toEqual(input());
    expect(next).toEqual({...input(), mapKo: "새 가상국", searchAliases: ["NEW"]});
    expect(next).not.toBe(current);
  });

  it("replaces the names module while preserving core identity and geometry references", () => {
    const geometry = {type: "Polygon", coordinates: []};
    const entity = {id: "EXA", geometry, names: createCountryNames(input())};
    const names = updateCountryNames(entity.names, {english: "Renamed Republic"});

    const next = replaceCountryNamesModule(entity, names);

    expect(next).not.toBe(entity);
    expect(next.id).toBe(entity.id);
    expect(next.geometry).toBe(geometry);
    expect(next.names).toBe(names);
  });
});
