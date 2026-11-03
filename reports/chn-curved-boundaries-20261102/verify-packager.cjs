const fs = require('node:fs'), cp = require('node:child_process'), assert = require('node:assert/strict');
const dir = 'reports/chn-curved-boundaries-20261102';
const fixtures = dir + '/packager-fixtures';
fs.mkdirSync(fixtures, {recursive: true});
const lodProducer = 'chn-internal-line-lod-producer-v1', lodProof = 'chn-internal-line-lod-independent-v1';
const curveProducer = 'chn-internal-line-curves-producer-v1', curveProof = 'chn-internal-line-curves-independent-v1';
const rejected = [
  ['unknown-and-missing', {pass: true, schemaVersion: 'unknown'}, {pass: true}],
  ['both-missing', {pass: true}, {pass: true}],
  ['curve-with-old-proof', {pass: true, schemaVersion: curveProducer}, {pass: true, schemaVersion: lodProof}],
  ['old-with-curve-proof', {pass: true, schemaVersion: lodProducer}, {pass: true, schemaVersion: curveProof}],
  ['curve-failed-producer', {pass: false, schemaVersion: curveProducer}, {pass: true, schemaVersion: curveProof}],
  ['curve-failed-proof', {pass: true, schemaVersion: curveProducer}, {pass: false, schemaVersion: curveProof}],
];
for (const [name, producer, proof] of rejected) {
  const producerPath = `${fixtures}/${name}-producer.json`, proofPath = `${fixtures}/${name}-proof.json`;
  fs.writeFileSync(producerPath, JSON.stringify(producer) + '\n');
  fs.writeFileSync(proofPath, JSON.stringify(proof) + '\n');
  const run = cp.spawnSync(process.execPath, ['scripts/chn-2020/package-internal-line-lod.mjs', '--producer', producerPath, '--verification', proofPath], {encoding: 'utf8'});
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /UNACCEPTED_LOD/);
}
const packageInfo = JSON.parse(fs.readFileSync(dir + '/package.json'));
const delivery = JSON.parse(fs.readFileSync(packageInfo.artifact.path));
const accepted = JSON.parse(cp.execFileSync(process.execPath, ['scripts/chn-2020/package-internal-line-lod.mjs',
  '--producer', delivery.producer.path, '--verification', delivery.verification.path], {encoding: 'utf8'}));
assert.deepEqual(accepted.artifact, packageInfo.artifact);
const report = {pass: true, rejectedControls: rejected.map(([name]) => name), acceptedCurvedDeliveryReproducesIdenticalBytes: true};
fs.writeFileSync(dir + '/packager-verification.json', JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report));
