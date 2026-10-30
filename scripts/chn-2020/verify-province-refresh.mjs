// Tests Fast Refresh with the existing game client; full reload/new game fails.
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {chromium} from '@playwright/test';
const root='reports/chn-province-20261030/browser',base='http://127.0.0.1:3001',signal='.tmp/province-presentation-activate';
if(fs.existsSync(signal))throw Error('REMOVE_OLD_ACTIVATION_SIGNAL_FIRST');
const report={pass:false,gameStarts:0,mapBootstraps:0,pageErrors:[],externalAiCalls:0};
const browser=await chromium.launch({headless:true,args:['--enable-unsafe-swiftshader']});
const context=await browser.newContext({viewport:{width:1440,height:900},locale:'ko-KR'});let ownSession;
try{
 await context.route('**/*',async r=>{const u=new URL(r.request().url());if(u.origin!==base||u.pathname==='/api/simulation/turn')return r.abort();await r.continue();});
 const page=await context.newPage();page.on('pageerror',e=>report.pageErrors.push(e.message));
 page.on('response',async r=>{if(r.url()===base+'/api/world/catalog/operational/map'&&r.ok())report.mapBootstraps++;if(r.url()===base+'/api/simulation/game'&&r.request().method()==='POST'&&r.ok()){report.gameStarts++;ownSession=(await r.json()).sessionId;}});
 const settled=()=>page.waitForFunction(()=>window.__PAX_OPERATIONAL_DEBUG__?.isRenderSettled(),null,{timeout:180000,polling:100});
 await page.goto(base,{waitUntil:'domcontentloaded',timeout:180000});await settled();
 await page.evaluate(()=>{const d=window.__PAX_OPERATIONAL_DEBUG__;d.selectCountryDetail('CHN');d.setDebugBoundaries(false);d.jumpTo([112,31],6);});await settled();
 report.before=await page.evaluate(()=>window.__PAX_OPERATIONAL_DEBUG__.getState());
 const firstSession=ownSession,firstBootstraps=report.mapBootstraps;
 console.log('READY_FOR_COMPONENT_PRESENTATION_UPDATE');
 const start=Date.now();while(!fs.existsSync(signal)){if(Date.now()-start>180000)throw Error('ACTIVATION_TIMEOUT');await new Promise(r=>setTimeout(r,200));}
 const updated=Date.now();while(report.mapBootstraps<=firstBootstraps){if(Date.now()-updated>90000)throw Error('BOOTSTRAP_NOT_REFRESHED');await new Promise(r=>setTimeout(r,200));}
 await settled();report.after=await page.evaluate(()=>window.__PAX_OPERATIONAL_DEBUG__.getState());
 report.sameSession=ownSession===firstSession;report.sessionIdHash=createHash('sha256').update(firstSession).digest('hex');
 if(!report.sameSession||report.gameStarts!==1||report.pageErrors.length||JSON.stringify(report.before.catalogRef)!==JSON.stringify(report.after.catalogRef)||report.before.revision!==report.after.revision||report.before.simulationRevision!==report.after.simulationRevision||report.after.selectedCountryId!=='CHN')throw Error('GAME_OR_SELECTION_RESET_DURING_PRESENTATION_REFRESH');
 report.pass=true;
}catch(e){report.error=e.stack||String(e);process.exitCode=1;}finally{if(ownSession)report.cleanupStatus=(await context.request.delete(base+'/api/simulation/game',{headers:{'X-Pax-Game':ownSession}})).status();await browser.close();fs.writeFileSync(`${root}/same-game-refresh.json`,JSON.stringify(report,null,2)+'\n');}
