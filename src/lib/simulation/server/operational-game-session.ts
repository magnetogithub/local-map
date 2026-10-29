import {createCatalogRuntime, type CatalogRuntimePair} from '../catalog-runtime';
import {createCatalogTurnPlan} from '../catalog-turn-plan';
import {queuePlayerAction, cancelQueuedPlayerAction} from '../queued-player-action';
import {buildSimulationContext, parseSimulationContextV1, type SimulationContextV1} from '../simulation-context';
import {targetDateForCustomInput} from '../client/turn-request';
import {createCommittedTurnReport, type TurnReport} from '../client/turn-report';
import {createCountrySearchProjection} from '../../projection/country-search-index-patch';
import {createOperationalStateChange} from '../../world/operational-state-change';
import {canonicalStringify} from '../../world/canonical-serializer';
import type {WorldGeometryCatalogContract} from '../../world/world-geometry-catalog-ref';
import type {CatalogRegionIndex} from '../catalog-region';
import type {OperationalFrontierValidation} from '../operational-frontier-validation';
import type {OperationalControlCounts, OperationalGameCommand, OperationalGameSnapshot} from '../operational-game-protocol';
import type {WorldStateV3} from '../../world/world-state-v3';
import type {SimulationModelProvider, SimulationProviderRequest} from './simulation-provider';

/** One local game's authoritative pair/history. Provider failures publish no state. */
export function createOperationalGameSession(input: {
  seed: CatalogRuntimePair;
  catalog: WorldGeometryCatalogContract;
  regionIndex: CatalogRegionIndex;
  frontier: OperationalFrontierValidation['resolve'];
  actionId: () => string;
}) {
  const runtime = createCatalogRuntime(input.seed, input.catalog);
  const key = (r: CatalogRuntimePair['revisions']) => `${r.worldRevision}:${r.simulationRevision}`;
  const versions = new Map([[key(input.seed.revisions), input.seed]]);
  const countCache = new WeakMap<WorldStateV3, OperationalControlCounts>();
  let busy = false, report: TurnReport | null = null;
  let preparedContext: Readonly<{base: CatalogRuntimePair; targetDate: string; turnId: string; canonical: string}> | undefined;
  const remember = () => {
    const pair = runtime.getSnapshot(); versions.set(key(pair.revisions), pair);
    while (versions.size > 64) versions.delete(versions.keys().next().value!);
  };
  const controlCounts = (world: WorldStateV3): OperationalControlCounts => {
    const cached = countCache.get(world); if (cached) return cached;
    const counts = Object.fromEntries(world.countryOrder.map(id => [id, {owned: 0, controlled: 0, occupied: 0}]));
    for (const id of world.territoryOrder) {
      const c = world.territoriesById[id];
      if (c.ownerCountryId) {counts[c.ownerCountryId].owned++; if (c.controllerCountryId !== c.ownerCountryId) counts[c.ownerCountryId].occupied++;}
      if (c.controllerCountryId) counts[c.controllerCountryId].controlled++;
    }
    countCache.set(world, counts); return counts;
  };
  runtime.subscribeChanges(change => {
    preparedContext = undefined;
    remember();
    if (change.previous.world === change.next.world || !change.stateChange) return;
    const previous = controlCounts(change.previous.world);
    const counts = Object.fromEntries(change.next.world.countryOrder.map(id => [id, {...previous[id] ?? {owned: 0, controlled: 0, occupied: 0}}]));
    for (const c of change.stateChange.cells) for (const [cell, sign] of [[c.before, -1], [c.after, 1]] as const) {
      if (cell.ownerCountryId && counts[cell.ownerCountryId]) {counts[cell.ownerCountryId].owned += sign; if (cell.controllerCountryId !== cell.ownerCountryId) counts[cell.ownerCountryId].occupied += sign;}
      if (cell.controllerCountryId && counts[cell.controllerCountryId]) counts[cell.controllerCountryId].controlled += sign;
    }
    countCache.set(change.next.world, counts);
  });
  const snapshot = (revisions?: CatalogRuntimePair['revisions']): OperationalGameSnapshot => {
    const pair = runtime.getSnapshot(), {world, simulation} = pair;
    const base = revisions ? versions.get(key(revisions)) : undefined;
    if (revisions && !base) throw Error('GAME_SNAPSHOT_EXPIRED');
    return {revisions: pair.revisions, world: {catalogRef: world.catalogRef, revision: world.revision, countriesById: world.countriesById,
      countryOrder: world.countryOrder, retiredCountryIds: [...world.retiredCountryIds]}, simulation,
      stateChange: base && base.world !== world ? createOperationalStateChange(base.world, world) : null,
      counts: controlCounts(world), canUndo: runtime.canUndo(), canRedo: runtime.canRedo(), report};
  };
  const expectedContext = (targetDate: string) => {
    const base = runtime.getSnapshot(), {world, simulation} = base;
    if (preparedContext?.base === base && preparedContext.targetDate === targetDate) return preparedContext;
    preparedContext = undefined;
    targetDateForCustomInput(simulation.currentDate, targetDate);
    const context = parseSimulationContextV1(buildSimulationContext({world, simulation, countrySearchProjection: createCountrySearchProjection(world),
      subdivisionCatalog: {listCountry: id => input.regionIndex.listCountry(id).slice(0, 128).map(r => ({ref: r.ref, parentCountryId: r.parentCountryId, nameKo: r.nameKo, nameEn: r.nameEn, materializable: false})), inspect: () => null, materialize: () => null},
      scenarioId: '2020-otl', scenarioStartDate: '2020-01-01', targetDate}));
    // Keep one private value; returned/request contexts cannot mutate the expected comparison.
    preparedContext = Object.freeze({base, targetDate, turnId: `turn.${simulation.turnNumber + 1}.${simulation.revision}`, canonical: canonicalStringify(context)});
    return preparedContext;
  };
  const assertRevisions = (expected: CatalogRuntimePair['revisions']) => {
    if (key(expected) !== key(runtime.getSnapshot().revisions)) throw Error('STALE_REVISION_PAIR');
  };
  const command = (command: Exclude<OperationalGameCommand, {operation: 'start'}>) => {
    if (command.operation === 'read') return {snapshot: snapshot(command.revisions)};
    if (busy) throw Error('TURN_IN_PROGRESS');
    assertRevisions(command.revisions);
    const base = runtime.getSnapshot();
    if (command.operation === 'prepare-turn') {
      const expected = expectedContext(command.targetDate);
      return {turnId: expected.turnId, context: JSON.parse(expected.canonical) as SimulationContextV1};
    }
    switch (command.operation) {
      case 'select-player': runtime.selectPlayer(command.countryId); break;
      case 'queue': runtime.replacePendingActions(queuePlayerAction(base.simulation.queuedActions, {actionId: input.actionId(), playerCountryId: base.simulation.playerCountryId, submittedAtDate: base.simulation.currentDate, text: command.text})); break;
      case 'cancel-action': runtime.replacePendingActions(cancelQueuedPlayerAction(base.simulation.queuedActions, command.actionId, base.simulation.playerCountryId)); break;
      case 'undo': runtime.undo(); report = null; break;
      case 'redo': runtime.redo(); report = null; break;
      case 'restart': {
        const player = base.simulation.playerCountryId;
        runtime.restart(); runtime.selectPlayer(player); versions.clear(); remember(); report = null; break;
      }
    }
    // Restart can reuse revision zero. Its response still compares the captured pair.
    const next = snapshot();
    return {snapshot: {...next, stateChange: base.world !== runtime.getSnapshot().world ? createOperationalStateChange(base.world, runtime.getSnapshot().world) : null}};
  };
  const resolveRequest = (request: SimulationProviderRequest) => {
    if (busy) throw Error('TURN_IN_PROGRESS');
    const base = runtime.getSnapshot();
    if (request.turnId !== `turn.${base.simulation.turnNumber + 1}.${base.simulation.revision}`) throw Error('STALE_STATE');
    const submitted = canonicalStringify(request.context), expected = expectedContext(request.context.period.endDate);
    if (expected.base !== base || expected.turnId !== request.turnId || runtime.getSnapshot() !== base || submitted !== expected.canonical) throw Error('STALE_STATE');
    return base.world;
  };
  const provider = (source: SimulationModelProvider): SimulationModelProvider => ({
    async *streamTurn(request, signal) {
      signal.throwIfAborted();
      resolveRequest(request);
      busy = true;
      const base = runtime.getSnapshot();
      try {
        for await (const event of source.streamTurn({...request, operationalWorld: base.world,
          operationalTerritorialAuthorities: base.simulation.territorialControlAuthorityOrder.map(id => base.simulation.territorialControlAuthoritiesById[id])}, signal)) {
          signal.throwIfAborted();
          if (event.type === 'resolution.ready') {
            if (runtime.getSnapshot() !== base) throw Error('STALE_STATE');
            const plan = createCatalogTurnPlan({...base, turnId: request.turnId, resolution: event.resolution, catalog: input.catalog, regionIndex: input.regionIndex,
              frontier: {world: base.world, resolve: input.frontier}});
            const nextReport = createCommittedTurnReport(plan);
            runtime.commit(plan); report = nextReport;
          }
          yield event;
          if (['resolution.ready', 'turn.failed', 'turn.cancelled'].includes(event.type)) return;
        }
      } finally {busy = false;}
    },
  });
  return {runtime, snapshot, command, resolveRequest, provider, isBusy: () => busy};
}
export type OperationalGameSession = ReturnType<typeof createOperationalGameSession>;
