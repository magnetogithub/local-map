const fs = require('node:fs'), cp = require('node:child_process'), assert = require('node:assert/strict');
const dir = 'reports/chn-source-rebuild-20261103', fixtures = dir + '/packager-fixtures';
fs.mkdirSync(fixtures, {recursive: true});
const sourceProducer = 'chn-internal-line-source-producer-v1', sourceProof = 'chn-internal-line-source-independent-v1';
const rejected = [
  ['unknown-and-missing', {pass: true, schemaVersion: 'unknown'}, {pass: true}],
  ['both-missing', {pass: true}, {pass: true}],
  ['source-with-old-proof', {pass: true, schemaVersion: sourceProducer}, {pass: true, schemaVersion: 'chn-internal-line-lod-independent-v1'}],
  ['old-with-source-proof', {pass: true, schemaVersion: 'chn-internal-line-lod-producer-v1'}, {pass: true, schemaVersion: sourceProof}],
  ['source-with-curve-proof', {pass: true, schemaVersion: sourceProducer}, {pass: true, schemaVersion: 'chn-internal-line-curves-independent-v1'}],
  ['curve-with-source-proof', {pass: true, schemaVersion: 'chn-internal-line-curves-producer-v1'}, {pass: true, schemaVersion: sourceProof}],
  ['failed-producer', {pass: false, schemaVersion: sourceProducer}, {pass: true, schemaVersion: sourceProof}],
  ['failed-proof', {pass: true, schemaVersion: sourceProducer}, {pass: false, schemaVersion: sourceProof}],
];
for (const [name, producer, proof] of rejected) {
  const a = `${fixtures}/${name}-producer.json`, b = `${fixtures}/${name}-proof.json`;
  fs.writeFileSync(a, JSON.stringify(producer) + '\n'); fs.writeFileSync(b, JSON.stringify(proof) + '\n');
  const run = cp.spawnSync(process.execPath, ['scripts/chn-2020/package-internal-line-lod.mjs', '--producer', a, '--verification', b], {encoding: 'utf8'});
  assert.notEqual(run.status, 0); assert.match(run.stderr, /UNACCEPTED_LOD/);
}
const published = JSON.parse(fs.readFileSync(dir + '/package.json'));
const delivery = JSON.parse(fs.readFileSync(published.artifact.path));
const accepted = JSON.parse(cp.execFileSync(process.execPath, ['scripts/chn-2020/package-internal-line-lod.mjs',
  '--producer', delivery.producer.path, '--verification', delivery.verification.path], {encoding: 'utf8'}));
assert.deepEqual(accepted.artifact, published.artifact);
const report = {pass: true, rejectedControls: rejected.map(([name]) => name), acceptedSourceDeliveryReproducesIdenticalBytes: true};
fs.writeFileSync(dir + '/packager-verification.json', JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report));
