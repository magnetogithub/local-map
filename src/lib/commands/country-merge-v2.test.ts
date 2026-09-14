import {describe, expect, it} from "vitest";

import {parseCountryMergeV2Command, safeParseCountryMergeV2Command} from "./country-merge-v2";

const country = (id: string) => ({
  id,
  names: {
    shortKo: id,
    officialKo: `${id} Union`,
    mapKo: id,
    english: `${id} Union`,
    searchAliases: [id],
  },
  politicalStatus: "sovereign",
  presentationOverride: null,
  moduleVersions: {core: 1, names: 1},
});
const command = () => ({
  commandId: "merge-a-b",
  type: "country.merge",
  expectedRevision: 19,
  payload: {
    sourceCountryIds: ["AAA", "BBB"],
    resultCountry: {kind: "new-country", country: country("ABU")},
    metadataInheritance: {mode: "preserve-result"},
  },
});

describe("10-43 country.merge v2 schema", () => {
  it("parses source Countries, a new result Country, and explicit metadata policy", () => {
    expect(parseCountryMergeV2Command(command())).toEqual(command());
  });

  it("parses an existing result with explicit source-field inheritance", () => {
    const input = command();
    const existing = {
      ...input,
      payload: {
        ...input.payload,
        resultCountry: {kind: "existing-country", countryId: "AAA"},
        metadataInheritance: {
          mode: "inherit-source",
          sourceCountryId: "BBB",
          fields: ["names", "presentationOverride"],
        },
      },
    };

    expect(parseCountryMergeV2Command(existing)).toEqual(existing);
  });

  it("rejects a payload without metadata inheritance rules", () => {
    const input = command();
    const payload = {
      sourceCountryIds: input.payload.sourceCountryIds,
      resultCountry: input.payload.resultCountry,
    };

    expect(safeParseCountryMergeV2Command({...input, payload}).success).toBe(false);
  });

  it("rejects incomplete or implicit metadata inheritance", () => {
    const input = command();
    for (const metadataInheritance of [
      {mode: "inherit-source", sourceCountryId: "AAA"},
      {mode: "inherit-source", sourceCountryId: "AAA", fields: []},
      {mode: "inherit-source", sourceCountryId: "AAA", fields: ["geometry"]},
      {inheritMetadata: true},
    ]) {
      expect(
        safeParseCountryMergeV2Command({
          ...input,
          payload: {...input.payload, metadataInheritance},
        }).success,
      ).toBe(false);
    }
  });

  it("requires at least two structurally valid source Country IDs", () => {
    const input = command();
    for (const sourceCountryIds of [["AAA"], ["AAA", " BBB"], []]) {
      expect(
        safeParseCountryMergeV2Command({
          ...input,
          payload: {...input.payload, sourceCountryIds},
        }).success,
      ).toBe(false);
    }
  });

  it("rejects malformed result references and planner-owned fields", () => {
    const input = command();
    expect(
      safeParseCountryMergeV2Command({
        ...input,
        payload: {...input.payload, resultCountry: {kind: "existing-country", countryId: ""}},
      }).success,
    ).toBe(false);
    for (const field of ["transferTerritories", "removeSources", "worldState"] as const) {
      expect(
        safeParseCountryMergeV2Command({
          ...input,
          payload: {...input.payload, [field]: true},
        }).success,
      ).toBe(false);
    }
  });
});
