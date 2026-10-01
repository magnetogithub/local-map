import {expect,test} from "@playwright/test";
import type {Page} from "@playwright/test";

test.afterEach(async({page})=>{await page.goto("about:blank")});

const mapReadiness=async(page:Page)=>page.evaluate(()=>({
  detailedStatus:window.__PAX_MAP_DEBUG__?.getDetailedStatus?.()??"missing",
  renderSettled:window.__PAX_MAP_DEBUG__?.isRenderSettled?.()??false,
  center:window.__PAX_MAP_DEBUG__?.getCenter?.()??null,
  zoom:window.__PAX_MAP_DEBUG__?.getZoom?.()??null,
  highResolutionLayer:window.__PAX_MAP_DEBUG__?.hasLayer?.("country-fill-high")??false,
  sourceSync:window.__PAX_MAP_DEBUG__?.getMapSourceSyncSnapshot?.()??null,
}));

const waitForMapReady=async(page:Page)=>expect.poll(
  ()=>mapReadiness(page),
  {timeout:60_000,message:"map did not reach source/style/render readiness"},
).toMatchObject({
  detailedStatus:"ready",
  renderSettled:true,
  highResolutionLayer:true,
  sourceSync:{resyncRequired:false,error:null},
});

test("searches and resets the player country on reload",async({page})=>{
  await page.setViewportSize({width:1440,height:900});
  await page.goto("/");
  await expect(page.getByRole("status")).toBeHidden({timeout:90_000});
  await expect(page.locator(".app-shell")).toHaveAttribute("data-page-mode","setup");
  await expect(page.locator(".simulation-panel")).toHaveCount(0);

  await page.getByLabel("국가 검색").fill("FRA");
  await page.getByRole("option",{name:/FRA/}).click();
  await expect(page.getByRole("heading",{name:"프랑스"})).toBeVisible();
  await page.getByRole("button",{name:/프랑스.*플레이 국가/}).click();
  await expect(page).toHaveURL(/\/game$/,{timeout:30_000});
  await expect(page.locator(".app-shell")).toHaveAttribute("data-page-mode","game");
  await expect(page.getByTestId("game-screen")).toBeVisible();
  await expect(page.locator(".simulation-panel")).toHaveCount(0);
  await page.getByRole("button",{name:"국가 행동"}).click();
  await expect(page.locator(".simulation-panel")).toBeVisible();
  await expect.poll(()=>page.evaluate(()=>JSON.stringify(window.__PAX_MAP_DEBUG__?.getPlayerFilter()))).toContain("FRA");

  await page.reload();
  await expect(page).toHaveURL(/\/$/,{timeout:30_000});
  await expect(page.getByRole("status")).toBeHidden({timeout:90_000});
  await expect(page.locator(".app-shell")).toHaveAttribute("data-page-mode","setup");
  await expect.poll(()=>page.evaluate(()=>JSON.stringify(window.__PAX_MAP_DEBUG__?.getPlayerFilter()))).not.toContain("FRA");
  expect(await page.evaluate(()=>localStorage.getItem("pax-local:game-setup:v1"))).toBeNull();
  await page.getByLabel("국가 검색").fill("JPN");
  await page.getByRole("option",{name:/JPN/}).click();
  await page.getByRole("button",{name:/일본.*플레이 국가/}).click();
  await expect.poll(()=>page.evaluate(()=>JSON.stringify(window.__PAX_MAP_DEBUG__?.getPlayerFilter()))).toContain("JPN");
  expect(await page.evaluate(()=>localStorage.getItem("pax-local:game-setup:v1"))).toBeNull();
});

test("renders dynamic labels, global Admin 1, high-resolution interaction, and world copies",async({page})=>{
  test.setTimeout(300_000);
  await page.setViewportSize({width:1440,height:900});await page.goto("/");await expect(page.getByRole("status").first()).toBeHidden({timeout:90_000});
  const lowLabels=await page.evaluate(()=>window.__PAX_MAP_DEBUG__!.queryRenderedLabelIds());
  expect(lowLabels).toEqual(expect.arrayContaining(["USA","RUS","CHN"]));expect(lowLabels).not.toContain("VAT");expect(lowLabels).not.toContain("MCO");
  await page.evaluate(()=>window.__PAX_MAP_DEBUG__!.jumpTo([540,20],1.25));await expect.poll(()=>page.evaluate(()=>window.__PAX_MAP_DEBUG__!.getCenter()[0])).toBeGreaterThan(500);expect(await page.evaluate(()=>window.__PAX_MAP_DEBUG__!.queryRenderedCountryIds())).toContain("USA");
  await page.evaluate(()=>window.__PAX_MAP_DEBUG__!.jumpTo([-180,20],1.25));await page.waitForTimeout(300);expect(await page.evaluate(()=>window.__PAX_MAP_DEBUG__!.queryRenderedCountryIds())).toContain("CHN");
  await page.evaluate(()=>window.__PAX_MAP_DEBUG__!.jumpTo([-98,39],4));await expect.poll(()=>page.evaluate(()=>window.__PAX_MAP_DEBUG__!.getDetailedStatus()),{timeout:60_000}).toBe("ready");
  for(const [id,count] of Object.entries({USA:47,CHN:29,FIN:17,KAZ:15,GBR:210,FRA:94}))expect(await page.evaluate(id=>window.__PAX_MAP_DEBUG__!.getAdmin1Count(id),id)).toBe(count);
  expect(await page.evaluate(()=>window.__PAX_MAP_DEBUG__!.getUnresolvedAdmin1())).toEqual([]);expect(await page.evaluate(()=>window.__PAX_MAP_DEBUG__!.hasLayer("country-fill-high"))).toBe(true);
  await page.locator(".maplibregl-canvas").click({position:{x:430,y:360}});expect(await page.evaluate(()=>window.__PAX_MAP_DEBUG__!.getSelectedFilter())).toBeTruthy();
});

test("preserves canonical playable countries and removes technical map units",async({page})=>{
  await page.setViewportSize({width:1440,height:900});await page.goto("/");await expect(page.getByRole("status")).toBeHidden({timeout:90_000});const search=page.getByLabel("국가 검색");
  for(const query of ["KAS","KAB","시아첸","바이코누르"]){await search.fill(query);await expect(page.getByRole("option")).toHaveCount(0)}
  for(const [query,id,name] of [["PSX","PSX","팔레스타인"],["SDS","SDS","남수단"],["SOL","SOL","소말릴란드"]]){await search.fill(query);await page.getByRole("option",{name:new RegExp(id)}).click();await expect(page.getByRole("heading",{name})).toBeVisible();await page.getByRole("button",{name:new RegExp(`${name}.*플레이 국가`)}).click();await expect.poll(()=>page.evaluate(()=>JSON.stringify(window.__PAX_MAP_DEBUG__?.getPlayerFilter()))).toContain(id);expect(await page.evaluate(()=>localStorage.getItem("pax-local:game-setup:v1"))).toBeNull()}
});

test("dissolved seams select parents and do not render border layers",async({page})=>{
  test.setTimeout(300_000);await page.setViewportSize({width:1440,height:900});await page.goto("/");await expect(page.getByRole("status")).toBeHidden({timeout:90_000});
  for(const [center,boundary,countryId] of [[[77.2,35.3],[77.612503,35.399165],"IND"],[[63.3,46],[63.354097,45.566897],"KAZ"]] as const){await page.evaluate(({center})=>window.__PAX_MAP_DEBUG__!.jumpTo([...center],7),{center});await expect.poll(()=>page.evaluate(()=>window.__PAX_MAP_DEBUG__!.getDetailedStatus()),{timeout:60_000}).toBe("ready");const boundaryPoint=await page.evaluate(boundary=>window.__PAX_MAP_DEBUG__!.project([...boundary]),boundary);const layers=await page.evaluate(point=>window.__PAX_MAP_DEBUG__!.getRenderedLayersAt(point),boundaryPoint);expect(layers).not.toContain("country-borders-high");expect(layers).not.toContain("admin1-boundaries");const centerPoint=await page.evaluate(center=>window.__PAX_MAP_DEBUG__!.project([...center]),center);await page.locator(".maplibregl-canvas").click({position:{x:centerPoint[0],y:centerPoint[1]}});await expect.poll(()=>page.evaluate(()=>JSON.stringify(window.__PAX_MAP_DEBUG__!.getSelectedFilter()))).toContain(countryId)}
  await page.evaluate(()=>window.__PAX_MAP_DEBUG__!.jumpTo([179.2,66],5.5));await waitForMapReady(page);const seam=await page.evaluate(()=>window.__PAX_MAP_DEBUG__!.project([179.99,66]));const seamLayers=await page.evaluate(point=>window.__PAX_MAP_DEBUG__!.getRenderedLayersAt(point),seam);expect(seamLayers).not.toContain("country-borders-high");expect(seamLayers).not.toContain("admin1-boundaries");
});

test("uses feature minZoom for point labels and crosses world copies by mouse drag",async({page})=>{
  test.setTimeout(300_000);await page.setViewportSize({width:1440,height:900});await page.goto("/");await expect(page.getByRole("status")).toBeHidden({timeout:90_000});
  await page.evaluate(()=>window.__PAX_MAP_DEBUG__!.jumpTo([12.453,41.903],5.2));await expect.poll(()=>page.evaluate(()=>window.__PAX_MAP_DEBUG__!.getDetailedStatus()),{timeout:60_000}).toBe("ready");expect(await page.evaluate(()=>window.__PAX_MAP_DEBUG__!.queryRenderedLabelIds())).not.toContain("VAT");await page.evaluate(()=>window.__PAX_MAP_DEBUG__!.jumpTo([12.453,41.903],7));await expect.poll(()=>page.evaluate(()=>window.__PAX_MAP_DEBUG__!.queryRenderedLabelIds()),{timeout:15_000}).toContain("VAT");
  await page.evaluate(()=>window.__PAX_MAP_DEBUG__!.jumpTo([179,20],1.25));const canvas=page.locator(".maplibregl-canvas");const box=await canvas.boundingBox();if(!box)throw new Error("map canvas missing");for(let i=0;i<4;i++){await page.mouse.move(box.x+250,box.y+400);await page.mouse.down();await page.mouse.move(box.x+850,box.y+400,{steps:12});await page.mouse.up()}await expect.poll(()=>page.evaluate(()=>window.__PAX_MAP_DEBUG__!.isRenderSettled()),{timeout:30_000}).toBe(true);expect(await page.evaluate(()=>window.__PAX_MAP_DEBUG__!.getCenter()[0])).toBeLessThan(175);expect(await page.evaluate(()=>window.__PAX_MAP_DEBUG__!.queryRenderedCountryIds())).toContain("USA");expect(await page.evaluate(()=>window.__PAX_MAP_DEBUG__!.queryRenderedLabelIds())).toContain("USA");
});

test("renders geometry labels and preserves Point fallback",async({page})=>{
  test.setTimeout(300_000);await page.setViewportSize({width:1440,height:900});await page.goto("/");await expect(page.getByRole("status")).toBeHidden({timeout:90_000});
  for(const [center,id,label] of [[[-105,50],"USA","미합중국"],[[104,35],"CHN","중화인민공화국"],[[90,60],"RUS","러시아"]] as const){await page.evaluate(({center})=>window.__PAX_MAP_DEBUG__!.jumpTo([...center],2.1),{center});await expect.poll(()=>page.evaluate(()=>window.__PAX_MAP_DEBUG__!.isRenderSettled()),{timeout:30_000}).toBe(true);const bounds=await page.evaluate(id=>window.__PAX_MAP_DEBUG__!.getCountryLabelRendererBounds?.(id)??[],id);expect(bounds).toHaveLength(1);expect(bounds[0]).toMatchObject({renderer:"glyph-geometry",layerId:"country-label-glyph-fills",primitiveCount:Array.from(label).length})}
  await page.evaluate(()=>{window.__PAX_MAP_DEBUG__!.jumpTo([12.453,41.903],7);window.__PAX_MAP_DEBUG__!.showOnlyCountryLabel?.("VAT")});await expect.poll(()=>page.evaluate(()=>window.__PAX_MAP_DEBUG__!.isRenderSettled()),{timeout:60_000}).toBe(true);await expect.poll(()=>page.evaluate(()=>window.__PAX_MAP_DEBUG__!.getRawRenderedCountryLabels().filter(label=>label.countryId==="VAT").length),{timeout:15_000}).toBe(1);const vat=await page.evaluate(()=>window.__PAX_MAP_DEBUG__!.getRawRenderedCountryLabels().find(label=>label.countryId==="VAT"));expect(vat?.layerId).toBe("country-labels-ultra-small");expect(await page.evaluate(()=>!window.__PAX_MAP_DEBUG__!.hasLayer("country-labels-prototype")&&!window.__PAX_MAP_DEBUG__!.hasLayer("country-labels-territory"))).toBe(true);
});

test("splits China, merges 31 countries, and rolls back atomically",async({page})=>{
  test.setTimeout(300_000);await page.setViewportSize({width:1440,height:900});await page.goto("/");await expect(page.getByRole("status")).toBeHidden({timeout:60_000});
  const initialRevision=Number(await page.locator(".app-shell").getAttribute("data-world-revision"));
  await page.evaluate(()=>window.__PAX_MAP_DEBUG__!.jumpTo([104,35],4));await expect.poll(()=>page.evaluate(()=>window.__PAX_MAP_DEBUG__!.getDetailedStatus()),{timeout:60_000}).toBe("ready");
  const unchangedFranceId=await page.evaluate(async()=>
    (await window.__PAX_MAP_DEBUG__!.getMapSourceFeatures!("countries-low")).find(feature=>feature.countryId==="FRA")?.id);
  expect(unchangedFranceId).toBeTruthy();
  await page.evaluate(()=>window.__PAX_MAP_DEBUG__!.setCountryInteractionState?.({selectedCountryId:"CHN"}));
  expect(JSON.stringify(await page.evaluate(()=>window.__PAX_MAP_DEBUG__!.getSelectedFilter()))).toContain("CHN");
  const splitTiming=await page.evaluate(async()=>{const started=performance.now();const result=await window.__PAX_MAP_DEBUG__!.splitChinaIntoProvinceCountries!();return {result,elapsedMs:performance.now()-started}});const applied=splitTiming.result;expect(splitTiming.elapsedMs).toBeLessThan(30_000);expect(applied.active).toBe(true);expect(applied.provinceCountryIds).toHaveLength(31);expect(new Set(applied.provinceCountryIds).size).toBe(31);expect(applied.provinceCountryIds.every(id=>/^[A-Z][A-Z0-9]{2}$/.test(id))).toBe(true);const beijingCountryId=applied.countryIdBySourceId["CHN-BJ"];expect(beijingCountryId).toMatch(/^D[A-Z0-9]{2}$/);
  expect(await page.evaluate(()=>window.__PAX_MAP_DEBUG__!.getMapSourceSyncSnapshot!())).toMatchObject({resyncRequired:false,error:null});
  await expect.poll(()=>page.evaluate(()=>window.__PAX_MAP_DEBUG__?.getMapProjectionRevision?.()),{timeout:60_000}).toBe(initialRevision+2);
  await expect.poll(()=>page.evaluate(()=>window.__PAX_MAP_DEBUG__?.getMapSourceSyncSnapshot?.().sources["countries-low"]?.revision)).toBe(initialRevision+2);
  const splitSync=await page.evaluate(()=>window.__PAX_MAP_DEBUG__!.getMapSourceSyncSnapshot!());
  expect(splitSync.resyncRequired).toBe(false);
  expect(splitSync.sources["countries-low"]?.mode).toBe("diff");
  expect(splitSync.sources["countries-high"]?.revision).toBe(initialRevision+2);
  expect(splitSync.sources["borders-low"]?.revision).toBe(initialRevision+2);
  expect(splitSync.sources["borders-high"]?.revision).toBe(initialRevision+2);
  expect(splitSync.sources["countries-low"]?.changedIds).not.toContain(unchangedFranceId);
  await expect.poll(()=>page.evaluate(async()=>
    (await window.__PAX_MAP_DEBUG__!.getMapSourceFeatures!("countries-low")).map(feature=>feature.countryId)),{timeout:60_000}).toContain(beijingCountryId);
  const splitSource=await page.evaluate(()=>window.__PAX_MAP_DEBUG__!.getMapSourceFeatures!("countries-high"));
  expect(splitSource.map(feature=>feature.countryId)).not.toContain("CHN");
  expect(new Set(splitSource.map(feature=>feature.id)).size).toBe(splitSource.length);
  const provinceIdSet=new Set(applied.provinceCountryIds);
  expect(new Set(splitSource.filter(feature=>feature.countryId&&provinceIdSet.has(feature.countryId)).map(feature=>feature.mapColor)).size).toBeGreaterThan(6);
  const splitBorders=await page.evaluate(()=>window.__PAX_MAP_DEBUG__!.getMapSourceFeatures!("borders-high"));
  expect(splitBorders.some(feature=>feature.countryId!==null&&provinceIdSet.has(feature.countryId))).toBe(true);
  await expect.poll(()=>page.evaluate(()=>window.__PAX_MAP_DEBUG__!.queryRenderedCountryIds()),{timeout:30_000}).not.toContain("CHN");const splitIds=await page.evaluate(()=>window.__PAX_MAP_DEBUG__!.queryRenderedCountryIds());expect(splitIds.some(id=>provinceIdSet.has(id))).toBe(true);
  await expect.poll(()=>page.evaluate(()=>JSON.stringify(window.__PAX_MAP_DEBUG__!.getSelectedFilter()))).not.toContain("CHN");
  await expect.poll(()=>page.evaluate(countryId=>window.__PAX_MAP_DEBUG__!.getCountryFocus?.(countryId)?.center[0]??null,beijingCountryId),{timeout:30_000}).toBeGreaterThan(110);
  await page.evaluate(id=>{window.__PAX_MAP_DEBUG__!.setCountryInteractionState?.({selectedCountryId:id});window.dispatchEvent(new CustomEvent("pax:focus-country",{detail:id}))},beijingCountryId);
  await expect.poll(()=>page.evaluate(()=>JSON.stringify(window.__PAX_MAP_DEBUG__!.getSelectedFilter()))).toContain(beijingCountryId);
  await expect.poll(()=>page.evaluate(()=>window.__PAX_MAP_DEBUG__!.getCenter()[0]),{timeout:15_000}).toBeGreaterThan(110);
  const mergeTiming=await page.evaluate(async()=>{const started=performance.now();const result=await window.__PAX_MAP_DEBUG__!.mergeChinaProvinceCountries!();return {result,elapsedMs:performance.now()-started}});expect(mergeTiming.elapsedMs).toBeLessThan(30_000);expect(mergeTiming.result.mergedCountryId).toMatch(/^D[A-Z0-9]{2}$/);expect(mergeTiming.result.sourceCountryIds).toHaveLength(31);const mergedCountryId=mergeTiming.result.mergedCountryId;
  await expect.poll(()=>page.evaluate(()=>window.__PAX_MAP_DEBUG__?.getMapProjectionRevision?.()),{timeout:60_000}).toBe(initialRevision+3);
  const mergedCountries=await page.evaluate(()=>window.__PAX_MAP_DEBUG__!.getMapSourceFeatures!("countries-high"));
  expect(mergedCountries.filter(feature=>feature.countryId===mergedCountryId)).toHaveLength(31);
  expect(mergedCountries.some(feature=>feature.countryId!==mergedCountryId&&feature.countryId!==null&&provinceIdSet.has(feature.countryId))).toBe(false);
  const mergedBorders=await page.evaluate(()=>window.__PAX_MAP_DEBUG__!.getMapSourceFeatures!("borders-high"));
  expect(mergedBorders.some(feature=>feature.countryId!==null&&provinceIdSet.has(feature.countryId))).toBe(false);
  expect(mergedBorders.some(feature=>feature.countryId===mergedCountryId&&feature.classification==="internal")).toBe(false);
  await expect.poll(()=>page.evaluate(()=>JSON.stringify(window.__PAX_MAP_DEBUG__!.getSelectedFilter()))).not.toContain(beijingCountryId);
  await page.evaluate(id=>{window.__PAX_MAP_DEBUG__!.setCountryInteractionState?.({selectedCountryId:id});window.dispatchEvent(new CustomEvent("pax:focus-country",{detail:id}))},mergedCountryId);
  await expect.poll(()=>page.evaluate(()=>JSON.stringify(window.__PAX_MAP_DEBUG__!.getSelectedFilter()))).toContain(mergedCountryId);
  const rollbackTiming=await page.evaluate(async()=>{const started=performance.now();const result=await window.__PAX_MAP_DEBUG__!.rollbackChinaProvinceCountries!();return {result,elapsedMs:performance.now()-started}});const rolledBack=rollbackTiming.result;expect(rollbackTiming.elapsedMs).toBeLessThan(30_000);expect(rolledBack).toEqual({active:false,restoredCountryId:"CHN"});await expect.poll(()=>page.evaluate(()=>window.__PAX_MAP_DEBUG__!.queryRenderedCountryIds()),{timeout:30_000}).toContain("CHN");const restoredIds=await page.evaluate(()=>window.__PAX_MAP_DEBUG__!.queryRenderedCountryIds());expect(restoredIds.some(id=>provinceIdSet.has(id)||id===mergedCountryId)).toBe(false);expect(await page.evaluate(()=>window.__PAX_MAP_DEBUG__!.getChinaProvinceScenario!())).toEqual({active:false,provinceCountryIds:[],countryIdBySourceId:{},mergedCountryId:null});
  await expect.poll(()=>page.evaluate(()=>window.__PAX_MAP_DEBUG__?.getMapProjectionRevision?.()),{timeout:60_000}).toBe(initialRevision+4);
  await expect.poll(()=>page.evaluate(async()=>
    (await window.__PAX_MAP_DEBUG__!.getMapSourceFeatures!("countries-high")).map(feature=>feature.countryId)),{timeout:60_000}).toContain("CHN");
  const rollbackSync=await page.evaluate(()=>window.__PAX_MAP_DEBUG__!.getMapSourceSyncSnapshot!());
  expect(rollbackSync.resyncRequired).toBe(false);
  expect(rollbackSync.sources["countries-low"]?.mode).toBe("diff");
  expect(rollbackSync.sources["countries-high"]?.revision).toBe(initialRevision+4);
  expect(rollbackSync.sources["borders-low"]?.revision).toBe(initialRevision+4);
  expect(rollbackSync.sources["borders-high"]?.revision).toBe(initialRevision+4);
  expect(rollbackSync.sources["countries-low"]?.changedIds).not.toContain(unchangedFranceId);
  await expect.poll(()=>page.evaluate(()=>JSON.stringify(window.__PAX_MAP_DEBUG__!.getSelectedFilter()))).not.toContain(mergedCountryId);
});

test("splits the USA into 50 state countries, merges them, and rolls back atomically",async({page})=>{
  test.setTimeout(300_000);
  await page.setViewportSize({width:1440,height:900});
  await page.goto("/");
  await expect(page.getByRole("status")).toBeHidden({timeout:90_000});
  const initialRevision=Number(await page.locator(".app-shell").getAttribute("data-world-revision"));
  await page.evaluate(()=>window.__PAX_MAP_DEBUG__!.jumpTo([-98,39],4));
  await expect.poll(()=>page.evaluate(()=>window.__PAX_MAP_DEBUG__!.getDetailedStatus()),{timeout:60_000}).toBe("ready");
  const unchangedFranceId=await page.evaluate(async()=>(await window.__PAX_MAP_DEBUG__!.getMapSourceFeatures!("countries-low")).find(feature=>feature.countryId==="FRA")?.id);

  const splitTiming=await page.evaluate(async()=>{
    const started=performance.now();
    const result=await window.__PAX_MAP_DEBUG__!.splitUnitedStatesIntoStateCountries!();
    return {result,elapsedMs:performance.now()-started};
  });
  const applied=splitTiming.result;
  expect(splitTiming.elapsedMs).toBeLessThan(45_000);
  expect(applied.stateCountryIds).toHaveLength(50);
  expect(new Set(applied.stateCountryIds).size).toBe(50);
  expect(applied.stateCountryIds.every(id=>/^[A-Z][A-Z0-9]{2}$/.test(id))).toBe(true);
  expect(applied.countryIdBySourceId["USA-DC"]).toBeUndefined();
  const californiaCountryId=applied.countryIdBySourceId["USA-CA"];
  expect(californiaCountryId).toMatch(/^D[A-Z0-9]{2}$/);

  await expect.poll(()=>page.evaluate(()=>window.__PAX_MAP_DEBUG__!.getMapProjectionRevision?.()),{timeout:60_000}).toBe(initialRevision+2);
  const splitSource=await page.evaluate(()=>window.__PAX_MAP_DEBUG__!.getMapSourceFeatures!("countries-high"));
  const stateIdSet=new Set(applied.stateCountryIds);
  expect(splitSource.map(feature=>feature.countryId)).not.toContain("USA");
  expect(splitSource.filter(feature=>feature.countryId!==null&&stateIdSet.has(feature.countryId))).toHaveLength(50);
  expect(new Set(splitSource.filter(feature=>feature.countryId!==null&&stateIdSet.has(feature.countryId)).map(feature=>feature.mapColor)).size).toBeGreaterThan(10);
  const splitBorders=await page.evaluate(()=>window.__PAX_MAP_DEBUG__!.getMapSourceFeatures!("borders-high"));
  expect(splitBorders.some(feature=>feature.countryId!==null&&stateIdSet.has(feature.countryId))).toBe(true);
  expect((await page.evaluate(()=>window.__PAX_MAP_DEBUG__!.getMapSourceSyncSnapshot!())).resyncRequired).toBe(false);
  await expect.poll(()=>page.evaluate(countryId=>window.__PAX_MAP_DEBUG__!.getCountryFocus?.(countryId)?.center[0]??null,californiaCountryId),{timeout:30_000}).toBeLessThan(-110);
  await page.evaluate(id=>{window.__PAX_MAP_DEBUG__!.setCountryInteractionState?.({selectedCountryId:id});window.dispatchEvent(new CustomEvent("pax:focus-country",{detail:id}))},californiaCountryId);
  await expect.poll(()=>page.evaluate(()=>window.__PAX_MAP_DEBUG__!.getCenter()[0]),{timeout:15_000}).toBeLessThan(-110);

  const mergeTiming=await page.evaluate(async()=>{
    const started=performance.now();
    const result=await window.__PAX_MAP_DEBUG__!.mergeUnitedStatesStateCountries!();
    return {result,elapsedMs:performance.now()-started};
  });
  expect(mergeTiming.elapsedMs).toBeLessThan(45_000);
  expect(mergeTiming.result.sourceCountryIds).toHaveLength(50);
  const mergedCountryId=mergeTiming.result.mergedCountryId;
  expect(mergedCountryId).toMatch(/^D[A-Z0-9]{2}$/);
  await expect.poll(()=>page.evaluate(()=>window.__PAX_MAP_DEBUG__!.getMapProjectionRevision?.()),{timeout:60_000}).toBe(initialRevision+3);
  const mergedSource=await page.evaluate(()=>window.__PAX_MAP_DEBUG__!.getMapSourceFeatures!("countries-high"));
  expect(mergedSource.filter(feature=>feature.countryId===mergedCountryId)).toHaveLength(50);
  expect(mergedSource.some(feature=>feature.countryId!==null&&stateIdSet.has(feature.countryId))).toBe(false);
  const mergedBorders=await page.evaluate(()=>window.__PAX_MAP_DEBUG__!.getMapSourceFeatures!("borders-high"));
  expect(mergedBorders.some(feature=>feature.countryId===mergedCountryId&&feature.classification==="internal")).toBe(false);

  const rolledBack=await page.evaluate(()=>window.__PAX_MAP_DEBUG__!.rollbackUnitedStatesStateCountries!());
  expect(rolledBack).toEqual({active:false,restoredCountryId:"USA"});
  await expect.poll(()=>page.evaluate(()=>window.__PAX_MAP_DEBUG__!.getMapProjectionRevision?.()),{timeout:60_000}).toBe(initialRevision+4);
  const restoredSource=await page.evaluate(()=>window.__PAX_MAP_DEBUG__!.getMapSourceFeatures!("countries-high"));
  expect(restoredSource.map(feature=>feature.countryId)).toContain("USA");
  expect(restoredSource.some(feature=>feature.countryId!==null&&(stateIdSet.has(feature.countryId)||feature.countryId===mergedCountryId))).toBe(false);
  expect(await page.evaluate(()=>window.__PAX_MAP_DEBUG__!.getUnitedStatesStateScenario!())).toEqual({active:false,stateCountryIds:[],countryIdBySourceId:{},mergedCountryId:null});
  const rollbackSync=await page.evaluate(()=>window.__PAX_MAP_DEBUG__!.getMapSourceSyncSnapshot!());
  expect(rollbackSync.resyncRequired).toBe(false);
  expect(rollbackSync.sources["countries-low"]?.changedIds).not.toContain(unchangedFranceId);
});

for(const size of [{width:1280,height:720},{width:1920,height:1080},{width:2560,height:1440}]){
  test(`desktop layout ${size.width}x${size.height}`,async({page})=>{
    await page.setViewportSize(size);
    await page.goto("/");
    await expect(page.getByRole("status")).toBeHidden({timeout:90_000});
    await expect(page.getByTestId("world-map")).toBeVisible();
    await expect(page.getByLabel("국가 검색")).toBeVisible();
  });
}
