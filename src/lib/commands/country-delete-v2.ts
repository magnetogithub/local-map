import {z} from "zod";

import {createMapCommandV2Schema} from "./map-command-v2";
import {countryIdV2Schema} from "./country-id-v2";
import {wrapCommandSchemaWithPlainDataBoundary} from "./plain-command-data-v2";

export const countryDeleteV2PayloadSchema = wrapCommandSchemaWithPlainDataBoundary(
  z.strictObject({
    countryId: countryIdV2Schema,
  }),
);

export const countryDeleteV2CommandSchema = createMapCommandV2Schema(
  "country.delete",
  countryDeleteV2PayloadSchema,
);

export type CountryDeleteV2Payload = z.infer<typeof countryDeleteV2PayloadSchema>;
export type CountryDeleteV2Command = z.infer<typeof countryDeleteV2CommandSchema>;

export const parseCountryDeleteV2Command = (input: unknown): CountryDeleteV2Command =>
  countryDeleteV2CommandSchema.parse(input);

export const safeParseCountryDeleteV2Command = (input: unknown) =>
  countryDeleteV2CommandSchema.safeParse(input);
