import {createStore} from 'zustand/vanilla';
import type {WorldStateV3} from '../../world/world-state-v3';
import {createTerritoryEntityV3} from '../../world/territory-entity-v3';
import {createImmutableReadonlySet} from '../../world/immutable-readonly-set';
import type {TerritoryId} from '../../world/territory-id';
import {assertWorldGeometryCatalogRefMatches} from '../../world/world-geometry-catalog-ref';
import type {OperationalClientCommand, OperationalGameCommand, OperationalGameSnapshot, OperationalGameStart} from '../operational-game-protocol';
import type {SimulationContextV1} from '../simulation-context';

export async function gameRequest<T>(command: OperationalGameCommand, signal?: AbortSignal): Promise<T> {
  const response = await fetch('/api/simulation/game', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(command), signal});
  const result = await response.json();
  if (!response.ok) throw Error(result.error?.code ?? `HTTP_${response.status}`);
  return result as T;
}

/** Browser mirror. Only server commands can change the authoritative runtime. */
export function createOperationalGameClient(start: OperationalGameStart, cellIds: readonly TerritoryId[]) {
  const territories: Record<string, ReturnType<typeof createTerritoryEntityV3>> = {};
  let offset = 0;
  for (const [count, sourceCountryId, ownerCountryId, controllerCountryId] of start.runs) {
    if (!Number.isSafeInteger(count) || count <= 0 || offset + count > cellIds.length) throw Error('INVALID_GAME_SEED');
    for (let i = 0; i < count; i++) {
      const id = cellIds[offset++];
      if (Object.hasOwn(territories, id)) throw Error('DUPLICATE_GAME_CELL');
      territories[id] = createTerritoryEntityV3({id, sourceCountryId, ownerCountryId, controllerCountryId});
    }
  }
  if (offset !== cellIds.length) throw Error('INVALID_GAME_SEED');
  const world: WorldStateV3 = Object.freeze({...start.snapshot.world, schemaVersion: 3, seedVersion: start.seedVersion, policyVersion: start.policyVersion,
    territoryOrder: Object.freeze([...cellIds]), territoriesById: Object.freeze(territories), retiredCountryIds: createImmutableReadonlySet(start.snapshot.world.retiredCountryIds)});
  const store = createStore(() => ({...start.snapshot, world, generation: 0}));
  const apply = (next: OperationalGameSnapshot, reset = false) => {
    const before = store.getState();
    assertWorldGeometryCatalogRefMatches(next.world.catalogRef, before.world.catalogRef);
    if (next.revisions.worldRevision !== next.world.revision || next.revisions.simulationRevision !== next.simulation.revision) throw Error('INVALID_GAME_REVISIONS');
    let world = before.world;
    if (next.stateChange || next.world.revision !== world.revision) {
      const delta = next.stateChange;
      if (!delta || delta.baseWorldRevision !== world.revision || delta.worldRevision !== next.world.revision) throw Error('STALE_GAME_DELTA');
      const changed = new Set<string>(), cells = {...world.territoriesById};
      for (const c of delta.cells) {
        const old = cells[c.id];
        if (changed.has(c.id) || !old || old.id !== c.before.id || old.sourceCountryId !== c.before.sourceCountryId || old.ownerCountryId !== c.before.ownerCountryId || old.controllerCountryId !== c.before.controllerCountryId || old.sourceCountryId !== c.after.sourceCountryId || c.id !== c.after.id) throw Error('INVALID_GAME_DELTA');
        changed.add(c.id); cells[c.id] = createTerritoryEntityV3(c.after);
      }
      world = Object.freeze({...world, ...next.world, territoriesById: delta.cells.length ? Object.freeze(cells) : world.territoriesById,
        retiredCountryIds: createImmutableReadonlySet(next.world.retiredCountryIds)});
    }
    store.setState({...next, world, generation: before.generation + (reset ? 1 : 0)}, true);
  };
  let pending = false;
  const request = async (command: OperationalClientCommand) => {
    if (pending) throw Error('GAME_COMMAND_IN_PROGRESS');
    pending = true;
    try {
      const result = await gameRequest<{snapshot?: OperationalGameSnapshot; turnId?: string; context?: SimulationContextV1}>({...command, sessionId: start.sessionId, revisions: store.getState().revisions} as OperationalGameCommand);
      if (result.snapshot) apply(result.snapshot, command.operation === 'restart');
      return result;
    } finally {pending = false;}
  };
  return {store, sessionId: start.sessionId, presentation: start.presentation, getSnapshot: store.getState, request,
    read: async () => {const result = await gameRequest<{snapshot: OperationalGameSnapshot}>({operation: 'read', sessionId: start.sessionId, revisions: store.getState().revisions}); apply(result.snapshot); return store.getState();}};
}
export type OperationalGameClient = ReturnType<typeof createOperationalGameClient>;
