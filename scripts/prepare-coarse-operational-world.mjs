// Prompt 19-01: package the existing coarse polygons; never subdivide geography.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {gzipSync} from 'node:zlib';
import geojsonvt from 'geojson-vt';
import {fromGeojsonVt} from '@maplibre/vt-pbf';

const version = 'catalog-v3-prompt19-coarse-v1';
const schemaVersion = 'operational-world-delivery-v2';
const base = 'data/catalogs/prompt14/catalog-v1-73e30c25c9637d6376cb65afa82483c6';
const source = `${base}/build-only/${path.basename(base)}`;
const output = 'data/derived/prompt19/coarse-world-v1';
const json = value => Buffer.from(`${JSON.stringify(value)}\n`);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const inputs = [`${source}/catalog.json`, `${source}/geometry.geojson`, `${source}/topology.json`,
  `${base}/migration-pair.json`, 'data/raw/ne_10m_admin_1_states_provinces.geojson',
  'data/source-locks/prompt14-derived-game-input-lock.json'];
const identities = inputs.map(file => {const bytes = fs.readFileSync(file); return {path: file, sha256: sha(bytes), byteLength: bytes.length};});
const inputRoot = sha(json(identities));
if (fs.existsSync(output)) throw Error(`Immutable output already exists: ${output}. Use its recorded artifacts; do not overwrite.`);
const artifacts = [];
function write(file, value, raw = false) {
  let bytes = raw ? value : json(value);
  if (file.endsWith('.gz')) bytes = gzipSync(bytes, {level: 9});
  const target = path.join(output, file);
  fs.mkdirSync(path.dirname(target), {recursive: true}); fs.writeFileSync(target, bytes, {flag: 'wx'});
  const identity = {path: file, sha256: sha(bytes), byteLength: bytes.length}; artifacts.push(identity); return identity;
}
const catalog = read(`${source}/catalog.json`), geometry = read(`${source}/geometry.geojson`), topology = read(`${source}/topology.json`);
const ordinal = new Map(catalog.territoryOrder.map((id, i) => [id, i + 1]));
const entries = new Map(catalog.entries.map(entry => [entry.id, entry]));
const countryOrder = [...new Set(catalog.entries.map(e => e.sourceCountryId))].sort();
const features = geometry.features.map(f => ({type: 'Feature', id: ordinal.get(f.properties.territoryId), properties: {}, geometry: f.geometry}));
if (features.some((f, i) => f.id !== i + 1)) throw Error('Coarse geometry/order mismatch');
const names = new Map(read(inputs[4]).features.map(f => [String(f.properties.ne_id), f.properties]));
const administrative = [], previous = [], rows = [], metrics = [];
for (const [i, id] of catalog.territoryOrder.entries()) {
  const e = entries.get(id), n = i + 1;
  const provenance = e.provenanceIds.map(p => catalog.provenanceById[p]).find(p => p.sourceId === 'natural-earth-admin1-states-provinces-10m');
  const sourceFeatureId = provenance?.sourceFeatureId ?? null;
  const p = sourceFeatureId ? names.get(sourceFeatureId) : null;
  administrative.push({parentKey: `coarse:${e.sourceCountryId}:${sourceFeatureId ?? id.slice(-64)}`, sourceCountryId: e.sourceCountryId,
    kind: p ? 'administrative' : 'country-envelope-residual', adminId: sourceFeatureId, name: p?.name_en ?? p?.name ?? e.sourceCountryId,
    sourceFeatureId, sourceVersion: provenance?.sourceVersion ?? null, restorationId: sourceFeatureId, residualId: p ? null : id.slice(-64), start: i, count: 1});
  previous.push({oldTerritoryId: id, sourceCountryId: e.sourceCountryId, start: i, count: 1});
  rows.push([n, id, n, n]);
  const [west, south, east, north] = e.bbox;
  const diameterKm = Math.max(0.001, Math.hypot((east - west) * Math.cos(e.centroid[1] * Math.PI / 180), north - south) * 111.195);
  const polygons = features[i].geometry.type === 'Polygon' ? [features[i].geometry.coordinates] : features[i].geometry.coordinates;
  // Spherical ring area; the coarse source's existing geometry is kept verbatim.
  const ringArea = ring => Math.abs(ring.slice(1).reduce((sum, b, j) => {
    const a = ring[j]; return sum + (b[0] - a[0]) * Math.PI / 180 * (2 + Math.sin(a[1] * Math.PI / 180) + Math.sin(b[1] * Math.PI / 180));
  }, 0) * 6371.0088 ** 2 / 2);
  const areaKm2 = Math.max(0, polygons.reduce((sum, polygon) => sum + ringArea(polygon[0]) - polygon.slice(1).reduce((s, r) => s + ringArea(r), 0), 0));
  metrics.push({id, sourceCountryId: e.sourceCountryId, centroid: e.centroid, areaKm2, diameterKm});
}
if (new Set(administrative.map(p => p.parentKey)).size !== administrative.length) throw Error('Duplicate coarse parent');
const distances = coordinates => coordinates.slice(1).reduce((sum, b, i) => {
  const a = coordinates[i], rad = Math.PI / 180, dy = (b[1] - a[1]) * rad, dx = (b[0] - a[0]) * rad;
  const h = Math.sin(dy / 2) ** 2 + Math.cos(a[1] * rad) * Math.cos(b[1] * rad) * Math.sin(dx / 2) ** 2;
  return sum + 2 * 6371.0088 * Math.asin(Math.min(1, Math.sqrt(h)));
}, 0);
const edges = topology.edges.map((e, i) => {
  const left = ordinal.get(e.leftTerritoryId), right = ordinal.get(e.rightTerritoryId) ?? 0;
  const country = right > 0 && entries.get(e.leftTerritoryId).sourceCountryId !== entries.get(e.rightTerritoryId).sourceCountryId;
  const boundaryClass = !right ? 'coast' : country ? 'country' : e.boundaryClass === 'administrative' ? 'administrative' : 'residual';
  return {id: `edge:operational:${sha(json(['prompt19-coarse', e.id]))}`, ordinal: i + 1, left, right,
    lengthKm: distances(e.geometry.coordinates), boundaryClass,
    flags: {positiveAdjacency: right > 0, country, administrative: boundaryClass === 'administrative', previous: right > 0, residual: boundaryClass === 'residual'}, geometry: e.geometry};
});
if (edges.some(e => !e.left || e.left === e.right || !(e.lengthKm > 0))) throw Error('Invalid coarse edge');
const counts = {countries: countryOrder.length, cells: rows.length, edges: edges.length, administrativeParents: administrative.length, previousParents: previous.length};
const adjacency = Array.from({length: rows.length}, () => new Set());
for (const e of edges) if (e.right) {adjacency[e.left - 1].add(e.right); adjacency[e.right - 1].add(e.left);}
const offsets = [0], neighbors = [];
for (const values of adjacency) {neighbors.push(...[...values].sort((a, b) => a - b)); offsets.push(neighbors.length);}
write('adjacency.json.gz', {cellCount: rows.length, offsets, neighbors});
write('metrics.json.gz', metrics);
write('region-names.json.gz', Object.fromEntries([...new Set(administrative.map(p => p.sourceFeatureId).filter(Boolean))].map(id => [id, names.get(id)])));
write('metadata/parents.json.gz', {administrative, previous});
const countries = [];
for (const countryId of countryOrder) {
  const countryRows = rows.filter(r => entries.get(r[1]).sourceCountryId === countryId);
  const ids = new Set(countryRows.map(r => r[0]));
  const metadata = write(`metadata/countries/${countryId}.json.gz`, {countryId, columns: ['cellOrdinal', 'cellId', 'administrativeOrdinal', 'previousParentOrdinal'], rows: countryRows});
  const detail = write(`detail/countries/${countryId}.geojson.gz`, {type: 'FeatureCollection', features: features.filter(f => ids.has(f.id))});
  countries.push({countryId, cellCount: countryRows.length, metadata, detail});
}
const edgeDetails = [];
for (let start = 0; start < edges.length; start += 2048) {
  const shard = `topology/${String(edgeDetails.length).padStart(3, '0')}.json.gz`, selected = edges.slice(start, start + 2048);
  const artifact = write(`detail/${shard}`, {schemaVersion, edges: selected});
  edgeDetails.push({shard, firstOrdinal: start + 1, count: selected.length, artifact});
}
const incidence = Buffer.alloc(edges.length * 8);
edges.forEach((e, i) => {incidence.writeUInt32LE(e.left, i * 8); incidence.writeUInt32LE(e.right, i * 8 + 4);});
const edgeIncidence = write('metadata/edge-incidence.bin.gz', incidence, true);
const options = {maxZoom: 6, indexMaxZoom: 4, indexMaxPoints: 100000, tolerance: 1, extent: 4096, buffer: 64, generateId: false};
const fc = values => ({type: 'FeatureCollection', features: values});
const classes = ['coast', 'country', 'administrative', 'operational', 'residual'];
const cellIndex = geojsonvt(fc(features), options);
const edgeIndex = geojsonvt(fc(edges.map(e => ({type: 'Feature', id: e.ordinal, properties: {c: classes.indexOf(e.boundaryClass), a: Number(e.flags.administrative)}, geometry: e.geometry}))), options);
const tiles = [], seenCells = new Set(), seenEdges = new Set();
for (let z = 0; z <= 6; z++) {
  console.log(`Packaging coarse tiles z${z}`);
  for (let x = 0; x < 2 ** z; x++) for (let y = 0; y < 2 ** z; y++) {
    const cells = cellIndex.getTile(z, x, y), lines = edgeIndex.getTile(z, x, y), layers = {};
    if (cells?.features.length) {layers.territories = cells; cells.features.forEach(f => seenCells.add(f.id));}
    if (lines?.features.length) {
      layers.edges = lines; lines.features.forEach(f => seenEdges.add(f.id));
      const admin = lines.features.filter(f => f.tags.a === 1);
      if (z >= 4 && admin.length) layers.administrative = {features: admin};
    }
    tiles.push(write(`tiles/${z}/${x}/${y}.pbf.gz`, Buffer.from(fromGeojsonVt(layers, {version: 2, extent: 4096})), true));
  }
}
write('lod-coverage.json.gz', {schemaVersion, cellCount: rows.length, edgeCount: edges.length, exactCells: rows.length, exactEdges: edges.length,
  missingOverviewCellOrdinals: rows.map(r => r[0]).filter(n => !seenCells.has(n)), missingOverviewEdgeOrdinals: edges.map(e => e.ordinal).filter(n => !seenEdges.has(n))});
const ref = {catalogVersion: version, geometryRoot: identities[1].sha256, topologyRoot: sha(json(edges)),
  renderArtifactRoot: sha(json(artifacts)), catalogOrderRoot: sha(json(catalog.territoryOrder)),
  administrativeMembershipRoot: sha(json(administrative)), previousParentRoot: sha(json(previous))};
const descriptor = {schemaVersion: 'operational-catalog-v1', catalogRef: {catalogVersion: version, geometryRoot: ref.geometryRoot,
  topologyRoot: ref.topologyRoot, renderArtifactRoot: ref.renderArtifactRoot, manifestPath: `/data/territory-catalog/${version}/manifest.json`},
  indexRoots: {catalogOrder: ref.catalogOrderRoot, administrativeMembership: ref.administrativeMembershipRoot, previousParent: ref.previousParentRoot}, counts, countryOrder};
const tileIndex = write('tile-index.json', {schemaVersion, ref, artifacts: tiles});
const detailIndex = write('detail-index.json', {schemaVersion, ref, countries, edgeDetails, parents: 'metadata/parents.json.gz', lodCoverage: 'lod-coverage.json.gz', lazy: true});
write('manifest.json', {schemaVersion, ref, counts, sourceId: 'world-operational-catalog', minZoom: 0, maxZoom: 6, promoteId: null,
  tileTemplate: 'tiles/{z}/{x}/{y}.pbf.gz', tileIndex, detailIndex, policy: {tileTransport: {compression: 'gzip', httpContentEncoding: null}, administrativeMinZoom: 4, operationalMinZoom: 8},
  edgeIncidence: {format: 'uint32-le-pairs', recordBytes: 8, recordCount: edges.length, decodedByteLength: incidence.length, artifact: edgeIncidence},
  runtimeRegeneration: false, attribution: 'Natural Earth (public domain). Existing coarse country and administrative territory polygons; Prompt 19-01.'});
write('catalog.json', descriptor);
write('provenance.json', {stage: '19-01', inputRoot, inputs: identities, method: 'Verbatim existing coarse polygons/topology; no grid or polygon subdivision.', compatibility: 'New games only; old operational catalog sessions are rejected.'});
artifacts.sort((a, b) => a.path.localeCompare(b.path));
const indexBytes = json({schemaVersion, artifacts: [...artifacts], totalByteLength: artifacts.reduce((n, a) => n + a.byteLength, 0)});
fs.writeFileSync(path.join(output, 'artifact-index.json'), indexBytes, {flag: 'wx'});
const pointer = {catalogVersion: version, root: output, index: {sha256: sha(indexBytes), byteLength: indexBytes.length}};
fs.mkdirSync('data/runtime/operational-catalog', {recursive: true});
fs.writeFileSync('data/runtime/operational-catalog/current.json', json(pointer));
console.log(JSON.stringify({output, ...pointer, counts, deliveredBytes: artifacts.reduce((n, a) => n + a.byteLength, 0)}));
