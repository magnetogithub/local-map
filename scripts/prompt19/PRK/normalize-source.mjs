// Offline PRK adapter: preserve acquired ADM2 geometry and original feature identity.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {digest, jsonBytes} from '../../prompt14-catalog-core.mjs';
import {prompt19SourceLockSchema} from '../../prompt19-country-core.mjs';

export const SOURCE_ID = 'geoboundaries-gbOpen-PRK-ADM2-82179303';
export const SOURCE_SHA256 = '4265ce501c4402a8bafdc27298c8462e41ed6f3170d50624503c3770b8ce91e9';
export const SOURCE_BYTES = 1694102;
const rawRoot = 'data/raw/prompt19/PRK';
const sourcePath = `${rawRoot}/geoBoundaries-PRK-ADM2.geojson`;
const normalizedPath = `${rawRoot}/normalized-adm2.geojson`;
const adapterPath = 'scripts/prompt19/PRK/normalize-source.mjs';
export const SOURCE_URL = 'https://media.githubusercontent.com/media/wmgeolab/geoBoundaries/9469f09/releaseData/gbOpen/PRK/ADM2/geoBoundaries-PRK-ADM2.geojson';
export const ATTRIBUTION = 'DPR Korea administrative boundaries: World Food Programme, OCHA ROAP; distributed by geoBoundaries, gbOpen PRK ADM2 PRK-ADM2-82179303, revision 9469f09. CC BY 3.0 IGO, https://creativecommons.org/licenses/by/3.0/igo/. Original: https://data.humdata.org/dataset/dpr-korea-administrative-boundaries. Changes: properties normalized; candidate generation intersects original components with pinned project coarse parents; no source coordinates moved.';

export function normalizeSource(bytes) {
  if (bytes.length !== SOURCE_BYTES || digest(bytes) !== SOURCE_SHA256) throw Error('PRK_SOURCE_IDENTITY');
  const source = JSON.parse(bytes);
  if (source.type !== 'FeatureCollection' || source.features.length !== 179 || source.crs?.properties?.name !== 'urn:ogc:def:crs:OGC:1.3:CRS84') throw Error('PRK_SOURCE_SCHEMA');
  const ids = new Set();
  const features = source.features.map(f => {
    const p = f.properties;
    if (p.shapeGroup !== 'PRK' || p.shapeType !== 'ADM2' || typeof p.shapeID !== 'string' || !p.shapeID || ids.has(p.shapeID)
      || !['Polygon', 'MultiPolygon'].includes(f.geometry?.type)) throw Error('PRK_FEATURE_IDENTITY');
    ids.add(p.shapeID);
    return {type: 'Feature', properties: {countryId: 'PRK', sourceId: SOURCE_ID, sourceFeatureId: p.shapeID,
      sourceParentId: null, name: p.shapeName || null, boundaryEvidenceRef: null}, geometry: f.geometry};
  });
  // CRS84 and EPSG:4326 use the same WGS84 coordinate values; GeoJSON stays longitude,latitude.
  // No ADM1 parent is present in this release: do not invent one from a name or centroid.
  return {type: 'FeatureCollection', features};
}

function writeStable(root, relative, bytes) {
  const target = path.join(root, relative);
  if (fs.existsSync(target)) {
    if (!fs.readFileSync(target).equals(bytes)) throw Error(`PRK_REFUSE_OVERWRITE: ${relative}`);
  } else fs.writeFileSync(target, bytes, {flag: 'wx'});
}
export function prepareSource(root = process.cwd()) {
  const sourceBytes = fs.readFileSync(path.join(root, sourcePath));
  const normalized = normalizeSource(sourceBytes);
  writeStable(root, normalizedPath, jsonBytes(normalized));
  const identity = relative => {const bytes = fs.readFileSync(path.join(root, relative)); return {path: relative, sha256: digest(bytes), byteLength: bytes.length};};
  const lock = prompt19SourceLockSchema.parse({schemaVersion: 'prompt19-country-source-lock-v1', countryId: 'PRK', normalizedCrs: 'EPSG:4326',
    sources: [{sourceId: SOURCE_ID, url: SOURCE_URL, version: 'geoBoundaries gbOpen PRK-ADM2-82179303 / revision 9469f09 / build 2023-12-12',
      publishedAt: null, retrievedAt: '2026-10-29T04:51:48Z', boundaryBasis: 'administrative', adminLevel: 2,
      temporalCoverage: 'gbOpen metadata: 2019 represented; related gbHumanitarian WFP/HDX metadata: 2013 represented. Underlying survey/geometry vintage unresolved.',
      scenarioDateCaveat: 'Not an exact reconstruction or certification of 2020-01-01. Metadata years conflict (gbOpen 2019 vs gbHumanitarian 2013); build date 2023-12-12 is a distribution date, not boundary effective date.',
      originalCrs: 'OGC:CRS84 (WGS84 longitude,latitude); values unchanged for EPSG:4326 GeoJSON',
      license: {name: 'Creative Commons Attribution 3.0 IGO (CC BY 3.0 IGO)', url: 'https://creativecommons.org/licenses/by/3.0/igo/', attribution: ATTRIBUTION, redistributionAllowed: true},
      artifact: identity(sourcePath)}],
    normalizedInput: identity(normalizedPath), preprocessing: {description: 'Retain all 179 original shapeID feature identities and all polygon coordinates/components/holes unchanged. Map shapeName to name; sourceParentId=null because no native ADM1 field is supplied. CRS84 WGS84 values require no numeric conversion. Common pinned generator alone intersects coarse parents. No simplification, snap, repair, synthetic fill, global IDs or publication.', code: [identity(adapterPath)]}});
  writeStable(root, 'data/source-locks/prompt19/PRK.json', jsonBytes(lock));
  return {features: normalized.features.length, source: identity(sourcePath), normalized: identity(normalizedPath), lock: identity('data/source-locks/prompt19/PRK.json')};
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) console.log(JSON.stringify(prepareSource()));
