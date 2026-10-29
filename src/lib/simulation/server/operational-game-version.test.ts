// @vitest-environment node
import {afterEach, describe, expect, it, vi} from 'vitest';
import currentOperationalCatalog from '../../../../data/runtime/operational-catalog/current.json';

type Pool = {catalogKey: string; sessions: Map<string, unknown>};
const host = globalThis as typeof globalThis & {__paxOperationalGamePool?: Pool; __paxOperationalGamesV19?: Map<string, unknown>};
afterEach(() => {delete host.__paxOperationalGamePool; delete host.__paxOperationalGamesV19; vi.resetModules();});

describe('operational game catalog version isolation', () => {
  it('invalidates sessions retained across a catalog change and rejects their IDs', async () => {
    const stale = new Map([['old-session', {}]]), legacy = new Map([['legacy-session', {}]]);
    host.__paxOperationalGamePool = {catalogKey: 'previous-version:previous-index', sessions: stale};
    host.__paxOperationalGamesV19 = legacy;
    vi.resetModules();
    const {operationalGameSession} = await import('./operational-game.server');
    expect(stale.size).toBe(0); expect(legacy.size).toBe(0);
    expect(host.__paxOperationalGamePool?.catalogKey).toBe(`${currentOperationalCatalog.catalogVersion}:${currentOperationalCatalog.index.sha256}`);
    expect(() => operationalGameSession('old-session')).toThrow('GAME_SESSION_EXPIRED');
  });

  it('reuses the current version session map across route module reloads', async () => {
    const sessions = new Map<string, unknown>();
    host.__paxOperationalGamePool = {catalogKey: `${currentOperationalCatalog.catalogVersion}:${currentOperationalCatalog.index.sha256}`, sessions};
    vi.resetModules(); await import('./operational-game.server');
    expect(host.__paxOperationalGamePool?.sessions).toBe(sessions);
  });
});
