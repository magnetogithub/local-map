// @vitest-environment node
import {describe, expect, it} from 'vitest';
import {prepareOperationalCatalog} from '../world/operational-catalog.server';

describe('19-01 existing coarse land topology', () => {
  it('retains symmetric Korean land contact while excluding sea and point contacts', () => {
    const catalog = prepareOperationalCatalog();
    const kor = new Set(catalog.loadCountry('KOR').map(c => c.ordinal));
    const prk = catalog.loadCountry('PRK');
    let contacts = 0;
    for (const cell of prk) for (const n of catalog.neighbors(cell.ordinal)) {
      expect(n).toBeGreaterThan(0);
      expect(catalog.neighbors(n)).toContain(cell.ordinal);
      if (kor.has(n)) {
        contacts++;
        const boundary = catalog.sharedBoundary(cell.ordinal, n);
        expect(catalog.edge(boundary.edgeOrdinal).lengthKm).toBeGreaterThan(0);
      }
    }
    expect(contacts).toBeGreaterThan(0);
  });
});
