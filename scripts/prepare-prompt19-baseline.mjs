// C-owned extraction only: pin existing envelopes/parents/seams without new subdivision.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {gunzipSync} from 'node:zlib';
import {digest, jsonBytes, geometryMetadata} from './prompt14-catalog-core.mjs';

export const PROMPT19_BASELINE_ROOT = 'data/derived/prompt19/baseline-v1';
export function preparePrompt19Baseline(root = process.cwd()) {
  const output = path.join(root, PROMPT19_BASELINE_ROOT);
  if (fs.existsSync(output)) throw Error('PROMPT19_BASELINE_ALREADY_EXISTS');
  const read = file => fs.readFileSync(path.join(root, file));
  const inputs = [];
  const checked = (file, pin) => {
    const bytes = read(file), identity = {path: file, sha256: digest(bytes), byteLength: bytes.length};
    if (pin && (identity.sha256 !== pin.sha256 || identity.byteLength !== pin.byteLength)) throw Error(`PROMPT19_BASELINE_IDENTITY: ${file}`);
    inputs.push(identity); return JSON.parse(file.endsWith('.gz') ? gunzipSync(bytes) : bytes);
  };
  const pointer = checked('data/runtime/operational-catalog/current.json');
  if (pointer.catalogVersion !== 'catalog-v3-prompt19-coarse-v1' || pointer.root !== 'data/derived/prompt19/coarse-world-v1') throw Error('PROMPT19_REQUIRES_COARSE_WORLD');
  const index = checked(`${pointer.root}/artifact-index.json`, pointer.index);
  const pinned = file => checked(`${pointer.root}/${file}`, index.artifacts.find(a => a.path === file) ?? (() => {throw Error('MISSING_BASELINE_PIN');})());
  const catalog = pinned('catalog.json'), parents = pinned('metadata/parents.json.gz'), detail = pinned('detail-index.json');
  const sourceLock = checked('data/source-locks/prompt14-derived-game-input-lock.json');
  const envelopePath = 'data/derived/prompt14/shared-game-p0.geojson';
  const envelopePin = sourceLock.artifacts.find(a => a.repositoryPath === envelopePath);
  if (!envelopePin) throw Error('MISSING_PROMPT19_ENVELOPE_PIN');
  const p0 = checked(envelopePath, envelopePin);
  const countries = ['KOR', 'PRK'], selected = new Set(countries), coarse = [], sourceByOrdinal = new Map(), summaries = {};
  // The small metadata table includes neighboring countries needed to label national seams.
  for (const c of detail.countries) {
    const metadata = pinned(c.metadata.path);
    // Other countries are read only from their compressed rows, never polygon payloads.
    for (const row of metadata.rows) sourceByOrdinal.set(row[0], c.countryId);
    if (!selected.has(c.countryId)) continue;
    const exact = pinned(c.detail.path), rows = new Map(metadata.rows.map(r => [r[0], r]));
    for (const f of exact.features) {
      const row = rows.get(f.id), parent = parents.administrative[row[2] - 1];
      coarse.push({type: 'Feature', id: row[1], properties: {countryId: c.countryId, coarseTerritoryId: row[1],
        parentKey: parent.parentKey, kind: parent.kind, name: parent.name, sourceFeatureId: parent.sourceFeatureId}, geometry: f.geometry});
    }
    summaries[c.countryId] = {coarseTerritories: exact.features.length};
  }
  const national = [];
  for (const shard of detail.edgeDetails) for (const e of pinned(shard.artifact.path).edges) {
    const leftCountryId = sourceByOrdinal.get(e.left), rightCountryId = sourceByOrdinal.get(e.right);
    if (e.right && e.boundaryClass === 'country' && (selected.has(leftCountryId) || selected.has(rightCountryId))) {
      national.push({type: 'Feature', id: e.id, properties: {baselineEdgeId: e.id, leftCountryId, rightCountryId, lengthKm: e.lengthKm}, geometry: e.geometry});
    }
  }
  const envelopes = {type: 'FeatureCollection', features: countries.map(countryId => {
    const f = p0.features.find(f => f.properties.countryId === countryId);
    if (!f) throw Error('MISSING_PROMPT19_ENVELOPE');
    summaries[countryId] = {...summaries[countryId], ...geometryMetadata(f.geometry)};
    return {type: 'Feature', id: countryId, properties: {countryId}, geometry: f.geometry};
  })};
  fs.mkdirSync(output, {recursive: true});
  const artifacts = [];
  const write = (file, value) => {const bytes = jsonBytes(value); fs.writeFileSync(path.join(output, file), bytes, {flag: 'wx'});
    const a = {path: file, sha256: digest(bytes), byteLength: bytes.length}; artifacts.push(a); return a;};
  write('country-envelopes.geojson', envelopes);
  write('coarse-parents.geojson', {type: 'FeatureCollection', features: coarse});
  write('national-boundaries.geojson', {type: 'FeatureCollection', features: national});
  const shared = national.filter(f => selected.has(f.properties.leftCountryId) && selected.has(f.properties.rightCountryId));
  write('baseline.json', {schemaVersion: 'prompt19-boundary-baseline-v1', catalogRef: catalog.catalogRef, countries: summaries,
    sharedBorder: {chains: shared.length, lengthKm: shared.reduce((n, f) => n + f.properties.lengthKm, 0),
      identities: shared.map(f => ({id: f.id, geometrySha256: digest(jsonBytes(f.geometry))}))},
    coordinateSystem: 'EPSG:4326', axisOrder: 'longitude,latitude', inputs});
  const indexBytes = jsonBytes({schemaVersion: 'prompt19-boundary-baseline-v1', artifacts});
  fs.writeFileSync(path.join(output, 'artifact-index.json'), indexBytes, {flag: 'wx'});
  return {root: PROMPT19_BASELINE_ROOT, index: {sha256: digest(indexBytes), byteLength: indexBytes.length}, countries: summaries, sharedBorderChains: shared.length};
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) console.log(JSON.stringify(preparePrompt19Baseline()));
