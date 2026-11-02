// Fresh QA browser only. Hover uses the real pointer; bridge calls only project
// coordinates, change camera/debug display, or invoke ordinary country selection.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {gunzipSync} from 'node:zlib';
import {performance} from 'node:perf_hooks';
import {chromium} from '@playwright/test';

const option = name => {const at = process.argv.indexOf(name); if (at < 0) return null; const value = process.argv[at + 1]; if (!value || value.startsWith('--')) throw Error(`MISSING_ARGUMENT:${name}`); return value;};
const base = new URL(option('--url') ?? 'http://127.0.0.1:3001');
if (!['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname) || base.port !== '3001' || base.protocol !== 'http:') throw Error('ISOLATED_LOCAL_QA_PORT_3001_REQUIRED');
const pointerFile = option('--pointer') ?? 'data/runtime/operational-catalog/current.json';
const outputRoot = path.resolve('reports/hover-debug-20261030'); fs.mkdirSync(outputRoot, {recursive: true});
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const pin = file => {const bytes = fs.readFileSync(file); return {path: path.relative(process.cwd(), path.resolve(file)).replaceAll('\\', '/'), sha256: digest(bytes), byteLength: bytes.length};};
const read = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const pointer = read(pointerFile), pointerPin = pin(pointerFile), started = performance.now();
const sourcePins = ['scripts/chn-2020/verify-hover-debug-browser.mjs', 'src/components/map/OperationalWorldMap.tsx',
  'src/lib/map/operational-map-consumer.ts', 'src/lib/map/operational-map-sources.ts', 'src/lib/map/operational-vector-delivery.ts',
  'src/lib/map/operational-debug-boundary-scope.ts'].map(pin);
const report = {schemaVersion: 'hover-country-debug-browser-v1', pass: false, pointer: pointerPin, code: sourcePins,
  conditions: {url: base.origin, viewport: {width: 1440, height: 900}, deviceScaleFactor: 1, browser: 'fresh isolated Chromium; software WebGL permitted',
    httpCache: 'disabled by Playwright interception; application immutable caches remain active', actualPointerHover: true,
    externalAiCalls: 0, turnsSubmitted: 0, worldWrites: 'only this isolated context initial allocation; finally deletes only captured own session IDs',
    scope: 'live owner-or-controller country and its direct positive land neighbors; fresh seed equals source-country identities',
    limitation: 'This change filters existing vector/exact micro-line presentation. Existing base PBF tiles still carry fine geometry; it does not remove non-target bytes from those tiles.'},
  failures: [], consoleErrors: [], pageErrors: [], requests: [], failedRequests: [], views: [], screenshots: [], cleanup: []};
const check = (condition, message) => {if (!condition) throw Error(message);};
const equalSet = (a, b) => JSON.stringify([...new Set(a)].sort()) === JSON.stringify([...new Set(b)].sort());
const summarize = values => {const unique = [...new Set(values)].sort((a, b) => Number(a) - Number(b)); return {count: unique.length, sha256: digest(JSON.stringify(unique)), sample: unique.slice(0, 32)};};
function preserve(file) {if (!fs.existsSync(file)) return; const dir = path.join(outputRoot, 'archive'); fs.mkdirSync(dir, {recursive: true}); const p = pin(file), target = path.join(dir, `${path.basename(file, path.extname(file))}-${p.sha256}${path.extname(file)}`); if (!fs.existsSync(target)) fs.copyFileSync(file, target);}
const indexBytes = fs.readFileSync(`${pointer.root}/artifact-index.json`);
check(indexBytes.length === pointer.index.byteLength && digest(indexBytes) === pointer.index.sha256, 'INDEX_PIN_MISMATCH');
const index = JSON.parse(indexBytes), artifacts = new Map(index.artifacts.map(a => [a.path, a]));
const checked = file => {const bytes = fs.readFileSync(`${pointer.root}/${file}`), a = artifacts.get(file); check(a && bytes.length === a.byteLength && digest(bytes) === a.sha256, `ASSET_PIN_MISMATCH:${file}`); return file.endsWith('.gz') ? gunzipSync(bytes) : bytes;};
const descriptor = JSON.parse(checked('catalog.json')), detailIndex = JSON.parse(checked('detail-index.json'));
const countryByOrdinal = new Array(descriptor.counts.cells + 1), neighbors = new Map(descriptor.countryOrder.map(id => [id, new Set()]));
for (const c of detailIndex.countries) for (const row of JSON.parse(checked(c.metadata.path)).rows) countryByOrdinal[row[0]] = c.countryId;
const incidence = checked('metadata/edge-incidence.bin.gz');
check(incidence.length === descriptor.counts.edges * 8, 'INCIDENCE_SIZE');
const pair = n => {check(Number.isSafeInteger(n) && n > 0 && n <= descriptor.counts.edges, 'UNKNOWN_RENDERED_EDGE'); return [incidence.readUInt32LE((n - 1) * 8), incidence.readUInt32LE((n - 1) * 8 + 4)];};
for (let n = 1; n <= descriptor.counts.edges; n++) {const [left, right] = pair(n); if (!left || !right) continue; const a = countryByOrdinal[left], b = countryByOrdinal[right]; if (a !== b) {neighbors.get(a).add(b); neighbors.get(b).add(a);}}
const expectedScope = id => id ? [id, ...neighbors.get(id)].sort() : [];
check(equalSet(expectedScope('PRK'), ['CHN', 'KOR', 'PRK', 'RUS']), 'PINNED_PRK_DIRECT_LAND_NEIGHBORS_DIFFER');
report.expectedScopes = {PRK: expectedScope('PRK'), CHN: expectedScope('CHN'), USA: expectedScope('USA')};
let browser, context, page, currentCase = 'initial', bootstrap, delayArmed = false, delayEntered, delayResolve;
const ownSessions = new Set(), responseReads = [], delayed = [];

async function settled() {await page.waitForFunction(() => window.__PAX_OPERATIONAL_DEBUG__?.isRenderSettled(), null, {timeout: 180000, polling: 100}); await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));}
async function leaveCanvas() {await page.mouse.move(1430, 10); await page.waitForFunction(() => window.__PAX_OPERATIONAL_DEBUG__?.getState().hoveredCountryId === null, null, {timeout: 15000});}
async function camera(center, zoom) {await page.evaluate(({center, zoom}) => window.__PAX_OPERATIONAL_DEBUG__.jumpTo(center, zoom), {center, zoom}); await settled();}
async function hover(coordinate, country, wait = true) {
  const local = await page.evaluate(point => window.__PAX_OPERATIONAL_DEBUG__.project(point), coordinate), box = await page.locator('canvas.maplibregl-canvas').boundingBox();
  check(box && local[0] >= 0 && local[1] >= 0 && local[0] < box.width && local[1] < box.height, `HOVER_POINT_OUTSIDE_CANVAS:${country ?? 'sea'}:${JSON.stringify({coordinate, local, box})}`);
  await page.mouse.move(box.x + local[0], box.y + local[1], {steps: 2});
  await page.waitForFunction(expected => window.__PAX_OPERATIONAL_DEBUG__?.getState().hoveredCountryId === expected, country, {timeout: 15000});
  if (wait) await settled();
  return {coordinate, canvasPoint: local};
}
async function view(name, hoverCountry, {expectMicro = false, screenshot = false} = {}) {
  currentCase = name;
  const data = await page.evaluate(() => {const d = window.__PAX_OPERATIONAL_DEBUG__, s = d.getState(); return {state: {catalogRef: s.catalogRef, revision: s.revision, simulationRevision: s.simulationRevision,
    selectedCountryId: s.selectedCountryId, hoveredCountryId: s.hoveredCountryId, debugBoundaries: s.debugBoundaries, detailStatus: s.detailStatus}, stats: d.getUpdateStats(),
    center: d.getCenter(), zoom: d.getZoom(), micro: d.queryRenderedFeatures({layers: ['operational-cell-grid', 'operational-detail-cell-grid']}),
    white: d.queryRenderedFeatures({layers: ['operational-administrative-border', 'operational-detail-administrative-border']}),
    exactCells: d.querySourceFeatureIds('world-operational-exact-cells'), exactEdges: d.querySourceFeatureIds('world-operational-exact-edges')};});
  check(data.state.catalogRef.catalogVersion === pointer.catalogVersion && data.state.revision === 0 && data.state.simulationRevision === 0, `${name}:GAME_STATE_CHANGED`);
  check(!data.stats.resyncRequired && data.stats.fullProjectionBuilds === 1, `${name}:MAP_REBUILT_OR_INVALID`);
  check(data.state.hoveredCountryId === hoverCountry, `${name}:HOVER_ID_MISMATCH`);
  const allowed = data.state.debugBoundaries ? expectedScope(hoverCountry) : [];
  check(Array.isArray(data.stats.debugBoundaryCountryIds), 'DEBUG_SCOPE_DIAGNOSTIC_REQUIRED');
  if (data.state.debugBoundaries) check(equalSet(data.stats.debugBoundaryCountryIds, allowed), `${name}:DIRECT_SCOPE_MISMATCH`);
  const countryCounts = {}, leaks = [], provenanceIds = new Set(bootstrap.provincePresentationBoundaryOrdinals ?? []);
  for (const feature of data.micro) {
    const n = Number(feature.id), sides = pair(n).filter(Boolean).map(ordinal => countryByOrdinal[ordinal]);
    if (!data.state.debugBoundaries || !sides.some(c => allowed.includes(c))) leaks.push({id: n, source: feature.source, countries: sides});
    check(!provenanceIds.has(n), `${name}:PROVINCE_EDGE_IS_ALSO_MICRO`);
    for (const c of new Set(sides)) countryCounts[c] = (countryCounts[c] ?? 0) + 1;
  }
  check(leaks.length === 0, `${name}:VECTOR_OR_EXACT_MICRO_SCOPE_LEAK:${JSON.stringify(leaks.slice(0, 10))}`);
  if (expectMicro) check(data.micro.length > 0, `${name}:EXPECTED_VISIBLE_FINE_LINES`);
  if (!hoverCountry || !data.state.debugBoundaries) check(data.micro.length === 0, `${name}:MICRO_VISIBLE_WITHOUT_DEBUG_HOVER`);
  const record = {...data, name, expectedCountries: allowed, microCountries: countryCounts, micro: summarize(data.micro.map(f => f.id)),
    microBySource: Object.fromEntries([...new Set(data.micro.map(f => f.source))].map(source => [source, summarize(data.micro.filter(f => f.source === source).map(f => f.id))])),
    white: summarize(data.white.map(f => f.id)), provinceWhite: summarize(data.white.filter(f => provenanceIds.has(Number(f.id))).map(f => f.id)),
    exactCells: summarize(data.exactCells), exactEdges: summarize(data.exactEdges)};
  report.views.push(record);
  if (screenshot) {const file = path.join(outputRoot, `${name}.png`); preserve(file); await page.screenshot({path: file}); report.screenshots.push(pin(file));}
  console.log(JSON.stringify({name, hover: hoverCountry, scope: allowed, micro: record.micro.count, microCountries: countryCounts, exactCells: record.exactCells.count}));
  return record;
}

try {
  browser = await chromium.launch({headless: true, args: ['--enable-unsafe-swiftshader', '--enable-precise-memory-info']});
  context = await browser.newContext({viewport: report.conditions.viewport, deviceScaleFactor: 1, locale: 'ko-KR', reducedMotion: 'reduce'});
  await context.route('**/*', async route => {
    const request = route.request(), u = new URL(request.url());
    if ((u.protocol === 'http:' || u.protocol === 'https:') && u.origin !== base.origin || u.pathname.startsWith('/api/simulation/turn')) {
      report.failures.push({message: 'EXTERNAL_OR_TURN_REQUEST_FORBIDDEN', url: u.href}); await route.abort('blockedbyclient'); return;
    }
    if (u.pathname === '/api/simulation/game' && request.method() === 'POST') {
      let operation; try {operation = request.postDataJSON()?.operation;} catch { /* Invalid commands are blocked below. */ }
      if (operation !== 'start') {report.failures.push({message: 'GAME_WRITE_COMMAND_FORBIDDEN', operation}); await route.abort('blockedbyclient'); return;}
    }
    if (delayArmed && /\/detail\/cells\/CHN\/\d+\.geojson\.gz$/.test(u.pathname)) {
      delayArmed = false; delayed.push(u.href); delayResolve();
      await new Promise(resolve => setTimeout(resolve, 900));
      try {await route.continue();} catch (error) {if (!/closed|disposed|already handled|aborted|Invalid InterceptionId/i.test(String(error))) report.failures.push({message: 'DELAY_ROUTE_FAILED', error: String(error)});}
      return;
    }
    await route.continue();
  });
  page = await context.newPage();
  page.on('request', request => report.requests.push({case: currentCase, url: request.url(), method: request.method()}));
  page.on('requestfailed', request => report.failedRequests.push({url: request.url(), reason: request.failure()?.errorText}));
  page.on('console', m => {if (m.type() === 'error') report.consoleErrors.push(m.text());});
  page.on('pageerror', e => report.pageErrors.push(e.message));
  page.on('response', response => {
    if (response.url() === `${base.origin}/api/simulation/game` && response.request().method() === 'POST' && response.ok()) {
      const work = response.json().then(value => {if (typeof value.sessionId === 'string') ownSessions.add(value.sessionId);}).catch(error => report.failures.push({message: 'OWN_SESSION_CAPTURE_FAILED', error: String(error)})); responseReads.push(work);
    }
  });
  await page.goto(base.origin, {waitUntil: 'domcontentloaded', timeout: 180000}); await settled(); await Promise.all(responseReads);
  check(ownSessions.size > 0, 'OWN_SESSION_NOT_CAPTURED');
  const bootstrapResponse = await context.request.get(`${base.origin}/api/world/catalog/operational/map`); check(bootstrapResponse.ok(), 'BOOTSTRAP_UNAVAILABLE'); bootstrap = await bootstrapResponse.json();
  check(bootstrap.catalog.catalogRef.catalogVersion === pointer.catalogVersion, 'BOOTSTRAP_CATALOG_MISMATCH');
  check(bootstrap.provincePresentationBoundaryOrdinals?.length === 994, 'EXPECTED_994_PROVINCE_BOUNDARIES_MISSING');
  report.bootstrap = {legacyCount: bootstrap.legacyBoundaryOrdinals?.length, provinceCount: 994, provinceRoot: bootstrap.provincePresentationRoot,
    provinceOrdinalsHash: digest(JSON.stringify(bootstrap.provincePresentationBoundaryOrdinals))};

  await leaveCanvas(); await camera([105, 30], 1.7);
  await page.evaluate(() => window.__PAX_OPERATIONAL_DEBUG__.setDebugBoundaries(false)); await settled(); await view('world-normal-no-hover', null);
  await page.evaluate(() => window.__PAX_OPERATIONAL_DEBUG__.setDebugBoundaries(true)); await settled(); await view('world-debug-no-hover', null);
  await camera([127, 39.5], 5.2); await view('korea-debug-no-hover', null);
  await page.evaluate(() => window.__PAX_OPERATIONAL_DEBUG__.selectCountryDetail('CHN'));
  await hover([125.75, 39.03], 'PRK'); const prk = await view('prk-hover-selected-chn', 'PRK', {expectMicro: true, screenshot: true});
  check(prk.state.selectedCountryId === 'CHN', 'SELECTION_FIXTURE_NOT_DISTINCT');
  await hover([125.82, 39.08], 'PRK'); const repeated = await view('prk-same-country-hover', 'PRK', {expectMicro: true});
  check(prk.stats.debugBoundaryScopeBuilds === repeated.stats.debugBoundaryScopeBuilds && prk.stats.debugBoundaryFilterWrites === repeated.stats.debugBoundaryFilterWrites, 'SAME_COUNTRY_REBUILT_SCOPE_OR_FILTER');
  await leaveCanvas(); await camera([105, 35], 3.3);
  await page.evaluate(() => window.__PAX_OPERATIONAL_DEBUG__.selectCountryDetail('PRK'));
  await hover([105, 35], 'CHN'); const chn = await view('chn-hover-selected-prk', 'CHN', {expectMicro: true, screenshot: true});
  check(chn.state.selectedCountryId === 'PRK', 'SECOND_SELECTION_FIXTURE_NOT_DISTINCT');
  await hover([135, 28], null); await view('sea-clears-china-scope', null);

  await leaveCanvas(); await camera([170, 50], 2.7);
  await hover([125.75, 39.03], 'PRK'); const visibleKorea = await view('korea-before-usa-hover', 'PRK', {expectMicro: true});
  check((visibleKorea.microCountries.PRK ?? 0) + (visibleKorea.microCountries.KOR ?? 0) > 0, 'KOREAN_MICROS_NOT_IN_COMPARISON_VIEW');
  await hover([210, 64], 'USA'); const usa = await view('usa-hover-hides-korean-micros', 'USA', {screenshot: true});
  check(!(usa.microCountries.PRK || usa.microCountries.KOR), 'NONADJACENT_USA_LEAKS_KOREAN_MICROS');

  await leaveCanvas(); await camera([125, 39.7], 7.3);
  await page.evaluate(() => window.__PAX_OPERATIONAL_DEBUG__.selectCountryDetail('USA'));
  delayArmed = true; delayEntered = new Promise(resolve => {delayResolve = resolve;});
  await hover([124.1, 40.45], 'CHN', false);
  await Promise.race([delayEntered, new Promise((_, reject) => setTimeout(() => reject(Error('CHN_VIEWPORT_REQUEST_NOT_INTERCEPTED')), 15000))]);
  await hover([125.75, 39.03], 'PRK', false); await hover([123.6, 39.1], null, false);
  await page.waitForTimeout(1200); await settled(); const race = await view('rapid-hover-sea-rejects-late-detail', null);
  check(race.exactCells.count === 0 && race.exactEdges.count === 0 && race.stats.selectedDetailCells === 0, 'OBSOLETE_EXACT_DETAIL_SURVIVED_SEA');
  report.race = {delayedRequests: delayed, finalScopeEmpty: true, finalExactEmpty: true};
  await hover([124.1, 40.45], 'CHN'); const exact = await view('chn-high-hover-exact-scope', 'CHN', {expectMicro: true});
  check(exact.exactCells.count > 0 && exact.stats.selectedDetailCells > 0, 'CAPABLE_CHN_VIEWPORT_DETAIL_NOT_EXERCISED');
  await hover([125.75, 39.03], 'PRK'); const prkHigh = await view('prk-high-hover-uses-existing-fine-pbf', 'PRK', {expectMicro: true});
  check(prkHigh.exactCells.count === 0 && prkHigh.stats.selectedDetailCells === 0, 'UNSHARDED_COUNTRY_RETAINED_PREVIOUS_EXACT_DETAIL');
  await leaveCanvas(); await camera([112, 31], 6);
  await page.evaluate(() => window.__PAX_OPERATIONAL_DEBUG__.setDebugBoundaries(false)); await settled();
  const off = await view('debug-off-preserves-normal-province-white', null, {screenshot: true});
  check(off.provinceWhite.count > 0, 'NORMAL_PROVINCE_WHITE_BOUNDARIES_DISAPPEARED');
} catch (error) {report.failures.push({message: error instanceof Error ? error.message : String(error), stack: error instanceof Error ? error.stack : null});}
finally {
  await Promise.all(responseReads);
  for (const sessionId of ownSessions) {
    try {const response = await context.request.delete(`${base.origin}/api/simulation/game`, {headers: {'X-Pax-Game': sessionId}});
      report.cleanup.push({sessionIdSha256: digest(sessionId), status: response.status()}); check(response.status() === 204, 'OWN_SESSION_DELETE_FAILED');
    } catch (error) {report.failures.push({message: 'OWN_SESSION_CLEANUP_FAILED', error: String(error)});}
  }
  report.fullCountryGeometryRequests = report.requests.filter(r => /\/detail\/countries\/[A-Z]{3}\.geojson\.gz(?:$|\?)/.test(r.url));
  if (report.fullCountryGeometryRequests.length) report.failures.push({message: 'FULL_NATIONAL_GEOMETRY_REQUEST_FORBIDDEN', requests: report.fullCountryGeometryRequests});
  if (report.consoleErrors.length || report.pageErrors.length) report.failures.push({message: 'BROWSER_ERRORS', consoleErrors: report.consoleErrors.length, pageErrors: report.pageErrors.length});
  const unexpectedFailures = report.failedRequests.filter(r => !/ERR_ABORTED/.test(r.reason ?? '')); if (unexpectedFailures.length) report.failures.push({message: 'UNEXPECTED_NETWORK_FAILURE', requests: unexpectedFailures});
  for (const original of [pointerPin, ...sourcePins]) {const now = pin(original.path); if (now.sha256 !== original.sha256 || now.byteLength !== original.byteLength) report.failures.push({message: 'SOURCE_CHANGED_DURING_VERIFICATION', path: original.path});}
  if (context) await context.close().catch(error => report.failures.push({message: 'CONTEXT_CLOSE_FAILED', error: String(error)}));
  if (browser) await browser.close().catch(error => report.failures.push({message: 'BROWSER_CLOSE_FAILED', error: String(error)}));
  report.elapsedMs = performance.now() - started; report.pass = report.failures.length === 0;
  const output = path.join(outputRoot, 'verification.json'); preserve(output); fs.writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({pass: report.pass, report: pin(output), views: report.views.length, cleanup: report.cleanup,
    fullCountryRequests: report.fullCountryGeometryRequests.length, failures: report.failures.map(e => e.message)}));
  if (!report.pass) process.exitCode = 1;
}
