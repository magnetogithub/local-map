import {z} from 'zod';
import type {WorldGeometryCatalogRef} from '../world/world-geometry-catalog-ref';
import {assertWorldGeometryCatalogRefMatches} from '../world/world-geometry-catalog-ref';
import {canonicalSerialize, canonicalStringify} from '../world/canonical-serializer';
import {sha256Hex} from '../world/sha256';
import {
  geographyArtifactSchema, geographyCatalogRefSchema, geographyCountryIdSchema, geographyCoverageSchema,
  geographyEvidenceSchema, geographyMetadataRefSchema, geographyNamesSchema, geographySourceSchema,
  provinceIdSchema, sourceRegionIdSchema, stateIdSchema,
  type GeographyArtifact, type GeographyMetadata, type GeographyMetadataRef,
} from './state-province-contract';
import {geographyFailure, type GeographyAdmissionContext, type GeographyDiagnostic, type GeographyResult} from './state-province-validation';

export const geographyTargetSchema = z.discriminatedUnion('kind', [
  z.strictObject({kind: z.literal('state'), id: stateIdSchema}),
  z.strictObject({kind: z.literal('province'), id: provinceIdSchema}),
  z.strictObject({kind: z.literal('source-region'), id: sourceRegionIdSchema}),
]);
/** Versioned new reference; never inserted into subdivisionReference.subdivisionId. */
export const geographyReferenceSchema = z.strictObject({
  catalogRef: geographyCatalogRefSchema, metadataRef: geographyMetadataRefSchema, target: geographyTargetSchema,
});
export type GeographyReference = z.infer<typeof geographyReferenceSchema>;
export const geographyCoverageWitnessSchema = z.strictObject({
  target: z.discriminatedUnion('kind', [
    z.strictObject({kind: z.literal('state'), id: stateIdSchema}),
    z.strictObject({kind: z.literal('source-region'), id: sourceRegionIdSchema}),
  ]), provinceIds: z.array(provinceIdSchema), evidence: z.array(geographyEvidenceSchema).min(1),
});
/** Built and independently verified offline; runtime joins it to metadata-only catalog rows. */
export const geographyAdmissionEvidenceSchema = z.strictObject({
  schemaVersion: z.literal('geography-admission-v1'), catalogRef: geographyCatalogRefSchema, metadataRef: geographyMetadataRefSchema,
  parentSources: z.array(z.strictObject({parentKey: stateIdSchema, source: geographySourceSchema})),
  sourceMemberships: z.array(z.strictObject({sourceCountryId: geographyCountryIdSchema, source: geographySourceSchema, provinceIds: z.array(provinceIdSchema).min(1)})),
  coverageWitnesses: z.array(geographyCoverageWitnessSchema),
});
export type GeographyAdmissionEvidence = z.infer<typeof geographyAdmissionEvidenceSchema>;
export const geographyManifestSchema = z.strictObject({
  schemaVersion: z.literal('state-province-manifest-v1'), purpose: z.enum(['fixture', 'production']),
  catalogRef: geographyCatalogRefSchema, metadataRef: geographyMetadataRefSchema,
  metadata: geographyArtifactSchema, admission: geographyArtifactSchema,
});
export type GeographyManifest = z.infer<typeof geographyManifestSchema>;
export type GeographyLoadRequest = Readonly<{catalogRef: WorldGeometryCatalogRef; metadataRef: GeographyMetadataRef | null}>;

/** JSON artifacts use canonical UTF-8 JSON plus one LF; metadataRef hashes the body WITHOUT the LF/ref. */
export const geographyArtifactBytes = (value: unknown): Uint8Array => new TextEncoder().encode(canonicalStringify(value) + '\n');
export function identifyGeographyArtifact(path: string, bytes: Uint8Array): GeographyArtifact {
  return geographyArtifactSchema.parse({path, sha256: sha256Hex(bytes), byteLength: bytes.byteLength});
}
export function verifyGeographyArtifact(artifact: GeographyArtifact, bytes: Uint8Array): GeographyResult<Uint8Array> {
  if (artifact.byteLength !== bytes.byteLength || artifact.sha256 !== sha256Hex(bytes)) return geographyFailure('GEOGRAPHY_METADATA', artifact.path, 'Artifact byte identity does not match');
  return {ok: true, value: bytes};
}
export function validateGeographyManifest(value: unknown, request: GeographyLoadRequest, allowFixture = false): GeographyResult<GeographyManifest> {
  const parsed = geographyManifestSchema.safeParse(value);
  if (!parsed.success) return geographyFailure('GEOGRAPHY_SCHEMA', 'manifest', parsed.error.issues[0].message);
  const manifest = parsed.data;
  try {assertWorldGeometryCatalogRefMatches(manifest.catalogRef, request.catalogRef);}
  catch {return geographyFailure('GEOGRAPHY_CATALOG', 'manifest.catalogRef', 'Manifest belongs to a different catalog snapshot');}
  if (manifest.purpose === 'fixture' && !allowFixture) return geographyFailure('GEOGRAPHY_SOURCE', 'manifest.purpose', 'Synthetic fixtures are not production evidence');
  if (request.metadataRef && canonicalStringify(manifest.metadataRef) !== canonicalStringify(request.metadataRef)) return geographyFailure('GEOGRAPHY_METADATA', 'manifest.metadataRef', 'Requested metadata snapshot is stale or unavailable');
  if (manifest.metadata.path === manifest.admission.path) return geographyFailure('GEOGRAPHY_SCHEMA', 'manifest', 'Metadata and independent admission evidence must be separate artifacts');
  return {ok: true, value: manifest};
}
export function validateGeographyAdmissionEvidence(value: unknown, manifest: GeographyManifest): GeographyResult<GeographyAdmissionEvidence> {
  const parsed = geographyAdmissionEvidenceSchema.safeParse(value);
  if (!parsed.success) return geographyFailure('GEOGRAPHY_SCHEMA', 'admission', parsed.error.issues[0].message);
  try {assertWorldGeometryCatalogRefMatches(parsed.data.catalogRef, manifest.catalogRef);}
  catch {return geographyFailure('GEOGRAPHY_CATALOG', 'admission.catalogRef', 'Admission evidence belongs to a different catalog');}
  if (canonicalStringify(parsed.data.metadataRef) !== canonicalStringify(manifest.metadataRef)) return geographyFailure('GEOGRAPHY_METADATA', 'admission.metadataRef', 'Admission evidence and metadata snapshot differ');
  return {ok: true, value: parsed.data};
}
export function geographySnapshotKey(catalogRef: WorldGeometryCatalogRef, metadataRef: GeographyMetadataRef): string {
  return sha256Hex(canonicalSerialize({catalogRef, metadataRef}));
}

export const GEOGRAPHY_CACHE_LIMITS = Object.freeze({maxEntries: 4, ttlMs: 300_000});
export const geographyPageRequestSchema = z.strictObject({offset: z.number().int().min(0), limit: z.number().int().min(1).max(128)});
export const geographySearchRequestSchema = z.strictObject({
  sourceCountryId: geographyCountryIdSchema.nullable(), kind: z.enum(['state', 'province', 'source-region']).nullable(),
  query: z.string().trim().min(1).max(120), page: geographyPageRequestSchema,
});
export type GeographyPageRequest = z.infer<typeof geographyPageRequestSchema>;
export type GeographySearchRequest = z.infer<typeof geographySearchRequestSchema>;
export const geographySummarySchema = z.strictObject({
  reference: geographyReferenceSchema, sourceCountryId: geographyCountryIdSchema, names: geographyNamesSchema,
  stateId: stateIdSchema.nullable(), parentStatus: z.enum(['verified', 'unassigned', 'not-applicable']),
  precision: z.enum(['fine', 'coarse', 'residual']).nullable(), geometryStatus: z.enum(['source-exact', 'game-adjusted', 'source-free']).nullable(),
  coverage: geographyCoverageSchema.nullable(), knownProvinceCount: z.number().int().nonnegative(),
  materialization: z.strictObject({status: z.enum(['requires-validation', 'unsupported']), reason: z.string().min(1).max(512)}),
});
export type GeographySummary = z.infer<typeof geographySummarySchema>;
/** One page may contain one item while the entire query is still ambiguous. */
export type GeographyPage<T> = Readonly<{
  catalogRef: WorldGeometryCatalogRef; metadataRef: GeographyMetadataRef;
  items: readonly T[]; totalMatches: number; offset: number; limit: number; truncated: boolean; ambiguous: boolean;
}>;
export type GeographyMembershipPage = GeographyPage<string> & Readonly<{reference: GeographyReference; coverage: GeographySummary['coverage']}>;
export type GeographySnapshot = Readonly<{
  catalogRef: WorldGeometryCatalogRef; metadataRef: GeographyMetadataRef; metadata: GeographyMetadata;
  search: (request: GeographySearchRequest) => GeographyResult<GeographyPage<GeographySummary>>;
  list: (request: Omit<GeographySearchRequest, 'query'>) => GeographyResult<GeographyPage<GeographySummary>>;
  inspect: (reference: GeographyReference) => GeographyResult<GeographySummary>;
  members: (reference: GeographyReference, page: GeographyPageRequest) => GeographyResult<GeographyMembershipPage>;
}>;
export type GeographyLoadResult = Readonly<{status: 'available'; snapshot: GeographySnapshot}> |
  Readonly<{status: 'unavailable' | 'stale'; diagnostics: readonly GeographyDiagnostic[]}>;
export type GeographyManifestLocation = Readonly<{status: 'available'; manifest: GeographyArtifact}> |
  Readonly<{status: 'unavailable' | 'stale'; diagnostics: readonly GeographyDiagnostic[]}>;
/** B implements the loader; A supplies pinned files. Both can use the fixture without one another. */
export type GeographyLoaderDependencies = Readonly<{
  locateManifest: (request: GeographyLoadRequest) => Promise<GeographyManifestLocation>;
  readArtifact: (artifact: GeographyArtifact) => Promise<Uint8Array>;
  catalogView: (ref: WorldGeometryCatalogRef) => Promise<Pick<GeographyAdmissionContext, 'catalog' | 'countryIds' | 'cells' | 'administrativeParents'>>;
}>;
export type GeographyLoader = (request: GeographyLoadRequest, dependencies: GeographyLoaderDependencies) => Promise<GeographyLoadResult>;
