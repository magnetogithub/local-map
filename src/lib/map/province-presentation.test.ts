// @vitest-environment node
import {describe, expect, it} from 'vitest';
import fs from 'node:fs';
import {prepareOperationalCatalog} from '../world/operational-catalog.server';
import {isProvincePresentationBoundary, readProvincePresentation} from './province-presentation.server';
import {assertAcceptedProvincePresentation, CHN_PROVINCE_PRESENTATION_IDENTITY, loadCHNProvincePresentation} from './chn-province-presentation.server';
import {createProductionOperationalGame} from '../world/operational-game.server';

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
    expect(groups.boundaryOrdinals).toHaveLength(1001); expect(groups.groups.size).toBe(3319);
    expect([...groups.groups.values()].filter(p => p === null)).toHaveLength(29);
  });
  it('keeps mainland Binhai in Tianjin and merges the enclosed fragment into the Hebei recipient', () => {
    const groups = loadCHNProvincePresentation(catalog);
    const mainland = catalog.cell('territory:catalog:c52ffe41e959f713f66bbbe06889511e6767fcec682aa67105adc3b45104a969');
    const merged = catalog.cell('territory:catalog:931baa0ac0bdd543e1b491cf6515c1e8cb37fedaf6191ab993d16b49f5e29e8a');
    expect(groups.groups.get(mainland.ordinal)).toBe('macro:CHN:CN-12');
    expect(groups.groups.get(merged.ordinal)).toBe('macro:CHN:CN-13');
    expect(() => catalog.cell('territory:catalog:0719d07c04a63bb0c1dd4d7fe26bccc8972a767facb8d9ef02552dd4dacb99a3')).toThrow('UNKNOWN_OPERATIONAL_CELL');
    expect(() => catalog.cell('territory:catalog:cd77a205ccdd3ef9427a18f1ecf005804927f5d5a9db6d15f03888eb341cf416')).toThrow('UNKNOWN_OPERATIONAL_CELL');
    const boundaryIds = groups.boundaryOrdinals.map(n => catalog.edge(n).id);
    expect(boundaryIds).not.toContain('edge:operational:79506854f0921889be3157936d932399e2b65a20e34c34a409db2849e8aa2d86');
    expect(boundaryIds).toEqual(expect.arrayContaining([
      'edge:operational:032bcfd649af62692a180cd59b68c5f096fac9344d7884485229ec57ab8355ef',
      'edge:operational:11822a2adb5f8f71e5bc5ec97d988d212540061344c632999bed8e7ecb0523e0',
      'edge:operational:63728172af360630e02c06f3ba85b3bd5764f4ef4a3a6034b1d84e52ac8ad4cf',
      'edge:operational:b87c77db766543e6465944b96c6d8edd153eedca5ca6596ded3457cb6d47858f',
    ]));
  });
  it('connects the Myanmar-side provincial border and Hubei/Hunan boundary south of Wuhan', () => {
    const groups = loadCHNProvincePresentation(catalog);
    expect(groups.groups.get(catalog.cell('territory:catalog:772c83eeb91960326f3a0996c36cb870fd43e381bd3a8020eaab227fbd0c6f95').ordinal)).toBe('macro:CHN:CN-54');
    expect(groups.groups.get(catalog.cell('territory:catalog:a66949df4b2ed89c0e30fdbdff653149748f957fcf9e7ba793da3749c6b35596').ordinal)).toBe('macro:CHN:CN-43');
    expect(groups.boundaryOrdinals.map(n => catalog.edge(n).id)).toEqual(expect.arrayContaining([
      'edge:operational:0b61a43b5b4062b725b6f0f29ab2334ef472c8c16113bdfbebc1c5c97a016e3b',
      'edge:operational:6fa212368e46e75fc91b96e0b3c7700896b0a367dd90b745cbda6efef2dd29ed',
      'edge:operational:887c67f10f54a4e1dddd9f2ec67fd3676a7159d7324d89875c5288033e313288',
    ]));
  });
  it('creates one playable merged cell with positive symmetric land adjacency and no removed fragment', () => {
    const game = createProductionOperationalGame('CHN');
    const merged = catalog.cell('territory:catalog:931baa0ac0bdd543e1b491cf6515c1e8cb37fedaf6191ab993d16b49f5e29e8a');
    expect(game.pair.world.territoriesById[merged.id]).toMatchObject({sourceCountryId: 'CHN', ownerCountryId: 'CHN', controllerCountryId: 'CHN'});
    expect(game.pair.world.territoriesById).not.toHaveProperty('territory:catalog:0719d07c04a63bb0c1dd4d7fe26bccc8972a767facb8d9ef02552dd4dacb99a3');
    const neighbors = catalog.neighbors(merged.ordinal);
    expect(neighbors).toHaveLength(7);
    for (const n of neighbors) {
      expect(n).not.toBe(merged.ordinal);
      expect(catalog.neighbors(n)).toContain(merged.ordinal);
      expect(catalog.sharedBoundary(merged.ordinal, n).edgeOrdinal).toBeGreaterThan(0);
    }
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
