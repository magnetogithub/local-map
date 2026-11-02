// Actual local UI turns through the existing, explicitly aliased scripted
// provider. A pinned trusted launch proof and empty trimmed API key are required
// before browser launch and again before every advance. No provider is mocked here.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {gunzipSync} from 'node:zlib';
import {performance} from 'node:perf_hooks';
import {chromium} from '@playwright/test';

const option=name=>{const i=process.argv.indexOf(name);if(i<0)return null;const value=process.argv[i+1];if(!value||value.startsWith('--'))throw Error(`MISSING_ARGUMENT:${name}`);return value;};
const proofFile=option('--launch-proof');if(!proofFile)throw Error('LAUNCH_PROOF_REQUIRED_BEFORE_BROWSER_TURNS');
const read=file=>JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,'')),sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const pin=file=>{const bytes=fs.readFileSync(file);return {path:file,sha256:sha(bytes),byteLength:bytes.length};};
const proofPin=pin(proofFile),proof=read(proofFile),baseURL=option('--url')??proof.url,pointerFile=option('--pointer')??'data/runtime/operational-catalog/current.json';
const outputRoot=path.resolve('reports/chn-2020/browser-play-candidate');fs.mkdirSync(outputRoot,{recursive:true});
const started=performance.now(),failures=[],consoleErrors=[],warnings=[],pageErrors=[],externalRequests=[],screens=[],turns=[];
const check=(condition,message)=>{if(!condition)throw Error(message);};
function assertSafeLaunch(){
  const currentPin=pin(proofFile);check(currentPin.sha256===proofPin.sha256&&currentPin.byteLength===proofPin.byteLength,'LAUNCH_PROOF_CHANGED');
  check(proof.smoke===true&&proof.apiKeyPolicy==='whitespace-trims-empty'&&proof.disabledExternalAI===true,'UNSAFE_QA_LAUNCH_POLICY');
  check(proof.environment?.PAX_OPERATIONAL_SMOKE==='1'&&typeof proof.environment.OPENAI_API_KEY==='string'&&/^\s+$/.test(proof.environment.OPENAI_API_KEY)&&proof.environment.OPENAI_API_KEY.trim()===''&&proof.environment.OPENAI_MODEL==='disabled-for-local-qa','EXTERNAL_AI_NOT_DISABLED_IN_LAUNCH');
  const url=new URL(baseURL);check(['127.0.0.1','localhost','[::1]'].includes(url.hostname)&&url.port==='3001'&&new URL(proof.url).origin===url.origin,'DEDICATED_TRUSTED_QA_PORT_REQUIRED');
  check(Number.isSafeInteger(proof.pid)&&proof.pid>0,'QA_PID_MISSING');process.kill(proof.pid,0);
  const code=proof.launchCodeArtifact;check(code?.path==='scripts/chn-2020/start-local-qa.ps1','UNEXPECTED_LAUNCH_CODE');const current=pin(code.path);check(current.sha256===code.sha256&&current.byteLength===code.byteLength,'LAUNCH_CODE_PIN_MISMATCH');
  const launcher=fs.readFileSync(code.path,'utf8'),config=fs.readFileSync('next.config.ts','utf8'),providerConfig=fs.readFileSync('src/lib/simulation/server/provider-config.ts','utf8'),fixture=fs.readFileSync('src/lib/test-only/region-provider.server.ts','utf8');
  check(launcher.includes("$env:OPENAI_API_KEY = ' '")&&launcher.includes("$env:PAX_OPERATIONAL_SMOKE = '1'")&&launcher.includes('QA_PORT_ALREADY_IN_USE')&&launcher.includes('-WindowStyle Hidden'),'LAUNCH_FAIL_CLOSED_FACTS_CHANGED');
  check(config.includes("process.env.PAX_OPERATIONAL_SMOKE === '1'")&&config.includes("'@/lib/simulation/server/production-provider.server': './src/lib/test-only/region-provider.server.ts'"),'SCRIPTED_ALIAS_SOURCE_CHANGED');
  check(providerConfig.includes('environment.OPENAI_API_KEY?.trim()')&&providerConfig.includes('if (!apiKey || !model)')&&providerConfig.includes('AI_NOT_CONFIGURED'),'PRODUCTION_FAIL_CLOSED_GUARD_CHANGED');
  check(fixture.includes("apiKey:'fixture'")&&fixture.includes('},transport)')&&fixture.includes("events('find_frontier_territories'")&&!fixture.includes('FetchOpenAIResponsesTransport'),'FIXTURE_INTERNAL_TRANSPORT_FACTS_CHANGED');
  const pointer=read(pointerFile);check(pointer.catalogVersion===proof.catalogVersion,'LAUNCH_AND_POINTER_CATALOG_DIFFER');
  return {url:url.origin,catalogVersion:pointer.catalogVersion,sourcePins:['next.config.ts','src/lib/simulation/server/provider-config.ts','src/lib/test-only/region-provider.server.ts'].map(pin)};
}
let browser,context,page,local;
const report={schemaVersion:'chn-2020-browser-play-verification-v1',pass:false,launchProof:proofPin,pointer:pin(pointerFile),conditions:{viewport:{width:1440,height:900},deviceScaleFactor:1,mode:'actual Chromium UI and production host validation with the existing in-process scripted provider alias',player:'CHN',target:'PRK',period:'two successive one-day turns',externalAiCalls:0},turns,screens,failures,consoleErrors,warnings,pageErrors,externalRequests};
const summarize=values=>{const unique=[...new Set(values)].sort((a,b)=>String(a).localeCompare(String(b)));return {count:unique.length,sha256:sha(Buffer.from(JSON.stringify(unique))),sample:unique.slice(0,24)};};
async function settled(){await page.waitForFunction(()=>window.__PAX_OPERATIONAL_DEBUG__?.isRenderSettled(),null,{timeout:180_000,polling:100});await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));}
async function capture(name){const file=path.join(outputRoot,`${name}.png`);await page.screenshot({path:file,fullPage:false});screens.push({name,path:path.relative(process.cwd(),file).replaceAll('\\','/')});}
async function metrics(){return page.evaluate(()=>({state:window.__PAX_OPERATIONAL_DEBUG__.getState(),stats:window.__PAX_OPERATIONAL_DEBUG__.getUpdateStats(),resources:performance.getEntriesByType('resource').map(r=>({name:r.name,transferSize:r.transferSize,encodedBodySize:r.encodedBodySize,decodedBodySize:r.decodedBodySize,duration:r.duration})),longTasks:window.__CHN_BROWSER_PLAY_METRICS__.longTasks,memory:performance.memory?{usedJSHeapSize:performance.memory.usedJSHeapSize,totalJSHeapSize:performance.memory.totalJSHeapSize,jsHeapSizeLimit:performance.memory.jsHeapSizeLimit}:null,exactCellIds:window.__PAX_OPERATIONAL_DEBUG__.querySourceFeatureIds('world-operational-exact-cells'),frontIds:window.__PAX_OPERATIONAL_DEBUG__.querySourceFeatureIds('world-operational-front-detail'),renderedFront:window.__PAX_OPERATIONAL_DEBUG__.queryRenderedFeatures({layers:['operational-detail-front']}),frontLayer:window.__PAX_OPERATIONAL_DEBUG__.getLayerState('operational-detail-front')}));}
function connectedToSupport(changedIds,supportIds){
  const allowed=new Set(changedIds.map(id=>local.ordinalById.get(id))),support=new Set(supportIds.map(id=>local.ordinalById.get(id))),seen=new Set(),queue=[];
  for(const n of allowed)if(local.neighbors(n).some(other=>support.has(other))){seen.add(n);queue.push(n);}
  for(let i=0;i<queue.length;i++)for(const n of local.neighbors(queue[i]))if(allowed.has(n)&&!seen.has(n)){seen.add(n);queue.push(n);}
  return seen.size===allowed.size;
}
try{
  report.safety=assertSafeLaunch();
  const pointer=read(pointerFile),indexBytes=fs.readFileSync(`${pointer.root}/artifact-index.json`);check(sha(indexBytes)===pointer.index.sha256&&indexBytes.length===pointer.index.byteLength,'PACKAGE_INDEX_PIN_MISMATCH');
  const artifacts=new Map(JSON.parse(indexBytes).artifacts.map(a=>[a.path,a]));
  const gz=file=>{const a=artifacts.get(file),bytes=fs.readFileSync(`${pointer.root}/${file}`);check(a&&bytes.length===a.byteLength&&sha(bytes)===a.sha256,`PACKAGE_ASSET_PIN:${file}`);return JSON.parse(gunzipSync(bytes));};
  const chnRows=gz('metadata/countries/CHN.json.gz').rows,prkRows=gz('metadata/countries/PRK.json.gz').rows,adjacency=gz('adjacency.json.gz'),cellMetrics=gz('metrics.json.gz');
  local={metrics:new Map(cellMetrics.map(m=>[m.id,m])),ordinalById:new Map([...chnRows,...prkRows].map(row=>[row[1],row[0]])),neighbors:n=>adjacency.neighbors.slice(adjacency.offsets[n-1],adjacency.offsets[n])};
  browser=await chromium.launch({headless:true,args:['--enable-unsafe-swiftshader','--enable-precise-memory-info']});context=await browser.newContext({viewport:{width:1440,height:900},deviceScaleFactor:1,locale:'ko-KR',reducedMotion:'reduce'});
  await context.addInitScript(()=>{performance.setResourceTimingBufferSize(5000);window.__CHN_BROWSER_PLAY_METRICS__={longTasks:[]};try{new PerformanceObserver(list=>{for(const entry of list.getEntries())window.__CHN_BROWSER_PLAY_METRICS__.longTasks.push({startTime:entry.startTime,duration:entry.duration});}).observe({type:'longtask',buffered:true});}catch{}});
  page=await context.newPage();page.on('console',message=>{if(message.type()==='error')consoleErrors.push(message.text());if(['warning','warn'].includes(message.type())){const text=message.text(),readback=/^\[\.WebGL-0x[0-9a-f]+\]GL Driver Message \(OpenGL, Performance, GL_CLOSE_PATH_NV, High\): GPU stall due to ReadPixels(?: \(this message will no longer repeat\))?$/i.test(text),informational=/Download the React DevTools|preloaded using link preload but not used within a few seconds/.test(text);warnings.push({text,material:!readback&&!informational,performanceWarning:readback});}});
  page.on('pageerror',error=>pageErrors.push(String(error)));page.on('request',request=>{if(request.url().startsWith('http')&&new URL(request.url()).origin!==new URL(baseURL).origin)externalRequests.push({url:request.url(),method:request.method()});});
  await page.goto(baseURL,{waitUntil:'domcontentloaded',timeout:180_000});await settled();
  check((await metrics()).state.catalogRef.catalogVersion===proof.catalogVersion,'BROWSER_LAUNCH_CATALOG_STALE');
  await page.evaluate(()=>window.__PAX_OPERATIONAL_DEBUG__.selectCountryDetail('CHN'));await page.locator('aside.panel .panel-kicker').filter({hasText:/CHN/}).waitFor();
  const countryName=(await page.locator('#country-title').innerText()).trim();await page.getByRole('button',{name:`${countryName}을(를) 플레이 국가로 선택`,exact:true}).click();await page.locator('[data-testid="game-screen"]').waitFor({state:'visible',timeout:180_000});
  await page.waitForFunction(()=>!!window.__PAX_OPERATIONAL_DEBUG__,null,{timeout:180_000});
  await page.evaluate(()=>{const debug=window.__PAX_OPERATIONAL_DEBUG__;debug.selectCountryDetail(null);debug.setDebugBoundaries(false);debug.jumpTo([125,40.5],6.4);});await settled();
  const initial=await metrics();check(initial.state.revision===0&&initial.frontIds.length===0,'FRESH_GAME_FRONT_NOT_EMPTY');report.initial={state:initial.state,stats:initial.stats};await capture('fresh-chn-game');
  const firstIds=[];
  for(let turn=0;turn<2;turn++){
    assertSafeLaunch();check((await metrics()).state.catalogRef.catalogVersion===proof.catalogVersion,'CATALOG_CHANGED_BEFORE_ADVANCE');
    const overlay=page.locator('.game-action-overlay');if(!await overlay.isVisible())await page.locator('[data-menu-kind="action"]').click();
    await page.locator('#game-player-action').fill('[DEBUG_WORLD_EFFECT] 북한과 공유하는 현재 육상 전선에 인접한 제한된 범위를 점령한다');await page.getByRole('button',{name:'대기열에 추가',exact:true}).click();await page.getByRole('button',{name:'1일',exact:true}).click();
    await page.waitForFunction(()=>document.querySelector('.action-queue')?.textContent?.includes('[DEBUG_WORLD_EFFECT]'));
    const before=await metrics();await page.evaluate(()=>{performance.clearResourceTimings();window.__CHN_BROWSER_PLAY_METRICS__.longTasks=[];});
    const readResponse=page.waitForResponse(response=>{if(!response.url().endsWith('/api/simulation/game')||response.status()!==200)return false;try{return response.request().postDataJSON()?.operation==='read';}catch{return false;}},{timeout:180_000});
    const began=performance.now();assertSafeLaunch();await page.getByRole('button',{name:'진행 시작',exact:true}).click();
    const response=await readResponse,result=await response.json();await page.waitForFunction(()=>['committed','failed','cancelled'].includes(document.querySelector('.turn-status')?.getAttribute('data-phase')),null,{timeout:180_000});
    const phase=await page.locator('.turn-status').getAttribute('data-phase');check(phase==='committed',`ACTUAL_UI_TURN_${phase}:${await page.locator('.turn-status').getAttribute('data-error-code')}`);const committedMs=performance.now()-began;await settled();const renderedMs=performance.now()-began;
    const after=await metrics(),changed=result.snapshot?.stateChange?.cells??[];check(changed.length>0&&changed.length<=512,'SCRIPTED_TURN_HAS_NO_BOUNDED_MAP_DELTA');check(after.state.revision===before.state.revision+1,'WORLD_REVISION_DID_NOT_ADVANCE_ONCE');
    const ids=changed.map(c=>c.id);check(new Set(ids).size===ids.length,'DUPLICATE_CHANGED_CELLS');
    for(const cell of changed)check(cell.before.sourceCountryId==='PRK'&&cell.after.sourceCountryId==='PRK'&&cell.before.ownerCountryId==='PRK'&&cell.after.ownerCountryId==='PRK'&&cell.before.controllerCountryId==='PRK'&&cell.after.controllerCountryId==='CHN','OWNER_CONTROLLER_OR_TARGET_SCOPE_VIOLATION');
    check(changed.length<before.state.controlCounts.PRK.owned,'WHOLE_PRK_OCCUPATION');check(after.state.controlCounts.PRK.owned===initial.state.controlCounts.PRK.owned,'PRK_OWNERSHIP_CHANGED');check(after.state.controlCounts.CHN.controlled-before.state.controlCounts.CHN.controlled===changed.length,'CONTROL_COUNTS_DO_NOT_MATCH_DELTA');
    const areaKm2=ids.reduce((n,id)=>n+local.metrics.get(id).areaKm2,0);check(areaKm2<=2800,'FRONTIER_AREA_CAP_EXCEEDED');
    if(turn===0){check(connectedToSupport(ids,chnRows.map(row=>row[1])),'FIRST_ENTRY_LACKS_ACTUAL_LAND_ADJACENCY');firstIds.push(...ids);}else{check(ids.every(id=>!firstIds.includes(id)),'FOLLOWUP_REUSES_ALREADY_OCCUPIED_CELLS');check(connectedToSupport(ids,firstIds),'FOLLOWUP_DOES_NOT_ADVANCE_FROM_OCCUPIED_FRONT');}
    check(!after.stats.resyncRequired&&after.stats.fullProjectionBuilds===initial.stats.fullProjectionBuilds,'TURN_REBUILT_OR_INVALIDATED_WHOLE_MAP_PROJECTION');
    const record={condition:turn===0?'cold-turn':'warm-followup-turn',committedMs,renderedMs,revisionBefore:before.state.revision,revisionAfter:after.state.revision,changedCellIds:ids,areaKm2,ownershipPreserved:true,currentControlAdjacency:true,resources:after.resources,longTasks:after.longTasks,longTaskTotalMs:after.longTasks.reduce((n,t)=>n+t.duration,0),memory:after.memory,updateStats:after.stats,controlCounts:{CHN:after.state.controlCounts.CHN,PRK:after.state.controlCounts.PRK},exactCells:summarize(after.exactCellIds),frontIds:summarize(after.frontIds)};
    const position=local.metrics.get(ids[0]).centroid;await page.evaluate(center=>window.__PAX_OPERATIONAL_DEBUG__.jumpTo(center,7),position);await settled();
    const front=await metrics();check(front.frontIds.length>0&&front.renderedFront.length>0,'ACTUAL_GOLD_FRONT_NOT_RENDERED');check(front.frontLayer?.paint?.['line-color']==='#D9A43C','FRONT_COLOR_CHANGED');record.front={camera:position,sourceIds:summarize(front.frontIds),renderedIds:summarize(front.renderedFront.map(f=>f.id)),layer:front.frontLayer};turns.push(record);await capture(`turn-${turn+1}-gold-front-normal`);
    await page.evaluate(()=>window.__PAX_OPERATIONAL_DEBUG__.setDebugBoundaries(true));await settled();await capture(`turn-${turn+1}-gold-front-debug`);await page.evaluate(()=>window.__PAX_OPERATIONAL_DEBUG__.setDebugBoundaries(false));
    while(await page.locator('.game-major-event__acknowledge').isVisible())await page.locator('.game-major-event__acknowledge').click();
    console.log(JSON.stringify({turn:turn+1,changed:ids.length,areaKm2,committedMs,renderedMs,goldFrontFeatures:front.renderedFront.length}));
  }
  report.final={state:(await metrics()).state};check(turns.length===2,'TWO_REAL_TURNS_REQUIRED');
}catch(error){failures.push({message:error instanceof Error?error.message:String(error),stack:error instanceof Error?error.stack:null});if(page)try{await capture('failure');}catch{}}
finally{
  if(context)try{await context.close();}catch(error){failures.push({message:String(error)});}if(browser)try{await browser.close();}catch(error){failures.push({message:String(error)});}
  if(consoleErrors.length||pageErrors.length||warnings.some(w=>w.material)||externalRequests.length)failures.push({message:'BROWSER_ERRORS_OR_MATERIAL_WARNINGS_OR_EXTERNAL_REQUESTS'});
  report.pass=failures.length===0;report.elapsedMs=performance.now()-started;report.code=pin('scripts/chn-2020/verify-browser-play.mjs');const output=path.join(outputRoot,'verification.json');fs.writeFileSync(output,`${JSON.stringify(report,null,2)}\n`);console.log(JSON.stringify({pass:report.pass,report:output,turns:turns.map(t=>({condition:t.condition,changedCells:t.changedCellIds.length,committedMs:t.committedMs,renderedMs:t.renderedMs})),failures:failures.map(f=>f.message)}));if(!report.pass)process.exitCode=1;
}
