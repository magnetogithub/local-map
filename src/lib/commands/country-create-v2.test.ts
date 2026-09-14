import {describe, expect, it} from "vitest";

import {
  countryCreateV2CommandSchema,
  parseCountryCreateV2Command,
  safeParseCountryCreateV2Command,
} from "./country-create-v2";

const countryIdentityInput = () => ({
  id: "AAA",
  names: {
    shortKo: "예시국",
    officialKo: "예시 공화국",
    mapKo: "예시국",
    english: "Example Republic",
    searchAliases: ["AAA", "Example"],
  },
  politicalStatus: "sovereign",
  presentationOverride: null,
  moduleVersions: {core: 1, names: 1},
});

const countryCreateV2Input = () => ({
  commandId: "create-aaa",
  type: "country.create",
  expectedRevision: 4,
  payload: {country: countryIdentityInput()},
});

describe("10-32 country.create v2 schema", () => {
  it("parses a Territory-free Country identity", () => {
    const parsed = parseCountryCreateV2Command(countryCreateV2Input());

    expect(parsed).toEqual(countryCreateV2Input());
    expect(Object.keys(parsed.payload.country).sort()).toEqual([
      "id",
      "moduleVersions",
      "names",
      "politicalStatus",
      "presentationOverride",
    ]);
  });

  it.each(["geometry", "territoryGeometry"])(
    "rejects geometry inside the Country identity: %s",
    (field) => {
      const input = countryCreateV2Input();
      expect(
        safeParseCountryCreateV2Command({
          ...input,
          payload: {country: {...input.payload.country, [field]: {type: "Polygon"}}},
        }).success,
      ).toBe(false);
    },
  );

  it.each(["geometry", "initialPresentation", "presentation"])(
    "rejects the duplicate or forbidden payload path: %s",
    (field) => {
      const input = countryCreateV2Input();
      expect(
        safeParseCountryCreateV2Command({
          ...input,
          payload: {...input.payload, [field]: {}},
        }).success,
      ).toBe(false);
    },
  );

  it("accepts the sole reviewed presentationOverride path", () => {
    const input = countryCreateV2Input();
    const withOverride = {
      ...input,
      payload: {
        country: {
          ...input.payload.country,
          presentationOverride: {
            center: [127.5, 36.5],
            policyVersion: "presentation-v2",
            reason: "Reviewed anchor.",
          },
        },
      },
    };

    expect(countryCreateV2CommandSchema.safeParse(withOverride).success).toBe(true);
  });

  it("rejects unknown identity, names, and presentation override fields", () => {
    const input = countryCreateV2Input();
    expect(
      safeParseCountryCreateV2Command({
        ...input,
        payload: {country: {...input.payload.country, playable: true}},
      }).success,
    ).toBe(false);
    expect(
      safeParseCountryCreateV2Command({
        ...input,
        payload: {
          country: {
            ...input.payload.country,
            names: {...input.payload.country.names, unknownName: "no"},
          },
        },
      }).success,
    ).toBe(false);
  });

  it("rejects an incorrect command type and invalid module versions", () => {
    const input = countryCreateV2Input();
    expect(safeParseCountryCreateV2Command({...input, type: "country.rename"}).success).toBe(false);
    expect(
      safeParseCountryCreateV2Command({
        ...input,
        payload: {country: {...input.payload.country, moduleVersions: {core: -1}}},
      }).success,
    ).toBe(false);
  });
});
