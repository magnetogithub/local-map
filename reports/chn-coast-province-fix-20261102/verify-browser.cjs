const fs = require('node:fs');
const assert = require('node:assert/strict');
const {chromium} = require('playwright');
const dir = 'reports/chn-coast-province-fix-20261102';
const base = process.argv[2] || 'http://127.0.0.1:3192';
const repaired = [3549, 4050, 6750, 7473, 9565];
(async () => {
  const browser = await chromium.launch({headless: true, channel: 'msedge'});
  const page = await browser.newPage({viewport: {width: 1440, height: 900}});
  const sessions = new Set(), pending = [], errors = [], views = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('response', r => {
    if (r.url() === base + '/api/simulation/game' && r.ok() && r.request().method() === 'POST') {
      pending.push(r.json().then(body => {if (body.sessionId) sessions.add(body.sessionId);}));
    }
  });
  try {
    await page.goto(base + '/game#player=CHN');
    await page.waitForFunction(() => window.__PAX_OPERATIONAL_DEBUG__?.getState().baseStatus === 'ready', null, {timeout: 60000});
    await page.getByRole('button', {name: '설정', exact: true}).click();
    await page.locator('[data-setting-key="showCountryLabels"]').uncheck();
    await page.getByRole('button', {name: '설정', exact: true}).click();
    for (const [name, center, zoom] of [['bohai', [118.3, 39.1], 5.6], ['binhai', [117.7, 39.0], 7.2]]) {
      await page.evaluate(({center, zoom}) => {const d = window.__PAX_OPERATIONAL_DEBUG__; d.setDebugBoundaries(false); d.jumpTo(center, zoom);}, {center, zoom});
      await page.waitForFunction(() => window.__PAX_OPERATIONAL_DEBUG__.isRenderSettled(), null, {timeout: 60000});
      await page.waitForTimeout(600);
      const result = await page.evaluate(() => {
        const d = window.__PAX_OPERATIONAL_DEBUG__;
        return {state: d.getState(), stats: d.getUpdateStats(), renderedProvinceIds: [...new Set(d.queryRenderedFeatures({layers: ['operational-province-display-lod']}).map(f => Number(f.id)))]};
      });
      assert.equal(result.stats.provinceDisplayLodVertexCount, 6728);
      assert.equal(result.stats.microDisplayLodVertexCount, 55079);
      if (name === 'binhai') for (const id of repaired) assert.ok(result.renderedProvinceIds.includes(id), 'REPAIR_NOT_RENDERED:' + id);
      await page.screenshot({path: `${dir}/after-${name}.png`});
      views.push({name, center, zoom, ...result});
    }
    assert.deepEqual(errors, []);
    fs.writeFileSync(`${dir}/browser-verification.json`, JSON.stringify({pass: true, errors, views}, null, 2) + '\n');
    console.log(JSON.stringify({pass: true, views: views.map(v => ({name: v.name, renderedRepairs: repaired.filter(id => v.renderedProvinceIds.includes(id))}))}));
  } catch (error) {
    await page.screenshot({path: `${dir}/browser-error.png`});
    throw error;
  } finally {
    await Promise.all(pending);
    for (const sessionId of sessions) await page.request.delete(base + '/api/simulation/game', {headers: {'X-Pax-Game': sessionId}});
    await browser.close();
  }
})().catch(e => {console.error(e); process.exitCode = 1;});
