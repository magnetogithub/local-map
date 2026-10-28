// @vitest-environment node
import fs from 'node:fs';
import {beforeAll, describe, expect, it} from 'vitest';
import {prepareOperationalCatalog, OPERATIONAL_CATALOG_PATHS, type OperationalCatalog} from './operational-catalog.server';
import {OPERATIONAL_CATALOG_VERSION, readOperationalCellState} from './operational-catalog';
import {createOperationalRegionIndex} from '../simulation/operational-region.server';
import {regionRecordSchema} from '../simulation/catalog-region';
import {createTerritoryEntityV3} from './territory-entity-v3';

let catalog: OperationalCatalog;
const reads: string[] = [];
beforeAll(() => {
  catalog = prepareOperationalCatalog(process.cwd(), file => {reads.push(file.replaceAll('\\', '/')); return fs.readFileSync(file);});
});

describe('16-01 pinned operational catalog', () => {
  it('loads admission and linked metadata without overview tiles or world geometry', () => {
    expect(catalog.ref.catalogVersion).toBe(OPERATIONAL_CATALOG_VERSION);
    expect(catalog.descriptor.counts).toEqual({countries: 247, cells: 923443, edges: 3125743, administrativeParents: 4761, previousParents: 4231});
    expect(reads.some(p => /\/tiles\/|\.geojson|\/topology\/|catalog-order\.json|adjacency\.json|edge-incidence|membership\.json|previous-parent-index/.test(p))).toBe(false);
    expect(() => catalog.assertRef({...catalog.ref, topologyRoot: '0'.repeat(64)})).toThrow('Catalog ref mismatch');
    expect(() => catalog.cell(0)).toThrow('UNKNOWN_OPERATIONAL_ORDINAL');
    expect(() => catalog.cell(923444)).toThrow('UNKNOWN_OPERATIONAL_ORDINAL');
    expect(() => catalog.loadCountry('../PRK')).toThrow('UNKNOWN_OPERATIONAL_COUNTRY');
  });

  it('round-trips original IDs and ordinals with complete administrative and previous-parent membership', () => {
    const cells = catalog.loadCountry('PRK'), first = cells[0];
    expect(cells).toHaveLength(1283);
    expect(catalog.loadCountry('PRK')).toBe(cells);
    expect(catalog.cell(first.id)).toBe(first);
    expect(catalog.cell(first.ordinal)).toBe(first);
    const admin = catalog.administrativeParents[first.administrativeOrdinal - 1];
    const previous = catalog.previousParents[first.previousParentOrdinal - 1];
    const members = catalog.administrativeMembership(admin.parentKey), oldMembers = catalog.previousMembership(previous.oldTerritoryId);
    expect(members).toHaveLength(admin.count);
    expect(oldMembers).toHaveLength(previous.count);
    expect(members).toContain(first); expect(oldMembers).toContain(first);
    expect(members.every(c => c.administrativeOrdinal === admin.ordinal)).toBe(true);
    expect(oldMembers.every(c => c.previousParentOrdinal === previous.ordinal)).toBe(true);
    expect(() => catalog.previousMembership('missing')).toThrow('UNKNOWN_OPERATIONAL_PREVIOUS_PARENT');
    expect(reads.some(p => /\/detail\/countries\/|catalog-order\.json/.test(p))).toBe(false);
  });

  it('resolves Korean source names, all 193 Slovenian identities, and memberships larger than the action cap', () => {
    const index = createOperationalRegionIndex(catalog);
    const korean = index.search('PRK', '강원');
    expect(korean).toHaveLength(1); expect(korean[0].nameKo).toContain('강원');
    const slovenian = index.listCountry('SVN').filter(r => r.ref.subdivisionId.startsWith('region:ne-admin1:'));
    expect(slovenian).toHaveLength(193);
    expect(index.search('SVN', 'Ljubljana')).toHaveLength(1);
    const guangdong = index.search('CHN', 'Guangdong')[0];
    expect(guangdong.territoryIds.length).toBeGreaterThan(512);
    expect(regionRecordSchema.parse(guangdong).territoryIds).toEqual(guangdong.territoryIds);
    expect(index.lookup('CHN', guangdong.ref)).toBe(guangdong);
    expect(() => index.resolve('CHN', guangdong.ref, 'occupy')).toThrow('REGION_REQUEST_CAP');
    expect(() => index.resolve('CHN', guangdong.ref, 'occupy', 513)).toThrow('REGION_REQUEST_CAP');
    expect(() => index.lookup('KOR', guangdong.ref)).toThrow('REGION_COUNTRY_SCOPE');
    expect(() => index.lookup('CHN', {...guangdong.ref, sourceVersion: '0'.repeat(64)})).toThrow('UNKNOWN_REGION_OR_CATALOG');
    const largePrevious = catalog.previousParents.find(p => p.count > 512)!;
    expect(catalog.previousMembership(largePrevious.oldTerritoryId)).toHaveLength(largePrevious.count);
  });

  it('reads canonical edge identity, positive-length adjacency, and zero only as the coast incidence', () => {
    const edge = catalog.edge(1), coast = catalog.edge(2);
    expect(edge.id).toMatch(/^edge:operational:[a-f0-9]{64}$/);
    expect(catalog.edgeIncidence(1)).toEqual({left: edge.left, right: edge.right});
    expect(edge.lengthKm).toBeGreaterThan(0);
    expect(catalog.neighbors(edge.left)).toContain(edge.right);
    expect(catalog.neighbors(edge.right)).toContain(edge.left);
    expect(coast.right).toBe(0); expect(coast.flags.positiveAdjacency).toBe(false);
    expect(catalog.neighbors(coast.left)).not.toContain(0);
    expect(() => catalog.edge(0)).toThrow('UNKNOWN_OPERATIONAL_ORDINAL');
    expect(() => catalog.edge(3125744)).toThrow('UNKNOWN_OPERATIONAL_ORDINAL');
    expect(reads.some(p => /catalog-order\.json|\/detail\/countries\//.test(p))).toBe(false);
  });

  it('rejects altered compressed metadata before publishing a country cache', () => {
    const broken = prepareOperationalCatalog(process.cwd(), file => {
      const bytes = fs.readFileSync(file);
      return file.replaceAll('\\', '/').endsWith('/metadata/countries/PRK.json.gz') ? Buffer.concat([bytes, Buffer.from('x')]) : bytes;
    });
    expect(() => broken.loadCountry('PRK')).toThrow('OPERATIONAL_ASSET_IDENTITY');
    expect(() => broken.loadCountry('PRK')).toThrow('OPERATIONAL_ASSET_IDENTITY');
    expect(broken.loadCountry('SVN').length).toBeGreaterThan(0);
    expect(OPERATIONAL_CATALOG_PATHS.delivery).toContain('56fc6c79c216e6bd1a11');
  });

  it('reads current owner/controller from the supplied world and rejects a different catalog', () => {
    const cell = catalog.loadCountry('PRK')[0];
    const state = createTerritoryEntityV3({id: cell.id, sourceCountryId: 'PRK', ownerCountryId: 'PRK', controllerCountryId: 'KOR'});
    const world = {catalogRef: catalog.ref, revision: 7, territoriesById: {[cell.id]: state}};
    expect(readOperationalCellState(world, catalog.ref, cell.id)).toBe(state);
    expect(() => readOperationalCellState({...world, territoriesById: {}}, catalog.ref, cell.id)).toThrow('UNKNOWN_OPERATIONAL_CELL_STATE');
    expect(() => readOperationalCellState(world, {...catalog.ref, geometryRoot: '0'.repeat(64)}, cell.id)).toThrow('Catalog ref mismatch');
  });

  it('provides the complete world contract in the original catalog order without reading polygons', () => {
    const contract = catalog.worldContract(), cell = catalog.loadCountry('PRK')[0];
    expect(contract.ref).toBe(catalog.ref);
    expect(contract.territoryOrder).toHaveLength(catalog.descriptor.counts.cells);
    expect(contract.territoryOrder[cell.ordinal - 1]).toBe(cell.id);
    expect(contract.territoriesById[cell.id]).toEqual({id: cell.id, sourceCountryId: 'PRK'});
    expect(catalog.worldContract()).toBe(contract);
    expect(reads.some(p => /catalog-order\.json|\/detail\/countries\//.test(p))).toBe(false);
  });
});
