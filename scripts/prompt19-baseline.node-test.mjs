// Read-only checks against the two-country baseline, not a world rollout/audit.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {gunzipSync} from 'node:zlib';
import {digest, jsonBytes} from './prompt14-catalog-core.mjs';

const root = 'data/derived/prompt19/baseline-v1';
const json = file => JSON.parse(fs.readFileSync(file));
const baseline = json(`${root}/baseline.json`), index = json(`${root}/artifact-index.json`);
test('every extracted baseline asset matches its byte pin and only KOR/PRK envelopes/parents are extracted', () => {
  for (const a of index.artifacts) {const bytes = fs.readFileSync(`${root}/${a.path}`); assert.equal(bytes.length, a.byteLength); assert.equal(digest(bytes), a.sha256);}
  const envelopes = json(`${root}/country-envelopes.geojson`), parents = json(`${root}/coarse-parents.geojson`);
  assert.deepEqual(envelopes.features.map(f => f.properties.countryId), ['KOR', 'PRK']);
  for (const countryId of ['KOR', 'PRK']) {
    const p0 = json('data/derived/prompt14/shared-game-p0.geojson').features.find(f => f.properties.countryId === countryId);
    assert.deepEqual(envelopes.features.find(f => f.properties.countryId === countryId).geometry, p0.geometry);
    const previous = JSON.parse(gunzipSync(fs.readFileSync(`data/derived/prompt19/coarse-world-v1/detail/countries/${countryId}.geojson.gz`)));
    const extracted = parents.features.filter(f => f.properties.countryId === countryId);
    assert.equal(extracted.length, previous.features.length);
    assert.deepEqual(extracted.map(f => f.geometry), previous.features.map(f => f.geometry));
  }
  assert.equal(parents.features.filter(f => f.properties.kind === 'country-envelope-residual').length, 1);
});
test('the three shared border chains retain exact current geometry and the raw component counts', () => {
  const shared = json(`${root}/national-boundaries.geojson`).features.filter(f => ['KOR', 'PRK'].includes(f.properties.leftCountryId) && ['KOR', 'PRK'].includes(f.properties.rightCountryId));
  assert.equal(shared.length, 3);
  assert.deepEqual(shared.map(f => ({id: f.id, geometrySha256: digest(jsonBytes(f.geometry))})), baseline.sharedBorder.identities);
  const previous = [];
  for (let i = 0; i < 8; i++) previous.push(...JSON.parse(gunzipSync(fs.readFileSync(`data/derived/prompt19/coarse-world-v1/detail/topology/${String(i).padStart(3, '0')}.json.gz`))).edges);
  for (const f of shared) assert.deepEqual(f.geometry, previous.find(e => e.id === f.id).geometry);
  assert.equal(baseline.countries.KOR.components, 53); assert.equal(baseline.countries.PRK.components, 10);
});
