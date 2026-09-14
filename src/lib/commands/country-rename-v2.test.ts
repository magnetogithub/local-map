import {describe, expect, it} from "vitest";

import {
  parseCountryRenameV2Command,
  safeParseCountryRenameV2Command,
} from "./country-rename-v2";

const command = (changes: Record<string, unknown>) => ({
  commandId: "rename-aaa",
  type: "country.rename",
  expectedRevision: 5,
  payload: {countryId: "AAA", changes},
});

describe("10-34 country.rename v2 schema", () => {
  it.each([
    ["shortKo", "새 이름"],
    ["officialKo", "새 공식 명칭"],
    ["mapKo", "새 지도명"],
    ["english", "New Name"],
    ["searchAliases", ["NEW", "New Name"]],
  ] as const)("accepts the explicit name field %s", (field, value) => {
    expect(parseCountryRenameV2Command(command({[field]: value})).payload.changes).toEqual({
      [field]: value,
    });
  });

  it.each([{}, {english: undefined}])("rejects an empty changes patch: %j", (changes) => {
    expect(safeParseCountryRenameV2Command(command(changes)).success).toBe(false);
  });

  it.each(["aliases", "name", "nameKo", "iso3", "presentation", "geometry"])(
    "rejects the unknown or non-name field %s",
    (field) => {
      expect(safeParseCountryRenameV2Command(command({[field]: "forbidden"})).success).toBe(false);
    },
  );

  it("rejects unknown fields even when an allowed field is present", () => {
    expect(
      safeParseCountryRenameV2Command(command({english: "Valid", aliases: ["unknown"]})).success,
    ).toBe(false);
  });

  it.each(["", " ", " padded "])("rejects a non-canonical text value: %j", (english) => {
    expect(safeParseCountryRenameV2Command(command({english})).success).toBe(false);
  });

  it("allows an empty search alias list but rejects invalid alias text", () => {
    expect(safeParseCountryRenameV2Command(command({searchAliases: []})).success).toBe(true);
    expect(
      safeParseCountryRenameV2Command(command({searchAliases: ["valid", " "]})).success,
    ).toBe(false);
  });

  it("rejects an incorrect command type and unknown payload fields", () => {
    const input = command({english: "New Name"});
    expect(safeParseCountryRenameV2Command({...input, type: "country.create"}).success).toBe(false);
    expect(
      safeParseCountryRenameV2Command({
        ...input,
        payload: {...input.payload, ifMissing: "ignore"},
      }).success,
    ).toBe(false);
  });
});
