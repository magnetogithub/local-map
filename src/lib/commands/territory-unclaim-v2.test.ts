import {describe, expect, it} from "vitest";

import {deriveTerritoryId} from "@/lib/world/territory-id";

import {
  parseTerritoryUnclaimV2Command,
  safeParseTerritoryUnclaimV2Command,
} from "./territory-unclaim-v2";

const territory = (sourceFeatureId: string) =>
  deriveTerritoryId({kind: "seed", seedVersion: "v2", sourceFeatureId});
const command = () => ({
  commandId: "unclaim-borderlands",
  type: "territory.unclaim",
  expectedRevision: 15,
  payload: {
    territoryIds: [territory("north"), territory("south")],
  },
});

describe("10-39 territory.unclaim v2 schema", () => {
  it("parses a non-empty Territory ID list as the complete payload", () => {
    const parsed = parseTerritoryUnclaimV2Command(command());

    expect(parsed).toEqual(command());
    expect(Object.keys(parsed.payload)).toEqual(["territoryIds"]);
  });

  it("does not require owner or current WorldState inputs", () => {
    expect(() => parseTerritoryUnclaimV2Command(command())).not.toThrow();
  });

  it("rejects an empty Territory ID list", () => {
    const input = command();
    expect(
      safeParseTerritoryUnclaimV2Command({
        ...input,
        payload: {territoryIds: []},
      }).success,
    ).toBe(false);
  });

  it.each(["territory:seed:broken", "", " territory"])(
    "rejects malformed TerritoryId %j",
    (territoryId) => {
      const input = command();
      expect(
        safeParseTerritoryUnclaimV2Command({
          ...input,
          payload: {territoryIds: [territoryId]},
        }).success,
      ).toBe(false);
    },
  );

  it.each([
    ["ownerCountryId", "AAA"],
    ["targetCountryId", null],
    ["ifAlreadyUnclaimed", "ignore"],
    ["silentMissing", true],
    ["worldState", {territoriesById: {}}],
    ["geometry", {type: "Polygon", coordinates: []}],
  ] as const)("rejects unknown payload field %s", (field, value) => {
    const input = command();
    expect(
      safeParseTerritoryUnclaimV2Command({
        ...input,
        payload: {...input.payload, [field]: value},
      }).success,
    ).toBe(false);
  });

  it("rejects an incorrect command type and top-level audit metadata", () => {
    expect(
      safeParseTerritoryUnclaimV2Command({...command(), type: "territory.assign"}).success,
    ).toBe(false);
    expect(
      safeParseTerritoryUnclaimV2Command({...command(), source: "unit-test"}).success,
    ).toBe(false);
  });
});
