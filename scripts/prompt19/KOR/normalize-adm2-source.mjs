// KOR ADM2 adapter. Property normalization only; source coordinates are preserved.
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {prompt19SourceLockSchema} from '../../prompt19-country-core.mjs';
import {validatePolygonFeatureCollection, CANONICAL_P0_VALIDATOR_POLICY} from '../../prompt14-source-gate.mjs';

const root = 'data/raw/prompt19/KOR/geoboundaries-adm2-2020-9469f095';
const normalizedPath = `${root}/normalized-boundaries.geojson`;
const lockPath = 'data/source-locks/prompt19/KOR-ADM2-2020.json';
const reportPath = 'reports/maintenance/20261029-kor-adm2-source-verification.json';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const pin = path => {const bytes = fs.readFileSync(path); return {path, sha256: sha(bytes), byteLength: bytes.length};};
for (const target of [normalizedPath, lockPath, reportPath]) if (fs.existsSync(target)) throw Error(`Refusing to overwrite ${target}`);
const metadata = JSON.parse(fs.readFileSync(`${root}/metadata.json`));
const source = JSON.parse(fs.readFileSync(`${root}/source.geojson`));
const acquisition = JSON.parse(fs.readFileSync(`${root}/acquisition.json`));
for (const receipt of acquisition.receipts) {
  const actual = pin(receipt.path);
  if (actual.sha256 !== receipt.sha256 || actual.byteLength !== receipt.byteLength) throw Error(`Acquired bytes changed: ${receipt.path}`);
}
if (metadata.boundaryID !== 'KOR-ADM2-91817680' || metadata.boundaryYear !== '2020' || metadata.boundaryType !== 'ADM2' ||
    metadata.boundaryLicense !== 'Creative Commons Attribution 3.0 License' ||
    source.crs?.properties?.name !== 'urn:ogc:def:crs:OGC:1.3:CRS84' || source.features.length !== 228 ||
    Number(metadata.admUnitCount) !== 229) throw Error('Unexpected fixed source identity, CRS, license metadata or known count discrepancy');
const citation = fs.readFileSync(`${root}/citation-and-use.txt`, 'utf8');
if (!citation.includes('Attribution 4.0 International (CC BY 4.0)') || !citation.includes('Attribution is required')) throw Error('Missing geoBoundaries distribution license');
const sourceId = 'geoboundaries-gbOpen-KOR-ADM2-2020';
const seen = new Set();
const normalized = {type: 'FeatureCollection', features: source.features.map(f => {
  if (f.properties.shapeGroup !== 'KOR' || f.properties.shapeType !== 'ADM2' || !f.properties.shapeID || seen.has(f.properties.shapeID)) throw Error('Invalid source country/level/identity');
  seen.add(f.properties.shapeID);
  return {type: 'Feature', properties: {countryId: 'KOR', sourceId, sourceFeatureId: f.properties.shapeID,
    sourceParentId: null, name: f.properties.shapeName || null, boundaryEvidenceRef: null}, geometry: f.geometry};
})};
const validity = validatePolygonFeatureCollection(normalized, 'KOR-ADM2-2020-original', CANONICAL_P0_VALIDATOR_POLICY);
if (!validity.pass) throw Error(`Invalid original geometry: ${validity.errors.slice(0, 3).join('; ')}`);
const coordinateIdentity = source.features.every((f, i) => JSON.stringify(f.geometry) === JSON.stringify(normalized.features[i].geometry));
if (!coordinateIdentity) throw Error('Original source geometry changed during normalization');
const ringArea = ring => Math.abs(ring.slice(1).reduce((sum, b, i) => {const a = ring[i]; return sum + (b[0]-a[0])*Math.PI/180*(2+Math.sin(a[1]*Math.PI/180)+Math.sin(b[1]*Math.PI/180));}, 0) * 6371.0088**2/2);
const areas = source.features.map(f => (f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates)
  .reduce((sum, polygon) => sum + ringArea(polygon[0]) - polygon.slice(1).reduce((n, ring) => n + ringArea(ring), 0), 0)).sort((a,b) => a-b);
fs.writeFileSync(normalizedPath, JSON.stringify(normalized) + '\n', {flag: 'wx'});
const sourceReceipt = acquisition.receipts.find(r => r.path === `${root}/source.geojson`);
const lock = prompt19SourceLockSchema.parse({schemaVersion: 'prompt19-country-source-lock-v1', countryId: 'KOR', normalizedCrs: 'EPSG:4326', sources: [{
  sourceId, url: sourceReceipt.url, version: `${acquisition.revision}/KOR-ADM2-91817680/228-actual-features`, publishedAt: null,
  retrievedAt: sourceReceipt.retrievedAt, boundaryBasis: 'administrative', adminLevel: 2,
  temporalCoverage: '2020 as represented by geoBoundaries KOR ADM2; Si/Kun districts and city districts. Fixed GeoJSON has 228 features although its metadata states 229.',
  scenarioDateCaveat: 'Year 2020 is the source-represented year, not certification of exact boundaries on 2020-01-01. Metadata reports 229 units but the fixed published GeoJSON contains 228; no missing polygon or parent identity is guessed. Fixed game country/coast/island/shared-border envelopes remain authoritative. Source outside the envelope and uncovered baseline residuals require independent reporting.',
  originalCrs: 'OGC:CRS84 (longitude,latitude); equivalent 2D positions to EPSG:4326 under the contract axis order',
  license: {name: 'CC BY 3.0 as designated in geoBoundaries dataset metadata; CC BY 4.0 geoBoundaries derivative/distribution',
    url: 'https://creativecommons.org/licenses/by/3.0/',
    attribution: 'geoBoundaries / William & Mary geoLab, https://www.geoboundaries.org ; source credited as geoBoundaries and Thomas Brinkhoff / City Population, https://www.citypopulation.de/en/southkorea/admin/ ; Runfola et al. (2020), doi:10.1371/journal.pone.0231866. Adapted to the game schema; no institutional endorsement implied.',
    redistributionAllowed: true}, artifact: pin(`${root}/source.geojson`),
}], normalizedInput: pin(normalizedPath), preprocessing: {
  description: 'Fixed geoBoundaries KOR ADM2 2020 source, 228 actual features versus 229 in upstream metadata. Preserve all source coordinates/components/holes and IDs. Only property names and CRS labels are normalized. Source parent codes are absent, so sourceParentId is null. No dissolve, clipping, simplification, snapping, filling, repair or invented boundary. Shared candidate engine performs alignment separately. Distribution license is from geoBoundaries citation/metadata, not inferred from City Population population-data terms.',
  code: [pin('scripts/prompt19/KOR/acquire-adm2-source.mjs'), pin('scripts/prompt19/KOR/normalize-adm2-source.mjs')],
}});
fs.mkdirSync('data/source-locks/prompt19', {recursive: true});
fs.writeFileSync(lockPath, JSON.stringify(lock, null, 2) + '\n', {flag: 'wx'});
const report = {
  date: '2026-10-29', sourceLock: pin(lockPath), original: pin(`${root}/source.geojson`), normalized: pin(normalizedPath),
  sourceCount: source.features.length, metadataCount: Number(metadata.admUnitCount), metadataCountMatches: false,
  discrepancy: 'Preserve all 228 published features. The source says 229 in metadata; no unprovided 229th unit is invented. Candidate/catalog counts must use actual geometry.',
  geometry: {originalCoordinatesPreserved: coordinateIdentity, validity, sourceRepairApplied: false},
  sourceAreaKm2: {count: areas.length, total: areas.reduce((a,b)=>a+b,0), mean: areas.reduce((a,b)=>a+b,0)/areas.length,
    min: areas[0], p50: areas[Math.floor((areas.length-1)/2)], p95: areas[Math.floor((areas.length-1)*.95)], max: areas.at(-1)},
  licenseEvidence: {metadata: pin(`${root}/metadata.json`), citation: pin(`${root}/citation-and-use.txt`), upstreamTerms: pin(`${root}/upstream-terms-of-use.html`),
    determination: 'Use geoBoundaries published CC BY 4.0 derivative/distribution and dataset-designated CC BY 3.0 with source attribution. City Population terms separately reserve geospatial copyright; their population-data CC BY statement is not treated as a geospatial grant.',
    sourceUrls: acquisition.receipts.map(r=>({path:r.path,url:r.url,finalUrl:r.finalUrl}))},
  limits: ['No runtime publication by this adapter.', 'No source-faithful completion claim for later joint arrangement.', 'The source count mismatch remains disclosed.', 'Year 2020 is not exact game-start boundary certification.'],
  externalAiRequests: 0,
};
fs.mkdirSync('reports/maintenance', {recursive: true});
fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n', {flag: 'wx'});
console.log(JSON.stringify({sourceCount: report.sourceCount, metadataCount: report.metadataCount, coordinateIdentity,
  validityPass: validity.pass, sourceAreaKm2: report.sourceAreaKm2, normalizedPath, lockPath, reportPath}));

