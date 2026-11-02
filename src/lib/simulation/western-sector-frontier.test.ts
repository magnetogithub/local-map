// @vitest-environment node
import {describe, expect, it} from 'vitest';
import {createProductionOperationalGame} from '../world/operational-game.server';
import {prepareOperationalCatalog, type OperationalCatalog} from '../world/operational-catalog.server';
import {createTerritoryEntityV3} from '../world/territory-entity-v3';
import type {OperationalWorldView} from '../world/operational-catalog';
import {selectOperationalFrontier, type OperationalFrontierSelection} from './operational-frontier.server';
import {createOperationalRegionIndex} from './operational-region.server';

type WesternEvidence = {
  method: string;
  administrativeTruthClaim: boolean;
  contacts: {name: string; administrativeParentKey: string}[];
  receivingComponents: {cellId: string}[];
};

function expectOriginalNearLimits(catalog: OperationalCatalog, selection: OperationalFrontierSelection) {
  expect(selection.cellIds.length).toBeGreaterThan(0);
  expect(selection.limits).toEqual({depthKm: 36, widthKm: 36, maximumAreaKm2: 2800});
  expect(selection.metrics.maximumGraphDepthKm).toBeLessThanOrEqual(36);
  expect(selection.metrics.maximumForwardDepthKm).toBeLessThanOrEqual(36);
  expect(selection.metrics.maximumLateralKm).toBeLessThanOrEqual(18);
  expect(selection.metrics.areaKm2).toBeLessThanOrEqual(2800);
  for (const ordinal of new Set(selection.cellIds.map(id => catalog.cell(id).administrativeOrdinal))) {
    const parent = catalog.administrativeParents[ordinal - 1];
    const total = catalog.administrativeMembership(parent.parentKey)
      .reduce((sum, cell) => sum + catalog.cellMetrics(cell.ordinal).areaKm2, 0);
    const selected = selection.cellIds.filter(id => catalog.cell(id).administrativeOrdinal === ordinal)
      .reduce((sum, id) => sum + catalog.cellMetrics(id).areaKm2, 0);
    if (total >= 8000) expect(selected).toBeLessThanOrEqual(total * 0.35);
  }
}

describe('actual western Korean gameplay sector', () => {
  it('uses a Gyeonggi fine cell for westward invasion and continues from current control within the original caps', () => {
    const game = createProductionOperationalGame('PRK'), catalog = prepareOperationalCatalog();
    const world: OperationalWorldView = {catalogRef: catalog.ref, revision: 0, territoriesById: game.pair.world.territoriesById};
    const request = {catalogRef: catalog.ref, baseWorldRevision: 0, actorCountryId: 'PRK', targetCountryId: 'KOR', operation: 'occupy', extent: 'near', direction: 'west', cap: 512};
    const regions = createOperationalRegionIndex(catalog);
    const first = selectOperationalFrontier(catalog, world, request, regions);
    expectOriginalNearLimits(catalog, first);
    expect(first.frontier.kind).toBe('land-border');
    const frontierCell = catalog.cell(first.frontier.cellId);
    const parent = catalog.administrativeParents[frontierCell.administrativeOrdinal - 1];
    expect(parent.kind).toBe('administrative');
    expect(parent.sourceCountryId).toBe('KOR');
    expect(parent.parentKey.startsWith('fine-macro:KOR:')).toBe(true);
    expect(parent.name).toMatch(/Gyeonggi/);

    const provenance = JSON.parse(catalog.readDeliveryAsset('provenance.json').toString('utf8')) as {westernSectorReconciliation?: WesternEvidence};
    const western = provenance.westernSectorReconciliation;
    expect(western, 'The active catalog must contain the verified western gameplay partition').toBeDefined();
    if (!western) throw Error('WESTERN_GAMEPLAY_PARTITION_NOT_ACTIVE');
    expect(western.method).toBe('gameplay-contact-partition');
    expect(western.administrativeTruthClaim).toBe(false);
    expect(new Set(western.contacts.map(contact => contact.name))).toEqual(new Set(['Paju-si', 'Yeoncheon-gun']));
    const parentKeys = new Set(western.contacts.map(contact => contact.administrativeParentKey));
    expect(parentKeys.size).toBe(1);

    expect(western.receivingComponents.map(component => component.cellId)).toContain(first.frontier.cellId);
    expect(parentKeys.has(parent.parentKey)).toBe(true);
    const gyeonggi = regions.search('KOR', 'Gyeonggi');
    expect(gyeonggi).toHaveLength(1);
    expect(gyeonggi[0].territoryIds).toContain(first.frontier.cellId);
    expect(catalog.cell(first.frontier.supportCellId).sourceCountryId).toBe('PRK');
    const edge = catalog.edge(first.frontier.edgeOrdinal);
    expect(edge.boundaryClass).toBe('country');
    expect(edge.lengthKm).toBeGreaterThan(0);

    const advanced: OperationalWorldView = {...world, revision: 1, territoriesById: {...world.territoriesById,
      ...Object.fromEntries(first.cellIds.map(id => [id, createTerritoryEntityV3({...world.territoriesById[id], controllerCountryId: 'PRK'})]))}};
    for (const id of first.cellIds) {
      expect(world.territoriesById[id]).toMatchObject({ownerCountryId: 'KOR', controllerCountryId: 'KOR'});
      expect(advanced.territoriesById[id]).toMatchObject({sourceCountryId: 'KOR', ownerCountryId: 'KOR', controllerCountryId: 'PRK'});
    }
    const next = selectOperationalFrontier(catalog, advanced, {...request, baseWorldRevision: 1}, regions);
    expectOriginalNearLimits(catalog, next);
    expect(next.frontier.kind).toBe('current-controller');
    expect(first.cellIds).toContain(next.frontier.supportCellId);
    expect(next.cellIds.every(id => !first.cellIds.includes(id))).toBe(true);
    expect(catalog.neighbors(catalog.cell(next.frontier.cellId).ordinal)).toContain(catalog.cell(next.frontier.supportCellId).ordinal);
    expect(() => selectOperationalFrontier(catalog, advanced, request, regions)).toThrow('STALE_WORLD_REVISION');
  });
});
