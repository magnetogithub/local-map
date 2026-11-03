const fs = require('fs');
const assert = require('node:assert/strict');
const {chromium} = require('playwright');
(async () => {
  const dir = 'reports/chn-simplification-20261102';
  const phase = process.argv[2] || 'after';
  const base = process.argv[3] || 'http://localhost:3000';
  fs.mkdirSync(dir, {recursive: true});
  const browser = await chromium.launch({headless: true, channel: 'msedge'});
  try {
    const page = await browser.newPage({viewport: {width: 1280, height: 900}});
    const errors = [];
    const sessions = new Set();
    const sessionReads = [];
    page.on('pageerror', e => errors.push(e.message));
    page.on('response', response => {
      if (response.url() === base + '/api/simulation/game' && response.ok() && response.request().method() === 'POST') {
        sessionReads.push(response.json().then(body => {if (body.sessionId) sessions.add(body.sessionId);}));
      }
    });
    await page.goto(base);
    await page.waitForFunction(() => window.__PAX_OPERATIONAL_DEBUG__?.getState().baseStatus === 'ready', null, {timeout: 60000});
    const snapshots = [];
    for (const [label, zoom, debug] of [['province', 4.8, false], ['micro', 5.7, true], ['high-zoom', 7.2, true]]) {
      await page.evaluate(({zoom, debug, label}) => {
        const d = window.__PAX_OPERATIONAL_DEBUG__;
        d.setDebugBoundaries(debug);
        d.jumpTo(label === 'high-zoom' ? [117.5, 36] : [120, 37], zoom);
      }, {zoom, debug, label});
      await page.waitForTimeout(1000);
      const point = await page.evaluate(() => window.__PAX_OPERATIONAL_DEBUG__.project([117.5, 36]));
      await page.mouse.move(...point);
      await page.waitForTimeout(2000);
      const result = await page.evaluate(() => {
        const d = window.__PAX_OPERATIONAL_DEBUG__, s = d.getUpdateStats();
        return {zoom: d.getZoom(), state: d.getState(), provinceVertices: s.provinceDisplayLodVertexCount,
          microVertices: s.microDisplayLodVertexCount, writes: [s.provinceDisplayLodSourceWrites, s.microDisplayLodSourceWrites],
          microActive: s.microDisplayLodActive, edgeCount: s.debugBoundaryEdgeCount};
      });
      assert.equal(result.provinceVertices, 6703);
      assert.equal(result.microVertices, 55104);
      assert.deepEqual(result.writes, [1, 1]);
      if (debug) assert.equal(result.microActive, true);
      await page.screenshot({path: `${dir}/${phase}-${label}.png`});
      snapshots.push({label, ...result});
    }
    assert.deepEqual(errors, []);
    fs.writeFileSync(`${dir}/${phase}.json`, JSON.stringify({errors, snapshots}, null, 2) + '\n');
    console.log(JSON.stringify({errors, snapshots: snapshots.map(({state, ...snapshot}) => snapshot)}));
    await Promise.all(sessionReads);
    for (const sessionId of sessions) await page.request.delete(base + '/api/simulation/game', {headers: {'X-Pax-Game': sessionId}});
  } finally { await browser.close(); }
})().catch(e => {console.error(e); process.exitCode = 1;});
