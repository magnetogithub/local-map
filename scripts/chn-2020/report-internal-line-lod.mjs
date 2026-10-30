import fs from 'node:fs';
import {createHash} from 'node:crypto';
const base = 'reports/chn-render-lod-20261030';
const read = path => JSON.parse(fs.readFileSync(path, 'utf8').replace(/^\uFEFF/, ''));
const pin = path => {const bytes = fs.readFileSync(path); return {path, sha256: createHash('sha256').update(bytes).digest('hex'), byteLength: bytes.length};};
const producerPath = 'data/derived/chn-2020/internal-line-lod-edc8c590e072774bd876/producer-report.json';
const proofPath = 'reports/chn-internal-render-lod-20261030/verification/independent.json';
const producer = read(producerPath), proof = read(proofPath), game = read(`${base}/game-debug/after.json`), browser = read(`${base}/browser/after.json`);
if (![producer, proof, game, browser].every(p => p.pass)) throw Error('REQUIRED_ACCEPTANCE_FAILED');
const buildPath = `${base}/build-webpack-retry.log`, buildLog = fs.readFileSync(buildPath, 'utf8');
if (!buildLog.includes('Compiled successfully') || !buildLog.includes('Route (app)') || buildLog.includes('Build failed')) throw Error('FINAL_BUILD_NOT_PASSED');
for (const file of ['types-upload-idle.log', 'lint-final.log']) if (fs.readFileSync(`${base}/${file}`, 'utf8').trim()) throw Error(`FINAL_CHECK_NOT_PASSED:${file}`);
const before = read(`${base}/user-game-before.json`), after = read(`${base}/user-game-final.json`), unlocked = read(`${base}/user-game-final-unlocked.json`);
const hashes = data => data.pools.flatMap(p => p.checkpoints.map(c => c.payloadHash)).sort();
if (JSON.stringify(hashes(before)) !== JSON.stringify(hashes(after)) || unlocked.mutationsLocked !== false) throw Error('GAME_PRESERVATION_FAILED');
const report = {
  schemaVersion: 'chn-internal-display-lod-final-v1', pass: true, scope: 'Chinese internal display lines only',
  catalogPointer: pin('data/runtime/operational-catalog/current.json'), catalogRef: producer.catalogRef,
  sourceBasis: producer.sourceBasis, producer: pin(producerPath), verification: pin(proofPath),
  delivery: read(`${base}/package-decimal-bounds.json`).artifact,
  geometry: producer.summary, topology: producer.topology,
  provincialAppearancePreserved: producer.provinceChangeFromPrevious,
  authoritativePreservation: proof.authorityUnchanged,
  displayPolicy: {minZoom: 2.2, maxZoomExclusive: 7, preciseOriginalAtZoom: 7, countryCoastAndOperationalFrontsUnchanged: true,
    provinceLoading: 'eligible viewport/zoom', microLoading: 'debug enabled, current hover scope includes CHN, eligible viewport/zoom',
    scope: 'current hovered country plus its positive-length land neighbors; selection independent; stationary pointer reconciled on camera idle',
    publication: 'separate immutable proof-pinned presentation; original catalog and save versions unchanged'},
  validation: {game: pin(`${base}/game-debug/after.json`), display: pin(`${base}/browser/after.json`),
    actualGameViews: game.views.length, displayViews: browser.views.length, errors: {page: game.pageErrors, console: game.consoleErrors},
    allArcGeometry: proof.checks, actualPBF: proof.actualDelivery,
    tests: [pin(`${base}/tests-final.log`), pin(`${base}/tests-upload-idle.log`)],
    types: pin(`${base}/types-upload-idle.log`), lint: pin(`${base}/lint-final.log`), build: pin(buildPath)},
  renderingDiagnostics: {microVertexReductionPercent: 100 * (1 - producer.summary.categoryMicro.displayVertices / producer.summary.categoryMicro.originalVertices),
    microCompressedBytes: 2978766, provinceCompressedBytes: 411639, microRequestsInActualGame: game.microLodRequests.length,
    geometryWrites: 'kind-specific counters in each browser view; expected once per map mount',
    beforeMapReadyWallMs: read(`${base}/browser/before.json`).mapReadyWallMs, afterMapReadyWallMs: browser.mapReadyWallMs,
    matchedGameFPSOrTurnImprovementClaim: false},
  games: {sessionsPreserved: after.sessionCount, payloadHashesIdentical: true, mutationsLocked: false,
    before: pin(`${base}/user-game-before.json`), after: pin(`${base}/user-game-final.json`), unlock: pin(`${base}/user-game-final-unlocked.json`)},
  localUrl: 'http://127.0.0.1:3002/game', newGameRequiredForThisDisplayChange: false,
  otherExistingGame: '3030/game observed with older 4718-cell catalog; preserved without migration or server restart',
  limitations: [
    'Authoritative polygon resolution and base PBF geometry/bytes are unchanged; this reduces visible Chinese line geometry, not the whole map database.',
    '300m is a Mercator simplification budget. Its pitch-zero display bound is under 0.491 CSS pixels below zoom7, separate from existing PBF quantization.',
    'Combined independent PBF checks cover four source-backed locations and 14 micro arcs, not every national micro arc. All8562 internal arc geometry and contact topology are checked.',
    'Province output is byte-identical to the earlier994-arc artifact, whose separate full province delivery proof is preserved.',
    'First eligible debug use fetches 2978766 gzip bytes. Subsequent reuse avoids auxiliary refetch and setData; baseline vector tiles still load normally.',
    'MapLibre visibility changes can reparse source buckets; unchanged hover scopes do not repeat filters or source writes. General gameplay lag work remains deferred.',
    'Timing diagnostics use development server/software WebGL and do not establish a matched whole-game FPS or turn-time improvement.',
    'Original Chinese boundary source has mixed2017/2021 metadata and is not certified as an exact2020 administrative snapshot.'
  ],
  resolvedFailures: [
    'Old game-browser front assertion counted opacity-zero front features; harness now checks authoritative occupied counts and exact front source.',
    'Next JSON-module floating-point parsing changed a decimal bound by one serialization byte; immutable delivery bounds now use decimal strings before runtime Number conversion.',
    'Synchronous sourcedata visibility swap reentered MapLibre Style.update before source prepare. Swap is deferred to idle; full browser checks exercise it.',
    'Canvas-leave probe coordinate was land in the full-screen game; harness now moves to the real HUD settings button.'
  ],
  code: ['src/components/map/OperationalWorldMap.tsx','src/lib/map/operational-map-consumer.ts','src/lib/map/operational-pointer-hover.ts',
    'src/lib/map/operational-vector-delivery.ts','src/lib/map/operational-delivery-contract.ts','src/lib/map/operational-delivery.server.ts',
    'src/lib/map/chn-boundary-display-lod.server.ts','scripts/chn-2020/package-internal-line-lod.mjs'].map(pin),
};
const output = `${base}/final-report.json`;
if (fs.existsSync(output)) throw Error('IMMUTABLE_FINAL_REPORT_EXISTS');
fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
process.stdout.write(JSON.stringify(pin(output)) + '\n');
