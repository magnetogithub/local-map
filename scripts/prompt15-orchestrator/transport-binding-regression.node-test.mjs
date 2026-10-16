import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {gunzipSync} from 'node:zlib';
import {identity} from './verification-stages.mjs';

// An independent reviewer supplies two already pinned packages and their
// authoritative binding. Both packages share read-only country assets.
const fixturePath = process.env.PROMPT15_TRANSPORT_REGRESSION_FIXTURE;
if (!fixturePath) throw Error('Specify PROMPT15_TRANSPORT_REGRESSION_FIXTURE; a missing required regression is not a skip');
const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
const verify = async pin => assert.deepEqual(await identity(path.resolve(pin.path)), pin, 'Regression fixture bytes changed');
await verify(fixture.consumer); await verify(fixture.authoritativeBinding);
for (const packageFixture of [fixture.normal, fixture.malformed]) await verify(packageFixture.root);
const {openTransportCountry} = await import(pathToFileURL(fixture.consumer.path).href);
const expected = JSON.parse(fs.readFileSync(fixture.authoritativeBinding.path, 'utf8'));
const open = packageFixture => openTransportCountry(packageFixture.directory,
  {...packageFixture.root, path: path.relative(packageFixture.directory, packageFixture.root.path).replaceAll('\\', '/')}, fixture.country);

test('normal compressed transport binding matches the independently pinned source', () => {
  const actual = open(fixture.normal).readCompleteBinding().binding;
  assert.deepEqual(actual.cellHashes, expected.cellHashes); assert.deepEqual(actual.edgeRows, expected.edgeRows);
});

test('the actual consumer rejects re-pinned binding ordinal and edge-side corruption', async () => {
  // Establish that this is a real semantic mutation with valid package hashes,
  // rather than a missing file, parse error or stale-pin negative test.
  const descriptor = JSON.parse(fs.readFileSync(fixture.malformed.root.path, 'utf8')).countries.find(country => country.country === fixture.country);
  await verify({...descriptor.binding, path: path.resolve(fixture.malformed.directory, descriptor.binding.path)});
  const malformed = JSON.parse(gunzipSync(fs.readFileSync(path.resolve(fixture.malformed.directory, descriptor.binding.path)), {maxOutputLength: 8 * 1024 * 1024}));
  assert.deepEqual(malformed.roots, expected.roots); assert.equal(malformed.cellHashes.length, expected.cellHashes.length); assert.equal(malformed.edgeRows.length, expected.edgeRows.length);
  assert.notDeepEqual(malformed.cellHashes, expected.cellHashes); assert.notDeepEqual(malformed.edgeRows, expected.edgeRows);
  const consumer = open(fixture.malformed);
  assert.throws(() => consumer.readCompleteBinding(), /binding|source|ordinal|identity|semantic/i,
    'The real consumer accepted incorrect binding contents with valid re-pinned hashes');
});
