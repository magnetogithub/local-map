import {z} from 'zod';
import {COUNTRY_ID_PATTERN} from '../world/country-id';
import {canonicalSerialize} from '../world/canonical-serializer';
import {sha256Hex} from '../world/sha256';
import {createWorldGeometryCatalogRef, readCatalogTerritoryId} from '../world/world-geometry-catalog-ref';
import {readWorldV3CountryId} from '../world/world-v3-validation';

export const GEOGRAPHY_SCHEMA_VERSION = 'state-province-metadata-v1' as const;
const text = z.string().min(1).max(512).refine(v => v === v.trim() && !/[\u0000-\u001f]/u.test(v), 'Expected nonempty canonical text');
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const geographySha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
export const geographyCountryIdSchema = z.string().regex(COUNTRY_ID_PATTERN).transform(v => readWorldV3CountryId(v, 'sourceCountryId'));
/** The existing reader preserves the TerritoryId brand and its exact namespace. */
export const provinceIdSchema = z.string().regex(/^territory:catalog:[a-f0-9]{64}$/).transform(v => readCatalogTerritoryId(v));
/** An existing administrative parentKey, checked against the pinned catalog at admission. */
export const stateIdSchema = text.brand<'StateId'>();
export type StateId = z.infer<typeof stateIdSchema>;
export type ProvinceId = z.infer<typeof provinceIdSchema>;
export const sourceRegionIdSchema = z.string().regex(/^source-region:[a-f0-9]{64}$/).brand<'SourceRegionId'>();
export const geographyCatalogRefSchema = z.unknown().transform((value, context) => {
  try {return createWorldGeometryCatalogRef(value);}
  catch (error) {context.addIssue({code: 'custom', message: error instanceof Error ? error.message : 'Invalid catalogRef'}); return z.NEVER;}
});
export const geographyArtifactSchema = z.strictObject({
  path: z.string().min(1).max(512).refine(v => /^[A-Za-z0-9._/-]+$/.test(v) && v.split('/').every(p => !!p && p !== '.' && p !== '..'), 'Expected a repository-relative artifact path'),
  sha256: geographySha256Schema, byteLength: count,
});
export type GeographyArtifact = z.infer<typeof geographyArtifactSchema>;
export const geographyEvidenceSchema = z.strictObject({artifact: geographyArtifactSchema, locator: text, method: text});
const evidence = z.array(geographyEvidenceSchema).min(1);
export type GeographyEvidence = z.infer<typeof geographyEvidenceSchema>;
export const geographySourceSchema = z.strictObject({
  sourceId: text, sourceFeatureId: text, sourceVersion: text, artifact: geographyArtifactSchema,
  temporalStatus: z.enum(['scenario-verified', 'source-vintage-only', 'unknown']), temporalNotes: z.array(text),
});
export type GeographySource = z.infer<typeof geographySourceSchema>;
const nameFact = z.strictObject({value: text, basis: z.enum(['source', 'verified-translation']), evidence});
export const geographyNamesSchema = z.strictObject({
  displayName: text, displayBasis: z.enum(['source', 'verified-translation', 'derived']), displayEvidence: evidence,
  sourceName: nameFact.nullable(), nameKo: nameFact.nullable(), nameEn: nameFact.nullable(),
  aliases: z.array(z.strictObject({value: text, language: z.enum(['ko', 'en', 'und']), basis: z.enum(['source', 'verified-alias']), evidence})),
});
export type GeographyNames = z.infer<typeof geographyNamesSchema>;
/** Geographic coverage of the stated source target, NOT merely a complete response page. */
export const geographyCoverageSchema = z.strictObject({
  status: z.enum(['complete', 'partial', 'unsupported']), knownProvinceCount: count,
  expectedProvinceCount: count.nullable(), evidence: z.array(geographyEvidenceSchema), limitations: z.array(text),
});
export type GeographyCoverage = z.infer<typeof geographyCoverageSchema>;
export const geographyStateSchema = z.strictObject({
  kind: z.literal('state'), stateId: stateIdSchema, catalogParentKey: text, sourceCountryId: geographyCountryIdSchema,
  source: geographySourceSchema, names: geographyNamesSchema, coverage: geographyCoverageSchema, evidence,
});
const province = {
  kind: z.literal('province'), provinceId: provinceIdSchema, sourceCountryId: geographyCountryIdSchema,
  names: geographyNamesSchema, precision: z.enum(['fine', 'coarse', 'residual']),
  geometryStatus: z.enum(['source-exact', 'game-adjusted', 'source-free']),
  sources: z.array(geographySourceSchema), evidence, parentEvidence: evidence,
};
export const geographyProvinceSchema = z.discriminatedUnion('parentStatus', [
  z.strictObject({...province, parentStatus: z.literal('verified'), stateId: stateIdSchema, unassignedReason: z.null()}),
  z.strictObject({...province, parentStatus: z.literal('unassigned'), stateId: z.null(), unassignedReason: text}),
]);
export const geographySourceRegionSchema = z.strictObject({
  kind: z.literal('source-region'), sourceRegionId: sourceRegionIdSchema, sourceCountryId: geographyCountryIdSchema,
  source: geographySourceSchema, names: geographyNamesSchema, provinceIds: z.array(provinceIdSchema).min(1),
  coverage: geographyCoverageSchema, evidence,
});
export const geographyCountryCountsSchema = z.strictObject({
  provinces: count, states: count, sourceRegions: count, fine: count, coarse: count, residual: count,
  unassignedParents: count, derivedDisplays: count, sourceNamed: count,
});
export const geographyCountrySchema = z.strictObject({
  sourceCountryId: geographyCountryIdSchema, counts: geographyCountryCountsSchema,
  sourceFeatureCount: count.nullable(), officialSubdivisionCount: count.nullable(),
  sourceFeatureCountEvidence: z.array(geographyEvidenceSchema), officialSubdivisionCountEvidence: z.array(geographyEvidenceSchema),
  nameSupport: z.enum(['source-and-derived', 'derived-only']), parentSupport: z.enum(['complete', 'partial', 'unsupported']),
});
export const geographyMetadataRefSchema = z.strictObject({
  schemaVersion: z.literal('geography-metadata-ref-v1'), contentRoot: geographySha256Schema,
});
export type GeographyMetadataRef = z.infer<typeof geographyMetadataRefSchema>;
export const geographyMetadataBodySchema = z.strictObject({
  schemaVersion: z.literal(GEOGRAPHY_SCHEMA_VERSION), catalogRef: geographyCatalogRefSchema,
  provenance: z.strictObject({
    scenarioDate: z.iso.date(), method: text, inputs: z.array(geographyArtifactSchema).min(1),
    code: z.array(geographyArtifactSchema).min(1), limitations: z.array(text),
  }),
  states: z.array(geographyStateSchema), provinces: z.array(geographyProvinceSchema).min(1),
  sourceRegions: z.array(geographySourceRegionSchema), countries: z.array(geographyCountrySchema).min(1),
});
export const geographyMetadataSchema = geographyMetadataBodySchema.extend({metadataRef: geographyMetadataRefSchema});
export type GeographyMetadataBody = z.infer<typeof geographyMetadataBodySchema>;
export type GeographyMetadata = z.infer<typeof geographyMetadataSchema>;
export type GeographyState = z.infer<typeof geographyStateSchema>;
export type GeographyProvince = z.infer<typeof geographyProvinceSchema>;
export type GeographySourceRegion = z.infer<typeof geographySourceRegionSchema>;
export type GeographyCountry = z.infer<typeof geographyCountrySchema>;
export type GeographyTarget = Readonly<{kind: 'state' | 'province' | 'source-region'; id: string}>;

/** Source identity excludes names, game ownership and metadata release versions. */
export function createSourceRegionId(countryId: string, sourceId: string, sourceFeatureId: string) {
  return sourceRegionIdSchema.parse(`source-region:${sha256Hex(canonicalSerialize({
    namespace: 'geography-source-region-v1', countryId: geographyCountryIdSchema.parse(countryId),
    sourceId: text.parse(sourceId), sourceFeatureId: text.parse(sourceFeatureId),
  }))}`);
}

/** Seals a contract value, not a production builder. Array order is significant. */
export function sealGeographyMetadata(value: GeographyMetadataBody): GeographyMetadata {
  const body = geographyMetadataBodySchema.parse(value);
  return {...body, metadataRef: {schemaVersion: 'geography-metadata-ref-v1', contentRoot: sha256Hex(canonicalSerialize(body))}};
}

export function normalizeGeographyName(value: string): string {
  return value.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLocaleLowerCase('en-US');
}

/** Country counts are derived; a missing official/source total remains null. */
export function countGeographyCountry(body: Pick<GeographyMetadataBody, 'states' | 'provinces' | 'sourceRegions'>, countryId: string) {
  const cells = body.provinces.filter(p => p.sourceCountryId === countryId);
  return {provinces: cells.length, states: body.states.filter(s => s.sourceCountryId === countryId).length,
    sourceRegions: body.sourceRegions.filter(r => r.sourceCountryId === countryId).length,
    fine: cells.filter(p => p.precision === 'fine').length, coarse: cells.filter(p => p.precision === 'coarse').length,
    residual: cells.filter(p => p.precision === 'residual').length,
    unassignedParents: cells.filter(p => p.parentStatus === 'unassigned').length,
    derivedDisplays: cells.filter(p => p.names.displayBasis === 'derived').length,
    sourceNamed: cells.filter(p => p.names.sourceName !== null).length};
}
