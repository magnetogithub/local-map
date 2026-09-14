import {z} from "zod";

import {territoryIdV2Schema} from "./country-establish-v2";
import {canonicalCommandTextSchema, createMapCommandV2Schema} from "./map-command-v2";
import {wrapCommandSchemaWithPlainDataBoundary} from "./plain-command-data-v2";

const finiteNumberSchema = z.number().finite();
const positionV2Schema = z.tuple([finiteNumberSchema, finiteNumberSchema]);
const linearRingV2Schema = z.array(positionV2Schema).min(4);
const polygonCoordinatesV2Schema = z.array(linearRingV2Schema).min(1);

const polygonGeometryV2ObjectSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("Polygon"),
    coordinates: polygonCoordinatesV2Schema,
  }),
  z.strictObject({
    type: z.literal("MultiPolygon"),
    coordinates: z.array(polygonCoordinatesV2Schema).min(1),
  }),
]);

export const polygonGeometryV2Schema = wrapCommandSchemaWithPlainDataBoundary(
  polygonGeometryV2ObjectSchema,
);

export const territoryPartitionResultV2Schema = wrapCommandSchemaWithPlainDataBoundary(
  z.strictObject({
    partitionKey: canonicalCommandTextSchema,
    geometry: polygonGeometryV2Schema,
  }),
);

export const territoryPartitionV2PayloadSchema = wrapCommandSchemaWithPlainDataBoundary(
  z.strictObject({
    sourceTerritoryId: territoryIdV2Schema,
    partitions: z.array(territoryPartitionResultV2Schema).min(2),
  }),
);

export const territoryPartitionV2CommandSchema = createMapCommandV2Schema(
  "territory.partition",
  territoryPartitionV2PayloadSchema,
);

export type PolygonGeometryV2 = z.infer<typeof polygonGeometryV2Schema>;
export type TerritoryPartitionResultV2 = z.infer<
  typeof territoryPartitionResultV2Schema
>;
export type TerritoryPartitionV2Payload = z.infer<typeof territoryPartitionV2PayloadSchema>;
export type TerritoryPartitionV2Command = z.infer<typeof territoryPartitionV2CommandSchema>;

export const parseTerritoryPartitionV2Command = (
  input: unknown,
): TerritoryPartitionV2Command => territoryPartitionV2CommandSchema.parse(input);

export const safeParseTerritoryPartitionV2Command = (input: unknown) =>
  territoryPartitionV2CommandSchema.safeParse(input);
