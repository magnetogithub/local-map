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

describe('current operational catalog', () => {
  it('loads admission and linked metadata without overview tiles or world geometry', () => {
    expect(catalog.ref.catalogVersion).toBe(OPERATIONAL_CATALOG_VERSION);
    expect(catalog.descriptor.counts.countries).toBe(247);
    expect(catalog.descriptor.counts.cells).toBeGreaterThanOrEqual(4231);
    expect(catalog.descriptor.counts.administrativeParents).toBe(catalog.administrativeParents.length);
    expect(catalog.descriptor.counts.previousParents).toBe(catalog.previousParents.length);
    expect(reads.some(p => /\/tiles\/|\.geojson|\/topology\/|catalog-order\.json|adjacency\.json|edge-incidence|membership\.json|previous-parent-index/.test(p))).toBe(false);
    expect(() => catalog.assertRef({...catalog.ref, topologyRoot: '0'.repeat(64)})).toThrow('Catalog ref mismatch');
    expect(() => catalog.cell(0)).toThrow('UNKNOWN_OPERATIONAL_ORDINAL');
    expect(() => catalog.cell(catalog.descriptor.counts.cells + 1)).toThrow('UNKNOWN_OPERATIONAL_ORDINAL');
    expect(() => catalog.loadCountry('../PRK')).toThrow('UNKNOWN_OPERATIONAL_COUNTRY');
  });

  it('round-trips original IDs and ordinals with complete administrative and previous-parent membership', () => {
    const cells = catalog.loadCountry('PRK'), first = cells[0];
    expect(cells).toHaveLength(catalog.countryDetail('PRK').cellCount);
    expect(catalog.loadCountry('PRK')).toBe(cells);
    expect(catalog.cell(first.id)).toBe(first);
    expect(catalog.cell(first.ordinal)).toBe(first);
    const admin = catalog.administrativeParents[first.administrativeOrdinal - 1];
    const previous = catalog.previousParents[first.previousParentOrdinal - 1];
    const members = catalog.administrativeMembership(admin.parentKey), oldMembers = catalog.previousMembership(previous.oldTerritoryId);
    expect(members).toEqual(cells.filter(c => c.administrativeOrdinal === admin.ordinal));
    expect(oldMembers).toEqual(cells.filter(c => c.previousParentOrdinal === previous.ordinal));
    expect(members).toContain(first); expect(oldMembers).toContain(first);
    expect(members.every(c => c.administrativeOrdinal === admin.ordinal)).toBe(true);
    expect(oldMembers.every(c => c.previousParentOrdinal === previous.ordinal)).toBe(true);
    expect(() => catalog.previousMembership('missing')).toThrow('UNKNOWN_OPERATIONAL_PREVIOUS_PARENT');
    expect(reads.some(p => /\/detail\/countries\/|catalog-order\.json/.test(p))).toBe(false);
  });

  it('resolves Korean source names and coarse country memberships', () => {
    const index = createOperationalRegionIndex(catalog);
    const korean = index.search('PRK', '강원');
    expect(korean).toHaveLength(1);
    expect(korean[0].nameKo).toContain('강원');
    expect(regionRecordSchema.parse(korean[0]).territoryIds).toEqual(korean[0].territoryIds);
    expect(index.listCountry('SVN')).toHaveLength(1);
    expect(() => index.resolve('PRK', korean[0].ref, 'occupy', 513)).toThrow('REGION_REQUEST_CAP');
    expect(() => index.lookup('KOR', korean[0].ref)).toThrow('REGION_COUNTRY_SCOPE');
  });

  it('reads canonical edge identity, positive-length adjacency, and zero only as the coast incidence', () => {
    const edges = Array.from({length: catalog.descriptor.counts.edges}, (_, i) => catalog.edge(i + 1));
    const edge = edges.find(e => e.right > 0)!, coast = edges.find(e => e.right === 0)!;
    expect(edge.id).toMatch(/^edge:operational:[a-f0-9]{64}$/);
    expect(catalog.edgeIncidence(edge.ordinal)).toEqual({left: edge.left, right: edge.right});
    expect(edge.lengthKm).toBeGreaterThan(0);
    expect(catalog.neighbors(edge.left)).toContain(edge.right);
    expect(catalog.neighbors(edge.right)).toContain(edge.left);
    expect(coast.right).toBe(0); expect(coast.flags.positiveAdjacency).toBe(false);
    expect(catalog.neighbors(coast.left)).not.toContain(0);
    expect(() => catalog.edge(0)).toThrow('UNKNOWN_OPERATIONAL_ORDINAL');
    expect(() => catalog.edge(catalog.descriptor.counts.edges + 1)).toThrow('UNKNOWN_OPERATIONAL_ORDINAL');
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
    expect(OPERATIONAL_CATALOG_PATHS.delivery).toContain('data/derived/prompt19/');
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
