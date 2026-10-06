import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {chromium} from 'playwright';
import {createHash} from 'node:crypto';
const reviewF=process.argv.includes('--review-f');
const outputIndex=process.argv.indexOf('--output');
const port=3167,output=path.resolve(outputIndex>=0?process.argv[outputIndex+1]:(reviewF?'reports/prompt14/14-17-country-color/review-f-remediation/browser':'reports/prompt14/14-17-country-color/browser'));
fs.mkdirSync(output,{recursive:true});
const server=spawn(process.execPath,['node_modules/next/dist/bin/next','start','--hostname','127.0.0.1','-p',String(port)],{windowsHide:true,stdio:['ignore','pipe','pipe']});
let serverLog='',browser,status='fail',failure;const scenarios=[],errors=[],turns=[];
server.stdout.on('data',b=>serverLog+=b);server.stderr.on('data',b=>serverLog+=b);
const assert=(value,message)=>{if(!value)throw new Error(message);};
try{
  await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error(`Server readiness: ${serverLog}`)),30000);server.stdout.on('data',b=>{if(String(b).includes('Ready')){clearTimeout(timer);resolve();}});server.once('exit',code=>{clearTimeout(timer);reject(new Error(`Server exit ${code}: ${serverLog}`));});});
  browser=await chromium.launch({channel:'chrome',headless:true,args:['--enable-unsafe-swiftshader']});
  for(const scenario of [{countryId:'RUS',color:'#CC0000',center:[99,61.7],zoom:3.5},{countryId:'AUT',color:'#FFFFFF',center:[14.5,47.5],zoom:6},
    ...reviewF?[{countryId:'RUS',color:null,center:[99,61.7],zoom:3.5}]:[]]){
    const page=await browser.newPage({viewport:{width:1440,height:900}});page.on('pageerror',e=>errors.push(e.message));
    let unauthorized=false;
    await page.route('**/api/simulation/turn',async route=>{
      const request=route.request().postDataJSON(),c=request.context,id=`event.color.${c.revisions.simulation}`,a=c.queuedActions[0];
      const r={contractVersion:'turn-resolution.v1',baseSimulationRevision:c.revisions.simulation,baseWorldRevision:c.revisions.world,period:c.period,
        playerActionOutcomes:[{outcomeId:`outcome.${c.revisions.simulation}`,actionId:a.actionId,status:'succeeded',evidenceEventId:id,summary:'국가 색상 채택',remainingConditions:[]}],
        events:[{eventId:id,date:c.period.endDate,title:'국가 색상 채택',publicNarrative:'새 국가 색상이 채택되었습니다.',actorCountryIds:[scenario.countryId],relatedFactIds:[],relatedSituationIds:[],causes:[{kind:'queued-action',id:a.actionId}],outcomeCategory:'domestic',significance:'notable'}],
        factMutations:[],situationMutations:[],scheduledConsequences:[],worldEffects:[],advisorSummary:'새 색상이 지도에 적용되었습니다.',unresolvedQuestions:[]};
      const authorityId=`cpa:color.${c.revisions.simulation}`;
      if(!unauthorized&&reviewF){
        const requestedMapColor=scenario.color?.toLowerCase()??null;
        if(scenario.color===null){
          const start=parseInt(createHash('sha256').update(`country-map-color.v1\0${scenario.countryId}`).digest('hex').slice(0,6),16),used=new Set(c.countryMapColors.map(c=>c.mapColor));
          for(let i=0;i<=used.size;i++){const color=`#${((start+i*0x9E3779)&0xFFFFFF).toString(16).padStart(6,'0').toUpperCase()}`;if(!used.has(color)){scenario.color=color;break;}}
          assert(scenario.color,'No fallback');scenario.fallback=true;
        }
        r.worldEffects.push({effectId:`color.${c.revisions.simulation}`,causedByEventId:id,type:'country.chooseMapColor',requestedMapColor,
          authority:{id:authorityId,actorCountryId:scenario.countryId,targetCountryId:scenario.countryId,validFrom:c.period.endDate,validTo:null,sourceEventId:id}});
      }else{
        if(!unauthorized)r.worldEffects.push({effectId:`grant.${c.revisions.simulation}`,causedByEventId:id,type:'countryPresentationAuthority.granted',authority:{id:authorityId,actorCountryId:scenario.countryId,targetCountryId:scenario.countryId,allowedMapColors:[scenario.color],validFrom:c.period.endDate,validTo:null,sourceEventId:id}});
        r.worldEffects.push({effectId:`color.${c.revisions.simulation}`,causedByEventId:id,type:'country.changeMapColor',actorCountryId:scenario.countryId,countryId:scenario.countryId,mapColor:unauthorized?'#000000':scenario.color,authorityId});
      }
      if(reviewF)turns.push({context:c,resolution:r,expectedValidation:!unauthorized,selectedColor:scenario.color});
      await route.fulfill({status:200,contentType:'application/x-ndjson',body:[{version:1,turnId:request.turnId,sequence:0,type:'turn.started'},{version:1,turnId:request.turnId,sequence:1,type:'resolution.ready',resolution:r}].map(v=>JSON.stringify(v)).join('\n')+'\n'});
    });
    await page.goto(`http://127.0.0.1:${port}/game#player=${scenario.countryId}`,{waitUntil:'domcontentloaded'});
    const ready=()=>page.waitForFunction(()=>window.__PAX_CATALOG_DEBUG__?.ready(),null,{timeout:30000});await ready();
    await page.evaluate(s=>window.__PAX_CATALOG_DEBUG__.jumpTo(s.center,s.zoom),scenario);await ready();
    await page.evaluate(()=>{
      const map=window.__PAX_CATALOG_DEBUG__.inspectMap();window.__colorCalls=[];
      const original=map.setFeatureState;map.setFeatureState=function(target,state){window.__colorCalls.push({method:'setFeatureState',target,state});return original.call(this,target,state);};
      for(const id of ['world-territory-catalog','catalog-country-labels','catalog-capitals']){const source=map.getSource(id);for(const method of ['setData','updateData'])if(typeof source[method]==='function'){const fn=source[method];source[method]=function(value){window.__colorCalls.push({source:id,method});return fn.call(this,value);};}}
    });
    const snapshot=()=>page.evaluate(countryId=>{const debug=window.__PAX_CATALOG_DEBUG__,map=debug.inspectMap();const ids=[...new Set(debug.renderedTerritoryIds())];return {...debug.getSnapshot(),visibleStates:ids.map(id=>({id,...map.getFeatureState({source:'world-territory-catalog',sourceLayer:'territories',id})})).filter(s=>s.ownerCountryId===countryId||s.controllerCountryId===countryId),labelState:map.getFeatureState({source:'catalog-country-labels',id:`catalog-label:${countryId}`}),calls:window.__colorCalls};},scenario.countryId);
    const before=await snapshot();assert(before.visibleStates.length,'No visible target country territories');const oldColor=before.visibleStates[0].mapColor;
    await page.getByRole('button',{name:'국가 행동',exact:true}).click();
    await page.locator('#game-player-action').fill(`국가 색상을 ${scenario.color}로 채택한다`);await page.getByRole('button',{name:'대기열에 추가',exact:true}).click();
    await page.getByRole('button',{name:'1일',exact:true}).click();await page.getByRole('button',{name:'진행 시작',exact:true}).click();
    await page.waitForFunction(()=>document.querySelector('.turn-status')?.getAttribute('data-phase')==='committed',null,{timeout:20000});await ready();
    const after=await snapshot();assert(after.visibleStates.every(s=>s.mapColor===scenario.color),'Requested color was not applied');assert(after.projectionBuilds===before.projectionBuilds,'Color rebuilt full projection');
    const renderedGlyphStates=await page.evaluate(countryId=>window.__PAX_CATALOG_DEBUG__.inspectMap().queryRenderedFeatures(undefined,{layers:['catalog-country-glyph-fills']}).filter(f=>f.properties.countryId===countryId).map(f=>({id:f.id,promotedId:f.properties.labelFeatureId,state:f.state})),scenario.countryId);
    assert(renderedGlyphStates.length>0,'Target glyphs not rendered');assert(renderedGlyphStates.every(f=>f.id===f.promotedId&&f.state.labelColor&&f.state.labelHaloColor),'Glyph feature state is not bound to rendered IDs');
    if(scenario.color==='#FFFFFF')assert(renderedGlyphStates.every(f=>f.state.labelColor==='#172E35'&&f.state.labelHaloColor==='#FFFFFF'),'White country glyphs are not rendered with contrasting ink');
    await page.getByRole('button',{name:'국가 행동 닫기',exact:true}).click();
    await page.screenshot({path:path.join(output,`${scenario.countryId}-${scenario.color.slice(1)}.png`)});
    await page.getByRole('button',{name:'국가 행동',exact:true}).click();
    await page.getByRole('button',{name:'마지막 턴 되돌리기'}).click();await ready();const undo=await snapshot();assert(undo.visibleStates.every(s=>s.mapColor===oldColor),'Undo did not restore exact color');
    await page.getByRole('button',{name:'다시 실행',exact:true}).click();await ready();const redo=await snapshot();assert(redo.visibleStates.every(s=>s.mapColor===scenario.color),'Redo did not restore requested color');
    assert(redo.calls.every(c=>c.method!=='setData'&&c.method!=='updateData'),'Color update rebuilt a source');
    assert(redo.labelState.labelColor&&redo.labelState.labelHaloColor,'Label contrast state missing');
    unauthorized=true;
    await page.locator('#game-player-action').fill('[DEBUG_WORLD_EFFECT] 권한 없이 검정색으로 변경');await page.getByRole('button',{name:'대기열에 추가',exact:true}).click();await page.getByRole('button',{name:'진행 시작',exact:true}).click();
    await page.waitForFunction(()=>document.querySelector('.turn-status')?.getAttribute('data-phase')==='failed',null,{timeout:20000});const rejected=await snapshot();
    assert(rejected.worldRevision===redo.worldRevision&&rejected.visibleStates.every(s=>s.mapColor===scenario.color),'Production debug bypass changed world');
    scenarios.push({countryId:scenario.countryId,requestedColor:scenario.fallback?null:scenario.color,selectedColor:scenario.color,hostChoiceIntent:reviewF,seedColor:oldColor,visibleTerritoryCount:after.visibleStates.length,
      before:{worldRevision:before.worldRevision,projectionBuilds:before.projectionBuilds},after:{worldRevision:after.worldRevision,projectionBuilds:after.projectionBuilds,colorProjectionUpdates:after.colorProjectionUpdates},
      undoColor:undo.visibleStates[0].mapColor,redoColor:redo.visibleStates[0].mapColor,labelState:redo.labelState,renderedGlyphStates,sourceUpdates:redo.calls.filter(c=>c.method!=='setFeatureState').length,
      affectedFeatureIds:[...new Set(redo.calls.filter(c=>c.target?.source==='world-territory-catalog').map(c=>c.target.id))],unauthorizedProductionDebugRejected:true,screenshot:`${scenario.countryId}-${scenario.color.slice(1)}.png`});
    await page.close();
  }
  assert(errors.length===0,`Browser errors: ${errors.join('; ')}`);status='pass';
}catch(error){failure=error.stack;}
finally{await browser?.close();server.kill();fs.writeFileSync(path.join(output,'evidence.json'),JSON.stringify({status,failure,mode:'Next production build; deterministic local provider responses through real UI/atomic runtime',scenarios,turns,browserErrors:errors},null,2));}
console.log(JSON.stringify({status,failure,scenarioCount:scenarios.length,output}));if(status!=='pass')process.exitCode=1;
