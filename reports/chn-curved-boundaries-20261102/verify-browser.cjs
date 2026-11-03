const fs = require('node:fs'), zlib = require('node:zlib');
const assert = require('node:assert/strict');
const {chromium} = require('playwright');
const dir = 'reports/chn-curved-boundaries-20261102', base = process.argv[2] || 'http://127.0.0.1:3192';
const previous = JSON.parse(fs.readFileSync('data/derived/chn-2020/internal-line-delivery-27d1f5131d82e9dd4b66/delivery.json'));
const current = JSON.parse(fs.readFileSync(JSON.parse(fs.readFileSync(dir + '/package.json')).artifact.path));
const vertices = (delivery, kind) => JSON.parse(zlib.gunzipSync(Buffer.from(delivery[kind].payloadBase64, 'base64'))).features.reduce((n, f) => n + f.geometry.coordinates.length, 0);
const onlyCase = process.argv.includes('--case') ? process.argv[process.argv.indexOf('--case') + 1] : null;
const cases = [
  ['china', [105, 35], 3.5, false],
  ['northeast', [124.2, 49.6], 6.0, false],
  ['northeast-close', [125.0, 49.0], 7.2, false],
  ['central', [112, 30.5], 5.6, false],
  ['southwest', [101.3, 28], 5.2, false],
  ['coast', [119.8, 34.5], 4.7, false],
  ['micro', [111.5, 31.5], 5.6, true],
  ['micro-wuhan', [114.3696, 30.6090], 7.2, true],
  ['korea-comparison', [127.3, 36.4], 6.0, false],
  ['korea-close', [127.3, 36.4], 7.2, false],
  ['dprk-comparison', [126.7, 40.0], 7.2, false],
  ['dprk-close', [127.5, 39.6], 8.2, false],
].filter(([name]) => !onlyCase || name === onlyCase);
assert.ok(cases.length);
(async () => {
  const browser = await chromium.launch({headless: true, channel: 'msedge'});
  const views = [], errors = [];
  try {
    for (const phase of ['before', 'after']) {
      const context = await browser.newContext({viewport: {width: 1440, height: 900}});
      const page = await context.newPage(), sessions = new Set(), pending = [];
      const delivery = phase === 'before' ? previous : current;
      page.on('pageerror', e => errors.push(e.message));
      page.on('response', r => {
        if (r.url() === base + '/api/simulation/game' && r.ok() && r.request().method() === 'POST') {
          pending.push(r.json().then(body => {if (body.sessionId) sessions.add(body.sessionId);}));
        }
      });
      if (phase === 'before') {
        // Serve the exact previous hashed display bundle in the same renderer.
        // This changes only the isolated QA context's responses.
        await context.route('**/api/world/catalog/operational/map', async route => {
          const response = await route.fetch(), value = await response.json();
          assert.deepEqual(value.provincePresentationBoundaryOrdinals, previous.province.edgeOrdinals);
          for (const kind of ['province', 'micro']) {
            const entry = previous[kind];
            value[kind + 'BoundaryLod'] = {artifact: {...entry.artifact, path: `/data/territory-catalog/${previous.catalogRef.catalogVersion}/${entry.artifact.path}`},
              bounds: entry.bounds.map(Number), minZoom: entry.minZoom, maxZoom: entry.maxZoom,
              ...(kind === 'micro' ? {edgeOrdinals: entry.edgeOrdinals} : {})};
          }
          await route.fulfill({response, json: value});
        });
        for (const kind of ['province', 'micro']) await context.route('**/' + previous[kind].artifact.path,
          route => route.fulfill({status: 200, contentType: 'application/gzip', body: Buffer.from(previous[kind].payloadBase64, 'base64')}));
      }
      try {
        const started = Date.now();
        await page.goto(base + '/game#player=CHN');
        await page.waitForFunction(() => window.__PAX_OPERATIONAL_DEBUG__?.getState().baseStatus === 'ready', null, {timeout: 60000});
        const initializationMilliseconds = Date.now() - started;
        await page.getByRole('button', {name: '설정', exact: true}).click();
        await page.locator('[data-setting-key="showCountryLabels"]').uncheck();
        await page.getByRole('button', {name: '설정', exact: true}).click();
        let activeDebug = false;
        for (const [name, center, zoom, debug] of cases) {
          if (debug !== activeDebug) {
            await page.getByRole('button', {name: '설정', exact: true}).click();
            await page.locator('[data-setting-key="debugMapBoundaries"]').setChecked(debug);
            await page.getByRole('button', {name: '설정', exact: true}).click();
            activeDebug = debug;
          }
          await page.evaluate(({center, zoom}) => window.__PAX_OPERATIONAL_DEBUG__.jumpTo(center, zoom), {center, zoom});
          await page.mouse.move(1390, 40);
          if (debug) {
            await page.waitForTimeout(300);
            const point = await page.evaluate(center => window.__PAX_OPERATIONAL_DEBUG__.project(center), center);
            await page.mouse.move(...point);
          }
          await page.waitForFunction(() => window.__PAX_OPERATIONAL_DEBUG__.isRenderSettled(), null, {timeout: 60000});
          await page.waitForTimeout(500);
          const data = await page.evaluate(() => {
            const d = window.__PAX_OPERATIONAL_DEBUG__, state = d.getState(), s = d.getUpdateStats();
            return {catalogVersion: state.catalogRef.catalogVersion, worldRevision: state.revision, simulationRevision: state.simulationRevision,
              hoveredCountryId: state.hoveredCountryId, provinceVertices: s.provinceDisplayLodVertexCount,
              microVertices: s.microDisplayLodVertexCount, writes: [s.provinceDisplayLodSourceWrites, s.microDisplayLodSourceWrites],
              microActive: s.microDisplayLodActive, microRenderedFeatures: d.queryRenderedFeatures({layers: ['operational-micro-display-lod']}).length,
              provinceIds: [...new Set(d.queryRenderedFeatures({layers: ['operational-province-display-lod']}).map(f => Number(f.id)))]};
          });
          assert.equal(data.provinceVertices, vertices(delivery, 'province'));
          assert.equal(data.microVertices, vertices(delivery, 'micro'));
          assert.deepEqual(data.writes, [1, 1]);
          if (debug) {assert.equal(data.microActive, true); assert.ok(data.microRenderedFeatures > 0);}
          else assert.equal(data.microRenderedFeatures, 0);
          await page.screenshot({path: `${dir}/${phase}-${name}.png`});
          views.push({phase, name, center, zoom, debug, initializationMilliseconds, ...data});
        }
      } finally {
        await Promise.all(pending);
        for (const sessionId of sessions) await context.request.delete(base + '/api/simulation/game', {headers: {'X-Pax-Game': sessionId}});
        await context.close();
      }
    }
    assert.deepEqual(errors, []);
    const reportPath = dir + '/browser-verification.json';
    const priorViews = onlyCase && fs.existsSync(reportPath) ? JSON.parse(fs.readFileSync(reportPath)).views.filter(v => !cases.some(([name]) => name === v.name)) : [];
    fs.writeFileSync(reportPath, JSON.stringify({pass: true, baselineMethod: 'Previous hashed static display delivery in the same renderer and unchanged game catalog.', errors, views: [...priorViews, ...views]}, null, 2) + '\n');
    console.log(JSON.stringify({pass: true, views: views.length, beforeVertices: vertices(previous, 'province') + vertices(previous, 'micro'), afterVertices: vertices(current, 'province') + vertices(current, 'micro')}));
  } finally {await browser.close();}
})().catch(e => {console.error(e); process.exitCode = 1;});
