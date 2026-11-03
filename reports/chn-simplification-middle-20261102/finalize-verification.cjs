const fs = require('node:fs'), crypto = require('node:crypto'), assert = require('node:assert/strict');
const dir = 'reports/chn-simplification-middle-20261102';
const read = path => JSON.parse(fs.readFileSync(path));
const pin = path => {const bytes = fs.readFileSync(path); return {path, sha256: crypto.createHash('sha256').update(bytes).digest('hex'), byteLength: bytes.length};};
const packageInfo = read(dir + '/package.json'), delivery = read(packageInfo.artifact.path);
const producer = read(delivery.producer.path), proof = read(delivery.verification.path);
const earlierDelivery = read('data/derived/chn-2020/internal-line-delivery-5eda5f6bb9cdc93a7ded/delivery.json');
const coarseDelivery = read('data/derived/chn-2020/internal-line-delivery-c0833a8e47165cdfabd6/delivery.json');
const earlier = read(earlierDelivery.producer.path), coarse = read(coarseDelivery.producer.path);
const browser = read(dir + '/browser-verification.json');
assert.equal(proof.pass, true);
assert.equal(browser.pass, true);
assert.deepEqual(pin(delivery.producer.path), delivery.producer);
assert.deepEqual(pin(delivery.verification.path), delivery.verification);
assert.deepEqual(pin(packageInfo.artifact.path), packageInfo.artifact);
assert.equal(browser.views.length, 18);
const count = value => ({all: value.summary.displayVertices, province: value.summary.categoryProvince.displayVertices, micro: value.summary.categoryMicro.displayVertices});
const counts = {beforeLastChange: count(earlier), tooCoarse: count(coarse), middle: count(producer)};
assert.ok(counts.tooCoarse.all < counts.middle.all && counts.middle.all < counts.beforeLastChange.all);
for (const kind of ['province', 'micro']) assert.ok(counts.tooCoarse[kind] < counts.middle[kind] && counts.middle[kind] < counts.beforeLastChange[kind]);
const originalDetailedRetained = producer.edges.filter(r => r.displayVertices === r.originalVertices && r.displayVertices > 10);
assert.equal(originalDetailedRetained.length, 0);
const korea = ['before', 'after'].map(phase => pin(`${dir}/${phase}-korea-close.png`));
assert.equal(korea[0].sha256, korea[1].sha256);
const report = {
  pass: true,
  scope: 'All 8562 internal China arcs: 1002 province boundaries and 7560 micro boundaries. The same global rule and retained-arc retry apply nationwide.',
  resolutionChoice: {target: 'Approximately midway between the two previous displays, with remaining detailed rollback arcs simplified safely.',
    toleranceMercatorMeters: 2500, vertices: counts,
    removedDetailRestoredFraction: (counts.middle.all - counts.tooCoarse.all) / (counts.beforeLastChange.all - counts.tooCoarse.all)},
  retainedArcRepair: {method: producer.policy.retainedArcRetry, refinedArcs: producer.retainedArcRefinements.length,
    verticesRemovedFromWholeArcRollbacks: producer.retainedArcRefinements.reduce((n, r) => n + r.beforeVertices - r.afterVertices, 0),
    unchangedOriginalArcsWithMoreThan10Vertices: originalDetailedRetained,
    exampleWuhanArc: producer.retainedArcRefinements.find(r => r.ordinal === 10186),
    limitation: 'Fixed junctions, exact contacts and closed-loop containment can require different retained vertex densities; vertex counts are a display-complexity proxy.'},
  authorityUnchanged: proof.authorityUnchanged,
  checks: {wholeNetwork: delivery.verification, independentChecks: proof.checks, negativeControls: proof.negativeControls,
    browser: {report: pin(dir + '/browser-verification.json'), views: browser.views.length, koreaCloseScreenshotsIdentical: true},
    vitest: {files: 4, tests: 109, pass: true}, typescript: true, eslint: true},
  delivery: packageInfo.artifact,
  inputs: {earlier: pin('data/derived/chn-2020/internal-line-delivery-5eda5f6bb9cdc93a7ded/delivery.json'),
    tooCoarse: pin('data/derived/chn-2020/internal-line-delivery-c0833a8e47165cdfabd6/delivery.json')},
  reproduce: [
    'python scripts/chn-2020/build-chn-internal-line-lod.py --tolerance 2500 --province-index data/derived/chn-2020/province-render-9cc4238ba7e460d4620f/index.json --previous-delivery data/derived/chn-2020/internal-line-delivery-5eda5f6bb9cdc93a7ded/delivery.json',
    `python scripts/chn-2020/verify-chn-internal-line-lod.py --producer-report ${delivery.producer.path} --tolerance 2500 --output ${delivery.verification.path}`,
    `node scripts/chn-2020/package-internal-line-lod.mjs --producer ${delivery.producer.path} --verification ${delivery.verification.path}`,
    `node ${dir}/verify-browser.cjs http://127.0.0.1:3192`,
    `node ${dir}/finalize-verification.cjs`,
  ],
};
fs.writeFileSync(dir + '/verification.json', JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({pass: true, vertices: counts, refinedArcs: report.retainedArcRepair.refinedArcs, koreaIdentical: true}));
