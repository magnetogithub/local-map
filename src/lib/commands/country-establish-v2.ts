import {z} from "zod";

import {readTerritoryId} from "@/lib/world/territory-id";

import {countryIdentityV2Schema} from "./country-create-v2";
import {canonicalCommandTextSchema, createMapCommandV2Schema} from "./map-command-v2";
import {wrapCommandSchemaWithPlainDataBoundary} from "./plain-command-data-v2";

export const territoryIdV2Schema = canonicalCommandTextSchema.transform((value, context) => {
  try {
    return readTerritoryId(value);
  } catch (error) {
    context.addIssue({
      code: "custom",
      message: error instanceof Error ? error.message : "Invalid TerritoryId",
    });
    return z.NEVER;
  }
});

export const countryEstablishV2PayloadSchema = wrapCommandSchemaWithPlainDataBoundary(
  z.strictObject({
    country: countryIdentityV2Schema,
    territoryIds: z.array(territoryIdV2Schema).min(1),
  }),
);

export const countryEstablishV2CommandSchema = createMapCommandV2Schema(
  "country.establish",
  countryEstablishV2PayloadSchema,
);

export type CountryEstablishV2Payload = z.infer<typeof countryEstablishV2PayloadSchema>;
export type CountryEstablishV2Command = z.infer<typeof countryEstablishV2CommandSchema>;

export const parseCountryEstablishV2Command = (input: unknown): CountryEstablishV2Command =>
  countryEstablishV2CommandSchema.parse(input);

export const safeParseCountryEstablishV2Command = (input: unknown) =>
  countryEstablishV2CommandSchema.safeParse(input);
