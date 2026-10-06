import {expect,test} from './catalog-fixture';
for(const length of [120,121,160,161])test(`V3 ${length}-character rename, real labels, atomic history and readable fallback`,async({page})=>{
 test.setTimeout(180000);await page.setViewportSize({width:1440,height:900});
 const text='프랑스민주연방공화국'.repeat(20).slice(0,length),posts:{status:number;request:Record<string,unknown>;body:unknown}[]=[];
 page.on('response',async response=>{if(response.url().endsWith('/api/world/labels')&&response.request().method()==='POST')posts.push({status:response.status(),request:response.request().postDataJSON(),body:await response.json()});});
 await page.route('**/api/simulation/turn',async route=>{
  const {turnId,context:c}=route.request().postDataJSON(),eventId='event.long-name',action=c.queuedActions[0];
  const resolution={contractVersion:'turn-resolution.v1',baseSimulationRevision:c.revisions.simulation,baseWorldRevision:c.revisions.world,period:c.period,
   playerActionOutcomes:[{outcomeId:'outcome.long-name',actionId:action.actionId,status:'succeeded',evidenceEventId:eventId,summary:'Name adopted',remainingConditions:[]}],
   events:[{eventId,date:c.period.endDate,title:'Name adopted',publicNarrative:'The constitutional name is adopted.',actorCountryIds:['FRA'],relatedFactIds:[],relatedSituationIds:[],causes:[{kind:'queued-action',id:action.actionId}],outcomeCategory:'domestic',significance:'minor'}],factMutations:[],situationMutations:[],scheduledConsequences:[],worldEffects:[{effectId:'effect.long-name',causedByEventId:eventId,type:'country.renamed',countryId:'FRA',displayName:text}],advisorSummary:'Name adopted',unresolvedQuestions:[]};
  await route.fulfill({status:200,contentType:'application/x-ndjson',body:[{version:1,turnId,sequence:0,type:'turn.started'},{version:1,turnId,sequence:1,type:'resolution.ready',resolution}].map(v=>JSON.stringify(v)).join('\n')+'\n'});
 });
 await page.goto('/game#player=FRA');const ready=()=>expect.poll(()=>page.evaluate(()=>window.__PAX_CATALOG_DEBUG__?.ready()),{timeout:90000}).toBe(true);await ready();
 await page.evaluate(()=>window.__PAX_CATALOG_DEBUG__!.jumpTo([2,46],4));await ready();
 const labels=()=>page.evaluate(()=>Object.fromEntries(Object.entries(window.__PAX_CATALOG_DEBUG__!.labelFeatures()).map(([source,features])=>[source,[...features].sort((a,b)=>String(a.id).localeCompare(String(b.id)))])));const initial=await labels();
 const before=await page.evaluate(()=>window.__PAX_CATALOG_DEBUG__!.getSnapshot());
 await page.locator('[data-menu-kind="action"]').click();await page.locator('#game-player-action').fill('Adopt constitutional name');await page.locator('#game-player-action').press('Enter');await page.locator('.game-advance-submit').click();
 await expect(page.locator('.turn-status')).toHaveAttribute('data-phase',length<=160?'committed':'failed',{timeout:30000});await ready();
 if(length===161){expect(await labels()).toEqual(initial);const after=await page.evaluate(()=>window.__PAX_CATALOG_DEBUG__!.getSnapshot());expect(after.worldRevision).toBe(before.worldRevision);expect(posts).toHaveLength(0);return;}
 await expect.poll(()=>posts.length).toBe(1);expect(posts[0].status).toBe(200);expect(posts[0].request.text).toBe(text);
 const committed=await labels();for(const [source,features]of Object.entries(initial))expect(committed[source].filter(f=>f.countryId!=='FRA')).toEqual(features.filter(f=>f.countryId!=='FRA'));
 expect(committed['catalog-country-glyph-fills'].filter(f=>f.countryId==='FRA')).toHaveLength(length);expect(committed['catalog-country-glyph-outlines'].filter(f=>f.countryId==='FRA')).toHaveLength(length);
 const rendered=await page.evaluate(()=>{const map=window.__PAX_CATALOG_DEBUG__!.inspectMap();return map.queryRenderedFeatures(undefined,{layers:['catalog-point-country-labels']}).filter(f=>f.properties.countryId==='FRA').map(f=>({text:f.properties.mapLabelKo,fallback:f.properties.fallbackText,readable:f.properties.readableFallback,state:f.state}));});
 expect(rendered.length).toBeGreaterThan(0);for(const f of rendered){expect(f.text).toBe(text);expect(f.fallback.replaceAll('\n','')).toBe(text);expect(f.fallback.split('\n').every((line:string)=>line.length<=18)).toBe(true);expect(f.readable).toBe(true);expect(f.state.labelColor).not.toBe(f.state.labelHaloColor);}
 await page.locator('[data-menu-kind="action"]').click();await page.screenshot({path:`long-name-${length}.png`});await page.locator('[data-menu-kind="action"]').click();
 await page.locator('.turn-undo').click();await ready();expect(await labels()).toEqual(initial);
 await page.locator('.turn-redo').click();await ready();expect(await labels()).toEqual(committed);
 const rejected=await page.request.post('/api/world/labels',{data:{...posts[0].request,text:'가'.repeat(161)}});expect(rejected.status()).toBe(400);
 expect(await page.evaluate(()=>window.__PAX_CATALOG_DEBUG__!.getSnapshot().labelFailures)).toEqual([]);
});
