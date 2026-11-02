// KOR adapter: schema/CRS-label normalization only, with original coordinates retained.
import fs from 'node:fs';
import {createHash} from 'node:crypto';

const root = 'data/raw/prompt19/KOR/geoboundaries-9469f095';
const normalizedPath = 'data/raw/prompt19/KOR/normalized-boundaries.geojson';
const lockPath = 'data/source-locks/prompt19/KOR.json';
const pin = path => {const bytes = fs.readFileSync(path); return {path, sha256: createHash('sha256').update(bytes).digest('hex'), byteLength: bytes.length};};
for (const file of [normalizedPath, lockPath]) if (fs.existsSync(file)) throw Error(`Refusing to overwrite ${file}`);
const metadata = JSON.parse(fs.readFileSync(`${root}/metadata.json`));
const source = JSON.parse(fs.readFileSync(`${root}/source.geojson`));
const acquisition = JSON.parse(fs.readFileSync(`${root}/acquisition.json`));
if (metadata.boundaryID !== 'KOR-ADM3-71637012' || metadata.boundaryYear !== '2018' || metadata.boundaryType !== 'ADM3' ||
    metadata.boundaryLicense !== 'Korea Open Government License Type 1 (Source Indication)' ||
    source.crs?.properties?.name !== 'urn:ogc:def:crs:OGC:1.3:CRS84' || source.features.length !== Number(metadata.admUnitCount)) throw Error('Unexpected source version, CRS or license metadata');
const sourceId = 'geoboundaries-gbOpen-KOR-ADM3-2018';
const seen = new Set();
const normalized = {type: 'FeatureCollection', features: source.features.map(f => {
  if (f.properties.shapeGroup !== 'KOR' || f.properties.shapeType !== 'ADM3' || !f.properties.shapeID || seen.has(f.properties.shapeID)) throw Error('Invalid source country/level/identity');
  seen.add(f.properties.shapeID);
  return {type: 'Feature', properties: {countryId: 'KOR', sourceId, sourceFeatureId: f.properties.shapeID,
    sourceParentId: null, name: f.properties.shapeName || null, boundaryEvidenceRef: null}, geometry: f.geometry};
})};
fs.writeFileSync(normalizedPath, JSON.stringify(normalized) + '\n', {flag: 'wx'});
const sourceReceipt = acquisition.receipts.find(r => r.path === `${root}/source.geojson`);
const lock = {schemaVersion: 'prompt19-country-source-lock-v1', countryId: 'KOR', normalizedCrs: 'EPSG:4326', sources: [{
  sourceId, url: sourceReceipt.url, version: `${acquisition.revision}/KOR-ADM3-71637012`, publishedAt: null,
  retrievedAt: sourceReceipt.retrievedAt, boundaryBasis: 'administrative', adminLevel: 3,
  temporalCoverage: '2018; KoStat/SGIS-derived submunicipal boundaries, distributed as geoBoundaries gbOpen KOR ADM3.',
  scenarioDateCaveat: 'The game starts 2020-01-01. This acquired layer represents 2018, not an exact reconstruction of administrative changes through 2020. Source feature IDs are geoBoundaries shapeID, not guessed Korean administrative codes. Existing country envelope/coast/islands/shared border remain authoritative and alignment is independently tested.',
  originalCrs: 'OGC:CRS84 (longitude,latitude); equivalent 2D positions to EPSG:4326 under the contract axis order',
  license: {name: 'KOGL Type 1 (KoStat source); CC BY 4.0 (geoBoundaries derivative/distribution)', url: 'https://www.kogl.or.kr/info/license.do',
    attribution: 'Statistics Korea (KoStat), SGIS; Justin Meyers / southkorea-maps (2018 data); geoBoundaries / William & Mary geoLab, https://www.geoboundaries.org ; Runfola et al. (2020), doi:10.1371/journal.pone.0231866. Adapted to the game schema; no institutional endorsement implied.', redistributionAllowed: true}, artifact: pin(`${root}/source.geojson`),
}], normalizedInput: pin(normalizedPath), preprocessing: {
  description: 'Read the fixed geoBoundaries KOR ADM3 2018 GeoJSON; verify shapeGroup/shapeType/shapeID and CRS84; preserve every source geometry/coordinate/component/hole; map properties to the common schema. Original source administrative parent codes are unavailable, so sourceParentId is null. No clipping, simplification, snapping, grid, boundary filling or geometry repair in this adapter. The shared C-owned candidate engine performs all coarse-parent intersections and diagnostics.',
  code: [pin('scripts/prompt19/KOR/acquire-source.mjs'), pin('scripts/prompt19/KOR/normalize-source.mjs')],
}};
fs.mkdirSync('data/source-locks/prompt19', {recursive: true});
fs.writeFileSync(lockPath, JSON.stringify(lock, null, 2) + '\n', {flag: 'wx'});
console.log(JSON.stringify({features: normalized.features.length, normalized: pin(normalizedPath), sourceLock: pin(lockPath)}));
