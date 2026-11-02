import {z} from "zod";

import {
  assertPolygonGeometry,
  type CountryEntity,
  type WorldState,
} from "./world-state";
import type {PolygonGeometry} from "@/lib/map/country-label-layout";

import {mapCommandEnvelopeSchema} from "../../commands/map-command";

const nonEmptyText = z.string().trim().min(1);
const finiteNumber = z.number().finite();
const positionSchema = z.tuple([finiteNumber, finiteNumber]);

export const countryUnitTypeSchema = z.enum([
  "sovereign-country",
  "dependent-territory",
  "disputed-territory",
  "military-base",
  "buffer-zone",
  "uninhabited-territory",
]);

export const polygonGeometrySchema = z.custom<PolygonGeometry>(
  (value) => {
    try {
      assertPolygonGeometry(value);
      return true;
    } catch {
      return false;
    }
  },
  {message: "geometry must be a valid Polygon or MultiPolygon"},
);

export const countryNamesSchema = z.strictObject({
  shortKo: nonEmptyText,
  officialKo: nonEmptyText,
  mapKo: nonEmptyText,
  english: nonEmptyText,
  searchAliases: z.array(nonEmptyText),
});

export const countryCapitalSchema = z.strictObject({
  nameKo: nonEmptyText,
  nameEn: nonEmptyText,
  coordinates: positionSchema.nullable(),
});

export const countryPresentationSchema = z.strictObject({
  flagCode: z.string().trim(),
  region: nonEmptyText,
  center: positionSchema,
  defaultZoom: finiteNumber.nonnegative(),
  labelRank: z.number().int().nonnegative().safe(),
});

export const countryEntitySchema: z.ZodType<CountryEntity> = z.strictObject({
  id: nonEmptyText,
  iso3: nonEmptyText,
  names: countryNamesSchema,
  geometry: polygonGeometrySchema,
  mapColor: nonEmptyText,
  playable: z.boolean(),
  unitType: countryUnitTypeSchema,
  capital: countryCapitalSchema.nullable(),
  presentation: countryPresentationSchema,
});

export const countryCreatePayloadSchema = z.strictObject({
  country: countryEntitySchema,
  initialPresentation: countryPresentationSchema.optional(),
});

export const countryCreateCommandSchema = mapCommandEnvelopeSchema.extend({
  type: z.literal("country.create"),
  payload: countryCreatePayloadSchema,
});

export type CountryCreatePayload = z.infer<typeof countryCreatePayloadSchema>;
export type CountryCreateCommand = z.infer<typeof countryCreateCommandSchema>;

const hasOwn = (value: object, key: string) =>
  Object.prototype.hasOwnProperty.call(value, key);

export const countryCreateCommandSchemaFor = (
  state: Pick<WorldState, "countriesById">,
) =>
  countryCreateCommandSchema.superRefine((command, context) => {
    const countryId = command.payload.country.id;
    if (hasOwn(state.countriesById, countryId)) {
      context.addIssue({
        code: "custom",
        path: ["payload", "country", "id"],
        message: `Country already exists: ${countryId}`,
      });
    }
  });

export const parseCountryCreateCommand = (
  input: unknown,
  state: Pick<WorldState, "countriesById">,
): CountryCreateCommand => countryCreateCommandSchemaFor(state).parse(input);

export const safeParseCountryCreateCommand = (
  input: unknown,
  state: Pick<WorldState, "countriesById">,
) => countryCreateCommandSchemaFor(state).safeParse(input);
