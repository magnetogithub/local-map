import {describe, expect, it} from "vitest";

import {deriveTerritoryId} from "@/lib/world/territory-id";

import {
  parseTerritoryPartitionV2Command,
  safeParseTerritoryPartitionV2Command,
} from "./territory-partition-v2";

const sourceTerritoryId = deriveTerritoryId({
  kind: "seed",
  seedVersion: "v2",
  sourceFeatureId: "source",
});
const command = () => ({
  commandId: "partition-source",
  type: "territory.partition",
  expectedRevision: 13,
  payload: {
    sourceTerritoryId,
    partitions: [
      {
        partitionKey: "west",
        geometry: {
          type: "Polygon",
          coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1]]],
        },
      },
      {
        partitionKey: "remote-islands",
        geometry: {
          type: "MultiPolygon",
          coordinates: [
            [[[100, 40], [101, 40], [101, 41], [100, 40]]],
            [[[120, 50], [121, 50], [121, 51], [120, 50]]],
          ],
        },
      },
    ],
  },
});

describe("10-37 territory.partition v2 schema", () => {
  it("parses a source Territory and at least two keyed result partitions", () => {
    expect(parseTerritoryPartitionV2Command(command())).toEqual(command());
  });

  it("leaves source/result union equivalence, gaps, and overlap to the planner", () => {
    const input = command();

    expect(() => parseTerritoryPartitionV2Command(input)).not.toThrow();
    expect("sourceGeometry" in input.payload).toBe(false);
  });

  it("requires at least two result partitions", () => {
    const input = command();
    expect(
      safeParseTerritoryPartitionV2Command({
        ...input,
        payload: {...input.payload, partitions: input.payload.partitions.slice(0, 1)},
      }).success,
    ).toBe(false);
  });

  it.each([
    ["non-Polygon geometry", {type: "LineString", coordinates: [[0, 0], [1, 1]]}],
    ["empty Polygon", {type: "Polygon", coordinates: []}],
    ["short ring", {type: "Polygon", coordinates: [[[0, 0], [1, 0], [0, 0]]]}],
    [
      "non-finite coordinate",
      {type: "Polygon", coordinates: [[[0, 0], [1, 0], [1, Number.NaN], [0, 0]]]},
    ],
    ["empty MultiPolygon", {type: "MultiPolygon", coordinates: []}],
  ] as const)("rejects %s", (_label, geometry) => {
    const input = command();
    expect(
      safeParseTerritoryPartitionV2Command({
        ...input,
        payload: {
          ...input.payload,
          partitions: [
            {...input.payload.partitions[0], geometry},
            input.payload.partitions[1],
          ],
        },
      }).success,
    ).toBe(false);
  });

  it("rejects malformed source IDs, partition keys, and unknown result fields", () => {
    const input = command();
    expect(
      safeParseTerritoryPartitionV2Command({
        ...input,
        payload: {...input.payload, sourceTerritoryId: "territory:seed:broken"},
      }).success,
    ).toBe(false);
    expect(
      safeParseTerritoryPartitionV2Command({
        ...input,
        payload: {
          ...input.payload,
          partitions: [
            {...input.payload.partitions[0], partitionKey: " west"},
            input.payload.partitions[1],
          ],
        },
      }).success,
    ).toBe(false);
    expect(
      safeParseTerritoryPartitionV2Command({
        ...input,
        payload: {
          ...input.payload,
          partitions: [
            {...input.payload.partitions[0], ownerCountryId: "AAA"},
            input.payload.partitions[1],
          ],
        },
      }).success,
    ).toBe(false);
  });

  it.each(["sourceGeometry", "geometryPolicy", "policyVersion", "tolerance"])(
    "rejects planner or policy payload field %s",
    (field) => {
      const input = command();
      expect(
        safeParseTerritoryPartitionV2Command({
          ...input,
          payload: {...input.payload, [field]: {}},
        }).success,
      ).toBe(false);
    },
  );
});
