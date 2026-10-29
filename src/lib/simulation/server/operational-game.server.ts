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

// Route bundles share the same local games, including across development module reloads.
const host = globalThis as typeof globalThis & {__paxOperationalGames?: Map<string, {session: OperationalGameSession; touched: number}>};
const sessions = host.__paxOperationalGames ??= new Map();
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
  const value = sessions.get(id);
  if (!value || Date.now() - value.touched > SESSION_LIFETIME && !value.session.isBusy()) {sessions.delete(id); throw Error('GAME_SESSION_EXPIRED');}
  value.touched = Date.now(); return value.session;
}
export function closeOperationalGame(id: string) {sessions.delete(id);}
