import {test,expect,type Page} from './catalog-fixture';

const ready=async(page:Page)=>{await page.waitForFunction(()=>window.__PAX_CATALOG_DEBUG__?.ready(),null,{timeout:90000});};
const snapshot=(page:Page)=>page.evaluate(()=>window.__PAX_CATALOG_DEBUG__!.getSnapshot());
async function enter(page:Page){
  await page.goto('/');await ready(page);
  await expect(page.locator('.app-shell')).toHaveAttribute('data-world-schema-version','3');
  await page.locator('#country-search').fill('FRA');await page.getByRole('option',{name:/FRA/}).click();
  await page.getByRole('button',{name:/플레이 국가로 선택/}).click();await page.waitForURL(/\/game/);await ready(page);
}
test('catalog production selection, map interaction, turn/news/major event, history and fresh reload',async({page})=>{
  const errors:string[]=[],requests:string[]=[];page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>requests.push(new URL(r.url()).pathname));
  await enter(page);const initial=await snapshot(page);expect(initial).toMatchObject({worldSchema:3,simulationSchema:2,date:'2020-01-01',playerCountryId:'FRA'});
  await page.evaluate(()=>window.__PAX_CATALOG_DEBUG__!.focusCountry('FRA'));await ready(page);
  await page.getByTestId('map-country-picker').selectOption('DEU');await expect(page.getByTestId('country-overlay')).toBeVisible();
  await page.locator('[data-menu-kind="action"]').click();
  await page.route('**/api/simulation/turn',async route=>{
    const {turnId,context:c}=route.request().postDataJSON(),action=c.queuedActions[0];
    const r={contractVersion:'turn-resolution.v1',baseSimulationRevision:c.revisions.simulation,baseWorldRevision:c.revisions.world,period:c.period,
      playerActionOutcomes:[{outcomeId:'outcome.catalog',actionId:action.actionId,status:'succeeded',evidenceEventId:'event.catalog',summary:'Adopted',remainingConditions:[]}],
      events:[{eventId:'event.catalog',date:c.period.endDate,title:'Catalog Charter',publicNarrative:'A constitutional charter has been adopted.',actorCountryIds:['FRA'],relatedFactIds:[],relatedSituationIds:[],causes:[{kind:'queued-action',id:action.actionId}],outcomeCategory:'domestic',significance:'major'}],
      factMutations:[],situationMutations:[],scheduledConsequences:[],worldEffects:[{effectId:'effect.catalog',causedByEventId:'event.catalog',type:'country.renamed',countryId:'FRA',displayName:'Catalog Republic'}],advisorSummary:'Charter enacted',unresolvedQuestions:[]};
    await route.fulfill({status:200,contentType:'application/x-ndjson',body:[{version:1,turnId,sequence:0,type:'turn.started'},{version:1,turnId,sequence:1,type:'resolution.ready',resolution:r}].map(e=>JSON.stringify(e)).join('\n')+'\n'});
  });
  await page.locator('#game-player-action').fill('Adopt a constitutional charter');await page.locator('#game-player-action').press('Enter');
  await page.locator('.game-custom-date input').fill('2020-01-10');await page.locator('.game-advance-submit').click();
  const dialog=page.getByRole('dialog');await expect(dialog).toContainText('Catalog Charter',{timeout:30000});await dialog.getByRole('button',{name:'확인'}).click();
  await expect(page.getByTestId('news-overlay')).toBeVisible();await expect(page.locator('.game-news__list')).toContainText('Catalog Charter');
  await expect(page.getByTestId('map-country-picker').locator('option[value="FRA"]')).toContainText('Catalog Republic');
  await page.locator('[data-menu-kind="action"]').click();await page.locator('.turn-undo').click();expect((await snapshot(page)).date).toBe('2020-01-01');
  await page.locator('.turn-redo').click();expect((await snapshot(page)).date).toBe('2020-01-10');
  await page.reload();await ready(page);expect((await snapshot(page)).date).toBe('2020-01-01');
  expect(await page.evaluate(()=>({local:Object.keys(localStorage),session:Object.keys(sessionStorage)}))).toEqual({local:[],session:[]});
  expect(requests.filter(p=>/canonical-territories|geometry-catalog|shared-game.*geojson/.test(p))).toEqual([]);expect(errors).toEqual([]);
});
test('catalog rejects GPT coordinates/polygons and production debug without atomic publication',async({page})=>{
  await enter(page);let mode='coordinates';
  await page.route('**/api/simulation/turn',async route=>{
    const {turnId,context:c}=route.request().postDataJSON(),action=c.queuedActions[0];
    const event={eventId:'event.invalid',date:c.period.endDate,title:'Invalid attempt',publicNarrative:'An attempted change.',actorCountryIds:['FRA'],relatedFactIds:[],relatedSituationIds:[],causes:[{kind:'queued-action',id:action.actionId}],outcomeCategory:'domestic',significance:'notable'};
    const effect=mode==='coordinates'
      ?{effectId:'effect.invalid',causedByEventId:event.eventId,type:'country.renamed',countryId:'FRA',displayName:'Forbidden Polygon',coordinates:[[1,2]],polygon:{type:'Polygon',coordinates:[]}}
      :{effectId:'effect.invalid',causedByEventId:event.eventId,type:'country.changeMapColor',countryId:'FRA',actorCountryId:'FRA',authorityId:'cpa:missing',mapColor:'#FFFFFF'};
    const r={contractVersion:'turn-resolution.v1',baseSimulationRevision:c.revisions.simulation,baseWorldRevision:c.revisions.world,period:c.period,
      playerActionOutcomes:[{outcomeId:'outcome.invalid',actionId:action.actionId,status:'succeeded',evidenceEventId:event.eventId,summary:'Attempt',remainingConditions:[]}],events:[event],factMutations:[],situationMutations:[],scheduledConsequences:[],worldEffects:[effect],advisorSummary:'Attempt',unresolvedQuestions:[]};
    await route.fulfill({status:200,contentType:'application/x-ndjson',body:[{version:1,turnId,sequence:0,type:'turn.started'},{version:1,turnId,sequence:1,type:'resolution.ready',resolution:r}].map(e=>JSON.stringify(e)).join('\n')+'\n'});
  });
  await page.locator('[data-menu-kind="action"]').click();
  for(const kind of ['coordinates','debug']){
    mode=kind;await page.locator('#game-player-action').fill('[DEBUG_WORLD_EFFECT] set white with supplied polygon');await page.locator('#game-player-action').press('Enter');
    const before=await snapshot(page);await page.locator('.game-advance-submit').click();
    await expect(page.locator('.turn-status')).toHaveAttribute('data-phase','failed',{timeout:20000});
    const after=await snapshot(page);expect(after.worldRevision).toBe(before.worldRevision);expect(after.date).toBe(before.date);expect(after.pairNotifications).toBe(before.pairNotifications);
    if(kind==='coordinates'){await enter(page);await page.locator('[data-menu-kind="action"]').click();}
  }
});
