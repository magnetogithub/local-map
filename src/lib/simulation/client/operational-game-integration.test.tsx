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
import {OPERATIONAL_GAME_HEADER, operationalGameCommandSchema} from '../operational-game-protocol';
import {prepareOperationalMapUpdate, createOperationalMapProjection} from '../../projection/operational-map-projection';
import type {SimulationProviderRequest, SimulationModelProvider} from '../server/simulation-provider';
import type {OperationalFrontierRequest} from '../operational-frontier-contract';
import {validateResolutionAgainstContext} from '../server/context-resolution-validator';

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
