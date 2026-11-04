// @vitest-environment node
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import currentOperationalCatalog from '../../../../data/runtime/operational-catalog/current.json';
import type {OperationalGameSession} from './operational-game-session';

const checkpoints = vi.hoisted(() => ({capture: vi.fn(), write: vi.fn()}));
vi.mock('./operational-game-checkpoint', () => ({captureOperationalGamePreservation: checkpoints.capture, writeOperationalGameCheckpoint: checkpoints.write}));
type Pool = {catalogKey: string; catalogPointer?: typeof currentOperationalCatalog;
  sessions: Map<string, {session: OperationalGameSession; touched: number}>; maintenanceLocked?: boolean};
const host = globalThis as typeof globalThis & {__paxOperationalGamePool?: Pool; __paxOperationalGamePoolsV20?: Map<string, Pool>;
  __paxOperationalGamesV19?: Map<string, unknown>; __paxOperationalGames?: unknown};
const globals = ['__paxOperationalGamePool', '__paxOperationalGamePoolsV20', '__paxOperationalGamesV19', '__paxOperationalGames'] as const;
let originalGlobals: PropertyDescriptorMap;
beforeEach(() => {
  originalGlobals = Object.fromEntries(globals.flatMap(key => {const descriptor = Object.getOwnPropertyDescriptor(host, key); return descriptor ? [[key, descriptor]] : [];}));
  for (const key of globals) delete host[key];
  checkpoints.capture.mockImplementation(input => input);
  checkpoints.write.mockReturnValue({roundtripValidated: true, historyEntries: 2});
  vi.resetModules();
});
afterEach(() => {
  for (const key of globals) delete host[key];
  Object.defineProperties(host, originalGlobals); vi.resetAllMocks(); vi.resetModules();
});
const keyOf = (pointer: typeof currentOperationalCatalog) => `${pointer.catalogVersion}:${pointer.index.sha256}`;
function previousPool(busy = false) {
  const pointer = {...currentOperationalCatalog, catalogVersion: 'catalog-version-fixture-previous'};
  const session = {isBusy: () => busy} as OperationalGameSession;
  const pool: Pool = {catalogKey: keyOf(pointer), catalogPointer: pointer,
    sessions: new Map([['old-session', {session, touched: 1234}]])};
  host.__paxOperationalGamePool = pool;
  return {pool, session};
}

describe('operational game catalog version isolation with preservation', () => {
  it('reuses the same active sessions and objects across module reloads without checkpointing or clearing them', async () => {
    const {pool, session} = previousPool();
    pool.catalogKey = keyOf(currentOperationalCatalog); pool.catalogPointer = currentOperationalCatalog;
    await import('./operational-game.server'); vi.resetModules(); await import('./operational-game.server');
    expect(host.__paxOperationalGamePool).toBe(pool); expect(pool.sessions.get('old-session')?.session).toBe(session);
    expect(host.__paxOperationalGamePoolsV20?.get(pool.catalogKey)).toBe(pool);
    expect(checkpoints.write).not.toHaveBeenCalled();
  });

  it('checkpoints supported old sessions before activation, retains their original catalog, and never resolves them in the new pool', async () => {
    const {pool, session} = previousPool(), originalEntry = pool.sessions.get('old-session');
    checkpoints.write.mockImplementation(() => {
      expect(host.__paxOperationalGamePool).toBe(pool);
      expect(host.__paxOperationalGamePoolsV20?.has(keyOf(currentOperationalCatalog))).toBe(false);
      return {roundtripValidated: true, historyEntries: 2};
    });
    const server = await import('./operational-game.server');
    expect(checkpoints.capture).toHaveBeenCalledWith(expect.objectContaining({sessionId: 'old-session', session,
      catalogKey: pool.catalogKey, catalogPointer: pool.catalogPointer}));
    expect(checkpoints.write).toHaveBeenCalledTimes(1); expect(pool.maintenanceLocked).toBe(true);
    expect(pool.sessions.get('old-session')).toBe(originalEntry);
    expect(host.__paxOperationalGamePoolsV20?.get(pool.catalogKey)).toBe(pool);
    expect(host.__paxOperationalGamePool?.catalogKey).toBe(keyOf(currentOperationalCatalog));
    expect(host.__paxOperationalGamePool?.sessions).not.toBe(pool.sessions);
    expect(() => server.operationalGameSession('old-session')).toThrow('GAME_CATALOG_PRESERVED');
    server.closeOperationalGame('old-session'); expect(pool.sessions.get('old-session')).toBe(originalEntry);
  });

  it.each(['busy', 'missing-original-pointer', 'checkpoint-failure'] as const)('refuses activation on %s and keeps every original reference', async reason => {
    const {pool, session} = previousPool(reason === 'busy'), entry = pool.sessions.get('old-session');
    if (reason === 'missing-original-pointer') delete pool.catalogPointer;
    if (reason === 'checkpoint-failure') checkpoints.write.mockImplementation(() => {throw Error('CHECKPOINT_TEST_WRITE_FAILED');});
    const error = reason === 'busy' ? 'GAME_CHECKPOINT_BUSY' : reason === 'missing-original-pointer' ? 'CHECKPOINT_ORIGINAL_CATALOG_POINTER_MISSING' : 'CHECKPOINT_TEST_WRITE_FAILED';
    await expect(import('./operational-game.server')).rejects.toThrow(error);
    expect(host.__paxOperationalGamePool).toBe(pool); expect(pool.sessions.get('old-session')).toBe(entry);
    expect(pool.sessions.get('old-session')?.session).toBe(session); expect(pool.maintenanceLocked).not.toBe(true);
    expect(host.__paxOperationalGamePoolsV20?.get(pool.catalogKey)).toBe(pool);
    expect(host.__paxOperationalGamePoolsV20?.has(keyOf(currentOperationalCatalog))).toBe(false);
  });

  it.each(['v19', 'unversioned'] as const)('explicitly rejects unsupported %s input without deleting either original pool', async kind => {
    const {pool} = previousPool(), entries = [...pool.sessions];
    const legacy = new Map([['legacy-session', {unsupportedOriginal: true}]]);
    if (kind === 'v19') host.__paxOperationalGamesV19 = legacy; else host.__paxOperationalGames = legacy;
    await expect(import('./operational-game.server')).rejects.toThrow('UNSUPPORTED_LEGACY_GAME_POOL_PRESENT');
    expect(kind === 'v19' ? host.__paxOperationalGamesV19 : host.__paxOperationalGames).toBe(legacy);
    expect(legacy.size).toBe(1); expect([...pool.sessions]).toEqual(entries); expect(host.__paxOperationalGamePool).toBe(pool);
    expect(checkpoints.capture).not.toHaveBeenCalled(); expect(checkpoints.write).not.toHaveBeenCalled();
    expect(host.__paxOperationalGamePoolsV20).toBeUndefined();
  });

  it.each(['v19', 'unversioned'] as const)('refuses standalone unsupported %s games before creating any replacement pool', async kind => {
    const legacy = new Map([['legacy-session', {original: true}]]);
    if (kind === 'v19') host.__paxOperationalGamesV19 = legacy; else host.__paxOperationalGames = legacy;
    await expect(import('./operational-game.server')).rejects.toThrow('UNSUPPORTED_LEGACY_GAME_POOL_PRESENT');
    expect(kind === 'v19' ? host.__paxOperationalGamesV19 : host.__paxOperationalGames).toBe(legacy);
    expect(legacy.size).toBe(1); expect(host.__paxOperationalGamePool).toBeUndefined();
    expect(host.__paxOperationalGamePoolsV20).toBeUndefined(); expect(checkpoints.write).not.toHaveBeenCalled();
  });
});
