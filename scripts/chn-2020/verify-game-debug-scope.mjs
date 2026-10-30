// Isolated /game regression: real country selection, real HUD settings, real pointer hover.
// The development bridge is used only for camera changes and read-only diagnostics.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {gunzipSync} from 'node:zlib';
import {performance} from 'node:perf_hooks';
import {chromium} from '@playwright/test';

const option = name => {const i = process.argv.indexOf(name); if (i < 0) return null; const v = process.argv[i + 1]; if (!v || v.startsWith('--')) throw Error(`MISSING_ARGUMENT:${name}`); return v;};
const base = new URL(option('--url') ?? 'http://127.0.0.1:3001');
if (base.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname) || base.port !== '3001') throw Error('ISOLATED_LOCAL_QA_PORT_3001_REQUIRED');
const label = option('--label') ?? 'game-debug';
const runtimeProbe = process.argv.includes('--runtime-probe');
if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(label)) throw Error('INVALID_REPORT_LABEL');
const output = path.resolve('reports/chn-render-lod-20261030/game-debug'); fs.mkdirSync(output, {recursive: true});
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const pin = file => {const bytes = fs.readFileSync(file); return {path: path.relative(process.cwd(), path.resolve(file)).replaceAll('\\', '/'), sha256: digest(bytes), byteLength: bytes.length};};
const read = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const check = (ok, message) => {if (!ok) throw Error(message);};
const equalSet = (a, b) => JSON.stringify([...new Set(a)].sort()) === JSON.stringify([...new Set(b)].sort());
const summarize = values => {const unique = [...new Set(values)].sort((a, b) => Number(a) - Number(b)); return {count: unique.length, sha256: digest(JSON.stringify(unique)), sample: unique.slice(0, 32)};};
function preserve(file) {if (!fs.existsSync(file)) return; const old = pin(file), archive = path.join(output, 'archive'); fs.mkdirSync(archive, {recursive: true}); const target = path.join(archive, `${path.basename(file, path.extname(file))}-${old.sha256}${path.extname(file)}`); if (!fs.existsSync(target)) fs.copyFileSync(file, target);}

const pointerPath = 'data/runtime/operational-catalog/current.json', pointer = read(pointerPath), pointerPin = pin(pointerPath);
const sourcePins = ['scripts/chn-2020/verify-game-debug-scope.mjs', 'src/components/map/OperationalWorldMap.tsx',
  'src/components/layout/OperationalGameSetupShell.tsx', 'src/components/game/CatalogGameScreen.tsx', 'src/components/game/WarAndSystemOverlays.tsx',
  'src/lib/map/operational-map-consumer.ts', 'src/lib/map/operational-map-sources.ts', 'src/lib/map/operational-vector-delivery.ts',
  'src/lib/map/operational-debug-boundary-scope.ts', 'src/lib/map/operational-pointer-hover.ts', 'src/lib/map/operational-delivery.server.ts',
  'src/lib/map/chn-boundary-display-lod.server.ts'].map(pin);
const indexBytes = fs.readFileSync(`${pointer.root}/artifact-index.json`);
check(indexBytes.length === pointer.index.byteLength && digest(indexBytes) === pointer.index.sha256, 'INDEX_PIN_MISMATCH');
const artifactIndex = JSON.parse(indexBytes), artifacts = new Map(artifactIndex.artifacts.map(a => [a.path, a]));
const checked = file => {const bytes = fs.readFileSync(`${pointer.root}/${file}`), a = artifacts.get(file); check(a && bytes.length === a.byteLength && digest(bytes) === a.sha256, `ARTIFACT_PIN_MISMATCH:${file}`); return file.endsWith('.gz') ? gunzipSync(bytes) : bytes;};
const descriptor = JSON.parse(checked('catalog.json')), detailIndex = JSON.parse(checked('detail-index.json'));
const countryByOrdinal = new Array(descriptor.counts.cells + 1), neighbors = new Map(descriptor.countryOrder.map(id => [id, new Set()])), countryCellCounts = {};
for (const c of detailIndex.countries) {
  const rows = JSON.parse(checked(c.metadata.path)).rows; countryCellCounts[c.countryId] = rows.length;
  for (const row of rows) {check(!countryByOrdinal[row[0]], 'DUPLICATE_CELL_ORDINAL'); countryByOrdinal[row[0]] = c.countryId;}
}
check(descriptor.counts.cells === 8005 && countryCellCounts.CHN === 3320 && countryByOrdinal.filter(Boolean).length === 8005, 'EXPECTED_CURRENT_8005_CELL_CHN_3320_CATALOG_REQUIRED');
const incidence = checked('metadata/edge-incidence.bin.gz'); check(incidence.length === descriptor.counts.edges * 8, 'INCIDENCE_SIZE_MISMATCH');
const pair = n => {check(Number.isSafeInteger(n) && n > 0 && n <= descriptor.counts.edges, `UNKNOWN_EDGE_ORDINAL:${n}`); return [incidence.readUInt32LE((n - 1) * 8), incidence.readUInt32LE((n - 1) * 8 + 4)];};
for (let n = 1; n <= descriptor.counts.edges; n++) {const [l, r] = pair(n); if (!l || !r) continue; const a = countryByOrdinal[l], b = countryByOrdinal[r]; check(a && b, 'INCIDENCE_CELL_NOT_CLASSIFIED'); if (a !== b) {neighbors.get(a).add(b); neighbors.get(b).add(a);}}
const expectedScope = country => country ? [country, ...neighbors.get(country)].sort() : [];
check(equalSet(expectedScope('PRK'), ['CHN', 'KOR', 'PRK', 'RUS']), 'PINNED_PRK_DIRECT_LAND_SCOPE_CHANGED');
check(!expectedScope('CHN').includes('KOR'), 'PINNED_CHN_SCOPE_INCLUDES_SECOND_HOP_KOR');
check(!expectedScope('USA').some(id => ['CHN', 'KOR', 'PRK'].includes(id)), 'PINNED_USA_SCOPE_INCLUDES_EAST_ASIA');

const MICRO = ['operational-cell-grid', 'operational-detail-cell-grid', 'operational-micro-display-lod', 'operational-micro-original', 'operational-detail-micro-original'];
const WHITE = ['operational-administrative-border', 'operational-detail-administrative-border', 'operational-province-display-lod', 'operational-province-original', 'operational-detail-province-original'];
const MICRO_LOD = 'operational-micro-display-lod';
const report = {schemaVersion: 'actual-game-debug-scope-browser-v1', label, pass: false, pointer: pointerPin, code: sourcePins,
  conditions: {url: base.origin, runtimeProbe, probeDeadlineMs: runtimeProbe ? 30000 : null, viewport: {width: 1440, height: 900}, deviceScaleFactor: 1, browser: 'fresh isolated Chromium; software WebGL permitted',
    actualGameEntry: 'search CHN, confirm play country, wait for /game', debugToggle: 'HUD settings checkbox click and keyboard Space; no debug bridge setter',
    hover: 'real mouse pointer; geometry/camera diagnostic bridge only', httpCache: 'disabled by interception; immutable application caches remain enabled',
    externalAiCalls: 0, turnsSubmitted: 0, permittedGamePosts: ['start', 'select-player'], existingUserSessionsTouched: 0,
    limitation: 'Presentation/scope regression only. No turn is advanced; exact authoritative fills and base PBF byte count are unchanged by stroke LOD.'},
  expectedScopes: Object.fromEntries(['PRK', 'CHN', 'USA'].map(id => [id, expectedScope(id)])), sourceCellCounts: {total: descriptor.counts.cells, CHN: countryCellCounts.CHN},
  views: [], screenshots: [], requests: [], commands: [], failures: [], pageErrors: [], consoleErrors: [], failedRequests: [], cleanup: []};
const ownSessions = new Set(), responseReads = [], started = performance.now();
let browser, context, page, bootstrap, gameBaseline, microPath, currentCase = 'initial';
const microRequests = () => report.requests.filter(r => microPath && new URL(r.url).pathname === microPath);
let rejectRuntimeError, probeTimer;
const runtimeError = new Promise((_, reject) => {rejectRuntimeError = reject;}); runtimeError.catch(() => {});
const guardRuntime = promise => Promise.race([promise, runtimeError]);

async function settled() {
  await guardRuntime(page.waitForFunction(() => window.__PAX_OPERATIONAL_DEBUG__?.isRenderSettled() || !!document.querySelector('[data-testid="world-map"][data-map-status="error"], main.route-loading[role="alert"]'), null, {timeout: 180000, polling: 100}));
  const error = await page.locator('[data-testid="world-map"][data-map-status="error"], main.route-loading[role="alert"]').count();
  if (error) throw Error('MAP_OR_GAME_INITIALIZATION_ERROR_SEE_BROWSER_ERRORS');
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}
async function waitHover(id) {await page.waitForFunction(expected => window.__PAX_OPERATIONAL_DEBUG__?.getState().hoveredCountryId === expected, id, {timeout: 15000});}
async function leaveCanvas() {
  // /game places the canvas across the entire viewport. A fixed corner can be
  // uncovered land, so leave through an actual HUD element above the canvas.
  await page.locator('[data-menu-kind="settings"]').hover(); await waitHover(null);
}
async function camera(center, zoom) {await page.evaluate(({center, zoom}) => window.__PAX_OPERATIONAL_DEBUG__.jumpTo(center, zoom), {center, zoom}); await settled();}
async function hover(coordinate, country, wait = true) {
  const local = await page.evaluate(p => window.__PAX_OPERATIONAL_DEBUG__.project(p), coordinate), box = await page.locator('canvas.maplibregl-canvas').boundingBox();
  check(box && local[0] >= 0 && local[1] >= 0 && local[0] < box.width && local[1] < box.height, `HOVER_OUTSIDE_CANVAS:${country ?? 'sea'}:${JSON.stringify({coordinate, local, box})}`);
  const point = {x: box.x + local[0], y: box.y + local[1]};
  check(await page.evaluate(p => Boolean(document.elementFromPoint(p.x, p.y)?.closest('canvas.maplibregl-canvas')), point), `HOVER_OCCLUDED_BY_GAME_UI:${country ?? 'sea'}`);
  await page.mouse.move(point.x, point.y, {steps: wait ? 2 : 1}); await waitHover(country); if (wait) await settled(); return {coordinate, canvasPoint: local};
}
async function screenshot(name) {const file = path.join(output, `${label}-${name}.png`); preserve(file); await page.screenshot({path: file}); report.screenshots.push(pin(file));}
async function openSettings() {if (!await page.locator('[data-testid="settings-overlay"]').isVisible()) await page.locator('[data-menu-kind="settings"]').click(); await page.locator('[data-testid="settings-overlay"]').waitFor();}
async function closeSettings() {await page.getByRole('button', {name: '설정 닫기', exact: true}).click(); await page.locator('[data-testid="settings-overlay"]').waitFor({state: 'hidden'});}
async function toggleDebugByClick(enabled) {
  await openSettings(); const checkbox = page.getByRole('checkbox', {name: /지도 디버그 모드/}); await checkbox.setChecked(enabled);
  check(await checkbox.isChecked() === enabled, 'HUD_CHECKBOX_DID_NOT_CHANGE');
  await page.waitForFunction(value => window.__PAX_OPERATIONAL_DEBUG__?.getState().debugBoundaries === value, enabled, {timeout: 15000}); await settled();
}
async function view(name, country, {expectMicro = false, takeScreenshot = false, expectExact = false} = {}) {
  currentCase = name; await settled();
  const display = await page.evaluate(() => {const d = window.__PAX_OPERATIONAL_DEBUG__; return {zoom: d.getZoom(), debug: d.getState().debugBoundaries};});
  const expectMicroLod = display.debug && !!country && expectedScope(country).includes('CHN') && display.zoom >= 2.2 && display.zoom < 7;
  await guardRuntime(page.waitForFunction(expected => window.__PAX_OPERATIONAL_DEBUG__?.getUpdateStats()?.microDisplayLodActive === expected, expectMicroLod, {timeout: 30000, polling: 100}));
  await settled();
  const data = await page.evaluate(({micro, white}) => {const d = window.__PAX_OPERATIONAL_DEBUG__, s = d.getState(); return {
    state: {catalogRef: s.catalogRef, revision: s.revision, simulationRevision: s.simulationRevision, counts: s.counts, controlCounts: s.controlCounts,
      selectedCountryId: s.selectedCountryId, hoveredCountryId: s.hoveredCountryId, debugBoundaries: s.debugBoundaries, detailStatus: s.detailStatus},
    stats: d.getUpdateStats(), center: d.getCenter(), zoom: d.getZoom(), micro: d.queryRenderedFeatures({layers: micro}), white: d.queryRenderedFeatures({layers: white}),
    microLayers: micro.map(id => d.getLayerState(id)), exactCells: d.querySourceFeatureIds('world-operational-exact-cells'), exactEdges: d.querySourceFeatureIds('world-operational-exact-edges'),
    frontQuery: d.queryRenderedFeatures({layers: ['operational-front', 'operational-detail-front']}), frontGeometryIds: d.querySourceFeatureIds('world-operational-front-detail'),
    dom: {mode: document.querySelector('.app-shell')?.getAttribute('data-page-mode'), cells: Number(document.querySelector('.app-shell')?.getAttribute('data-world-territory-count')),
      revision: Number(document.querySelector('.app-shell')?.getAttribute('data-world-revision')), catalogVersion: document.querySelector('.app-shell')?.getAttribute('data-catalog-version')},
  };}, {micro: MICRO, white: WHITE});
  // Keep evidence even if an assertion below fails; opacity-zero query results
  // are not proof that a line is visible. Exact front geometry and control
  // counts are authoritative for this no-turn presentation regression.
  report.latestDiagnostic = {name, state: data.state, stats: data.stats, dom: data.dom, exactFrontGeometryIds: summarize(data.frontGeometryIds), frontQueryIds: summarize(data.frontQuery.map(f => f.id))};
  check(data.dom.mode === 'game' && data.dom.cells === 8005 && data.dom.catalogVersion === pointer.catalogVersion, `${name}:ACTUAL_GAME_HAS_STALE_CATALOG`);
  check(data.state.catalogRef.catalogVersion === pointer.catalogVersion && data.state.counts.cells === 8005, `${name}:BRIDGE_CATALOG_MISMATCH`);
  check(data.state.revision === 0 && data.dom.revision === 0 && data.state.simulationRevision === gameBaseline.simulationRevision, `${name}:UNEXPECTED_GAME_REVISION`);
  check(JSON.stringify(data.state.controlCounts) === JSON.stringify(gameBaseline.controlCounts), `${name}:CONTROL_COUNTS_CHANGED`);
  check(data.state.controlCounts.CHN?.owned === 3320 && data.state.controlCounts.CHN?.controlled === 3320, `${name}:CHN_FINE_CONTROL_COUNT_WRONG`);
  check(data.state.hoveredCountryId === country, `${name}:HOVER_MISMATCH`);
  check(!data.stats.resyncRequired && data.stats.fullProjectionBuilds === 1, `${name}:INVALID_PROJECTION:${JSON.stringify(data.stats)}`);
  check(data.frontGeometryIds.length === 0 && data.stats.exactFronts === 0 && Object.values(data.state.controlCounts).every(c => c.occupied === 0), `${name}:UNEXPECTED_OCCUPATION_OR_EXACT_FRONT`);
  const allowed = data.state.debugBoundaries ? expectedScope(country) : [];
  check(Array.isArray(data.stats.debugBoundaryCountryIds) && equalSet(data.stats.debugBoundaryCountryIds, allowed), `${name}:DIRECT_DEBUG_COUNTRY_SCOPE_MISMATCH`);
  check(data.stats.debugBoundaryScopeBuilds <= 1, `${name}:DEBUG_SCOPE_INDEX_REBUILT`);
  const provinceIds = new Set(bootstrap.provincePresentationBoundaryOrdinals ?? []), countryCounts = {}, leaks = [];
  for (const f of data.micro) {
    const n = Number(f.id), sides = pair(n).filter(Boolean).map(ordinal => countryByOrdinal[ordinal]);
    if (!data.state.debugBoundaries || !sides.some(c => allowed.includes(c))) leaks.push({id: n, layerId: f.layerId, countries: sides});
    check(!provinceIds.has(n), `${name}:NORMAL_PROVINCE_EDGE_IS_ALSO_DEBUG_MICRO`);
    for (const id of new Set(sides)) countryCounts[id] = (countryCounts[id] ?? 0) + 1;
  }
  check(leaks.length === 0, `${name}:MICRO_SCOPE_LEAK:${JSON.stringify(leaks.slice(0, 12))}`);
  if (expectMicro) check(data.micro.length > 0, `${name}:DEBUG_HOVER_HAS_NO_MICRO_LINES`);
  if (!country || !data.state.debugBoundaries) check(data.micro.length === 0, `${name}:MICRO_VISIBLE_WITHOUT_DEBUG_HOVER`);
  if (country === 'CHN') check(!countryCounts.KOR, `${name}:SECOND_HOP_KOR_MICROS_VISIBLE`);
  if (country === 'USA') check(!['CHN', 'KOR', 'PRK'].some(id => countryCounts[id]), `${name}:USA_HOVER_LEAKS_CHINA_OR_KOREAN_MICROS`);
  const lodIds = new Set(data.micro.filter(f => f.layerId === MICRO_LOD).map(f => Number(f.id))), originalIds = new Set(data.micro.filter(f => f.layerId !== MICRO_LOD).map(f => Number(f.id)));
  check(![...lodIds].some(n => originalIds.has(n)), `${name}:MICRO_LOD_AND_ORIGINAL_DRAW_SAME_EDGE`);
  check(typeof data.stats.microDisplayLodReady === 'boolean' && typeof data.stats.microDisplayLodActive === 'boolean' && typeof data.stats.microDisplayLodInScope === 'boolean', `${name}:MICRO_LOD_DIAGNOSTICS_MISSING`);
  const microLodOrdinals = new Set(bootstrap.microBoundaryLod.edgeOrdinals), chnOriginalIds = new Set([...originalIds].filter(n => microLodOrdinals.has(n)));
  check(data.stats.microDisplayLodActive === expectMicroLod, `${name}:MICRO_LOD_ACTIVITY_MISMATCH`);
  if (expectMicroLod) {
    check(data.stats.microDisplayLodReady && data.stats.microDisplayLodVertexCount === 182690 && data.stats.microDisplayLodSourceWrites === 1 && lodIds.size > 0, `${name}:LOW_ZOOM_MICRO_LOD_NOT_READY_OR_VISIBLE`);
    check(chnOriginalIds.size === 0, `${name}:LOW_ZOOM_LOD_RETAINS_CHN_ORIGINAL_STROKES`);
  } else check(lodIds.size === 0, `${name}:MICRO_LOD_VISIBLE_OUTSIDE_ELIGIBLE_SCOPE`);
  if (data.zoom >= 7 && expectMicro) check(chnOriginalIds.size > 0, `${name}:HIGH_ZOOM_CHN_ORIGINAL_MICROS_MISSING`);
  if (expectExact) check(data.exactCells.length > 0 && data.stats.selectedDetailCells > 0, `${name}:HIGH_ZOOM_CHN_EXACT_NOT_EXERCISED`);
  const record = {...data, name, expectedCountries: allowed, microCountries: countryCounts, micro: summarize(data.micro.map(f => f.id)),
    microLayers: data.microLayers.map(layer => {if (!layer) return null; const {filter, ...state} = layer, encoded = JSON.stringify(filter); return {...state, filterSummary: {sha256: digest(encoded), byteLength: Buffer.byteLength(encoded)}};}),
    microByLayer: Object.fromEntries([...new Set(data.micro.map(f => f.layerId))].map(id => [id, summarize(data.micro.filter(f => f.layerId === id).map(f => f.id))])),
    white: summarize(data.white.map(f => f.id)), provinceWhite: summarize(data.white.filter(f => provinceIds.has(Number(f.id))).map(f => f.id)),
    exactCells: summarize(data.exactCells), exactEdges: summarize(data.exactEdges), frontQuery: summarize(data.frontQuery.map(f => f.id)), frontGeometryIds: summarize(data.frontGeometryIds),
    expectedMicroLod: expectMicroLod, chnOriginalMicroIds: summarize([...chnOriginalIds]), microRequestCount: microRequests().length};
  report.views.push(record); if (takeScreenshot) await screenshot(name);
  console.log(JSON.stringify({name, debug: data.state.debugBoundaries, hover: country, scope: allowed, micro: record.micro.count, microCountries: countryCounts, exactCells: record.exactCells.count}));
  return record;
}

try {
  browser = await chromium.launch({headless: true, args: ['--enable-unsafe-swiftshader', '--enable-precise-memory-info']});
  context = await browser.newContext({viewport: report.conditions.viewport, deviceScaleFactor: 1, locale: 'ko-KR', reducedMotion: 'reduce'});
  await context.route('**/*', async route => {
    const request = route.request(), u = new URL(request.url());
    if (((u.protocol === 'http:' || u.protocol === 'https:') && u.origin !== base.origin) || u.pathname.startsWith('/api/simulation/turn')) {
      report.failures.push({message: 'EXTERNAL_OR_TURN_REQUEST_FORBIDDEN', url: u.href}); await route.abort('blockedbyclient'); return;
    }
    if (u.pathname === '/api/simulation/game' && request.method() === 'POST') {
      let command; try {command = request.postDataJSON();} catch { /* Invalid commands are blocked. */ }
      const allowed = command?.operation === 'start' || command?.operation === 'select-player' && command.countryId === 'CHN' && ownSessions.has(command.sessionId);
      if (!allowed) {report.failures.push({message: 'GAME_COMMAND_FORBIDDEN', operation: command?.operation}); await route.abort('blockedbyclient'); return;}
      report.commands.push({case: currentCase, operation: command.operation, countryId: command.countryId ?? null});
    }
    await route.continue();
  });
  page = await context.newPage();
  page.on('request', r => report.requests.push({case: currentCase, url: r.url(), method: r.method()}));
  page.on('requestfailed', r => report.failedRequests.push({url: r.url(), reason: r.failure()?.errorText}));
  page.on('pageerror', e => {const error = {case: currentCase, message: e.message, stack: e.stack ?? null}; report.pageErrors.push(error); console.log(JSON.stringify({pageError: error})); rejectRuntimeError(Error(`BROWSER_RUNTIME_ERROR:${e.stack ?? e.message}`));});
  page.on('console', m => {if (m.type() === 'error') report.consoleErrors.push(m.text());});
  page.on('response', r => {
    if (r.url() === `${base.origin}/api/simulation/game` && r.request().method() === 'POST' && r.ok()) responseReads.push(r.json().then(body => {if (typeof body.sessionId === 'string') ownSessions.add(body.sessionId);}).catch(e => report.failures.push({message: 'SESSION_CAPTURE_FAILED', error: String(e)})));
  });
  if (runtimeProbe) probeTimer = setTimeout(() => rejectRuntimeError(Error('RUNTIME_PROBE_DEADLINE_30000')), 30000);
  await guardRuntime(page.goto(base.origin, {waitUntil: 'domcontentloaded', timeout: 180000})); await settled(); await Promise.all(responseReads);
  check(ownSessions.size === 1, 'EXPECTED_ONE_FRESH_OWN_SESSION');
  const bootstrapResponse = await context.request.get(`${base.origin}/api/world/catalog/operational/map`); check(bootstrapResponse.ok(), 'BOOTSTRAP_UNAVAILABLE'); bootstrap = await bootstrapResponse.json();
  check(bootstrap.catalog.catalogRef.catalogVersion === pointer.catalogVersion && bootstrap.catalog.counts.cells === 8005, 'BOOTSTRAP_NOT_CURRENT_FINE_CATALOG');
  check(bootstrap.provincePresentationBoundaryOrdinals?.length === 994, 'CURRENT_PROVINCE_994_SET_MISSING');
  check(bootstrap.microBoundaryLod?.edgeOrdinals?.length === 7568, 'AFTER_MICRO_LOD_7568_DESCRIPTOR_REQUIRED');
  microPath = bootstrap.microBoundaryLod.artifact.path;
  check(typeof microPath === 'string' && /^\/data\/territory-catalog\/[^/]+\/display\/chn-micro-lines-[a-f0-9]{64}\.geojson\.gz$/.test(microPath), 'MICRO_LOD_ARTIFACT_PATH_MISSING');
  report.bootstrap = {catalogRef: bootstrap.catalog.catalogRef, provinceCount: bootstrap.provincePresentationBoundaryOrdinals.length,
    provinceLod: bootstrap.provinceBoundaryLod ?? null, microLod: bootstrap.microBoundaryLod ? {...bootstrap.microBoundaryLod, edgeOrdinals: summarize(bootstrap.microBoundaryLod.edgeOrdinals)} : null};

  currentCase = 'actual-chn-game-entry';
  await page.getByLabel('국가 검색', {exact: true}).fill('CHN'); await page.locator('#country-CHN button').click();
  await page.locator('aside.panel .panel-kicker').filter({hasText: /CHN/}).waitFor();
  const countryName = (await page.locator('#country-title').innerText()).trim();
  await page.getByRole('button', {name: `${countryName}을(를) 플레이 국가로 선택`, exact: true}).click();
  await page.waitForURL(url => url.pathname === '/game', {timeout: 180000}); await page.locator('[data-testid="game-screen"]').waitFor(); await settled();
  gameBaseline = await page.evaluate(() => window.__PAX_OPERATIONAL_DEBUG__.getState());
  check(gameBaseline.revision === 0 && !gameBaseline.debugBoundaries, 'FRESH_GAME_OR_DEFAULT_DEBUG_WRONG');
  check(gameBaseline.counts.cells === 8005 && gameBaseline.controlCounts.CHN?.owned === 3320, 'ACTUAL_GAME_FINE_COUNTS_WRONG');
  report.entry = {pathname: new URL(page.url()).pathname, worldRevision: gameBaseline.revision, simulationRevision: gameBaseline.simulationRevision, cells: gameBaseline.counts.cells, CHN: gameBaseline.controlCounts.CHN};
  // Verify the player-visible territorial counts, rather than only a debug bridge.
  await page.locator('[data-testid="map-country-picker"]').selectOption('PRK');
  await page.locator('[data-testid="map-country-picker"]').selectOption('CHN');
  await page.locator('[data-testid="country-territorial-control"]').waitFor();
  report.entry.controlPanel = await page.locator('[data-testid="country-territorial-control"]').evaluate(node => Object.fromEntries([...node.querySelectorAll('dt')].map(dt => [dt.textContent, dt.nextElementSibling?.textContent])));
  check(report.entry.controlPanel['소유 영토'] === '3320' && report.entry.controlPanel['통제 영토'] === '3320', 'VISIBLE_CHN_CONTROL_PANEL_NOT_FINE');
  await screenshot('actual-game-chn-3320'); await page.locator('[data-testid="game-panel"] .game-panel__close').click();
  await leaveCanvas(); await camera([127, 39.5], 5.2);
  if (runtimeProbe) {report.probeComplete = true; throw Error('RUNTIME_PROBE_COMPLETED_NO_ERROR');}
  const normalCold = await view('normal-game-korea-no-hover', null, {takeScreenshot: true});
  check(microRequests().length === 0 && !normalCold.stats.microDisplayLodReady && normalCold.stats.microDisplayLodSourceWrites === 0, 'MICRO_LOD_LOADED_IN_NORMAL_MODE');

  await toggleDebugByClick(true); await screenshot('hud-debug-checkbox-on'); await closeSettings(); await leaveCanvas();
  await view('debug-on-korea-no-hover', null);
  check(microRequests().length === 0, 'MICRO_LOD_LOADED_WITHOUT_A_COUNTRY_HOVER');
  await hover([125.75, 39.03], 'PRK'); const prk = await view('prk-normal-zoom-scope', 'PRK', {expectMicro: true, takeScreenshot: true});
  check(microRequests().length === 1 && prk.stats.microDisplayLodSourceWrites === 1, 'FIRST_ELIGIBLE_HOVER_DID_NOT_LOAD_MICRO_EXACTLY_ONCE');
  check((prk.microCountries.PRK ?? 0) > 0 && (prk.microCountries.KOR ?? 0) > 0 && (prk.microCountries.CHN ?? 0) > 0, 'PRK_VIEW_DOES_NOT_EXERCISE_CHN_AND_BOTH_KOREAS');
  await hover([125.82, 39.08], 'PRK'); const repeated = await view('prk-same-country-move', 'PRK', {expectMicro: true});
  check(prk.stats.debugBoundaryScopeBuilds === repeated.stats.debugBoundaryScopeBuilds && prk.stats.debugBoundaryFilterWrites === repeated.stats.debugBoundaryFilterWrites, 'SAME_COUNTRY_HOVER_REBUILT_SCOPE_OR_FILTER');
  // Keep the physical pointer stationary while the map moves under it. A camera
  // change must re-hit-test the new country instead of retaining the old PRK ID.
  currentCase = 'stationary-pointer-prk-to-usa';
  await leaveCanvas(); await camera([125.75, 39.03], 5.2); await hover([125.75, 39.03], 'PRK');
  report.stationaryPointer = {before: await page.evaluate(() => ({state: window.__PAX_OPERATIONAL_DEBUG__.getState(), stats: window.__PAX_OPERATIONAL_DEBUG__.getUpdateStats()})), pointerMovesDuringCameraChange: 0};
  await camera([-100, 40], 5.2);
  report.stationaryPointer.after = await page.evaluate(() => ({state: window.__PAX_OPERATIONAL_DEBUG__.getState(), stats: window.__PAX_OPERATIONAL_DEBUG__.getUpdateStats()}));
  if (report.stationaryPointer.after.state.hoveredCountryId !== 'USA') await screenshot('stationary-pointer-stale-hover-failure');
  check(report.stationaryPointer.after.state.hoveredCountryId === 'USA', `STATIONARY_POINTER_CAMERA_RETAINS_STALE_HOVER:${report.stationaryPointer.after.state.hoveredCountryId}`);
  await view('stationary-pointer-prk-to-usa', 'USA', {takeScreenshot: true});
  await leaveCanvas(); await camera([127, 39.5], 5.2);
  await hover([124.1, 40.45], 'CHN'); await view('chn-no-second-hop-kor', 'CHN', {expectMicro: true, takeScreenshot: true});
  await hover([123.6, 39.1], null); await view('sea-clears-all-micros', null, {takeScreenshot: true});

  await leaveCanvas(); await camera([170, 50], 2.7); await hover([125.75, 39.03], 'PRK');
  const koreaBeforeUsa = await view('wide-view-prk-before-usa', 'PRK', {expectMicro: true});
  check((koreaBeforeUsa.microCountries.PRK ?? 0) + (koreaBeforeUsa.microCountries.KOR ?? 0) > 0, 'KOREA_NOT_VISIBLE_IN_USA_COMPARISON_CAMERA');
  await hover([210, 64], 'USA'); await view('usa-hides-visible-china-and-koreas', 'USA', {takeScreenshot: true});

  await leaveCanvas(); await camera([127, 39.5], 5.2); await openSettings();
  const checkbox = page.getByRole('checkbox', {name: /지도 디버그 모드/}); await checkbox.focus(); await hover([125.75, 39.03], 'PRK');
  await checkbox.press('Space'); await page.waitForFunction(() => !window.__PAX_OPERATIONAL_DEBUG__?.getState().debugBoundaries, null, {timeout: 15000});
  check(!await checkbox.isChecked(), 'HUD_KEYBOARD_OFF_NOT_REFLECTED'); await view('hud-off-keeps-current-prk-hover-no-micros', 'PRK', {takeScreenshot: true});
  await checkbox.press('Space'); await page.waitForFunction(() => window.__PAX_OPERATIONAL_DEBUG__?.getState().debugBoundaries, null, {timeout: 15000});
  check(await checkbox.isChecked(), 'HUD_KEYBOARD_ON_NOT_REFLECTED'); await view('hud-on-restores-current-prk-hover', 'PRK', {expectMicro: true, takeScreenshot: true});
  await closeSettings(); await leaveCanvas();

  await camera([125, 39.7], 7.3); await hover([124.1, 40.45], 'CHN');
  await page.waitForFunction(() => window.__PAX_OPERATIONAL_DEBUG__?.getUpdateStats()?.selectedDetailCells > 0, null, {timeout: 30000});
  await view('chn-high-zoom-exact-scope', 'CHN', {expectMicro: true, expectExact: true, takeScreenshot: true});
  await hover([125.75, 39.03], 'PRK'); const highPrk = await view('prk-high-zoom-pbf-scope', 'PRK', {expectMicro: true, takeScreenshot: true});
  check(highPrk.exactCells.count === 0 && highPrk.stats.selectedDetailCells === 0, 'PRK_HOVER_RETAINED_CHN_EXACT_CELLS');
  await openSettings(); await hover([124.1, 40.45], 'CHN', false); await hover([125.75, 39.03], 'PRK', false);
  await page.locator('[data-testid="settings-overlay"]').hover(); await waitHover(null); await settled();
  const cleared = await view('rapid-country-to-sidebar-clears-scope', null, {takeScreenshot: true});
  check(cleared.exactCells.count === 0 && cleared.exactEdges.count === 0 && cleared.stats.selectedDetailCells === 0, 'SIDEBAR_RETAINED_OLD_EXACT_GEOMETRY');
  await page.waitForTimeout(1000); const delayed = await view('sidebar-still-clear-after-pending-responses', null);
  check(delayed.exactCells.count === 0 && delayed.exactEdges.count === 0, 'LATE_RESPONSE_RESTORED_EXACT_GEOMETRY_AFTER_SIDEBAR');
  await toggleDebugByClick(false); await closeSettings(); await leaveCanvas(); await camera([118, 31], 5);
  await hover([118, 31], 'CHN'); const normal = await view('final-normal-game-china-provinces', 'CHN', {takeScreenshot: true});
  check(normal.provinceWhite.count > 0, 'NORMAL_CHINA_PROVINCES_MISSING_AFTER_DEBUG_OFF');
  check(microRequests().length === 1 && normal.stats.microDisplayLodSourceWrites === 1, 'WARM_HOVER_CAMERA_OR_DEBUG_TOGGLE_REFETCHES_OR_REWRITES_MICRO_LOD');
  report.microWarmReuse = {requestCount: microRequests().length, sourceWrites: normal.stats.microDisplayLodSourceWrites, vertexCount: normal.stats.microDisplayLodVertexCount};
  await Promise.all(responseReads); check(ownSessions.size === 1 && report.commands.filter(c => c.operation === 'start').length === 1, 'GAME_NAVIGATION_ALLOCATED_EXTRA_SESSION');
  check(report.commands.some(c => c.operation === 'select-player' && c.countryId === 'CHN'), 'ACTUAL_UI_SELECT_PLAYER_NOT_EXERCISED');
  report.resources = await page.evaluate(() => performance.getEntriesByType('resource').map(r => ({name: r.name, duration: r.duration, transferSize: r.transferSize, encodedBodySize: r.encodedBodySize, decodedBodySize: r.decodedBodySize})));
} catch (error) {
  if (!(runtimeProbe && error instanceof Error && error.message === 'RUNTIME_PROBE_COMPLETED_NO_ERROR')) report.failures.push({case: currentCase, message: error instanceof Error ? error.message : String(error), stack: error instanceof Error ? error.stack : null});
  if (page && !page.isClosed()) {
    try {report.failureDiagnostic = await page.evaluate(() => ({pathname: location.pathname, state: window.__PAX_OPERATIONAL_DEBUG__?.getState() ?? null, stats: window.__PAX_OPERATIONAL_DEBUG__?.getUpdateStats() ?? null, alerts: [...document.querySelectorAll('[role="alert"], .map-status')].map(n => n.textContent)})); await screenshot('failure-diagnostic');}
    catch (diagnosticError) {report.failures.push({message: 'FAILURE_DIAGNOSTIC_CAPTURE_FAILED', error: String(diagnosticError)});}
  }
}
finally {
  if (probeTimer) clearTimeout(probeTimer);
  await Promise.all(responseReads);
  for (const id of ownSessions) {try {const response = await context.request.delete(`${base.origin}/api/simulation/game`, {headers: {'X-Pax-Game': id}}); report.cleanup.push({sessionIdSha256: digest(id), status: response.status()}); check(response.status() === 204, 'OWN_SESSION_DELETE_FAILED');} catch (error) {report.failures.push({message: 'OWN_SESSION_CLEANUP_FAILED', error: String(error)});}}
  report.fullCountryGeometryRequests = report.requests.filter(r => /\/detail\/countries\/[A-Z]{3}\.geojson\.gz(?:$|\?)/.test(r.url));
  report.microLodRequests = microRequests();
  if (report.fullCountryGeometryRequests.length) report.failures.push({message: 'FULL_COUNTRY_GEOMETRY_REQUEST_FORBIDDEN', count: report.fullCountryGeometryRequests.length});
  if (report.pageErrors.length || report.consoleErrors.length) report.failures.push({message: 'BROWSER_ERRORS', pageErrors: report.pageErrors.length, consoleErrors: report.consoleErrors.length});
  const unexpected = report.failedRequests.filter(r => !/ERR_ABORTED/.test(r.reason ?? '')); if (unexpected.length) report.failures.push({message: 'UNEXPECTED_NETWORK_FAILURE', requests: unexpected});
  for (const expected of [pointerPin, ...sourcePins]) {try {const actual = pin(expected.path); if (actual.sha256 !== expected.sha256 || actual.byteLength !== expected.byteLength) report.failures.push({message: 'SOURCE_CHANGED_DURING_VERIFICATION', path: expected.path});} catch (error) {report.failures.push({message: 'SOURCE_PIN_RECHECK_FAILED', path: expected.path, error: String(error)});}}
  if (context) await context.close().catch(error => report.failures.push({message: 'CONTEXT_CLOSE_FAILED', error: String(error)}));
  if (browser) await browser.close().catch(error => report.failures.push({message: 'BROWSER_CLOSE_FAILED', error: String(error)}));
  report.elapsedMs = performance.now() - started; report.pass = report.failures.length === 0;
  const file = path.join(output, `${label}.json`); preserve(file); fs.writeFileSync(file, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({pass: report.pass, artifact: pin(file), views: report.views.length, failures: report.failures.map(f => f.message)})); if (!report.pass) process.exitCode = 1;
}
