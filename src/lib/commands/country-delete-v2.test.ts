import {describe, expect, it} from "vitest";

import {
  parseCountryDeleteV2Command,
  safeParseCountryDeleteV2Command,
} from "./country-delete-v2";

const command = () => ({
  commandId: "delete-aaa",
  type: "country.delete",
  expectedRevision: 8,
  payload: {countryId: "AAA"},
});

describe("10-35 country.delete v2 schema", () => {
  it("parses only the low-level Country identity deletion payload", () => {
    const parsed = parseCountryDeleteV2Command(command());

    expect(parsed).toEqual(command());
    expect(Object.keys(parsed.payload)).toEqual(["countryId"]);
  });

  it.each([
    ["policy", {ifMissing: "ignore"}],
    ["ifMissing", "ignore"],
    ["silentMissing", true],
    ["allowEmptyWorld", true],
    ["allow-empty-world", true],
    ["ifLastCountry", "allow-empty-world"],
    ["disposition", "unclaim"],
    ["territoryDisposition", []],
    ["territoryIds", []],
  ] as const)("rejects the forbidden payload field %s", (field, value) => {
    const input = command();
    expect(
      safeParseCountryDeleteV2Command({
        ...input,
        payload: {...input.payload, [field]: value},
      }).success,
    ).toBe(false);
  });

  it.each(["", " ", " AAA"])("rejects a non-canonical countryId: %j", (countryId) => {
    const input = command();
    expect(
      safeParseCountryDeleteV2Command({...input, payload: {countryId}}).success,
    ).toBe(false);
  });

  it("does not require WorldState, ownership, or last-country inputs", () => {
    expect(() => parseCountryDeleteV2Command(command())).not.toThrow();
  });

  it("rejects an incorrect command type and top-level audit policy", () => {
    expect(safeParseCountryDeleteV2Command({...command(), type: "country.dissolve"}).success)
      .toBe(false);
    expect(safeParseCountryDeleteV2Command({...command(), source: "unit-test"}).success)
      .toBe(false);
  });
});
