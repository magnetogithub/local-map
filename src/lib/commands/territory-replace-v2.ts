import {z} from "zod";

import {territoryIdV2Schema} from "./country-establish-v2";
import {createMapCommandV2Schema} from "./map-command-v2";
import {wrapCommandSchemaWithPlainDataBoundary} from "./plain-command-data-v2";
import {polygonGeometryV2Schema} from "./territory-partition-v2";

export const territoryReplaceV2PayloadSchema = wrapCommandSchemaWithPlainDataBoundary(
  z.strictObject({
    territoryId: territoryIdV2Schema,
    geometry: polygonGeometryV2Schema,
  }),
);

export const territoryReplaceV2CommandSchema = createMapCommandV2Schema(
  "territory.replace",
  territoryReplaceV2PayloadSchema,
);

export type TerritoryReplaceV2Payload = z.infer<typeof territoryReplaceV2PayloadSchema>;
export type TerritoryReplaceV2Command = z.infer<typeof territoryReplaceV2CommandSchema>;

export const parseTerritoryReplaceV2Command = (input: unknown): TerritoryReplaceV2Command =>
  territoryReplaceV2CommandSchema.parse(input);

export const safeParseTerritoryReplaceV2Command = (input: unknown) =>
  territoryReplaceV2CommandSchema.safeParse(input);
