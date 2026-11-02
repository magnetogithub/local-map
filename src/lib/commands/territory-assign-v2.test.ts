import {describe, expect, it} from "vitest";

import {deriveTerritoryId} from "@/lib/world/territory-id";

import {
  parseTerritoryAssignV2Command,
  safeParseTerritoryAssignV2Command,
} from "./territory-assign-v2";

const territoryId = deriveTerritoryId({
  kind: "seed",
  seedVersion: "v2",
  sourceFeatureId: "unclaimed-island",
});
const command = () => ({
  commandId: "assign-island",
  type: "territory.assign",
  expectedRevision: 14,
  payload: {
    territoryId,
    targetCountryId: "AAA",
  },
});

describe("10-38 territory.assign v2 schema", () => {
  it("parses exactly one Territory ID and target Country ID", () => {
    const parsed = parseTerritoryAssignV2Command(command());

    expect(parsed).toEqual(command());
    expect(Object.keys(parsed.payload).sort()).toEqual(["targetCountryId", "territoryId"]);
  });

  it("does not require current ownership or target Country existence inputs", () => {
    expect(() => parseTerritoryAssignV2Command(command())).not.toThrow();
  });

  it.each([
    ["malformed TerritoryId", "territory:seed:broken", "AAA"],
    ["blank target CountryId", territoryId, ""],
    ["padded target CountryId", territoryId, " AAA"],
  ] as const)("rejects %s", (_label, candidateTerritoryId, targetCountryId) => {
    const input = command();
    expect(
      safeParseTerritoryAssignV2Command({
        ...input,
        payload: {territoryId: candidateTerritoryId, targetCountryId},
      }).success,
    ).toBe(false);
  });

  it.each([
    ["ownerCountryId", null],
    ["currentOwnerCountryId", null],
    ["ifAlreadyOwned", "transfer"],
    ["ifTargetMissing", "ignore"],
    ["worldState", {countriesById: {}, territoriesById: {}}],
    ["geometry", {type: "Polygon", coordinates: []}],
  ] as const)("rejects planner-owned payload field %s", (field, value) => {
    const input = command();
    expect(
      safeParseTerritoryAssignV2Command({
        ...input,
        payload: {...input.payload, [field]: value},
      }).success,
    ).toBe(false);
  });

  it("rejects an incorrect command type and top-level audit metadata", () => {
    expect(
      safeParseTerritoryAssignV2Command({...command(), type: "territory.transfer"}).success,
    ).toBe(false);
    expect(
      safeParseTerritoryAssignV2Command({...command(), source: "unit-test"}).success,
    ).toBe(false);
  });
});
