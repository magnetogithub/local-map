'use client';
import {assertWorldGeometryCatalogRefMatches} from '../../world/world-geometry-catalog-ref';
import type {TerritoryId} from '../../world/territory-id';
import {OPERATIONAL_GAME_HEADER, type OperationalGameStart} from '../operational-game-protocol';
import {createOperationalGameClient, gameRequest, type OperationalGameClient} from './operational-game-client';

export type OperationalGameLease = Readonly<{
  ready: Promise<OperationalGameClient>;
  release(): void;
}>;

type LoadingGame = {
  ready: Promise<OperationalGameClient>;
  users: number;
  sessionId?: string;
  clientReady: boolean;
  abandoned: boolean;
  closeRequested: boolean;
  releaseTimer?: ReturnType<typeof setTimeout>;
  cellsAbort: AbortController;
  onPageHide(event: PageTransitionEvent): void;
};

/** Owns the existing single in-memory game across setup -> /game transitions. */
export function createOperationalGameLoader(): () => OperationalGameLease {
  let loading: LoadingGame | undefined;
  const closeAllocatedSession = (entry: LoadingGame) => {
    if (!entry.sessionId || entry.closeRequested) return;
    entry.closeRequested = true;
    void fetch('/api/simulation/game', {method: 'DELETE',
      headers: {[OPERATIONAL_GAME_HEADER]: entry.sessionId}, keepalive: true}).catch(() => {});
  };
  const abandon = (entry: LoadingGame) => {
    if (!entry.abandoned) {
      entry.abandoned = true;
      if (loading === entry) loading = undefined;
      clearTimeout(entry.releaseTimer);
      entry.cellsAbort.abort();
      window.removeEventListener('pagehide', entry.onPageHide);
    }
    closeAllocatedSession(entry);
  };
  const begin = (): LoadingGame => {
    const entry: LoadingGame = {
      ready: undefined as unknown as Promise<OperationalGameClient>, users: 0,
      clientReady: false, abandoned: false, closeRequested: false, cellsAbort: new AbortController(),
      onPageHide: event => {if (!event.persisted) abandon(entry);},
    };
    window.addEventListener('pagehide', entry.onPageHide);
    // Never abort start: its eventual session ID is needed to reclaim a late allocation.
    const start = gameRequest<OperationalGameStart>({operation: 'start'}).then(value => {
      entry.sessionId = value.sessionId;
      if (entry.abandoned) {closeAllocatedSession(entry); throw new DOMException('Game initialization cancelled', 'AbortError');}
      return value;
    });
    const cells = fetch('/api/world/catalog/operational/cells', {cache: 'no-store', signal: entry.cellsAbort.signal})
      .then(async response => {if (!response.ok) throw Error('CATALOG_NOT_READY'); return response.json();});
    entry.ready = Promise.all([start, cells]).then(([created, catalog]) => {
      if (entry.abandoned || entry.users === 0) throw new DOMException('Game initialization cancelled', 'AbortError');
      assertWorldGeometryCatalogRefMatches(catalog.catalogRef, created.snapshot.world.catalogRef);
      const client = createOperationalGameClient(created, catalog.cellIds as TerritoryId[]);
      entry.clientReady = true;
      return client;
    }).catch(error => {abandon(entry); throw error;});
    return entry;
  };
  return () => {
    const entry = loading ??= begin();
    clearTimeout(entry.releaseTimer);
    entry.users++;
    let released = false;
    return {ready: entry.ready, release: () => {
      if (released) return;
      released = true;
      entry.users--;
      // Ready games retain the existing route continuity; pagehide owns their final cleanup.
      if (entry.users === 0 && !entry.clientReady && !entry.abandoned) {
        entry.releaseTimer = setTimeout(() => {
          if (entry.users === 0 && !entry.clientReady) abandon(entry);
        }, 0);
      }
    }};
  };
}

export const acquireOperationalGame = createOperationalGameLoader();
