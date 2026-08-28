import {expect,test} from "@playwright/test";

test.afterEach(async({page})=>{await page.goto("about:blank")});

test("searches, restores, and replaces the player country",async({page})=>{
  await page.setViewportSize({width:1440,height:900});
  await page.goto("/");
  await expect(page.getByRole("status")).toBeHidden({timeout:30_000});

  await page.getByLabel("국가 검색").fill("FRA");
  await page.getByRole("option",{name:/FRA/}).click();
  await expect(page.getByRole("heading",{name:"프랑스"})).toBeVisible();
  await page.getByRole("button",{name:/프랑스.*플레이 국가/}).click();
  await expect.poll(()=>page.evaluate(()=>JSON.stringify(window.__PAX_MAP_DEBUG__?.getPlayerFilter()))).toContain("FRA");

  await page.reload();
  await expect(page.getByRole("status")).toBeHidden({timeout:30_000});
  await expect.poll(()=>page.evaluate(()=>JSON.stringify(window.__PAX_MAP_DEBUG__?.getPlayerFilter()))).toContain("FRA");
  await page.getByLabel("국가 검색").fill("JPN");
  await page.getByRole("option",{name:/JPN/}).click();
  await page.getByRole("button",{name:/일본.*플레이 국가/}).click();
  await expect.poll(()=>page.evaluate(()=>JSON.parse(localStorage.getItem("pax-local:game-setup:v1")!).playerCountryId)).toBe("JPN");
});

test("renders dynamic labels, global Admin 1, high-resolution interaction, and world copies",async({page})=>{
  test.setTimeout(120_000);
  await page.setViewportSize({width:1440,height:900});await page.goto("/");await expect(page.getByRole("status").first()).toBeHidden({timeout:30_000});
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
  await page.setViewportSize({width:1440,height:900});await page.goto("/");await expect(page.getByRole("status")).toBeHidden({timeout:30_000});const search=page.getByLabel("국가 검색");
  for(const query of ["KAS","KAB","시아첸","바이코누르"]){await search.fill(query);await expect(page.getByRole("option")).toHaveCount(0)}
  for(const [query,id,name] of [["PSX","PSX","팔레스타인"],["SDS","SDS","남수단"],["SOL","SOL","소말릴란드"]]){await search.fill(query);await page.getByRole("option",{name:new RegExp(id)}).click();await expect(page.getByRole("heading",{name})).toBeVisible();await page.getByRole("button",{name:new RegExp(`${name}.*플레이 국가`)}).click();await expect.poll(()=>page.evaluate(()=>JSON.parse(localStorage.getItem("pax-local:game-setup:v1")!).playerCountryId)).toBe(id)}
});

test("dissolved seams select parents and do not render border layers",async({page})=>{
  test.setTimeout(180_000);await page.setViewportSize({width:1440,height:900});await page.goto("/");await expect(page.getByRole("status")).toBeHidden({timeout:30_000});
  for(const [center,boundary,countryId] of [[[77.2,35.3],[77.612503,35.399165],"IND"],[[63.3,46],[63.354097,45.566897],"KAZ"]] as const){await page.evaluate(({center})=>window.__PAX_MAP_DEBUG__!.jumpTo([...center],7),{center});await expect.poll(()=>page.evaluate(()=>window.__PAX_MAP_DEBUG__!.getDetailedStatus()),{timeout:60_000}).toBe("ready");const boundaryPoint=await page.evaluate(boundary=>window.__PAX_MAP_DEBUG__!.project([...boundary]),boundary);const layers=await page.evaluate(point=>window.__PAX_MAP_DEBUG__!.getRenderedLayersAt(point),boundaryPoint);expect(layers).not.toContain("country-borders-high");expect(layers).not.toContain("admin1-boundaries");const centerPoint=await page.evaluate(center=>window.__PAX_MAP_DEBUG__!.project([...center]),center);await page.locator(".maplibregl-canvas").click({position:{x:centerPoint[0],y:centerPoint[1]}});await expect.poll(()=>page.evaluate(()=>JSON.stringify(window.__PAX_MAP_DEBUG__!.getSelectedFilter()))).toContain(countryId)}
  await page.evaluate(()=>window.__PAX_MAP_DEBUG__!.jumpTo([179.2,66],5.5));await expect.poll(()=>page.evaluate(()=>window.__PAX_MAP_DEBUG__!.isRenderSettled())).toBe(true);const seam=await page.evaluate(()=>window.__PAX_MAP_DEBUG__!.project([179.99,66]));const seamLayers=await page.evaluate(point=>window.__PAX_MAP_DEBUG__!.getRenderedLayersAt(point),seam);expect(seamLayers).not.toContain("country-borders-high");expect(seamLayers).not.toContain("admin1-boundaries");
});

test("uses feature minZoom for point labels and crosses world copies by mouse drag",async({page})=>{
  test.setTimeout(240_000);await page.setViewportSize({width:1440,height:900});await page.goto("/");await expect(page.getByRole("status")).toBeHidden({timeout:30_000});
  await page.evaluate(()=>window.__PAX_MAP_DEBUG__!.jumpTo([12.453,41.903],5.2));await expect.poll(()=>page.evaluate(()=>window.__PAX_MAP_DEBUG__!.getDetailedStatus()),{timeout:60_000}).toBe("ready");expect(await page.evaluate(()=>window.__PAX_MAP_DEBUG__!.queryRenderedLabelIds())).not.toContain("VAT");await page.evaluate(()=>window.__PAX_MAP_DEBUG__!.jumpTo([12.453,41.903],7));await expect.poll(()=>page.evaluate(()=>window.__PAX_MAP_DEBUG__!.queryRenderedLabelIds()),{timeout:15_000}).toContain("VAT");
  await page.evaluate(()=>window.__PAX_MAP_DEBUG__!.jumpTo([179,20],1.25));const canvas=page.locator(".maplibregl-canvas");const box=await canvas.boundingBox();if(!box)throw new Error("map canvas missing");for(let i=0;i<4;i++){await page.mouse.move(box.x+250,box.y+400);await page.mouse.down();await page.mouse.move(box.x+850,box.y+400,{steps:12});await page.mouse.up()}await expect.poll(()=>page.evaluate(()=>window.__PAX_MAP_DEBUG__!.isRenderSettled()),{timeout:30_000}).toBe(true);expect(await page.evaluate(()=>window.__PAX_MAP_DEBUG__!.getCenter()[0])).toBeLessThan(175);expect(await page.evaluate(()=>window.__PAX_MAP_DEBUG__!.queryRenderedCountryIds())).toContain("USA");expect(await page.evaluate(()=>window.__PAX_MAP_DEBUG__!.queryRenderedLabelIds())).toContain("USA");
});

test("renders geometry labels and preserves Point fallback",async({page})=>{
  test.setTimeout(120_000);await page.setViewportSize({width:1440,height:900});await page.goto("/");await expect(page.getByRole("status")).toBeHidden({timeout:30_000});
  for(const [center,id,label] of [[[-105,50],"USA","미합중국"],[[104,35],"CHN","중화인민공화국"],[[90,60],"RUS","러시아"]] as const){await page.evaluate(({center})=>window.__PAX_MAP_DEBUG__!.jumpTo([...center],2.1),{center});await expect.poll(()=>page.evaluate(()=>window.__PAX_MAP_DEBUG__!.isRenderSettled()),{timeout:30_000}).toBe(true);const bounds=await page.evaluate(id=>window.__PAX_MAP_DEBUG__!.getCountryLabelRendererBounds?.(id)??[],id);expect(bounds).toHaveLength(1);expect(bounds[0]).toMatchObject({renderer:"glyph-geometry",layerId:"country-label-glyph-fills",primitiveCount:Array.from(label).length})}
  await page.evaluate(()=>{window.__PAX_MAP_DEBUG__!.jumpTo([12.453,41.903],7);window.__PAX_MAP_DEBUG__!.showOnlyCountryLabel?.("VAT")});await expect.poll(()=>page.evaluate(()=>window.__PAX_MAP_DEBUG__!.isRenderSettled()),{timeout:60_000}).toBe(true);await expect.poll(()=>page.evaluate(()=>window.__PAX_MAP_DEBUG__!.getRawRenderedCountryLabels().filter(label=>label.countryId==="VAT").length),{timeout:15_000}).toBe(1);const vat=await page.evaluate(()=>window.__PAX_MAP_DEBUG__!.getRawRenderedCountryLabels().find(label=>label.countryId==="VAT"));expect(vat?.layerId).toBe("country-labels-ultra-small");expect(await page.evaluate(()=>!window.__PAX_MAP_DEBUG__!.hasLayer("country-labels-prototype")&&!window.__PAX_MAP_DEBUG__!.hasLayer("country-labels-territory"))).toBe(true);
});

test("splits China into 31 temporary province countries and rolls back atomically",async({page})=>{
  test.setTimeout(120_000);await page.setViewportSize({width:1440,height:900});await page.goto("/");await expect(page.getByRole("status")).toBeHidden({timeout:30_000});
  await page.evaluate(()=>window.__PAX_MAP_DEBUG__!.jumpTo([104,35],4));await expect.poll(()=>page.evaluate(()=>window.__PAX_MAP_DEBUG__!.getDetailedStatus()),{timeout:60_000}).toBe("ready");
  const applied=await page.evaluate(()=>window.__PAX_MAP_DEBUG__!.splitChinaIntoProvinceCountries!());expect(applied.active).toBe(true);expect(applied.provinceCountryIds).toHaveLength(31);expect(new Set(applied.provinceCountryIds).size).toBe(31);expect(applied.provinceCountryIds).toContain("CHN-BJ");
  await expect.poll(()=>page.evaluate(()=>window.__PAX_MAP_DEBUG__!.queryRenderedCountryIds()),{timeout:30_000}).not.toContain("CHN");const splitIds=await page.evaluate(()=>window.__PAX_MAP_DEBUG__!.queryRenderedCountryIds());expect(splitIds.some(id=>id.startsWith("CHN-"))).toBe(true);
  const rolledBack=await page.evaluate(()=>window.__PAX_MAP_DEBUG__!.rollbackChinaProvinceCountries!());expect(rolledBack).toEqual({active:false,restoredCountryId:"CHN"});await expect.poll(()=>page.evaluate(()=>window.__PAX_MAP_DEBUG__!.queryRenderedCountryIds()),{timeout:30_000}).toContain("CHN");const restoredIds=await page.evaluate(()=>window.__PAX_MAP_DEBUG__!.queryRenderedCountryIds());expect(restoredIds.some(id=>id.startsWith("CHN-"))).toBe(false);expect(await page.evaluate(()=>window.__PAX_MAP_DEBUG__!.getChinaProvinceScenario!())).toEqual({active:false,provinceCountryIds:[]});
});

for(const size of [{width:1280,height:720},{width:1920,height:1080},{width:2560,height:1440}]){
  test(`desktop layout ${size.width}x${size.height}`,async({page})=>{
    await page.setViewportSize(size);
    await page.goto("/");
    await expect(page.getByRole("status")).toBeHidden({timeout:30_000});
    await expect(page.getByTestId("world-map")).toBeVisible();
    await expect(page.getByLabel("국가 검색")).toBeVisible();
  });
}
