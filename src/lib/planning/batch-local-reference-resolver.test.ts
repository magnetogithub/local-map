import {describe, expect, it} from "vitest";

import {parseCommandBatchV2Command} from "../commands/command-batch-v2";
import {deriveTerritoryId} from "../world/territory-id";
import {resolveCommandBatchLocalReferences} from "./batch-local-reference-resolver";

const sourceTerritoryId = deriveTerritoryId({
  kind: "seed",
  seedVersion: "v2",
  sourceFeatureId: "batch-local-source",
});

const partitionCommand = {
  commandId: "partition-main",
  type: "territory.partition",
  expectedRevision: 7,
  payload: {
    sourceTerritoryId,
    partitions: [
      {
        partitionKey: "west",
        geometry: {type: "Polygon", coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]]},
      },
      {
        partitionKey: "east",
        geometry: {type: "Polygon", coordinates: [[[1, 0], [2, 0], [2, 1], [1, 0]]]},
      },
    ],
  },
} as const;

const batch = (commands: unknown[]) => parseCommandBatchV2Command({
  commandId: "batch-local",
  type: "command.batch",
  expectedRevision: 7,
  payload: {commands},
});

describe("10-74 batch local reference resolver", () => {
  it("resolves later territory.transfer partition-result references from earlier partition output IDs", () => {
    const transferCommand = {
      commandId: "transfer-west",
      type: "territory.transfer",
      expectedRevision: 7,
      payload: {
        source: {kind: "partition-result", commandId: "partition-main", partitionKey: "west"},
        targetCountryId: "BBB",
      },
    };

    const result = resolveCommandBatchLocalReferences(batch([
      partitionCommand,
      transferCommand,
    ]));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.localSymbols["partition-main:west"]).toBe(
      deriveTerritoryId({
        kind: "partition",
        sourceTerritoryId,
        partitionKey: "west",
      }),
    );
    expect(result.batch.payload.commands[1]).toEqual({
      ...transferCommand,
      payload: {
        ...transferCommand.payload,
        source: {
          kind: "territory-id",
          territoryId: deriveTerritoryId({
            kind: "partition",
            sourceTerritoryId,
            partitionKey: "west",
          }),
        },
      },
    });
  });

  it("resolves country.split territorySources without mutating the input batch", () => {
    const splitCommand = {
      commandId: "split-after-partition",
      type: "country.split",
      expectedRevision: 7,
      payload: {
        sourceCountryId: "AAA",
        resultCountries: [
          {
            country: {
              id: "BBB",
              names: {
                shortKo: "BBB",
                officialKo: "BBB",
                mapKo: "BBB",
                english: "BBB",
                searchAliases: ["BBB"],
              },
              politicalStatus: "sovereign",
              presentationOverride: null,
              moduleVersions: {core: 1},
            },
            territorySources: [
              {kind: "partition-result", commandId: "partition-main", partitionKey: "west"},
            ],
          },
          {
            country: {
              id: "CCC",
              names: {
                shortKo: "CCC",
                officialKo: "CCC",
                mapKo: "CCC",
                english: "CCC",
                searchAliases: ["CCC"],
              },
              politicalStatus: "sovereign",
              presentationOverride: null,
              moduleVersions: {core: 1},
            },
            territorySources: [
              {kind: "partition-result", commandId: "partition-main", partitionKey: "east"},
            ],
          },
        ],
      },
    };
    const input = batch([partitionCommand, splitCommand]);

    const result = resolveCommandBatchLocalReferences(input);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(input.payload.commands[1]).toEqual(splitCommand);
    expect(result.batch.payload.commands[1]).toEqual({
      ...splitCommand,
      payload: {
        ...splitCommand.payload,
        resultCountries: [
          {
            ...splitCommand.payload.resultCountries[0],
            territorySources: [{
              kind: "territory-id",
              territoryId: deriveTerritoryId({
                kind: "partition",
                sourceTerritoryId,
                partitionKey: "west",
              }),
            }],
          },
          {
            ...splitCommand.payload.resultCountries[1],
            territorySources: [{
              kind: "territory-id",
              territoryId: deriveTerritoryId({
                kind: "partition",
                sourceTerritoryId,
                partitionKey: "east",
              }),
            }],
          },
        ],
      },
    });
  });

  it("explicitly rejects forward unknown partition-result references", () => {
    const transferCommand = {
      commandId: "transfer-forward",
      type: "territory.transfer",
      expectedRevision: 7,
      payload: {
        source: {kind: "partition-result", commandId: "partition-main", partitionKey: "west"},
        targetCountryId: "BBB",
      },
    };

    const result = resolveCommandBatchLocalReferences(batch([
      transferCommand,
      partitionCommand,
    ]));

    expect(result).toEqual({
      ok: false,
      error: {
        kind: "planning-error",
        code: "batch-local-reference-unknown",
        commandId: "transfer-forward",
        message: "Unknown batch-local partition result reference: partition-main:west",
      },
    });
  });
});
