// @vitest-environment node
import {describe, expect, it} from 'vitest';
import {createWorldGeometryCatalogRef, readCatalogTerritoryId} from '../world/world-geometry-catalog-ref';
import {createTerritoryEntityV3} from '../world/territory-entity-v3';
import type {OperationalCell, OperationalWorldView} from '../world/operational-catalog';
import {createCatalogRegionIndex} from './catalog-region';
import {createOperationalFrontierLookup, selectOperationalFrontier, type OperationalFrontierCatalog} from './operational-frontier.server';

const ref = createWorldGeometryCatalogRef({catalogVersion: 'test-frontier-v1', geometryRoot: 'a'.repeat(64), topologyRoot: 'b'.repeat(64), renderArtifactRoot: 'c'.repeat(64), manifestPath: '/data/test-frontier-v1/manifest.json'});
const id = (n: number) => readCatalogTerritoryId(`territory:catalog:${n.toString(16).padStart(64, '0')}`);
// Positive-length land edges only. The remote island and point contact have no graph edge.
function fixture() {
  const cells = Array.from({length: 13}, (_, i) => ({id: id(i + 1), ordinal: i + 1, sourceCountryId: (i < 2 ? 'AAA' : 'BBB') as OperationalCell['sourceCountryId'], administrativeOrdinal: 1, previousParentOrdinal: 1}));
  const points: [number, number][] = [[0, 0], [0, 0.09], [0.09, 0], [0.09, 0.09], [0.18, 0], [0.18, 0.09], [0.27, 0], [0.27, 0.09], [0.36, 0], [0.36, 0.09], [0.45, 0], [0.09, 0.02], [10, 10]];
  const links = [[1, 3], [2, 4], [3, 4], [3, 5], [4, 6], [5, 6], [5, 7], [6, 8], [7, 8], [7, 9], [8, 10], [9, 10], [9, 11]];
  const cell = (key: string | number) => {
    const value = typeof key === 'number' ? cells[key - 1] : cells.find(c => c.id === key);
    if (!value) throw Error('UNKNOWN_OPERATIONAL_CELL'); return value;
  };
  const catalog: OperationalFrontierCatalog = {
    ref, cell,
    cellMetrics: key => ({centroid: points[cell(key).ordinal - 1], areaKm2: 100, diameterKm: 14}),
    neighbors: n => links.flatMap(([a, b]) => a === n ? [b] : b === n ? [a] : []).sort((a, b) => a - b),
    sharedBoundary: (a, b) => {
      if (!links.some(([x, y]) => (x === a && y === b) || (x === b && y === a))) throw Error('NO_OPERATIONAL_LAND_BOUNDARY');
      const p = points[a - 1], q = points[b - 1], x = (p[0] + q[0]) / 2, y = (p[1] + q[1]) / 2;
      return {edgeOrdinal: 1, start: [x, y - 0.04], end: [x, y + 0.04]};
    },
    administrativeParents: [{ordinal: 1, parentKey: 'BBB:province', sourceCountryId: 'BBB', kind: 'administrative', adminId: 'province', name: 'Province', sourceFeatureId: 'province', sourceVersion: 'test', restorationId: 'province', residualId: null, start: 0, count: 11}],
    administrativeMembership: () => cells.slice(2),
  };
  const world: OperationalWorldView = {catalogRef: ref, revision: 7, territoriesById: Object.fromEntries(cells.map(c => [c.id, createTerritoryEntityV3({id: c.id, sourceCountryId: c.sourceCountryId, ownerCountryId: c.sourceCountryId, controllerCountryId: c.sourceCountryId})]))};
  const request = {catalogRef: ref, baseWorldRevision: 7, actorCountryId: 'AAA', targetCountryId: 'BBB', operation: 'occupy', extent: 'near'};
  return {cells, catalog, world, request};
}

describe('16-06 current-world bounded frontier', () => {
  it('selects a deterministic connected portion and excludes coasts, point contacts and remote cells', () => {
    const {catalog, world, request} = fixture();
    const before = JSON.stringify(world);
    const result = selectOperationalFrontier(catalog, world, request);
    expect(result.cellIds.length).toBeGreaterThan(1);
    expect(result.cellIds).not.toContain(id(12)); expect(result.cellIds).not.toContain(id(13));
    expect(result.cellIds.length).toBeLessThan(11);
    expect(result.frontier.kind).toBe('land-border');
    expect(result.metrics.maximumGraphDepthKm).toBeLessThanOrEqual(36);
    expect(result.metrics.maximumLateralKm).toBeLessThanOrEqual(18);
    expect(result.effectTarget).toEqual({territoryIds: result.cellIds, regionRefs: null});
    expect(result).toEqual(selectOperationalFrontier(catalog, {...world, territoriesById: Object.fromEntries(Object.entries(world.territoriesById).reverse())}, request));
    expect(JSON.stringify(world)).toBe(before);
  });

  it('starts the next advance at current control and never selects already occupied cells', () => {
    const {catalog, world, request} = fixture();
    const first = selectOperationalFrontier(catalog, world, request);
    const advanced: OperationalWorldView = {...world, revision: 8, territoriesById: {...world.territoriesById,
      ...Object.fromEntries(first.cellIds.map(id => [id, createTerritoryEntityV3({...world.territoriesById[id], controllerCountryId: 'AAA'})]))}};
    const next = selectOperationalFrontier(catalog, advanced, {...request, baseWorldRevision: 8});
    expect(next.frontier.kind).toBe('current-controller');
    expect(first.cellIds).toContain(next.frontier.supportCellId);
    expect(next.cellIds.every(id => !first.cellIds.includes(id))).toBe(true);
    expect(next.baseWorldRevision).toBe(8);
    expect(next.cellIds.some(id => catalog.neighbors(catalog.cell(id).ordinal).some(n => first.cellIds.includes(catalog.cell(n).id)))).toBe(true);
    const deeper = selectOperationalFrontier(catalog, world, {...request, extent: 'deeper'});
    const limited = selectOperationalFrontier(catalog, world, {...request, extent: 'limited'});
    expect(limited.cellIds.length).toBeGreaterThan(first.cellIds.length);
    expect(limited.metrics.maximumGraphDepthKm).toBeLessThanOrEqual(120);
    expect(limited.limits.widthKm).toBe(96);
    expect(deeper.cellIds.length).toBeGreaterThanOrEqual(limited.cellIds.length);
    expect(deeper.cellIds.length).toBeGreaterThan(first.cellIds.length);
  });

  it('uses current relations after transfer rather than the immutable source country', () => {
    const {catalog, world, request} = fixture();
    const territoriesById = Object.fromEntries(Object.entries(world.territoriesById).map(([id, t]) => [id,
      t.ownerCountryId === 'BBB' ? createTerritoryEntityV3({...t, ownerCountryId: 'CCC', controllerCountryId: 'CCC'}) : t]));
    const result = selectOperationalFrontier(catalog, {...world, territoriesById}, {...request, targetCountryId: 'CCC'});
    expect(result.cellIds.length).toBeGreaterThan(0);
    expect(result.cellIds.every(id => territoriesById[id].sourceCountryId === 'BBB')).toBe(true);
  });

  it('binds operation and supports liberation and donor-side transfer without granting authority', () => {
    const {catalog, world, request} = fixture();
    const occupied = {...world, territoriesById: Object.fromEntries(Object.entries(world.territoriesById).map(([id, t]) => [id,
      t.sourceCountryId === 'BBB' ? createTerritoryEntityV3({...t, ownerCountryId: 'AAA'}) : t]))};
    const liberation = selectOperationalFrontier(catalog, occupied, {...request, operation: 'liberate'});
    expect(liberation.operation).toBe('liberate');
    expect(liberation.cellIds.every(id => occupied.territoriesById[id].ownerCountryId === 'AAA')).toBe(true);
    const transfer = selectOperationalFrontier(catalog, world, {...request, operation: 'transfer'});
    expect(transfer.operation).toBe('transfer');
    expect(transfer.cellIds.every(id => world.territoriesById[id].ownerCountryId === 'AAA')).toBe(true);
  });

  it('resolves names or canonical memberships, and does not require an administrative name', () => {
    const {catalog, world, request, cells} = fixture();
    const reference = {catalogId: ref.catalogVersion, sourceVersion: ref.geometryRoot, subdivisionId: 'region:test:BBB:province'};
    const region = {ref: reference, parentCountryId: 'BBB', nameKo: '북부', nameEn: 'North', aliases: [], territoryIds: cells.slice(2, 4).map(c => c.id), provenanceIds: ['test']};
    const index = createCatalogRegionIndex([region], cells.map(c => c.id), ref);
    const result = selectOperationalFrontier(catalog, world, {...request, regionQuery: '북부'}, index);
    expect(result.scope.reference).toEqual(reference);
    expect(result.cellIds.every(id => region.territoryIds.includes(id))).toBe(true);
    expect(() => selectOperationalFrontier(catalog, world, {...request, regionQuery: 'unknown'}, index)).toThrow('UNKNOWN_REGION');
    const ambiguous = createCatalogRegionIndex([region, {...region, ref: {...reference, subdivisionId: 'second'}}], cells.map(c => c.id), ref);
    expect(() => selectOperationalFrontier(catalog, world, {...request, regionQuery: 'North'}, ambiguous)).toThrow('AMBIGUOUS_REGION');
    const north = selectOperationalFrontier(catalog, world, {...request, direction: 'north'});
    const south = selectOperationalFrontier(catalog, world, {...request, direction: 'south'});
    expect(north.frontier.cellId).toBe(id(4)); expect(south.frontier.cellId).toBe(id(3));
  });

  it('fails stale, mismatched, invalid, disconnected and oversized requests with no partial result', () => {
    const {catalog, world, request} = fixture();
    const lookup = createOperationalFrontierLookup(catalog);
    expect(lookup(world, {...request, baseWorldRevision: 6})).toMatchObject({ok: false, code: 'STALE_WORLD_REVISION'});
    expect(lookup(world, {...request, catalogRef: {...ref, topologyRoot: 'f'.repeat(64)}}).ok).toBe(false);
    expect(lookup({...world, catalogRef: {...ref, geometryRoot: 'f'.repeat(64)}}, request).ok).toBe(false);
    expect(lookup(world, {...request, actorCountryId: 'BBB'})).toMatchObject({ok: false, code: 'FRONTIER_COUNTRY_SCOPE'});
    expect(lookup(world, {...request, targetCountryId: 'ZZZ'})).toMatchObject({ok: false, code: 'UNKNOWN_FRONTIER_COUNTRY'});
    expect(lookup(world, {...request, cap: 1})).toMatchObject({ok: false, code: 'FRONTIER_REQUEST_CAP'});
    for (const value of [{cap: 513}, {extent: 'world'}, {coordinates: [0, 0]}]) expect(lookup(world, {...request, ...value})).toMatchObject({ok: false, code: 'INVALID_FRONTIER_REQUEST'});
    expect(lookup({...world, territoriesById: {...world.territoriesById, [id(50)]: createTerritoryEntityV3({id: id(50), sourceCountryId: 'BBB', ownerCountryId: 'BBB', controllerCountryId: 'BBB'})}}, request).ok).toBe(false);
    expect(lookup(world, {...request, extent: 'deeper'}).ok).toBe(true);
    expect(createOperationalFrontierLookup({...catalog, neighbors: () => []})(world, request)).toMatchObject({ok: false, code: 'NO_CURRENT_LAND_FRONTIER'});
    expect(createOperationalFrontierLookup({...catalog, cellMetrics: key => ({...catalog.cellMetrics(key), areaKm2: 3000})})(world, request)).toMatchObject({ok: false, code: 'FRONTIER_REQUEST_CAP'});
  });
});
