import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import test from 'node:test';
import {prompt19SourceLockSchema} from '../../prompt19-country-core.mjs';
import {validatePolygonFeatureCollection, CANONICAL_P0_VALIDATOR_POLICY} from '../../prompt14-source-gate.mjs';

const root = 'data/raw/prompt19/KOR/geoboundaries-adm2-2020-9469f095';
const read = path => JSON.parse(fs.readFileSync(path));
const raw = read(`${root}/source.geojson`);
const normalized = read(`${root}/normalized-boundaries.geojson`);
const lock = read('data/source-locks/prompt19/KOR-ADM2-2020.json');
const report = read('reports/maintenance/20261029-kor-adm2-source-verification.json');
const checkPin = pin => {
  const bytes = fs.readFileSync(pin.path);
  assert.equal(bytes.length, pin.byteLength, pin.path);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), pin.sha256, pin.path);
};

test('the ADM2 lock uses the fixed acquired source and current adapter bytes', () => {
  assert.equal(prompt19SourceLockSchema.safeParse(lock).success, true);
  assert.equal(lock.sources.length, 1);
  assert.equal(lock.sources[0].adminLevel, 2);
  assert.equal(lock.sources[0].sourceId, 'geoboundaries-gbOpen-KOR-ADM2-2020');
  checkPin(lock.sources[0].artifact);
  checkPin(lock.normalizedInput);
  lock.preprocessing.code.forEach(checkPin);
  read(`${root}/acquisition.json`).receipts.forEach(checkPin);
});

test('all actual ADM2 features retain source identities, coordinates, components and holes', () => {
  assert.equal(raw.features.length, 228);
  assert.equal(normalized.features.length, raw.features.length);
  assert.equal(raw.crs.properties.name, 'urn:ogc:def:crs:OGC:1.3:CRS84');
  const ids = new Set();
  for (const [i, feature] of raw.features.entries()) {
    const result = normalized.features[i];
    assert.equal(feature.properties.shapeGroup, 'KOR');
    assert.equal(feature.properties.shapeType, 'ADM2');
    assert.equal(result.properties.sourceFeatureId, feature.properties.shapeID);
    assert.equal(result.properties.sourceParentId, null);
    assert.equal(result.properties.countryId, 'KOR');
    assert.deepEqual(result.geometry, feature.geometry);
    ids.add(result.properties.sourceFeatureId);
  }
  assert.equal(ids.size, raw.features.length);
});

test('the published metadata discrepancy is disclosed instead of inventing a missing district', () => {
  assert.equal(read(`${root}/metadata.json`).admUnitCount, '229');
  assert.equal(report.sourceCount, 228);
  assert.equal(report.metadataCount, 229);
  assert.equal(report.metadataCountMatches, false);
  assert.match(lock.sources[0].scenarioDateCaveat, /229.*228/);
  assert.equal(report.geometry.sourceRepairApplied, false);
});

test('the new actual source passes a fresh polygon validity scan', () => {
  const validity = validatePolygonFeatureCollection(normalized, 'KOR ADM2 source regression', CANONICAL_P0_VALIDATOR_POLICY);
  assert.equal(validity.pass, true, validity.errors.slice(0, 3).join('; '));
  assert.deepEqual(validity.counts, {features:228,polygons:389,rings:389,vertices:25818,polygon:207,multiPolygon:21});
});

