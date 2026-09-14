import {z} from "zod";

import {territoryIdV2Schema} from "./country-establish-v2";
import {canonicalCommandTextSchema, createMapCommandV2Schema} from "./map-command-v2";
import {wrapCommandSchemaWithPlainDataBoundary} from "./plain-command-data-v2";

export const territoryAssignV2PayloadSchema = wrapCommandSchemaWithPlainDataBoundary(
  z.strictObject({
    territoryId: territoryIdV2Schema,
    targetCountryId: canonicalCommandTextSchema,
  }),
);

export const territoryAssignV2CommandSchema = createMapCommandV2Schema(
  "territory.assign",
  territoryAssignV2PayloadSchema,
);

export type TerritoryAssignV2Payload = z.infer<typeof territoryAssignV2PayloadSchema>;
export type TerritoryAssignV2Command = z.infer<typeof territoryAssignV2CommandSchema>;

export const parseTerritoryAssignV2Command = (input: unknown): TerritoryAssignV2Command =>
  territoryAssignV2CommandSchema.parse(input);

export const safeParseTerritoryAssignV2Command = (input: unknown) =>
  territoryAssignV2CommandSchema.safeParse(input);
