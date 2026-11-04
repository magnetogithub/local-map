import type {FineProfile, GeographyProducerInput, ProducerParent, Properties} from '../../../scripts/geography/current-input';
import {createSourceRegionId, type GeographyProvince, type GeographySource} from '../geography/state-province-contract';
import type {OperationalCell} from '../world/operational-catalog';

type SourceIdentity = Pick<GeographySource, 'sourceId' | 'sourceFeatureId' | 'sourceVersion' | 'artifact'>;
type Profile = Pick<FineProfile, 'sourceId' | 'sourceVersion' | 'raw' | 'rawFeatures' | 'macroSourceId' | 'macroArtifact' | 'groups'>;
export type CurrentGeographyOracleInput = {
  descriptor: {countryOrder: readonly string[]}; cells: readonly OperationalCell[]; parents: readonly ProducerParent[];
  features: ReadonlyMap<string, Properties>; fineProfiles: ReadonlyMap<string, Profile>;
  coarse: GeographyProducerInput['coarse'];
};

/** Observed partition for comparison with the independently adopted country profiles. */
export function observedGeographyCountryPartition(provinces: readonly Pick<GeographyProvince, 'sourceCountryId' | 'precision'>[]) {
  return {
    // Residual cells still belong to an adopted fine country's game envelope.
    fineCountries: new Set(provinces.filter(p => p.precision === 'fine' || p.precision === 'residual').map(p => p.sourceCountryId)),
    coarseCountries: new Set(provinces.filter(p => p.precision === 'coarse').map(p => p.sourceCountryId)),
  };
}

/** Test oracle over independently pinned catalog/raw/crosswalk inputs, never submitted metadata. */
export function deriveCurrentGeographyExpectations(input: CurrentGeographyOracleInput) {
  const countries = new Set(input.descriptor.countryOrder), fineCountries = new Set(input.fineProfiles.keys());
  if (countries.size !== input.descriptor.countryOrder.length || [...fineCountries].some(id => !countries.has(id))) throw Error('ORACLE_COUNTRY_PARTITION');
  const states = input.parents.filter(p => p.kind === 'administrative').map(parent => {
    const profile = input.fineProfiles.get(parent.sourceCountryId), group = profile?.groups.get(parent.macroId!);
    if (profile && !group) throw Error('ORACLE_STATE_CROSSWALK');
    const source: SourceIdentity = profile ? {sourceId: profile.macroSourceId, sourceFeatureId: group!.sourceFeatureId,
      sourceVersion: group!.sourceVersion, artifact: profile.macroArtifact} : {sourceId: input.coarse.sourceId,
      sourceFeatureId: parent.sourceFeatureId!, sourceVersion: input.coarse.version, artifact: input.coarse.artifact};
    return {stateId: parent.parentKey, sourceCountryId: parent.sourceCountryId, source};
  });
  const groups = new Map<string, {sourceCountryId: string; source: SourceIdentity; provinceIds: string[]}>();
  const cells = input.cells.map(cell => {
    const parent = input.parents[cell.administrativeOrdinal - 1], feature = input.features.get(cell.id), profile = input.fineProfiles.get(cell.sourceCountryId);
    if (!countries.has(cell.sourceCountryId) || !parent || parent.sourceCountryId !== cell.sourceCountryId || !feature) throw Error('ORACLE_CELL_LINK');
    const native = feature.fineSourceIdentity as {sourceId: string; sourceFeatureId: string} | null | undefined;
    let source: SourceIdentity | null = null, originalName: unknown;
    const precision: GeographyProvince['precision'] = profile ? native ? 'fine' : 'residual' : 'coarse';
    if (profile && native) {
      const raw = profile.rawFeatures.get(native.sourceFeatureId);
      if (!raw || native.sourceId !== profile.sourceId || feature.sourceVersion !== profile.sourceVersion) throw Error('ORACLE_RAW_SOURCE');
      source = {sourceId: profile.sourceId, sourceFeatureId: native.sourceFeatureId, sourceVersion: profile.sourceVersion, artifact: profile.raw};
      originalName = raw.shapeName;
    } else if (!profile && parent.kind === 'administrative') {
      const raw = input.coarse.features.get(parent.sourceFeatureId!);
      if (!raw) throw Error('ORACLE_COARSE_SOURCE');
      source = {sourceId: input.coarse.sourceId, sourceFeatureId: parent.sourceFeatureId!, sourceVersion: input.coarse.version, artifact: input.coarse.artifact};
      originalName = raw.name;
    }
    const sourceRegionId = source ? createSourceRegionId(cell.sourceCountryId, source.sourceId, source.sourceFeatureId) : null;
    if (sourceRegionId) {
      const group = groups.get(sourceRegionId) ?? {sourceCountryId: cell.sourceCountryId, source: source!, provinceIds: []};
      group.provinceIds.push(cell.id); groups.set(sourceRegionId, group);
    }
    return {provinceId: cell.id, sourceCountryId: cell.sourceCountryId, ordinal: cell.ordinal,
      stateId: parent.kind === 'administrative' ? parent.parentKey : null, precision, source, sourceRegionId,
      derivedDisplay: source === null || typeof originalName !== 'string' || !originalName.trim()};
  });
  if (new Set(cells.map(c => c.provinceId)).size !== cells.length || new Set(states.map(s => s.stateId)).size !== states.length) throw Error('ORACLE_DUPLICATE_ID');
  return {countries, fineCountries, coarseCountries: new Set([...countries].filter(id => !fineCountries.has(id))), states, cells, groups};
}
