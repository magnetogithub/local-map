import {test,expect} from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';

test('reference machine legacy/catalog camera benchmark and bounded catalog caches',async({browser,baseURL})=>{
  test.info().annotations.push({type:'runtime',description:'comparison only: historical V2 camera baseline and production World V3 / Simulation V2'});
  test.setTimeout(300000);const measurements=[];
  for(const mode of ['legacy','catalog']){
    const context=await browser.newContext({viewport:{width:1440,height:900}});
    if(mode==='legacy')await context.addCookies([{name:'pax-legacy-regression',value:'1',url:baseURL!}]);
    const page=await context.newPage(),errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
    const start=performance.now();await page.goto(baseURL!);
    if(mode==='catalog')await page.waitForFunction(()=>window.__PAX_CATALOG_DEBUG__?.ready(),null,{timeout:90000});
    else await page.waitForFunction(()=>window.__PAX_MAP_DEBUG__?.isRenderSettled?.(),null,{timeout:90000});
    const loadMs=performance.now()-start,cdp=await context.newCDPSession(page),heap=[];
    // Finish the same camera locations' asynchronous source/font/tile loading before
    // comparing repeated retained heap. Cold-cache growth is reported separately.
    await cdp.send('HeapProfiler.collectGarbage');
    const coldHeap=await cdp.send('Runtime.getHeapUsage'),warmupStarted=performance.now();
    for(let round=0;round<2;round++)for(const [index,center] of ([[-98,38],[104,35],[127,36],[0,54],[2,46]] as [number,number][]).entries()){
      await page.evaluate(({mode,center,zoom})=>{
        if(mode==='catalog')window.__PAX_CATALOG_DEBUG__!.jumpTo(center,zoom);
        else window.__PAX_MAP_DEBUG__!.jumpTo(center,zoom);
      },{mode,center,zoom:index%2?3.5:2});
      await page.waitForFunction(mode=>mode==='catalog'?window.__PAX_CATALOG_DEBUG__?.ready():window.__PAX_MAP_DEBUG__?.isRenderSettled?.(),mode,{timeout:90000});
    }
    await cdp.send('HeapProfiler.collectGarbage');
    const warmHeap=await cdp.send('Runtime.getHeapUsage'),warmupMs=performance.now()-warmupStarted;
    const samples=[];
    for(let round=0;round<3;round++){
      samples.push(await page.evaluate(async mode=>{
        const catalog=window.__PAX_CATALOG_DEBUG__,legacy=window.__PAX_MAP_DEBUG__,frames:number[]=[];
        const before=catalog?.getSnapshot(),original=JSON.stringify;let worldSerializations=0;
        JSON.stringify=function(value,...args){if(value&&typeof value==='object'&&'territoriesById' in value)worldSerializations++;return original(value,...args as []);};
        const centers:[number,number][]=[[-98,38],[104,35],[127,36],[0,54],[2,46]],started=performance.now();let last=started;
        for(const [index,center] of centers.entries()){
          if(mode==='catalog')catalog!.jumpTo(center,index%2?3.5:2);else legacy!.jumpTo(center,index%2?3.5:2);
          const until=performance.now()+300;
          while(performance.now()<until){await new Promise<void>(resolve=>requestAnimationFrame(()=>resolve()));const now=performance.now();frames.push(now-last);last=now;}
        }
        JSON.stringify=original;frames.sort((a,b)=>a-b);
        return {durationMs:performance.now()-started,frames:frames.length,frameTimeP50:frames[Math.floor(frames.length*.5)],frameTimeP95:frames[Math.floor(frames.length*.95)],maxFrameMs:frames.at(-1),fps:frames.length/((performance.now()-started)/1000),worldSerializations,before,after:catalog?.getSnapshot()};
      },mode));
      await cdp.send('HeapProfiler.collectGarbage');heap.push(await cdp.send('Runtime.getHeapUsage'));
    }
    const output=process.env.PROMPT14_PERFORMANCE_OUTPUT??'reports/prompt14/final-validation/performance';fs.mkdirSync(output,{recursive:true});
    fs.writeFileSync(`${output}/browser-camera-${mode}.json`,JSON.stringify({mode,loadMs,coldHeap,warmHeap,warmupMs,samples,heap,browserErrors:errors},null,2));
    expect(errors).toEqual([]);for(const s of samples){expect(s.frames).toBeGreaterThan(0);expect(s.maxFrameMs!).toBeLessThan(5000);expect(s.worldSerializations).toBe(0);}
    if(mode==='catalog')for(const s of samples){expect(s.after!.projectionBuilds).toBe(s.before!.projectionBuilds);expect(Number(s.after!.cachedTiles)).toBeLessThanOrEqual(256);expect(Number(s.after!.cachedBytes)).toBeLessThanOrEqual(8*1024*1024);}
    expect(heap.at(-1)!.usedSize).toBeLessThanOrEqual(warmHeap.usedSize+32*1024*1024);
    let updates:unknown;
    if(mode==='catalog'){
      const freeze=JSON.parse(fs.readFileSync('data/catalogs/prompt14/frozen-catalog-ref.json','utf8'));
      const metadata=JSON.parse(fs.readFileSync(`public/data/territory-catalog/${freeze.ref.catalogVersion}/consumer-metadata.json`,'utf8'));
      const counts:Record<string,number>={};for(const t of metadata.territories)counts[t.sourceCountryId]=(counts[t.sourceCountryId]??0)+1;
      const target=Object.entries(counts).filter(([id])=>id!=='RUS').sort((a,b)=>b[1]-a[1])[0][0];
      const ids=metadata.territories.filter((t:{sourceCountryId:string})=>t.sourceCountryId===target).map((t:{id:string})=>t.id).sort().slice(0,512);
      await page.goto(`${baseURL}/game#player=RUS`);await page.waitForFunction(()=>window.__PAX_CATALOG_DEBUG__?.ready(),null,{timeout:90000});
      let phase='source';
      await page.route('**/api/simulation/turn',async route=>{
        const {turnId,context:c}=route.request().postDataJSON(),eventId=`event.benchmark.${phase}`,action=c.queuedActions[0];
        const event={eventId,date:c.period.endDate,title:'Benchmark mandate',publicNarrative:'A bounded mandate.',actorCountryIds:['RUS',target],relatedFactIds:[],relatedSituationIds:[],causes:phase==='source'?[]:phase==='occupation'?[{kind:'authoritative-event',id:'event.benchmark.source'}]:[{kind:'queued-action',id:action.actionId}],outcomeCategory:phase==='color'?'domestic':'military',significance:'notable'};
        const authority={id:'tca:benchmark',actorCountryId:'RUS',targetCountryId:target,allowedTerritoryIds:ids,allowedOperations:['occupy'],validFrom:c.period.endDate,validTo:null,sourceEventId:eventId};
        const effects=phase==='source'?[]:phase==='occupation'?[
          {effectId:'effect.benchmark.grant',causedByEventId:eventId,type:'territorialAuthority.granted',authority},
          {effectId:'effect.benchmark.occupy',causedByEventId:eventId,type:'territory.occupy',actorCountryId:'RUS',targetCountryId:target,authorityId:authority.id,territoryIds:ids}]:[
          {effectId:'effect.benchmark.color',causedByEventId:eventId,type:'country.chooseMapColor',requestedMapColor:'#CC0000',authority:{id:'cpa:benchmark',actorCountryId:'RUS',targetCountryId:'RUS',validFrom:c.period.endDate,validTo:null,sourceEventId:eventId}}];
        const r={contractVersion:'turn-resolution.v1',baseSimulationRevision:c.revisions.simulation,baseWorldRevision:c.revisions.world,period:c.period,
          playerActionOutcomes:action?[{outcomeId:'outcome.benchmark',actionId:action.actionId,status:'succeeded',evidenceEventId:eventId,summary:'Color adopted',remainingConditions:[]}]:[],
          events:[event],factMutations:[],situationMutations:[],scheduledConsequences:[],worldEffects:effects,advisorSummary:'Benchmark',unresolvedQuestions:[]};
        await route.fulfill({status:200,contentType:'application/x-ndjson',body:[{version:1,turnId,sequence:0,type:'turn.started'},{version:1,turnId,sequence:1,type:'resolution.ready',resolution:r}].map(v=>JSON.stringify(v)).join('\n')+'\n'});
      });
      await page.locator('[data-menu-kind="action"]').click();
      const run=async(date:string)=>{
        await page.locator('.game-custom-date input').fill(date);const start=performance.now();await page.locator('.game-advance-submit').click();
        await expect(page.locator('.turn-status')).toHaveAttribute('data-phase','committed',{timeout:20000});
        return performance.now()-start;
      };
      await page.getByRole('checkbox',{name:'행동 없이 시간만 진행'}).check();await run('2020-01-02');
      await page.evaluate(()=>{
        const map=window.__PAX_CATALOG_DEBUG__!.inspectMap(),calls:{method:string;target?:unknown}[]=[];
        (window as unknown as {benchmarkCalls:typeof calls}).benchmarkCalls=calls;
        const original=map.setFeatureState.bind(map);map.setFeatureState=((target,state)=>{calls.push({method:'setFeatureState',target});return original(target,state);}) as typeof map.setFeatureState;
        for(const id of ['catalog-country-labels','catalog-capitals','catalog-country-glyph-fills','catalog-country-glyph-outlines','catalog-small-country-labels']){const s=map.getSource(id) as unknown as {setData:(v:unknown)=>unknown;updateData:(v:unknown)=>unknown};for(const method of ['setData','updateData'] as const){const fn=s[method].bind(s);s[method]=(v)=>{calls.push({method});return fn(v);};}}
      });
      const before=await page.evaluate(()=>window.__PAX_CATALOG_DEBUG__!.getSnapshot());phase='occupation';const occupationMs=await run('2020-01-03');
      for(const id of ids)expect(await page.evaluate(id=>window.__PAX_CATALOG_DEBUG__!.territoryState(id),id)).toMatchObject({controllerCountryId:'RUS',occupied:true});
      phase='color';await page.getByRole('checkbox',{name:'행동 없이 시간만 진행'}).uncheck();await page.locator('#game-player-action').fill('Adopt red map color');await page.locator('#game-player-action').press('Enter');
      const colorMs=await run('2020-01-04'),after=await page.evaluate(()=>window.__PAX_CATALOG_DEBUG__!.getSnapshot());
      const calls=await page.evaluate(()=>(window as unknown as {benchmarkCalls:{method:string}[]}).benchmarkCalls);
      expect(calls.filter(c=>c.method==='setData'||c.method==='updateData')).toEqual([]);expect(after.projectionBuilds).toBe(before.projectionBuilds);
      expect(after.labelLayoutRequests).toBe(before.labelLayoutRequests);expect(after.labelCountryUpdates).toBe(before.labelCountryUpdates);expect(after.labelFailures).toEqual([]);
      updates={target,occupiedTerritories:ids.length,occupationMs,colorMs,before,after,featureStateCalls:calls.length,wholeSourceSetData:0,sourceUpdateData:0};
    }
    measurements.push({mode,loadMs,coldHeap,warmHeap,warmupMs,samples,heap,updates,browserErrors:errors});await context.close();
  }
  const output=process.env.PROMPT14_PERFORMANCE_OUTPUT??'reports/prompt14/final-validation/performance';fs.mkdirSync(output,{recursive:true});fs.writeFileSync(`${output}/browser.json`,JSON.stringify({status:'pass',environment:{platform:os.platform(),cpu:os.cpus()[0].model,browser:browser.version(),viewport:{width:1440,height:900},buildMode:'Next production E2E build, single worker; isolated legacy fixture vs default V3',catalogVersion:JSON.parse(fs.readFileSync('data/catalogs/prompt14/frozen-catalog-ref.json','utf8')).ref.catalogVersion},measurements,interpretation:'Frame-time and FPS are reference-machine observations, not universal acceptance thresholds. 5-second frames and unbounded retained growth are structural failures.'},null,2));
});
