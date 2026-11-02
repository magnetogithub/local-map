import 'server-only';
import fs from 'node:fs';
import path from 'node:path';
import {createHash, randomUUID} from 'node:crypto';
import {gzipSync, gunzipSync} from 'node:zlib';
import {createWorldStateV3, type WorldStateV3} from '../../world/world-state-v3';
import {createWorldGeometryCatalogContract, type WorldGeometryCatalogContract} from '../../world/world-geometry-catalog-ref';
import {worldV3RuntimeContentHash} from '../../world/world-v3-runtime-hash';
import {createSimulationStateV2, simulationStateV2ContentHash, type SimulationStateV2} from '../simulation-state-v2';
import type {CatalogRuntimePair, CatalogRuntime} from '../catalog-runtime';
import type {OperationalGameSession} from './operational-game-session';
import type {TurnReport} from '../client/turn-report';

type Pointer = Readonly<{catalogVersion: string; root: string; index: Readonly<{sha256: string; byteLength: number}>}>;
type History = ReturnType<CatalogRuntime['getHistory']>;
export type OperationalGamePreservation = Readonly<{
  format: 'operational-game-preservation.v1'; sessionId: string; catalogKey: string; catalogPointer: Pointer;
  touched: number; current: CatalogRuntimePair; initial: CatalogRuntimePair; history: History;
  catalogs: readonly WorldGeometryCatalogContract[]; report: TurnReport | null;
}>;
type Encoded = null | boolean | string | number | {$ref: number} | {$primitive: 'undefined' | 'negative-zero'};
type Node = {kind: 'object'; nullPrototype: boolean; entries: [string, Encoded][]} | {kind: 'array' | 'set'; values: Encoded[]} | {kind: 'map'; entries: [Encoded, Encoded][]};
type Graph = {root: Encoded; nodes: Node[]};
const sha = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
function invalid(condition: unknown, code: string): asserts condition {if (!condition) throw Error(code);}
function frozenReadonlySet(value: object): value is ReadonlySet<unknown> {
  const prototype = Object.getPrototypeOf(value), descriptor = Object.getOwnPropertyDescriptor(value, 'valuesSnapshot');
  if (!prototype || prototype === Object.prototype || !Object.isFrozen(value) || !descriptor || !('value' in descriptor) || !Array.isArray(descriptor.value) || !Object.isFrozen(descriptor.value)) return false;
  const candidate = value as ReadonlySet<unknown>, values = descriptor.value as unknown[];
  if (candidate.size !== values.length || !['has', 'values', 'keys', 'entries', 'forEach'].every(key => typeof (candidate as unknown as Record<string, unknown>)[key] === 'function') || typeof candidate[Symbol.iterator] !== 'function') return false;
  const iterated = [...candidate];return iterated.length === values.length && iterated.every((item, i) => item === values[i]);
}

// Identity-preserving graph encoding retains shared before/after/plan references,
// readonly/native Sets, Maps, undefined and negative zero. Unsupported objects
// fail closed instead of JSON.stringify silently discarding game state.
function encode(value: unknown): Graph {
  const nodes: Node[] = [], seen = new Map<object, number>();
  const visit = (value: unknown): Encoded => {
    if (value === undefined) return {$primitive: 'undefined'};
    if (typeof value === 'number') {invalid(Number.isFinite(value), 'CHECKPOINT_NONFINITE_VALUE');return Object.is(value, -0) ? {$primitive: 'negative-zero'} : value;}
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
    invalid(typeof value === 'object', 'CHECKPOINT_UNSUPPORTED_VALUE');
    const prior = seen.get(value);if (prior !== undefined) return {$ref: prior};const id = nodes.length;seen.set(value, id);nodes.push({kind: 'array', values: []});
    if (Array.isArray(value)) nodes[id] = {kind: 'array', values: value.map(visit)};
    else if (value instanceof Map) nodes[id] = {kind: 'map', entries: [...value].map(([key, item]) => [visit(key), visit(item)])};
    else if (value instanceof Set || frozenReadonlySet(value)) nodes[id] = {kind: 'set', values: [...value as ReadonlySet<unknown>].map(visit)};
    else {
      const prototype = Object.getPrototypeOf(value);invalid(prototype === null || prototype === Object.prototype, 'CHECKPOINT_UNSUPPORTED_OBJECT');invalid(Object.getOwnPropertySymbols(value).length === 0, 'CHECKPOINT_SYMBOL_VALUE');
      const descriptors = Object.getOwnPropertyDescriptors(value);
      nodes[id] = {kind: 'object', nullPrototype: prototype === null, entries: Object.keys(descriptors).sort().map(key => {const d = descriptors[key];invalid(d.enumerable && 'value' in d, 'CHECKPOINT_NONDATA_PROPERTY');return [key, visit(d.value)];})};
    }
    return {$ref: id};
  };
  return {root: visit(value), nodes};
}
function decode(graph: Graph): unknown {
  invalid(graph && Array.isArray(graph.nodes), 'CHECKPOINT_GRAPH_SHAPE');
  const objects: unknown[] = graph.nodes.map(node => node.kind === 'array' ? [] : node.kind === 'set' ? new Set() : node.kind === 'map' ? new Map() : node.kind === 'object' ? Object.create(node.nullPrototype ? null : Object.prototype) : undefined);
  const value = (encoded: Encoded): unknown => {
    if (encoded === null || typeof encoded !== 'object') return encoded;
    if ('$primitive' in encoded) {invalid(['undefined', 'negative-zero'].includes(encoded.$primitive), 'CHECKPOINT_PRIMITIVE_TAG');return encoded.$primitive === 'undefined' ? undefined : -0;}
    invalid(Number.isSafeInteger(encoded.$ref) && encoded.$ref >= 0 && encoded.$ref < objects.length, 'CHECKPOINT_GRAPH_REFERENCE');return objects[encoded.$ref];
  };
  graph.nodes.forEach((node, i) => {
    if (node.kind === 'array') (objects[i] as unknown[]).push(...node.values.map(value));
    else if (node.kind === 'set') for (const item of node.values) (objects[i] as Set<unknown>).add(value(item));
    else if (node.kind === 'map') for (const [key, item] of node.entries) (objects[i] as Map<unknown, unknown>).set(value(key), value(item));
    else if (node.kind === 'object') for (const [key, item] of node.entries) Object.defineProperty(objects[i], key, {value: value(item), enumerable: true, writable: true, configurable: true});
    else throw Error('CHECKPOINT_GRAPH_NODE');
  });
  const result = value(graph.root);invalid(JSON.stringify(encode(result)) === JSON.stringify(graph), 'CHECKPOINT_LOSSLESS_ROUNDTRIP_FAILED');return result;
}

function validate(data: OperationalGamePreservation) {
  invalid(data?.format === 'operational-game-preservation.v1' && typeof data.sessionId === 'string' && Number.isFinite(data.touched), 'CHECKPOINT_PAYLOAD_SHAPE');
  invalid(data.catalogPointer?.catalogVersion === data.current.world.catalogRef.catalogVersion, 'CHECKPOINT_ORIGINAL_CATALOG_MISMATCH');
  invalid(data.catalogKey === `${data.catalogPointer.catalogVersion}:${data.catalogPointer.index.sha256}`, 'CHECKPOINT_CATALOG_KEY_MISMATCH');
  const catalogs = new Map(data.catalogs.map(c => {const parsed = createWorldGeometryCatalogContract(c);return [parsed.ref.catalogVersion, parsed] as const;}));
  invalid(catalogs.size === data.catalogs.length && catalogs.size > 0, 'CHECKPOINT_CATALOG_CONTRACTS');
  const checkedWorlds = new WeakSet<object>();
  const pair = (world: WorldStateV3, simulation: SimulationStateV2) => {const catalog = catalogs.get(world.catalogRef.catalogVersion);invalid(catalog, 'CHECKPOINT_MISSING_ORIGINAL_CATALOG');if (!checkedWorlds.has(world)) {createWorldStateV3(world, catalog);checkedWorlds.add(world);}createSimulationStateV2(simulation, world);};
  for (const state of [data.current, data.initial]) {pair(state.world, state.simulation);invalid(state.revisions.worldRevision === state.world.revision && state.revisions.simulationRevision === state.simulation.revision, 'CHECKPOINT_PAIR_REVISIONS');}
  invalid(Number.isSafeInteger(data.history.pointer) && data.history.pointer >= 0 && data.history.pointer <= data.history.entries.length, 'CHECKPOINT_HISTORY_POINTER');
  for (const entry of data.history.entries) {
    pair(entry.beforeWorld, entry.beforeSimulation);pair(entry.afterWorld, entry.afterSimulation);
    const p = entry.plan;invalid(p.kind === 'resolved-turn-plan.v1' && p.turnId === entry.turnId && p.baseWorldState === entry.beforeWorld && p.nextWorldState === entry.afterWorld && p.baseSimulationState === entry.beforeSimulation && p.nextSimulationState === entry.afterSimulation, 'CHECKPOINT_HISTORY_PLAN_REFERENCES');
    invalid(p.beforeWorldHash === worldV3RuntimeContentHash(entry.beforeWorld) && p.afterWorldHash === worldV3RuntimeContentHash(entry.afterWorld) && p.beforeSimulationHash === simulationStateV2ContentHash(entry.beforeSimulation) && p.afterSimulationHash === simulationStateV2ContentHash(entry.afterSimulation), 'CHECKPOINT_HISTORY_CONTENT_HASH');
  }
  return data;
}
export function captureOperationalGamePreservation(input: {sessionId: string; touched: number; session: OperationalGameSession; catalogKey: string; catalogPointer: Pointer}): OperationalGamePreservation {
  invalid(!input.session.isBusy(), 'GAME_CHECKPOINT_BUSY');
  const {runtime} = input.session, current = runtime.getSnapshot(), initial = runtime.getInitialSnapshot(), history = runtime.getHistory();
  const worlds = [current.world, initial.world, ...history.entries.flatMap(e => [e.beforeWorld, e.afterWorld])];
  const catalogs = new Map(worlds.map(world => [world.catalogRef.catalogVersion, runtime.getCatalogForSnapshot(world)]));
  const data: OperationalGamePreservation = {format: 'operational-game-preservation.v1', sessionId: input.sessionId, touched: input.touched, catalogKey: input.catalogKey, catalogPointer: input.catalogPointer, current, initial, history, catalogs: [...catalogs.values()], report: input.session.snapshot().report};
  validate(data);invalid(runtime.getSnapshot() === current && !input.session.isBusy(), 'GAME_CHANGED_DURING_CHECKPOINT');return data;
}
export function readOperationalGameCheckpoint(file: string, expected?: {sha256: string; byteLength: number}): OperationalGamePreservation {
  const bytes = fs.readFileSync(file);if (expected) invalid(bytes.length === expected.byteLength && sha(bytes) === expected.sha256, 'CHECKPOINT_FILE_IDENTITY');
  const envelope = JSON.parse(gunzipSync(bytes).toString('utf8')) as {format: string; payloadHash: string; graph: Graph};
  invalid(envelope.format === 'operational-game-checkpoint.v1' && sha(JSON.stringify(envelope.graph)) === envelope.payloadHash, 'CHECKPOINT_PAYLOAD_HASH');return validate(decode(envelope.graph) as OperationalGamePreservation);
}
export function writeOperationalGameCheckpoint(data: OperationalGamePreservation, workspace = process.cwd()) {
  validate(data);const graph = encode(data), payloadHash = sha(JSON.stringify(graph)), bytes = gzipSync(Buffer.from(JSON.stringify({format: 'operational-game-checkpoint.v1', payloadHash, graph})), {level: 9});
  const folder = path.resolve(workspace, 'data/runtime/operational-game-checkpoints'), parent = path.resolve(workspace);
  let ancestor = folder;while (!fs.existsSync(ancestor)) ancestor = path.dirname(ancestor);
  const ancestorRelative = path.relative(fs.realpathSync(parent), fs.realpathSync(ancestor));invalid(!ancestorRelative.startsWith('..') && !path.isAbsolute(ancestorRelative), 'CHECKPOINT_DIRECTORY_ESCAPED');
  fs.mkdirSync(folder, {recursive: true, mode: 0o700});const relative = path.relative(fs.realpathSync(parent), fs.realpathSync(folder));invalid(relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative), 'CHECKPOINT_DIRECTORY_ESCAPED');
  const file = path.join(folder, `${payloadHash}.json.gz`), temporary = `${file}.${randomUUID()}.tmp`;
  if (!fs.existsSync(file)) {let descriptor: number | undefined;try {descriptor = fs.openSync(temporary, 'wx', 0o600);fs.writeFileSync(descriptor, bytes);fs.fsyncSync(descriptor);fs.closeSync(descriptor);descriptor = undefined;fs.renameSync(temporary, file);}catch (error) {if (descriptor !== undefined) fs.closeSync(descriptor);if (fs.existsSync(temporary)) fs.unlinkSync(temporary);throw error;}}
  const artifact = {path: path.relative(workspace, file).replaceAll('\\', '/'), sha256: sha(bytes), byteLength: bytes.length};
  const recovered = readOperationalGameCheckpoint(file, artifact);invalid(JSON.stringify(encode(recovered)) === JSON.stringify(graph), 'CHECKPOINT_READBACK_DIFFERS');
  return {artifact, payloadHash, sessionIdHash: sha(data.sessionId), catalogVersion: data.current.world.catalogRef.catalogVersion, revisions: {...data.current.revisions}, historyEntries: data.history.entries.length, historyPointer: data.history.pointer, completeInitialCurrentAndHistory: true, roundtripValidated: true};
}

/** Pure recovery preview: validates and reconstructs the same next undo/redo
 * pair under its original catalog, without changing any running game. */
export function stepOperationalGameRecovery(data: OperationalGamePreservation, operation: 'undo' | 'redo'): OperationalGamePreservation {
  validate(data);const pointer = data.history.pointer, entry = operation === 'undo' ? data.history.entries[pointer - 1] : data.history.entries[pointer];if (!entry) return data;
  const targetWorld = operation === 'undo' ? entry.beforeWorld : entry.afterWorld, targetSimulation = operation === 'undo' ? entry.beforeSimulation : entry.afterSimulation;
  const catalog = data.catalogs.find(c => c.ref.catalogVersion === targetWorld.catalogRef.catalogVersion);invalid(catalog, 'CHECKPOINT_MISSING_ORIGINAL_CATALOG');
  const world = createWorldStateV3({...targetWorld, revision: data.current.world.revision + 1}, catalog), simulation = createSimulationStateV2({...targetSimulation, revision: data.current.simulation.revision + 1}, world);
  return validate({...data, current: {world, simulation, revisions: {worldRevision: world.revision, simulationRevision: simulation.revision}}, history: {...data.history, pointer: pointer + (operation === 'undo' ? -1 : 1)}});
}
