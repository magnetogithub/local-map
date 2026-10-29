// Actual-source internal adjacency evidence, not a replacement for the failed clipped candidate.
import fs from 'node:fs';
import {gzipSync} from 'node:zlib';
import {performance} from 'node:perf_hooks';
import {createHash} from 'node:crypto';
import {normalizeGeometry, compareText} from '../../prompt14-catalog-core.mjs';
import {nodeCatalogBoundarySegments} from '../../prompt14-catalog-topology.mjs';

const start = performance.now(), inputPath = 'data/raw/prompt19/KOR/normalized-boundaries.geojson', inputBytes = fs.readFileSync(inputPath);
const input = JSON.parse(inputBytes), envelope = JSON.parse(fs.readFileSync('data/derived/prompt19/baseline-v1/country-envelopes.geojson')).features.find(f => f.properties.countryId === 'KOR');
const atoms = input.features.map((f, i) => ({canonicalAtomKey: f.properties.sourceFeatureId, geometry: normalizeGeometry(f.geometry),
  identity: {sourceCountryId: 'KOR', sourceFeatureId: f.properties.sourceFeatureId, inputRole: 'acquired-ADM3-diagnostic'}, members: [{featureIndex: i}]}));
const result = nodeCatalogBoundarySegments(atoms, {type: 'FeatureCollection', features: [envelope]}, console.log);
const pairs = new Map(), adjacency = new Map(atoms.map(a => [a.identity.sourceFeatureId, new Set()]));
let oneSidedSegments = 0, ambiguousSegments = 0, p0OnlySegments = 0;
const ambiguitySamples = [];
const lengthKm = (a, b) => {
  const rad = Math.PI / 180, h = Math.sin((b[1] - a[1]) * rad / 2) ** 2 + Math.cos(a[1] * rad) * Math.cos(b[1] * rad) * Math.sin((b[0] - a[0]) * rad / 2) ** 2;
  return 2 * 6371.0088 * Math.asin(Math.min(1, Math.sqrt(h)));
};
for (const e of result.segments.values()) {
  const owners = [...new Set([...e.left, ...e.right])];
  if (!owners.length) {p0OnlySegments++; continue;}
  if (owners.length === 1) {oneSidedSegments++; continue;}
  if (owners.length !== 2 || e.left.length !== 1 || e.right.length !== 1 || e.left[0] === e.right[0]) {
    ambiguousSegments++;
    if (ambiguitySamples.length < 12) ambiguitySamples.push({geometry: [e.a, e.b], sourceIds: owners.map(i => atoms[i].identity.sourceFeatureId)});
    continue;
  }
  const [leftSourceId, rightSourceId] = owners.map(i => atoms[i].identity.sourceFeatureId).sort(compareText), length = lengthKm(e.a, e.b);
  if (!(length > 0)) throw Error('ZERO_LENGTH_SOURCE_ADJACENCY');
  const key = `${leftSourceId}/${rightSourceId}`;
  const pair = pairs.get(key) ?? {leftSourceId, rightSourceId, lengthKm: 0, geometry: {type: 'MultiLineString', coordinates: []}};
  pair.lengthKm += length; pair.geometry.coordinates.push([e.a, e.b]); pairs.set(key, pair);
  adjacency.get(leftSourceId).add(rightSourceId); adjacency.get(rightSourceId).add(leftSourceId);
}
for (const [id, neighbors] of adjacency) for (const n of neighbors) if (n === id || !adjacency.get(n).has(id)) throw Error('ASYMMETRIC_SOURCE_ADJACENCY');
const graph = {countryId: 'KOR', authority: 'Actual ADM3 source feature identities only; not final clipped connected-cell IDs',
  source: {path: inputPath, sha256: createHash('sha256').update(inputBytes).digest('hex')},
  adjacency: Object.fromEntries([...adjacency].map(([id, ns]) => [id, [...ns].sort(compareText)])), edges: [...pairs.values()]};
const graphPath = 'reports/verification/prompt19/KOR/source-internal-adjacency.json.gz', bytes = gzipSync(Buffer.from(JSON.stringify(graph) + '\n'), {level: 9});
fs.writeFileSync(graphPath, bytes, {flag: 'wx'});
const report = {stage: '19-02A', sourceFeatures: atoms.length, positiveLengthAdjacencyPairs: pairs.size, oneSidedSegments, ambiguousSegments, ambiguitySamples,
  p0OnlySegments, symmetric: true, selfEdges: 0, pointContactUsedAsAdjacency: false, seaConnectionsInvented: false,
  graph: {path: graphPath, sha256: createHash('sha256').update(bytes).digest('hex'), byteLength: bytes.length},
  elapsedMs: performance.now() - start, maximumRssBytes: process.resourceUsage().maxRSS * 1024,
  candidateCoverageOrTopologyPass: false, limitations: 'One-sided and ambiguous segments remain diagnostics. Country envelope differs from the source. Recompute on connected clipped cells after C fixes the shared generator; this graph confers no gameplay/candidate-ready status.'};
fs.writeFileSync('reports/verification/prompt19/KOR/source-adjacency-verification.json', JSON.stringify(report, null, 2) + '\n', {flag: 'wx'});
console.log(JSON.stringify(report));
