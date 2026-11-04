import {describe, expect, it} from 'vitest';
import {createStateProvinceContractFixture} from '../../src/lib/test-only/state-province-contract-fixture';
import {geographyArtifactBytes, identifyGeographyArtifact} from '../../src/lib/geography/state-province-io';
import {appendNameAliases, enrichCuratedNames, enrichPublishedNames, nameFactsSchema, nameOverridesSchema, validateNameOverrides, type NameEnrichmentInput} from './name-enrichment';
import {sourceNames} from './country-adapters';
import {findStaticNameCandidates} from './verify-name-metadata';

function registryFixture() {
  const f = createStateProvinceContractFixture(), source = f.metadata.sourceRegions[0].source;
  const facts = nameFactsSchema.parse({schemaVersion: 'geography-name-facts-v1', reviewedOn: '2026-11-03', contentPolicy: 'Fictional labels only',
    facts: [{id: 'fictional-spellings', publisher: 'Fictional publisher', url: 'https://example.test/place', sourceDate: null,
      verifiedValues: ['스프링필드', 'Springfield', 'Spring Field'], reviewMethod: 'Synthetic name equivalence', limitation: 'No real country source'}]});
  const overrides = nameOverridesSchema.parse({schemaVersion: 'geography-source-name-overrides-v1', entries: [{
    sourceCountryId: 'AAA', sourceId: source.sourceId, sourceFeatureId: source.sourceFeatureId, sourceVersion: source.sourceVersion,
    expectedSourceName: 'Springfield', nameKo: {value: '스프링필드', factIds: ['fictional-spellings']},
    nameEn: {value: 'Springfield', factIds: ['fictional-spellings']},
    aliases: [{value: '스프링필드', language: 'ko', factIds: ['fictional-spellings']}, {value: 'Spring Field', language: 'en', factIds: ['fictional-spellings']}],
  }]});
  const input: NameEnrichmentInput = {facts, overrides,
    factsArtifact: identifyGeographyArtifact('fixtures/names/facts.json', geographyArtifactBytes(facts)),
    overridesArtifact: identifyGeographyArtifact('fixtures/names/overrides.json', geographyArtifactBytes(overrides))};
  return {f, source, input};
}

describe('offline evidence-backed place names', () => {
  it('adds reviewed Korean/English spellings to one original identity without changing sourceName', () => {
    const {f, source, input} = registryFixture(); validateNameOverrides(input);
    const names = enrichCuratedNames(f.metadata.sourceRegions[0].names, source, 'AAA', input);
    expect(names.sourceName).toEqual(f.metadata.sourceRegions[0].names.sourceName);
    expect(names.nameKo).toMatchObject({value: '스프링필드', basis: 'verified-translation'});
    expect(names.nameEn?.value).toBe('Springfield');
    expect(names.aliases.find(a => a.value === 'Spring Field')!.evidence.some(e => e.artifact.sha256 === input.factsArtifact.sha256)).toBe(true);
    expect(enrichCuratedNames(f.metadata.sourceRegions[0].names, source, 'BBB', input)).toEqual(f.metadata.sourceRegions[0].names);
    expect(enrichCuratedNames(f.metadata.sourceRegions[0].names, {...source, sourceVersion: 'stale'}, 'AAA', input)).toEqual(f.metadata.sourceRegions[0].names);
  });

  it('merges proof for normalized alias duplicates and preserves punctuation distinctions', () => {
    const {f, input} = registryFixture(), names = structuredClone(f.metadata.sourceRegions[0].names);
    names.aliases = [{value: 'ＡＢ', language: 'en', basis: 'source', evidence: names.displayEvidence}];
    const updated = appendNameAliases(names, [
      {value: 'ab', language: 'en', basis: 'verified-alias', evidence: [{artifact: input.factsArtifact, locator: 'fact:fictional-spellings', method: 'fixture'}]},
      {value: 'A-B', language: 'en', basis: 'source', evidence: names.displayEvidence},
    ]);
    expect(updated.aliases).toHaveLength(2);
    expect(updated.aliases.find(a => a.value === 'ＡＢ')!.evidence).toHaveLength(2);
  });

  it('rejects unsupported spellings, duplicate target tuples and spatial intent aliases', () => {
    const {input} = registryFixture();
    const unsupported = structuredClone(input); unsupported.overrides.entries[0].aliases[0].value = 'Invented';
    expect(() => validateNameOverrides(unsupported)).toThrow('NAME_FACT_VALUE_MISMATCH');
    const duplicate = structuredClone(input); duplicate.overrides.entries.push(duplicate.overrides.entries[0]);
    expect(() => validateNameOverrides(duplicate)).toThrow('DUPLICATE_NAME_OVERRIDE');
    const spatial = structuredClone(input); spatial.overrides.entries[0].aliases[0].value = '현재 전선'; spatial.facts.facts[0].verifiedValues.push('현재 전선');
    expect(() => validateNameOverrides(spatial)).toThrow('SPATIAL_INTENT_IS_NOT_A_PLACE_NAME');
  });

  it('fails closed when a curated source target has a different original name', () => {
    const {f, source, input} = registryFixture(), names = structuredClone(f.metadata.sourceRegions[0].names);
    names.sourceName!.value = 'Different city';
    expect(() => enrichCuratedNames(names, source, 'AAA', input)).toThrow('NAME_OVERRIDE_ORIGINAL_NAME_CHANGED');
  });

  it('uses an evidenced publisher child ID for localized labels without inferring a new parent', () => {
    const {f} = registryFixture(), original = f.metadata.sourceRegions[0];
    const names = enrichPublishedNames(original.names, {artifact: original.source.artifact, hierarchyArtifact: original.source.artifact,
      locator: 'child.id:123', sourceFeatureId: original.source.sourceFeatureId,
      properties: {id: '123', native: '스프링필드', name: 'Springfield City', parent: {id: 'newer-parent-not-used'}}});
    expect(names.nameKo?.value).toBe('스프링필드'); expect(names.nameEn?.value).toBe('Springfield City');
    expect(original.provinceIds).toEqual(f.ids.slice(0, 2));
    expect(f.metadata.provinces[0].stateId).toBe(f.stateA);
  });

  it('extracts actual source aliases and does not label an English fallback as Korean', () => {
    const {f} = registryFixture(), proof = f.metadata.provinces[0].evidence;
    const names = sourceNames('Original', proof, 'fallback', {name_en: 'Original', name_ko: 'Original', name_alt: 'Alt One|Alt Two', name_local: '원본 이름|原名'});
    expect(names.nameKo).toBeNull();
    expect(names.aliases.map(a => a.value)).toEqual(expect.arrayContaining(['Alt One', 'Alt Two', '원본 이름', '原名']));
  });

  it('returns all namesake source identities and one full group for a fragmented source', () => {
    const {f} = registryFixture();
    const global = findStaticNameCandidates(f.metadata, '  ＳＰＲＩＮＧＦＩＥＬＤ  ', 'source-region');
    expect(global).toHaveLength(2); expect(global.map(c => c.sourceCountryId)).toEqual(['AAA', 'BBB']);
    const scoped = findStaticNameCandidates(f.metadata, '스프링필드', 'source-region', 'AAA');
    expect(scoped).toHaveLength(1); expect(scoped[0].provinceIds).toEqual(f.ids.slice(0, 2));
    expect(scoped[0].coverage).toEqual(f.metadata.sourceRegions[0].coverage);
    expect(findStaticNameCandidates(f.metadata, '북한 북부', 'source-region')).toEqual([]);
    expect(findStaticNameCandidates(f.metadata, '휴전선 인근', 'state')).toEqual([]);
  });
});
