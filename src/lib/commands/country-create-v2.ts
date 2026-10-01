import {z} from "zod";

import {COUNTRY_POLITICAL_STATUSES} from "@/lib/world/country-entity";

import {canonicalCommandTextSchema, createMapCommandV2Schema} from "./map-command-v2";
import {countryIdV2Schema} from "./country-id-v2";
import {wrapCommandSchemaWithPlainDataBoundary} from "./plain-command-data-v2";

const finiteNumber = z.number().finite();
const positionSchema = z.tuple([finiteNumber, finiteNumber]);

export const countryNamesV2Shape = {
  shortKo: canonicalCommandTextSchema,
  officialKo: canonicalCommandTextSchema,
  mapKo: canonicalCommandTextSchema,
  english: canonicalCommandTextSchema,
  searchAliases: z.array(canonicalCommandTextSchema),
};

export const countryNamesV2Schema = wrapCommandSchemaWithPlainDataBoundary(
  z.strictObject(countryNamesV2Shape),
);

const countryPresentationOverrideV2ObjectSchema = z
  .strictObject({
    center: positionSchema.optional(),
    defaultZoom: finiteNumber.positive().optional(),
    labelAnchor: positionSchema.optional(),
    labelScale: finiteNumber.positive().optional(),
    policyVersion: canonicalCommandTextSchema,
    reason: canonicalCommandTextSchema,
  })
  .refine(
    (override) =>
      override.center !== undefined ||
      override.defaultZoom !== undefined ||
      override.labelAnchor !== undefined ||
      override.labelScale !== undefined,
    {message: "presentationOverride requires at least one manual value"},
  );

export const countryPresentationOverrideV2Schema = wrapCommandSchemaWithPlainDataBoundary(
  countryPresentationOverrideV2ObjectSchema,
);

export const countryIdentityV2Schema = wrapCommandSchemaWithPlainDataBoundary(
  z.strictObject({
    id: countryIdV2Schema.optional(),
    names: countryNamesV2Schema,
    politicalStatus: z.enum(COUNTRY_POLITICAL_STATUSES),
    presentationOverride: countryPresentationOverrideV2Schema.nullable(),
    moduleVersions: z.record(
      canonicalCommandTextSchema,
      z.number().int().nonnegative().safe(),
    ),
  }),
);

export const countryCreateV2PayloadSchema = wrapCommandSchemaWithPlainDataBoundary(
  z.strictObject({
    country: countryIdentityV2Schema,
  }),
);

export const countryCreateV2CommandSchema = createMapCommandV2Schema(
  "country.create",
  countryCreateV2PayloadSchema,
);

export type CountryIdentityV2 = z.infer<typeof countryIdentityV2Schema>;
export type CountryCreateV2Payload = z.infer<typeof countryCreateV2PayloadSchema>;
export type CountryCreateV2Command = z.infer<typeof countryCreateV2CommandSchema>;

export const parseCountryCreateV2Command = (input: unknown): CountryCreateV2Command =>
  countryCreateV2CommandSchema.parse(input);

export const safeParseCountryCreateV2Command = (input: unknown) =>
  countryCreateV2CommandSchema.safeParse(input);
