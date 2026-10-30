// Authoritative local browser QA only. The runner creates an isolated context,
// opens a new local game, and never requests an AI turn or changes another tab.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {chromium} from '@playwright/test';

const option=name=>{const i=process.argv.indexOf(name);if(i<0)return null;const value=process.argv[i+1];if(!value||value.startsWith('--'))throw Error(`MISSING_ARGUMENT:${name}`);return value;};
const phase=option('--phase')??'candidate';if(!['baseline','candidate'].includes(phase))throw Error('INVALID_PHASE');
const baseURL=option('--url')??process.env.PLAYWRIGHT_BASE_URL??'http://localhost:3000';
const base=new URL(baseURL);if(!['localhost','127.0.0.1','[::1]'].includes(base.hostname))throw Error('LOCAL_BROWSER_ONLY');
const expectedCatalog=option('--expected-catalog')??JSON.parse(fs.readFileSync('data/runtime/operational-catalog/current.json')).catalogVersion;
const outputRoot=path.resolve(`reports/chn-2020/browser-${phase}`);fs.mkdirSync(outputRoot,{recursive:true});
const reportFile=path.join(outputRoot,'verification.json');
const started=performance.now(),failures=[],consoleErrors=[],warnings=[],pageErrors=[],failedRequests=[],httpErrors=[],externalRequests=[],turnRequests=[],screens=[],views=[];
const report={schemaVersion:'chn-2020-browser-verification-v1',phase,pass:false,expectedCatalog,conditions:{baseURL,mode:'Next development server; actual Chromium WebGL',viewport:{width:1440,height:900},deviceScaleFactor:1,cold:'new browser context with empty browser cache; server and OS caches are not flushed',warm:'reload in the same context before any interception; normal HTTP cache remains enabled',reducedMotion:'reduce',externalAiCalls:0},loads:[],views,screens,consoleErrors,warnings,pageErrors,failedRequests,httpErrors,externalRequests,turnRequests,failures,
  browserTurn:{executed:false,reason:'The normal browser turn route constructs FetchOpenAIResponsesTransport and has no scripted-provider injection. This runner never starts that route. Actual scripted-provider tool lookup, atomic turn, undo/redo and cold/warm turn timings are covered by verify-play-performance.test.ts.'}};
const check=(condition,message)=>{if(!condition)throw Error(message);};
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const summarizeIds=ids=>{const values=[...new Set(ids)].sort((a,b)=>String(a).localeCompare(String(b)));return {count:values.length,sha256:hash(values),sample:values.slice(0,24)};};
const layers={fill:'operational-fill',detailFill:'operational-detail-fill',changedFill:'operational-changed-fill',country:'operational-country-border',detailCountry:'operational-detail-country-border',administrative:'operational-administrative-border',detailAdministrative:'operational-detail-administrative-border',micro:'operational-cell-grid',detailMicro:'operational-detail-cell-grid',front:'operational-front',detailFront:'operational-detail-front'};
let browser,context,page;

async function settled(){
  await page.waitForFunction(()=>window.__PAX_OPERATIONAL_DEBUG__?.isRenderSettled(),null,{timeout:180_000,polling:100});
  await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
}
async function browserMetrics(){
  return page.evaluate(()=>{
    const resources=performance.getEntriesByType('resource').map(entry=>({name:entry.name,initiatorType:entry.initiatorType,startTime:entry.startTime,duration:entry.duration,transferSize:entry.transferSize,encodedBodySize:entry.encodedBodySize,decodedBodySize:entry.decodedBodySize}));
    const memory=performance.memory?{usedJSHeapSize:performance.memory.usedJSHeapSize,totalJSHeapSize:performance.memory.totalJSHeapSize,jsHeapSizeLimit:performance.memory.jsHeapSizeLimit}:null;
    return {mapReadyFromNavigationMs:performance.now(),navigation:performance.getEntriesByType('navigation').map(entry=>({type:entry.type,duration:entry.duration,domContentLoadedEventEnd:entry.domContentLoadedEventEnd,loadEventEnd:entry.loadEventEnd,transferSize:entry.transferSize,encodedBodySize:entry.encodedBodySize,decodedBodySize:entry.decodedBodySize})),resources,longTasks:window.__CHN_BROWSER_METRICS__?.longTasks??[],memory,state:window.__PAX_OPERATIONAL_DEBUG__?.getState(),updateStats:window.__PAX_OPERATIONAL_DEBUG__?.getUpdateStats()};
  });
}
function categories(resources){
  const totals={};
  for(const item of resources){
    const match=item.name.match(/\/tiles\/(\d+)\//),category=match?(Number(match[1])<=2?'overviewTiles':'detailTiles'):item.name.includes('/detail/')?'exactDetail':/metadata|operational|manifest|catalog|index/.test(item.name)?'indexAndMetadata':item.name.includes('/fonts/')?'fonts':'applicationAndOther';
    const total=totals[category]??{requests:0,transferBytes:0,encodedBodyBytes:0,decodedBodyBytes:0,zeroTransferRequests:0};total.requests++;total.transferBytes+=item.transferSize;total.encodedBodyBytes+=item.encodedBodySize;total.decodedBodyBytes+=item.decodedBodySize;if(item.transferSize===0)total.zeroTransferRequests++;totals[category]=total;
  }return totals;
}
async function capture(name){const file=path.join(outputRoot,`${name}.png`);await page.screenshot({path:file,fullPage:false});screens.push({name,path:path.relative(process.cwd(),file).replaceAll('\\','/')});}
async function stateSnapshot(){
  const result=await page.evaluate(async layerIds=>{
    const debug=window.__PAX_OPERATIONAL_DEBUG__;if(!debug)throw Error('DEVELOPMENT_DEBUG_BRIDGE_MISSING');
    const states=await Promise.all(Object.entries(layerIds).map(async([key,id])=>{
      const layer=debug.getLayerState(id);if(!layer)return [key,null];const text=JSON.stringify(layer.filter);
      if(text.length>2000){const bytes=new TextEncoder().encode(text),digest=await crypto.subtle.digest('SHA-256',bytes);layer.filter={kind:'large-filter-summary',byteLength:bytes.byteLength,sha256:[...new Uint8Array(digest)].map(b=>b.toString(16).padStart(2,'0')).join(''),expressionPreview:text.slice(0,300)};}
      return [key,layer];
    }));
    return {state:debug.getState(),center:debug.getCenter(),zoom:debug.getZoom(),renderSettled:debug.isRenderSettled(),updateStats:debug.getUpdateStats(),layers:Object.fromEntries(states),fills:debug.queryRenderedFillIds(),micro:debug.queryRenderedFeatures({layers:[layerIds.micro,layerIds.detailMicro]}),exactCellIds:debug.querySourceFeatureIds('world-operational-exact-cells'),exactEdgeIds:debug.querySourceFeatureIds('world-operational-exact-edges'),frontIds:debug.querySourceFeatureIds('world-operational-front-detail')};
  },layers);
  return {...result,fills:summarizeIds(result.fills.map(f=>`${f.source}/${f.sourceLayer??''}/${f.id}`)),micro:summarizeIds(result.micro.map(f=>`${f.source}/${f.id}`)),exactCellIds:summarizeIds(result.exactCellIds),exactEdgeIds:summarizeIds(result.exactEdgeIds),frontIds:summarizeIds(result.frontIds)};
}
async function checkMapStyle(snapshot,debug){
  check(snapshot.state.catalogRef.catalogVersion===expectedCatalog,'BROWSER_CATALOG_IS_STALE');
  check(snapshot.renderSettled,'MAP_NOT_SETTLED');check(!snapshot.updateStats?.resyncRequired,'MAP_RESYNC_REQUIRED');check(snapshot.fills.count>0,'NO_RENDERED_LAND');
  for(const name of ['micro','detailMicro'])check(snapshot.layers[name]?.visibility===(debug?'visible':'none'),`${name} debug visibility mismatch`);
  if(!debug)check(snapshot.micro.count===0,'MICRO_BOUNDARIES_VISIBLE_IN_NORMAL_MODE');
  for(const name of ['country','detailCountry'])check(snapshot.layers[name]?.paint?.['line-color']==='#000000',`${name} is not black`);
  for(const name of ['administrative','detailAdministrative'])check(snapshot.layers[name]?.paint?.['line-color']==='#FFFFFF',`${name} is not white`);
  const frontOpacity=JSON.stringify(snapshot.layers.front?.paint?.['line-opacity']);check(frontOpacity.includes('feature-state')&&frontOpacity.includes('front'),'GOLD_FRONT_IS_NOT_STATE_GATED');check(snapshot.frontIds.count===0,'PEACETIME_EXACT_FRONT_IS_NOT_EMPTY');
}

try{
  browser=await chromium.launch({headless:true,args:['--enable-unsafe-swiftshader','--enable-precise-memory-info']});
  context=await browser.newContext({viewport:{width:1440,height:900},deviceScaleFactor:1,locale:'ko-KR',reducedMotion:'reduce'});
  await context.addInitScript(()=>{
    performance.setResourceTimingBufferSize(5000);window.__CHN_BROWSER_METRICS__={longTasks:[]};
    try{new PerformanceObserver(list=>{for(const entry of list.getEntries())window.__CHN_BROWSER_METRICS__.longTasks.push({startTime:entry.startTime,duration:entry.duration,name:entry.name});}).observe({type:'longtask',buffered:true});}catch{/* Chromium may omit the Long Tasks API; resources/memory still remain measured. */}
  });
  page=await context.newPage();
  page.on('console',message=>{
    const item={type:message.type(),text:message.text(),location:message.location()};
    if(message.type()==='error')consoleErrors.push(item);
    if(message.type()==='warning'||message.type()==='warn'){
      const readback=/^\[\.WebGL-0x[0-9a-f]+\]GL Driver Message \(OpenGL, Performance, GL_CLOSE_PATH_NV, High\): GPU stall due to ReadPixels(?: \(this message will no longer repeat\))?$/i.test(item.text);
      const informational=/Download the React DevTools|preloaded using link preload but not used within a few seconds/.test(item.text);
      warnings.push({...item,material:!informational&&!readback,performanceWarning:readback,classification:readback?'headless-software-webgl-readback-performance':informational?'development-tooling-or-unused-preload':'unclassified-warning'});
    }
  });
  page.on('pageerror',error=>pageErrors.push({name:error.name,message:error.message,stack:error.stack}));
  page.on('request',request=>{
    const url=request.url();if(url.startsWith('http')&&new URL(url).origin!==base.origin)externalRequests.push({url,method:request.method()});
    if(url.includes('/api/simulation/turn'))turnRequests.push({url,method:request.method()});
  });
  page.on('requestfailed',request=>failedRequests.push({url:request.url(),error:request.failure()?.errorText??'unknown',expectedCancellation:request.failure()?.errorText==='net::ERR_ABORTED'}));
  page.on('response',response=>{if(response.status()>=400)httpErrors.push({url:response.url(),status:response.status()});});
  for(const condition of ['cold','warm']){
    const began=performance.now();
    if(condition==='cold')await page.goto(baseURL,{waitUntil:'domcontentloaded',timeout:180_000});else await page.reload({waitUntil:'domcontentloaded',timeout:180_000});
    await page.locator('[data-testid="world-map"]').waitFor({state:'visible',timeout:180_000});await settled();
    const metrics=await browserMetrics();check(metrics.state?.catalogRef.catalogVersion===expectedCatalog,`${condition} loaded a stale catalog`);
    check(metrics.state?.revision===0,`${condition} did not start a fresh game`);
    report.loads.push({condition,wallMs:performance.now()-began,...metrics,resourceCategories:categories(metrics.resources),longTaskCount:metrics.longTasks.length,longTaskTotalMs:metrics.longTasks.reduce((n,t)=>n+t.duration,0),maximumLongTaskMs:Math.max(0,...metrics.longTasks.map(t=>t.duration))});
    console.log(JSON.stringify({phase,condition,mapReadyMs:metrics.mapReadyFromNavigationMs,resources:metrics.resources.length,longTasks:metrics.longTasks.length}));
  }
  const viewpoints=[{name:'world',center:[15,20],zoom:1},{name:'china',center:[104.5,35],zoom:3.3},{name:'chn-prk-border',center:[124.4,40.6],zoom:6.2},{name:'shanghai-coast',center:[121.2,31.1],zoom:6.2},{name:'hainan-island',center:[109.7,19.15],zoom:6}];
  for(const view of viewpoints)for(const debug of [false,true]){
    await page.evaluate(({view,debug})=>{const bridge=window.__PAX_OPERATIONAL_DEBUG__;bridge.selectCountryDetail(null);bridge.setDebugBoundaries(debug);bridge.jumpTo(view.center,view.zoom);},{view,debug});
    await settled();const snapshot=await stateSnapshot();await checkMapStyle(snapshot,debug);
    if(phase==='candidate'&&debug&&view.name==='china')check(snapshot.micro.count>0,'CHN_FINE_BOUNDARIES_NOT_RENDERED_IN_DEBUG');
    views.push({name:view.name,mode:debug?'debug':'normal',...snapshot});await capture(`${view.name}-${debug?'debug':'normal'}`);
  }
  // Performance sampling is complete before routing. A delayed first CHN detail
  // response is cancelled by an ordinary PRK selection and then by clearing it.
  let routeStarted,delayedRequests=0;const entered=new Promise(resolve=>{routeStarted=resolve;});
  const pattern='**/detail/countries/CHN.geojson.gz';
  const delayHandler=async route=>{delayedRequests++;routeStarted();await new Promise(resolve=>setTimeout(resolve,1200));try{await route.continue();}catch(error){if(!/already handled|disposed|closed|aborted|Invalid InterceptionId/i.test(String(error)))throw error;}};
  await context.route(pattern,delayHandler);
  await page.evaluate(()=>window.__PAX_OPERATIONAL_DEBUG__.selectCountryDetail('CHN'));
  await Promise.race([entered,new Promise((_,reject)=>setTimeout(()=>reject(Error('FIRST_CHN_DETAIL_REQUEST_NOT_INTERCEPTED')),15_000))]);
  await page.evaluate(()=>{const bridge=window.__PAX_OPERATIONAL_DEBUG__;bridge.jumpTo([127,40.5],5.3);bridge.selectCountryDetail('PRK');});
  await page.waitForFunction(()=>{const state=window.__PAX_OPERATIONAL_DEBUG__?.getState();return state?.selectedCountryId==='PRK'&&state.detailStatus==='ready';},null,{timeout:180_000});
  await settled();const prkDetail=await stateSnapshot();check(prkDetail.exactCellIds.count>0,'PRK detail never mounted during late-request check');
  await page.evaluate(()=>window.__PAX_OPERATIONAL_DEBUG__.selectCountryDetail(null));await settled();
  await page.waitForTimeout(1500);await settled();
  const cleared=await stateSnapshot();check(cleared.state.selectedCountryId===null&&cleared.state.detailStatus==='idle','DETAIL_SELECTION_NOT_CLEARED');check(cleared.exactCellIds.count===0&&cleared.exactEdgeIds.count===0,'LATE_COUNTRY_DETAIL_REAPPEARED');check(cleared.state.revision===0,'DETAIL_QA_MUTATED_WORLD');
  report.staleDetail={pass:true,delayedChnRequests:delayedRequests,selectedPrkExactCells:prkDetail.exactCellIds,afterClear:cleared};await capture('stale-detail-cleared');await context.unroute(pattern,delayHandler);
  await page.evaluate(()=>{const bridge=window.__PAX_OPERATIONAL_DEBUG__;bridge.jumpTo([104.5,35],3.3);bridge.selectCountryDetail('CHN');});
  await page.waitForFunction(()=>{const state=window.__PAX_OPERATIONAL_DEBUG__?.getState();return state?.selectedCountryId==='CHN'&&state.detailStatus==='ready';},null,{timeout:180_000});
  for(const debug of [false,true]){
    await page.evaluate(value=>window.__PAX_OPERATIONAL_DEBUG__.setDebugBoundaries(value),debug);await settled();const snapshot=await stateSnapshot();await checkMapStyle(snapshot,debug);check(snapshot.exactCellIds.count>0,'CHN_EXACT_DETAIL_EMPTY');views.push({name:'china-selected-detail',mode:debug?'debug':'normal',...snapshot});await capture(`china-selected-detail-${debug?'debug':'normal'}`);
  }
  await page.evaluate(()=>{window.__PAX_OPERATIONAL_DEBUG__.selectCountryDetail(null);window.__PAX_OPERATIONAL_DEBUG__.setDebugBoundaries(false);});await settled();await capture('china-detail-cleared');
  // Confirm the isolated browser's own new game through the actual UI. No turn
  // is submitted; this cannot touch a different browser context's local game.
  await page.evaluate(()=>window.__PAX_OPERATIONAL_DEBUG__.selectCountryDetail('CHN'));
  await page.locator('aside.panel .panel-kicker').filter({hasText:/CHN/}).waitFor({state:'visible',timeout:30_000});
  const selectedCountryName=(await page.locator('#country-title').innerText()).trim();
  const startButtonName=`${selectedCountryName}을(를) 플레이 국가로 선택`;
  await page.getByRole('button',{name:startButtonName,exact:true}).click();
  await page.locator('[data-testid="game-screen"]').waitFor({state:'visible',timeout:180_000});await settled();
  const game=await stateSnapshot();check(game.state.catalogRef.catalogVersion===expectedCatalog,'NEW_GAME_CATALOG_MISMATCH');check(game.state.revision===0,'NEW_GAME_WORLD_REVISION_NOT_ZERO');
  report.newGame={pass:true,path:new URL(page.url()).pathname,selectedCountryName,startButtonName,state:game.state,updateStats:game.updateStats,date:await page.locator('.app-shell').getAttribute('data-current-date')};await capture('new-china-game');
  check(report.newGame.date==='2020-01-01','NEW_GAME_SCENARIO_DATE_MISMATCH');
  report.finalMetrics=await browserMetrics();report.finalResourceCategories=categories(report.finalMetrics.resources);
}catch(error){failures.push({message:error instanceof Error?error.message:String(error),stack:error instanceof Error?error.stack:null});if(page)try{await capture('failure');}catch{/* Preserve the original diagnostic if browser rendering failed. */}}
finally{
  if(context)try{await context.close();}catch(error){failures.push({message:`context.close: ${String(error)}`});}
  if(browser)try{await browser.close();}catch(error){failures.push({message:`browser.close: ${String(error)}`});}
  if(consoleErrors.length)failures.push({message:`${consoleErrors.length} browser console errors`});if(pageErrors.length)failures.push({message:`${pageErrors.length} uncaught browser errors`});if(warnings.some(w=>w.material))failures.push({message:`${warnings.filter(w=>w.material).length} material browser warnings`});if(httpErrors.length)failures.push({message:`${httpErrors.length} HTTP errors`});if(externalRequests.length)failures.push({message:`${externalRequests.length} unexpected external browser requests`});if(turnRequests.length)failures.push({message:`${turnRequests.length} forbidden AI-turn requests`});
  const unexpectedFailures=failedRequests.filter(r=>!r.expectedCancellation);if(unexpectedFailures.length)failures.push({message:`${unexpectedFailures.length} failed requests beyond ordinary navigation/detail cancellation`});
  report.pass=failures.length===0;report.elapsedMs=performance.now()-started;report.browser=browser?.browserType().name()??'chromium';report.code={path:'scripts/chn-2020/verify-browser.mjs',sha256:createHash('sha256').update(fs.readFileSync('scripts/chn-2020/verify-browser.mjs')).digest('hex')};
  fs.writeFileSync(reportFile,`${JSON.stringify(report,null,2)}\n`);
  console.log(JSON.stringify({phase,pass:report.pass,report:reportFile,screenshots:screens.length,loads:report.loads.map(load=>({condition:load.condition,mapReadyMs:load.mapReadyFromNavigationMs,longTasks:load.longTaskCount})),failures:failures.map(f=>f.message)}));if(!report.pass)process.exitCode=1;
}
