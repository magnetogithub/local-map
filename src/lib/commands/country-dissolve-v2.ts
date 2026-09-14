import {z} from "zod";

import {territoryIdV2Schema} from "./country-establish-v2";
import {canonicalCommandTextSchema, createMapCommandV2Schema} from "./map-command-v2";
import {wrapCommandSchemaWithPlainDataBoundary} from "./plain-command-data-v2";

const unclaimDispositionV2Schema = z.strictObject({
  type: z.literal("unclaim"),
});

const transferDispositionV2Schema = z.strictObject({
  type: z.literal("transfer"),
  targetCountryId: canonicalCommandTextSchema,
});

const mergeDispositionV2Schema = z.strictObject({
  type: z.literal("merge"),
  targetCountryId: canonicalCommandTextSchema,
});

const countryDissolveDispositionV2ObjectSchema = z.discriminatedUnion("type", [
  unclaimDispositionV2Schema,
  transferDispositionV2Schema,
  mergeDispositionV2Schema,
]);

export const countryDissolveDispositionV2Schema = wrapCommandSchemaWithPlainDataBoundary(
  countryDissolveDispositionV2ObjectSchema,
);

export const countryDissolveTerritoryDispositionV2Schema =
  wrapCommandSchemaWithPlainDataBoundary(
    z.strictObject({
      territoryId: territoryIdV2Schema,
      disposition: countryDissolveDispositionV2Schema,
    }),
  );

export const countryDissolveV2PayloadSchema = wrapCommandSchemaWithPlainDataBoundary(
  z.strictObject({
    sourceCountryId: canonicalCommandTextSchema,
    territoryDispositions: z.array(countryDissolveTerritoryDispositionV2Schema).min(1),
  }),
);

export const countryDissolveV2CommandSchema = createMapCommandV2Schema(
  "country.dissolve",
  countryDissolveV2PayloadSchema,
);

export type CountryDissolveDispositionV2 = z.infer<
  typeof countryDissolveDispositionV2Schema
>;
export type CountryDissolveV2Payload = z.infer<typeof countryDissolveV2PayloadSchema>;
export type CountryDissolveV2Command = z.infer<typeof countryDissolveV2CommandSchema>;

export const parseCountryDissolveV2Command = (input: unknown): CountryDissolveV2Command =>
  countryDissolveV2CommandSchema.parse(input);

export const safeParseCountryDissolveV2Command = (input: unknown) =>
  countryDissolveV2CommandSchema.safeParse(input);
