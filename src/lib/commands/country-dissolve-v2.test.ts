import {describe, expect, it} from "vitest";

import {deriveTerritoryId} from "@/lib/world/territory-id";

import {
  parseCountryDissolveV2Command,
  safeParseCountryDissolveV2Command,
} from "./country-dissolve-v2";

const territory = (sourceFeatureId: string) =>
  deriveTerritoryId({kind: "seed", seedVersion: "v2", sourceFeatureId});
const command = () => ({
  commandId: "dissolve-old",
  type: "country.dissolve",
  expectedRevision: 12,
  payload: {
    sourceCountryId: "OLD",
    territoryDispositions: [
      {territoryId: territory("north"), disposition: {type: "unclaim"}},
      {
        territoryId: territory("south"),
        disposition: {type: "transfer", targetCountryId: "NEW"},
      },
      {
        territoryId: territory("island"),
        disposition: {type: "merge", targetCountryId: "ALLY"},
      },
    ],
  },
});

describe("10-36 country.dissolve v2 schema", () => {
  it("parses unclaim, transfer, and merge dispositions", () => {
    expect(parseCountryDissolveV2Command(command())).toEqual(command());
  });

  it.each(["delete", "drop", "remove", "annex", "partition"])(
    "rejects the unsupported disposition %s",
    (type) => {
      const input = command();
      expect(
        safeParseCountryDissolveV2Command({
          ...input,
          payload: {
            ...input.payload,
            territoryDispositions: [
              {territoryId: territory("north"), disposition: {type}},
            ],
          },
        }).success,
      ).toBe(false);
    },
  );

  it("requires a target Country for transfer and merge, but forbids one for unclaim", () => {
    const input = command();
    for (const disposition of [
      {type: "transfer"},
      {type: "merge"},
      {type: "unclaim", targetCountryId: "NEW"},
    ]) {
      expect(
        safeParseCountryDissolveV2Command({
          ...input,
          payload: {
            ...input.payload,
            territoryDispositions: [
              {territoryId: territory("north"), disposition},
            ],
          },
        }).success,
      ).toBe(false);
    }
  });

  it("rejects an empty disposition list and malformed identities", () => {
    const input = command();
    expect(
      safeParseCountryDissolveV2Command({
        ...input,
        payload: {...input.payload, territoryDispositions: []},
      }).success,
    ).toBe(false);
    expect(
      safeParseCountryDissolveV2Command({
        ...input,
        payload: {...input.payload, sourceCountryId: " OLD"},
      }).success,
    ).toBe(false);
    expect(
      safeParseCountryDissolveV2Command({
        ...input,
        payload: {
          ...input.payload,
          territoryDispositions: [
            {territoryId: "territory:seed:broken", disposition: {type: "unclaim"}},
          ],
        },
      }).success,
    ).toBe(false);
  });

  it("rejects geometry, policy, and WorldState data while requiring no state lookup", () => {
    const input = command();
    expect(() => parseCountryDissolveV2Command(input)).not.toThrow();
    for (const extra of [
      {geometry: {type: "Polygon"}},
      {allowEmptyWorld: true},
      {ifMissing: "ignore"},
      {worldState: {territoriesById: {}}},
    ]) {
      expect(
        safeParseCountryDissolveV2Command({
          ...input,
          payload: {...input.payload, ...extra},
        }).success,
      ).toBe(false);
    }
  });
});
