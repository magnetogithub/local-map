import {z} from "zod";

import {countryCreateV2CommandSchema} from "./country-create-v2";
import {countryDeleteV2CommandSchema} from "./country-delete-v2";
import {countryDissolveV2CommandSchema} from "./country-dissolve-v2";
import {countryEstablishV2CommandSchema} from "./country-establish-v2";
import {countryMergeV2CommandSchema} from "./country-merge-v2";
import {countryRenameV2CommandSchema} from "./country-rename-v2";
import {countrySplitV2CommandSchema} from "./country-split-v2";
import {createMapCommandV2Schema} from "./map-command-v2";
import {wrapCommandSchemaWithPlainDataBoundary} from "./plain-command-data-v2";
import {territoryAssignV2CommandSchema} from "./territory-assign-v2";
import {territoryPartitionV2CommandSchema} from "./territory-partition-v2";
import {territoryReplaceV2CommandSchema} from "./territory-replace-v2";
import {
  partitionResultReferenceV2Schema,
  territoryTransferV2CommandSchema,
} from "./territory-transfer-v2";
import {territoryUnclaimV2CommandSchema} from "./territory-unclaim-v2";

export const MAX_COMMANDS_PER_BATCH = 64;
export const MAX_COMMAND_BATCH_DEPTH = 4;

export const localCommandReferenceV2Schema = partitionResultReferenceV2Schema;

export const leafMapCommandV2Schema = z.union([
  countryCreateV2CommandSchema,
  countryEstablishV2CommandSchema,
  countryRenameV2CommandSchema,
  countryDeleteV2CommandSchema,
  countryDissolveV2CommandSchema,
  territoryPartitionV2CommandSchema,
  territoryAssignV2CommandSchema,
  territoryUnclaimV2CommandSchema,
  territoryReplaceV2CommandSchema,
  territoryTransferV2CommandSchema,
  countrySplitV2CommandSchema,
  countryMergeV2CommandSchema,
]);

export const commandBatchV2PayloadSchema = wrapCommandSchemaWithPlainDataBoundary(
  z.strictObject({
    commands: z.array(z.unknown()).min(1).max(MAX_COMMANDS_PER_BATCH),
  }),
);

const commandBatchV2BaseSchema = createMapCommandV2Schema(
  "command.batch",
  commandBatchV2PayloadSchema,
);

type RefinementContext = Parameters<
  Parameters<typeof commandBatchV2BaseSchema.superRefine>[0]
>[1];

function addNestedIssue(
  context: RefinementContext,
  path: PropertyKey[],
  message: string,
) {
  context.addIssue({code: "custom", path, message});
}

function validateNestedCommand(
  input: unknown,
  depth: number,
  context: RefinementContext,
  path: PropertyKey[],
) {
  const type =
    input && typeof input === "object" && !Array.isArray(input) && "type" in input
      ? (input as {type?: unknown}).type
      : undefined;

  if (type !== "command.batch") {
    const leafResult = leafMapCommandV2Schema.safeParse(input);
    if (!leafResult.success) {
      addNestedIssue(
        context,
        path,
        leafResult.error.issues[0]?.message ?? "Invalid leaf command",
      );
    }
    return;
  }

  const batchResult = commandBatchV2BaseSchema.safeParse(input);
  if (!batchResult.success) {
    addNestedIssue(
      context,
      path,
      batchResult.error.issues[0]?.message ?? "Invalid nested command batch",
    );
    return;
  }
  if (depth > MAX_COMMAND_BATCH_DEPTH) {
    addNestedIssue(
      context,
      path,
      `Command batch depth must not exceed ${MAX_COMMAND_BATCH_DEPTH}`,
    );
    return;
  }

  batchResult.data.payload.commands.forEach((command, index) =>
    validateNestedCommand(command, depth + 1, context, [...path, "payload", "commands", index]),
  );
}

export const commandBatchV2CommandSchema = commandBatchV2BaseSchema.superRefine(
  (batch, context) => {
    batch.payload.commands.forEach((command, index) =>
      validateNestedCommand(command, 2, context, ["payload", "commands", index]),
    );
  },
);

export type LocalCommandReferenceV2 = z.infer<typeof localCommandReferenceV2Schema>;
export type LeafMapCommandV2 = z.infer<typeof leafMapCommandV2Schema>;
export type CommandBatchV2Payload = z.infer<typeof commandBatchV2PayloadSchema>;
export type CommandBatchV2Command = z.infer<typeof commandBatchV2CommandSchema>;

export const parseCommandBatchV2Command = (input: unknown): CommandBatchV2Command =>
  commandBatchV2CommandSchema.parse(input);

export const safeParseCommandBatchV2Command = (input: unknown) =>
  commandBatchV2CommandSchema.safeParse(input);
