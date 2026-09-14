import {z} from "zod";

import {territoryIdV2Schema} from "./country-establish-v2";
import {canonicalCommandTextSchema, createMapCommandV2Schema} from "./map-command-v2";
import {wrapCommandSchemaWithPlainDataBoundary} from "./plain-command-data-v2";

const directTerritoryReferenceV2Schema = z.strictObject({
  kind: z.literal("territory-id"),
  territoryId: territoryIdV2Schema,
});

const partitionResultReferenceV2ObjectSchema = z.strictObject({
  kind: z.literal("partition-result"),
  commandId: canonicalCommandTextSchema,
  partitionKey: canonicalCommandTextSchema,
});

export const partitionResultReferenceV2Schema = wrapCommandSchemaWithPlainDataBoundary(
  partitionResultReferenceV2ObjectSchema,
);

const territorySourceReferenceV2ObjectSchema = z.discriminatedUnion("kind", [
  directTerritoryReferenceV2Schema,
  partitionResultReferenceV2ObjectSchema,
]);

export const territorySourceReferenceV2Schema = wrapCommandSchemaWithPlainDataBoundary(
  territorySourceReferenceV2ObjectSchema,
);

export const territoryTransferV2PayloadSchema = wrapCommandSchemaWithPlainDataBoundary(
  z.strictObject({
    source: territorySourceReferenceV2Schema,
    targetCountryId: canonicalCommandTextSchema,
  }),
);

export const territoryTransferV2CommandSchema = createMapCommandV2Schema(
  "territory.transfer",
  territoryTransferV2PayloadSchema,
);

export type PartitionResultReferenceV2 = z.infer<typeof partitionResultReferenceV2Schema>;
export type TerritorySourceReferenceV2 = z.infer<typeof territorySourceReferenceV2Schema>;
export type TerritoryTransferV2Payload = z.infer<typeof territoryTransferV2PayloadSchema>;
export type TerritoryTransferV2Command = z.infer<typeof territoryTransferV2CommandSchema>;

export const parseTerritoryTransferV2Command = (input: unknown): TerritoryTransferV2Command =>
  territoryTransferV2CommandSchema.parse(input);

export const safeParseTerritoryTransferV2Command = (input: unknown) =>
  territoryTransferV2CommandSchema.safeParse(input);
