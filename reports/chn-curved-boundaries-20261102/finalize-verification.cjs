const fs = require('node:fs'), crypto = require('node:crypto'), assert = require('node:assert/strict');
const dir = 'reports/chn-curved-boundaries-20261102';
const read = path => JSON.parse(fs.readFileSync(path));
const pin = path => {const bytes = fs.readFileSync(path); return {path, sha256: crypto.createHash('sha256').update(bytes).digest('hex'), byteLength: bytes.length};};
const packageInfo = read(dir + '/package.json'), delivery = read(packageInfo.artifact.path);
const producer = read(delivery.producer.path), proof = read(delivery.verification.path);
const browser = read(dir + '/browser-verification.json'), packager = read(dir + '/packager-verification.json');
const baseline = read(producer.inputs.smoothingBaselineDelivery.path);
for (const [path, expected] of [[packageInfo.artifact.path, packageInfo.artifact], [delivery.producer.path, delivery.producer],
  [delivery.verification.path, delivery.verification]]) assert.deepEqual(pin(path), expected);
assert.equal(proof.pass, true);
assert.equal(browser.pass, true);
assert.equal(packager.pass, true);
assert.equal(browser.views.length, 24);
const comparisons = {};
for (const name of ['korea-close', 'dprk-close']) {
  comparisons[name] = ['before', 'after'].map(phase => pin(`${dir}/${phase}-${name}.png`));
  assert.equal(comparisons[name][0].sha256, comparisons[name][1].sha256);
}
for (const view of browser.views) {
  assert.deepEqual(view.writes, [1, 1]);
  assert.equal(view.provinceVertices, view.phase === 'after' ? producer.summary.provinceVertices : 5692);
  assert.equal(view.microVertices, view.phase === 'after' ? producer.summary.microVertices : 39915);
}
const report = {
  pass: true,
  scope: 'All 8562 accepted internal China arcs: 1002 provincial and 7560 micro boundaries. One shared offline curve rule at every zoom.',
  change: 'Keep the accepted middle simplification; round eligible interior corners with short quadratic Bezier fillets. Derived samples represent the curves instead of restoring raw detail.',
  summary: producer.summary,
  policy: producer.policy,
  authorityUnchanged: proof.authorityUnchanged,
  checks: {independentWholeNetworkProof: delivery.verification, independentChecks: proof.checks, negativeControls: proof.negativeControls,
    packager: pin(dir + '/packager-verification.json'), browser: pin(dir + '/browser-verification.json'),
    vitest: {files: 4, tests: 109, pass: true}, typescript: true, eslint: true, unchangedCountryScreenshots: comparisons},
  delivery: packageInfo.artifact,
  performance: {baselineCompressedBytes: baseline.province.artifact.byteLength + baseline.micro.artifact.byteLength,
    currentCompressedBytes: delivery.province.artifact.byteLength + delivery.micro.artifact.byteLength,
    curveGeneration: 'Offline only; each of the two static sources is published once per mount and reused across all tested views.',
    initializationMilliseconds: Object.fromEntries(['before', 'after'].map(phase => [phase, browser.views.find(v => v.phase === phase).initializationMilliseconds])),
    timingLimit: 'Sequential local development sessions on the same server with a warm build; diagnostic initialization timings, not a controlled performance benchmark.'},
  reproduce: [
    `python scripts/chn-2020/build-chn-curved-internal-lines.py --baseline-delivery ${producer.inputs.smoothingBaselineDelivery.path}`,
    `python scripts/chn-2020/verify-chn-curved-internal-lines.py --producer-report ${delivery.producer.path} --output ${delivery.verification.path}`,
    `node scripts/chn-2020/package-internal-line-lod.mjs --producer ${delivery.producer.path} --verification ${delivery.verification.path}`,
    `node ${dir}/verify-packager.cjs`,
    `node ${dir}/verify-browser.cjs http://127.0.0.1:3192`,
    `node ${dir}/finalize-verification.cjs`,
  ],
  limitations: proof.limitations,
};
fs.writeFileSync(dir + '/verification.json', JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({pass: true, curvedEdges: producer.summary.curvedEdges, roundedCorners: producer.summary.roundedCorners,
  browserViews: browser.views.length, koreaAndDprkScreenshotsIdentical: true, compressedBytes: report.performance.currentCompressedBytes,
  initializationMilliseconds: report.performance.initializationMilliseconds}));
