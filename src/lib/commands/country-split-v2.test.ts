import {describe, expect, it} from "vitest";

import {deriveTerritoryId} from "@/lib/world/territory-id";

import {parseCountrySplitV2Command, safeParseCountrySplitV2Command} from "./country-split-v2";

const territoryId = deriveTerritoryId({
  kind: "seed",
  seedVersion: "v2",
  sourceFeatureId: "whole-island",
});
const country = (id: string) => ({
  id,
  names: {
    shortKo: id,
    officialKo: `${id} Republic`,
    mapKo: id,
    english: `${id} Republic`,
    searchAliases: [id],
  },
  politicalStatus: "sovereign",
  presentationOverride: null,
  moduleVersions: {core: 1, names: 1},
});
const command = () => ({
  commandId: "split-old",
  type: "country.split",
  expectedRevision: 18,
  payload: {
    sourceCountryId: "OLD",
    resultCountries: [
      {
        country: country("WEST"),
        territorySources: [
          {kind: "partition-result", commandId: "partition-main", partitionKey: "west"},
        ],
      },
      {
        country: country("EAST"),
        territorySources: [
          {kind: "partition-result", commandId: "partition-main", partitionKey: "east"},
          {kind: "territory-id", territoryId},
        ],
      },
    ],
  },
});

describe("10-42 country.split v2 schema", () => {
  it("parses source Country, result identities, and Territory references", () => {
    expect(parseCountrySplitV2Command(command())).toEqual(command());
  });

  it("leaves area conservation, duplicate references, and source removal to the planner", () => {
    const input = command();
    const duplicate = {
      ...input,
      payload: {
        ...input.payload,
        resultCountries: input.payload.resultCountries.map((result) => ({
          ...result,
          territorySources: [input.payload.resultCountries[0].territorySources[0]],
        })),
      },
    };

    expect(() => parseCountrySplitV2Command(duplicate)).not.toThrow();
    expect("sourceGeometry" in input.payload).toBe(false);
  });

  it("requires at least two result Countries and one Territory source per result", () => {
    const input = command();
    expect(
      safeParseCountrySplitV2Command({
        ...input,
        payload: {...input.payload, resultCountries: input.payload.resultCountries.slice(0, 1)},
      }).success,
    ).toBe(false);
    expect(
      safeParseCountrySplitV2Command({
        ...input,
        payload: {
          ...input.payload,
          resultCountries: [
            {...input.payload.resultCountries[0], territorySources: []},
            input.payload.resultCountries[1],
          ],
        },
      }).success,
    ).toBe(false);
  });

  it("rejects malformed source Country and partition references", () => {
    const input = command();
    expect(
      safeParseCountrySplitV2Command({
        ...input,
        payload: {...input.payload, sourceCountryId: " OLD"},
      }).success,
    ).toBe(false);
    expect(
      safeParseCountrySplitV2Command({
        ...input,
        payload: {
          ...input.payload,
          resultCountries: [
            {
              ...input.payload.resultCountries[0],
              territorySources: [
                {kind: "partition-result", commandId: "partition-main", partitionKey: ""},
              ],
            },
            input.payload.resultCountries[1],
          ],
        },
      }).success,
    ).toBe(false);
  });

  it.each(["sourceGeometry", "areaTolerance", "removeSource", "worldState"])(
    "rejects planner-owned payload field %s",
    (field) => {
      const input = command();
      expect(
        safeParseCountrySplitV2Command({
          ...input,
          payload: {...input.payload, [field]: true},
        }).success,
      ).toBe(false);
    },
  );
});
