import {z} from "zod";

import {territoryIdV2Schema} from "./country-establish-v2";
import {createMapCommandV2Schema} from "./map-command-v2";
import {wrapCommandSchemaWithPlainDataBoundary} from "./plain-command-data-v2";

export const territoryUnclaimV2PayloadSchema = wrapCommandSchemaWithPlainDataBoundary(
  z.strictObject({
    territoryIds: z.array(territoryIdV2Schema).min(1),
  }),
);

export const territoryUnclaimV2CommandSchema = createMapCommandV2Schema(
  "territory.unclaim",
  territoryUnclaimV2PayloadSchema,
);

export type TerritoryUnclaimV2Payload = z.infer<typeof territoryUnclaimV2PayloadSchema>;
export type TerritoryUnclaimV2Command = z.infer<typeof territoryUnclaimV2CommandSchema>;

export const parseTerritoryUnclaimV2Command = (input: unknown): TerritoryUnclaimV2Command =>
  territoryUnclaimV2CommandSchema.parse(input);

export const safeParseTerritoryUnclaimV2Command = (input: unknown) =>
  territoryUnclaimV2CommandSchema.safeParse(input);
