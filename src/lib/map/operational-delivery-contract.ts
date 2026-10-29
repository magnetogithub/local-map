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
});
export function readOperationalMapBootstrap(value: unknown, expected: WorldGeometryCatalogRef): OperationalMapBootstrap {
  const b = bootstrapSchema.parse(value), ref = createWorldGeometryCatalogRef(b.catalog.catalogRef);
  assertWorldGeometryCatalogRefMatches(ref, expected);
  if (!/^catalog-v3-/.test(ref.catalogVersion) || b.catalog.counts.countries !== b.catalog.countryOrder.length ||
      b.catalog.countryOrder.some((id, i, all) => i > 0 && id <= all[i - 1])) throw Error('INVALID_OPERATIONAL_BOOTSTRAP');
  const names = {manifest: 'manifest.json', tileIndex: 'tile-index.json', detailIndex: 'detail-index.json', parents: 'metadata/parents.json.gz', coverage: 'lod-coverage.json.gz'} as const;
  const identities = Object.fromEntries(Object.entries(names).map(([key, file]) => {
    const a = catalogArtifactIdentity(b[key as keyof typeof names], ref);
    if (a.path !== `/data/territory-catalog/${ref.catalogVersion}/${file}`) throw Error('INVALID_OPERATIONAL_BOOTSTRAP_PATH');
    return [key, a];
  })) as Pick<OperationalMapBootstrap, keyof typeof names>;
  if (identities.manifest.path !== ref.manifestPath) throw Error('INVALID_OPERATIONAL_MANIFEST_PATH');
  return Object.freeze({...identities, schemaVersion: b.schemaVersion, catalog: Object.freeze({...b.catalog, catalogRef: ref})});
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
