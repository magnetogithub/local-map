import {
  normalizeGeographyName, type GeographyMetadata, type GeographyNames, type GeographySource,
} from '../../src/lib/geography/state-province-contract';
import {requireInput, type GeographyProducerInput, type Properties} from './current-input';

const label = (value: unknown): string | null => typeof value === 'string' && value.trim() ? value.trim().replace(/\s+/gu, ' ') : null;
const sourceKey = (country: string, s: Pick<GeographySource, 'sourceId' | 'sourceFeatureId' | 'sourceVersion'>) => JSON.stringify([country, s.sourceId, s.sourceFeatureId, s.sourceVersion]);
const values = (names: GeographyNames) => [names.displayName, names.sourceName?.value, names.nameKo?.value, names.nameEn?.value, ...names.aliases.map(a => a.value)].filter((v): v is string => !!v);
const sameArtifact = (a: GeographySource['artifact'], b: GeographySource['artifact']) => a.path === b.path && a.sha256 === b.sha256 && a.byteLength === b.byteLength;

/** Offline output inspection only, not the B runtime index. Returns every exact normalized candidate. */
export function findStaticNameCandidates(metadata: GeographyMetadata, query: string, kind: 'state' | 'source-region', country?: string) {
  const q = normalizeGeographyName(query);
  requireInput(q.length > 0, 'EMPTY_STATIC_NAME_QUERY');
  const records = kind === 'state' ? metadata.states : metadata.sourceRegions;
  const provinceById = new Map(metadata.provinces.map(p => [p.provinceId as string, p]));
  return records.filter(r => (!country || r.sourceCountryId === country) && values(r.names).some(v => normalizeGeographyName(v) === q)).map(record => {
    const provinceIds = record.kind === 'state' ? metadata.provinces.filter(p => p.stateId === record.stateId).map(p => p.provinceId) : record.provinceIds;
    return {kind: record.kind, id: record.kind === 'state' ? record.stateId : record.sourceRegionId,
      sourceCountryId: record.sourceCountryId, source: record.source, provinceIds,
      stateIds: [...new Set(provinceIds.map(id => provinceById.get(id)!.stateId))], coverage: record.coverage};
  });
}

/** Verify written-name facts independently of enrichment helpers; preserve original name and full group identity. */
export function verifyMetadataNames(metadata: GeographyMetadata, input: GeographyProducerInput) {
  const usedOverrides = new Set<string>();
  let aliasCount = 0, withKorean = 0, withEnglish = 0;
  for (const record of [...metadata.states, ...metadata.provinces, ...metadata.sourceRegions]) {
    const source = record.kind === 'province' ? record.sources[0] : record.source, names = record.names;
    if (!source) {
      requireInput(names.aliases.length === 0 && names.nameKo === null && names.nameEn === null, 'SOURCE_FREE_OFFICIAL_ALIAS');
      continue;
    }
    const profile = input.fineProfiles.get(record.sourceCountryId);
    let raw: Properties | undefined;
    if (source.sourceId === profile?.sourceId) raw = profile.rawFeatures.get(source.sourceFeatureId);
    else if (source.sourceId === profile?.macroSourceId) raw = profile.macroFeatures.get(source.sourceFeatureId);
    else if (source.sourceId === input.coarse.sourceId) raw = input.coarse.features.get(source.sourceFeatureId);
    requireInput(raw, 'NAME_SOURCE_IDENTITY_UNAVAILABLE');
    requireInput((names.sourceName?.value ?? null) === label(raw.shapeName ?? raw.name), 'NAME_ORIGINAL_SOURCE_CHANGED');
    const originalLocator = source.sourceId === input.coarse.sourceId ? `ne_id:${source.sourceFeatureId}`
      : source.sourceId === profile?.sourceId ? `shapeID:${source.sourceFeatureId}` : `feature:${source.sourceFeatureId}`;
    if (names.sourceName) requireInput(names.sourceName.evidence.some(e => sameArtifact(e.artifact, source.artifact) && e.locator === originalLocator), 'NAME_ORIGINAL_EVIDENCE_MISMATCH');
    const published = source.sourceId === profile?.sourceId ? profile.localizedNames?.get(source.sourceFeatureId) : undefined;
    const override = input.nameEnrichment?.overrides.entries.find(row => sourceKey(row.sourceCountryId, row) === sourceKey(record.sourceCountryId, source));
    const rawKo = label(published?.properties.native ?? raw.name_ko ?? raw.native);
    const expectedKo = override?.nameKo?.value ?? (rawKo && /[가-힣ㄱ-ㅎㅏ-ㅣ]/u.test(rawKo) ? rawKo : null);
    const expectedEn = override?.nameEn?.value ?? label(published?.properties.name ?? raw.name_en);
    requireInput((names.nameKo?.value ?? null) === expectedKo && (names.nameEn?.value ?? null) === expectedEn, 'NAME_LANGUAGE_FACT_MISMATCH');
    for (const [fact, curated] of [[names.nameKo, override?.nameKo], [names.nameEn, override?.nameEn]] as const) {
      if (!fact || curated) continue;
      const proofArtifact = published?.artifact ?? source.artifact, locator = published?.locator ?? originalLocator;
      requireInput(fact.evidence.some(e => sameArtifact(e.artifact, proofArtifact) && e.locator === locator), 'NAME_LANGUAGE_EVIDENCE_MISMATCH');
      if (published) requireInput(fact.evidence.some(e => sameArtifact(e.artifact, published.hierarchyArtifact) && e.locator === `sourceFeatureId:${source.sourceFeatureId}`), 'NAME_PUBLISHER_CROSSWALK_EVIDENCE_MISSING');
    }
    if (names.nameKo) withKorean++; if (names.nameEn) withEnglish++;
    const rawAliases = ['name_alt', 'name_local', 'gn_name', 'gns_name', 'woe_name'].flatMap(field => {
      const v = label(raw![field]); return v ? v.split('|').map(label).filter((a): a is string => !!a && a !== '-99') : [];
    });
    const allowedSourceAliases = new Set([...rawAliases, label(published?.properties.name)].filter((v): v is string => !!v).map(normalizeGeographyName));
    const emitted = new Set(values(names).map(normalizeGeographyName));
    for (const v of rawAliases) requireInput(emitted.has(normalizeGeographyName(v)), 'SOURCE_ALIAS_OMITTED');
    for (const alias of names.aliases) {
      if (alias.basis === 'source') requireInput(allowedSourceAliases.has(normalizeGeographyName(alias.value)), 'UNVERIFIED_SOURCE_ALIAS');
      else requireInput(override?.aliases.some(a => a.value === alias.value && a.language === alias.language), 'UNVERIFIED_CURATED_ALIAS');
    }
    if (override) {
      usedOverrides.add(sourceKey(record.sourceCountryId, source));
      requireInput(override.expectedSourceName === names.sourceName?.value, 'CURATED_ALIAS_ORIGINAL_IDENTITY');
      for (const alias of override.aliases) {
        requireInput(names.aliases.some(a => normalizeGeographyName(a.value) === normalizeGeographyName(alias.value)), 'CURATED_ALIAS_OMITTED');
      }
      for (const fact of [override.nameKo, override.nameEn, ...override.aliases].filter(v => v !== null)) {
        const candidates = [names.nameKo, names.nameEn, ...names.aliases].filter(v => v && normalizeGeographyName(v.value) === normalizeGeographyName(fact.value));
        requireInput(candidates.some(actual => actual && actual.evidence.some(e => sameArtifact(e.artifact, input.nameEnrichment!.overridesArtifact) && e.locator === `source:${record.sourceCountryId}:${source.sourceId}:${source.sourceFeatureId}`) &&
          fact.factIds.every(id => actual.evidence.some(e => sameArtifact(e.artifact, input.nameEnrichment!.factsArtifact) && e.locator === `fact:${id}`))), 'CURATED_ALIAS_EVIDENCE_MISSING');
      }
    }
    aliasCount += names.aliases.length;
  }
  requireInput(usedOverrides.size === (input.nameEnrichment?.overrides.entries.length ?? 0), 'CURATED_TARGET_UNUSED');
  return {status: 'validated-static-names', aliasCount, recordsWithKoreanName: withKorean, recordsWithEnglishName: withEnglish,
    curatedSourceIdentities: usedOverrides.size, originalNamesPreserved: true, allCandidatesRetained: true,
    runtimeLoaderOrApiVerification: false};
}
