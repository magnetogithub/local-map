import {z} from "zod";

import {countryIdentityV2Schema} from "./country-create-v2";
import {createMapCommandV2Schema} from "./map-command-v2";
import {countryIdV2Schema} from "./country-id-v2";
import {wrapCommandSchemaWithPlainDataBoundary} from "./plain-command-data-v2";

const existingResultCountryV2Schema = z.strictObject({
  kind: z.literal("existing-country"),
  countryId: countryIdV2Schema,
});

const newResultCountryV2Schema = z.strictObject({
  kind: z.literal("new-country"),
  country: countryIdentityV2Schema,
});

const mergeResultCountryV2ObjectSchema = z.discriminatedUnion("kind", [
  existingResultCountryV2Schema,
  newResultCountryV2Schema,
]);

export const mergeResultCountryV2Schema = wrapCommandSchemaWithPlainDataBoundary(
  mergeResultCountryV2ObjectSchema,
);

export const mergeMetadataFieldV2Schema = z.enum([
  "names",
  "politicalStatus",
  "presentationOverride",
  "moduleVersions",
]);

const preserveResultMetadataV2Schema = z.strictObject({
  mode: z.literal("preserve-result"),
});

const inheritSourceMetadataV2Schema = z.strictObject({
  mode: z.literal("inherit-source"),
  sourceCountryId: countryIdV2Schema,
  fields: z.array(mergeMetadataFieldV2Schema).min(1),
});

const mergeMetadataInheritanceV2ObjectSchema = z.discriminatedUnion("mode", [
  preserveResultMetadataV2Schema,
  inheritSourceMetadataV2Schema,
]);

export const mergeMetadataInheritanceV2Schema = wrapCommandSchemaWithPlainDataBoundary(
  mergeMetadataInheritanceV2ObjectSchema,
);

export const countryMergeV2PayloadSchema = wrapCommandSchemaWithPlainDataBoundary(
  z.strictObject({
    sourceCountryIds: z.array(countryIdV2Schema).min(2),
    resultCountry: mergeResultCountryV2Schema,
    metadataInheritance: mergeMetadataInheritanceV2Schema,
  }),
);

export const countryMergeV2CommandSchema = createMapCommandV2Schema(
  "country.merge",
  countryMergeV2PayloadSchema,
);

export type MergeResultCountryV2 = z.infer<typeof mergeResultCountryV2Schema>;
export type MergeMetadataInheritanceV2 = z.infer<
  typeof mergeMetadataInheritanceV2Schema
>;
export type CountryMergeV2Payload = z.infer<typeof countryMergeV2PayloadSchema>;
export type CountryMergeV2Command = z.infer<typeof countryMergeV2CommandSchema>;

export const parseCountryMergeV2Command = (input: unknown): CountryMergeV2Command =>
  countryMergeV2CommandSchema.parse(input);

export const safeParseCountryMergeV2Command = (input: unknown) =>
  countryMergeV2CommandSchema.safeParse(input);
