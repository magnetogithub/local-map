import fs from 'node:fs';
import path from 'node:path';
import {compareText, digest, jsonBytes} from './prompt14-catalog-core.mjs';
import {CELL_EXPERIMENT_POLICY as POLICY} from './prompt15-cell-policy.mjs';
import {boundaryIndex, boundaryMatch, canonicalSegment, comparePoint, geometrySegmentRecords, makeEdge,
  segmentBucket, segmentKey, TOPOLOGY_BUCKETS, validateMembershipIndexes} from './prompt15-world-indices-core.mjs';
import {nodeUnpairedBuckets} from './prompt15-r3-edge-noding.mjs';
import {assert, countryAssets} from './prompt15-sliver-indices-adapter.mjs';

export const SCHEMA = 'prompt15-sliver-adoption-indices-draft-v1';
function csr(groups, metadata) {
  const parents = [], cellOrdinals = [];
  for (const key of [...groups.keys()].sort(compareText)) {
    const ordinals = groups.get(key).sort((a, b) => a - b);
    parents.push({...metadata(key), start: cellOrdinals.length, count: ordinals.length});
    for (const ordinal of ordinals) cellOrdinals.push(ordinal);
  }
  return {parents, cellOrdinals};
}
export function buildMembership(cells, parentEvidence, oldParents) {
  const admin = new Map(), old = new Map(), seen = new Set();
  for (const [i, cell] of cells.entries()) {
    assert(cell.ordinal === i + 1 && !seen.has(cell.id), 'Duplicate ID or stale/local world ordinal'); seen.add(cell.id);
    const parent = parentEvidence.get(cell.parentKey), previous = oldParents.get(cell.oldTerritoryId);
    assert(parent && previous && parent.sourceCountryId === cell.sourceCountryId && parent.adminId === cell.adminId &&
      parent.sourceFeatureId === cell.parentSourceFeatureId && previous.properties.sourceCountryId === cell.sourceCountryId,
    `Invalid membership parent ${cell.id}`);
    for (const [map, key] of [[admin, cell.parentKey], [old, cell.oldTerritoryId]]) {
      const list = map.get(key) ?? []; list.push(i + 1); map.set(key, list);
    }
  }
  const administrative = {schemaVersion: SCHEMA, cellCount: cells.length, ...csr(admin, key => parentEvidence.get(key))};
  const previous = {schemaVersion: SCHEMA, cellCount: cells.length, ...csr(old, key => ({oldTerritoryId: key,
    sourceCountryId: oldParents.get(key).properties.sourceCountryId, approvedGeometryHash: digest(jsonBytes(oldParents.get(key).geometry))}))};
  const oldOrdinal = new Map(previous.parents.map((p, i) => [p.oldTerritoryId, i + 1]));
  previous.oldParentOrdinalByCell = cells.map(c => oldOrdinal.get(c.oldTerritoryId));
  const adminOrdinal = new Map(administrative.parents.map((p, i) => [p.parentKey, i + 1]));
  administrative.parentOrdinalByCell = cells.map(c => adminOrdinal.get(c.parentKey));
  const audit = validateMembership(cells, administrative, previous);
  assert(audit.pass, `Membership structural failure: ${audit.errors.join(',')}`);
  return {administrative, previous, audit};
}
export function validateMembership(cells, administrative, previous) {
  const result = validateMembershipIndexes(cells, administrative, previous);
  const keys = new Set();
  for (const [i, cell] of cells.entries()) {
    if (cell.ordinal !== i + 1 || keys.has(cell.id) || i > 0 && compareText(cells[i - 1].id, cell.id) >= 0) result.errors.push('world-cell-id-or-ordinal'); keys.add(cell.id);
    const p = administrative.parents[administrative.parentOrdinalByCell?.[i] - 1];
    if (!p || p.parentKey !== cell.parentKey) result.errors.push('administrative-forward-mapping');
  }
  result.errors = [...new Set(result.errors)]; result.pass = result.errors.length === 0; return result;
}
export function sourceSupport(a, b, originalA, originalB, limit = 1e-12) {
  const dx = originalB[0] - originalA[0], dy = originalB[1] - originalA[1], length = Math.hypot(dx, dy);
  if (!(length > 0) || !(Math.hypot(b[0] - a[0], b[1] - a[1]) > 0)) return false;
  for (const p of [a, b]) {
    const distance = Math.abs((p[0] - originalA[0]) * dy - (p[1] - originalA[1]) * dx) / length;
    const along = ((p[0] - originalA[0]) * dx + (p[1] - originalA[1]) * dy) / length;
    if (distance > limit || along < -limit || along > length + limit) return false;
  }
  return true;
}
function mapCutRanges(geometries) {
  const result = new Map();
  for (const [id, geometry] of geometries) {
    const records = geometrySegmentRecords({geometry}, 1).filter(r => r[4]);
    result.set(id, records);
  }
  return result;
}
function cutSupported(a, b, id, marker, ranges) {
  const vertical = a[0] === b[0], low = Math.min(a[vertical ? 1 : 0], b[vertical ? 1 : 0]), high = Math.max(a[vertical ? 1 : 0], b[vertical ? 1 : 0]);
  const intervals = (ranges.get(id) ?? []).filter(r => r[4] === marker).map(r => [Math.min(r[0][vertical ? 1 : 0], r[1][vertical ? 1 : 0]), Math.max(r[0][vertical ? 1 : 0], r[1][vertical ? 1 : 0])]).sort((x, y) => x[0] - y[0]);
  let cursor = low;
  for (const [lo, hi] of intervals) if (lo <= cursor + 1e-12 && hi > cursor) cursor = hi;
  return cursor >= high - 1e-12 && intervals.length > 0;
}
export function pairOccurrences(group, cells) {
  const {a, b, records} = group, unique = new Set(records.map(r => `${r[2]}:${r[3]}:${r[4]}`));
  assert(unique.size === records.length, 'Duplicate edge occurrence', group);
  for (const r of records) assert(Number.isInteger(r[2]) && r[2] >= 1 && r[2] <= cells.length &&
    sourceSupport(a, b, r[5], r[6]), 'Invalid edge owner or source segment support', {segment: [a, b], record: r});
  assert(records.length <= 2 && records.length > 0, 'Ambiguous edge owners', group);
  if (records.length === 2) {
    assert(records[0][2] !== records[1][2] && records[0][3] !== records[1][3], 'Same-direction or repeated owner edge', group);
    return {left: records.find(r => r[3] === 0)[2], right: records.find(r => r[3] === 1)[2], a, b};
  }
  return {left: records[0][2], right: 0, a: records[0][3] === 0 ? a : b, b: records[0][3] === 0 ? b : a};
}
const pushCsr = lists => {
  const offsets = [0], values = [];
  for (const list of lists) {for (const v of [...new Set(list)].sort((a, b) => Math.abs(a) - Math.abs(b))) values.push(v); offsets.push(values.length);}
  return {offsets, values};
};
export function buildTopology({context, cells, countryOrder, work, emit, partial = false, progress = console.log}) {
  assert(!fs.existsSync(work), 'Refusing existing topology work output'); fs.mkdirSync(work, {recursive: true});
  const raw = path.join(work, 'raw'), noded = path.join(work, 'noded'); fs.mkdirSync(raw);
  const byId = new Map(cells.map(c => [c.id, c.ordinal])), geometrySeen = new Uint8Array(cells.length + 1);
  const fds = Array.from({length: TOPOLOGY_BUCKETS}, (_, i) => fs.openSync(path.join(raw, `${i}.ndjson`), 'wx'));
  const vertices = new Set(); let sourceVertexOccurrences = 0, sourceSegments = 0;
  try {
    for (const [ci, country] of countryOrder.entries()) {
      const collection = context.featuresForCountry ? context.featuresForCountry(country) : countryAssets(context, country).geometry;
      assert(collection.features.length <= POLICY.budgets.countryCells, `Country cell cap ${country}`);
      const buffers = Array.from({length: TOPOLOGY_BUCKETS}, () => []);
      for (const feature of collection.features) {
        const ordinal = byId.get(feature.properties.cellId);
        assert(ordinal && !geometrySeen[ordinal] && cells[ordinal - 1].sourceCountryId === country, 'Unknown/duplicate geometry cell', feature.properties);
        assert(feature.geometry.type === 'Polygon', 'Operational cell must be one Polygon component'); geometrySeen[ordinal] = 1;
        for (const ring of feature.geometry.coordinates) sourceVertexOccurrences += ring.length - 1;
        for (const record of geometrySegmentRecords(feature, ordinal)) {
          const augmented = [record[0], record[1], record[2], record[3], record[4] ?? null, record[0], record[1]];
          buffers[segmentBucket(segmentKey(record[0], record[1]))].push(JSON.stringify(augmented) + '\n'); sourceSegments++;
        }
      }
      for (let i = 0; i < TOPOLOGY_BUCKETS; i++) if (buffers[i].length) fs.writeSync(fds[i], buffers[i].join(''));
      progress(JSON.stringify({stage: 'segments', country, completed: ci + 1, countries: countryOrder.length, sourceSegments, rssBytes: process.memoryUsage().rss}));
    }
  } finally {for (const fd of fds) fs.closeSync(fd);}
  assert(geometrySeen.reduce((a, b) => a + b, 0) === cells.length, 'Geometry cell omissions');
  assert(sourceVertexOccurrences <= POLICY.budgets.worldVertices && cells.length <= POLICY.budgets.worldCells, 'Cell/vertex cap exceeded');
  const noding = nodeUnpairedBuckets(raw, noded); assert(noding.pass, 'Topology noding displacement exceeded frozen contract', noding); global.gc?.();
  const p0Index = boundaryIndex(context.p0), selectedCountries = new Set(countryOrder);
  const p0Cuts = mapCutRanges(context.p0.features.map(f => [f.properties.countryId, f.geometry]));
  const oldCuts = mapCutRanges([...context.oldParents].map(([id, f]) => [id, f.geometry]));
  const parentCuts = mapCutRanges([...context.approvedParents].map(([id, f]) => [id, f.geometry]));
  const adjacency = Array.from({length: cells.length}, () => []), incidence = Array.from({length: cells.length}, () => []);
  const classes = {coast: 0, country: 0, administrative: 0, residual: 0, operational: 0};
  const mapCuts = {polarClosure: 0, longitudeOpenClosure: 0, longitudeSelfClosure: 0, longitudeAdjacency: 0};
  const changedCrossBorder = []; let edgeCount = 0, pairedSegments = 0, externalContextEdges = 0;
  const validateCut = (group, record) => {
    const cell = cells[record[2] - 1], marker = record[4];
    assert(cutSupported(group.a, group.b, cell.sourceCountryId, marker, p0Cuts) &&
      cutSupported(group.a, group.b, cell.oldTerritoryId, marker, oldCuts) &&
      cutSupported(group.a, group.b, cell.parentKey, marker, parentCuts), 'Unsupported map-cut source owner', {group, cell});
  };
  for (let bucket = 0; bucket < TOPOLOGY_BUCKETS; bucket++) {
    const groups = new Map();
    for (const line of fs.readFileSync(path.join(noded, `${bucket}.ndjson`), 'utf8').split('\n')) if (line) {
      const record = JSON.parse(line), key = segmentKey(record[0], record[1]), group = groups.get(key) ?? {a: record[0], b: record[1], records: []};
      group.records.push(record); groups.set(key, group);
    }
    const edges = [], support = [];
    for (const group of [...groups.values()].sort((x, y) => comparePoint(x.a, y.a) || comparePoint(x.b, y.b))) {
      let periodic = false;
      if (group.a[1] === group.b[1] && Math.abs(group.a[1]) === 90) {
        for (const r of group.records) {assert(r[4] === `pole:${group.a[1]}`, 'Polar marker mismatch'); validateCut(group, r);}
        mapCuts.polarClosure++; continue;
      }
      if (group.a[0] === -180 && group.b[0] === -180) {
        const negative = group.records.filter(r => r[4] === '-180'), positive = group.records.filter(r => r[4] === '180');
        assert(negative.length + positive.length === group.records.length, 'Longitude marker mismatch');
        for (const r of group.records) validateCut(group, r);
        if (!negative.length || !positive.length) {assert(group.records.length === 1, 'Ambiguous open map cut'); mapCuts.longitudeOpenClosure++; continue;}
        assert(negative.length === 1 && positive.length === 1, 'Ambiguous periodic pair');
        if (negative[0][2] === positive[0][2]) {mapCuts.longitudeSelfClosure++; continue;}
        group.records = [negative[0].slice(), positive[0].slice()]; group.records[0][3] = 0; group.records[1][3] = 1;
        periodic = true; mapCuts.longitudeAdjacency++;
      }
      const pair = pairOccurrences(group, cells);
      const edge = makeEdge(cells, pair.left, pair.right, pair.a, pair.b, edgeCount + 1);
      let contextOpen = false;
      if (!periodic && (!edge.right || edge.boundaryClass === 'country')) {
        for (const owner of [edge.left, edge.right].filter(Boolean)) {
          const cell = cells[owner - 1], match = boundaryMatch(group.a, group.b, cell.sourceCountryId, p0Index);
          const other = cells[(owner === edge.left ? edge.right : edge.left) - 1];
          assert(match.pass && (!other || match.neighbors.includes(other.sourceCountryId)), 'Edge is outside fixed country boundary support', {edge, owner, match: {pass: match.pass, gapDegrees: match.gapDegrees, neighbors: match.neighbors}});
          if (!other && match.neighbors.length) {
            assert(partial && match.neighbors.every(c => !selectedCountries.has(c)), 'Unpaired land border', {edge, sourceNeighbors: match.neighbors}); contextOpen = true;
          }
        }
      }
      if (contextOpen) externalContextEdges++;
      edgeCount++; assert(edgeCount <= POLICY.budgets.worldEdges, 'World edge cap exceeded'); classes[edge.boundaryClass]++;
      for (const p of edge.geometry.coordinates) vertices.add(`${p[0]},${p[1]}`);
      incidence[edge.left - 1].push(edgeCount);
      if (edge.right) {
        incidence[edge.right - 1].push(-edgeCount); adjacency[edge.left - 1].push(edge.right); adjacency[edge.right - 1].push(edge.left); pairedSegments++;
        const l = cells[edge.left - 1], r = cells[edge.right - 1];
        if (edge.boundaryClass === 'country' && (context.selected?.get(l.sourceCountryId)?.selectedGeometryReplacementRequired || context.selected?.get(r.sourceCountryId)?.selectedGeometryReplacementRequired))
          changedCrossBorder.push({edgeOrdinal: edge.ordinal, leftCountry: l.sourceCountryId, rightCountry: r.sourceCountryId, leftCellId: l.id, rightCellId: r.id});
      }
      edges.push(edge); support.push({edgeOrdinal: edge.ordinal, periodic, externalContext: contextOpen,
        owners: group.records.map(r => ({ordinal: r[2], side: r[3], mapCut: r[4], sourceSegment: [r[5], r[6]]}))});
    }
    emit(`topology/${String(bucket).padStart(3, '0')}.json.gz`, {schemaVersion: SCHEMA, bucket, edges});
    emit(`source-support/${String(bucket).padStart(3, '0')}.json.gz`, {schemaVersion: SCHEMA, bucket, support});
    progress(JSON.stringify({stage: 'topology', completedBuckets: bucket + 1, buckets: TOPOLOGY_BUCKETS, edgeCount, rssBytes: process.memoryUsage().rss}));
    if ((bucket + 1) % 16 === 0) global.gc?.();
  }
  assert(vertices.size <= POLICY.budgets.worldVertices, 'World unique topology vertex cap exceeded');
  const adj = pushCsr(adjacency), inc = pushCsr(incidence);
  return {adjacency: {schemaVersion: SCHEMA, cellCount: cells.length, offsets: adj.offsets, neighbors: adj.values,
    adjacencyPairs: adj.values.length / 2}, incidence: {schemaVersion: SCHEMA, cellCount: cells.length, offsets: inc.offsets, signedEdges: inc.values,
    convention: 'Positive = left owner, negative = right owner. Absolute value is NEW global edge ordinal.'},
    counts: {cells: cells.length, edges: edgeCount, topologyVertices: vertices.size, sourceVertexOccurrences, pairedSegments,
      adjacencyPairs: adj.values.length / 2, incidenceReferences: inc.values.length, isolatedCells: adjacency.filter(x => !x.length).length, ...classes},
    noding, mapCuts, externalContextEdges, changedCrossBorder};
}
