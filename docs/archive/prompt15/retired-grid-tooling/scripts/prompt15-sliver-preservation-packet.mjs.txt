import {gzipSync, gunzipSync} from 'node:zlib';
import {jsonBytes} from './prompt14-catalog-core.mjs';

export const PACKET_VERSION = 'prompt15-sliver-preservation-packet-v2';
const requiredInput = ['countryId', 'envelope', 'parents', 'previousParents', 'cells', 'expectedCells', 'sourceIdentities',
  'administrativeMembership', 'previousMembership', 'incidentEdges', 'assembly', 'historicalGeneration', 'historyRole', 'historicalCurrentCounts'];
const runtimeFields = ['cellMeta', 'adjacency', 'tinySourceComponents', 'previousMetricEvidence'];
const identityFields = ['id', 'sourceCountryId', 'parentKey', 'adminId', 'parentSourceFeatureId', 'oldTerritoryId', 'componentIndex', 'sourceComponentHash'];
const fail = (where, message) => {throw Error(`Audit packet ${where}: ${message}`);};
const check = (value, where, message) => {if (!value) fail(where, message);};
const own = (value, key) => Object.hasOwn(value, key);
function plain(value, where) {
  check(value && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value)), where, 'plain object required');
}
export function assertWireValue(value, where = '$') {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {check(Number.isFinite(value), where, 'non-finite number'); return;}
  if (Array.isArray(value)) {for (let i = 0; i < value.length; i++) {check(own(value, i), `${where}[${i}]`, 'array hole'); assertWireValue(value[i], `${where}[${i}]`);} return;}
  if (typeof value !== 'object') fail(where, `non-wire ${typeof value}`);
  if (value instanceof Map || value instanceof Set) fail(where, `non-wire ${value.constructor.name}`);
  plain(value, where);
  for (const [key, child] of Object.entries(value)) assertWireValue(child, `${where}.${key}`);
}
function need(value, keys, where) {for (const key of keys) check(own(value, key), `${where}.${key}`, 'required field missing');}
function ordinal(value, capacity, where, zero = false) {check(Number.isSafeInteger(value) && value >= (zero ? 0 : 1) && value <= capacity, where, 'invalid global ordinal');}
function pairs(value, where, keyCheck) {
  check(Array.isArray(value), where, 'Map entry array required'); const out = new Map();
  value.forEach((row, i) => {check(Array.isArray(row) && row.length === 2, `${where}[${i}]`, 'two-item Map entry required'); keyCheck(row[0], `${where}[${i}][0]`); check(!out.has(row[0]), `${where}[${i}][0]`, 'duplicate Map key'); out.set(row[0], row[1]);}); return out;
}
export const PACKET_CONTRACT = Object.freeze({schemaVersion: PACKET_VERSION,
  required: ['schemaVersion', 'cellOrdinalCapacity', 'edgeOrdinalCapacity', 'input', 'cellContext', 'selection', 'supplement', 'originalSix', 'unchangedFromBaseline', 'historicalCurrentCounts'],
  requiredInput, runtimeFields,
  cellMeta: 'Excluded, never undefined/null in wire input. Reconstructed from unique complete global cellContext identities.',
  adjacency: 'Owned-country entries of the runtime Map only; every neighbor and global identity retained; no truncation.',
  tinySourceComponents: 'All Set items in an array; unique strings; restored as Set.',
  previousMetricEvidence: 'null = absent, [] = present empty Map, entry array = present complete Map. No evidence entry discarded.',
  selection: 'null = no selection; actual plain selection record otherwise.', originalSix: 'null = absent; original record otherwise.',
  unsupported: 'Any remaining undefined/function/Map/Set/nonfinite/nonplain value is rejected with its exact field path.',
  verdicts: 'Transport never changes strict/v2/development meanings or numeric worker exit.'});

export function validateWirePacket(packet) {
  assertWireValue(packet); plain(packet, '$'); need(packet, PACKET_CONTRACT.required, '$');
  check(packet.schemaVersion === PACKET_VERSION, '$.schemaVersion', 'unsupported packet schema');
  for (const key of Object.keys(packet)) check(PACKET_CONTRACT.required.includes(key), `$.${key}`, 'unknown packet field');
  ordinal(packet.cellOrdinalCapacity, 0xffffffff, '$.cellOrdinalCapacity'); ordinal(packet.edgeOrdinalCapacity, 0xffffffff, '$.edgeOrdinalCapacity');
  const input = packet.input; plain(input, '$.input'); need(input, [...requiredInput, ...runtimeFields.filter(k => k !== 'cellMeta')], '$.input');
  for (const key of Object.keys(input)) check([...requiredInput, ...runtimeFields.filter(k => k !== 'cellMeta')].includes(key), `$.input.${key}`, 'unknown wire input field');
  check(typeof input.countryId === 'string' && input.countryId.length > 0, '$.input.countryId', 'country identity required');
  for (const key of ['parents', 'previousParents', 'cells', 'expectedCells', 'sourceIdentities', 'administrativeMembership', 'previousMembership', 'incidentEdges', 'historicalCurrentCounts']) check(Array.isArray(input[key]), `$.input.${key}`, 'array required');
  plain(input.assembly, '$.input.assembly');
  check(input.cells.length > 0 && Array.isArray(packet.cellContext), '$.cellContext', 'nonempty own cells and context required');
  const context = new Map(), byId = new Set();
  packet.cellContext.forEach((cell, i) => {
    const at = `$.cellContext[${i}]`; plain(cell, at); need(cell, ['ordinal', ...identityFields], at); ordinal(cell.ordinal, packet.cellOrdinalCapacity, `${at}.ordinal`);
    check(!context.has(cell.ordinal) && typeof cell.id === 'string' && cell.id && !byId.has(cell.id), at, 'duplicate/missing global cell identity');
    for (const k of ['sourceCountryId', 'parentKey', 'parentSourceFeatureId', 'oldTerritoryId', 'sourceComponentHash']) check(typeof cell[k] === 'string' && cell[k], `${at}.${k}`, 'source/parent identity required');
    check(Number.isSafeInteger(cell.componentIndex) && cell.componentIndex >= 0 && (cell.adminId === null || typeof cell.adminId === 'string'), at, 'invalid component/admin identity');
    context.set(cell.ordinal, cell); byId.add(cell.id);
  });
  const ownCells = new Map();
  input.cells.forEach((cell, i) => {
    ordinal(cell.ordinal, packet.cellOrdinalCapacity, `$.input.cells[${i}].ordinal`); const c = context.get(cell.ordinal);
    check(c && !ownCells.has(cell.ordinal) && c.sourceCountryId === input.countryId && identityFields.every(k => cell[k] === c[k]), `$.input.cells[${i}]`, 'missing/duplicate/mismatched own global identity'); ownCells.set(cell.ordinal, cell);
  });
  const expected = new Set(); input.expectedCells.forEach((c, i) => {check(ownCells.get(c.ordinal)?.id === c.id && !expected.has(c.ordinal), `$.input.expectedCells[${i}]`, 'unknown/duplicate expected global identity'); expected.add(c.ordinal);});
  check(expected.size === ownCells.size, '$.input.expectedCells', 'incomplete expected cells');
  const edges = new Set(); input.incidentEdges.forEach((edge, i) => {
    const at = `$.input.incidentEdges[${i}]`; ordinal(edge.ordinal, packet.edgeOrdinalCapacity, `${at}.ordinal`); ordinal(edge.left, packet.cellOrdinalCapacity, `${at}.left`); ordinal(edge.right, packet.cellOrdinalCapacity, `${at}.right`, true);
    check(!edges.has(edge.ordinal) && context.has(edge.left) && (!edge.right || context.has(edge.right)) && (ownCells.has(edge.left) || ownCells.has(edge.right)), at, 'duplicate edge or missing incident counterpart context'); edges.add(edge.ordinal);
  });
  const adjacency = pairs(input.adjacency, '$.input.adjacency', (o, at) => ordinal(o, packet.cellOrdinalCapacity, at));
  check(adjacency.size === ownCells.size && [...ownCells.keys()].every(o => adjacency.has(o)), '$.input.adjacency', 'complete owned-cell adjacency required');
  for (const [o, neighbors] of adjacency) {check(ownCells.has(o) && Array.isArray(neighbors) && new Set(neighbors).size === neighbors.length, `$.input.adjacency.${o}`, 'invalid owned adjacency');
    for (const n of neighbors) {ordinal(n, packet.cellOrdinalCapacity, `$.input.adjacency.${o}`); check(n !== o && context.has(n), `$.input.adjacency.${o}`, 'missing counterpart identity');}}
  for (const [key, descriptor, identity] of [['administrativeMembership', 'parents', 'parentKey'], ['previousMembership', 'previousParents', 'oldTerritoryId']]) {
    const known = new Set(input[descriptor].map(p => p[identity])), seen = new Set(), groups = new Set();
    input[key].forEach((p, i) => {const at = `$.input.${key}[${i}]`; check(known.has(p[identity]) && !groups.has(p[identity]) && Array.isArray(p.cellOrdinals), at, 'unknown/duplicate parent reference'); groups.add(p[identity]);
      if (own(p, 'count')) check(p.count === p.cellOrdinals.length, `${at}.count`, 'truncated membership');
      for (const o of p.cellOrdinals) {ordinal(o, packet.cellOrdinalCapacity, `${at}.cellOrdinals`); check(ownCells.get(o)?.[identity] === p[identity] && !seen.has(o), `${at}.cellOrdinals`, 'missing/duplicate/wrong parent cell'); seen.add(o);}});
    check(seen.size === ownCells.size && groups.size === known.size, `$.input.${key}`, 'incomplete parent membership');
  }
  check(Array.isArray(input.tinySourceComponents) && new Set(input.tinySourceComponents).size === input.tinySourceComponents.length && input.tinySourceComponents.every(x => typeof x === 'string' && x), '$.input.tinySourceComponents', 'unique Set item array required');
  if (input.previousMetricEvidence !== null) pairs(input.previousMetricEvidence, '$.input.previousMetricEvidence', (key, at) => check(typeof key === 'string' && input.previousParents.some(p => p.oldTerritoryId === key), at, 'unknown previous metric parent'));
  if (packet.selection !== null) plain(packet.selection, '$.selection'); if (packet.originalSix !== null) plain(packet.originalSix, '$.originalSix');
  check(Array.isArray(packet.supplement) && (!packet.supplement.length || packet.selection !== null), '$.supplement', 'selection required for supplementary debt');
  check(typeof packet.unchangedFromBaseline === 'boolean' && packet.unchangedFromBaseline === input.assembly.catalogAndGeometryByteIdenticalToBaseline, '$.unchangedFromBaseline', 'assembly scope mismatch');
  check(jsonBytes(packet.historicalCurrentCounts).equals(jsonBytes(input.historicalCurrentCounts)), '$.historicalCurrentCounts', 'historical/current count evidence mismatch');
  return packet;
}
export function encodeCountryPacket(input, {selection = null, supplement = [], originalSix = null, cellOrdinalCapacity, edgeOrdinalCapacity}) {
  plain(input, '$.input'); need(input, [...requiredInput, 'cellMeta', 'adjacency', 'tinySourceComponents'], '$.input');
  check(typeof input.cellMeta === 'function', '$.input.cellMeta', 'runtime lookup function required');
  check(input.adjacency instanceof Map, '$.input.adjacency', 'runtime Map required'); check(input.tinySourceComponents instanceof Set, '$.input.tinySourceComponents', 'runtime Set required');
  check(input.previousMetricEvidence == null || input.previousMetricEvidence instanceof Map, '$.input.previousMetricEvidence', 'optional runtime Map required');
  const {cellMeta, adjacency, tinySourceComponents, previousMetricEvidence, ...plainInput} = input;
  const owned = new Set(input.cells.map(c => c.ordinal)), selectedAdjacency = [...adjacency].filter(([o]) => owned.has(o));
  const referenced = new Set([...owned, ...input.incidentEdges.flatMap(e => [e.left, e.right]).filter(Boolean), ...selectedAdjacency.flatMap(([, neighbors]) => neighbors)]);
  const cellContext = [...referenced].sort((a, b) => a - b).map(o => {ordinal(o, cellOrdinalCapacity, `$.cellContext.ordinal(${o})`); const c = cellMeta(o); check(c && c.ordinal === o, `$.cellContext.ordinal(${o})`, 'missing global lookup reference'); return c;});
  return validateWirePacket({schemaVersion: PACKET_VERSION, cellOrdinalCapacity, edgeOrdinalCapacity,
    input: {...plainInput, adjacency: selectedAdjacency, tinySourceComponents: [...tinySourceComponents], previousMetricEvidence: previousMetricEvidence == null ? null : [...previousMetricEvidence]},
    cellContext, selection: selection ?? null, supplement, originalSix: originalSix ?? null,
    unchangedFromBaseline: input.assembly.catalogAndGeometryByteIdenticalToBaseline, historicalCurrentCounts: input.historicalCurrentCounts});
}
export function decodeCountryPacket(wire) {
  validateWirePacket(wire); const context = new Map(wire.cellContext.map(c => [c.ordinal, c]));
  return {...wire, input: {...wire.input, cellMeta: o => context.get(o), adjacency: new Map(wire.input.adjacency),
    tinySourceComponents: new Set(wire.input.tinySourceComponents), previousMetricEvidence: wire.input.previousMetricEvidence === null ? undefined : new Map(wire.input.previousMetricEvidence)}};
}
export const packetGzip = wire => {validateWirePacket(wire); return gzipSync(jsonBytes(wire), {level: 1, mtime: 0});};
export const packetGunzip = bytes => decodeCountryPacket(JSON.parse(gunzipSync(bytes)));
