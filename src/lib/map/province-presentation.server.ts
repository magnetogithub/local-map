import 'server-only';
import {z} from 'zod';
import type {OperationalCatalog} from '../world/operational-catalog.server';
import {assertWorldGeometryCatalogRefMatches, createWorldGeometryCatalogRef} from '../world/world-geometry-catalog-ref';

const province = z.string().regex(/^macro:CHN:CN-\d{2}$/);
const schema = z.object({
  schemaVersion: z.literal('chn-province-presentation-v1'), countryId: z.literal('CHN'), administrativeTruthClaim: z.literal(false),
  catalogRef: z.unknown(), provinces: z.array(z.object({id: province, name: z.string()})),
  cells: z.array(z.object({ordinal: z.number().int().positive(), id: z.string(), sourceFeatureId: z.string().nullable(), renderProvinceId: province.nullable()})),
});

/** Read only after checking the independently accepted artifact digest. This partial
 * runtime contract does not prove source identities; the offline verifier does. */
export function readProvincePresentation(value: unknown, catalog: OperationalCatalog): ReadonlyMap<number, string | null> {
  const data = schema.parse(value);
  assertWorldGeometryCatalogRefMatches(createWorldGeometryCatalogRef(data.catalogRef), catalog.ref);
  const provinces = new Set(data.provinces.map(p => p.id));
  if (provinces.size !== 31 || provinces.size !== data.provinces.length) throw Error('INVALID_PROVINCE_PRESENTATION_PROVINCES');
  const cells = catalog.loadCountry('CHN');
  if (cells.length !== data.cells.length) throw Error('INVALID_PROVINCE_PRESENTATION_MEMBERSHIP');
  const families = new Map<string, string | null>(), result = new Map<number, string | null>();
  data.cells.forEach((row, i) => {
    const cell = cells[i], parent = catalog.administrativeParents[cell.administrativeOrdinal - 1];
    if (row.ordinal !== cell.ordinal || row.id !== cell.id || (row.renderProvinceId !== null && !provinces.has(row.renderProvinceId))) throw Error('INVALID_PROVINCE_PRESENTATION_MEMBERSHIP');
    if (parent.kind === 'administrative' && parent.adminId !== `fine-macro:CHN:${row.renderProvinceId}`) throw Error('PROVINCE_PRESENTATION_VERIFIED_PARENT_CHANGED');
    if (row.sourceFeatureId === null && row.renderProvinceId !== null) throw Error('PROVINCE_PRESENTATION_SOURCE_FREE_ASSIGNMENT');
    if (row.sourceFeatureId !== null) {
      if (families.has(row.sourceFeatureId) && families.get(row.sourceFeatureId) !== row.renderProvinceId) throw Error('PROVINCE_PRESENTATION_SPLIT_FAMILY');
      families.set(row.sourceFeatureId, row.renderProvinceId);
    }
    result.set(row.ordinal, row.renderProvinceId);
  });
  return result;
}

/** Caller supplies an actual positive shared edge from admitted incidence.
 * Both sides must be CHN; null stays unresolved. */
export function isProvincePresentationBoundary(left: {ordinal: number; sourceCountryId: string}, right: {ordinal: number; sourceCountryId: string}, groups: ReadonlyMap<number, string | null>) {
  if (left.sourceCountryId !== 'CHN' || right.sourceCountryId !== 'CHN') return false;
  const a = groups.get(left.ordinal), b = groups.get(right.ordinal);
  return a != null && b != null && a !== b;
}
