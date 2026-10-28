// @vitest-environment node
import fs from 'node:fs';
import {describe, expect, it, vi} from 'vitest';
import {createProductionOperationalGame, prepareProductionOperationalTransition} from './operational-game.server';
import {loadOperationalCatalog} from './operational-catalog.server';
import {loadProductionCatalogSeed} from './production-catalog-seed.server';
import {createCatalogRuntime, readCatalogRuntimePair} from '../simulation/catalog-runtime';
import {readCatalogConsumerMetadata} from '../map/catalog-consumer-contract';
import {catalogContractForConsumer} from '../projection/catalog-map-consumer-projection';
import {createSimulationStateV2} from '../simulation/simulation-state-v2';
import {createCatalogTurnPlan} from '../simulation/catalog-turn-plan';
import {selectOperationalFrontier} from '../simulation/operational-frontier.server';

describe('16-02 pinned production new-game factory', () => {
  it('initializes the complete cell set from the previous game seed without loading detailed geometry', () => {
    const reads = vi.spyOn(fs, 'readFileSync');
    const paths: string[] = [];
    const game = (() => {try {return createProductionOperationalGame('KOR');} finally {
      paths.push(...reads.mock.calls.map(call => String(call[0]).replaceAll('\\', '/')));
      reads.mockRestore();
    }})();
    const operational = loadOperationalCatalog();
    const previous = loadProductionCatalogSeed();
    const metadata = readCatalogConsumerMetadata(JSON.parse(fs.readFileSync(`public${previous.bootstrap.metadata.path}`, 'utf8')), previous.bootstrap.catalogRef);
    const legacy = readCatalogRuntimePair(previous.serializedPair, catalogContractForConsumer(metadata));
    expect(game.pair.world.territoryOrder).toHaveLength(923443);
    expect(paths.some(p => /\.geojson|\/detail\/|\/topology\/|geometry\.json|topology\.json/.test(p))).toBe(false);
    expect(game.pair.world.territoryOrder.every((id, i) => id === game.catalog.territoryOrder[i])).toBe(true);
    expect(game.pair.world.catalogRef).toEqual(game.descriptor.catalogRef);
    expect(game.catalog.ref).toEqual(operational.ref);
    expect(game.pair.revisions).toEqual({worldRevision: 0, simulationRevision: 0});
    expect(game.pair.simulation.playerCountryId).toBe('KOR');
    expect(game.pair.world.countriesById).toEqual(legacy.world.countriesById);
    // A small sample across parents/countries verifies the actual pinned mapping,
    // rather than reconstructing source-country ownership in the new-game path.
    for (const countryId of ['KOR', 'PRK', 'SVN', 'CHN']) {
      const cells = operational.loadCountry(countryId);
      for (const cell of [cells[0], cells[Math.floor(cells.length / 2)], cells.at(-1)!]) {
        const parent = operational.previousParents[cell.previousParentOrdinal - 1];
        const previousState = legacy.world.territoriesById[parent.oldTerritoryId];
        expect(game.pair.world.territoriesById[cell.id]).toEqual({id: cell.id, sourceCountryId: cell.sourceCountryId,
          ownerCountryId: previousState.ownerCountryId, controllerCountryId: previousState.controllerCountryId});
      }
    }
    expect(createProductionOperationalGame('SVN').pair.world).toBe(game.pair.world);
    expect(() => createProductionOperationalGame('XXX')).toThrow();
    // The transition entrypoint rejects a different source catalog before changing it.
    expect(() => prepareProductionOperationalTransition(game.pair)).toThrow('Catalog ref mismatch');
  }, 90_000);

  it('commits a bounded real Korean frontier into the complete world and restores its render delta through undo/redo', () => {
    const game = createProductionOperationalGame('KOR'), catalog = loadOperationalCatalog();
    const selected = selectOperationalFrontier(catalog, game.pair.world, {catalogRef: catalog.ref,
      baseWorldRevision: 0, actorCountryId: 'KOR', targetCountryId: 'PRK', operation: 'occupy', extent: 'near'});
    const ground = {eventId: 'event.ground', date: '2020-01-01', title: '기존 접경 전황', publicNarrative: '접경의 기존 군사 상황을 확인했습니다.',
      actorCountryIds: ['KOR', 'PRK'], relatedFactIds: [], relatedSituationIds: [], causes: [], outcomeCategory: 'military', significance: 'notable'};
    const authority = {id: 'tca:frontier', actorCountryId: 'KOR', targetCountryId: 'PRK', allowedTerritoryIds: selected.cellIds,
      allowedOperations: ['occupy'], validFrom: '2020-01-01', validTo: null, sourceEventId: ground.eventId};
    const simulation = createSimulationStateV2({...game.pair.simulation, eventLog: [ground],
      territorialControlAuthoritiesById: {[authority.id]: authority}, territorialControlAuthorityOrder: [authority.id]}, game.pair.world);
    const runtime = createCatalogRuntime({...game.pair, simulation}, game.catalog), before = runtime.getSnapshot();
    const plan = createCatalogTurnPlan({...before, catalog: game.catalog, turnId: 'turn.actual-cells',
      frontier: {world: before.world, resolve: (world, scope) => selectOperationalFrontier(catalog, world, scope)},
      resolution: {contractVersion: 'turn-resolution.v1', baseWorldRevision: 0, baseSimulationRevision: 0,
        period: {startDate: '2020-01-01', endDate: '2020-01-02'}, playerActionOutcomes: [],
        events: [{...ground, eventId: 'event.advance', date: '2020-01-02', causes: [{kind: 'authoritative-event', id: ground.eventId}]}],
        factMutations: [], situationMutations: [], scheduledConsequences: [], worldEffects: [{effectId: 'effect.occupy',
          causedByEventId: 'event.advance', type: 'territory.occupy', actorCountryId: 'KOR', targetCountryId: 'PRK',
          authorityId: authority.id, territoryIds: selected.cellIds, regionRefs: null, frontierScope: selected.scope}],
        advisorSummary: '선택된 접경 cell을 점령했습니다.', unresolvedQuestions: []}});
    const next = runtime.commit(plan), delta = runtime.getLastChange()!.stateChange!;
    expect(next.world.territoryOrder).toHaveLength(923443);
    expect(delta.cells.map(c => c.id)).toEqual(selected.cellIds);
    for (const id of selected.cellIds) expect(next.world.territoriesById[id]).toMatchObject({ownerCountryId: 'PRK', controllerCountryId: 'KOR', sourceCountryId: 'PRK'});
    const occupied = new Set(selected.cellIds), first = catalog.cell(selected.cellIds[0]);
    const parent = catalog.administrativeParents[first.administrativeOrdinal - 1];
    const untouched = catalog.administrativeMembership(parent.parentKey).find(cell => !occupied.has(cell.id))!;
    expect(untouched).toBeDefined();
    expect(next.world.territoriesById[untouched.id]).toBe(before.world.territoriesById[untouched.id]);
    expect(next.world.territoriesById[untouched.id].controllerCountryId).toBe('PRK');
    const undone = runtime.undo();
    expect(runtime.getLastChange()!.stateChange!.cells.map(c => c.id)).toEqual(selected.cellIds);
    for (const id of selected.cellIds) expect(undone.world.territoriesById[id].controllerCountryId).toBe('PRK');
    const redone = runtime.redo();
    for (const id of selected.cellIds) expect(redone.world.territoriesById[id].controllerCountryId).toBe('KOR');
    expect(runtime.getHistory().pointer).toBe(1);
    expect(runtime.getLastChange()!.next).toBe(redone);
  }, 120_000);
});
