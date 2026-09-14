import {describe, expect, it} from "vitest";

import {deriveTerritoryId} from "@/lib/world/territory-id";

import {
  parseTerritoryTransferV2Command,
  safeParseTerritoryTransferV2Command,
} from "./territory-transfer-v2";

const territoryId = deriveTerritoryId({
  kind: "seed",
  seedVersion: "v2",
  sourceFeatureId: "transfer-me",
});
const base = () => ({
  commandId: "transfer-territory",
  type: "territory.transfer",
  expectedRevision: 17,
  payload: {
    source: {kind: "territory-id", territoryId},
    targetCountryId: "BBB",
  },
});

describe("10-41 territory.transfer v2 schema", () => {
  it("parses a direct Territory ID source", () => {
    expect(parseTerritoryTransferV2Command(base())).toEqual(base());
  });

  it("parses a prior partition result reference", () => {
    const input = base();
    const command = {
      ...input,
      payload: {
        ...input.payload,
        source: {
          kind: "partition-result",
          commandId: "partition-source",
          partitionKey: "west",
        },
      },
    };

    expect(parseTerritoryTransferV2Command(command)).toEqual(command);
  });

  it.each([
    {kind: "territory-id", territoryId: "territory:seed:broken"},
    {kind: "partition-result", commandId: "", partitionKey: "west"},
    {kind: "partition-result", commandId: "partition-source", partitionKey: " west"},
    {kind: "geometry", geometry: {}},
  ])("rejects malformed source reference %#", (source) => {
    const input = base();
    expect(
      safeParseTerritoryTransferV2Command({
        ...input,
        payload: {...input.payload, source},
      }).success,
    ).toBe(false);
  });

  it.each([
    ["tolerance", true],
    ["areaTolerance", true],
    ["allowTolerance", true],
    ["allowOverlap", false],
    ["strict", false],
  ] as const)("rejects boolean tolerance option %s", (field, value) => {
    const input = base();
    expect(
      safeParseTerritoryTransferV2Command({
        ...input,
        payload: {...input.payload, [field]: value},
      }).success,
    ).toBe(false);
  });

  it("rejects malformed target identity and planner-owned state", () => {
    const input = base();
    expect(
      safeParseTerritoryTransferV2Command({
        ...input,
        payload: {...input.payload, targetCountryId: " BBB"},
      }).success,
    ).toBe(false);
    expect(
      safeParseTerritoryTransferV2Command({
        ...input,
        payload: {...input.payload, worldState: {}},
      }).success,
    ).toBe(false);
  });
});
