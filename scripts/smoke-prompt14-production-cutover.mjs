import fs from 'node:fs';
import path from 'node:path';
import {chromium} from 'playwright';
import {digest,jsonBytes,writeArtifact,assertBuildOutput} from './prompt14-catalog-core.mjs';
const server=process.argv[2],output=path.resolve(process.argv[3]??'.tmp/prompt14-cutover/browser');
if(!server||!['localhost','127.0.0.1'].includes(new URL(server).hostname))throw new Error('An explicit local production server URL is required');
assertBuildOutput(process.cwd(),output);fs.mkdirSync(output,{recursive:true});
const requests=[],errors=[],failures=[],phases=[],heapSamples=[];
const browser=await chromium.launch({channel:process.env.PLAYWRIGHT_CHROMIUM_CHANNEL,headless:true,args:['--enable-unsafe-swiftshader']});
const page=await browser.newPage({viewport:{width:1440,height:900}}),cdp=await page.context().newCDPSession(page);
page.on('request',r=>requests.push(new URL(r.url()).pathname));page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});page.on('requestfailed',r=>failures.push({path:new URL(r.url()).pathname,error:r.failure()?.errorText}));
const assert=(value,message)=>{if(!value)throw new Error(message);};
const snapshot=()=>page.evaluate(()=>window.__PAX_CATALOG_DEBUG__.getSnapshot());
const ready=()=>page.waitForFunction(()=>window.__PAX_CATALOG_DEBUG__?.ready()&&document.querySelector('[data-testid="world-map"]')?.getAttribute('data-map-status')==='ready',null,{timeout:60000});
let status='fail',error=null,renameNext=false;
try{
  await page.goto(server,{waitUntil:'domcontentloaded'});await ready();
  const first=await snapshot();assert(first.worldSchema===3&&first.simulationSchema===2&&first.date==='2020-01-01','Initial production pair is not V3/V2 canonical seed');
  assert(await page.locator('.app-shell').getAttribute('data-world-territory-count')==='4231','Territory catalog coverage is incomplete');
  assert(await page.evaluate(()=>window.__PAX_CATALOG_DEBUG__.renderedTerritoryIds().length>0&&window.__PAX_CATALOG_DEBUG__.renderedLabelIds().length>0),'Map did not render canonical territories and country labels');
  await page.screenshot({path:path.join(output,'world.png')});phases.push({phase:'world-load',snapshot:first});
  await page.evaluate(()=>window.__PAX_CATALOG_DEBUG__.jumpTo([127.6,36.3],5.5));await ready();
  const box=await page.getByTestId('world-map').boundingBox(),point=await page.evaluate(()=>window.__PAX_CATALOG_DEBUG__.project([127.6,36.3]));
  await page.mouse.move(box.x+point[0],box.y+point[1]);await page.mouse.click(box.x+point[0],box.y+point[1]);
  await page.getByRole('button',{name:/플레이 국가로 선택/}).waitFor();
  assert((await page.locator('aside.panel').innerText()).includes('KOR'),'Canonical territory click did not select Korea in the panel');
  await page.screenshot({path:path.join(output,'korea-panel.png')});phases.push({phase:'selection-hover-label-panel',snapshot:await snapshot()});
  const cameraBuilds=(await snapshot()).projectionBuilds;
  for(let round=0;round<3;round++){
    for(const center of [[-98,38],[104,35],[127.6,36.3],[0,54],[2,46]]){await page.evaluate(center=>window.__PAX_CATALOG_DEBUG__.jumpTo(center,4.5),center);await ready();}
    await cdp.send('HeapProfiler.collectGarbage');heapSamples.push({round,...await cdp.send('Runtime.getHeapUsage'),snapshot:await snapshot()});
  }
  const afterCamera=await snapshot();assert(afterCamera.projectionBuilds===cameraBuilds,'Camera rebuilt the full projection');assert(afterCamera.cachedTiles<=256&&afterCamera.cachedBytes<=8*1024*1024,'Verified tile cache exceeded its bounds');
  assert(heapSamples.at(-1).usedSize<=heapSamples[0].usedSize+32*1024*1024,'Repeated warmed camera routes caused excessive retained heap growth');
  phases.push({phase:'repeated-pan-zoom',snapshot:afterCamera,heapSamples});
  await page.evaluate(()=>window.__PAX_CATALOG_DEBUG__.selectCountry('KOR'));await page.getByRole('button',{name:/플레이 국가로 선택/}).click();await page.waitForURL('**/game#player=KOR');await ready();
  assert((await snapshot()).simulationSchema===2,'Game entered a legacy simulation');
  await page.route('**/api/simulation/turn',async route=>{
    const request=route.request().postDataJSON(),context=request.context;
    const resolution={contractVersion:'turn-resolution.v1',baseSimulationRevision:context.revisions.simulation,baseWorldRevision:context.revisions.world,period:context.period,playerActionOutcomes:[],events:[],factMutations:[],situationMutations:[],scheduledConsequences:[],worldEffects:[],advisorSummary:'안정된 상황이 이어지고 있습니다.',unresolvedQuestions:[]};
    if(renameNext){resolution.events=[{eventId:'event.review-d.rename',date:context.period.endDate,title:'국호 변경',publicNarrative:'국호가 변경되었습니다.',actorCountryIds:['KOR'],relatedFactIds:[],relatedSituationIds:[],causes:[],outcomeCategory:'domestic',significance:'notable'}];resolution.worldEffects=[{effectId:'effect.review-d.rename',causedByEventId:'event.review-d.rename',type:'country.renamed',countryId:'KOR',displayName:'검증 대한민국'}];}
    await route.fulfill({status:200,contentType:'application/x-ndjson',body:[{version:1,turnId:request.turnId,sequence:0,type:'turn.started'},{version:1,turnId:request.turnId,sequence:1,type:'resolution.ready',resolution}].map(v=>JSON.stringify(v)).join('\n')+'\n'});
  });
  await page.getByRole('button',{name:'국가 행동',exact:true}).click();await page.getByRole('checkbox').check();await page.getByRole('button',{name:'진행 시작',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('.turn-status')?.getAttribute('data-phase')==='committed',null,{timeout:15000});
  assert((await snapshot()).date==='2020-01-31','Narrative turn did not commit to the V2 simulation');phases.push({phase:'game-narrative-turn',snapshot:await snapshot()});
  await page.getByRole('button',{name:'마지막 턴 되돌리기'}).click();assert((await snapshot()).date==='2020-01-01','Pair undo did not restore the initial date');
  await page.getByRole('button',{name:'다시 실행',exact:true}).click();assert((await snapshot()).date==='2020-01-31','Pair redo did not restore the committed date');
  await page.evaluate(()=>{
    const map=window.__PAX_CATALOG_DEBUG__.inspectMap();window.__reviewDCalls=[];
    for(const id of ['world-territory-catalog','catalog-country-labels','catalog-capitals','catalog-country-glyph-fills','catalog-country-glyph-outlines','catalog-small-country-labels']){
      const source=map.getSource(id);
      for(const method of ['setData','updateData'])if(typeof source[method]==='function'){
        const original=source[method];source[method]=function(value){window.__reviewDCalls.push({source:id,method,value:JSON.parse(JSON.stringify(value))});return original.call(this,value);};
      }
    }
  });
  await page.evaluate(()=>window.__PAX_CATALOG_DEBUG__.jumpTo([127.6,36.3],5.5));await ready();
  const renameBaseRevision=(await snapshot()).worldRevision;
  renameNext=true;
  if(!await page.getByRole('checkbox',{name:'행동 없이 시간만 진행'}).isVisible())await page.getByRole('button',{name:'국가 행동',exact:true}).click();
  await page.getByRole('checkbox',{name:'행동 없이 시간만 진행'}).check();await page.getByRole('button',{name:'진행 시작',exact:true}).click();
  await page.waitForFunction(revision=>window.__PAX_CATALOG_DEBUG__.getSnapshot().worldRevision===revision,renameBaseRevision+1);await ready();
  const labelStages=[];
  const inspectRename=async(stage,text)=>{
    await page.waitForFunction(text=>window.__PAX_CATALOG_DEBUG__.inspectMap().queryRenderedFeatures(undefined,{layers:['catalog-country-glyph-fills']}).some(f=>f.properties.countryId==='KOR'&&f.properties.text===text),text,{timeout:15000});
    await ready();const measured=await page.evaluate(async()=>{
      const map=window.__PAX_CATALOG_DEBUG__.inspectMap(),data=await map.getSource('catalog-country-labels').getData();
      return {calls:window.__reviewDCalls,label:data.features.find(f=>f.id==='catalog-label:KOR'),rendered:map.queryRenderedFeatures(undefined,{layers:['catalog-country-glyph-fills']}).filter(f=>f.properties.countryId==='KOR').map(f=>f.properties.text),outlines:map.queryRenderedFeatures(undefined,{layers:['catalog-country-glyph-outlines']}).filter(f=>f.properties.countryId==='KOR').map(f=>f.properties.text)};
    });
    assert(measured.label?.properties.text===text&&measured.rendered.includes(text)&&measured.outlines.includes(text),`${stage} did not update the real rendered Korean glyph/outline: ${JSON.stringify(measured)}`);
    const expected=labelStages.length+1,updates=measured.calls.filter(c=>c.method==='updateData'&&c.source==='catalog-country-labels');
    assert(measured.calls.filter(c=>c.method==='setData').length===0,`${stage} performed whole-source setData`);
    assert(updates.length===expected&&updates.every(c=>c.source==='catalog-country-labels'&&c.value.update?.length===1&&c.value.update[0].id==='catalog-label:KOR'&&!c.value.add&&!c.value.remove),`${stage} updated unaffected features or capitals`);
    assert(measured.calls.every(c=>c.source!=='catalog-capitals'),`${stage} updated unrelated capitals`);
    const glyphUpdates=measured.calls.filter(c=>c.method==='updateData'&&c.source!=='catalog-country-labels');
    for(const source of ['catalog-country-glyph-fills','catalog-country-glyph-outlines'])assert(glyphUpdates.filter(c=>c.source===source).length===expected,`${stage} missed an incremental glyph source update`);
    assert(glyphUpdates.every(c=>[...(c.value.add??[]).map(f=>f.id),...(c.value.update??[]).map(f=>f.id),...(c.value.remove??[])].every(id=>/^(fill|outline|fallback):KOR:/.test(String(id)))),`${stage} updated an unaffected country's glyph`);
    labelStages.push({stage,text,...measured});await page.screenshot({path:path.join(output,`label-${stage}.png`)});
  };
  await inspectRename('rename','검증 대한민국');
  await page.getByRole('button',{name:'마지막 턴 되돌리기'}).click();await page.waitForFunction(revision=>window.__PAX_CATALOG_DEBUG__.getSnapshot().worldRevision===revision,renameBaseRevision+2);await inspectRename('undo','대한민국');
  await page.getByRole('button',{name:'다시 실행',exact:true}).click();await page.waitForFunction(revision=>window.__PAX_CATALOG_DEBUG__.getSnapshot().worldRevision===revision,renameBaseRevision+3);await inspectRename('redo','검증 대한민국');
  const measuredCalls=labelStages.at(-1).calls;
  phases.push({phase:'incremental-rename-undo-redo',labelStages,wholeSourceSetDataCalls:measuredCalls.filter(c=>c.method==='setData').length,capitalUpdateCalls:measuredCalls.filter(c=>c.source==='catalog-capitals').length,labelUpdateCalls:measuredCalls.filter(c=>c.source==='catalog-country-labels'&&c.method==='updateData').length,updatedFeatureIds:[...new Set(measuredCalls.flatMap(c=>(c.value.update??[]).map(f=>f.id)))]});
  await page.getByRole('button',{name:'설정',exact:true}).click();
  const widths=()=>page.evaluate(()=>window.__PAX_CATALOG_DEBUG__.inspectMap().getPaintProperty('catalog-territory-edges','line-width'));
  const normal=await widths();await page.locator('[data-setting-key="emphasizeBorders"]').check();
  await page.waitForFunction(()=>window.__PAX_CATALOG_DEBUG__.inspectMap().getPaintProperty('catalog-territory-edges','line-width')[3]?.[2]===1.6);
  const emphasized=await widths();assert(normal[2]===0.3&&emphasized[2]===0.3&&normal[3][2]===0.8&&emphasized[3][2]===1.6,'Country/admin widths do not match emphasis policy');
  await page.screenshot({path:path.join(output,'borders-emphasized.png')});
  await page.locator('[data-setting-key="emphasizeBorders"]').uncheck();
  await page.waitForFunction(()=>window.__PAX_CATALOG_DEBUG__.inspectMap().getPaintProperty('catalog-territory-edges','line-width')[3]?.[2]===0.8);
  const restored=await widths();assert(JSON.stringify(restored)===JSON.stringify(normal),'Border widths did not restore');
  await page.screenshot({path:path.join(output,'borders-normal.png')});phases.push({phase:'border-emphasis-settings',normal,emphasized,restored,administrativeWidth:normal[2],countryNormalWidth:normal[3][2],countryEmphasizedWidth:emphasized[3][2]});
  await page.reload({waitUntil:'domcontentloaded'});await ready();const refreshed=await snapshot();assert(refreshed.date==='2020-01-01'&&refreshed.worldSchema===3&&refreshed.simulationSchema===2,'Refresh did not restore the V3/V2 canonical seed');
  await page.screenshot({path:path.join(output,'game-refreshed.png')});phases.push({phase:'refresh-seed-restoration',snapshot:refreshed});
  const persisted=await page.evaluate(async()=>({localStorage:localStorage.length,sessionStorage:sessionStorage.length,indexedDbDatabases:(await indexedDB.databases()).length}));assert(persisted.localStorage===0&&persisted.sessionStorage===0&&persisted.indexedDbDatabases===0,'Browser state persistence was introduced');
  phases.push({phase:'no-browser-persistence',...persisted});
  assert(!requests.some(p=>/build-only|geometry\.geojson|topology\.json|\/data\/maps\/.*geojson/.test(p)),'Production browser requested a full geometry asset');
  assert(errors.length===0,`Browser errors: ${errors.join('; ')}`);
  const bad=await browser.newPage({viewport:{width:1440,height:900}});
  await bad.route('**/manifest.json',async route=>{const response=await route.fetch(),bytes=await response.body();bytes[0]^=1;await route.fulfill({response,body:bytes});});
  await bad.goto(server);await bad.getByRole('alert').waitFor();assert(await bad.locator('.app-shell').count()===0,'Catalog mismatch allowed a partial runtime to enter');await bad.close();
  phases.push({phase:'catalog-mismatch-entry-rejected'});status='pass';
}catch(e){error=e.stack;await page.screenshot({path:path.join(output,'failure.png')}).catch(()=>{});}
finally{await browser.close();}
const evidence={status,error,server,phases,requests:[...new Set(requests)],requestCount:requests.length,browserErrors:errors,requestFailures:failures,
  screenshots:fs.readdirSync(output).filter(p=>p.endsWith('.png')).map(p=>{const b=fs.readFileSync(path.join(output,p));return {path:p,sha256:digest(b),byteLength:b.length};})};
writeArtifact(output,'runtime-smoke-evidence.json',jsonBytes(evidence));console.log(JSON.stringify({status,error,phases:phases.map(p=>p.phase),output}));if(status!=='pass')process.exitCode=1;
