import {z} from "zod";

import {readTerritoryId} from "../world/territory-id";
import {
  boundedTitleSchema,
  countryIdSchema,
  nullableCountryIdSchema,
  simulationIdSchema,
} from "./simulation-contract-primitives";

const territoryIdSchema = z.string().max(512).refine((value) => {
  try {
    readTerritoryId(value);
    return true;
  } catch {
    return false;
  }
}, "Expected an existing TerritoryId reference");

export const subdivisionReferenceSchema = z.strictObject({
  catalogId: simulationIdSchema,
  sourceVersion: z.string().trim().min(1).max(128),
  subdivisionId: z.string().trim().min(1).max(128),
});

const effectBase = {
  effectId: simulationIdSchema,
  causedByEventId: simulationIdSchema,
};

const countryRenamedEffectSchema = z.strictObject({
  ...effectBase,
  type: z.literal("country.renamed"),
  countryId: countryIdSchema,
  displayName: boundedTitleSchema,
});

const countriesUnifiedEffectSchema = z.strictObject({
  ...effectBase,
  type: z.literal("countries.unified"),
  countryIds: z.array(countryIdSchema).min(2).max(16),
  newCountryRef: simulationIdSchema,
  displayName: boundedTitleSchema,
});

const countryEstablishedEffectSchema = z.strictObject({
  ...effectBase,
  type: z.literal("country.established"),
  sourceCountryId: nullableCountryIdSchema,
  territoryIds: z.array(territoryIdSchema).max(64),
  subdivisionRefs: z.array(subdivisionReferenceSchema).max(64),
  newCountryRef: simulationIdSchema,
  displayName: boundedTitleSchema,
}).refine(
  (value) => value.territoryIds.length + value.subdivisionRefs.length > 0,
  {message: "country.established requires a territory or subdivision reference"},
);

const countryDissolvedEffectSchema = z.strictObject({
  ...effectBase,
  type: z.literal("country.dissolved"),
  countryId: countryIdSchema,
  successorCountryId: nullableCountryIdSchema,
});

const territoriesTransferredEffectSchema = z.strictObject({
  ...effectBase,
  type: z.literal("territories.transferred"),
  fromCountryId: countryIdSchema,
  toCountryId: countryIdSchema,
  territoryIds: z.array(territoryIdSchema).min(1).max(64),
});

const subdivisionPartitionSchema = z.strictObject({
  newCountryRef: simulationIdSchema,
  displayName: boundedTitleSchema,
  subdivisionRefs: z.array(subdivisionReferenceSchema).min(1).max(64),
});

const countryPartitionedEffectSchema = z.strictObject({
  ...effectBase,
  type: z.literal("country.partitionedBySubdivisions"),
  sourceCountryId: countryIdSchema,
  partitions: z.array(subdivisionPartitionSchema).min(2).max(32),
});

export const worldEffectSchema = z.discriminatedUnion("type", [
  countryRenamedEffectSchema,
  countriesUnifiedEffectSchema,
  countryEstablishedEffectSchema,
  countryDissolvedEffectSchema,
  territoriesTransferredEffectSchema,
  countryPartitionedEffectSchema,
]);

export type SubdivisionReferenceV1 = z.infer<typeof subdivisionReferenceSchema>;
export type WorldEffectV1 = z.infer<typeof worldEffectSchema>;

