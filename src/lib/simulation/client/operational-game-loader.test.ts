import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

import {createOperationalGameLoader} from './operational-game-loader';
import type {OperationalGameStart} from '../operational-game-protocol';
import {OPERATIONAL_GAME_HEADER} from '../operational-game-protocol';
import {createSimulationStateV2} from '../simulation-state-v2';
import {createWorldStateV3} from '../../world/world-state-v3';
import {createWorldGeometryCatalogContract, readCatalogTerritoryId} from '../../world/world-geometry-catalog-ref';

const sessionA = '757c2206-552c-4e0e-99b4-816d841ec403';
const sessionB = '757c2206-552c-4e0e-99b4-816d841ec404';
const cellId = readCatalogTerritoryId(`territory:catalog:${'1'.repeat(64)}`);
const catalog = createWorldGeometryCatalogContract({
  ref: {catalogVersion: 'loader-fixture-v1', geometryRoot: '1'.repeat(64), topologyRoot: '2'.repeat(64),
    renderArtifactRoot: '3'.repeat(64), manifestPath: '/data/territory-catalog/loader-fixture-v1/manifest.json'},
  territoryOrder: [cellId], territoriesById: {[cellId]: {id: cellId, sourceCountryId: 'AAA'}},
});
const world = createWorldStateV3({
  schemaVersion: 3, seedVersion: 'loader-seed', policyVersion: 'loader-policy', revision: 0,
  countriesById: {AAA: {id: 'AAA', names: {shortKo: 'AAA', officialKo: 'AAA', mapKo: 'AAA', english: 'AAA', searchAliases: []},
    politicalStatus: 'sovereign', presentationOverride: null, moduleVersions: {core: 1, names: 1}, mapColor: '#334455'}},
  countryOrder: ['AAA'], retiredCountryIds: new Set(), catalogRef: catalog.ref, territoryOrder: [cellId],
  territoriesById: {[cellId]: {id: cellId, sourceCountryId: 'AAA', ownerCountryId: 'AAA', controllerCountryId: 'AAA'}},
}, catalog);
const simulation = createSimulationStateV2({
  schemaVersion: 2, revision: 0, currentDate: '2020-01-01', turnNumber: 0, playerCountryId: 'AAA', queuedActions: [],
  factsById: {}, factOrder: [], situationsById: {}, situationOrder: [], scheduledConsequences: [], eventLog: [],
  history: {lastCommittedTurnId: null, committedTurnCount: 0}, territorialControlAuthoritiesById: {},
  territorialControlAuthorityOrder: [], countryPresentationAuthoritiesById: {}, countryPresentationAuthorityOrder: [],
}, world);
const startPayload = (sessionId = sessionA): OperationalGameStart => ({
  sessionId, seedVersion: world.seedVersion, policyVersion: world.policyVersion, runs: [[1, 'AAA', 'AAA', 'AAA']], presentation: [],
  snapshot: {revisions: {worldRevision: 0, simulationRevision: 0}, world: {
    catalogRef: world.catalogRef, revision: 0, countriesById: world.countriesById, countryOrder: world.countryOrder, retiredCountryIds: [],
  }, simulation, stateChange: null, counts: {AAA: {owned: 1, controlled: 1, occupied: 0}}, canUndo: false, canRedo: false, report: null},
});

function deferred<Value>() {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>(done => {resolve = done;});
  return {promise, resolve};
}

const cellsResponse = () => Response.json({catalogRef: catalog.ref, cellIds: [cellId]});
const startResponse = (id = sessionA) => Response.json(startPayload(id));
type Acquire = ReturnType<typeof createOperationalGameLoader>;
type Lease = ReturnType<Acquire>;
let leases: Lease[];
function acquireLease(acquire: Acquire) {
  const lease = acquire();
  // Released consumers still observe their shared initialization rejection.
  void lease.ready.catch(() => {});
  leases.push(lease);
  return lease;
}

function installFetch(starts: (Response | Promise<Response>)[], cells: (Response | Promise<Response>)[]) {
  let startIndex = 0, cellIndex = 0;
  const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    if (url === '/api/simulation/game' && init?.method === 'DELETE') return new Response(null, {status: 204});
    if (url === '/api/simulation/game' && JSON.parse(String(init?.body)).operation === 'start') {
      const response = starts[startIndex++];
      if (!response) throw Error('UNEXPECTED_START');
      return response;
    }
    if (url === '/api/world/catalog/operational/cells') {
      const response = cells[cellIndex++];
      if (!response) throw Error('UNEXPECTED_CELLS');
      return response;
    }
    throw Error(`UNEXPECTED_FETCH: ${String(url)}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  return {
    fetchMock,
    starts: () => fetchMock.mock.calls.filter(([url, init]) => url === '/api/simulation/game' && init?.method === 'POST'),
    deletes: () => fetchMock.mock.calls.filter(([, init]) => init?.method === 'DELETE')
      .map(([, init]) => new Headers(init?.headers).get(OPERATIONAL_GAME_HEADER)),
    cellSignal: () => fetchMock.mock.calls.find(([url]) => url === '/api/world/catalog/operational/cells')?.[1]?.signal,
  };
}

function pageHide(persisted = false) {
  const event = new Event('pagehide');
  Object.defineProperty(event, 'persisted', {value: persisted});
  window.dispatchEvent(event);
}

beforeEach(() => {vi.useFakeTimers(); leases = [];});
afterEach(async () => {
  pageHide(false);
  leases.forEach(lease => lease.release());
  await vi.runOnlyPendingTimersAsync();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('F05 operational initialization ownership', () => {
  it('closes a known session when cells fail and starts a clean initialization next time', async () => {
    const network = installFetch([startResponse(), startResponse(sessionB)], [new Response(null, {status: 503}), cellsResponse()]);
    const acquire = createOperationalGameLoader();
    await expect(acquireLease(acquire).ready).rejects.toThrow('CATALOG_NOT_READY');
    await vi.advanceTimersByTimeAsync(0);
    expect(network.deletes()).toEqual([sessionA]);
    const next = await acquireLease(acquire).ready;
    expect(next.sessionId).toBe(sessionB);
    expect(next.getSnapshot().world.territoryOrder).toEqual([cellId]);
    expect(network.starts()).toHaveLength(2);
  });

  it('observes a late start response after cells failure and deletes its allocated session', async () => {
    const lateStart = deferred<Response>();
    const network = installFetch([lateStart.promise], [new Response(null, {status: 503})]);
    await expect(acquireLease(createOperationalGameLoader()).ready).rejects.toThrow('CATALOG_NOT_READY');
    expect(network.deletes()).toEqual([]);
    expect(network.starts()[0][1]?.signal?.aborted ?? false).toBe(false);
    lateStart.resolve(startResponse());
    await vi.advanceTimersByTimeAsync(0);
    expect(network.deletes()).toEqual([sessionA]);
  });

  it.each(['catalog', 'client'] as const)('closes an allocated session on %s validation failure', async failure => {
    const start = startPayload();
    const cellResponse = failure === 'catalog'
      ? Response.json({catalogRef: {...catalog.ref, geometryRoot: 'f'.repeat(64)}, cellIds: [cellId]})
      : cellsResponse();
    const invalidStart = failure === 'client' ? {...start, runs: [[2, 'AAA', 'AAA', 'AAA']]} : start;
    const network = installFetch([Response.json(invalidStart)], [cellResponse]);
    await expect(acquireLease(createOperationalGameLoader()).ready).rejects.toBeInstanceOf(Error);
    await vi.advanceTimersByTimeAsync(0);
    expect(network.deletes()).toEqual([sessionA]);
  });

  it('abandons the last pending lease, aborts only cells, and closes a later start exactly once', async () => {
    const start = deferred<Response>(), cells = deferred<Response>();
    const network = installFetch([start.promise], [cells.promise]);
    const lease = acquireLease(createOperationalGameLoader());
    lease.release(); lease.release();
    await vi.advanceTimersByTimeAsync(0);
    expect(network.cellSignal()?.aborted).toBe(true);
    expect(network.starts()[0][1]?.signal?.aborted ?? false).toBe(false);
    start.resolve(startResponse()); cells.resolve(cellsResponse());
    await expect(lease.ready).rejects.toMatchObject({name: 'AbortError'});
    await vi.advanceTimersByTimeAsync(0);
    pageHide(false);
    expect(network.deletes()).toEqual([sessionA]);
  });

  it('reuses pending initialization during StrictMode cleanup and immediate reacquisition', async () => {
    const start = deferred<Response>(), cells = deferred<Response>();
    const network = installFetch([start.promise], [cells.promise]);
    const acquire = createOperationalGameLoader(), first = acquireLease(acquire);
    first.release();
    const remounted = acquireLease(acquire);
    await vi.advanceTimersByTimeAsync(0);
    expect(network.cellSignal()?.aborted).toBe(false);
    start.resolve(startResponse()); cells.resolve(cellsResponse());
    const client = await remounted.ready;
    expect(client.sessionId).toBe(sessionA);
    expect(network.starts()).toHaveLength(1);
    expect(network.deletes()).toEqual([]);
  });

  it('keeps initialization alive while another consumer still owns it', async () => {
    const start = deferred<Response>(), cells = deferred<Response>();
    const network = installFetch([start.promise], [cells.promise]);
    const acquire = createOperationalGameLoader(), first = acquireLease(acquire), second = acquireLease(acquire);
    first.release();
    await vi.advanceTimersByTimeAsync(0);
    expect(network.cellSignal()?.aborted).toBe(false);
    start.resolve(startResponse()); cells.resolve(cellsResponse());
    expect((await second.ready).sessionId).toBe(sessionA);
    expect(network.starts()).toHaveLength(1);
    expect(network.deletes()).toEqual([]);
  });

  it('preserves a ready client across a route handoff longer than a cleanup task', async () => {
    const network = installFetch([startResponse()], [cellsResponse()]);
    const acquire = createOperationalGameLoader(), setup = acquireLease(acquire);
    const client = await setup.ready;
    setup.release();
    await vi.advanceTimersByTimeAsync(60_000);
    const game = acquireLease(acquire);
    expect(await game.ready).toBe(client);
    expect(network.starts()).toHaveLength(1);
    expect(network.deletes()).toEqual([]);
  });

  it('keeps a ready session for bfcache but closes it once on a non-persisted pagehide', async () => {
    const network = installFetch([startResponse(), startResponse(sessionB)], [cellsResponse(), cellsResponse()]);
    const acquire = createOperationalGameLoader(), first = acquireLease(acquire);
    const client = await first.ready;
    pageHide(true);
    expect(network.deletes()).toEqual([]);
    expect(await acquireLease(acquire).ready).toBe(client);
    pageHide(false); pageHide(false);
    expect(network.deletes()).toEqual([sessionA]);
    const replacement = await acquireLease(acquire).ready;
    expect(replacement.sessionId).toBe(sessionB);
    expect(network.starts()).toHaveLength(2);
  });

  it('handles pagehide before a session ID exists and closes the late allocation', async () => {
    const start = deferred<Response>(), cells = deferred<Response>();
    const network = installFetch([start.promise], [cells.promise]);
    const lease = acquireLease(createOperationalGameLoader());
    pageHide(false); pageHide(false);
    start.resolve(startResponse()); cells.resolve(cellsResponse());
    await expect(lease.ready).rejects.toMatchObject({name: 'AbortError'});
    await vi.advanceTimersByTimeAsync(0);
    expect(network.deletes()).toEqual([sessionA]);
  });

  it('does not clear a replacement entry when an abandoned start completes late', async () => {
    const oldStart = deferred<Response>();
    const network = installFetch([oldStart.promise, startResponse(sessionB)], [new Response(null, {status: 503}), cellsResponse()]);
    const acquire = createOperationalGameLoader();
    await expect(acquireLease(acquire).ready).rejects.toThrow('CATALOG_NOT_READY');
    const replacement = await acquireLease(acquire).ready;
    oldStart.resolve(startResponse());
    await vi.advanceTimersByTimeAsync(0);
    expect(network.deletes()).toEqual([sessionA]);
    expect(await acquireLease(acquire).ready).toBe(replacement);
    expect(network.starts()).toHaveLength(2);
  });

  it('does not issue DELETE when start itself failed without an allocated session ID', async () => {
    const cells = deferred<Response>();
    const network = installFetch([Response.json({error: {code: 'START_FAILED'}}, {status: 503})], [cells.promise]);
    await expect(acquireLease(createOperationalGameLoader()).ready).rejects.toThrow('START_FAILED');
    expect(network.deletes()).toEqual([]);
    expect(network.cellSignal()?.aborted).toBe(true);
    cells.resolve(cellsResponse());
  });
});
