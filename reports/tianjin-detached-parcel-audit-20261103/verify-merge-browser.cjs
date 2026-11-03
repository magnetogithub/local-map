const fs = require('node:fs'), zlib = require('node:zlib'), assert = require('node:assert/strict');
const {chromium} = require('playwright');
const folder = 'reports/tianjin-detached-parcel-audit-20261103';
const base = process.argv[2] || 'http://127.0.0.1:3193';
const pointer = JSON.parse(fs.readFileSync('data/runtime/operational-catalog/current.json'));
const proof = JSON.parse(fs.readFileSync(folder + '/merge-verification.json'));
const input = JSON.parse(fs.readFileSync(proof.after.path));
const merge = input.report.manualCellMerge.operations[0];
const meta = JSON.parse(zlib.gunzipSync(fs.readFileSync(pointer.root + '/metadata/countries/CHN.json.gz')));
const mergedOrdinal = meta.rows.find(row => row[1] === merge.mergedCellId)[0];
(async () => {
  const browser = await chromium.launch({headless: true, channel: 'msedge'});
  const context = await browser.newContext({viewport: {width: 1440, height: 900}});
  const page = await context.newPage(), errors = [], sessions = new Set(), pending = [];
  await context.route('**/api/simulation/turn*', route => route.abort());
  page.on('pageerror', e => errors.push(e.message));
  page.on('response', response => {
    if (response.url() === base + '/api/simulation/game' && response.ok() && response.request().method() === 'POST') {
      pending.push(response.json().then(value => {if (value.sessionId) sessions.add(value.sessionId);}));
    }
  });
  const views = [];
  try {
    await page.goto(base + '/game#player=CHN');
    await page.waitForFunction(() => window.__PAX_OPERATIONAL_DEBUG__?.getState().baseStatus === 'ready', null, {timeout: 120000});
    await page.getByRole('button', {name: '설정', exact: true}).click();
    await page.locator('[data-setting-key="showCountryLabels"]').uncheck();
    await page.getByRole('button', {name: '설정', exact: true}).click();
    for (const debug of [false, true]) for (const zoom of [6.0, 7.2, 8.3]) {
      await page.evaluate(({debug, zoom}) => {const d = window.__PAX_OPERATIONAL_DEBUG__; d.setDebugBoundaries(debug); d.jumpTo([117.375, 38.497], zoom);}, {debug, zoom});
      await page.waitForTimeout(250);
      await page.mouse.move(720, 450);
      await page.waitForFunction(() => window.__PAX_OPERATIONAL_DEBUG__.isRenderSettled(), null, {timeout: 60000});
      await page.waitForTimeout(400);
      const result = await page.evaluate(() => {
        const d = window.__PAX_OPERATIONAL_DEBUG__, point = d.project([117.375, 38.497]);
        return {state: d.getState(), stats: d.getUpdateStats(),
          fills: d.queryRenderedFeatures({point, layers: ['operational-fill', 'operational-detail-fill', 'operational-changed-fill']}),
          linesAtPoint: d.queryRenderedFeatures({point, layers: ['operational-administrative-border', 'operational-cell-grid', 'operational-detail-administrative-border', 'operational-detail-cell-grid', 'operational-province-display-lod', 'operational-micro-display-lod']})};
      });
      assert.equal(result.state.catalogRef.catalogVersion, pointer.catalogVersion);
      assert.equal(result.state.counts.cells, 8004);
      assert.equal(result.state.counts.edges, 26272);
      assert.ok(result.fills.length > 0);
      assert.ok(result.fills.every(f => Number(f.id) === mergedOrdinal), JSON.stringify(result.fills));
      assert.equal(result.linesAtPoint.length, 0, 'REMOVED_RING_STILL_RENDERED');
      const screenshot = `${folder}/merged-${debug ? 'debug' : 'normal'}-z${zoom}.png`;
      await page.screenshot({path: screenshot});
      views.push({zoom, debug, screenshot, ...result});
    }
    await page.evaluate(() => window.__PAX_OPERATIONAL_DEBUG__.selectCountryDetail('CHN'));
    await page.waitForFunction(() => window.__PAX_OPERATIONAL_DEBUG__.getState().detailStatus === 'ready', null, {timeout: 60000});
    const selected = await page.evaluate(() => {const d = window.__PAX_OPERATIONAL_DEBUG__; return d.queryRenderedFeatures({point: d.project([117.375, 38.497]), layers: ['operational-fill', 'operational-detail-fill']});});
    assert.ok(selected.some(f => Number(f.id) === mergedOrdinal));
    assert.ok(selected.every(f => Number(f.id) === mergedOrdinal));
    assert.deepEqual(errors, []);
    fs.writeFileSync(folder + '/merge-browser-verification.json', JSON.stringify({pass: true, catalogVersion: pointer.catalogVersion, mergedOrdinal, mergedId: merge.mergedCellId, errors, views, selectedCountryFillAtTarget: selected}, null, 2) + '\n');
    console.log(JSON.stringify({pass: true, views: views.length, mergedOrdinal, selectedCountryFillAtTarget: selected}));
  } finally {
    await Promise.all(pending);
    for (const sessionId of sessions) await context.request.delete(base + '/api/simulation/game', {headers: {'X-Pax-Game': sessionId}});
    await browser.close();
  }
})().catch(error => {console.error(error); process.exitCode = 1;});
