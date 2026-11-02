// Isolated local browser evidence for CHN province-line presentation only.
// No existing tab is attached and no AI turn or game command is submitted.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {chromium} from '@playwright/test';

const option=name=>{const i=process.argv.indexOf(name);if(i<0)return null;const value=process.argv[i+1];if(!value||value.startsWith('--'))throw Error(`MISSING_ARGUMENT:${name}`);return value;};
const phase=option('--phase');if(!['before','after'].includes(phase))throw Error('USE_PHASE_BEFORE_OR_AFTER');
const base=new URL(option('--url')??'http://127.0.0.1:3001');
if(base.protocol!=='http:'||!['127.0.0.1','localhost','[::1]'].includes(base.hostname)||base.port!=='3001')throw Error('ISOLATED_LOCAL_QA_PORT_3001_REQUIRED');
const root=path.resolve('reports/chn-render-lod-20261030/browser');fs.mkdirSync(root,{recursive:true});
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const pin=file=>{const bytes=fs.readFileSync(file);return{path:path.relative(process.cwd(),path.resolve(file)).replaceAll('\\','/'),sha256:digest(bytes),byteLength:bytes.length};};
const read=file=>JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,''));
const pointerFile='data/runtime/operational-catalog/current.json',pointer=read(pointerFile),pointerPin=pin(pointerFile);
const code=['scripts/chn-2020/verify-province-line-lod-browser.mjs','src/components/map/OperationalWorldMap.tsx',
 'src/lib/map/operational-map-consumer.ts','src/lib/map/operational-map-sources.ts','src/lib/map/operational-vector-delivery.ts',
 'src/lib/map/operational-delivery.server.ts','src/lib/map/operational-delivery-contract.ts','src/lib/map/operational-boundary-style.ts'].map(pin);
const WHITE=['operational-administrative-border','operational-detail-administrative-border','operational-province-original','operational-detail-province-original','operational-province-display-lod'];
const LOD='operational-province-display-lod',ORIGINAL=['operational-province-original','operational-detail-province-original'];
const report={schemaVersion:'chn-province-line-lod-browser-v1',phase,pass:false,pointer:pointerPin,code,
 conditions:{url:base.origin,viewport:{width:1440,height:900},deviceScaleFactor:1,browser:'fresh isolated Chromium; software WebGL permitted',httpCache:'disabled by interception; application immutable caches remain active',serverAndOSCache:'not flushed',externalAiCalls:0,turnsSubmitted:0,limitation:'Stroke LOD only. Authoritative fill polygons, gameplay cells and base PBF transport stay unchanged. Timings/heap are diagnostics, not a matched full-game FPS claim.'},
 views:[],screenshots:[],requests:[],consoleErrors:[],pageErrors:[],failedRequests:[],failures:[],cleanup:[]};
const check=(ok,message)=>{if(!ok)throw Error(message);};
const summarize=ids=>{const values=[...new Set(ids.map(Number))].sort((a,b)=>a-b);return{count:values.length,sha256:digest(JSON.stringify(values)),sample:values.slice(0,24)};};
function preserve(file){if(!fs.existsSync(file))return;const old=pin(file),dir=path.join(root,'archive');fs.mkdirSync(dir,{recursive:true});const target=path.join(dir,`${path.basename(file,path.extname(file))}-${old.sha256}${path.extname(file)}`);if(!fs.existsSync(target))fs.copyFileSync(file,target);}
let browser,context,page,bootstrap,lodPath,currentCase='initial',ownSessions=new Set();
const responseReads=[],started=performance.now();
const lodRequests=()=>report.requests.filter(r=>lodPath&&new URL(r.url).pathname===lodPath);
async function settled(){await page.waitForFunction(()=>window.__PAX_OPERATIONAL_DEBUG__?.isRenderSettled(),null,{timeout:180000,polling:100});await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));}
async function leave(){await page.mouse.move(1430,10);await page.waitForFunction(()=>window.__PAX_OPERATIONAL_DEBUG__?.getState().hoveredCountryId===null,null,{timeout:15000});}
async function camera(center,zoom){await page.evaluate(({center,zoom})=>window.__PAX_OPERATIONAL_DEBUG__.jumpTo(center,zoom),{center,zoom});await settled();}
async function expectLod(active){if(phase!=='after')return;await page.waitForFunction(expected=>window.__PAX_OPERATIONAL_DEBUG__?.getUpdateStats()?.provinceDisplayLodActive===expected,active,{timeout:30000,polling:100});await settled();}
async function hover(position,country){const local=await page.evaluate(p=>window.__PAX_OPERATIONAL_DEBUG__.project(p),position),box=await page.locator('canvas.maplibregl-canvas').boundingBox();check(box&&local[0]>=0&&local[1]>=0&&local[0]<box.width&&local[1]<box.height,'HOVER_POINT_OUTSIDE_CANVAS');await page.mouse.move(box.x+local[0],box.y+local[1],{steps:2});await page.waitForFunction(id=>window.__PAX_OPERATIONAL_DEBUG__?.getState().hoveredCountryId===id,country,{timeout:15000});await settled();}
async function view(name,{expectLodActive=false,expectProvince=false,screenshot=true}={}){
 currentCase=name;await expectLod(expectLodActive);
 const data=await page.evaluate(({white,lod,original})=>{const d=window.__PAX_OPERATIONAL_DEBUG__,s=d.getState();return{
  state:{catalogRef:s.catalogRef,revision:s.revision,simulationRevision:s.simulationRevision,hoveredCountryId:s.hoveredCountryId,selectedCountryId:s.selectedCountryId,debugBoundaries:s.debugBoundaries,detailStatus:s.detailStatus},
  center:d.getCenter(),zoom:d.getZoom(),stats:d.getUpdateStats(),white:d.queryRenderedFeatures({layers:white}),micro:d.queryRenderedFeatures({layers:['operational-cell-grid','operational-detail-cell-grid','operational-micro-original','operational-detail-micro-original','operational-micro-display-lod'].filter(id=>d.getLayerState(id)!==null)}),
  exactCells:d.querySourceFeatureIds('world-operational-exact-cells'),exactEdges:d.querySourceFeatureIds('world-operational-exact-edges'),
  layerStates:[lod,...original].map(id=>d.getLayerState(id)),
  fills:d.queryRenderedFillIds().map(f=>f.id),
  heap:performance.memory?{usedJSHeapSize:performance.memory.usedJSHeapSize,totalJSHeapSize:performance.memory.totalJSHeapSize}:null,
 };},{white:WHITE,lod:LOD,original:ORIGINAL});
 check(data.state.catalogRef.catalogVersion===pointer.catalogVersion&&data.state.revision===0&&data.state.simulationRevision===0,`${name}:GAME_CHANGED`);
 check(!data.stats.resyncRequired&&data.stats.fullProjectionBuilds===1,`${name}:MAP_REBUILT_OR_INVALID`);
 const ids=new Set(bootstrap.provincePresentationBoundaryOrdinals),province=data.white.filter(f=>ids.has(Number(f.id))),lod=province.filter(f=>f.layerId===LOD),original=province.filter(f=>f.layerId!==LOD);
 const lodIds=new Set(lod.map(f=>Number(f.id))),duplicates=[...new Set(original.map(f=>Number(f.id)))].filter(n=>lodIds.has(n));
 check(duplicates.length===0,`${name}:LOD_AND_ORIGINAL_DRAW_SAME_EDGE:${duplicates.slice(0,12)}`);
 if(expectProvince)check(province.length>0,`${name}:PROVINCE_BOUNDARIES_MISSING`);
 if(!data.state.debugBoundaries)check(data.micro.length===0,`${name}:MICRO_VISIBLE_IN_NORMAL_MODE`);
 if(phase==='after'){
  check(typeof data.stats.provinceDisplayLodReady==='boolean'&&typeof data.stats.provinceDisplayLodActive==='boolean','LOD_DIAGNOSTICS_MISSING');
  check(data.stats.provinceDisplayLodActive===expectLodActive,`${name}:LOD_ACTIVITY_MISMATCH`);
  if(expectLodActive){check(data.stats.provinceDisplayLodReady&&data.stats.provinceDisplayLodVertexCount>0&&lod.length>0,`${name}:READY_LOD_NOT_RENDERED`);check(original.length===0,`${name}:ORIGINAL_VISIBLE_WHILE_LOD_ACTIVE`);}
  else check(lod.length===0,`${name}:LOD_VISIBLE_OUTSIDE_ZOOM_OR_COUNTRY`);
 }
 const record={...data,name,white:summarize(data.white.map(f=>f.id)),provinceWhite:summarize(province.map(f=>f.id)),lodWhite:summarize(lod.map(f=>f.id)),originalWhite:summarize(original.map(f=>f.id)),
  whiteByLayer:Object.fromEntries([...new Set(data.white.map(f=>f.layerId))].map(id=>[id,summarize(data.white.filter(f=>f.layerId===id).map(f=>f.id))])),micro:summarize(data.micro.map(f=>f.id)),fills:summarize(data.fills),exactCells:summarize(data.exactCells),exactEdges:summarize(data.exactEdges),lodRequestCount:lodRequests().length};
 report.views.push(record);
 if(screenshot){const file=path.join(root,`${phase}-${name}.png`);preserve(file);await page.screenshot({path:file});report.screenshots.push(pin(file));}
 console.log(JSON.stringify({phase,name,province:record.provinceWhite.count,lod:record.lodWhite.count,original:record.originalWhite.count,active:data.stats.provinceDisplayLodActive??false,sourceWrites:data.stats.provinceDisplayLodSourceWrites??0}));
 return record;
}

try{
 browser=await chromium.launch({headless:true,args:['--enable-unsafe-swiftshader','--enable-precise-memory-info']});
 context=await browser.newContext({viewport:report.conditions.viewport,deviceScaleFactor:1,locale:'ko-KR',reducedMotion:'reduce'});
 await context.route('**/*',async route=>{const request=route.request(),u=new URL(request.url());if(((u.protocol==='http:'||u.protocol==='https:')&&u.origin!==base.origin)||u.pathname.startsWith('/api/simulation/turn')){report.failures.push({message:'EXTERNAL_OR_TURN_FORBIDDEN',url:u.href});await route.abort();return;}if(u.pathname==='/api/simulation/game'&&request.method()==='POST'){let operation;try{operation=request.postDataJSON()?.operation;}catch{}if(operation!=='start'){report.failures.push({message:'GAME_COMMAND_FORBIDDEN',operation});await route.abort();return;}}await route.continue();});
 page=await context.newPage();page.on('request',r=>report.requests.push({case:currentCase,url:r.url(),method:r.method()}));page.on('pageerror',e=>report.pageErrors.push(e.message));page.on('console',m=>{if(m.type()==='error')report.consoleErrors.push(m.text());});page.on('requestfailed',r=>report.failedRequests.push({url:r.url(),reason:r.failure()?.errorText}));
 page.on('response',r=>{if(r.url()===base.origin+'/api/simulation/game'&&r.request().method()==='POST'&&r.ok())responseReads.push(r.json().then(body=>{if(typeof body.sessionId==='string')ownSessions.add(body.sessionId);}).catch(e=>report.failures.push({message:'SESSION_CAPTURE_FAILED',error:String(e)})));});
 const navigation=performance.now();await page.goto(base.origin,{waitUntil:'domcontentloaded',timeout:180000});await settled();report.mapReadyWallMs=performance.now()-navigation;await Promise.all(responseReads);check(ownSessions.size===1,'EXPECTED_ONE_OWN_GAME');
 const response=await context.request.get(base.origin+'/api/world/catalog/operational/map');check(response.ok(),'BOOTSTRAP_HTTP');bootstrap=await response.json();
 check(bootstrap.catalog.catalogRef.catalogVersion===pointer.catalogVersion&&bootstrap.provincePresentationBoundaryOrdinals?.length===994,'CATALOG_OR_PROVINCE_SET_CHANGED');
 lodPath=bootstrap.provinceBoundaryLod?.artifact.path;
 if(phase==='after')check(typeof lodPath==='string'&&/^\/data\/territory-catalog\/[^/]+\/display\/chn-province-lines-[a-f0-9]{64}\.geojson\.gz$/.test(lodPath),'LOD_ARTIFACT_DESCRIPTOR_MISSING');
 report.bootstrap={catalogRef:bootstrap.catalog.catalogRef,provinceCount:994,lod:bootstrap.provinceBoundaryLod??null};
 await leave();await page.evaluate(()=>window.__PAX_OPERATIONAL_DEBUG__.setDebugBoundaries(false));
 await camera([-100,40],4.2);await view('us-before-china',{screenshot:false});if(phase==='after')check(lodRequests().length===0,'CHINA_GEOMETRY_LOADED_IN_US_VIEW');
 await camera([105,34],1.7);await view('world-overview',{screenshot:false});if(phase==='after')check(lodRequests().length===0,'CHINA_LOD_LOADED_BELOW_MIN_ZOOM');
 await camera([118,31],5);const east=await view('east-china',{expectLodActive:phase==='after',expectProvince:true});
 await camera([105,34],4.2);await view('china',{expectLodActive:phase==='after',expectProvince:true});
 await camera([125,40.5],6.5);await view('border',{expectLodActive:phase==='after',expectProvince:true});
 const warmRequests=lodRequests().length,warmWrites=east.stats.provinceDisplayLodSourceWrites;
 await camera([118.7,31.2],5.2);await view('warm-pan',{expectLodActive:phase==='after',expectProvince:true,screenshot:false});
 await camera([118,31],5);const warm=await view('warm-return',{expectLodActive:phase==='after',expectProvince:true,screenshot:false});
 if(phase==='after'){check(lodRequests().length===warmRequests,'WARM_CAMERA_REFETCHES_LOD');check(warm.stats.provinceDisplayLodSourceWrites===warmWrites,'WARM_CAMERA_REWRITES_LOD_SOURCE');}
 await camera([120,31],7.3);await view('shanghai-high-original',{expectProvince:true});
 await page.evaluate(()=>window.__PAX_OPERATIONAL_DEBUG__.setDebugBoundaries(true));await hover([121.47,31.23],'CHN');
 await page.waitForFunction(()=>window.__PAX_OPERATIONAL_DEBUG__?.getUpdateStats()?.selectedDetailCells>0,null,{timeout:30000});await settled();const exact=await view('debug-high-exact-original',{expectProvince:true});
 check(exact.exactCells.count>0&&exact.micro.count>0,'HIGH_DEBUG_EXACT_NOT_EXERCISED');
 await leave();await camera([118,31],6.5);await view('return-low-after-exact',{expectLodActive:phase==='after',expectProvince:true});
 await page.evaluate(()=>window.__PAX_OPERATIONAL_DEBUG__.setDebugBoundaries(false));await settled();
 await camera([-100,40],4.2);await view('us-after-china',{screenshot:false});
 await camera([118,31],5);const final=await view('final-low',{expectLodActive:phase==='after',expectProvince:true,screenshot:false});
 if(phase==='after'){check(lodRequests().length===warmRequests,'RETURN_AFTER_HIGH_ZOOM_REFETCHES_LOD');check(final.stats.provinceDisplayLodSourceWrites===warmWrites,'RETURN_AFTER_HIGH_REWRITES_LOD_SOURCE');}
 report.warmReuse={requestsBefore:warmRequests,requestsAfter:lodRequests().length,sourceWritesBefore:warmWrites??null,sourceWritesAfter:final.stats.provinceDisplayLodSourceWrites??null};
 report.resources=await page.evaluate(()=>performance.getEntriesByType('resource').map(r=>({name:r.name,duration:r.duration,transferSize:r.transferSize,encodedBodySize:r.encodedBodySize,decodedBodySize:r.decodedBodySize})));
}catch(error){report.failures.push({message:error instanceof Error?error.message:String(error),stack:error instanceof Error?error.stack:null});}
finally{
 await Promise.all(responseReads);
 for(const id of ownSessions){try{const r=await context.request.delete(base.origin+'/api/simulation/game',{headers:{'X-Pax-Game':id}});report.cleanup.push({sessionIdSha256:digest(id),status:r.status()});check(r.status()===204,'OWN_SESSION_DELETE_FAILED');}catch(e){report.failures.push({message:'OWN_SESSION_CLEANUP_FAILED',error:String(e)});}}
 report.lodRequests=lodRequests();report.fullCountryGeometryRequests=report.requests.filter(r=>/\/detail\/countries\/[A-Z]{3}\.geojson\.gz(?:$|\?)/.test(r.url));
 if(report.fullCountryGeometryRequests.length)report.failures.push({message:'FULL_COUNTRY_GEOMETRY_REQUEST',count:report.fullCountryGeometryRequests.length});
 if(report.consoleErrors.length||report.pageErrors.length)report.failures.push({message:'BROWSER_ERRORS',consoleErrors:report.consoleErrors.length,pageErrors:report.pageErrors.length});
 const unexpected=report.failedRequests.filter(r=>!/ERR_ABORTED/.test(r.reason??''));if(unexpected.length)report.failures.push({message:'UNEXPECTED_FAILED_REQUESTS',requests:unexpected});
 for(const expected of [pointerPin,...code]){const actual=pin(expected.path);if(actual.sha256!==expected.sha256||actual.byteLength!==expected.byteLength)report.failures.push({message:'SOURCE_CHANGED_DURING_PHASE',path:expected.path});}
 if(context)await context.close();if(browser)await browser.close();
 report.elapsedMs=performance.now()-started;report.pass=report.failures.length===0;const file=path.join(root,`${phase}.json`);preserve(file);fs.writeFileSync(file,JSON.stringify(report,null,2)+'\n');
 console.log(JSON.stringify({phase,pass:report.pass,artifact:pin(file),views:report.views.length,lodRequests:report.lodRequests.length,failures:report.failures.map(f=>f.message)}));if(!report.pass)process.exitCode=1;
}
