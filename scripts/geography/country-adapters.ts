import {
  type GeographyArtifact, type GeographyCoverage, type GeographyEvidence, type GeographyNames, type GeographySource,
} from '../../src/lib/geography/state-province-contract';
import type {OperationalCell} from '../../src/lib/world/operational-catalog';
import {requireInput, type GeographyProducerInput, type ProducerParent, type Properties} from './current-input';
import {appendNameAliases} from './name-enrichment';

export const evidenceAt = (artifact: GeographyArtifact, locator: string, method: string): GeographyEvidence => ({artifact, locator, method});
/** Canonical whitespace only; original source bytes and feature IDs remain untouched. */
export const sourceText = (value: unknown): string | null => typeof value === 'string' && value.trim() ? value.trim().replace(/\s+/gu, ' ') : null;
export function sourceNames(value: unknown, evidence: GeographyEvidence[], fallback: string, properties: Properties = {}): GeographyNames {
  const original = sourceText(value), providedKo = sourceText(properties.name_ko ?? properties.native), en = sourceText(properties.name_en);
  const ko = providedKo && /[가-힣ㄱ-ㅎㅏ-ㅣ]/u.test(providedKo) ? providedKo : null;
  const names: GeographyNames = {displayName: original ?? fallback, displayBasis: original ? 'source' : 'derived', displayEvidence: evidence,
    sourceName: original ? {value: original, basis: 'source', evidence} : null,
    nameKo: ko ? {value: ko, basis: 'source', evidence} : null,
    nameEn: en ? {value: en, basis: 'source', evidence} : null, aliases: []};
  const aliases = ['name_alt', 'name_local', 'gn_name', 'gns_name', 'woe_name'].flatMap(field => {
    const value = sourceText(properties[field]);
    return value ? value.split('|').map(v => sourceText(v)).filter((v): v is string => !!v && v !== '-99').map(value => ({value,
      language: 'und' as const, basis: 'source' as const, evidence: evidence.map(e => ({...e, locator: `${e.locator}/field:${field}`}))})) : [];
  });
  return appendNameAliases(names, aliases);
}
export function limitedCoverage(knownProvinceCount: number, coarse: boolean, evidence: GeographyEvidence[]): GeographyCoverage {
  return {status: coarse ? 'unsupported' : 'partial', knownProvinceCount, expectedProvinceCount: null, evidence,
    limitations: [coarse ? 'Existing coarse game membership only; no fine subdivision coverage.' : 'Complete known cell linkage is retained; complete original geographic coverage has not been independently admitted.']};
}
function sourceRef(sourceId: string, sourceFeatureId: string, sourceVersion: string, artifact: GeographyArtifact): GeographySource {
  return {sourceId, sourceFeatureId, sourceVersion, artifact, temporalStatus: 'source-vintage-only',
    temporalNotes: ['Pinned source vintage; exact scenario-date administrative status is not certified. See source-lock and hierarchy evidence.']};
}

export function parentSource(input: GeographyProducerInput, parent: ProducerParent) {
  requireInput(parent.kind === 'administrative', 'RESIDUAL_IS_NOT_STATE');
  const profile = input.fineProfiles.get(parent.sourceCountryId);
  if (profile) {
    const group = parent.macroId ? profile.groups.get(parent.macroId) : undefined;
    requireInput(group && parent.sourceVersion === group.sourceVersion, `PARENT_SOURCE_CROSSWALK:${parent.parentKey}`);
    const raw = profile.macroFeatures.get(group.sourceFeatureId);
    requireInput(raw, `PARENT_RAW_FEATURE:${group.sourceFeatureId}`);
    const source = sourceRef(profile.macroSourceId, group.sourceFeatureId, group.sourceVersion, profile.macroArtifact);
    const evidence = [evidenceAt(profile.macroArtifact, `feature:${group.sourceFeatureId}`, 'pinned-macro-name'),
      evidenceAt(profile.hierarchy, `macroId:${group.macroId}`, 'verified-source-parent-crosswalk')];
    return {source, names: sourceNames(raw.shapeName ?? raw.name, evidence, parent.parentKey, raw), evidence, coarse: false};
  }
  requireInput(parent.sourceFeatureId && parent.sourceVersion === input.coarse.version, `COARSE_PARENT_SOURCE:${parent.parentKey}`);
  const raw = input.coarse.features.get(parent.sourceFeatureId);
  requireInput(raw, `COARSE_RAW_FEATURE:${parent.sourceFeatureId}`);
  const source = sourceRef(input.coarse.sourceId, parent.sourceFeatureId, input.coarse.version, input.coarse.artifact);
  const evidence = [evidenceAt(input.coarse.artifact, `ne_id:${parent.sourceFeatureId}`, 'registered-coarse-parent-source')];
  return {source, names: sourceNames(raw.name, evidence, parent.parentKey, raw), evidence, coarse: true};
}

export function provinceSource(input: GeographyProducerInput, cell: OperationalCell) {
  const parent = input.parents[cell.administrativeOrdinal - 1], p = input.features.get(cell.id)!;
  const profile = input.fineProfiles.get(cell.sourceCountryId);
  const cellEvidence = evidenceAt(input.bundle, `feature:${cell.id}`, 'exact-current-cell-source-link');
  const fallback = `${cell.sourceCountryId} fragment ${cell.id.slice('territory:catalog:'.length, 'territory:catalog:'.length + 12)}`;
  if (profile && p.fineSourceIdentity) {
    const identity = p.fineSourceIdentity as {sourceId: string; sourceFeatureId: string};
    requireInput(identity.sourceId === profile.sourceId && p.sourceId === identity.sourceId && p.sourceFeatureId === identity.sourceFeatureId && p.sourceVersion === profile.sourceVersion, `CELL_FINE_IDENTITY:${cell.id}`);
    const raw = profile.rawFeatures.get(identity.sourceFeatureId), normalized = profile.normalizedFeatures.get(identity.sourceFeatureId);
    requireInput(raw && normalized && p.name === normalized.name, `CELL_RAW_NAME:${cell.id}`);
    const assignment = profile.assignments.get(identity.sourceFeatureId);
    if (assignment) requireInput(parent.kind === 'administrative' && parent.macroId === assignment.macroId && p.sourceParentId === assignment.macroId, `CELL_VERIFIED_PARENT:${cell.id}`);
    else requireInput(profile.unresolved.has(identity.sourceFeatureId) && parent.kind === 'country-envelope-residual' && p.sourceParentId === null, `CELL_UNASSIGNED_PARENT:${cell.id}`);
    const source = sourceRef(profile.sourceId, identity.sourceFeatureId, profile.sourceVersion, profile.raw);
    const evidence = [evidenceAt(profile.raw, `shapeID:${identity.sourceFeatureId}`, 'pinned-source-name'), cellEvidence];
    return {source, names: sourceNames(raw.shapeName, evidence, fallback), evidence,
      parentEvidence: [evidenceAt(profile.hierarchy, `sourceFeatureId:${identity.sourceFeatureId}`, assignment?.method ?? 'explicit-unresolved-parent'), cellEvidence],
      precision: 'fine' as const, geometryStatus: 'game-adjusted' as const};
  }
  if (!profile && parent.kind === 'administrative') {
    const resolved = parentSource(input, parent);
    return {...resolved, parentEvidence: [...resolved.evidence, cellEvidence], evidence: [...resolved.evidence, cellEvidence],
      precision: 'coarse' as const, geometryStatus: 'game-adjusted' as const};
  }
  requireInput(parent.kind === 'country-envelope-residual' && !p.fineSourceIdentity, `SOURCE_FREE_PARENT:${cell.id}`);
  return {source: null, names: sourceNames(null, [cellEvidence], fallback), evidence: [cellEvidence], parentEvidence: [cellEvidence],
    precision: profile ? 'residual' as const : 'coarse' as const, geometryStatus: 'source-free' as const};
}
