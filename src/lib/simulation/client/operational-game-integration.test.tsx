import {afterEach, describe, expect, it, vi} from 'vitest';
import {act, renderHook, waitFor} from '@testing-library/react';
import {createOperationalGameSession} from '../server/operational-game-session';
import {createSimulationTurnPost} from '../server/simulation-turn-handler';
import {createWorldStateV3} from '../../world/world-state-v3';
import {createWorldGeometryCatalogContract, readCatalogTerritoryId} from '../../world/world-geometry-catalog-ref';
import {OPERATIONAL_CATALOG_VERSION, type OperationalWorldView} from '../../world/operational-catalog';
import {createSimulationStateV2} from '../simulation-state-v2';
import {createCatalogRegionIndex} from '../catalog-region';
import {parseTurnResolutionV1} from '../turn-resolution';
import {createOperationalGameClient} from './operational-game-client';
import {useOperationalTurnController} from './use-operational-turn-controller';
import {OPERATIONAL_GAME_HEADER, operationalGameCommandSchema, type OperationalGameSnapshot} from '../operational-game-protocol';
import {prepareOperationalMapUpdate, createOperationalMapProjection} from '../../projection/operational-map-projection';
import type {SimulationProviderRequest, SimulationModelProvider} from '../server/simulation-provider';
import type {OperationalFrontierRequest} from '../operational-frontier-contract';
import {validateResolutionAgainstContext} from '../server/context-resolution-validator';
import {activePlayerActionCount, type QueuedPlayerActionV1} from '../queued-player-action';
import * as simulationContext from '../simulation-context';

const sessionId = '757c2206-552c-4e0e-99b4-816d841ec403';
function fixture() {
  const ids = Array.from({length: 6}, (_, i) => readCatalogTerritoryId(`territory:catalog:${(i + 1).toString(16).padStart(64, '0')}`));
  const catalog = createWorldGeometryCatalogContract({ref: {catalogVersion: OPERATIONAL_CATALOG_VERSION, geometryRoot: '1'.repeat(64), topologyRoot: '2'.repeat(64), renderArtifactRoot: '3'.repeat(64), manifestPath: `/data/territory-catalog/${OPERATIONAL_CATALOG_VERSION}/manifest.json`},
    territoryOrder: ids, territoriesById: Object.fromEntries(ids.map((id, i) => [id, {id, sourceCountryId: i ? 'BBB' : 'AAA'}]))});
  const countries = ['AAA', 'BBB'].map((id, i) => ({id, names: {shortKo: id, officialKo: id, mapKo: id, english: id, searchAliases: []}, politicalStatus: 'sovereign', presentationOverride: null, moduleVersions: {core: 1}, mapColor: i ? '#CC0000' : '#00CC00'}));
  const world = createWorldStateV3({schemaVersion: 3, seedVersion: 'seed', policyVersion: 'policy', revision: 0, countriesById: Object.fromEntries(countries.map(c => [c.id, c])), countryOrder: ['AAA', 'BBB'], retiredCountryIds: new Set(), catalogRef: catalog.ref,
    territoryOrder: ids, territoriesById: Object.fromEntries(ids.map((id, i) => [id, {id, sourceCountryId: i ? 'BBB' : 'AAA', ownerCountryId: i ? 'BBB' : 'AAA', controllerCountryId: i ? 'BBB' : 'AAA'}]))}, catalog);
  const ground = {eventId: 'event.ground', date: '2020-01-01', title: '기존 분쟁', publicNarrative: '기존 분쟁', actorCountryIds: ['AAA', 'BBB'], relatedFactIds: [], relatedSituationIds: [], causes: [], outcomeCategory: 'military', significance: 'notable'};
  const authority = {id: 'tca:fixture', actorCountryId: 'AAA', targetCountryId: 'BBB', allowedOperations: ['occupy'], allowedTerritoryIds: ids.slice(1), validFrom: '2020-01-01', validTo: null, sourceEventId: ground.eventId};
  const simulation = createSimulationStateV2({schemaVersion: 2, revision: 0, currentDate: '2020-01-01', turnNumber: 0, playerCountryId: 'AAA', queuedActions: [], factsById: {}, factOrder: [], situationsById: {}, situationOrder: [], scheduledConsequences: [], eventLog: [ground], history: {lastCommittedTurnId: null, committedTurnCount: 0}, territorialControlAuthoritiesById: {[authority.id]: authority}, territorialControlAuthorityOrder: [authority.id], countryPresentationAuthoritiesById: {}, countryPresentationAuthorityOrder: []}, world);
  const seed = {world, simulation, revisions: {worldRevision: 0, simulationRevision: 0}};
  const frontier = (current: OperationalWorldView, scope: OperationalFrontierRequest) => ({catalogRef: catalog.ref, baseWorldRevision: current.revision, actorCountryId: scope.actorCountryId, targetCountryId: scope.targetCountryId, operation: scope.operation,
    cellIds: [ids.find(id => current.territoriesById[id].controllerCountryId === 'BBB')!]});
  let sequence = 0;
  // Real operational residual identities exceed the old 64-character event-ID bound.
  const region = {ref: {catalogId: catalog.ref.catalogVersion, sourceVersion: catalog.ref.geometryRoot, subdivisionId: `region:residual:BBB:${'a'.repeat(96)}`},
    parentCountryId: 'BBB', nameKo: '잔여 영토', nameEn: 'Residual territory', aliases: [], territoryIds: ids.slice(1), provenanceIds: ['residual:test']};
  const session = createOperationalGameSession({seed, catalog, regionIndex: createCatalogRegionIndex([region], ids, catalog.ref), frontier, actionId: () => `action.${++sequence}`});
  const client = createOperationalGameClient({sessionId, snapshot: session.snapshot(), seedVersion: 'seed', policyVersion: 'policy', runs: [[1, 'AAA', 'AAA', 'AAA'], [5, 'BBB', 'BBB', 'BBB']], presentation: []}, ids);
  const resolution = (request: SimulationProviderRequest) => {
    const scope = {catalogRef: catalog.ref, baseWorldRevision: request.context.revisions.world, actorCountryId: 'AAA', targetCountryId: 'BBB', operation: 'occupy' as const, extent: 'near' as const, cap: 512};
    const selected = frontier(session.runtime.getSnapshot().world, scope), eventId = `event.${request.context.revisions.simulation}`;
    return parseTurnResolutionV1({contractVersion: 'turn-resolution.v1', baseSimulationRevision: request.context.revisions.simulation, baseWorldRevision: request.context.revisions.world, period: request.context.period,
      playerActionOutcomes: request.context.queuedActions.map(a => ({outcomeId: `outcome.${a.actionId}`, actionId: a.actionId, status: 'succeeded', evidenceEventId: eventId, summary: '부분 점령', remainingConditions: []})),
      events: [{...ground, eventId, date: request.context.period.endDate, causes: [{kind: 'authoritative-event', id: ground.eventId}]}], factMutations: [], situationMutations: [], scheduledConsequences: [],
      worldEffects: [{effectId: `effect.${eventId}`, causedByEventId: eventId, type: 'territory.occupy', actorCountryId: 'AAA', targetCountryId: 'BBB', authorityId: authority.id, territoryIds: selected.cellIds, regionRefs: null, frontierScope: scope}], advisorSummary: '부분 점령 반영', unresolvedQuestions: []});
  };
  let source: SimulationModelProvider = {async *streamTurn(request) {yield {type: 'resolution.ready', resolution: resolution(request)};}};
  const post = createSimulationTurnPost({resolveOperationalWorld: session.resolveRequest, createProvider: () => session.provider(source)});
  let disconnect = false;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    if (url === '/api/simulation/game') {
      try {return Response.json(session.command(operationalGameCommandSchema.parse(JSON.parse(String(init.body))) as Exclude<ReturnType<typeof operationalGameCommandSchema.parse>, {operation: 'start'}>));}
      catch (error) {return Response.json({error: {code: (error as Error).message}}, {status: 409});}
    }
    expect(new Headers(init.headers).get(OPERATIONAL_GAME_HEADER)).toBe(sessionId);
    const result = await post(new Request('http://localhost/api/simulation/turn', init));
    if (disconnect) {await result.text(); throw Error('DISCONNECTED');}
    return result;
  }));
  return {client, session, ids, catalog, post, resolution, frontier, setSource: (next: SimulationModelProvider) => {source = next;}, disconnect: () => {disconnect = true;}};
}
afterEach(() => {vi.unstubAllGlobals(); vi.restoreAllMocks();});

describe('18 client mirror metadata updates', () => {
  it('applies an empty cell delta without enumerating the frozen territory dictionary', async () => {
    const f = fixture(), before = f.client.getSnapshot();
    const enumerate = vi.fn(() => Reflect.ownKeys(before.world.territoriesById));
    const cells = new Proxy(before.world.territoriesById, {ownKeys: enumerate});
    f.client.store.setState({...before, world: Object.freeze({...before.world, territoriesById: cells})}, true);
    const wire = f.session.snapshot();
    const next: OperationalGameSnapshot = {...wire,
      world: {...wire.world, revision: 1, countriesById: {...wire.world.countriesById,
        AAA: {...wire.world.countriesById.AAA, mapColor: '#ABCDEF'}}},
      revisions: {...wire.revisions, worldRevision: 1},
      stateChange: {catalogRef: f.catalog.ref, baseWorldRevision: 0, worldRevision: 1, cells: []},
    };
    vi.mocked(fetch).mockResolvedValueOnce(Response.json({snapshot: next}));
    await f.client.read();
    const after = f.client.getSnapshot();
    expect(enumerate).not.toHaveBeenCalled();
    expect(after.world.territoriesById).toBe(cells);
    expect(after.world.territoryOrder).toBe(before.world.territoryOrder);
    expect(after.world.revision).toBe(1);
    expect(after.world.countriesById.AAA.mapColor).toBe('#ABCDEF');
    expect(before.world.countriesById.AAA.mapColor).toBe('#00CC00');
    expect(Object.isFrozen(after.world)).toBe(true);
    expect(Object.isFrozen(after.world.territoriesById)).toBe(true);
  });

  it.each(['revision', 'delta'] as const)('rejects an empty delta with an invalid %s without publishing a partial snapshot', async failure => {
    const f = fixture(), before = f.client.getSnapshot(), wire = f.session.snapshot();
    const next: OperationalGameSnapshot = {...wire, world: {...wire.world, revision: 1},
      revisions: {...wire.revisions, worldRevision: failure === 'revision' ? 2 : 1},
      stateChange: {catalogRef: f.catalog.ref, baseWorldRevision: failure === 'delta' ? 1 : 0, worldRevision: 1, cells: []},
    };
    vi.mocked(fetch).mockResolvedValueOnce(Response.json({snapshot: next}));
    await expect(f.client.read()).rejects.toThrow(failure === 'revision' ? 'INVALID_GAME_REVISIONS' : 'STALE_GAME_DELTA');
    expect(f.client.getSnapshot()).toBe(before);
  });
});

describe('18 authoritative prepared context reuse', () => {
  const prepare = (f: ReturnType<typeof fixture>, targetDate = '2020-01-02'): SimulationProviderRequest => {
    const prepared = f.session.command({operation: 'prepare-turn', sessionId, revisions: f.session.runtime.getSnapshot().revisions, targetDate});
    if (!prepared.turnId || !prepared.context) throw Error('MISSING_PREPARED_CONTEXT');
    return {turnId: prepared.turnId, context: prepared.context};
  };
  const post = (f: ReturnType<typeof fixture>, request: SimulationProviderRequest) => f.post(new Request('http://localhost/api/simulation/turn', {
    method: 'POST', body: JSON.stringify(request),
  }));

  it('builds once across preparation, HTTP validation and provider validation', async () => {
    const f = fixture(), build = vi.spyOn(simulationContext, 'buildSimulationContext'), before = f.session.runtime.getSnapshot();
    const streamTurn = vi.fn(async function* () {yield {type: 'turn.cancelled' as const};});
    f.setSource({streamTurn});
    const request = prepare(f), response = await post(f, request);
    expect(response.status).toBe(200); expect(await response.text()).toContain('turn.cancelled');
    expect(streamTurn).toHaveBeenCalledOnce(); expect(build).toHaveBeenCalledOnce();
    expect(f.session.runtime.getSnapshot()).toBe(before); expect(f.session.isBusy()).toBe(false);
  });

  it('keeps its canonical expected value private when a returned context or submitted context is mutated', async () => {
    const f = fixture(), build = vi.spyOn(simulationContext, 'buildSimulationContext'), before = f.session.runtime.getSnapshot();
    const first = prepare(f), clean = prepare(f);
    expect(first.context.playerCountry).not.toBe(clean.context.playerCountry);
    Reflect.set(first.context.playerCountry, 'name', 'forged returned context');
    expect(() => f.session.resolveRequest(first)).toThrow('STALE_STATE');
    expect(f.session.resolveRequest(clean)).toBe(before.world);
    const streamTurn = vi.fn(async function* () {yield {type: 'turn.cancelled' as const};});
    f.setSource({streamTurn});
    const forged = {...clean, context: {...clean.context, playerCountry: {...clean.context.playerCountry, name: 'forged request'}}};
    const response = await post(f, forged);
    expect(response.status).toBe(409); expect(streamTurn).not.toHaveBeenCalled();
    expect(prepare(f).context.playerCountry.name).toBe('AAA');
    expect(build).toHaveBeenCalledOnce(); expect(f.session.runtime.getSnapshot()).toBe(before);
  });

  it('invalidates the cache when player selection replaces a pair without changing its revision numbers', () => {
    const f = fixture(), build = vi.spyOn(simulationContext, 'buildSimulationContext'), request = prepare(f);
    const before = f.session.runtime.getSnapshot();
    f.session.command({operation: 'select-player', sessionId, revisions: before.revisions, countryId: 'BBB'});
    expect(f.session.runtime.getSnapshot().revisions).toEqual(before.revisions);
    expect(f.session.runtime.getSnapshot()).not.toBe(before);
    expect(() => f.session.resolveRequest(request)).toThrow('STALE_STATE');
    expect(prepare(f).context.playerCountry.countryId).toBe('BBB'); expect(build).toHaveBeenCalledTimes(2);
  });

  it('rechecks the pair after HTTP validation before the provider starts', async () => {
    const f = fixture(), build = vi.spyOn(simulationContext, 'buildSimulationContext'), request = prepare(f);
    const streamTurn = vi.fn(async function* () {yield {type: 'turn.cancelled' as const};});
    const handler = createSimulationTurnPost({resolveOperationalWorld: f.session.resolveRequest, createProvider: () => {
      f.session.runtime.selectPlayer('BBB');
      return f.session.provider({streamTurn});
    }});
    const response = await handler(new Request('http://localhost/api/simulation/turn', {method: 'POST', body: JSON.stringify(request)}));
    expect(await response.text()).toContain('turn.failed'); expect(streamTurn).not.toHaveBeenCalled();
    expect(f.session.runtime.getHistory().entries).toHaveLength(0); expect(f.session.isBusy()).toBe(false);
    expect(build).toHaveBeenCalledTimes(2);
  });

  it('replaces its one slot for another valid target date and clears a failed preparation', () => {
    const f = fixture(), build = vi.spyOn(simulationContext, 'buildSimulationContext'), day = prepare(f);
    const week = prepare(f, '2020-01-08');
    expect(week.context.period.endDate).toBe('2020-01-08'); expect(build).toHaveBeenCalledTimes(2);
    expect(f.session.resolveRequest(day)).toBe(f.session.runtime.getSnapshot().world); expect(build).toHaveBeenCalledTimes(3);
    expect(() => prepare(f, '2020-01-01')).toThrow();
    prepare(f); expect(build).toHaveBeenCalledTimes(4);
  });

  it('rebuilds after queue changes, commit, undo, redo and restart', async () => {
    const f = fixture(), build = vi.spyOn(simulationContext, 'buildSimulationContext'), initial = prepare(f);
    f.session.command({operation: 'queue', sessionId, revisions: f.session.runtime.getSnapshot().revisions, text: '접경 점령'});
    const queued = prepare(f); expect(queued.context.queuedActions).toHaveLength(1); expect(build).toHaveBeenCalledTimes(2);
    expect(() => f.session.resolveRequest(initial)).toThrow('STALE_STATE');
    const provider = f.session.provider({async *streamTurn(request) {yield {type: 'resolution.ready', resolution: f.resolution(request)};}});
    for await (const event of provider.streamTurn(queued, new AbortController().signal)) expect(event.type).toBe('resolution.ready');
    expect(f.session.runtime.getHistory().entries).toHaveLength(1); expect(build).toHaveBeenCalledTimes(2);
    prepare(f, '2020-01-03'); expect(build).toHaveBeenCalledTimes(3);
    for (const [index, operation] of (['undo', 'redo', 'restart'] as const).entries()) {
      f.session.command({operation, sessionId, revisions: f.session.runtime.getSnapshot().revisions});
      const next = prepare(f, '2020-01-03'), current = f.session.runtime.getSnapshot();
      expect(next.context.revisions).toEqual({world: current.world.revision, simulation: current.simulation.revision});
      expect(next.context.period.startDate).toBe(current.simulation.currentDate); expect(build).toHaveBeenCalledTimes(index + 4);
    }
  });

  it.each(['failure', 'cancellation', 'exception'] as const)('reuses the current expected value after provider %s and commits a retry atomically', async outcome => {
    const f = fixture(), build = vi.spyOn(simulationContext, 'buildSimulationContext'), before = f.session.runtime.getSnapshot(), request = prepare(f);
    const failed = f.session.provider({async *streamTurn() {
      if (outcome === 'exception') throw Error('provider disconnected');
      if (outcome === 'failure') yield {type: 'turn.failed', code: 'PROVIDER_ERROR', message: 'retry', retryable: true};
      else yield {type: 'turn.cancelled'};
    }});
    const finish = async () => {for await (const event of failed.streamTurn(request, new AbortController().signal)) expect(event.type).toBe(outcome === 'failure' ? 'turn.failed' : 'turn.cancelled');};
    if (outcome === 'exception') await expect(finish()).rejects.toThrow('provider disconnected'); else await finish();
    expect(f.session.runtime.getSnapshot()).toBe(before); expect(f.session.isBusy()).toBe(false);
    const retry = prepare(f); expect(f.session.resolveRequest(retry)).toBe(before.world);
    const provider = f.session.provider({async *streamTurn(current) {yield {type: 'resolution.ready', resolution: f.resolution(current)};}});
    for await (const event of provider.streamTurn(retry, new AbortController().signal)) expect(event.type).toBe('resolution.ready');
    expect(build).toHaveBeenCalledOnce(); expect(f.session.runtime.getHistory().entries).toHaveLength(1);
    expect(f.session.runtime.getSnapshot().simulation.currentDate).toBe('2020-01-02'); expect(f.session.isBusy()).toBe(false);
  });
});

describe('F03 authoritative action admission and provider boundary', () => {
  const legacyActions = (count: number): QueuedPlayerActionV1[] => Array.from({length: count}, (_, i) => ({
    actionId: `legacy.${i}`, actorCountryId: 'AAA', submittedAtDate: '2020-01-01',
    text: `기존 행동 ${i}`, visibility: 'public', status: 'queued',
  }));

  it('rejects server action 33 before replacing the authoritative snapshot', () => {
    const f = fixture();
    f.session.runtime.replacePendingActions(legacyActions(32));
    const before = f.session.runtime.getSnapshot();
    expect(() => f.session.command({operation: 'queue', sessionId, revisions: before.revisions, text: '33번째 행동'}))
      .toThrowError(expect.objectContaining({code: 'ACTION_QUEUE_LIMIT_REACHED'}));
    expect(f.session.runtime.getSnapshot()).toBe(before);
    f.session.command({operation: 'cancel-action', sessionId, revisions: before.revisions, actionId: 'legacy.0'});
    f.session.command({operation: 'queue', sessionId, revisions: f.session.runtime.getSnapshot().revisions, text: '취소 후 등록'});
    expect(activePlayerActionCount(f.session.runtime.getSnapshot().simulation.queuedActions)).toBe(32);
  });

  it('rejects an oversized HTTP context before constructing any provider', async () => {
    const f = fixture(), prepared = await f.client.request({operation: 'prepare-turn', targetDate: '2020-01-02'});
    const createProvider = vi.fn(() => ({async *streamTurn() {yield {type: 'turn.cancelled' as const};}}));
    const post = createSimulationTurnPost({createProvider});
    const result = await post(new Request('http://localhost/api/simulation/turn', {method: 'POST',
      body: JSON.stringify({turnId: prepared.turnId, context: {...prepared.context, queuedActions: legacyActions(33).map(({status, ...a}) => {void status; return a;})}})}));
    expect(result.status).toBe(400);
    expect(createProvider).not.toHaveBeenCalled();
    expect(f.session.runtime.getSnapshot().simulation.turnNumber).toBe(0);
  });

  it.each([33, 128])('recovers a legacy queue of %i without provider work until cancellation reaches 32', async count => {
    const f = fixture(), prepared = await f.client.request({operation: 'prepare-turn', targetDate: '2020-01-02'});
    f.session.runtime.replacePendingActions(legacyActions(count));
    const before = f.session.runtime.getSnapshot();
    const streamTurn = vi.fn(async function* (request: SimulationProviderRequest) {
      yield {type: 'resolution.ready' as const, resolution: f.resolution(request)};
    });
    const provider = f.session.provider({streamTurn});
    expect(() => f.session.command({operation: 'prepare-turn', sessionId, revisions: before.revisions, targetDate: '2020-01-02'}))
      .toThrowError(expect.objectContaining({code: 'ACTION_QUEUE_LIMIT_REACHED'}));
    await expect(provider.streamTurn({turnId: prepared.turnId!, context: prepared.context!}, new AbortController().signal)[Symbol.asyncIterator]().next())
      .rejects.toMatchObject({code: 'ACTION_QUEUE_LIMIT_REACHED'});
    expect(streamTurn).not.toHaveBeenCalled();
    expect(f.session.runtime.getSnapshot()).toBe(before);
    expect(f.session.isBusy()).toBe(false);
    for (let i = 0; i < count - 32; i++) {
      f.session.command({operation: 'cancel-action', sessionId, revisions: f.session.runtime.getSnapshot().revisions, actionId: `legacy.${i}`});
    }
    const ready = f.session.command({operation: 'prepare-turn', sessionId, revisions: f.session.runtime.getSnapshot().revisions, targetDate: '2020-01-02'});
    expect(ready.context!.queuedActions).toHaveLength(32);
    for await (const event of provider.streamTurn({turnId: ready.turnId!, context: ready.context!}, new AbortController().signal)) {
      expect(event.type).toBe('resolution.ready');
    }
    expect(streamTurn).toHaveBeenCalledOnce();
    expect(f.session.runtime.getSnapshot().simulation.currentDate).toBe('2020-01-02');
    expect(activePlayerActionCount(f.session.runtime.getSnapshot().simulation.queuedActions)).toBe(0);
  });

  it('prevents direct client callbacks from submitting or advancing an oversized queue', async () => {
    const f = fixture();
    f.session.runtime.replacePendingActions(legacyActions(33));
    await f.client.read();
    const hook = renderHook(() => useOperationalTurnController(f.client));
    act(() => hook.result.current.setActionDraft('초과 등록'));
    expect(hook.result.current.canQueue).toBe(false);
    vi.mocked(fetch).mockClear();
    act(() => hook.result.current.queueAction());
    expect(fetch).not.toHaveBeenCalled();
    await act(async () => {await hook.result.current.advance('day');});
    expect(hook.result.current.turn.errorCode).toBe('ACTION_QUEUE_LIMIT_REACHED');
    const calls = vi.mocked(fetch).mock.calls;
    expect(calls.every(([url, init]) => url === '/api/simulation/game' && JSON.parse(String(init?.body)).operation === 'read')).toBe(true);
    expect(f.session.runtime.getSnapshot().simulation.currentDate).toBe('2020-01-01');
  });
});

function failCommand(operation: string, afterApply = false) {
  const transport = fetch;
  const operations: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    if (url === '/api/simulation/game') {
      const command = JSON.parse(String(init.body));
      operations.push(command.operation);
      if (command.operation === operation) {
        if (afterApply) {await transport(url, init); throw Error('DISCONNECTED');}
        return Response.json({error: {code: 'STALE_REVISION_PAIR'}}, {status: 409});
      }
    }
    return transport(url, init);
  }));
  return operations;
}

describe('17 F01 command failures and turn retry', () => {
  it.each(['queue', 'cancel-action', 'undo', 'redo'] as const)('reconciles a failed %s without retrying time advancement', async operation => {
    const f = fixture(), hook = renderHook(() => useOperationalTurnController(f.client));
    if (operation === 'cancel-action') await act(async () => {await f.client.request({operation: 'queue', text: '대기 행동'});});
    if (operation === 'undo' || operation === 'redo') await act(async () => {await hook.result.current.advance('day');});
    if (operation === 'redo') await act(async () => {await f.client.request({operation: 'undo'});});
    await act(async () => {hook.result.current.setActionDraft('새 행동');});
    const before = f.client.getSnapshot(), operations = failCommand(operation), read = vi.spyOn(f.client, 'read');
    await act(async () => {
      if (operation === 'queue') hook.result.current.queueAction();
      else if (operation === 'cancel-action') hook.result.current.cancelAction(hook.result.current.queuedActions[0].actionId);
      else hook.result.current[operation]();
    });
    await waitFor(() => expect(hook.result.current.running).toBe(false));
    expect(hook.result.current.turn).toMatchObject({phase: 'failed', failureSource: 'command', errorCode: 'STALE_REVISION_PAIR', turnId: null, resolution: null});
    expect(read).toHaveBeenCalledOnce();
    expect(f.client.getSnapshot().simulation).toEqual(before.simulation);
    expect(hook.result.current.actionDraft).toBe('새 행동');
    await act(async () => {await hook.result.current.retry();});
    expect(operations).toEqual([operation, 'read']);
    expect(hook.result.current.turn.phase).toBe('failed');
    expect(hook.result.current.canQueue).toBe(true);
  });

  it.each(['queue', 'cancel-action', 'undo', 'redo'] as const)('reads the applied %s after its response is lost without applying it twice', async operation => {
    const f = fixture(), hook = renderHook(() => useOperationalTurnController(f.client));
    if (operation === 'cancel-action') await act(async () => {await f.client.request({operation: 'queue', text: '대기 행동'});});
    if (operation === 'undo' || operation === 'redo') await act(async () => {await hook.result.current.advance('day');});
    if (operation === 'redo') await act(async () => {await f.client.request({operation: 'undo'});});
    await act(async () => {hook.result.current.setActionDraft('새 행동');});
    const before = f.client.getSnapshot(), operations = failCommand(operation, true);
    await act(async () => {
      if (operation === 'queue') hook.result.current.queueAction();
      else if (operation === 'cancel-action') hook.result.current.cancelAction(hook.result.current.queuedActions[0].actionId);
      else hook.result.current[operation]();
    });
    await waitFor(() => expect(hook.result.current.running).toBe(false));
    expect(hook.result.current.turn).toMatchObject({phase: 'failed', failureSource: 'command', errorCode: 'DISCONNECTED'});
    const reconciled = f.client.getSnapshot();
    expect(reconciled.simulation).toEqual(f.session.snapshot().simulation);
    expect(reconciled.simulation).not.toEqual(before.simulation);
    expect(reconciled.canUndo).toBe(f.session.snapshot().canUndo);
    expect(reconciled.canRedo).toBe(f.session.snapshot().canRedo);
    await act(async () => {await hook.result.current.retry();});
    expect(operations).toEqual([operation, 'read']);
    expect(f.client.getSnapshot()).toBe(reconciled);
    expect(f.session.runtime.getHistory().entries).toHaveLength(operation === 'undo' || operation === 'redo' ? 1 : 0);
  });

  it('keeps the command failure visible and releases the lock even when reconciliation also fails', async () => {
    const f = fixture(), hook = renderHook(() => useOperationalTurnController(f.client));
    await act(async () => {hook.result.current.setActionDraft('새 행동');});
    const before = f.client.getSnapshot(), operations = failCommand('queue');
    vi.spyOn(f.client, 'read').mockRejectedValueOnce(Error('READ_FAILED'));
    await act(async () => {hook.result.current.queueAction();});
    await waitFor(() => expect(hook.result.current.running).toBe(false));
    expect(hook.result.current.turn).toMatchObject({phase: 'failed', failureSource: 'command', errorCode: 'STALE_REVISION_PAIR'});
    await act(async () => {await hook.result.current.retry();});
    expect(operations).toEqual(['queue']);
    expect(f.client.getSnapshot()).toBe(before);
    expect(hook.result.current.canQueue).toBe(true);
  });

  it('invalidates an earlier turn retry while reconciling a command and blocks competing mutations', async () => {
    const f = fixture(), hook = renderHook(() => useOperationalTurnController(f.client));
    f.setSource({async *streamTurn() {throw Error('PROVIDER_ERROR');}});
    await act(async () => {await hook.result.current.advance('week');});
    expect(hook.result.current.turn.phase).toBe('failed');
    const oldRetry = hook.result.current.retry;
    await act(async () => {hook.result.current.setActionDraft('새 행동');});
    const operations = failCommand('queue'), read = f.client.read;
    let finishRead!: () => void;
    vi.spyOn(f.client, 'read').mockImplementationOnce(async () => {
      await new Promise<void>(resolve => {finishRead = resolve;});
      return read();
    });
    await act(async () => {hook.result.current.queueAction();});
    await waitFor(() => expect(finishRead).toBeDefined());
    expect(hook.result.current.running).toBe(true);
    await act(async () => {await oldRetry(); hook.result.current.undo(); hook.result.current.queueAction();});
    expect(operations).toEqual(['queue']);
    await act(async () => {finishRead();});
    await waitFor(() => expect(hook.result.current.running).toBe(false));
    await act(async () => {await oldRetry(); await hook.result.current.retry();});
    expect(operations).toEqual(['queue', 'read']);
    expect(hook.result.current.turn).toMatchObject({phase: 'failed', failureSource: 'command'});
  });

  it.each([
    {preset: 'week' as const, targetDate: '2020-01-08'},
    {preset: null, targetDate: '2020-02-29'},
  ])('retries the selected $targetDate after a turn failure and retires old retry handlers after commit', async ({preset, targetDate}) => {
    const f = fixture(), hook = renderHook(() => useOperationalTurnController(f.client));
    const transport = fetch, dates: string[] = [];
    let failTurn = true;
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      if (url === '/api/simulation/game') {
        const command = JSON.parse(String(init.body));
        if (command.operation === 'prepare-turn') dates.push(command.targetDate);
      } else if (failTurn) {
        failTurn = false;
        return Response.json({error: {code: 'TEMPORARY_FAILURE'}}, {status: 503});
      }
      return transport(url, init);
    }));
    await act(async () => {if (preset) await hook.result.current.advance(preset); else await hook.result.current.advanceToDate(targetDate);});
    expect(hook.result.current.turn).toMatchObject({phase: 'failed', failureSource: 'turn'});
    const retry = hook.result.current.retry;
    await act(async () => {await retry();});
    expect(dates).toEqual([targetDate, targetDate]);
    expect(hook.result.current.turn.phase).toBe('committed');
    expect(f.client.getSnapshot().simulation.currentDate).toBe(targetDate);
    await act(async () => {await retry();});
    expect(dates).toHaveLength(2);
    expect(f.session.runtime.getHistory().entries).toHaveLength(1);
  });

  it('keeps cancellation retry available with the selected duration and releases the controller lock', async () => {
    const f = fixture(), hook = renderHook(() => useOperationalTurnController(f.client));
    const transport = fetch;
    let waiting = false, cancelFirst = true;
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      if (url === '/api/simulation/turn' && cancelFirst) {
        cancelFirst = false;
        waiting = true;
        return new Promise<Response>((_, reject) => init.signal!.addEventListener('abort', () => reject(Error('CANCELLED')), {once: true}));
      }
      return transport(url, init);
    }));
    let advance!: Promise<void>;
    act(() => {advance = hook.result.current.advance('week');});
    await waitFor(() => expect(waiting).toBe(true));
    expect(hook.result.current.running).toBe(true);
    await act(async () => {hook.result.current.stop(); await advance;});
    expect(hook.result.current.turn.phase).toBe('cancelled');
    expect(hook.result.current.running).toBe(false);
    expect(f.client.getSnapshot().simulation.currentDate).toBe('2020-01-01');
    await act(async () => {await hook.result.current.retry();});
    expect(hook.result.current.turn.phase).toBe('committed');
    expect(f.client.getSnapshot().simulation.currentDate).toBe('2020-01-08');
    expect(f.session.runtime.getHistory().entries).toHaveLength(1);
  });
});

describe('16-08 actual game turn adapters', () => {
  it('queues through the UI controller, commits partial occupation, advances from current state and projects undo/redo deltas', async () => {
    const f = fixture(), hook = renderHook(() => useOperationalTurnController(f.client));
    await act(async () => {hook.result.current.setActionDraft('접경 일부 점령');});
    await act(async () => {hook.result.current.queueAction();});
    await waitFor(() => expect(hook.result.current.queuedActions).toHaveLength(1));
    const before = f.client.getSnapshot().world;
    await act(async () => {await hook.result.current.advance('day');});
    expect(hook.result.current.turn.phase).toBe('committed');
    expect(f.client.getSnapshot().simulation.currentDate).toBe('2020-01-02');
    expect(f.client.getSnapshot().world.territoriesById[f.ids[1]]).toMatchObject({ownerCountryId: 'BBB', controllerCountryId: 'AAA'});
    expect(f.client.getSnapshot().world.territoriesById[f.ids[2]]).toBe(before.territoriesById[f.ids[2]]);
    expect(f.client.getSnapshot().counts.BBB).toEqual({owned: 5, controlled: 4, occupied: 1});
    let projection = createOperationalMapProjection(before, f.catalog.ref, 6);
    projection = prepareOperationalMapUpdate(projection, f.client.getSnapshot().world, f.client.getSnapshot().stateChange!).projection;
    await act(async () => {await hook.result.current.advance('day');});
    expect(f.client.getSnapshot().world.territoriesById[f.ids[2]].controllerCountryId).toBe('AAA');
    projection = prepareOperationalMapUpdate(projection, f.client.getSnapshot().world, f.client.getSnapshot().stateChange!).projection;
    await act(async () => {hook.result.current.undo();});
    await waitFor(() => expect(f.client.getSnapshot().world.territoriesById[f.ids[2]].controllerCountryId).toBe('BBB'));
    projection = prepareOperationalMapUpdate(projection, f.client.getSnapshot().world, f.client.getSnapshot().stateChange!).projection;
    expect(f.client.getSnapshot().simulation.currentDate).toBe('2020-01-02');
    await act(async () => {hook.result.current.redo();});
    await waitFor(() => expect(f.client.getSnapshot().world.territoriesById[f.ids[2]].controllerCountryId).toBe('AAA'));
    projection = prepareOperationalMapUpdate(projection, f.client.getSnapshot().world, f.client.getSnapshot().stateChange!).projection;
    expect(projection.world.territoriesById).toEqual(f.session.runtime.getSnapshot().world.territoriesById);
    expect(projection.world.revision).toBe(f.session.runtime.getSnapshot().world.revision);
    expect(f.session.runtime.getHistory().entries).toHaveLength(2);
  });

  it('rejects spoofed context, stale commands and invalid IDs with no partial commit', async () => {
    const f = fixture(), prepared = await f.client.request({operation: 'prepare-turn', targetDate: '2020-01-02'});
    const before = f.session.runtime.getSnapshot();
    const response = await f.post(new Request('http://localhost/api/simulation/turn', {method: 'POST', body: JSON.stringify({turnId: prepared.turnId, context: {...prepared.context, playerCountry: {countryId: 'BBB', name: 'BBB'}}})}));
    expect(response.status).toBe(409);
    await f.client.request({operation: 'queue', text: '진격'});
    expect(() => f.session.command({operation: 'undo', sessionId, revisions: {...before.revisions, worldRevision: 1}})).toThrow('STALE_REVISION_PAIR');
    f.setSource({async *streamTurn(request) {const r = f.resolution(request); yield {type: 'resolution.ready', resolution: {...r, worldEffects: r.worldEffects.map(e => ({...e, territoryIds: [readCatalogTerritoryId(`territory:catalog:${'f'.repeat(64)}`)]}))} as typeof r};}});
    const hook = renderHook(() => useOperationalTurnController(f.client));
    const queued = f.session.runtime.getSnapshot();
    await act(async () => {await hook.result.current.advance('day');});
    expect(hook.result.current.turn.phase).toBe('failed');
    expect(hook.result.current.turn.errorCode).toBe('PROVIDER_ERROR');
    expect(f.session.runtime.getSnapshot()).toBe(queued);
    expect(f.session.runtime.getHistory().entries).toHaveLength(0);
    expect(f.client.getSnapshot().world.territoriesById[f.ids[1]].controllerCountryId).toBe('BBB');
  });

  it('recovers a response lost after commit without repeating the turn or losing its report', async () => {
    const f = fixture(); f.disconnect();
    const hook = renderHook(() => useOperationalTurnController(f.client));
    await act(async () => {await hook.result.current.advance('day');});
    expect(hook.result.current.turn.phase).toBe('committed');
    expect(hook.result.current.report?.mapChanges[0]).toContain('1개');
    expect(f.session.runtime.getHistory().entries).toHaveLength(1);
    expect(f.client.getSnapshot().world.territoriesById[f.ids[1]].controllerCountryId).toBe('AAA');
    await act(async () => {await f.client.request({operation: 'restart'});});
    expect(f.client.getSnapshot().generation).toBe(1);
    expect(f.client.getSnapshot().world.territoriesById[f.ids[1]].controllerCountryId).toBe('BBB');
    expect(f.client.getSnapshot().simulation.currentDate).toBe('2020-01-01');
    expect(f.client.getSnapshot().canUndo).toBe(false);
    await act(async () => {await f.client.request({operation: 'restart'});});
    expect(f.client.getSnapshot().generation).toBe(2);
  });

  it('blocks competing mutations during a provider turn and releases the game after cancellation', async () => {
    const f = fixture(), prepared = await f.client.request({operation: 'prepare-turn', targetDate: '2020-01-02'});
    const base = f.session.runtime.getSnapshot(), abort = new AbortController();
    const provider = f.session.provider({async *streamTurn(request, signal) {yield {type: 'phase.changed', phase: 'looking_up'}; signal.throwIfAborted(); yield {type: 'resolution.ready', resolution: f.resolution(request)};}});
    const iterator = provider.streamTurn({turnId: prepared.turnId!, context: prepared.context!}, abort.signal)[Symbol.asyncIterator]();
    await iterator.next();
    expect(f.session.isBusy()).toBe(true);
    expect(() => f.session.command({operation: 'undo', sessionId, revisions: base.revisions})).toThrow('TURN_IN_PROGRESS');
    expect(f.session.command({operation: 'read', sessionId, revisions: base.revisions}).snapshot?.revisions).toEqual(base.revisions);
    abort.abort();
    await expect(iterator.next()).rejects.toThrow();
    expect(f.session.isBusy()).toBe(false);
    expect(f.session.runtime.getSnapshot()).toBe(base);
    expect(f.session.runtime.getHistory().entries).toHaveLength(0);
  });

  it('validates complete host authority scopes when the model context has clipped their cell IDs', async () => {
    const f = fixture(), prepared = await f.client.request({operation: 'prepare-turn', targetDate: '2020-01-02'});
    const request = {turnId: prepared.turnId!, context: prepared.context!}, resolution = f.resolution(request);
    const full = request.context.territorialControlAuthorities!;
    const clipped = {...request.context, territorialControlAuthorities: full.map(a => ({...a, allowedTerritoryIds: []}))};
    const regionIndex = createCatalogRegionIndex([], f.ids, f.catalog.ref), frontier = {world: f.session.runtime.getSnapshot().world, resolve: f.frontier};
    expect(validateResolutionAgainstContext(resolution, clipped, {regionIndex, frontier}).ok).toBe(false);
    expect(validateResolutionAgainstContext(resolution, clipped, {regionIndex, frontier, territorialControlAuthorities: full}).ok).toBe(true);
    let supplied = false;
    const provider = f.session.provider({async *streamTurn(current) {supplied = current.operationalTerritorialAuthorities?.[0].allowedTerritoryIds.length === 5; yield {type: 'resolution.ready', resolution};}});
    for await (const event of provider.streamTurn(request, new AbortController().signal)) expect(event.type).toBe('resolution.ready');
    expect(supplied).toBe(true);
  });
});
