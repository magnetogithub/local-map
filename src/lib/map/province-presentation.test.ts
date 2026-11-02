// @vitest-environment node
import {describe, expect, it} from 'vitest';
import fs from 'node:fs';
import {prepareOperationalCatalog} from '../world/operational-catalog.server';
import {isProvincePresentationBoundary, readProvincePresentation} from './province-presentation.server';
import {assertAcceptedProvincePresentation, CHN_PROVINCE_PRESENTATION_IDENTITY, loadCHNProvincePresentation} from './chn-province-presentation.server';

const catalog = prepareOperationalCatalog(), cells = catalog.loadCountry('CHN');
const provinces = catalog.administrativeParents.filter(p => p.sourceCountryId === 'CHN' && p.kind === 'administrative')
  .map(p => ({id: p.adminId!.replace('fine-macro:CHN:', ''), name: p.name!}));
function fixture() {
  return {schemaVersion: 'chn-province-presentation-v1', countryId: 'CHN', administrativeTruthClaim: false, catalogRef: catalog.ref, provinces,
    cells: cells.map(c => {const p = catalog.administrativeParents[c.administrativeOrdinal - 1];
      return {id: c.id, ordinal: c.ordinal, sourceFeatureId: `fixture:${c.id}`, renderProvinceId: p.kind === 'administrative' ? p.adminId!.replace('fine-macro:CHN:', '') : null};})};
}
describe('province presentation is independent of authoritative administrative membership', () => {
  it('accepts only the independently verified immutable projection, blocking source identity/name/province spoofing before use', () => {
    const data = JSON.parse(fs.readFileSync(CHN_PROVINCE_PRESENTATION_IDENTITY.path, 'utf8'));
    expect(() => assertAcceptedProvincePresentation(data)).not.toThrow();
    const full = JSON.parse(fs.readFileSync(data.acceptedPresentation.path, 'utf8'));
    expect(data.cells).toEqual(full.cells); expect(data.addedBoundaryOrdinals).toEqual(full.addedBoundaryOrdinals);
    expect(data.provinces).toEqual(full.provinces.map(({id, name}: {id: string; name: string}) => ({id, name})));
    for (const mutate of [
      (v: typeof data) => {const c = v.cells.find((r: {sourceFeatureId: string | null}) => r.sourceFeatureId === null); c.sourceFeatureId = 'forged-source'; c.renderProvinceId = v.provinces[0].id;},
      (v: typeof data) => {v.cells[0].sourceFeatureId = 'forged-family';},
      (v: typeof data) => {v.provinces[0].id = 'macro:CHN:CN-99'; v.provinces[0].name = 'fabricated';},
      (v: typeof data) => {v.independentVerification.sha256 = '0'.repeat(64);},
    ]) {const changed = structuredClone(data); mutate(changed); expect(() => assertAcceptedProvincePresentation(changed)).toThrow('IDENTITY');}
    const groups = loadCHNProvincePresentation(catalog);
    expect(groups.boundaryOrdinals).toHaveLength(994); expect(groups.groups.size).toBe(3320);
    expect([...groups.groups.values()].filter(p => p === null)).toHaveLength(33);
  });
  it('keeps verified parents and all cells, and rejects stale identity, missing/duplicate cells and invented province groups', () => {
    const data = fixture(), groups = readProvincePresentation(data, catalog);
    expect(groups.size).toBe(cells.length);
    expect(() => readProvincePresentation({...data, catalogRef: {...catalog.ref, geometryRoot: '0'.repeat(64)}}, catalog)).toThrow();
    expect(() => readProvincePresentation({...data, cells: data.cells.slice(1)}, catalog)).toThrow('MEMBERSHIP');
    expect(() => readProvincePresentation({...data, cells: [data.cells[1], ...data.cells.slice(1)]}, catalog)).toThrow('MEMBERSHIP');
    expect(() => readProvincePresentation({...data, provinces: provinces.slice(1)}, catalog)).toThrow('PROVINCES');
    expect(() => readProvincePresentation({...data, countryId: 'PRK'}, catalog)).toThrow();
    expect(() => readProvincePresentation({...data, administrativeTruthClaim: true}, catalog)).toThrow();
    const known = data.cells.findIndex(r => r.renderProvinceId !== null), changed = structuredClone(data);
    changed.cells[known].renderProvinceId = null;
    expect(() => readProvincePresentation(changed, catalog)).toThrow('VERIFIED_PARENT_CHANGED');
  });
  it('never splits a whole source family or assigns source-free land to a province', () => {
    const data = fixture(), rows = data.cells.filter(r => r.renderProvinceId === null).slice(0, 2);
    rows[0].sourceFeatureId = rows[1].sourceFeatureId = 'fixture-family';
    rows[0].renderProvinceId = provinces[0].id;
    expect(() => readProvincePresentation(data, catalog)).toThrow('SPLIT_FAMILY');
    const free = fixture(); const row = free.cells.find(r => r.renderProvinceId === null)!;
    Object.assign(row, {sourceFeatureId: null, renderProvinceId: provinces[0].id});
    expect(() => readProvincePresentation(free, catalog)).toThrow('SOURCE_FREE_ASSIGNMENT');
  });
  it('promotes only two non-null distinct CHN groups, never coast, foreign, unresolved or within-province contacts', () => {
    const chn = {ordinal: 1, sourceCountryId: 'CHN'}, other = {ordinal: 2, sourceCountryId: 'CHN'};
    const groups = new Map([[1, 'macro:CHN:CN-11'], [2, 'macro:CHN:CN-12'], [3, null]]);
    expect(isProvincePresentationBoundary(chn, other, groups)).toBe(true);
    expect(isProvincePresentationBoundary(chn, {...other, sourceCountryId: 'PRK'}, groups)).toBe(false);
    expect(isProvincePresentationBoundary(chn, {...other, ordinal: 0}, groups)).toBe(false);
    expect(isProvincePresentationBoundary(chn, {...other, ordinal: 3}, groups)).toBe(false);
    groups.set(2, groups.get(1)!);
    expect(isProvincePresentationBoundary(chn, other, groups)).toBe(false);
  });
});
