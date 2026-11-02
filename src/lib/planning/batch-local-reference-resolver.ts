import type {
  CommandBatchV2Command,
  LeafMapCommandV2,
} from "../commands/command-batch-v2";
import {leafMapCommandV2Schema, parseCommandBatchV2Command} from "../commands/command-batch-v2";
import type {TerritorySourceReferenceV2} from "../commands/territory-transfer-v2";
import {deriveTerritoryId, type TerritoryId} from "../world/territory-id";
import type {PlanningError, PlanningErrorCode} from "./plan-result";

export type BatchLocalReferenceResolution = Readonly<
  | {
      ok: true;
      batch: CommandBatchV2Command;
      localSymbols: Readonly<Record<string, TerritoryId>>;
    }
  | {ok: false; error: PlanningError}
>;

type LocalSymbolTable = Map<string, TerritoryId>;

const symbolKey = (commandId: string, partitionKey: string) =>
  `${commandId}:${partitionKey}`;

const batchLocalError = (
  code: PlanningErrorCode,
  commandId: string,
  message: string,
): PlanningError => Object.freeze({
  kind: "planning-error",
  code,
  commandId,
  message,
});

const isPlanningError = (
  value: LeafMapCommandV2 | TerritorySourceReferenceV2 | PlanningError,
): value is PlanningError =>
  value && typeof value === "object" && "kind" in value && value.kind === "planning-error";

const commandTypeOf = (command: unknown) =>
  command && typeof command === "object" && !Array.isArray(command) && "type" in command
    ? (command as {type?: unknown}).type
    : undefined;

function resolveTerritorySourceReference(
  reference: TerritorySourceReferenceV2,
  commandId: string,
  localSymbols: LocalSymbolTable,
): TerritorySourceReferenceV2 | PlanningError {
  if (reference.kind === "territory-id") {
    return reference;
  }

  const key = symbolKey(reference.commandId, reference.partitionKey);
  const territoryId = localSymbols.get(key);
  if (!territoryId) {
    return batchLocalError(
      "batch-local-reference-unknown",
      commandId,
      `Unknown batch-local partition result reference: ${key}`,
    );
  }

  return Object.freeze({kind: "territory-id", territoryId});
}

function resolveLeafCommand(
  command: LeafMapCommandV2,
  localSymbols: LocalSymbolTable,
): LeafMapCommandV2 | PlanningError {
  if (command.type === "territory.transfer") {
    const source = resolveTerritorySourceReference(
      command.payload.source,
      command.commandId,
      localSymbols,
    );
    if (isPlanningError(source)) {
      return source;
    }
    return Object.freeze({
      ...command,
      payload: Object.freeze({...command.payload, source}),
    }) as LeafMapCommandV2;
  }

  if (command.type === "country.split") {
    const resultCountries = [];
    for (const resultCountry of command.payload.resultCountries) {
      const territorySources = [];
      for (const reference of resultCountry.territorySources) {
        const resolved = resolveTerritorySourceReference(
          reference,
          command.commandId,
          localSymbols,
        );
        if (isPlanningError(resolved)) {
          return resolved;
        }
        territorySources.push(resolved);
      }
      resultCountries.push(Object.freeze({
        ...resultCountry,
        territorySources: Object.freeze(territorySources),
      }));
    }
    return Object.freeze({
      ...command,
      payload: Object.freeze({
        ...command.payload,
        resultCountries: Object.freeze(resultCountries),
      }),
    }) as LeafMapCommandV2;
  }

  return command;
}

function registerLeafCommandSymbols(
  command: LeafMapCommandV2,
  localSymbols: LocalSymbolTable,
) {
  if (command.type !== "territory.partition") {
    return;
  }

  for (const partition of command.payload.partitions) {
    localSymbols.set(
      symbolKey(command.commandId, partition.partitionKey),
      deriveTerritoryId({
        kind: "partition",
        sourceTerritoryId: command.payload.sourceTerritoryId,
        partitionKey: partition.partitionKey,
      }),
    );
  }
}

export function resolveCommandBatchLocalReferences(
  batch: CommandBatchV2Command,
): BatchLocalReferenceResolution {
  const localSymbols: LocalSymbolTable = new Map();
  const resolvedCommands: LeafMapCommandV2[] = [];

  for (const rawCommand of batch.payload.commands) {
    if (commandTypeOf(rawCommand) === "command.batch") {
      return Object.freeze({
        ok: false,
        error: batchLocalError(
        "batch-local-reference-unknown",
          (rawCommand as {commandId?: string}).commandId ?? batch.commandId,
        "Nested batch local reference resolution is not supported by stage 10-74",
        ),
      });
    }

    const command = leafMapCommandV2Schema.parse(rawCommand);
    const resolved = resolveLeafCommand(command, localSymbols);
    if (isPlanningError(resolved)) {
      return Object.freeze({ok: false, error: resolved});
    }
    resolvedCommands.push(resolved);
    registerLeafCommandSymbols(resolved, localSymbols);
  }

  return Object.freeze({
    ok: true,
    batch: parseCommandBatchV2Command({
      ...batch,
      payload: {...batch.payload, commands: resolvedCommands},
    }),
    localSymbols: Object.freeze(Object.fromEntries(localSymbols)),
  });
}
