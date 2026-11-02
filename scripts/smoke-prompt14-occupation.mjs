import fs from 'node:fs';import path from 'node:path';import {chromium} from 'playwright';
import {digest,jsonBytes,writeArtifact,assertBuildOutput} from './prompt14-catalog-core.mjs';
const server=process.argv[2],output=path.resolve(process.argv[3]??'.tmp/prompt14-occupation/browser');
if(!server||!['localhost','127.0.0.1'].includes(new URL(server).hostname))throw Error('Explicit local production server required');
assertBuildOutput(process.cwd(),output);fs.mkdirSync(output,{recursive:true});
const browser=await chromium.launch({headless:true,args:['--enable-unsafe-swiftshader']}),page=await browser.newPage({viewport:{width:1440,height:900}});
const errors=[],requests=[],phases=[],turns=[];let stage='ground',status='fail',error=null,ids=[],occupationAnchor=[];
page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});page.on('request',r=>requests.push(new URL(r.url()).pathname));
const assert=(v,message)=>{if(!v)throw Error(message);};
const ready=()=>page.waitForFunction(()=>window.__PAX_CATALOG_DEBUG__?.ready()&&document.querySelector('[data-testid="world-map"]')?.getAttribute('data-map-status')==='ready',null,{timeout:60000});
const snapshot=()=>page.evaluate(()=>window.__PAX_CATALOG_DEBUG__.getSnapshot());
const states=()=>page.evaluate(ids=>ids.map(id=>window.__PAX_CATALOG_DEBUG__.territoryState(id)),ids);
const calls=()=>page.evaluate(()=>window.__occupationCalls);
const resetCalls=()=>page.evaluate(()=>{window.__occupationCalls=[];});
const openAction=async()=>{if(!await page.getByRole('button',{name:'진행 시작',exact:true}).isVisible())await page.getByRole('button',{name:'국가 행동',exact:true}).click();};
const turn=async(name,fail=false)=>{stage=name;await openAction();await resetCalls();const before=await snapshot();await page.getByRole('button',{name:'1일',exact:true}).click();await page.getByRole('checkbox',{name:'행동 없이 시간만 진행'}).check();await page.getByRole('button',{name:'진행 시작',exact:true}).click();await page.waitForFunction(phase=>document.querySelector('.turn-status')?.getAttribute('data-phase')===phase,fail?'failed':'committed',{timeout:20000});await ready();const after=await snapshot();assert(after.pairNotifications-before.pairNotifications===(fail?0:1),`${name}: pair notification count is not atomic`);return {before,after};};
const capture=async(name,expectedOwner,expectedController,measurement)=>{
  const actual=await states(),measured=await calls();for(const t of actual){assert(t.ownerCountryId===expectedOwner&&t.controllerCountryId===expectedController,`${name}: owner/controller mismatch`);assert(t.occupied===(expectedController!==expectedOwner),`${name}: occupied mismatch`);}
  assert(measured.filter(c=>c.method==='setData').length===0,`${name}: whole source setData`);
  const territoryChanges=measured.filter(c=>c.method==='setFeatureState'&&c.target.sourceLayer==='territories'&&Object.hasOwn(c.state,'ownerCountryId'));
  if(!name.startsWith('merge'))assert(territoryChanges.length===3&&new Set(territoryChanges.map(c=>c.target.id)).size===3&&territoryChanges.every(c=>ids.includes(c.target.id)),`${name}: unrelated territory state updates`);
  if(!name.startsWith('transfer')&&!name.startsWith('merge'))assert(measured.filter(c=>c.method==='updateData').length===0,`${name}: controller-only update changed labels or capitals`);
  const after=await snapshot();assert(after.fullProjectionBuilds===1,`${name}: full projection regenerated`);
  const fronts=await page.evaluate(()=>{const map=window.__PAX_CATALOG_DEBUG__.inspectMap();return map.querySourceFeatures('world-territory-catalog',{sourceLayer:'edges'}).filter(f=>map.getFeatureState({source:'world-territory-catalog',sourceLayer:'edges',id:f.id}).front).map(f=>({id:f.id,left:f.properties.leftTerritoryId,right:f.properties.rightTerritoryId}));});
  if(expectedOwner!==expectedController){assert(fronts.length>0,`${name}: no front on loaded edges`);for(const f of fronts)assert(ids.includes(f.left)||ids.includes(f.right),`${name}: non-adjacent front`);}
  const colorCountry=expectedController??expectedOwner;
  const fillColors=await page.evaluate(ids=>{const d=window.__PAX_CATALOG_DEBUG__,map=d.inspectMap();return ids.map(id=>map.getFeatureState({source:'world-territory-catalog',sourceLayer:'territories',id}).mapColor);},ids);
  const countryColor=await page.evaluate(id=>window.__PAX_CATALOG_DEBUG__.territoryState(window.__occupationReference[id]).mapColor,colorCountry);
  assert(fillColors.every(c=>c===countryColor),`${name}: controller color mismatch`);
  phases.push({phase:name,...measurement,snapshot:after,territories:actual,calls:measured,fronts,wholeSourceSetDataCalls:0,fullProjectionBuilds:after.fullProjectionBuilds});
  await page.getByRole('button',{name:'국가 행동',exact:true}).click();await page.screenshot({path:path.join(output,`${name}.png`)});
  if(name==='occupy'){
    const box=await page.getByTestId('world-map').boundingBox(),point=await page.evaluate(p=>window.__PAX_CATALOG_DEBUG__.project(p),occupationAnchor);await page.mouse.click(box.x+point[0],box.y+point[1]);
    await page.getByTestId('country-territorial-control').waitFor();const counts=await page.getByTestId('country-territorial-control').locator('dd').allTextContents();assert(counts[2]==='3','Country panel does not show three occupied legal-owner territories');
    const detail=await page.getByTestId('territory-control-detail').innerText(),names=await page.evaluate(()=>({owner:window.__PAX_CATALOG_DEBUG__.countryControl('CHN').nameKo,controller:window.__PAX_CATALOG_DEBUG__.countryControl('KOR').nameKo}));assert(detail.includes(`소유: ${names.owner}`)&&detail.includes(`통제: ${names.controller}`)&&detail.includes('점령 중'),'Clicked occupied territory did not expose actual legal owner/controller');
    phases.push({phase:'occupied-territory-country-panel',counts,detail});await page.screenshot({path:path.join(output,'occupied-country-panel.png')});await page.locator('.game-panel__close').click();
  }
  await openAction();
};
try{
  await page.goto(`${server}/game#player=KOR`,{waitUntil:'domcontentloaded'});await ready();
  assert((await snapshot()).worldSchema===3&&(await snapshot()).simulationSchema===2,'Wrong production schemas');
  const bootstrap=await (await page.request.get(`${server}/api/world/catalog`)).json(),metadata=await (await page.request.get(`${server}${bootstrap.metadata.path}`)).json();
  ids=metadata.territories.filter(t=>t.sourceCountryId==='CHN').slice(0,3).map(t=>t.id);
  occupationAnchor=metadata.territories.find(t=>t.id===ids[2]).anchor;
  const fourth=metadata.territories.filter(t=>t.sourceCountryId==='CHN')[3].id;
  await page.evaluate(ref=>{window.__occupationReference=ref;},{KOR:metadata.territories.find(t=>t.sourceCountryId==='KOR').id,CHN:fourth});
  await page.evaluate(()=>window.__PAX_CATALOG_DEBUG__.jumpTo([115,29],4.5));await ready();
  await page.evaluate(()=>{const map=window.__PAX_CATALOG_DEBUG__.inspectMap();window.__occupationCalls=[];const original=map.setFeatureState;map.setFeatureState=function(target,state){window.__occupationCalls.push({method:'setFeatureState',target,state});return original.call(this,target,state);};for(const id of ['world-territory-catalog','catalog-country-labels','catalog-capitals']){const source=map.getSource(id);for(const method of ['setData','updateData'])if(typeof source[method]==='function'){const fn=source[method];source[method]=function(value){window.__occupationCalls.push({method,source:id,value:JSON.parse(JSON.stringify(value))});return fn.call(this,value);};}}});
  await page.route('**/api/simulation/turn',async route=>{
    const request=route.request().postDataJSON(),context=request.context,date=context.period.endDate,eventId=`event.occupation.${stage}`,effect=(type,payload,suffix=type)=>({effectId:`effect.${stage}.${suffix}`,causedByEventId:eventId,type,...payload});
    const r={contractVersion:'turn-resolution.v1',baseSimulationRevision:context.revisions.simulation,baseWorldRevision:context.revisions.world,period:context.period,playerActionOutcomes:[],events:[{eventId,date,title:`영토 ${stage}`,publicNarrative:'검증된 영토 관계의 결과를 적용했습니다.',actorCountryIds:['CHN','KOR'],relatedFactIds:[],relatedSituationIds:[],causes:stage==='ground'?[]:[{kind:'authoritative-event',id:'event.occupation.ground'}],outcomeCategory:stage==='merge'||stage==='transfer'?'treaty':'military',significance:'notable'}],factMutations:[],situationMutations:[],scheduledConsequences:[],worldEffects:[],advisorSummary:'일부 영토의 소유와 통제를 확인했습니다.',unresolvedQuestions:[]};
    const grant=(id,actor,target,op)=>effect('territorialAuthority.granted',{authority:{id,actorCountryId:actor,targetCountryId:target,allowedTerritoryIds:ids,allowedOperations:[op],validFrom:date,validTo:null,sourceEventId:eventId}},'grant');
    if(stage==='occupy'||stage==='invalid-tail')r.worldEffects=[...(stage==='occupy'?[grant('tca:production-occupy','KOR','CHN','occupy')]:[]),effect('territory.occupy',{actorCountryId:'KOR',targetCountryId:'CHN',authorityId:'tca:production-occupy',territoryIds:ids})];
    if(stage==='liberate')r.worldEffects=[grant('tca:production-liberate','CHN','KOR','liberate'),effect('territory.liberate',{actorCountryId:'CHN',targetCountryId:'KOR',authorityId:'tca:production-liberate',territoryIds:ids})];
    if(stage==='invalid-tail')r.worldEffects.push(effect('territory.occupy',{actorCountryId:'KOR',targetCountryId:'CHN',authorityId:'tca:unknown',territoryIds:ids},'invalid'));
    if(stage==='transfer')r.worldEffects=[grant('tca:production-transfer','CHN','KOR','transfer'),effect('territory.transferOwnership',{actorCountryId:'CHN',targetCountryId:'KOR',newOwnerCountryId:'KOR',controllerPolicy:'new-owner',authorityId:'tca:production-transfer',territoryIds:ids})];
    if(stage==='merge')r.worldEffects=[effect('countries.merged',{initiatorCountryId:'KOR',absorbedCountryIds:['CHN']})];
    turns.push({stage,context,resolution:r,expectedValidation:stage!=='invalid-tail'});
    await route.fulfill({status:200,contentType:'application/x-ndjson',body:[{version:1,turnId:request.turnId,sequence:0,type:'turn.started'},{version:1,turnId:request.turnId,sequence:1,type:'resolution.ready',resolution:r}].map(v=>JSON.stringify(v)).join('\n')+'\n'});
  });
  phases.push({phase:'grounded-prior-event',...await turn('ground')});
  await capture('occupy','CHN','KOR',await turn('occupy'));
  assert(await page.evaluate(id=>window.__PAX_CATALOG_DEBUG__.territoryState(id).controllerCountryId,fourth)==='CHN','Partial occupation changed unselected Chinese territory');
  for(const [name,button,owner,controller]of [['occupation-undo','마지막 턴 되돌리기','CHN','CHN'],['occupation-redo','다시 실행','CHN','KOR']]){await resetCalls();const before=await snapshot();await page.getByRole('button',{name:button,exact:true}).click();await ready();assert((await snapshot()).pairNotifications-before.pairNotifications===1,`${name}: not one atomic notification`);await capture(name,owner,controller,{before});}
  await capture('liberate','CHN','CHN',await turn('liberate'));
  const beforeFailure=await states(),failure=await turn('invalid-tail',true),failureCalls=await calls();assert(JSON.stringify(await states())===JSON.stringify(beforeFailure)&&failure.before.worldRevision===failure.after.worldRevision&&failure.before.simulationRevision===failure.after.simulationRevision&&failure.before.date===failure.after.date&&failureCalls.length===0,'Failed aggregate published a partial pair or map changes');
  phases.push({phase:'invalid-tail-atomic-rollback',...failure,calls:failureCalls});await page.screenshot({path:path.join(output,'invalid-tail-rollback.png')});
  await capture('transfer','KOR','KOR',await turn('transfer'));
  assert(!(await snapshot()).authorityOrder.includes('tca:production-occupy'),'Stale authority survived ownership change');
  for(const [name,button,owner]of [['transfer-undo','마지막 턴 되돌리기','CHN'],['transfer-redo','다시 실행','KOR']]){await resetCalls();await page.getByRole('button',{name:button,exact:true}).click();await ready();await capture(name,owner,owner,{});}
  await capture('merge','KOR','KOR',await turn('merge'));
  assert(await page.locator('.app-shell').getAttribute('data-world-country-count')==='246'&&(await snapshot()).playerCountryId==='KOR','Merge failed initiator identity/retirement');
  await resetCalls();await page.getByRole('button',{name:'마지막 턴 되돌리기',exact:true}).click();await ready();assert(await page.locator('.app-shell').getAttribute('data-world-country-count')==='247','Merge undo failed country restoration');await capture('merge-undo','KOR','KOR',{});
  await resetCalls();await page.getByRole('button',{name:'다시 실행',exact:true}).click();await ready();assert(await page.locator('.app-shell').getAttribute('data-world-country-count')==='246','Merge redo failed retirement');await capture('merge-redo','KOR','KOR',{});
  const builds=(await snapshot()).fullProjectionBuilds;for(const center of [[127,36],[115,29],[0,54]]){await page.evaluate(c=>window.__PAX_CATALOG_DEBUG__.jumpTo(c,4),center);await ready();}assert((await snapshot()).fullProjectionBuilds===builds,'Camera regenerated projection');
  assert(errors.length===0,`Browser errors: ${errors.join(';')}`);assert(!requests.some(p=>/build-only|geometry\.geojson|topology\.json/.test(p)),'Full geometry/topology reached browser');status='pass';
}catch(e){error=e.stack;phases.push({phase:'failure-diagnostics',snapshot:await snapshot().catch(()=>null),uiError:await page.locator('.turn-status').getAttribute('data-error-code').catch(()=>null)});await page.screenshot({path:path.join(output,'failure.png')}).catch(()=>{});}finally{await browser.close();}
const evidence={status,error,server,phases,turns,scopeTerritoryIds:ids,browserErrors:errors,requests:[...new Set(requests)],provider:'deterministic intercepted NDJSON; actual production host planner/atomic store/MapLibre',screenshots:fs.readdirSync(output).filter(p=>p.endsWith('.png')).map(p=>{const b=fs.readFileSync(path.join(output,p));return {path:p,sha256:digest(b),byteLength:b.length};})};
writeArtifact(output,'occupation-smoke-evidence.json',jsonBytes(evidence));console.log(JSON.stringify({status,error,phases:phases.map(p=>p.phase),output}));if(status!=='pass')process.exitCode=1;
