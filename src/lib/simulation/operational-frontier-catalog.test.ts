// @vitest-environment node
import fs from 'node:fs';
import {beforeAll, describe, expect, it} from 'vitest';
import {prepareOperationalCatalog, type OperationalCatalog} from '../world/operational-catalog.server';
import {createTerritoryEntityV3} from '../world/territory-entity-v3';
import type {OperationalWorldView} from '../world/operational-catalog';
import {createOperationalRegionIndex} from './operational-region.server';
import {selectOperationalFrontier} from './operational-frontier.server';

let catalog: OperationalCatalog;
const reads: string[] = [];
beforeAll(() => {
  catalog = prepareOperationalCatalog(process.cwd(), file => {reads.push(file.replaceAll('\\', '/')); return fs.readFileSync(file);});
});

function worldAt(countryId: string): OperationalWorldView {
  const target = catalog.loadCountry(countryId);
  const ordinals = new Set(target.map(c => c.ordinal));
  for (const c of target) for (const n of catalog.neighbors(c.ordinal)) ordinals.add(n);
  return {catalogRef: catalog.ref, revision: 3, territoriesById: Object.fromEntries([...ordinals].map(n => {
    const c = catalog.cell(n);
    return [c.id, createTerritoryEntityV3({id: c.id, sourceCountryId: c.sourceCountryId, ownerCountryId: c.sourceCountryId, controllerCountryId: c.sourceCountryId})];
  }))};
}

describe('16-06 pinned catalog frontier integration', () => {
  it('partially selects the Korean frontier and advances from the supplied updated control state', () => {
    const world = worldAt('PRK');
    const request = {catalogRef: catalog.ref, baseWorldRevision: 3, actorCountryId: 'KOR', targetCountryId: 'PRK', operation: 'occupy', extent: 'near'};
    const first = selectOperationalFrontier(catalog, world, request);
    expect(first.cellIds.length).toBeGreaterThan(1);
    expect(first.cellIds.length).toBeLessThanOrEqual(512);
    expect(first.metrics.areaKm2).toBeLessThanOrEqual(2800);
    expect(first.metrics.maximumGraphDepthKm).toBeLessThanOrEqual(36);
    expect(first.metrics.maximumLateralKm).toBeLessThanOrEqual(18);
    expect(catalog.neighbors(catalog.cell(first.frontier.cellId).ordinal)).toContain(catalog.cell(first.frontier.supportCellId).ordinal);
    const chosen = new Set(first.cellIds);
    const parents = new Set(first.cellIds.map(id => catalog.cell(id).administrativeOrdinal));
    expect([...parents].some(n => {
      const members = catalog.administrativeMembership(catalog.administrativeParents[n - 1].parentKey);
      return members.some(c => chosen.has(c.id)) && members.some(c => !chosen.has(c.id));
    })).toBe(true);
    const seen = new Set([first.cellIds[0]]), queue = [first.cellIds[0]];
    while (queue.length) for (const n of catalog.neighbors(catalog.cell(queue.pop()!).ordinal)) {
      const c = catalog.cell(n);
      if (chosen.has(c.id) && !seen.has(c.id)) {seen.add(c.id); queue.push(c.id);}
    }
    expect(seen.size).toBe(chosen.size);
    const territoriesById = {...world.territoriesById};
    for (const id of chosen) territoriesById[id] = createTerritoryEntityV3({...territoriesById[id], controllerCountryId: 'KOR'});
    const next = selectOperationalFrontier(catalog, {...world, revision: 4, territoriesById}, {...request, baseWorldRevision: 4});
    expect(next.frontier.kind).toBe('current-controller');
    expect(chosen.has(next.frontier.supportCellId as typeof first.cellIds[number])).toBe(true);
    expect(next.cellIds.every(id => !chosen.has(id))).toBe(true);
    expect(world.territoriesById[first.cellIds[0]].controllerCountryId).toBe('PRK');
    expect(reads.some(p => /\/geometry\.geojson|\/detail\/countries\//.test(p))).toBe(false);
  });

  it('uses the same selector and existing administrative identities for Slovenia', () => {
    const world = worldAt('SVN'), regions = createOperationalRegionIndex(catalog);
    const request = {catalogRef: catalog.ref, baseWorldRevision: 3, actorCountryId: 'HRV', targetCountryId: 'SVN', operation: 'occupy', extent: 'near'};
    const selected = selectOperationalFrontier(catalog, world, request, regions);
    expect(selected.cellIds.length).toBeGreaterThan(0);
    expect(selected.cellIds.length).toBeLessThan(catalog.loadCountry('SVN').length);
    const chosen = selected.frontier.cellId;
    const region = regions.listCountry('SVN').find(r => r.territoryIds.includes(chosen))!;
    const named = selectOperationalFrontier(catalog, world, {...request, reference: region.ref}, regions);
    expect(named.cellIds.every(id => region.territoryIds.includes(id))).toBe(true);
    expect(named.scope.reference).toEqual(region.ref);
    expect(regions.listCountry('SVN').filter(r => r.ref.subdivisionId.startsWith('region:ne-admin1:'))).toHaveLength(193);
  });
});
