import {z} from 'zod';
import type {OperationalCatalogDescriptor} from '../world/operational-catalog';
import {assertWorldGeometryCatalogRefMatches, createWorldGeometryCatalogRef, type WorldGeometryCatalogRef} from '../world/world-geometry-catalog-ref';
import {catalogArtifactIdentity, type CatalogArtifactIdentity} from './catalog-consumer-contract';

export const OPERATIONAL_DELIVERY_SCHEMA = 'operational-world-delivery-v2';
export const OPERATIONAL_MAP_SOURCE_ID = 'world-operational-catalog';
export type OperationalMapBootstrap = Readonly<{
  schemaVersion: 'operational-map-bootstrap-v1';
  catalog: OperationalCatalogDescriptor;
  manifest: CatalogArtifactIdentity;
  tileIndex: CatalogArtifactIdentity;
  detailIndex: CatalogArtifactIdentity;
  parents: CatalogArtifactIdentity;
  coverage: CatalogArtifactIdentity;
  /** Verified administrative contacts; operational subdivisions stay debug-only. */
  legacyBoundaryOrdinals?: readonly number[];
  /** Source-backed map grouping only; never an administrative/gameplay parent. */
  provincePresentationBoundaryOrdinals?: readonly number[];
  provincePresentationRoot?: string;
  /** Optional display-only line LOD, bound to this catalog without changing game geometry. */
  provinceBoundaryLod?: Readonly<{artifact: CatalogArtifactIdentity; bounds: readonly [number, number, number, number]; minZoom: 2.2; maxZoom: 7}>;
  microBoundaryLod?: Readonly<{artifact: CatalogArtifactIdentity; bounds: readonly [number, number, number, number]; minZoom: 2.2; maxZoom: 7; edgeOrdinals: readonly number[]}>;
}>;
const positive = z.number().int().positive().max(0xffffffff);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const descriptorSchema = z.strictObject({
  schemaVersion: z.literal('operational-catalog-v1'), catalogRef: z.unknown(),
  indexRoots: z.strictObject({catalogOrder: hash, administrativeMembership: hash, previousParent: hash}),
  counts: z.strictObject({countries: positive, cells: positive, edges: positive, administrativeParents: positive, previousParents: positive}),
  countryOrder: z.array(z.string().regex(/^[A-Z]{3}$/)).min(1),
});
const bootstrapSchema = z.strictObject({
  schemaVersion: z.literal('operational-map-bootstrap-v1'), catalog: descriptorSchema,
  manifest: z.unknown(), tileIndex: z.unknown(), detailIndex: z.unknown(), parents: z.unknown(), coverage: z.unknown(),
  legacyBoundaryOrdinals: z.array(positive).optional().default([]),
  provincePresentationBoundaryOrdinals: z.array(positive).optional().default([]), provincePresentationRoot: hash.optional(),
  provinceBoundaryLod: z.strictObject({artifact: z.unknown(), bounds: z.tuple([z.number().finite(), z.number().finite(), z.number().finite(), z.number().finite()]),
    minZoom: z.literal(2.2), maxZoom: z.literal(7)}).optional(),
  microBoundaryLod: z.strictObject({artifact: z.unknown(), bounds: z.tuple([z.number().finite(), z.number().finite(), z.number().finite(), z.number().finite()]),
    minZoom: z.literal(2.2), maxZoom: z.literal(7), edgeOrdinals: z.array(positive).min(1)}).optional(),
});
export function readOperationalMapBootstrap(value: unknown, expected: WorldGeometryCatalogRef): OperationalMapBootstrap {
  const b = bootstrapSchema.parse(value), ref = createWorldGeometryCatalogRef(b.catalog.catalogRef);
  assertWorldGeometryCatalogRefMatches(ref, expected);
  if (!/^catalog-v3-/.test(ref.catalogVersion) || b.catalog.counts.countries !== b.catalog.countryOrder.length ||
      b.catalog.countryOrder.some((id, i, all) => i > 0 && id <= all[i - 1])) throw Error('INVALID_OPERATIONAL_BOOTSTRAP');
  if (b.legacyBoundaryOrdinals.some((n, i, all) => n > b.catalog.counts.edges || (i > 0 && n <= all[i - 1]))) throw Error('INVALID_OPERATIONAL_LEGACY_BOUNDARIES');
  if (b.provincePresentationBoundaryOrdinals.some((n, i, all) => n > b.catalog.counts.edges || (i > 0 && n <= all[i - 1])) ||
      (b.provincePresentationBoundaryOrdinals.length > 0 && !b.provincePresentationRoot)) throw Error('INVALID_OPERATIONAL_PROVINCE_PRESENTATION');
  const names = {manifest: 'manifest.json', tileIndex: 'tile-index.json', detailIndex: 'detail-index.json', parents: 'metadata/parents.json.gz', coverage: 'lod-coverage.json.gz'} as const;
  const identities = Object.fromEntries(Object.entries(names).map(([key, file]) => {
    const a = catalogArtifactIdentity(b[key as keyof typeof names], ref);
    if (a.path !== `/data/territory-catalog/${ref.catalogVersion}/${file}`) throw Error('INVALID_OPERATIONAL_BOOTSTRAP_PATH');
    return [key, a];
  })) as Pick<OperationalMapBootstrap, keyof typeof names>;
  if (identities.manifest.path !== ref.manifestPath) throw Error('INVALID_OPERATIONAL_MANIFEST_PATH');
  let provinceBoundaryLod: OperationalMapBootstrap['provinceBoundaryLod'];
  if (b.provinceBoundaryLod) {
    const lod = b.provinceBoundaryLod, a = catalogArtifactIdentity(lod.artifact, ref), [w, s, e, n] = lod.bounds;
    if (!b.provincePresentationRoot || !b.provincePresentationBoundaryOrdinals.length || w < -180 || e > 180 || s < -90 || n > 90 || w >= e || s >= n ||
        a.path !== `/data/territory-catalog/${ref.catalogVersion}/display/chn-province-lines-${a.sha256}.geojson.gz` || !a.byteLength) throw Error('INVALID_PROVINCE_BOUNDARY_LOD');
    provinceBoundaryLod = Object.freeze({...lod, artifact: a, bounds: Object.freeze([...lod.bounds]) as readonly [number, number, number, number]});
  }
  let microBoundaryLod: OperationalMapBootstrap['microBoundaryLod'];
  if (b.microBoundaryLod) {
    const lod = b.microBoundaryLod, a = catalogArtifactIdentity(lod.artifact, ref), [w, s, e, n] = lod.bounds;
    const macroIds = new Set(b.provincePresentationBoundaryOrdinals);
    if (w < -180 || e > 180 || s < -90 || n > 90 || w >= e || s >= n ||
        lod.edgeOrdinals.some((id, i, all) => id > b.catalog.counts.edges || (i > 0 && id <= all[i - 1]) || macroIds.has(id)) ||
        a.path !== `/data/territory-catalog/${ref.catalogVersion}/display/chn-micro-lines-${a.sha256}.geojson.gz` || !a.byteLength) throw Error('INVALID_MICRO_BOUNDARY_LOD');
    microBoundaryLod = Object.freeze({...lod, artifact: a, bounds: Object.freeze([...lod.bounds]) as readonly [number, number, number, number], edgeOrdinals: Object.freeze(lod.edgeOrdinals)});
  }
  return Object.freeze({...identities, schemaVersion: b.schemaVersion, catalog: Object.freeze({...b.catalog, catalogRef: ref}),
    legacyBoundaryOrdinals: Object.freeze(b.legacyBoundaryOrdinals),
    provincePresentationBoundaryOrdinals: Object.freeze(b.provincePresentationBoundaryOrdinals),
    ...(b.provincePresentationRoot ? {provincePresentationRoot: b.provincePresentationRoot} : {}),
    ...(provinceBoundaryLod ? {provinceBoundaryLod} : {}), ...(microBoundaryLod ? {microBoundaryLod} : {})});
}

/** Delivery manifests carry additional source roots; never silently discard their identity. */
export function assertOperationalDeliveryRef(value: unknown, catalog: OperationalCatalogDescriptor) {
  const r = z.object({catalogVersion: z.string(), geometryRoot: hash, topologyRoot: hash, renderArtifactRoot: hash,
    catalogOrderRoot: hash, administrativeMembershipRoot: hash, previousParentRoot: hash}).parse(value);
  assertWorldGeometryCatalogRefMatches(createWorldGeometryCatalogRef({catalogVersion: r.catalogVersion,
    geometryRoot: r.geometryRoot, topologyRoot: r.topologyRoot, renderArtifactRoot: r.renderArtifactRoot,
    manifestPath: catalog.catalogRef.manifestPath}), catalog.catalogRef);
  if (r.catalogOrderRoot !== catalog.indexRoots.catalogOrder || r.administrativeMembershipRoot !== catalog.indexRoots.administrativeMembership ||
      r.previousParentRoot !== catalog.indexRoots.previousParent) throw Error('OPERATIONAL_DELIVERY_ROOT_MISMATCH');
}
