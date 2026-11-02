// @vitest-environment node
import {beforeEach, describe, expect, it, vi} from 'vitest';
import type {OperationalMapWorld} from './operational-map-projection';
import {operationalFront} from './operational-map-projection';
import {mapColorPresentation} from '../world/country-map-color';
import {createTerritoryEntityV3} from '../world/territory-entity-v3';
import {createWorldGeometryCatalogRef, readCatalogTerritoryId} from '../world/world-geometry-catalog-ref';

vi.mock('../world/country-map-color', async importOriginal => {
  const actual = await importOriginal<typeof import('../world/country-map-color')>();
  return {...actual, mapColorPresentation: vi.fn(actual.mapColorPresentation)};
});

const ref = createWorldGeometryCatalogRef({catalogVersion: 'catalog-v3-fixture', geometryRoot: 'a'.repeat(64), topologyRoot: 'b'.repeat(64), renderArtifactRoot: 'c'.repeat(64), manifestPath: '/data/territory-catalog/catalog-v3-fixture/manifest.json'});
const ids = [1, 2, 3].map(n => readCatalogTerritoryId(`territory:catalog:${String(n).padStart(64, '0')}`));
function fixture(): OperationalMapWorld {
  return {catalogRef: ref, revision: 0, territoryOrder: ids,
    countriesById: {AAA: {mapColor: '#FF0000'}, BBB: {mapColor: '#0000FF'}, CCC: {mapColor: '#FF0000'}},
    territoriesById: Object.fromEntries(ids.map((id, i) => [id, createTerritoryEntityV3({id, sourceCountryId: ['AAA', 'BBB', 'CCC'][i],
      ownerCountryId: ['AAA', 'BBB', 'CCC'][i], controllerCountryId: ['AAA', 'AAA', 'CCC'][i]})]))};
}
function recolor(world: OperationalMapWorld, mapColor: string): OperationalMapWorld {
  return {...world, revision: world.revision + 1, countriesById: {...world.countriesById, AAA: {mapColor}}};
}
function changeCell(world: OperationalMapWorld, patch: {ownerCountryId?: string | null; controllerCountryId?: string | null}): OperationalMapWorld {
  return {...world, revision: world.revision + 1, territoriesById: {...world.territoriesById,
    [ids[0]]: createTerritoryEntityV3({...world.territoriesById[ids[0]], ...patch})}};
}

describe('occupation-front classification', () => {
  const peaceful = () => changeCell(fixture(), {controllerCountryId: 'AAA'});
  const border = {left: 1, right: 3};

  it('keeps ordinary borders and peaceful ownership transfers out of the gold front layer', () => {
    const world = peaceful();
    expect(operationalFront(world, border)).toBe(false);
    expect(operationalFront(changeCell(world, {ownerCountryId: 'BBB', controllerCountryId: 'BBB'}), border)).toBe(false);
  });

  it('requires occupation and different valid controllers on either side', () => {
    const occupied = changeCell(peaceful(), {controllerCountryId: 'BBB'});
    expect(operationalFront(occupied, border)).toBe(true);
    expect(operationalFront(occupied, {left: 3, right: 1})).toBe(true);
    expect(operationalFront(changeCell(occupied, {controllerCountryId: 'CCC'}), border)).toBe(false);
    expect(operationalFront(changeCell(occupied, {controllerCountryId: 'AAA'}), border)).toBe(false);
  });

  it.each(['ownerCountryId', 'controllerCountryId'] as const)('excludes unowned or uncontrolled land (%s)', field => {
    const world = changeCell(peaceful(), {ownerCountryId: null, controllerCountryId: field === 'controllerCountryId' ? null : 'BBB'});
    expect(operationalFront(world, border)).toBe(false);
    expect(operationalFront(world, {left: 3, right: 1})).toBe(false);
  });

  it.each(['AAA', 'BBB', 'CCC'])('excludes unavailable owner/controller countries (%s)', unavailable => {
    const world = changeCell(peaceful(), {controllerCountryId: 'BBB'});
    const countriesById = {...world.countriesById}; delete countriesById[unavailable];
    expect(operationalFront({...world, countriesById}, border)).toBe(false);
  });

  it('never classifies a coast as a front', () => {
    expect(operationalFront(changeCell(peaceful(), {controllerCountryId: 'BBB'}), {left: 1, right: 0})).toBe(false);
  });
});

let operationalCellView: typeof import('./operational-map-projection')['operationalCellView'];
beforeEach(async () => {
  vi.resetModules();
  vi.mocked(mapColorPresentation).mockClear();
  ({operationalCellView} = await import('./operational-map-projection'));
});

describe('18-03B operational projection color reuse', () => {
  it('calculates a shared color once across cells and countries while returning fresh complete views', () => {
    const world = fixture();
    for (let repeat = 0; repeat < 10; repeat++) {
      for (const ordinal of [1, 2, 3]) expect(operationalCellView(world, ordinal).mapColor).toBe('#FF0000');
    }
    expect(mapColorPresentation).toHaveBeenCalledExactlyOnceWith('#FF0000');
    const first = operationalCellView(world, 1), second = operationalCellView(world, 2);
    expect(first).toEqual({ordinal: 1, ...world.territoriesById[ids[0]], mapColor: '#FF0000', outlineColor: '#000000',
      selectionColor: '#000000', labelColor: '#000000', labelHaloColor: '#FFFFFF', occupied: false});
    expect(second).toMatchObject({ordinal: 2, id: ids[1], sourceCountryId: 'BBB', ownerCountryId: 'BBB', controllerCountryId: 'AAA', occupied: true});
    first.mapColor = '#123456';
    expect(operationalCellView(world, 1)).not.toBe(first);
    expect(operationalCellView(world, 1).mapColor).toBe('#FF0000');
    expect(mapColorPresentation).toHaveBeenCalledTimes(1);
  });

  it('uses the current color through edits, undo and redo snapshots', () => {
    const before = fixture(), edited = recolor(before, '#ABCDEF');
    const snapshots = [before, edited, {...before, revision: 2}, {...edited, revision: 3}];
    for (const [i, world] of snapshots.entries()) {
      const expected = i % 2 === 0 ? '#FF0000' : '#ABCDEF';
      expect(operationalCellView(world, 1).mapColor).toBe(expected);
      expect(operationalCellView(world, 2)).toMatchObject({mapColor: expected, occupied: true});
      expect(operationalCellView(world, 3).mapColor).toBe('#FF0000');
    }
    expect(vi.mocked(mapColorPresentation).mock.calls).toEqual([['#FF0000'], ['#ABCDEF']]);
  });

  it('reads fresh ownership and control through occupation, liberation, transfer and restoration', () => {
    const before = fixture(), occupied = changeCell(before, {controllerCountryId: 'BBB'});
    const liberated = changeCell(occupied, {controllerCountryId: 'AAA'});
    const transferred = changeCell(liberated, {ownerCountryId: 'CCC', controllerCountryId: 'CCC'});
    for (const [world, owner, controller, mapColor, isOccupied] of [
      [before, 'AAA', 'AAA', '#FF0000', false],
      [occupied, 'AAA', 'BBB', '#0000FF', true],
      [liberated, 'AAA', 'AAA', '#FF0000', false],
      [transferred, 'CCC', 'CCC', '#FF0000', false],
      [{...occupied, revision: 4}, 'AAA', 'BBB', '#0000FF', true],
      [{...transferred, revision: 5}, 'CCC', 'CCC', '#FF0000', false],
    ] as const) {
      expect(operationalCellView(world, 1)).toMatchObject({id: ids[0], sourceCountryId: 'AAA', ownerCountryId: owner,
        controllerCountryId: controller, mapColor, occupied: isOccupied});
    }
    expect(mapColorPresentation).toHaveBeenCalledTimes(2);
  });

  it('reuses the neutral color for null controllers and follows subsequent controller changes', () => {
    const neutral = {...changeCell(fixture(), {ownerCountryId: null, controllerCountryId: null}), countriesById: {}};
    for (let i = 0; i < 5; i++) expect(operationalCellView(neutral, 1)).toMatchObject({mapColor: '#D6D3C7', occupied: false, controllerCountryId: null});
    const controlled = {...changeCell(neutral, {controllerCountryId: 'AAA'}), countriesById: {AAA: {mapColor: '#FF0000'}}};
    expect(operationalCellView(controlled, 1)).toMatchObject({mapColor: '#FF0000', occupied: true, ownerCountryId: null});
    expect(operationalCellView({...neutral, revision: 3}, 1)).toMatchObject({mapColor: '#D6D3C7', occupied: false});
    expect(vi.mocked(mapColorPresentation).mock.calls).toEqual([['#D6D3C7'], ['#FF0000']]);
  });

  it('rejects a retired controller despite a warm cache and reflects its recreation color', () => {
    const before = fixture();
    operationalCellView(before, 1);
    const countriesById = {BBB: before.countriesById.BBB, CCC: before.countriesById.CCC};
    const retired = {...before, revision: 1, countriesById};
    expect(() => operationalCellView(retired, 1)).toThrow('UNKNOWN_OPERATIONAL_MAP_CONTROLLER');
    const transferred = changeCell(retired, {ownerCountryId: 'CCC', controllerCountryId: 'CCC'});
    expect(operationalCellView(transferred, 1)).toMatchObject({ownerCountryId: 'CCC', controllerCountryId: 'CCC', mapColor: '#FF0000'});
    const recreated = {...before, revision: 3, countriesById: {...countriesById, AAA: {mapColor: '#00FF00'}}};
    expect(operationalCellView(recreated, 1).mapColor).toBe('#00FF00');
    expect(operationalCellView({...before, revision: 4}, 1).mapColor).toBe('#FF0000');
    expect(vi.mocked(mapColorPresentation).mock.calls).toEqual([['#FF0000'], ['#00FF00']]);
  });

  it('still rejects invalid ordinals and unknown or mismatched cells after warming the color', () => {
    const world = fixture();
    operationalCellView(world, 1);
    for (const ordinal of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => operationalCellView(world, ordinal)).toThrow('INVALID_OPERATIONAL_MAP_ORDINAL');
    }
    expect(() => operationalCellView(world, 4)).toThrow('UNKNOWN_OPERATIONAL_MAP_CELL');
    expect(() => operationalCellView({...world, territoriesById: {}}, 1)).toThrow('UNKNOWN_OPERATIONAL_MAP_CELL');
    const mismatched = {...world, territoriesById: {...world.territoriesById, [ids[0]]: {...world.territoriesById[ids[0]], id: ids[1]}}};
    expect(() => operationalCellView(mismatched, 1)).toThrow('UNKNOWN_OPERATIONAL_MAP_CELL');
    expect(mapColorPresentation).toHaveBeenCalledTimes(1);
  });

  it('does not normalize or cache invalid colors even when their uppercase equivalent is cached', () => {
    const world = fixture();
    operationalCellView(world, 1);
    for (const mapColor of ['#ff0000', '#FFF', 'red', ' #FFFFFF', '#GG0000']) {
      const invalid = recolor(world, mapColor);
      expect(() => operationalCellView(invalid, 1)).toThrow('canonical uppercase #RRGGBB');
      expect(() => operationalCellView(invalid, 1)).toThrow('canonical uppercase #RRGGBB');
    }
    expect(operationalCellView(world, 1).mapColor).toBe('#FF0000');
    expect(mapColorPresentation).toHaveBeenCalledTimes(11);
  });

  it('evicts old colors after 512 entries instead of retaining every past edit', () => {
    const world = fixture(), color = (n: number) => `#${n.toString(16).padStart(6, '0').toUpperCase()}`;
    for (let n = 0; n < 512; n++) operationalCellView(recolor(world, color(n)), 1);
    expect(mapColorPresentation).toHaveBeenCalledTimes(512);
    operationalCellView(recolor(world, color(511)), 1);
    expect(mapColorPresentation).toHaveBeenCalledTimes(512);
    operationalCellView(recolor(world, color(512)), 1);
    expect(operationalCellView(recolor(world, color(0)), 1).mapColor).toBe('#000000');
    expect(mapColorPresentation).toHaveBeenCalledTimes(514);
    operationalCellView(recolor(world, color(0)), 1);
    expect(mapColorPresentation).toHaveBeenCalledTimes(514);
  });
});
