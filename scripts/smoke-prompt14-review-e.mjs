import fs from 'node:fs';import path from 'node:path';import {chromium} from 'playwright';
import {digest,jsonBytes,writeArtifact,assertBuildOutput} from './prompt14-catalog-core.mjs';
const server=process.argv[2],output=path.resolve(process.argv[3]??'.tmp/prompt14-review-e/browser');
if(!server||!['localhost','127.0.0.1'].includes(new URL(server).hostname))throw Error('Explicit local production server required');
assertBuildOutput(process.cwd(),output);fs.mkdirSync(output,{recursive:true});
const browser=await chromium.launch({headless:true,args:['--enable-unsafe-swiftshader']}),page=await browser.newPage({viewport:{width:1440,height:900}});
const errors=[],phases=[],turns=[];let stage='ground',status='fail',error=null,ids=[],hungarianIds=[],mergedIds=[];
page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
const assert=(v,message)=>{if(!v)throw Error(message);};
const ready=()=>page.waitForFunction(()=>window.__PAX_CATALOG_DEBUG__?.ready()&&document.querySelector('[data-testid="world-map"]')?.getAttribute('data-map-status')==='ready',null,{timeout:60000});
const snapshot=()=>page.evaluate(()=>window.__PAX_CATALOG_DEBUG__.getSnapshot());
const resetCalls=()=>page.evaluate(()=>{window.__reviewECalls=[];});
const calls=()=>page.evaluate(()=>window.__reviewECalls);
const openAction=async()=>{if(!await page.getByRole('button',{name:'진행 시작',exact:true}).isVisible())await page.getByRole('button',{name:'국가 행동',exact:true}).click();};
const turn=async(name,date,fail=false)=>{stage=name;await openAction();await resetCalls();const before=await snapshot();await page.getByLabel('목표 날짜 직접 입력').fill(date);await page.getByRole('checkbox',{name:'행동 없이 시간만 진행'}).check();await page.getByRole('button',{name:'진행 시작',exact:true}).click();await page.waitForFunction(phase=>document.querySelector('.turn-status')?.getAttribute('data-phase')===phase,fail?'failed':'committed',{timeout:20000});await ready();return {before,after:await snapshot(),calls:await calls()};};
const capture=async(name,player,measurement={})=>{
  await page.waitForFunction(id=>window.__PAX_CATALOG_DEBUG__.getSnapshot().uiPlayerCountryId===id&&document.querySelector('.game-player-badge__code')?.textContent===id,player);
  const s=await snapshot(),highlight=await page.evaluate(()=>window.__PAX_CATALOG_DEBUG__.inspectMap().getFilter('catalog-player-highlight'));
  const expected=player==='HUN'?hungarianIds:mergedIds;
  assert(s.playerCountryId===player&&s.uiPlayerCountryId===player,`${name}: simulation/UI player mismatch`);
  assert(JSON.stringify([...highlight[2][1]].sort())===JSON.stringify([...expected].sort()),`${name}: player territory highlight mismatch`);
  assert(new URL(page.url()).hash==='#player=HUN',`${name}: initial hash changed`);
  assert((await page.locator('.app-shell').getAttribute('data-world-country-count'))===(player==='HUN'?'247':'246'),`${name}: country retirement mismatch`);
  assert(!await page.getByText('게임 세계를 초기화하는 중입니다').isVisible(),`${name}: initialization stuck`);
  phases.push({phase:name,...measurement,snapshot:s,hud:await page.locator('.game-player-badge').innerText(),highlightTerritoryIds:highlight[2][1],wholeSourceSetDataCalls:(measurement.calls??[]).filter(c=>c.method==='setData').length});
  if(await page.getByRole('button',{name:'진행 시작',exact:true}).isVisible())await page.getByRole('button',{name:'국가 행동',exact:true}).click();
  await page.screenshot({path:path.join(output,`${name}.png`),animations:'disabled'});
};
try{
  await page.goto(`${server}/game#player=HUN`,{waitUntil:'domcontentloaded'});await ready();
  const bootstrap=await (await page.request.get(`${server}/api/world/catalog`)).json(),metadata=await (await page.request.get(`${server}${bootstrap.metadata.path}`)).json();
  ids=metadata.territories.filter(t=>t.sourceCountryId==='CHN').slice(0,3).map(t=>t.id);hungarianIds=metadata.territories.filter(t=>t.sourceCountryId==='HUN').map(t=>t.id);mergedIds=metadata.territories.filter(t=>['HUN','AUT'].includes(t.sourceCountryId)).map(t=>t.id);
  await page.evaluate(()=>{const map=window.__PAX_CATALOG_DEBUG__.inspectMap();window.__reviewECalls=[];const original=map.setFeatureState;map.setFeatureState=function(target,state){window.__reviewECalls.push({method:'setFeatureState',target,state});return original.call(this,target,state);};for(const id of ['catalog-country-labels','catalog-capitals']){const source=map.getSource(id);for(const method of ['setData','updateData'])if(typeof source[method]==='function'){const fn=source[method];source[method]=function(value){window.__reviewECalls.push({method,source:id,value:JSON.parse(JSON.stringify(value))});return fn.call(this,value);};}}});
  await page.route('**/api/simulation/turn',async route=>{
    const request=route.request().postDataJSON(),context=request.context,eventId=`event.review-e.${stage}`,date=stage.startsWith('future-')?'2020-01-03':context.period.endDate;
    const effect=(type,payload,suffix=type)=>({effectId:`effect.${stage}.${suffix}`,causedByEventId:eventId,type,...payload});
    const r={contractVersion:'turn-resolution.v1',baseSimulationRevision:context.revisions.simulation,baseWorldRevision:context.revisions.world,period:context.period,playerActionOutcomes:[],events:[{eventId,date,title:`검증 ${stage}`,publicNarrative:'플레이 국가와 예약 결과의 인과관계를 검증합니다.',actorCountryIds:['AUT','HUN','CHN','KOR'].filter(id=>context.countryDirectory.some(c=>c.countryId===id)),relatedFactIds:[],relatedSituationIds:[],causes:stage==='ground'?[]:[{kind:stage==='merge'?'authoritative-event':'scheduled-consequence',id:stage==='merge'?'event.review-e.ground':'consequence.review-e.future'}],outcomeCategory:'treaty',significance:'notable'}],factMutations:[],situationMutations:[],scheduledConsequences:[],worldEffects:[],advisorSummary:'검증 결과',unresolvedQuestions:[]};
    if(stage==='ground')r.scheduledConsequences=[{consequenceId:'consequence.review-e.future',earliestDate:'2020-01-15',deadlineDate:null,actorCountryIds:['CHN','KOR'],situationId:null,triggerSummary:'1월 15일 예정 결과',sourceEventId:eventId,status:'scheduled'}];
    if(stage==='merge')r.worldEffects=[effect('countries.merged',{initiatorCountryId:'AUT',absorbedCountryIds:['HUN']})];
    if(stage.startsWith('future-')||stage==='due-valid'){
      const grant=effect('territorialAuthority.granted',{authority:{id:`tca:review-e-${stage}`,actorCountryId:'KOR',targetCountryId:'CHN',allowedTerritoryIds:ids,allowedOperations:['occupy'],validFrom:date,validTo:null,sourceEventId:eventId}},'grant');
      const occupy=effect('territory.occupy',{actorCountryId:'KOR',targetCountryId:'CHN',authorityId:`tca:review-e-${stage}`,territoryIds:ids});
      if(stage.startsWith('future-')){r.events.unshift({eventId:'event.review-e.rename',date,title:'국호 변경',publicNarrative:'국호를 변경합니다.',actorCountryIds:['HUN'],relatedFactIds:[],relatedSituationIds:[],causes:[],outcomeCategory:'domestic',significance:'minor'});r.worldEffects=[{effectId:'effect.review-e.rename',causedByEventId:'event.review-e.rename',type:'country.renamed',countryId:'HUN',displayName:'잘못된 부분 변경'},grant,...(stage==='future-middle'?[occupy]:[])];}else r.worldEffects=[grant,occupy];
    }
    turns.push({stage,context,resolution:r,expectedValidation:!stage.startsWith('future-')});
    await route.fulfill({status:200,contentType:'application/x-ndjson',body:[{version:1,turnId:request.turnId,sequence:0,type:'turn.started'},{version:1,turnId:request.turnId,sequence:1,type:'resolution.ready',resolution:r}].map(v=>JSON.stringify(v)).join('\n')+'\n'});
  });
  await capture('initial','HUN');
  phases.push({phase:'ground',...await turn('ground','2020-01-02')});
  for(const name of ['future-middle','future-last']){
    const beforeName=await page.locator('.game-player-badge').innerText(),territories=await page.evaluate(ids=>ids.map(id=>window.__PAX_CATALOG_DEBUG__.territoryState(id)),ids),result=await turn(name,'2020-01-31',true);
    const stable=s=>({date:s.date,worldRevision:s.worldRevision,simulationRevision:s.simulationRevision,player:s.playerCountryId,uiPlayer:s.uiPlayerCountryId,eventCount:s.eventCount,authorityOrder:s.authorityOrder,canUndo:s.canUndo,canRedo:s.canRedo,pairNotifications:s.pairNotifications});
    assert(JSON.stringify(stable(result.before))===JSON.stringify(stable(result.after))&&result.calls.length===0,`${name}: partial world/simulation/history/map publication`);
    assert(JSON.stringify(await page.evaluate(ids=>ids.map(id=>window.__PAX_CATALOG_DEBUG__.territoryState(id)),ids))===JSON.stringify(territories)&&await page.locator('.game-player-badge').innerText()===beforeName,`${name}: partial control/name change`);
    const rejection=await page.locator('.turn-status').getAttribute('data-error-code');assert(rejection?.startsWith('INVALID_CAUSALITY:'),`${name}: incorrect rejection reason: ${rejection}`);
    phases.push({phase:name,...result,rejection,notificationDelta:0,mapCalls:0,partialChanges:0});await page.screenshot({path:path.join(output,`${name}.png`),animations:'disabled'});
  }
  const merge=await turn('merge','2020-01-03');assert(merge.after.pairNotifications-merge.before.pairNotifications===1,'Merge notification not atomic');await capture('merge-commit','AUT',merge);
  for(const [name,button,player]of [['merge-undo','마지막 턴 되돌리기','HUN'],['merge-redo','다시 실행','AUT']]){await openAction();await resetCalls();const before=await snapshot();await page.getByRole('button',{name:button,exact:true}).click();await ready();const after=await snapshot();assert(after.pairNotifications-before.pairNotifications===1,`${name}: notification not atomic`);await capture(name,player,{before,after,calls:await calls()});}
  const due=await turn('due-valid','2020-01-15');assert(due.after.pairNotifications-due.before.pairNotifications===1,'Valid due grant not atomic');const control=await page.evaluate(ids=>ids.map(id=>window.__PAX_CATALOG_DEBUG__.territoryState(id)),ids);assert(control.every(t=>t.ownerCountryId==='CHN'&&t.controllerCountryId==='KOR'),'Valid due occupation failed');phases.push({phase:'due-valid',...due,territories:control});await page.screenshot({path:path.join(output,'due-valid.png'),animations:'disabled'});
  assert(phases.flatMap(p=>p.calls??[]).filter(c=>c.method==='setData').length===0,'Ordinary change used whole source setData');assert(errors.length===0,`Browser errors: ${errors.join(';')}`);status='pass';
}catch(e){error=e.stack;phases.push({phase:'failure-diagnostics',snapshot:await snapshot().catch(()=>null),uiError:await page.locator('.turn-status').getAttribute('data-error-code').catch(()=>null)});await page.screenshot({path:path.join(output,'failure.png')}).catch(()=>{});}finally{await browser.close();}
const evidence={status,error,server,phases,turns,browserErrors:errors,provider:'deterministic intercepted NDJSON; actual production host planner/atomic store/UI/MapLibre',screenshots:fs.readdirSync(output).filter(p=>p.endsWith('.png')).map(p=>{const b=fs.readFileSync(path.join(output,p));return {path:p,sha256:digest(b),byteLength:b.length};})};
writeArtifact(output,'review-e-smoke-evidence.json',jsonBytes(evidence));console.log(JSON.stringify({status,error,phases:phases.map(p=>p.phase),output}));if(status!=='pass')process.exitCode=1;
