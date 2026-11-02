import {test,expect,type Page} from './catalog-fixture';
const ready=async(page:Page)=>expect.poll(()=>page.evaluate(()=>window.__PAX_CATALOG_DEBUG__?.ready()),{timeout:90000}).toBe(true);
test('V3 named region lookup, provider tools, server validation, planner and atomic partial occupation',async({page})=>{
 test.setTimeout(300000);await page.goto('/game#player=KOR');await ready(page);
 const responses:{url:string;body:unknown}[]=[];page.on('response',async r=>{if(r.url().includes('/api/world/regions'))responses.push({url:r.url(),body:await r.json()});});
 await page.locator('[data-menu-kind="action"]').click();
 for(const text of ['E2E REGION TREATY','E2E REGION OCCUPY Guangdong']){
   await page.locator('#game-player-action').fill(text);await page.locator('#game-player-action').press('Enter');await page.locator('.game-advance-submit').click();
   await expect.poll(()=>page.evaluate(()=>window.__PAX_CATALOG_DEBUG__?.getSnapshot().simulationRevision),{timeout:30000}).toBe(text.includes('TREATY')?1:2);
 }
 await ready(page);const state=await page.evaluate(()=>{const d=window.__PAX_CATALOG_DEBUG__!;return {snapshot:d.getSnapshot(),occupied:d.territoryFeatures().filter(f=>f.ownerCountryId==='CHN'&&(d.territoryState(f.id) as {controllerCountryId:string}).controllerCountryId==='KOR')};});
 expect(state.occupied.length).toBeGreaterThan(0);expect(state.occupied.length).toBeLessThan(100);expect(state.snapshot).toMatchObject({worldRevision:1,fullProjectionBuilds:1,labelLayoutRequests:0,labelFailures:[]});
 const receipt=responses.find(r=>(r.body as {region?:{nameEn:string;territoryIds:string[]}}).region?.nameEn==='Guangdong')?.body as {region:{territoryIds:string[]}};
 expect(receipt.region.territoryIds).toEqual(state.occupied.map(f=>f.id).sort());
 await page.locator('.turn-undo').click();expect(await page.evaluate(()=>window.__PAX_CATALOG_DEBUG__?.getSnapshot().simulationRevision)).toBe(3);
 await page.locator('.turn-redo').click();expect(await page.evaluate(()=>window.__PAX_CATALOG_DEBUG__?.getSnapshot().simulationRevision)).toBe(4);
 await page.locator('#game-player-action').fill('E2E REGION COLOR white');await page.locator('#game-player-action').press('Enter');await page.locator('.game-advance-submit').click();
 await expect.poll(()=>page.evaluate(()=>window.__PAX_CATALOG_DEBUG__?.getSnapshot().simulationRevision),{timeout:30000}).toBe(5);await ready(page);
 expect(await page.evaluate(()=>window.__PAX_CATALOG_DEBUG__?.getSnapshot())).toMatchObject({labelLayoutRequests:0,labelFailures:[]});
 const colors=await page.evaluate(()=>{const d=window.__PAX_CATALOG_DEBUG__!,map=d.inspectMap();return d.labelFeatures()['catalog-country-glyph-fills'].filter(f=>f.countryId==='KOR').map(f=>map.getFeatureState({source:'catalog-country-glyph-fills',id:String(f.id)}));});
 expect(colors.length).toBeGreaterThan(0);expect(colors.every(c=>c.labelColor&&c.labelHaloColor&&c.labelColor!==c.labelHaloColor)).toBe(true);
 await page.evaluate(()=>window.__PAX_CATALOG_DEBUG__!.jumpTo([127,36],5));await ready(page);
 const rendered=await page.evaluate(()=>window.__PAX_CATALOG_DEBUG__!.inspectMap().queryRenderedFeatures(undefined,{layers:['catalog-country-glyph-fills']}).filter(f=>f.properties.countryId==='KOR').map(f=>({id:f.id,promoted:f.properties.labelFeatureId,state:f.state})));
 expect(rendered.length).toBeGreaterThan(0);for(const f of rendered){expect(f.id).toBe(f.promoted);expect(f.state).toMatchObject({labelColor:'#172E35',labelHaloColor:'#FFFFFF'});}
});
test('V3 glyph fill and outline, shape size at zooms, world wrap and small-country fallback',async({page})=>{
 test.setTimeout(300000);await page.setViewportSize({width:1440,height:900});await page.goto('/');await ready(page);
 for(const [id,center]of [['AUS',[134,-25]],['RUS',[90,60]],['USA',[-105,40]],['CHN',[104,35]]] as const){
   const sizes:number[]=[];
   for(const zoom of [1.8,2.8]){await page.evaluate(({center,zoom})=>window.__PAX_CATALOG_DEBUG__!.jumpTo([...center],zoom),{center,zoom});await ready(page);
     const result=await page.evaluate(id=>{const map=window.__PAX_CATALOG_DEBUG__!.inspectMap();const fills=map.queryRenderedFeatures(undefined,{layers:['catalog-country-glyph-fills']}).filter(f=>f.properties.countryId===id),outlines=map.queryRenderedFeatures(undefined,{layers:['catalog-country-glyph-outlines']}).filter(f=>f.properties.countryId===id);
       const points=fills.flatMap(f=>f.geometry.type==='Polygon'?f.geometry.coordinates.flat():f.geometry.type==='MultiPolygon'?f.geometry.coordinates.flat(2):[]).map(p=>map.project([p[0],p[1]]));
       return {fills:fills.length,outlines:outlines.length,width:Math.max(...points.map(p=>p.x))-Math.min(...points.map(p=>p.x))};},id);
     expect(result.fills).toBeGreaterThan(0);expect(result.outlines).toBeGreaterThan(0);expect(result.width).toBeGreaterThan(0);sizes.push(result.width);
     await page.screenshot({path:`review-g-${id}-z${zoom}.png`});
   }expect(sizes[1]).toBeGreaterThan(sizes[0]*1.5);
 }
 await page.evaluate(()=>window.__PAX_CATALOG_DEBUG__!.jumpTo([540,20],1.25));await ready(page);expect(await page.evaluate(()=>window.__PAX_CATALOG_DEBUG__!.renderedLabelIds())).toContain('USA');
 await page.evaluate(()=>window.__PAX_CATALOG_DEBUG__!.jumpTo([12.453,41.903],5.2));await ready(page);expect(await page.evaluate(()=>window.__PAX_CATALOG_DEBUG__!.renderedLabelIds())).not.toContain('VAT');
 await page.evaluate(()=>window.__PAX_CATALOG_DEBUG__!.jumpTo([12.453,41.903],7));await ready(page);await expect.poll(()=>page.evaluate(()=>window.__PAX_CATALOG_DEBUG__!.renderedLabelIds())).toContain('VAT');
 expect(await page.evaluate(()=>window.__PAX_CATALOG_DEBUG__!.getSnapshot())).toMatchObject({labelLayoutRequests:0,fullProjectionBuilds:1,labelFailures:[]});
});
