import {z} from 'zod';
import {
  geographyArtifactSchema, geographyCountryIdSchema, normalizeGeographyName,
  type GeographyArtifact, type GeographyEvidence, type GeographyNames, type GeographySource,
} from '../../src/lib/geography/state-province-contract';

const text = z.string().min(1).max(512).refine(v => v === v.trim() && !/[\u0000-\u001f]/u.test(v));
const factId = z.string().regex(/^[a-z0-9-]+$/);
const namedFact = z.strictObject({value: text, factIds: z.array(factId).min(1)});
export const nameFactsSchema = z.strictObject({
  schemaVersion: z.literal('geography-name-facts-v1'), reviewedOn: z.iso.date(), contentPolicy: text,
  facts: z.array(z.strictObject({id: factId, publisher: text, url: z.url(), sourceDate: z.iso.date().nullable(),
    verifiedValues: z.array(text).min(1), reviewMethod: text, limitation: text,
    localSource: z.strictObject({artifact: geographyArtifactSchema, featureId: text, requiredFields: z.record(z.string(), text)}).optional(),
  })).min(1),
});
export const nameOverridesSchema = z.strictObject({
  schemaVersion: z.literal('geography-source-name-overrides-v1'),
  entries: z.array(z.strictObject({sourceCountryId: geographyCountryIdSchema, sourceId: text, sourceFeatureId: text,
    sourceVersion: text, expectedSourceName: text, nameKo: namedFact.nullable(), nameEn: namedFact.nullable(),
    aliases: z.array(namedFact.extend({language: z.enum(['ko', 'en', 'und'])})),
  })),
});
export type NameFacts = z.infer<typeof nameFactsSchema>;
export type NameOverrides = z.infer<typeof nameOverridesSchema>;
export type NameEnrichmentInput = Readonly<{facts: NameFacts; factsArtifact: GeographyArtifact; overrides: NameOverrides; overridesArtifact: GeographyArtifact}>;
export type PublishedNameFacts = Readonly<{artifact: GeographyArtifact; locator: string; hierarchyArtifact: GeographyArtifact; sourceFeatureId: string; properties: Record<string, unknown>}>;
export const sourceNameKey = (country: string, source: Pick<GeographySource, 'sourceId' | 'sourceFeatureId' | 'sourceVersion'>) => JSON.stringify([country, source.sourceId, source.sourceFeatureId, source.sourceVersion]);
const requireNames = (ok: unknown, message: string): void => {if (!ok) throw Error(message);};

export function validateNameOverrides(input: NameEnrichmentInput) {
  const facts = new Map(input.facts.facts.map(f => [f.id, f]));
  requireNames(facts.size === input.facts.facts.length, 'DUPLICATE_NAME_FACT');
  const identities = new Set<string>();
  for (const row of input.overrides.entries) {
    const identity = sourceNameKey(row.sourceCountryId, row);
    requireNames(!identities.has(identity), 'DUPLICATE_NAME_OVERRIDE'); identities.add(identity);
    for (const value of [row.nameKo, row.nameEn, ...row.aliases].filter(v => v !== null)) {
      requireNames(!['북한 북부', '휴전선 인근', '현재 전선'].includes(value.value), 'SPATIAL_INTENT_IS_NOT_A_PLACE_NAME');
      requireNames(value.factIds.every(id => facts.get(id)?.verifiedValues.includes(value.value)), `NAME_FACT_VALUE_MISMATCH:${value.value}`);
    }
  }
}

export function appendNameAliases(names: GeographyNames, values: readonly {value: string; language: 'ko' | 'en' | 'und'; basis: 'source' | 'verified-alias'; evidence: GeographyEvidence[]}[]): GeographyNames {
  const seen = new Map(names.aliases.map((a, index) => [normalizeGeographyName(a.value), index]));
  const aliases = [...names.aliases];
  for (const alias of values) {
    const key = normalizeGeographyName(alias.value);
    if (!key) continue;
    const position = seen.get(key);
    if (position !== undefined) {
      const prior = aliases[position], proofs = new Map([...prior.evidence, ...alias.evidence].map(e => [JSON.stringify(e), e]));
      aliases[position] = {...prior, evidence: [...proofs.values()]};
      continue;
    }
    seen.set(key, aliases.length); aliases.push(alias);
  }
  aliases.sort((a, b) => a.value < b.value ? -1 : a.value > b.value ? 1 : 0);
  return {...names, aliases};
}

/** Reuses a previously verified source->publisher child ID, never a name/position match. */
export function enrichPublishedNames(names: GeographyNames, facts?: PublishedNameFacts): GeographyNames {
  if (!facts) return names;
  const value = (p: unknown) => typeof p === 'string' && p.trim() ? p.trim().replace(/\s+/gu, ' ') : null;
  const ko = value(facts.properties.native), en = value(facts.properties.name);
  const evidence = [{artifact: facts.artifact, locator: facts.locator, method: 'pinned-publisher-name-fact'},
    {artifact: facts.hierarchyArtifact, locator: `sourceFeatureId:${facts.sourceFeatureId}`, method: 'existing-verified-publisher-child-crosswalk'}];
  const enriched = {...names, nameKo: ko && /[가-힣ㄱ-ㅎㅏ-ㅣ]/u.test(ko) ? {value: ko, basis: 'source' as const, evidence} : names.nameKo,
    nameEn: en ? {value: en, basis: 'source' as const, evidence} : names.nameEn};
  return en ? appendNameAliases(enriched, [{value: en, language: 'en', basis: 'source', evidence}]) : enriched;
}

export function enrichCuratedNames(names: GeographyNames, source: GeographySource, country: string, input?: NameEnrichmentInput): GeographyNames {
  if (!input) return names;
  const row = input.overrides.entries.find(r => sourceNameKey(r.sourceCountryId, r) === sourceNameKey(country, source));
  if (!row) return names;
  requireNames(names.sourceName?.value === row.expectedSourceName, 'NAME_OVERRIDE_ORIGINAL_NAME_CHANGED');
  const evidence = (ids: string[]): GeographyEvidence[] => [{artifact: input.overridesArtifact,
    locator: `source:${row.sourceCountryId}:${row.sourceId}:${row.sourceFeatureId}`, method: 'explicit-reviewed-name-equivalence'},
  ...ids.map(id => ({artifact: input.factsArtifact, locator: `fact:${id}`, method: 'reviewed-primary-or-pinned-source-name'}))];
  const enriched = {...names,
    nameKo: row.nameKo ? {value: row.nameKo.value, basis: 'verified-translation' as const, evidence: evidence(row.nameKo.factIds)} : names.nameKo,
    nameEn: row.nameEn ? {value: row.nameEn.value, basis: 'verified-translation' as const, evidence: evidence(row.nameEn.factIds)} : names.nameEn};
  return appendNameAliases(enriched, row.aliases.map(a => ({value: a.value, language: a.language, basis: 'verified-alias', evidence: evidence(a.factIds)})));
}
