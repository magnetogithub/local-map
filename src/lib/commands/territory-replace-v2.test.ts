import {describe, expect, it} from "vitest";

import {deriveTerritoryId} from "@/lib/world/territory-id";

import {
  parseTerritoryReplaceV2Command,
  safeParseTerritoryReplaceV2Command,
} from "./territory-replace-v2";

const territoryId = deriveTerritoryId({
  kind: "seed",
  seedVersion: "v2",
  sourceFeatureId: "replace-me",
});
const command = () => ({
  commandId: "replace-territory",
  type: "territory.replace",
  expectedRevision: 16,
  payload: {
    territoryId,
    geometry: {
      type: "Polygon",
      coordinates: [[[0, 0], [4, 4], [0, 4], [4, 0]]],
    },
  },
});

describe("10-40 territory.replace v2 schema", () => {
  it("parses one Territory ID and complete Polygon geometry", () => {
    expect(parseTerritoryReplaceV2Command(command())).toEqual(command());
  });

  it("leaves closure, self-intersection, winding, and topology checks outside schema", () => {
    expect(() => parseTerritoryReplaceV2Command(command())).not.toThrow();
  });

  it.each([
    ["LineString", {type: "LineString", coordinates: [[0, 0], [1, 1]]}],
    ["empty Polygon", {type: "Polygon", coordinates: []}],
    ["short ring", {type: "Polygon", coordinates: [[[0, 0], [1, 0], [0, 0]]]}],
    ["non-finite coordinate", {type: "Polygon", coordinates: [[[0, 0], [1, 0], [1, Number.POSITIVE_INFINITY], [0, 0]]]}],
    ["empty MultiPolygon", {type: "MultiPolygon", coordinates: []}],
  ] as const)("rejects malformed basic geometry: %s", (_label, geometry) => {
    const input = command();
    expect(
      safeParseTerritoryReplaceV2Command({...input, payload: {...input.payload, geometry}})
        .success,
    ).toBe(false);
  });

  it("rejects malformed Territory IDs and unknown payload fields", () => {
    const input = command();
    expect(
      safeParseTerritoryReplaceV2Command({
        ...input,
        payload: {...input.payload, territoryId: "territory:seed:broken"},
      }).success,
    ).toBe(false);
    for (const extra of [
      {ownerCountryId: "AAA"},
      {geometryPolicy: "v1"},
      {tolerance: 0.001},
      {worldState: {}},
    ]) {
      expect(
        safeParseTerritoryReplaceV2Command({
          ...input,
          payload: {...input.payload, ...extra},
        }).success,
      ).toBe(false);
    }
  });
});
