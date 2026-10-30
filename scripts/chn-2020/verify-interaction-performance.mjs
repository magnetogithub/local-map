// Isolated local Chromium interaction benchmark. No existing browser or game is
// attached, no turn is submitted, and the development bridge changes views only.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {performance as nodePerformance} from 'node:perf_hooks';
import {chromium} from '@playwright/test';

const option = name => {const i = process.argv.indexOf(name); if (i < 0) return null; const value = process.argv[i + 1]; if (!value || value.startsWith('--')) throw Error(`MISSING_ARGUMENT:${name}`); return value;};
const phase = option('--phase');
if (!['baseline', 'optimized'].includes(phase)) throw Error('USE_PHASE_BASELINE_OR_OPTIMIZED');
const cpuProfile = process.argv.includes('--cpu-profile');
const baseURL = option('--url') ?? 'http://127.0.0.1:3002';
const base = new URL(baseURL);
if (!['localhost', '127.0.0.1', '[::1]'].includes(base.hostname) || !['http:', 'https:'].includes(base.protocol)) throw Error('LOCAL_BROWSER_ONLY');
const pointerPath = option('--pointer') ?? 'data/runtime/operational-catalog/current.json';
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const pin = file => {const bytes = fs.readFileSync(file); return {path: file.replaceAll('\\', '/'), sha256: digest(bytes), byteLength: bytes.length};};
const pointer = JSON.parse(fs.readFileSync(pointerPath, 'utf8')), pointerPin = pin(pointerPath);
const outputRoot = path.resolve('reports/chn-perf-20261030');
fs.mkdirSync(outputRoot, {recursive: true});
const reportPath = path.join(outputRoot, `${phase}-interaction.json`);
const codePaths = ['scripts/chn-2020/verify-interaction-performance.mjs', 'src/components/map/OperationalWorldMap.tsx',
  'src/lib/map/operational-map-consumer.ts', 'src/lib/map/operational-map-sources.ts', 'src/lib/map/operational-vector-delivery.ts',
  'src/lib/projection/operational-map-projection.ts', 'src/lib/map/operational-country-labels.ts'];
const codePins = codePaths.map(pin), started = nodePerformance.now();
const failures = [], phases = [], requests = [], responses = [], failedRequests = [], consoleErrors = [], pageErrors = [], screenshots = [];
const report = {schemaVersion: 'chn-interaction-performance-v1', phase, pass: false, pointer: pointerPin, catalogVersion: pointer.catalogVersion, code: codePins,
  conditions: {baseURL, viewport: {width: 1440, height: 900}, deviceScaleFactor: 1, browser: 'Chromium headless with WebGL; unsafe SwiftShader fallback enabled; actual driver recorded below',
    browserCache: 'fresh isolated context; Playwright interception disables HTTP cache in both phases; application decoded-byte cache remains active', serverAndOSCache: 'not flushed', reducedMotion: 'reduce',
    cameraWorkflow: 'Fixed rAF-paced jumpTo trajectory; each phase waits for map and detail settlement. This is a synthetic repeatable interaction, not a mouse hardware profile.',
    cpuProfile, cpuProfileScope: 'CDP V8 main renderer thread only; worker, compositor and GPU time are not attributed by this sampler',
    externalAiCalls: 0, gameWrites: 'only the isolated context ordinary initial game allocation; no AI/turn/game commands are sent by the probe'},
  phases, requests, responses, failedRequests, consoleErrors, pageErrors, screenshots, failures, cpuProfiles: []};
const check = (condition, message) => {if (!condition) throw Error(message);};
let browser, context, page, profiler, currentPhase = 'navigation';

function preserve(file) {
  if (!fs.existsSync(file)) return;
  const archive = path.join(outputRoot, 'archive'); fs.mkdirSync(archive, {recursive: true});
  const old = pin(file), target = path.join(archive, `${path.basename(file, path.extname(file))}-${old.sha256}${path.extname(file)}`);
  if (!fs.existsSync(target)) fs.copyFileSync(file, target);
}
function frameStats(entries) {
  const values = entries.map(e => e.intervalMs).sort((a, b) => a - b);
  const percentile = p => values.length ? values[Math.max(0, Math.ceil(values.length * p) - 1)] : null;
  return {count: values.length, medianMs: percentile(.5), p95Ms: percentile(.95), maximumMs: values.at(-1) ?? null,
    over50ms: values.filter(v => v > 50).length, over100ms: values.filter(v => v > 100).length, intervalsMs: entries.map(e => e.intervalMs)};
}
function resourceTotals(resources) {
  const result = {};
  for (const r of resources) {
    const category = /\/detail\/countries\/CHN\.geojson\.gz(?:$|\?)/.test(r.name) ? 'fullChinaExact' : /\/detail\//.test(r.name) ? 'otherExact'
      : /\/tiles\//.test(r.name) ? 'vectorTiles' : /\/fonts\/|\.woff2?(?:$|\?)/.test(r.name) ? 'fonts' : 'applicationAndMetadata';
    const item = result[category] ?? {requests: 0, transferBytes: 0, encodedBodyBytes: 0, httpDecodedBodyBytes: 0};
    item.requests++; item.transferBytes += r.transferSize; item.encodedBodyBytes += r.encodedBodySize; item.httpDecodedBodyBytes += r.decodedBodySize; result[category] = item;
  }
  return result;
}
async function stopProfile(name) {
  const {profile} = await profiler.send('Profiler.stop');
  const file = path.join(outputRoot, `${phase}-${name}.cpuprofile`); preserve(file);
  fs.writeFileSync(file, JSON.stringify(profile));
  const self = new Map(), samples = profile.samples ?? [], deltas = profile.timeDeltas ?? [];
  const fallback = samples.length ? (profile.endTime - profile.startTime) / samples.length : 0;
  samples.forEach((id, i) => {const entry = self.get(id) ?? {samples: 0, selfMs: 0}; entry.samples++; entry.selfMs += (deltas[i] ?? fallback) / 1000; self.set(id, entry);});
  const durationMs = (profile.endTime - profile.startTime) / 1000;
  const topSelfTime = profile.nodes.map(node => ({...self.get(node.id) ?? {samples: 0, selfMs: 0},
    functionName: node.callFrame.functionName || '(anonymous)', url: node.callFrame.url, line: node.callFrame.lineNumber + 1,
    column: node.callFrame.columnNumber + 1, hitCount: node.hitCount ?? null})).filter(n => n.samples > 0).sort((a, b) => b.selfMs - a.selfMs).slice(0, 40);
  const result = {name, artifact: pin(file), durationMs, sampleCount: samples.length, functionNodeCount: profile.nodes.length,
    sampledSelfTimeMs: [...self.values()].reduce((sum, n) => sum + n.selfMs, 0), topSelfTime};
  report.cpuProfiles.push(result); return result;
}
async function settled() {
  await page.waitForFunction(() => window.__PAX_OPERATIONAL_DEBUG__?.isRenderSettled(), null, {timeout: 180000, polling: 100});
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}
async function snapshot() {
  return page.evaluate(() => {
    const debug = window.__PAX_OPERATIONAL_DEBUG__;
    if (!debug) throw Error('DEVELOPMENT_DEBUG_BRIDGE_MISSING');
    const state = debug.getState(), exactCells = debug.querySourceFeatureIds('world-operational-exact-cells'), exactEdges = debug.querySourceFeatureIds('world-operational-exact-edges');
    return {state: {catalogRef: state.catalogRef, revision: state.revision, simulationRevision: state.simulationRevision,
      counts: state.counts, selectedCountryId: state.selectedCountryId, debugBoundaries: state.debugBoundaries,
      baseStatus: state.baseStatus, worldStatus: state.worldStatus, detailStatus: state.detailStatus, appliedRevision: state.appliedRevision},
    center: debug.getCenter(), zoom: debug.getZoom(), updateStats: debug.getUpdateStats(), exactCells: [...exactCells].sort((a, b) => Number(a) - Number(b)),
    exactEdges: [...exactEdges].sort((a, b) => Number(a) - Number(b)), renderSettled: debug.isRenderSettled()};
  });
}
async function mark() {
  return page.evaluate(() => ({time: performance.now(), heap: performance.memory ? {usedJSHeapSize: performance.memory.usedJSHeapSize,
    totalJSHeapSize: performance.memory.totalJSHeapSize, jsHeapSizeLimit: performance.memory.jsHeapSizeLimit} : null}));
}
async function measure(name, action) {
  currentPhase = name;
  const profiling = !!profiler && ['world-pan-zoom', 'china-pan-zoom'].includes(name);
  if (profiling) await profiler.send('Profiler.start');
  const begin = await mark();
  let end;
  try {await action(); await settled(); end = await mark();}
  finally {if (profiling) await stopProfile(name);}
  const entries = await page.evaluate(({start, end}) => ({
    frames: window.__CHN_INTERACTION_METRICS__.frames.filter(e => e.at - e.intervalMs >= start && e.at <= end),
    longTasks: window.__CHN_INTERACTION_METRICS__.longTasks.filter(e => e.startTime < end && e.startTime + e.duration > start),
    resources: performance.getEntriesByType('resource').filter(e => e.startTime >= start && e.startTime <= end).map(e => ({name: e.name, startTime: e.startTime,
      duration: e.duration, initiatorType: e.initiatorType, transferSize: e.transferSize, encodedBodySize: e.encodedBodySize, decodedBodySize: e.decodedBodySize})),
  }), {start: begin.time, end: end.time});
  const state = await snapshot();
  check(state.state.catalogRef.catalogVersion === pointer.catalogVersion, `${name}:CATALOG_MISMATCH`);
  check(state.state.revision === 0 && state.state.simulationRevision === 0, `${name}:GAME_REVISION_CHANGED`);
  check(!state.updateStats?.resyncRequired, `${name}:MAP_RESYNC_REQUIRED`);
  const item = {name, startTime: begin.time, endTime: end.time, durationMs: end.time - begin.time, frames: frameStats(entries.frames),
    longTasks: {count: entries.longTasks.length, totalWithinPhaseMs: entries.longTasks.reduce((sum, e) => sum + Math.max(0, Math.min(end.time, e.startTime + e.duration) - Math.max(begin.time, e.startTime)), 0),
      maximumMs: Math.max(0, ...entries.longTasks.map(e => e.duration)), entries: entries.longTasks},
    heapBefore: begin.heap, heapAfter: end.heap, resources: entries.resources, resourceTotals: resourceTotals(entries.resources), ...state};
  phases.push(item);
  console.log(JSON.stringify({phase, name, ms: item.durationMs, frameP95Ms: item.frames.p95Ms, longTasksMs: item.longTasks.totalWithinPhaseMs,
    heap: item.heapAfter?.usedJSHeapSize, exactCells: item.exactCells.length, exactEdges: item.exactEdges.length}));
  return item;
}
async function camera(center, zoom) {await page.evaluate(({center, zoom}) => window.__PAX_OPERATIONAL_DEBUG__.jumpTo(center, zoom), {center, zoom});}
async function trajectory(center, zoom, steps = 36, longitude = .8, latitude = .25, zoomAmplitude = .15) {
  await page.evaluate(async ({center, zoom, steps, longitude, latitude, zoomAmplitude}) => {
    const debug = window.__PAX_OPERATIONAL_DEBUG__;
    for (let i = 0; i < steps; i++) {
      await new Promise(resolve => requestAnimationFrame(resolve));
      const p = (i + 1) / steps * Math.PI * 2;
      debug.jumpTo([center[0] + Math.sin(p) * longitude, center[1] + Math.sin(p * 2) * latitude], zoom + Math.sin(p) * zoomAmplitude);
    }
    debug.jumpTo(center, zoom);
  }, {center, zoom, steps, longitude, latitude, zoomAmplitude});
  // Same fixed wait in both phases lets a normal moveend debounce finish.
  await page.waitForTimeout(500);
}
async function screenshot() {
  // A source can report loaded while its newly submitted worker tile is still
  // pending. Wait for delivered land rather than accepting an empty screenshot.
  await page.waitForFunction(() => window.__PAX_OPERATIONAL_DEBUG__?.queryRenderedFillIds().length > 0, null, {timeout: 180000, polling: 250});
  const count = await page.evaluate(() => window.__PAX_OPERATIONAL_DEBUG__.queryRenderedFillIds().length);
  check(count > 0, 'SCREENSHOT_HAS_NO_RENDERED_LAND');
  const file = path.join(outputRoot, `${phase}-china.png`); preserve(file);
  await page.screenshot({path: file, fullPage: false}); screenshots.push({...pin(file), renderedFillFeatures: count});
}
function exactRequestCount() {return requests.filter(r => /\/detail\//.test(r.url)).length;}

try {
  browser = await chromium.launch({headless: true, args: ['--enable-unsafe-swiftshader', '--enable-precise-memory-info']});
  context = await browser.newContext({viewport: {width: 1440, height: 900}, deviceScaleFactor: 1, locale: 'ko-KR', reducedMotion: 'reduce'});
  await context.addInitScript(() => {
    performance.setResourceTimingBufferSize(10000);
    const metrics = window.__CHN_INTERACTION_METRICS__ = {frames: [], longTasks: [], longTasksSupported: false};
    let previous;
    const frame = at => {if (previous !== undefined) metrics.frames.push({at, intervalMs: at - previous}); previous = at; requestAnimationFrame(frame);};
    requestAnimationFrame(frame);
    try {new PerformanceObserver(list => {for (const e of list.getEntries()) metrics.longTasks.push({startTime: e.startTime, duration: e.duration, name: e.name});}).observe({type: 'longtask', buffered: true}); metrics.longTasksSupported = true;} catch { /* Report unsupported API explicitly below. */ }
  });
  // The runner cannot submit a real AI turn even if a UI regression does so.
  await context.route('**/*', async route => {
    const url = route.request().url();
    if (/\/api\/simulation\/turn(?:$|\?)/.test(url)) {failures.push({message: 'FORBIDDEN_AI_TURN_REQUEST', url}); await route.abort('blockedbyclient'); return;}
    if (url.startsWith('http') && new URL(url).origin !== base.origin) {failures.push({message: 'EXTERNAL_REQUEST_FORBIDDEN', url}); await route.abort('blockedbyclient'); return;}
    await route.continue();
  });
  page = await context.newPage();
  if (cpuProfile) {profiler = await context.newCDPSession(page); await profiler.send('Profiler.enable'); await profiler.send('Profiler.setSamplingInterval', {interval: 1000});}
  page.on('request', request => requests.push({phase: currentPhase, url: request.url(), method: request.method()}));
  page.on('response', response => {responses.push({phase: currentPhase, url: response.url(), status: response.status()}); if (response.status() >= 400) failures.push({message: `HTTP_${response.status()}`, url: response.url()});});
  page.on('requestfailed', request => failedRequests.push({phase: currentPhase, url: request.url(), error: request.failure()?.errorText, ordinaryCancellation: request.failure()?.errorText === 'net::ERR_ABORTED'}));
  page.on('console', message => {if (message.type() === 'error') consoleErrors.push({text: message.text(), location: message.location()});});
  page.on('pageerror', error => pageErrors.push({message: error.message, stack: error.stack}));
  const navigationStart = nodePerformance.now();
  await page.goto(baseURL, {waitUntil: 'domcontentloaded', timeout: 180000});
  await page.locator('[data-testid="world-map"]').waitFor({state: 'visible', timeout: 180000}); await settled();
  report.mapReady = {wallMs: nodePerformance.now() - navigationStart, ...await mark(), ...await snapshot()};
  report.hardware = await page.evaluate(() => {
    const canvas = document.querySelector('canvas.maplibregl-canvas');
    const gl = canvas?.getContext('webgl2') || canvas?.getContext('webgl');
    const extension = gl?.getExtension('WEBGL_debug_renderer_info');
    const renderer = extension ? gl.getParameter(extension.UNMASKED_RENDERER_WEBGL) : gl?.getParameter(gl.RENDERER);
    return {hardwareConcurrency: navigator.hardwareConcurrency, deviceMemoryGiB: navigator.deviceMemory ?? null, platform: navigator.platform,
      userAgent: navigator.userAgent, webgl: gl ? {renderer, vendor: extension ? gl.getParameter(extension.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR),
        version: gl.getParameter(gl.VERSION), shadingLanguageVersion: gl.getParameter(gl.SHADING_LANGUAGE_VERSION),
        drawingBufferWidth: gl.drawingBufferWidth, drawingBufferHeight: gl.drawingBufferHeight, contextAttributes: gl.getContextAttributes(),
        softwareRenderer: /swiftshader|software|llvmpipe/i.test(String(renderer))} : null};
  });
  check(report.mapReady.state.catalogRef.catalogVersion === pointer.catalogVersion, 'INITIAL_CATALOG_MISMATCH');
  await page.evaluate(() => {const d = window.__PAX_OPERATIONAL_DEBUG__; d.selectCountryDetail(null); d.setDebugBoundaries(false);});
  await measure('world-pan-zoom', async () => {await camera([15, 20], 1.2); await trajectory([15, 20], 1.2, 48, 10, 2, .18);});
  await measure('china-pan-zoom', async () => {await camera([104.5, 35], 3.3); await trajectory([104.5, 35], 3.3, 48, 3, 1, .25);});
  const selectedLow = await measure('select-china-z3.3', async () => {await camera([104.5, 35], 3.3); await page.evaluate(() => window.__PAX_OPERATIONAL_DEBUG__.selectCountryDetail('CHN'));});
  check(selectedLow.state.selectedCountryId === 'CHN', 'ORDINARY_CHINA_SELECTION_FAILED');
  if (phase === 'optimized') check(selectedLow.exactCells.length === 0 && selectedLow.exactEdges.length === 0, 'LOW_ZOOM_EXACT_DETAIL_MOUNTED');
  await screenshot();
  for (const zoom of [5.3, 6.2]) {
    const view = await measure(`selected-china-z${zoom}-pan`, async () => {await camera([124.4, 40.6], zoom); await trajectory([124.4, 40.6], zoom, 36, .3, .1, .1);});
    if (phase === 'optimized') check(view.exactCells.length === 0 && view.exactEdges.length === 0, `${zoom}:LOW_ZOOM_EXACT_DETAIL_MOUNTED`);
  }
  const normalBorder = await measure('normal-border-z7.3', async () => {await camera([124.4, 40.6], 7.3); await page.waitForTimeout(500);});
  if (phase === 'optimized') check(normalBorder.exactCells.length === 0 && normalBorder.exactEdges.length === 0, 'NORMAL_MODE_EXACT_SELECTION_DETAIL_MOUNTED');
  const border = await measure('debug-border-z7.3', async () => {await page.evaluate(() => window.__PAX_OPERATIONAL_DEBUG__.setDebugBoundaries(true)); await page.waitForTimeout(500);});
  check(border.exactCells.length > 0, 'HIGH_ZOOM_VIEWPORT_DETAIL_MISSING');
  if (phase === 'optimized') check(border.exactCells.length < 3320, 'HIGH_ZOOM_DETAIL_IS_WHOLE_CHINA');
  const stableRequestsBefore = exactRequestCount(), stableBefore = await snapshot();
  const stable = await measure('stable-scope-tiny-pan', async () => {await trajectory([124.4, 40.6], 7.3, 30, .0000001, .0000001, 0);});
  const counterNames = ['detailSourceWrites', 'exactSourceWrites', 'detailDataWrites'];
  const sourceWriteCounter = counterNames.find(name => typeof stableBefore.updateStats?.[name] === 'number' && typeof stable.updateStats?.[name] === 'number');
  report.stableScope = {sameCellIds: JSON.stringify(stableBefore.exactCells) === JSON.stringify(stable.exactCells), sameEdgeIds: JSON.stringify(stableBefore.exactEdges) === JSON.stringify(stable.exactEdges),
    exactRequestsBefore: stableRequestsBefore, exactRequestsAfter: exactRequestCount(), sourceWriteCounter: sourceWriteCounter ?? null,
    sourceWritesBefore: sourceWriteCounter ? stableBefore.updateStats[sourceWriteCounter] : null, sourceWritesAfter: sourceWriteCounter ? stable.updateStats[sourceWriteCounter] : null,
    cellsUpdatedBefore: stableBefore.updateStats?.cellsUpdated, cellsUpdatedAfter: stable.updateStats?.cellsUpdated};
  if (phase === 'optimized') {
    check(report.stableScope.sameCellIds && report.stableScope.sameEdgeIds, 'TINY_PAN_CHANGED_DETAIL_SCOPE');
    check(report.stableScope.exactRequestsBefore === report.stableScope.exactRequestsAfter, 'STABLE_SCOPE_RELOADED_EXACT_DETAIL');
    check(!!sourceWriteCounter, 'SOURCE_WRITE_COUNTER_REQUIRED_FOR_STABLE_SCOPE_PROOF');
    check(report.stableScope.sourceWritesBefore === report.stableScope.sourceWritesAfter, 'STABLE_SCOPE_REWROTE_EXACT_SOURCE');
  }
} catch (error) {
  failures.push({message: error instanceof Error ? error.message : String(error), stack: error instanceof Error ? error.stack : null});
} finally {
  if (page) try {
    report.final = await page.evaluate(() => ({time: performance.now(), longTasksSupported: window.__CHN_INTERACTION_METRICS__?.longTasksSupported,
      frames: window.__CHN_INTERACTION_METRICS__?.frames ?? [], longTasks: window.__CHN_INTERACTION_METRICS__?.longTasks ?? [],
      resources: performance.getEntriesByType('resource').map(e => ({name: e.name, startTime: e.startTime, duration: e.duration, transferSize: e.transferSize, encodedBodySize: e.encodedBodySize, decodedBodySize: e.decodedBodySize})),
      heap: performance.memory ? {usedJSHeapSize: performance.memory.usedJSHeapSize, totalJSHeapSize: performance.memory.totalJSHeapSize} : null}));
    report.final.frames = frameStats(report.final.frames); report.final.resourceTotals = resourceTotals(report.final.resources);
  } catch (error) {failures.push({message: `FINAL_METRICS_FAILED:${String(error)}`});}
  report.fullChinaRequests = requests.filter(r => /\/detail\/countries\/CHN\.geojson\.gz(?:$|\?)/.test(r.url));
  if (phase === 'optimized' && report.fullChinaRequests.length) failures.push({message: 'FULL_CHINA_DETAIL_REQUEST_FORBIDDEN', count: report.fullChinaRequests.length});
  if (consoleErrors.length || pageErrors.length) failures.push({message: 'BROWSER_ERRORS', consoleErrors: consoleErrors.length, pageErrors: pageErrors.length});
  const unexpected = failedRequests.filter(r => !r.ordinaryCancellation); if (unexpected.length) failures.push({message: 'UNEXPECTED_FAILED_REQUESTS', count: unexpected.length});
  for (const original of [pointerPin, ...codePins]) {const current = pin(original.path); if (current.sha256 !== original.sha256 || current.byteLength !== original.byteLength) failures.push({message: 'INPUT_CHANGED_DURING_MEASUREMENT', path: original.path});}
  if (context) await context.close().catch(error => failures.push({message: `CONTEXT_CLOSE:${String(error)}`}));
  if (browser) await browser.close().catch(error => failures.push({message: `BROWSER_CLOSE:${String(error)}`}));
  report.elapsedMs = nodePerformance.now() - started; report.pass = failures.length === 0;
  preserve(reportPath); fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({phase, pass: report.pass, report: pin(reportPath), mapReadyMs: report.mapReady?.wallMs,
    fullChinaRequests: report.fullChinaRequests.length, phases: phases.map(p => ({name: p.name, p95: p.frames.p95Ms, longTasksMs: p.longTasks.totalWithinPhaseMs})), failures: failures.map(f => f.message)}));
  if (!report.pass) process.exitCode = 1;
}
