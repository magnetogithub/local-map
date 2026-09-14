import {describe, expect, it} from "vitest";

import {deriveTerritoryId} from "@/lib/world/territory-id";

import {
  parseCountryEstablishV2Command,
  safeParseCountryEstablishV2Command,
} from "./country-establish-v2";

const country = () => ({
  id: "NEW",
  names: {
    shortKo: "신생국",
    officialKo: "신생 공화국",
    mapKo: "신생국",
    english: "New Republic",
    searchAliases: ["NEW"],
  },
  politicalStatus: "sovereign",
  presentationOverride: null,
  moduleVersions: {core: 1, names: 1},
});
const territory = (sourceFeatureId: string) =>
  deriveTerritoryId({kind: "seed", seedVersion: "v2", sourceFeatureId});
const command = () => ({
  commandId: "establish-new",
  type: "country.establish",
  expectedRevision: 10,
  payload: {
    country: country(),
    territoryIds: [territory("alpha"), territory("beta")],
  },
});
const invalidTerritoryIdLists: unknown[][] = [
  [],
  ["territory:seed:broken"],
  [" alpha "],
];

describe("10-33 country.establish v2 schema", () => {
  it("parses a new Country identity and structurally valid TerritoryId list", () => {
    expect(parseCountryEstablishV2Command(command())).toEqual(command());
  });

  it("does not require or query current Territory ownership", () => {
    const input = command();

    expect(() => parseCountryEstablishV2Command(input)).not.toThrow();
    expect(Object.keys(input.payload).sort()).toEqual(["country", "territoryIds"]);
  });

  it.each(invalidTerritoryIdLists)(
    "rejects an empty or malformed TerritoryId list: %j",
    (territoryIds) => {
      const input = command();
      expect(
        safeParseCountryEstablishV2Command({
          ...input,
          payload: {...input.payload, territoryIds},
        }).success,
      ).toBe(false);
    },
  );

  it("rejects embedded ownership, geometry, and WorldState data", () => {
    const input = command();
    for (const extra of [
      {ownerCountryId: null},
      {geometry: {type: "Polygon"}},
      {worldState: {territoriesById: {}}},
    ]) {
      expect(
        safeParseCountryEstablishV2Command({
          ...input,
          payload: {...input.payload, ...extra},
        }).success,
      ).toBe(false);
    }
  });

  it("rejects geometry inside the new Country identity", () => {
    const input = command();
    expect(
      safeParseCountryEstablishV2Command({
        ...input,
        payload: {
          ...input.payload,
          country: {...input.payload.country, geometry: {type: "Polygon"}},
        },
      }).success,
    ).toBe(false);
  });
});
