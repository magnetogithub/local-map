import 'server-only';
import fs from 'node:fs';
import {randomUUID} from 'node:crypto';
import {createProductionOperationalGame} from '../../world/operational-game.server';
import {loadOperationalCatalog} from '../../world/operational-catalog.server';
import {loadProductionCatalogSeed} from '../../world/production-catalog-seed.server';
import {readCatalogConsumerMetadata} from '../../map/catalog-consumer-contract';
import {loadCatalogRegionIndex} from '../catalog-region.server';
import {selectOperationalFrontier} from '../operational-frontier.server';
import {createOperationalGameSession, type OperationalGameSession} from './operational-game-session';
import type {OperationalGameStart, OperationalCountryPresentation} from '../operational-game-protocol';
import currentOperationalCatalog from '../../../../data/runtime/operational-catalog/current.json';
import {captureOperationalGamePreservation, writeOperationalGameCheckpoint} from './operational-game-checkpoint';

// Route bundles share the same local games, including across development module reloads.
type GameSessions = Map<string, {session: OperationalGameSession; touched: number}>;
type GamePool = {catalogKey: string; sessions: GameSessions; catalogPointer?: typeof currentOperationalCatalog; maintenanceLocked?: boolean};
const host = globalThis as typeof globalThis & {__paxOperationalGames?: unknown; __paxOperationalGamesV19?: GameSessions;
  __paxOperationalGamePool?: GamePool; __paxOperationalGamePoolsV20?: Map<string, GamePool>};
const catalogKey = currentOperationalCatalog.catalogVersion + ':' + currentOperationalCatalog.index.sha256;
const pools = host.__paxOperationalGamePoolsV20 ??= new Map();
const previousPool = host.__paxOperationalGamePool;
if (previousPool) {
  pools.set(previousPool.catalogKey, previousPool);
  if (previousPool.catalogKey === catalogKey) previousPool.catalogPointer ??= currentOperationalCatalog;
}
function checkpointPools(selected: readonly GamePool[]) {
  if ((host.__paxOperationalGamesV19?.size ?? 0) > 0 || host.__paxOperationalGames != null) throw Error('UNSUPPORTED_LEGACY_GAME_POOL_PRESENT');
  for (const pool of selected) for (const value of pool.sessions.values()) if (value.session.isBusy()) throw Error('GAME_CHECKPOINT_BUSY');
  const locks = selected.map(pool => pool.maintenanceLocked);selected.forEach(pool => {pool.maintenanceLocked = true;});
  try {
    const results = selected.map(pool => {
      if (!pool.catalogPointer) throw Error('CHECKPOINT_ORIGINAL_CATALOG_POINTER_MISSING');
      const checkpoints = [...pool.sessions].map(([sessionId, value]) => writeOperationalGameCheckpoint(captureOperationalGamePreservation({sessionId, ...value, catalogKey: pool.catalogKey, catalogPointer: pool.catalogPointer!})));
      return {catalogVersion: pool.catalogPointer.catalogVersion, catalogKey: pool.catalogKey, sessionCount: pool.sessions.size, checkpoints};
    });
    return {pass: true, activeCatalogVersion: currentOperationalCatalog.catalogVersion, activeCatalogKey: catalogKey, sessionCount: results.reduce((n, result) => n + result.sessionCount, 0), busySessions: 0, mutationsLocked: true, checkpointFormat: 'operational-game-preservation.v1', pools: results};
  } catch (error) {selected.forEach((pool, i) => {pool.maintenanceLocked = locks[i];});throw error;}
}
// Back up the original pool before installing a new active key. Never clear it.
// A busy game or failed disk roundtrip prevents the new module from proceeding.
if (previousPool && previousPool.catalogKey !== catalogKey) checkpointPools([previousPool]);
const activePool: GamePool = pools.get(catalogKey) ?? {catalogKey, sessions: new Map(), catalogPointer: currentOperationalCatalog};
activePool.catalogPointer ??= currentOperationalCatalog;pools.set(catalogKey, activePool);host.__paxOperationalGamePool = activePool;
const sessions = activePool.sessions;
const SESSION_LIFETIME = 6 * 60 * 60 * 1000;
let presentation: readonly OperationalCountryPresentation[] | undefined;
function countryPresentation() {
  if (presentation) return presentation;
  const previous = loadProductionCatalogSeed();
  const metadata = readCatalogConsumerMetadata(JSON.parse(fs.readFileSync(`public${previous.bootstrap.metadata.path}`, 'utf8')), previous.bootstrap.catalogRef);
  presentation = metadata.countries.map(country => {
    const cells = metadata.territories.filter(c => c.sourceCountryId === country.countryId);
    const box = cells.reduce((b, c) => [Math.min(b[0], c.bbox[0]), Math.min(b[1], c.bbox[1]), Math.max(b[2], c.bbox[2]), Math.max(b[3], c.bbox[3])], [180, 90, -180, -90]);
    return {...country, focus: {center: country.label.anchor, zoom: Math.max(1, Math.min(7, Math.log2(360 / Math.max(1, box[2] - box[0], box[3] - box[1]))))}};
  });
  return presentation;
}
export function startOperationalGame(): OperationalGameStart {
  if (activePool.maintenanceLocked) throw Error('GAME_CHECKPOINT_LOCKED');
  const now = Date.now();
  for (const [id, value] of sessions) if (!value.session.isBusy() && now - value.touched > SESSION_LIFETIME) sessions.delete(id);
  if (sessions.size >= 8) throw Error('TOO_MANY_LOCAL_GAMES');
  const game = createProductionOperationalGame(), catalog = loadOperationalCatalog(), regionIndex = loadCatalogRegionIndex(catalog.ref);
  const session = createOperationalGameSession({seed: game.pair, catalog: game.catalog, regionIndex,
    frontier: (world, scope) => selectOperationalFrontier(catalog, world, scope, regionIndex), actionId: () => `action.${randomUUID()}`});
  const runs: [number, string, string | null, string | null][] = [];
  for (const id of game.pair.world.territoryOrder) {
    const c = game.pair.world.territoriesById[id], last = runs.at(-1);
    if (last && last[1] === c.sourceCountryId && last[2] === c.ownerCountryId && last[3] === c.controllerCountryId) last[0]++;
    else runs.push([1, c.sourceCountryId, c.ownerCountryId, c.controllerCountryId]);
  }
  const sessionId = randomUUID();
  const result = {sessionId, snapshot: session.snapshot(), runs, seedVersion: game.pair.world.seedVersion, policyVersion: game.pair.world.policyVersion, presentation: countryPresentation()};
  sessions.set(sessionId, {session, touched: now});
  return result;
}
export function operationalGameSession(id: string): OperationalGameSession {
  for (const pool of pools.values()) if (pool !== activePool && pool.sessions.has(id)) throw Error('GAME_CATALOG_PRESERVED');
  if (activePool.maintenanceLocked) throw Error('GAME_CHECKPOINT_LOCKED');
  const value = sessions.get(id);
  if (!value || Date.now() - value.touched > SESSION_LIFETIME && !value.session.isBusy()) {sessions.delete(id); throw Error('GAME_SESSION_EXPIRED');}
  loadOperationalCatalog().assertRef(value.session.runtime.getSnapshot().world.catalogRef);
  value.touched = Date.now(); return value.session;
}
export function closeOperationalGame(id: string) {
  // A stale tab's pagehide cleanup cannot erase a preserved old-catalog pool.
  if (!activePool.maintenanceLocked) sessions.delete(id);
}
export function checkpointOperationalGames(expectedCatalogVersion: string) {
  if (expectedCatalogVersion !== currentOperationalCatalog.catalogVersion) throw Error('CHECKPOINT_CATALOG_MISMATCH');
  const pointer = JSON.parse(fs.readFileSync('data/runtime/operational-catalog/current.json', 'utf8')) as typeof currentOperationalCatalog;
  if (`${pointer.catalogVersion}:${pointer.index.sha256}` !== catalogKey) throw Error('CHECKPOINT_ACTIVE_POINTER_CHANGED');
  return checkpointPools([...pools.values()]);
}
export function abortOperationalGameCheckpoint(expectedCatalogVersion: string) {
  if (expectedCatalogVersion !== currentOperationalCatalog.catalogVersion) throw Error('CHECKPOINT_CATALOG_MISMATCH');
  const pointer = JSON.parse(fs.readFileSync('data/runtime/operational-catalog/current.json', 'utf8')) as typeof currentOperationalCatalog;
  if (`${pointer.catalogVersion}:${pointer.index.sha256}` !== catalogKey) throw Error('CHECKPOINT_ACTIVE_POINTER_CHANGED');
  activePool.maintenanceLocked = false;return {pass: true, activeCatalogVersion: currentOperationalCatalog.catalogVersion, mutationsLocked: false};
}
