// @vitest-environment node
import {describe, expect, it} from 'vitest';
import {prepareOperationalCatalog} from '../world/operational-catalog.server';
import {createOperationalRegionIndex} from './operational-region.server';

describe('fine-derived macro region lookup', () => {
  const catalog = prepareOperationalCatalog(), index = createOperationalRegionIndex(catalog);
  it('uses the same new macro membership for Korean and English searches', () => {
    for (const [ko, en] of [['함경북도', 'North Hamgyong'], ['강원도', 'Kangwon'], ['남포', 'Nampo']]) {
      const localized = index.search('PRK', ko), english = index.search('PRK', en);
      expect(localized).toHaveLength(1); expect(localized[0].ref).toEqual(english[0].ref);
      expect(localized[0].ref.subdivisionId).toMatch(/^region:fine-macro:PRK:/);
      expect(localized[0].territoryIds.length).toBeGreaterThan(0);
    }
  });
  it('keeps promoted boundaries and region lookup on the same administrative parents', () => {
    for (const countryId of ['KOR', 'PRK']) {
      for (const record of index.listCountry(countryId).filter(r => r.ref.subdivisionId.startsWith('region:fine-macro:'))) {
        const parents = new Set(record.territoryIds.map(id => catalog.cell(id).administrativeOrdinal));
        expect(parents.size).toBe(1);
        const parent = catalog.administrativeParents[[...parents][0] - 1];
        expect(parent.parentKey.startsWith('fine-macro:')).toBe(true);
        expect(record.provenanceIds).toEqual([parent.parentKey]);
      }
    }
  });
});
