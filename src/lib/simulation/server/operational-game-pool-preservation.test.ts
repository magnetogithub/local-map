// @vitest-environment node
import {afterEach, describe, expect, it, vi} from 'vitest';
import pointer from '../../../../data/runtime/operational-catalog/current.json';
import type {OperationalGameSession} from './operational-game-session';
const mocks = vi.hoisted(() => ({capture: vi.fn(), write: vi.fn()}));
vi.mock('./operational-game-checkpoint', () => ({captureOperationalGamePreservation: mocks.capture, writeOperationalGameCheckpoint: mocks.write}));
type Pool = {catalogKey: string; catalogPointer?: typeof pointer; sessions: Map<string, {session: OperationalGameSession; touched: number}>; maintenanceLocked?: boolean};
const host = globalThis as typeof globalThis & {__paxOperationalGamePool?: Pool; __paxOperationalGamePoolsV20?: Map<string, Pool>; __paxOperationalGames?: unknown; __paxOperationalGamesV19?: unknown};
const key = `${pointer.catalogVersion}:${pointer.index.sha256}`;
function pool(busy = false, older = false) {
  const originalPointer = older ? {...pointer, catalogVersion: 'catalog-v3-original-retained'} : pointer;
  const session = {isBusy: () => busy} as OperationalGameSession;
  const value: Pool = {catalogKey: `${originalPointer.catalogVersion}:${originalPointer.index.sha256}`, catalogPointer: originalPointer, sessions: new Map([['private-existing-session', {session, touched: Date.now()}]])};
  host.__paxOperationalGamePool = value;delete host.__paxOperationalGamePoolsV20;
  mocks.capture.mockImplementation(input => input);mocks.write.mockReturnValue({artifact: {path: 'private-preservation.json.gz', sha256: '1'.repeat(64), byteLength: 123}, historyEntries: 2, roundtripValidated: true});return {value, session};
}
afterEach(() => {delete host.__paxOperationalGamePool;delete host.__paxOperationalGamePoolsV20;delete host.__paxOperationalGames;delete host.__paxOperationalGamesV19;vi.resetAllMocks();vi.resetModules();});
describe('retained original catalog pools and checkpoint barrier', () => {
  it('upgrades an existing live pool without clearing it and blocks mutations/cleanup after checkpoint', async () => {
    const {value, session} = pool();vi.resetModules();const server = await import('./operational-game.server');
    expect(host.__paxOperationalGamePool).toBe(value);expect(value.sessions.get('private-existing-session')?.session).toBe(session);
    expect(server.checkpointOperationalGames(pointer.catalogVersion)).toMatchObject({pass: true, sessionCount: 1, mutationsLocked: true});
    expect(mocks.capture.mock.calls[0][0].session).toBe(session);expect(() => server.startOperationalGame()).toThrow('GAME_CHECKPOINT_LOCKED');
    server.closeOperationalGame('private-existing-session');expect(value.sessions.size).toBe(1);
    expect(server.abortOperationalGameCheckpoint(pointer.catalogVersion)).toMatchObject({mutationsLocked: false});server.closeOperationalGame('private-existing-session');expect(value.sessions.size).toBe(0);
  });
  it('rejects busy games and restores the prior lock after write failure', async () => {
    const busy = pool(true);vi.resetModules();const first = await import('./operational-game.server');expect(() => first.checkpointOperationalGames(pointer.catalogVersion)).toThrow('GAME_CHECKPOINT_BUSY');expect(mocks.write).not.toHaveBeenCalled();expect(busy.value.maintenanceLocked).not.toBe(true);
    const idle = pool();vi.resetModules();const second = await import('./operational-game.server');mocks.write.mockImplementationOnce(() => {throw Error('DISK_WRITE_FAILED');});expect(() => second.checkpointOperationalGames(pointer.catalogVersion)).toThrow('DISK_WRITE_FAILED');expect(idle.value.sessions.size).toBe(1);expect(idle.value.maintenanceLocked).not.toBe(true);
  });
  it('automatically backs up and retains an old catalog pool during a key switch', async () => {
    const {value, session} = pool(false, true);vi.resetModules();const server = await import('./operational-game.server');
    expect(mocks.write).toHaveBeenCalledTimes(1);expect(host.__paxOperationalGamePoolsV20?.get(value.catalogKey)).toBe(value);expect(host.__paxOperationalGamePool?.catalogKey).toBe(key);expect(value.sessions.get('private-existing-session')?.session).toBe(session);expect(value.maintenanceLocked).toBe(true);
    expect(() => server.operationalGameSession('private-existing-session')).toThrow('GAME_CATALOG_PRESERVED');server.closeOperationalGame('private-existing-session');expect(value.sessions.size).toBe(1);
  });
  it('fails module activation on fallback checkpoint failure while retaining every original reference', async () => {
    const {value, session} = pool(false, true);mocks.write.mockImplementationOnce(() => {throw Error('CHECKPOINT_DISK_FAILURE');});vi.resetModules();await expect(import('./operational-game.server')).rejects.toThrow('CHECKPOINT_DISK_FAILURE');
    expect(host.__paxOperationalGamePool).toBe(value);expect(value.sessions.get('private-existing-session')?.session).toBe(session);expect(host.__paxOperationalGamePoolsV20?.get(value.catalogKey)).toBe(value);
  });
});
