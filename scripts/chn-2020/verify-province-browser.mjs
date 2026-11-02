// Isolated browser; never attaches a user's tab or submits a turn.
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {chromium} from '@playwright/test';
const phase=process.argv[2];
if(!['before','after'].includes(phase)) throw Error('USE_BEFORE_OR_AFTER');
const root='reports/chn-province-20261030/browser', base=process.argv[3]??'http://127.0.0.1:3002';
if(!/^http:\/\/127\.0\.0\.1:300[12]$/.test(base))throw Error('LOCAL_QA_URL_ONLY');
fs.mkdirSync(root,{recursive:true});
const pin=file=>{const b=fs.readFileSync(file);return{path:file,sha256:createHash('sha256').update(b).digest('hex'),byteLength:b.length};};
const pointer=JSON.parse(fs.readFileSync('data/runtime/operational-catalog/current.json'));
const report={phase,pass:false,baseURL:base,pointer:pin('data/runtime/operational-catalog/current.json'),viewport:{width:1440,height:900},deviceScaleFactor:1,conditions:'fresh isolated Chromium; HTTP cache disabled; server/OS cache retained; software WebGL permitted; no turns/AI',requests:[],errors:[],views:[]};
const browser=await chromium.launch({headless:true,args:['--enable-unsafe-swiftshader','--enable-precise-memory-info']});
let context, ownSession;
try{
 context=await browser.newContext({viewport:report.viewport,deviceScaleFactor:1,locale:'ko-KR',reducedMotion:'reduce'});
 await context.route('**/*',async route=>{const u=new URL(route.request().url());if(u.origin!==base||/\/api\/simulation\/turn(?:$|\?)/.test(u.href))throw Error('FORBIDDEN_REQUEST:'+u.href);await route.continue();});
 const page=await context.newPage();page.on('pageerror',e=>report.errors.push(e.message));page.on('request',r=>report.requests.push(r.url()));
 page.on('response',async r=>{if(r.url()===base+'/api/simulation/game'&&r.request().method()==='POST'&&r.ok()){const b=await r.json();if(b.sessionId)ownSession=b.sessionId;}});
 const settle=()=>page.waitForFunction(()=>window.__PAX_OPERATIONAL_DEBUG__?.isRenderSettled(),null,{timeout:180000,polling:100});
 const start=performance.now();await page.goto(base,{waitUntil:'domcontentloaded',timeout:180000});await settle();report.mapReadyMs=performance.now()-start;
 const bootstrap=await (await context.request.get(base+'/api/world/catalog/operational/map')).json();
 report.normalBoundaryCount=bootstrap.legacyBoundaryOrdinals.length;
 report.provinceBoundaryCount=bootstrap.provincePresentationBoundaryOrdinals?.length??0;report.provincePresentationRoot=bootstrap.provincePresentationRoot??null;
 for(const [name,center,zoom,debug,select] of [['world',[105,30],1.7,false,null],['china',[105,34],4.2,false,null],['central',[112,31],6,false,null],['coast',[120.5,30.8],6.6,false,null],['hainan',[109.7,19.2],7.2,false,null],['korea-border',[125,40.5],7.3,false,null],['central-debug',[112,31],6,true,null],['exact-province',[113.8,29.8],7.3,true,'CHN']]){
  await page.evaluate(({center,zoom,debug,select})=>{const d=window.__PAX_OPERATIONAL_DEBUG__;d.selectCountryDetail(select);d.setDebugBoundaries(debug);d.jumpTo(center,zoom);},{center,zoom,debug,select});await settle();
  const data=await page.evaluate(()=>{const d=window.__PAX_OPERATIONAL_DEBUG__;return{state:d.getState(),stats:d.getUpdateStats(),white:d.queryRenderedFeatures({layers:['operational-administrative-border','operational-detail-administrative-border']}),fine:d.queryRenderedFeatures({layers:['operational-cell-grid','operational-detail-cell-grid']}),normal:d.getLayerState('operational-administrative-border'),debug:d.getLayerState('operational-cell-grid')};});
  if(data.state.catalogRef.catalogVersion!==pointer.catalogVersion||data.state.revision!==0||data.state.simulationRevision!==0||data.stats.resyncRequired)throw Error('STATE_CHANGED');
  const provinceSet=new Set(bootstrap.provincePresentationBoundaryOrdinals??[]);
  data.provinceWhiteFeatures=data.white.filter(f=>provinceSet.has(Number(f.id))).length;
  if(!debug&&data.fine.length)throw Error('MICRO_BOUNDARIES_VISIBLE_IN_NORMAL_MODE');
  if(phase==='after'&&['central','coast','exact-province'].includes(name)&&!data.provinceWhiteFeatures)throw Error('PROVINCE_BOUNDARIES_NOT_VISIBLE:'+name);
  if(data.fine.some(f=>provinceSet.has(Number(f.id))))throw Error('PROVINCE_EDGE_ALSO_DRAWN_AS_MICRO');
  const file=`${root}/${phase}-${name}.png`;await page.screenshot({path:file});report.views.push({name,center,zoom,debug,selected:select,...data,screenshot:pin(file)});
  console.log(JSON.stringify({phase,name,white:data.white.length,fine:data.fine.length,detailCells:data.stats.selectedDetailCells}));
 }
 report.fullChinaDetailRequests=report.requests.filter(x=>x.endsWith('/detail/countries/CHN.geojson.gz')).length;
 if(report.fullChinaDetailRequests||report.errors.length)throw Error('BROWSER_ERRORS_OR_FULL_CHINA_REQUEST');
 if(phase==='after'&&!report.provinceBoundaryCount)throw Error('NEW_PROVINCE_BOOTSTRAP_MISSING');
 report.pass=true;
}catch(e){report.errors.push(e.stack||String(e));process.exitCode=1;}finally{
 if(ownSession&&context){const r=await context.request.delete(base+'/api/simulation/game',{headers:{'X-Pax-Game':ownSession}});report.ownSessionCleanupStatus=r.status();}
 await browser.close();fs.writeFileSync(`${root}/${phase}.json`,JSON.stringify(report,null,2)+'\n');
}
