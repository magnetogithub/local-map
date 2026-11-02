import {z} from "zod";

import {countryNamesV2Shape} from "./country-create-v2";
import {createMapCommandV2Schema} from "./map-command-v2";
import {countryIdV2Schema} from "./country-id-v2";
import {wrapCommandSchemaWithPlainDataBoundary} from "./plain-command-data-v2";

const countryRenameV2ChangesObjectSchema = z
  .strictObject(countryNamesV2Shape)
  .partial()
  .refine((changes) => Object.values(changes).some((value) => value !== undefined), {
    message: "country.rename requires at least one explicit name field",
  });

export const countryRenameV2ChangesSchema = wrapCommandSchemaWithPlainDataBoundary(
  countryRenameV2ChangesObjectSchema,
);

export const countryRenameV2PayloadSchema = wrapCommandSchemaWithPlainDataBoundary(
  z.strictObject({
    countryId: countryIdV2Schema,
    changes: countryRenameV2ChangesSchema,
  }),
);

export const countryRenameV2CommandSchema = createMapCommandV2Schema(
  "country.rename",
  countryRenameV2PayloadSchema,
);

export type CountryRenameV2Changes = z.infer<typeof countryRenameV2ChangesSchema>;
export type CountryRenameV2Payload = z.infer<typeof countryRenameV2PayloadSchema>;
export type CountryRenameV2Command = z.infer<typeof countryRenameV2CommandSchema>;

export const parseCountryRenameV2Command = (input: unknown): CountryRenameV2Command =>
  countryRenameV2CommandSchema.parse(input);

export const safeParseCountryRenameV2Command = (input: unknown) =>
  countryRenameV2CommandSchema.safeParse(input);
