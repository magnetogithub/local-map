import {
  createSourceRegionId, geographyCountryIdSchema,
  type GeographyMetadata,
} from './state-province-contract';
import {
  geographyFailure, validateGeographyMetadata,
  type GeographyAdmissionContext, type GeographyResult,
} from './state-province-validation';

export type CountryMetadataPreparation = Readonly<{
  scope: 'country-preparation';
  sourceCountryId: GeographyMetadata['countries'][number]['sourceCountryId'];
  /** A sealed one-country input, never a published full-catalog snapshot. */
  metadata: GeographyMetadata;
}>;

/**
 * Validate a producer's one-country input using the shared schema and semantics.
 * The caller supplies the full pinned catalog and independently admitted evidence;
 * neither catalog membership nor source/parent/coverage truth comes from `value`.
 * No builder, loader, files, publication or mutable world state is involved.
 */
export function validateCountryMetadataInput(
  sourceCountryId: unknown,
  value: unknown,
  context: GeographyAdmissionContext,
): GeographyResult<CountryMetadataPreparation> {
  const country = geographyCountryIdSchema.safeParse(sourceCountryId);
  if (!country.success) return geographyFailure('GEOGRAPHY_CATALOG', 'sourceCountryId', 'Expected an existing catalog CountryId, not a name or ISO alias');
  const countryId = country.data;
  const territoryOrder = context.catalog.territoryOrder.filter(id => context.catalog.territoriesById[id].sourceCountryId === countryId);
  if (!context.countryIds.includes(countryId) || !territoryOrder.length) {
    return geographyFailure('GEOGRAPHY_CATALOG', 'sourceCountryId', 'CountryId has no registered territories in the pinned catalog');
  }

  const parentKeys = new Set(context.administrativeParents.filter(p => p.sourceCountryId === countryId).map(p => p.parentKey));
  const sourceMemberships = context.sourceMemberships.filter(s => s.sourceCountryId === countryId);
  // Scope independent witnesses by admitted identities, not by the submitted records.
  // Otherwise omitting a record could also silently remove its verification evidence.
  const targets = new Set([
    ...[...parentKeys].map(id => `state:${id}`),
    ...sourceMemberships.map(s => `source-region:${createSourceRegionId(countryId, s.source.sourceId, s.source.sourceFeatureId)}`),
  ]);
  const scopedContext: GeographyAdmissionContext = {
    catalog: {
      ref: context.catalog.ref,
      territoryOrder,
      territoriesById: Object.fromEntries(territoryOrder.map(id => [id, context.catalog.territoriesById[id]])),
    },
    countryIds: [countryId],
    cells: context.cells.filter(c => c.sourceCountryId === countryId),
    // Keep the original array: administrativeOrdinal is a global one-based index.
    administrativeParents: context.administrativeParents,
    parentSources: context.parentSources.filter(p => parentKeys.has(p.parentKey)),
    sourceMemberships,
    coverageWitnesses: context.coverageWitnesses.filter(w => targets.has(`${w.target.kind}:${w.target.id}`)),
  };
  const result = validateGeographyMetadata(value, scopedContext);
  if (!result.ok) return result;
  return {ok: true, value: Object.freeze({scope: 'country-preparation', sourceCountryId: countryId, metadata: result.value})};
}
