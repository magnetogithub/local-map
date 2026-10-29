import fs from 'node:fs';
import {normalizeGeometry, geometryMetadata} from '../../prompt14-catalog-core.mjs';
import {validatePolygonFeatureCollection, CANONICAL_P0_VALIDATOR_POLICY} from '../../prompt14-source-gate.mjs';

const raw = JSON.parse(fs.readFileSync('data/raw/prompt19/KOR/normalized-boundaries.geojson'));
const input = {type: 'FeatureCollection', features: raw.features.map(f => ({...f, geometry: normalizeGeometry(f.geometry)}))};
const validity = validatePolygonFeatureCollection(input, 'KOR ADM3 2018 acquired source', CANONICAL_P0_VALIDATOR_POLICY);
const totals = input.features.reduce((n, f) => {const m = geometryMetadata(f.geometry); return {features: n.features + 1, components: n.components + m.components,
  holes: n.holes + m.holes, vertices: n.vertices + m.vertices};}, {features: 0, components: 0, holes: 0, vertices: 0});
const report = {stage: '19-02A', countryId: 'KOR', sourceValidity: validity, totals, coordinateChanges: 0,
  normalizedGeometryPolicy: 'Ring orientation/start and component ordering only. Source bytes remain preserved.'};
fs.mkdirSync('reports/verification/prompt19/KOR', {recursive: true});
fs.writeFileSync('reports/verification/prompt19/KOR/source-inspection.json', JSON.stringify(report, null, 2) + '\n', {flag: 'wx'});
console.log(JSON.stringify({pass: validity.pass, totals, errors: validity.errors.slice(0, 10), errorCount: validity.errors.length}));
if (!validity.pass) process.exitCode = 2;
