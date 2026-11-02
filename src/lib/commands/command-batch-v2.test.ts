import {describe, expect, it} from "vitest";

import {deriveTerritoryId} from "@/lib/world/territory-id";

import {
  MAX_COMMAND_BATCH_DEPTH,
  MAX_COMMANDS_PER_BATCH,
  parseCommandBatchV2Command,
  safeParseCommandBatchV2Command,
} from "./command-batch-v2";

const territoryId = deriveTerritoryId({
  kind: "seed",
  seedVersion: "v2",
  sourceFeatureId: "batch-source",
});
const deleteCommand = (index: number) => ({
  commandId: `delete-${index}`,
  type: "country.delete",
  expectedRevision: 20,
  payload: {countryId: `C${index.toString(36).toUpperCase().padStart(2, "0")}`},
});
const batch = (commands: unknown[], commandId = "batch-root") => ({
  commandId,
  type: "command.batch",
  expectedRevision: 20,
  payload: {commands},
});
const nestedBatch = (depth: number): unknown =>
  depth === 1 ? batch([deleteCommand(depth)], `batch-${depth}`) : batch([
    nestedBatch(depth - 1),
  ], `batch-${depth}`);

describe("10-44 command batch v2 schema", () => {
  it("preserves the declared command order", () => {
    const input = batch([deleteCommand(2), deleteCommand(1), deleteCommand(3)]);
    const parsed = parseCommandBatchV2Command(input);

    expect(parsed).toEqual(input);
    expect((parsed.payload.commands as {commandId: string}[]).map(({commandId}) => commandId))
      .toEqual(["delete-2", "delete-1", "delete-3"]);
  });

  it("accepts a partition result local reference in a later command", () => {
    const partition = {
      commandId: "partition-source",
      type: "territory.partition",
      expectedRevision: 20,
      payload: {
        sourceTerritoryId: territoryId,
        partitions: [
          {partitionKey: "west", geometry: {type: "Polygon", coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]]}},
          {partitionKey: "east", geometry: {type: "Polygon", coordinates: [[[1, 0], [2, 0], [2, 1], [1, 0]]]}},
        ],
      },
    };
    const transfer = {
      commandId: "transfer-west",
      type: "territory.transfer",
      expectedRevision: 20,
      payload: {
        source: {kind: "partition-result", commandId: "partition-source", partitionKey: "west"},
        targetCountryId: "BBB",
      },
    };

    expect(parseCommandBatchV2Command(batch([partition, transfer]))).toEqual(
      batch([partition, transfer]),
    );
  });

  it("rejects an empty batch", () => {
    expect(safeParseCommandBatchV2Command(batch([])).success).toBe(false);
  });

  it("enforces the per-batch size limit", () => {
    expect(
      safeParseCommandBatchV2Command(
        batch(Array.from({length: MAX_COMMANDS_PER_BATCH}, (_, index) => deleteCommand(index))),
      ).success,
    ).toBe(true);
    expect(
      safeParseCommandBatchV2Command(
        batch(Array.from({length: MAX_COMMANDS_PER_BATCH + 1}, (_, index) => deleteCommand(index))),
      ).success,
    ).toBe(false);
  });

  it("enforces the nested batch depth limit", () => {
    expect(safeParseCommandBatchV2Command(nestedBatch(MAX_COMMAND_BATCH_DEPTH)).success)
      .toBe(true);
    expect(safeParseCommandBatchV2Command(nestedBatch(MAX_COMMAND_BATCH_DEPTH + 1)).success)
      .toBe(false);
  });

  it("rejects unsupported commands and unknown batch fields", () => {
    expect(
      safeParseCommandBatchV2Command(
        batch([{...deleteCommand(1), type: "country.teleport"}]),
      ).success,
    ).toBe(false);
    const input = batch([deleteCommand(1)]);
    expect(
      safeParseCommandBatchV2Command({
        ...input,
        payload: {...input.payload, atomic: true},
      }).success,
    ).toBe(false);
  });
});
