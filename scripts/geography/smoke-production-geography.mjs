import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {chromium} from '@playwright/test';

// A separate production process and browser context; no existing dev server or game is used.
const output = path.resolve(process.env.PAX_GEOGRAPHY_SMOKE_OUTPUT ?? '.tmp/prompt20-geography-smoke');
await fs.mkdir(output, {recursive: true});
const registry = JSON.parse(await fs.readFile('data/runtime/geography/current.json', 'utf8'));
// Expected inventory comes from the independently pinned operational descriptor, not geography metadata.
const pointer = JSON.parse(await fs.readFile('data/runtime/operational-catalog/current.json', 'utf8'));
const checkedJson = async (file, pin) => {
  const bytes = await fs.readFile(file);
  assert.equal(bytes.length, pin.byteLength); assert.equal(createHash('sha256').update(bytes).digest('hex'), pin.sha256);
  return JSON.parse(bytes.toString('utf8'));
};
const index = await checkedJson(`${pointer.root}/artifact-index.json`, pointer.index);
const descriptor = await checkedJson(`${pointer.root}/catalog.json`, index.artifacts.find(a => a.path === 'catalog.json'));
assert.deepEqual(registry.catalogRef, descriptor.catalogRef);
assert.equal(pointer.catalogVersion, descriptor.catalogRef.catalogVersion);
assert.equal(descriptor.countryOrder.length, descriptor.counts.countries);
assert.equal(new Set(descriptor.countryOrder).size, descriptor.counts.countries);
const expected = {cells: descriptor.counts.cells, countries: descriptor.countryOrder.length};
const listener = net.createServer();
await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
const port = listener.address().port;
await new Promise(resolve => listener.close(resolve));
const server = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'start', '--hostname', '127.0.0.1', '-p', String(port)],
  {windowsHide: true, env: process.env, stdio: ['ignore', 'pipe', 'pipe']});
let log = '', browser, sessionId;
server.stdout.on('data', data => {log += data;}); server.stderr.on('data', data => {log += data;});
const evidence = {task: 'geography-production-smoke', status: 'running', externalAICalls: 0, expected,
  catalogRef: descriptor.catalogRef, metadataRef: registry.metadataRef, phases: [], browserErrors: [], requestFailures: []};
const base = `http://127.0.0.1:${port}`;
const post = async (url, body) => {
  const response = await fetch(base + url, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)});
  return {status: response.status, body: await response.json()};
};
try {
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error(`Production readiness timeout: ${log}`)), 30_000);
    server.stdout.on('data', data => {if (String(data).includes('Ready')) {clearTimeout(timer); resolve();}});
    server.once('error', reject); server.once('exit', code => {clearTimeout(timer); reject(Error(`Production server exited ${code}`));});
  });
  const started = await post('/api/simulation/game', {operation: 'start'});
  assert.equal(started.status, 200, JSON.stringify(started.body)); sessionId = started.body.sessionId;
  const cells = started.body.runs.reduce((n, r) => n + r[0], 0);
  assert.equal(cells, expected.cells);
  assert.deepEqual([...started.body.snapshot.world.countryOrder].sort(), [...descriptor.countryOrder].sort());
  assert.deepEqual(started.body.snapshot.world.catalogRef, descriptor.catalogRef);
  const selected = await post('/api/simulation/game', {operation: 'select-player', sessionId, revisions: started.body.snapshot.revisions, countryId: 'KOR'});
  assert.equal(selected.status, 200);
  const prepared = await post('/api/simulation/game', {operation: 'prepare-turn', sessionId, revisions: selected.body.snapshot.revisions, targetDate: '2020-01-02'});
  assert.equal(prepared.status, 200, JSON.stringify(prepared.body));
  assert.deepEqual(prepared.body.context.geography, {catalogRef: registry.catalogRef, metadataRef: registry.metadataRef});
  const geo = async (query, sourceCountryId) => post('/api/world/regions', {mode: 'geography', catalogRef: registry.catalogRef, metadataRef: registry.metadataRef,
    request: {operation: 'search', sourceCountryId, kind: 'source-region', query, reference: null, page: {offset: 0, limit: 1}}});
  const city = await geo('청진', 'PRK'), duplicate = await geo('중구', 'KOR');
  assert.equal(city.status, 200); assert.equal(city.body.value.totalMatches, 1);
  assert.equal(city.body.value.items[0].coverage.status, 'partial');
  assert.ok(duplicate.body.value.totalMatches > 1); assert.equal(duplicate.body.value.ambiguous, true); assert.equal(duplicate.body.value.truncated, true);
  const legacy = await post('/api/world/regions', {catalogRef: registry.catalogRef, countryId: 'CHN', operation: 'occupy', query: '내몽골'});
  assert.equal(legacy.status, 200); assert.equal(legacy.body.region.materializable, false);
  assert.equal(legacy.body.region.geography.coverage.status, 'partial');
  const unchanged = await post('/api/simulation/game', {operation: 'read', sessionId, revisions: selected.body.snapshot.revisions});
  assert.deepEqual(unchanged.body.snapshot.revisions, selected.body.snapshot.revisions);
  assert.equal(unchanged.body.snapshot.canUndo, false); assert.equal(unchanged.body.snapshot.stateChange, null);
  evidence.phases.push({phase: 'production-api', cells, countries: started.body.snapshot.world.countryOrder.length, preparedGeography: prepared.body.context.geography,
    city: {totalMatches: city.body.value.totalMatches, coverage: city.body.value.items[0].coverage.status},
    duplicate: {totalMatches: duplicate.body.value.totalMatches, ambiguous: duplicate.body.value.ambiguous, truncated: duplicate.body.value.truncated},
    legacyCanonical: true, readOnlyRevisions: unchanged.body.snapshot.revisions});

  browser = await chromium.launch({channel: process.env.PLAYWRIGHT_CHROMIUM_CHANNEL, headless: true, args: ['--enable-unsafe-swiftshader']});
  const page = await browser.newPage({viewport: {width: 1440, height: 900}});
  page.on('pageerror', error => evidence.browserErrors.push(error.message));
  page.on('requestfailed', request => evidence.requestFailures.push({url: request.url(), error: request.failure()?.errorText}));
  await page.route('**/api/simulation/turn', () => {throw Error('External AI is forbidden in this smoke');});
  await page.goto(base, {waitUntil: 'domcontentloaded'});
  await page.waitForSelector('[data-testid="world-map"][data-map-status="ready"]', {timeout: 60_000});
  const uiCells = Number(await page.locator('.app-shell').getAttribute('data-world-territory-count'));
  const uiCountries = Number(await page.locator('.app-shell').getAttribute('data-world-country-count'));
  assert.equal(uiCells, expected.cells); assert.equal(uiCountries, expected.countries);
  const rendered = await page.locator('.maplibregl-canvas').isVisible(); assert.equal(rendered, true);
  await page.screenshot({path: path.join(output, 'setup.png')});
  await page.locator('#country-search').fill('KOR');
  await page.getByRole('option', {name: /KOR/}).click();
  await page.getByRole('button', {name: /플레이 국가로 선택/}).click();
  await page.waitForURL('**/game*', {timeout: 30_000});
  await page.waitForSelector('.app-shell[data-page-mode="game"] [data-testid="world-map"][data-map-status="ready"]', {timeout: 60_000});
  await page.getByTestId('game-screen').waitFor();
  await page.screenshot({path: path.join(output, 'game-kor.png')});
  assert.deepEqual(evidence.browserErrors, []);
  evidence.phases.push({phase: 'existing-ui-boot-country-selection-map', player: 'KOR', cells: uiCells, countries: uiCountries,
    mapStatus: 'ready', screenshots: ['setup.png', 'game-kor.png']});
  evidence.status = 'pass';
} catch (error) {evidence.status = 'fail'; evidence.error = String(error.stack ?? error); process.exitCode = 1;}
finally {
  if (browser) await browser.close();
  if (sessionId) await fetch(base + '/api/simulation/game', {method: 'DELETE', headers: {'X-Pax-Game': sessionId}}).catch(() => {});
  server.kill();
  await fs.writeFile(path.join(output, 'server.log'), log);
  await fs.writeFile(path.join(output, 'evidence.json'), JSON.stringify(evidence, null, 2) + '\n');
}
console.log(JSON.stringify(evidence, null, 2));
