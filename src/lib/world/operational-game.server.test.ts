// @vitest-environment node
import fs from 'node:fs';
import {describe, expect, it, vi} from 'vitest';
import {createProductionOperationalGame} from './operational-game.server';
import {loadOperationalCatalog} from './operational-catalog.server';
import {createCatalogRuntime, readCatalogRuntimePair} from '../simulation/catalog-runtime';

describe('current operational new game', () => {
  it('starts directly from the coarse seed, preserves all countries, and never reads old operational assets', () => {
    const spy = vi.spyOn(fs, 'readFileSync');
    let paths: string[] = [];
    const game = (() => {try {return createProductionOperationalGame('KOR');} finally {paths = spy.mock.calls.map(c => String(c[0]).replaceAll('\\', '/')); spy.mockRestore();}})();
    expect(game.pair.world.territoryOrder).toHaveLength(loadOperationalCatalog().descriptor.counts.cells);
    expect(game.pair.world.countryOrder).toHaveLength(247);
    expect(game.pair.revisions).toEqual({worldRevision: 0, simulationRevision: 0});
    expect(game.pair.simulation.playerCountryId).toBe('KOR');
    expect(game.pair.simulation.currentDate).toBe('2020-01-01');
    expect(paths.some(p => /data\/derived\/prompt15|56fc6c79c216e6bd1a11|\/detail\/|edge-incidence/.test(p))).toBe(false);
    expect(game.catalog.ref).toEqual(loadOperationalCatalog().ref);
    for (const countryId of ['KOR', 'PRK', 'SVN', 'CHN']) for (const c of loadOperationalCatalog().loadCountry(countryId)) {
      expect(game.pair.world.territoriesById[c.id]).toMatchObject({sourceCountryId: countryId, ownerCountryId: countryId, controllerCountryId: countryId});
    }
    expect(createProductionOperationalGame('SVN').pair.world).toBe(game.pair.world);
    expect(() => createProductionOperationalGame('XXX')).toThrow();
    expect(createCatalogRuntime(game.pair, game.catalog).getSnapshot().world.territoryOrder).toHaveLength(loadOperationalCatalog().descriptor.counts.cells);
  });
  it('rejects an old catalog save before reinterpreting any territory IDs', () => {
    const game = createProductionOperationalGame();
    const saved = {format: 'world-simulation-schema-pair.v1', world: {...game.pair.world, retiredCountryIds: [...game.pair.world.retiredCountryIds], catalogRef: {...game.catalog.ref}}};
    saved.world.catalogRef.catalogVersion = 'catalog-v3-56fc6c79c216e6bd1a11';
    saved.world.catalogRef.manifestPath = `/data/territory-catalog/${saved.world.catalogRef.catalogVersion}/manifest.json`;
    expect(() => readCatalogRuntimePair(JSON.stringify(saved), game.catalog)).toThrow('Catalog ref mismatch');
  });
});
