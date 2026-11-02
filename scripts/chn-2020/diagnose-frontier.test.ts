// @vitest-environment node
import fs from 'node:fs';
import path from 'node:path';
import {it, vi} from 'vitest';
import type {OperationalFrontierSelection} from '../../src/lib/simulation/operational-frontier.server';

const pointerPath = process.env.CHN_DIAGNOSE_POINTER;
if (pointerPath) {
  const bytes = fs.readFileSync(pointerPath), pointer = JSON.parse(bytes.toString('utf8'));
  vi.doMock('../../data/runtime/operational-catalog/current.json', () => ({default: pointer}));
  const originalRead = fs.readFileSync;
  vi.spyOn(fs, 'readFileSync').mockImplementation(((file: fs.PathOrFileDescriptor, ...args: unknown[]) => {
    if (typeof file === 'string' && path.resolve(file) === path.resolve('data/runtime/operational-catalog/current.json')) {
      return args[0] === 'utf8' ? bytes.toString('utf8') : Buffer.from(bytes);
    }
    return Reflect.apply(originalRead, fs, [file, ...args]);
  }) as typeof fs.readFileSync);
}

(pointerPath ? it : it.skip)('records the actual ordered frontier seeds without changing selection', async () => {
  const {prepareOperationalCatalog} = await import('../../src/lib/world/operational-catalog.server');
  const {createProductionOperationalGame} = await import('../../src/lib/world/operational-game.server');
  const {selectOperationalFrontier} = await import('../../src/lib/simulation/operational-frontier.server');
  const {createTerritoryEntityV3} = await import('../../src/lib/world/territory-entity-v3');
  const catalog = prepareOperationalCatalog(), world = createProductionOperationalGame('PRK').pair.world;
  const contacts: unknown[] = [];
  let stage = 'first';
  const observed = {...catalog, sharedBoundary: (left: number, right: number) => {
    const cell = catalog.cell(left), boundary = catalog.sharedBoundary(left, right);
    const parent = catalog.administrativeParents[cell.administrativeOrdinal - 1];
    contacts.push({stage, cell, support: catalog.cell(right), metrics: catalog.cellMetrics(left), parent,
      parentAreaKm2: catalog.administrativeMembership(parent.parentKey).reduce((sum, c) => sum + catalog.cellMetrics(c.ordinal).areaKm2, 0), boundary});
    return boundary;
  }};
  const routes: {direction: string | null; error?: string; first?: OperationalFrontierSelection; followup?: OperationalFrontierSelection}[] = [];
  for (const direction of [null, 'north', 'south', 'east', 'west']) {
    stage = `${direction || 'default'}:first`;
    try {
      const request = {catalogRef: catalog.ref, baseWorldRevision: world.revision,
        actorCountryId: 'PRK', targetCountryId: 'CHN', operation: 'occupy', extent: 'near', cap: 512, direction};
      const first = selectOperationalFrontier(observed, world, request);
      stage = `${direction || 'default'}:followup`;
      const advanced = {...world, revision: world.revision + 1, territoriesById: {...world.territoriesById,
        ...Object.fromEntries(first.cellIds.map(id => [id, createTerritoryEntityV3({...world.territoriesById[id], controllerCountryId: 'PRK'})]))}};
      routes.push({direction, first, followup: selectOperationalFrontier(observed, advanced, {...request, baseWorldRevision: advanced.revision})});
    }
    catch (error) {routes.push({direction, error: error instanceof Error ? error.message : String(error)});}
  }
  const result = routes;
  fs.writeFileSync('reports/chn-2020/frontier-seed-diagnosis.json', `${JSON.stringify({pointerPath, contacts, result}, null, 2)}\n`);
  console.log(JSON.stringify({contacts: contacts.length, routes: routes.map(r => ({direction: r.direction, error: r.error,
    firstCount: r.first?.cellIds.length, firstAreaKm2: r.first?.metrics.areaKm2, followupKind: r.followup?.frontier.kind,
    followupCount: r.followup?.cellIds.length, followupAreaKm2: r.followup?.metrics.areaKm2}))}));
}, 30000);
