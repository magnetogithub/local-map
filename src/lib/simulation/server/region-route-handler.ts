import {z} from 'zod';
import {loadCatalogRegionIndex} from '../catalog-region.server';
import {createWorldGeometryCatalogRef, type WorldGeometryCatalogRef} from '../../world/world-geometry-catalog-ref';
import {subdivisionReferenceSchema} from '../world-effect';
import {regionOperation, type CatalogRegionIndex} from '../catalog-region';
import {geographyMetadataRefSchema, geographyCatalogRefSchema} from '../../geography/state-province-contract';
import {geographyReadRequestSchema, executeGeographyRead, assertGeographyContextSnapshot} from '../../geography/state-province-read';
import {compactRegion, loadRegionGeography, type RegionGeographyLoader} from '../../geography/state-province-region.server';
import type {GeographySnapshot} from '../../geography/state-province-io';
import {OPERATIONAL_CATALOG_VERSION} from '../../world/operational-catalog';

const legacySchema = z.strictObject({catalogRef: z.unknown(), countryId: z.string().min(1).max(160), operation: regionOperation,
  mode: z.enum(['action', 'membership']).optional(), query: z.string().min(1).max(120).optional(),
  reference: subdivisionReferenceSchema.optional(), limit: z.number().int().min(1).max(128).optional(),
  metadataRef: geographyMetadataRefSchema.optional(),
});
const geographySchema = z.strictObject({mode: z.literal('geography'), catalogRef: geographyCatalogRefSchema,
  metadataRef: geographyMetadataRefSchema.nullable(), request: geographyReadRequestSchema});
const schema = z.union([geographySchema, legacySchema]);

export function createRegionPost(dependencies: Readonly<{
  loadGeography?: RegionGeographyLoader;
  loadIndex?: (ref: WorldGeometryCatalogRef, snapshot?: GeographySnapshot) => CatalogRegionIndex;
}> = {}) {
  return async function POST(request: Request) {
    const respond = (body: unknown, status = 200) => Response.json(body, {status, headers: {'Cache-Control': 'no-store'}});
    if (Number(request.headers.get('content-length')) > 4096) return respond({ok: false, code: 'REGION_REQUEST_CAP'}, 413);
    try {
      const raw = await request.text();
      if (new TextEncoder().encode(raw).length > 4096) return respond({ok: false, code: 'REGION_REQUEST_CAP'}, 413);
      const args = schema.parse(JSON.parse(raw));
      const catalogRef = createWorldGeometryCatalogRef(args.catalogRef);
      let snapshot: GeographySnapshot | undefined;
      if (args.mode === 'geography' || args.metadataRef || catalogRef.catalogVersion === OPERATIONAL_CATALOG_VERSION) {
        const loaded = await (dependencies.loadGeography ?? loadRegionGeography)({catalogRef, metadataRef: args.metadataRef ?? null});
        if (loaded.status !== 'available') return respond({ok: false, status: loaded.status, diagnostics: loaded.diagnostics}, loaded.status === 'stale' ? 409 : 503);
        snapshot = loaded.snapshot;
        assertGeographyContextSnapshot({catalogRef, metadataRef: args.metadataRef ?? snapshot.metadataRef}, snapshot);
      }
      if (args.mode === 'geography') {
        const result = executeGeographyRead(snapshot!, args.request);
        return respond({...result, countryIdSemantics: 'source'}, result.ok ? 200 : 400);
      }
      const index = (dependencies.loadIndex ?? loadCatalogRegionIndex)(catalogRef, snapshot);
      if (args.reference) return respond({ok: true, countryIdSemantics: 'source', region: args.mode === 'membership'
        ? index.lookup(args.countryId, args.reference) : index.resolve(args.countryId, args.reference, args.operation)});
      if (args.query) {
        const found = index.search(args.countryId, args.query);
        if (found.length !== 1) return respond({ok: false, code: found.length ? 'AMBIGUOUS_REGION' : 'UNKNOWN_REGION',
          candidates: found.slice(0, 8).map(compactRegion), totalMatches: found.length, truncated: found.length > 8, ambiguous: found.length > 1, countryIdSemantics: 'source'});
        return respond({ok: true, region: compactRegion(found[0]), countryIdSemantics: 'source'});
      }
      const regions = index.listCountry(args.countryId), limit = args.limit ?? 128;
      return respond({ok: true, regions: regions.slice(0, limit).map(compactRegion), clipped: regions.length > limit,
        totalMatches: regions.length, truncated: regions.length > limit, countryIdSemantics: 'source'});
    } catch (error) {
      return respond({ok: false, code: error instanceof Error ? error.message : 'INVALID_REGION_REQUEST'}, 400);
    }
  };
}
