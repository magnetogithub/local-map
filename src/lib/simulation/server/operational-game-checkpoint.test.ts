// @vitest-environment node
import fs from 'node:fs';
import path from 'node:path';
import {afterAll, afterEach, beforeAll, describe, expect, it, vi} from 'vitest';
import {createProductionOperationalGame} from '../../world/operational-game.server';
import {prepareOperationalCatalog} from '../../world/operational-catalog.server';
import {createWorldStateV3} from '../../world/world-state-v3';
import {createImmutableReadonlySet} from '../../world/immutable-readonly-set';
import {worldV3RuntimeContentHash} from '../../world/world-v3-runtime-hash';
import {createSimulationStateV2, simulationStateV2ContentHash} from '../simulation-state-v2';
import {createOperationalRegionIndex} from '../operational-region.server';
import {selectOperationalFrontier} from '../operational-frontier.server';
import {createOperationalGameSession, type OperationalGameSession} from './operational-game-session';
import {createProductionSimulationProvider} from '../../test-only/region-provider.server';
import {captureOperationalGamePreservation, readOperationalGameCheckpoint, stepOperationalGameRecovery, writeOperationalGameCheckpoint, type OperationalGamePreservation} from './operational-game-checkpoint';
import pointer from '../../../../data/runtime/operational-catalog/current.json';

let session: OperationalGameSession, captured: OperationalGamePreservation;
const folders: string[] = [];
const temp = () => {const dir = fs.mkdtempSync(path.join(process.cwd(), '.tmp', 'game-preservation-'));folders.push(dir);return dir;};
beforeAll(async () => {
  vi.stubEnv('PAX_OPERATIONAL_SMOKE', '1');vi.stubGlobal('fetch', vi.fn(() => {throw Error('EXTERNAL_NETWORK_FORBIDDEN');}));
  const game = createProductionOperationalGame('CHN'), catalog = prepareOperationalCatalog(), regionIndex = createOperationalRegionIndex(catalog), old = game.pair.world;
  // A valid fixture with a nonempty retired registry exercises the real custom
  // ReadonlySet. Two actual host-validated provider turns then populate history.
  const countries = Object.fromEntries(Object.entries(old.countriesById).filter(([id]) => id !== 'ISL'));
  const territories = Object.fromEntries(old.territoryOrder.map(id => {const c = old.territoriesById[id];return [id, c.sourceCountryId === 'ISL' ? {...c, ownerCountryId: 'CHN', controllerCountryId: 'CHN'} : c];}));
  const world = createWorldStateV3({...old, countriesById: countries, countryOrder: old.countryOrder.filter(id => id !== 'ISL'), territoriesById: territories, retiredCountryIds: createImmutableReadonlySet(['ISL'])}, game.catalog);
  const simulation = createSimulationStateV2({...game.pair.simulation, queuedActions: [], factsById: {}, factOrder: [], situationsById: {}, situationOrder: [], eventLog: [], scheduledConsequences: [], territorialControlAuthoritiesById: {}, territorialControlAuthorityOrder: [], countryPresentationAuthoritiesById: {}, countryPresentationAuthorityOrder: []}, world);
  session = createOperationalGameSession({seed: {...game.pair, world, simulation}, catalog: game.catalog, regionIndex, frontier: (w, scope) => selectOperationalFrontier(catalog, w, scope, regionIndex), actionId: () => `action.private.${session.runtime.getHistory().entries.length}`});
  for (const date of ['2020-01-02', '2020-01-03']) {
    session.command({operation: 'queue', sessionId: 'checkpoint-test', revisions: session.runtime.getSnapshot().revisions, text: '[DEBUG_WORLD_EFFECT] PRIVATE_PRESERVATION_ACTION 접경 일부 점령'});
    const prepared = session.command({operation: 'prepare-turn', sessionId: 'checkpoint-test', revisions: session.runtime.getSnapshot().revisions, targetDate: date});if (!('context' in prepared) || !prepared.context || !prepared.turnId) throw Error('PREPARE_MISSING');
    const events = [];for await (const event of session.provider(createProductionSimulationProvider()).streamTurn({turnId: prepared.turnId, context: prepared.context}, new AbortController().signal)) events.push(event);
    expect(events.some(event => event.type === 'resolution.ready')).toBe(true);
  }
  session.command({operation: 'undo', sessionId: 'checkpoint-test', revisions: session.runtime.getSnapshot().revisions});
  expect(session.runtime.getHistory().entries).toHaveLength(2);expect(session.runtime.getHistory().pointer).toBe(1);
  captured = captureOperationalGamePreservation({sessionId: 'checkpoint-test', touched: 1234, session, catalogKey: `${pointer.catalogVersion}:${pointer.index.sha256}`, catalogPointer: pointer});
}, 60_000);
afterEach(() => {for (const folder of folders.splice(0)) {const relative = path.relative(path.join(process.cwd(), '.tmp'), folder);if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw Error('UNSAFE_TEST_CLEANUP');fs.rmSync(folder, {recursive: true, force: true});}});
afterAll(() => {vi.unstubAllGlobals();vi.unstubAllEnvs();});

describe('lossless private original-catalog preservation', () => {
  it('roundtrips current, initial, two full plans/history pointer, shared references and nonempty Sets', () => {
    const directory = temp(), summary = writeOperationalGameCheckpoint(captured, directory), recovered = readOperationalGameCheckpoint(path.join(directory, summary.artifact.path), summary.artifact);
    expect(summary.completeInitialCurrentAndHistory).toBe(true);expect(summary.roundtripValidated).toBe(true);expect(summary.historyEntries).toBe(2);expect(summary.historyPointer).toBe(1);
    expect(recovered.current.world.catalogRef).toEqual(captured.current.world.catalogRef);expect(recovered.initial.simulation).toEqual(captured.initial.simulation);
    expect([...recovered.current.world.retiredCountryIds]).toEqual(['ISL']);expect(recovered.current.world.retiredCountryIds.has('ISL' as never)).toBe(true);
    expect(recovered.history.entries[0].plan.baseWorldState).toBe(recovered.history.entries[0].beforeWorld);expect(recovered.history.entries[1].plan.nextSimulationState).toBe(recovered.history.entries[1].afterSimulation);
    expect(recovered.current.simulation.queuedActions.some(a => a.text.includes('PRIVATE_PRESERVATION_ACTION'))).toBe(true);
    expect(JSON.stringify(summary)).not.toContain('PRIVATE_PRESERVATION_ACTION');expect(JSON.stringify(summary)).not.toContain('checkpoint-test');
    const original = session.runtime.getSnapshot(), undo = stepOperationalGameRecovery(recovered, 'undo'), actualUndo = session.runtime.undo();
    expect(undo.current.revisions).toEqual(actualUndo.revisions);expect(worldV3RuntimeContentHash(undo.current.world)).toBe(worldV3RuntimeContentHash(actualUndo.world));expect(simulationStateV2ContentHash(undo.current.simulation)).toBe(simulationStateV2ContentHash(actualUndo.simulation));
    const redo = stepOperationalGameRecovery(undo, 'redo'), actualRedo = session.runtime.redo();expect(redo.current.revisions).toEqual(actualRedo.revisions);expect(worldV3RuntimeContentHash(redo.current.world)).toBe(worldV3RuntimeContentHash(original.world));expect(simulationStateV2ContentHash(redo.current.simulation)).toBe(simulationStateV2ContentHash(actualRedo.simulation));
    // Restore the test session pointer so following tests capture the same state.
    expect(session.runtime.getHistory().pointer).toBe(captured.history.pointer);
  });
  it('rejects a changed private artifact before decoding and invalid history pointers before writing', () => {
    const directory = temp(), summary = writeOperationalGameCheckpoint(captured, directory), file = path.join(directory, summary.artifact.path), bytes = fs.readFileSync(file);bytes[0] ^= 1;fs.writeFileSync(file, bytes);
    expect(() => readOperationalGameCheckpoint(file, summary.artifact)).toThrow('CHECKPOINT_FILE_IDENTITY');
    expect(() => writeOperationalGameCheckpoint({...captured, history: {...captured.history, pointer: 3}}, directory)).toThrow('CHECKPOINT_HISTORY_POINTER');
  });
  it('recognizes a frozen cross-HMR/minified readonly Set without constructor-name reliance', () => {
    const original = captured.current.world.retiredCountryIds, prototype = Object.create(Object.prototype);
    Object.defineProperties(prototype, Object.getOwnPropertyDescriptors(Object.getPrototypeOf(original)));
    Object.defineProperty(prototype, 'constructor', {value: class a {}, configurable: true});
    const minified = Object.create(prototype) as typeof original;
    Object.defineProperty(minified, 'valuesSnapshot', {value: Object.freeze(['ISL']), enumerable: true});Object.freeze(minified);
    expect(minified.constructor.name).toBe('a');expect(minified.has('ISL' as never)).toBe(true);
    const data = {...captured, current: {...captured.current, world: {...captured.current.world, retiredCountryIds: minified}}};
    const directory = temp(), summary = writeOperationalGameCheckpoint(data, directory), recovered = readOperationalGameCheckpoint(path.join(directory, summary.artifact.path), summary.artifact);
    expect([...recovered.current.world.retiredCountryIds]).toEqual(['ISL']);
  });
  it('fails closed for busy sessions and a filesystem write failure without changing live state', () => {
    const before = session.runtime.getSnapshot();expect(() => captureOperationalGamePreservation({sessionId: 'busy', touched: 0, session: {...session, isBusy: () => true}, catalogKey: captured.catalogKey, catalogPointer: pointer})).toThrow('GAME_CHECKPOINT_BUSY');
    const directory = temp();fs.writeFileSync(path.join(directory, 'data'), 'blocked');expect(() => writeOperationalGameCheckpoint(captured, directory)).toThrow();expect(session.runtime.getSnapshot()).toBe(before);
  });
});
