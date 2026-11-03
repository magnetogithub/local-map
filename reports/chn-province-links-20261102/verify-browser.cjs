const fs = require('node:fs');
const assert = require('node:assert/strict');
const {chromium} = require('playwright');
const dir = 'reports/chn-province-links-20261102', base = process.argv[2] || 'http://127.0.0.1:3192';
const previous = JSON.parse(fs.readFileSync('data/derived/chn-2020/internal-line-delivery-8c66c8388b1ea04dc800/delivery.json'));
const previousProvince = JSON.parse(fs.readFileSync('data/derived/chn-2020/province-render-36da1312a1dd69777275/index.json'));
const current = JSON.parse(fs.readFileSync(JSON.parse(fs.readFileSync(dir + '/package.json')).artifact.path));
const cases = [['myanmar-side', [98.7, 28.0], 6.5, [3838, 7977]], ['south-of-wuhan', [113.0, 29.55], 7.1, [7152]]];
(async () => {
  const browser = await chromium.launch({headless: true, channel: 'msedge'});
  const views = [], errors = [];
  try {
    for (const phase of ['before', 'after']) {
      const context = await browser.newContext({viewport: {width: 1440, height: 900}});
      const sessions = new Set(), pending = [], delivery = phase === 'before' ? previous : current;
      const page = await context.newPage();
      page.on('pageerror', e => errors.push(e.message));
      page.on('response', r => {
        if (r.url() === base + '/api/simulation/game' && r.ok() && r.request().method() === 'POST') {
          pending.push(r.json().then(body => {if (body.sessionId) sessions.add(body.sessionId);}));
        }
      });
      if (phase === 'before') {
        // Controlled baseline: use the prior hash-pinned static display bundle
        // in the same renderer. No active server files or game state are changed.
        await context.route('**/api/world/catalog/operational/map', async route => {
          const response = await route.fetch(), value = await response.json();
          value.provincePresentationBoundaryOrdinals = previous.province.edgeOrdinals;
          value.provincePresentationRoot = '36da1312a1dd69777275944a9762de92ee8e79fd9322079bfe4f8ee559960a70';
          assert.deepEqual(value.provincePresentationBoundaryOrdinals, previousProvince.addedBoundaryOrdinals);
          for (const kind of ['province', 'micro']) {
            const entry = previous[kind];
            value[kind + 'BoundaryLod'] = {artifact: {...entry.artifact, path: `/data/territory-catalog/${previous.catalogRef.catalogVersion}/${entry.artifact.path}`},
              bounds: entry.bounds.map(Number), minZoom: entry.minZoom, maxZoom: entry.maxZoom, ...(kind === 'micro' ? {edgeOrdinals: entry.edgeOrdinals} : {})};
          }
          await route.fulfill({response, json: value});
        });
        for (const kind of ['province', 'micro']) {
          await context.route('**/' + previous[kind].artifact.path, route => route.fulfill({status: 200,
            contentType: 'application/gzip', body: Buffer.from(previous[kind].payloadBase64, 'base64')}));
        }
      }
      try {
        await page.goto(base + '/game#player=CHN');
        await page.waitForFunction(() => window.__PAX_OPERATIONAL_DEBUG__?.getState().baseStatus === 'ready', null, {timeout: 60000});
        await page.getByRole('button', {name: '설정', exact: true}).click();
        await page.locator('[data-setting-key="showCountryLabels"]').uncheck();
        await page.getByRole('button', {name: '설정', exact: true}).click();
        await page.mouse.move(1400, 400);
        for (const [name, center, zoom, repaired] of cases) {
          await page.evaluate(({center, zoom}) => {const d = window.__PAX_OPERATIONAL_DEBUG__; d.setDebugBoundaries(false); d.jumpTo(center, zoom);}, {center, zoom});
          await page.waitForFunction(() => window.__PAX_OPERATIONAL_DEBUG__.isRenderSettled(), null, {timeout: 60000});
          await page.waitForTimeout(500);
          const data = await page.evaluate(() => {
            const d = window.__PAX_OPERATIONAL_DEBUG__;
            return {state: d.getState(), stats: d.getUpdateStats(), provinceIds: [...new Set(d.queryRenderedFeatures({layers: ['operational-province-display-lod']}).map(f => Number(f.id)))]};
          });
          assert.equal(data.stats.provinceDisplayLodVertexCount, phase === 'before' ? 6728 : 6753);
          assert.equal(data.stats.microDisplayLodVertexCount, phase === 'before' ? 55079 : 55054);
          for (const id of repaired) assert.equal(data.provinceIds.includes(id), phase === 'after', `REPAIR_VISIBILITY:${phase}:${id}`);
          await page.screenshot({path: `${dir}/${phase}-${name}.png`});
          views.push({phase, name, center, zoom, repaired, ...data});
        }
      } finally {
        await Promise.all(pending);
        for (const sessionId of sessions) await context.request.delete(base + '/api/simulation/game', {headers: {'X-Pax-Game': sessionId}});
        await context.close();
      }
    }
    assert.deepEqual(errors, []);
    fs.writeFileSync(dir + '/browser-verification.json', JSON.stringify({pass: true, baselineMethod: 'Prior hashed static display delivery in the current renderer; current geometry and game catalog retained.', errors, views}, null, 2) + '\n');
    console.log(JSON.stringify({pass: true, views: views.map(v => ({phase: v.phase, name: v.name, renderedRepairs: v.repaired.filter(id => v.provinceIds.includes(id))}))}));
  } finally {await browser.close();}
})().catch(e => {console.error(e); process.exitCode = 1;});
