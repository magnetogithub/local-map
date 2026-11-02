import {z} from "zod";

import {countryIdentityV2Schema} from "./country-create-v2";
import {createMapCommandV2Schema} from "./map-command-v2";
import {countryIdV2Schema} from "./country-id-v2";
import {wrapCommandSchemaWithPlainDataBoundary} from "./plain-command-data-v2";
import {territorySourceReferenceV2Schema} from "./territory-transfer-v2";

export const countrySplitResultV2Schema = wrapCommandSchemaWithPlainDataBoundary(
  z.strictObject({
    country: countryIdentityV2Schema,
    territorySources: z.array(territorySourceReferenceV2Schema).min(1),
  }),
);

export const countrySplitV2PayloadSchema = wrapCommandSchemaWithPlainDataBoundary(
  z.strictObject({
    sourceCountryId: countryIdV2Schema,
    resultCountries: z.array(countrySplitResultV2Schema).min(2),
  }),
);

export const countrySplitV2CommandSchema = createMapCommandV2Schema(
  "country.split",
  countrySplitV2PayloadSchema,
);

export type CountrySplitResultV2 = z.infer<typeof countrySplitResultV2Schema>;
export type CountrySplitV2Payload = z.infer<typeof countrySplitV2PayloadSchema>;
export type CountrySplitV2Command = z.infer<typeof countrySplitV2CommandSchema>;

export const parseCountrySplitV2Command = (input: unknown): CountrySplitV2Command =>
  countrySplitV2CommandSchema.parse(input);

export const safeParseCountrySplitV2Command = (input: unknown) =>
  countrySplitV2CommandSchema.safeParse(input);
