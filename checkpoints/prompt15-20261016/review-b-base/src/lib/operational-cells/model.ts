import {z} from "zod";

/** Offline catalog contracts. No mutable world, runtime generation or cutover API. */
export const textSchema = z.string().min(1).refine(v => v === v.trim(), "Canonical text required");
export const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
export const countryIdSchema = z.string().regex(/^[A-Z][A-Z0-9]{2}$/);
export const cellIdSchema = z.string().regex(/^territory:catalog:[a-f0-9]{64}$/);
export const artifactPinSchema = z.strictObject({
  path: textSchema, sha256: sha256Schema, byteLength: z.number().int().nonnegative(),
});
export const catalogRefSchema = z.strictObject({
  catalogVersion: textSchema, geometryRoot: sha256Schema, topologyRoot: sha256Schema,
  renderArtifactRoot: sha256Schema,
  manifestPath: z.string().regex(/^\/data\/[A-Za-z0-9._/-]+\.json$/),
}).refine(r => !r.manifestPath.split("/").some(p => p === "." || p === "..") &&
  r.manifestPath.split("/").slice(1).every(Boolean) &&
  r.manifestPath.split("/").includes(r.catalogVersion), "Versioned local manifest required");

const positionSchema = z.tuple([z.number().finite(), z.number().finite()]);
const ringSchema = z.array(positionSchema).min(4).refine(r =>
  r[0][0] === r[r.length - 1][0] && r[0][1] === r[r.length - 1][1], "Closed ring required");
const polygonSchema = z.array(ringSchema).min(1);
/** Coordinates are in the explicitly pinned planar metre CRS, never implicit degrees. */
export const geometrySchema = z.discriminatedUnion("type", [
  z.strictObject({type: z.literal("Polygon"), coordinates: polygonSchema}),
  z.strictObject({type: z.literal("MultiPolygon"), coordinates: z.array(polygonSchema).min(1)}),
]);

/** Administrative identity is the fixed source tuple, not a TerritoryId or owner. */
export const administrativeIdentitySchema = z.strictObject({
  sourceCountryId: countryIdSchema, sourceVersion: textSchema, level: z.number().int().nonnegative(),
  sourceFeatureId: textSchema.refine(v => !v.startsWith("territory:"), "Source identity required"),
});
export const administrativeKey = (v: z.infer<typeof administrativeIdentitySchema>) =>
  JSON.stringify([v.sourceCountryId, v.sourceVersion, v.level, v.sourceFeatureId]);

export const geometryProvenanceSchema = z.strictObject({
  rawSource: artifactPinSchema, approvedGeometry: artifactPinSchema,
  // Certificate tracks raw -> aligned -> projected component and hole correspondence.
  correspondence: artifactPinSchema,
});
export const envelopeSchema = z.strictObject({
  sourceCountryId: countryIdSchema, geometry: geometrySchema, provenance: geometryProvenanceSchema,
});
export const administrativeRegionSchema = z.strictObject({
  identity: administrativeIdentitySchema, name: textSchema, geometry: geometrySchema,
  provenance: geometryProvenanceSchema,
});
export const previousTerritorySchema = z.strictObject({
  id: cellIdSchema, sourceCountryId: countryIdSchema, geometry: geometrySchema,
  geometryArtifact: artifactPinSchema,
});
export const administrativeParentSchema = z.discriminatedUnion("kind", [
  z.strictObject({kind: z.literal("administrative-region"), identity: administrativeIdentitySchema}),
  z.strictObject({kind: z.literal("no-administrative-source"), sourceCountryId: countryIdSchema,
    evidence: artifactPinSchema}),
]);
export const generationProvenanceSchema = z.strictObject({
  policy: z.strictObject({version: textSchema, artifact: artifactPinSchema}),
  generator: z.strictObject({version: textSchema, artifact: artifactPinSchema}),
  projection: z.strictObject({id: textSchema, unit: z.literal("metre"), definition: artifactPinSchema}),
  dependencies: z.array(z.strictObject({name: textSchema, version: textSchema, artifact: artifactPinSchema})).min(1),
});
export const generationInputSchema = z.strictObject({
  version: z.literal(1), kind: z.literal("offline-protected-refinement"),
  targetCatalogVersion: textSchema, previousCatalogRef: catalogRefSchema,
  provenance: generationProvenanceSchema,
  restoration: z.strictObject({status: z.literal("approved"), evidence: artifactPinSchema}),
  // One explicitly chosen administrative level per country; other levels are separate memberships.
  sourceInventory: z.array(administrativeIdentitySchema),
  noAdministrativeSource: z.array(z.strictObject({sourceCountryId: countryIdSchema, evidence: artifactPinSchema})),
  envelopes: z.array(envelopeSchema).min(1),
  administrativeRegions: z.array(administrativeRegionSchema),
  previousTerritories: z.array(previousTerritorySchema).min(1),
}).superRefine((v, ctx) => {
  const reject = (message: string) => ctx.addIssue({code: "custom", message});
  const unique = (keys: string[], kind: string) => {
    if (new Set(keys).size !== keys.length) reject(`Duplicate ${kind}`);
  };
  unique(v.envelopes.map(e => e.sourceCountryId), "envelope");
  unique(v.sourceInventory.map(administrativeKey), "source identity");
  unique(v.administrativeRegions.map(a => administrativeKey(a.identity)), "administrative identity");
  unique(v.previousTerritories.map(t => t.id), "previous territory");
  unique(v.noAdministrativeSource.map(c => c.sourceCountryId), "no-source country");
  unique(v.provenance.dependencies.map(d => d.name), "dependency");
  if (v.targetCatalogVersion === v.previousCatalogRef.catalogVersion) reject("New immutable catalog version required");
  const expected = new Set(v.sourceInventory.map(administrativeKey));
  const actual = new Set(v.administrativeRegions.map(a => administrativeKey(a.identity)));
  if (expected.size !== actual.size || [...expected].some(k => !actual.has(k))) reject("Source identity inventory mismatch");
  const countries = new Set(v.envelopes.map(e => e.sourceCountryId));
  const referencedCountries = [...v.sourceInventory.map(a => a.sourceCountryId),
    ...v.previousTerritories.map(t => t.sourceCountryId), ...v.noAdministrativeSource.map(c => c.sourceCountryId)];
  if (referencedCountries.some(c => !countries.has(c))) reject("Unknown country envelope");
  for (const country of countries) {
    const identities = v.sourceInventory.filter(a => a.sourceCountryId === country);
    const noSource = v.noAdministrativeSource.some(c => c.sourceCountryId === country);
    if ((identities.length > 0) === noSource) reject("Administrative source or explicit no-source evidence required");
    if (new Set(identities.map(a => a.level)).size > 1) reject("One partition level per country required");
    if (!v.previousTerritories.some(t => t.sourceCountryId === country)) reject("Missing protected previous geometry");
  }
});

/** Geometric base faces only; subdivision and stable-ID derivation are later tasks. */
export const refinementFaceSchema = z.strictObject({
  sourceCountryId: countryIdSchema, administrativeParent: administrativeParentSchema,
  previousGeometryParent: z.strictObject({catalogRef: catalogRefSchema, territoryId: cellIdSchema}),
  geometry: geometrySchema,
}).refine(v => (v.administrativeParent.kind === "administrative-region" ?
  v.administrativeParent.identity.sourceCountryId : v.administrativeParent.sourceCountryId) === v.sourceCountryId,
"Administrative parent country mismatch");

/** Contract only: algorithm/canonicalization and dependency pins are fixed in 15-15. */
export const cellIdentityInputSchema = z.strictObject({
  sourceCountryId: countryIdSchema, administrativeParent: administrativeParentSchema,
  previousGeometryParent: z.strictObject({catalogRef: catalogRefSchema, territoryId: cellIdSchema}),
  canonicalGeometrySha256: sha256Schema, policyVersion: textSchema,
});
export const operationalCellSchema = refinementFaceSchema.safeExtend({
  id: cellIdSchema, canonicalGeometrySha256: sha256Schema, provenance: generationProvenanceSchema,
});
export const administrativeMembershipSchema = z.strictObject({
  identity: administrativeIdentitySchema, cellIds: z.array(cellIdSchema).min(1),
}).refine(v => new Set(v.cellIds).size === v.cellIds.length, "Duplicate cell membership");

/** Positive shared length only. Country/admin/internal are independent meanings.
 * Occupation frontlines are runtime controller comparisons, not immutable edge types. */
export const adjacencySchema = z.strictObject({
  leftCellId: cellIdSchema, rightCellId: cellIdSchema,
  sharedEdgeSha256: sha256Schema, sharedLengthMetres: z.number().finite().positive(),
  boundary: z.strictObject({country: z.boolean(), administrative: z.boolean(), operational: z.literal(true)}),
}).refine(v => v.leftCellId < v.rightCellId, "Canonical distinct edge sides required");

export type GenerationInput = z.infer<typeof generationInputSchema>;
export type RefinementFace = z.infer<typeof refinementFaceSchema>;
export type OperationalCell = z.infer<typeof operationalCellSchema>;
export type AdministrativeRegion = z.infer<typeof administrativeRegionSchema>;
