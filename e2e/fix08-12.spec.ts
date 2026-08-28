import {test,expect} from "@playwright/test";
import path from "node:path";

const countries=["RUS","CHN","AUS","USA","CHL","IDN"] as const;
const expectedGlyphs={RUS:3,CHN:7,AUS:7,USA:4,CHL:2,IDN:5} as const;
const cameraZoom={RUS:2,CHN:2,AUS:2,USA:2,CHL:4,IDN:3} as const;

test("8-12 captures fixed-camera representative typography",async({page})=>{
  const phase=process.env.PAX_FIX08_12_PHASE??"after";
  await page.setViewportSize({width:1440,height:900});
  await page.goto("/");
  await expect(page.getByRole("status").first()).toBeHidden({timeout:30_000});
  const stable=async()=>{await expect.poll(()=>page.evaluate(()=>window.__PAX_MAP_DEBUG__?.isRenderSettled()??false),{timeout:60_000}).toBe(true);await page.evaluate(()=>new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve()))))};
  await stable();
  const evidence=[];
  for(const countryId of countries){
    const placement=await page.evaluate(id=>window.__PAX_MAP_DEBUG__!.getCountryLabelPlacement(id),countryId) as {anchor:[number,number]};
    await page.evaluate(({anchor,zoom})=>window.__PAX_MAP_DEBUG__!.jumpTo(anchor,zoom),{anchor:placement.anchor,zoom:cameraZoom[countryId]});
    await stable();
    const measurement=await page.evaluate(id=>{const debug=window.__PAX_MAP_DEBUG__!,bounds=debug.getCountryLabelRendererBounds?.(id)??[];return {countryId:id,center:debug.getCenter(),zoom:debug.getZoom(),glyphCount:debug.getGlyphLabelFeatureCount?.(id)??0,instanceCount:debug.getGlyphLabelInstanceCount?.(id)??0,bounds}},countryId);
    if(phase!=="before"){expect(measurement.glyphCount).toBe(expectedGlyphs[countryId]);expect(measurement.instanceCount).toBe(1);expect(measurement.bounds).toHaveLength(1);const bound=measurement.bounds[0] as {left:number;right:number;top:number;bottom:number};expect(bound.left).toBeGreaterThanOrEqual(0);expect(bound.top).toBeGreaterThanOrEqual(0);expect(bound.right).toBeLessThanOrEqual(1440);expect(bound.bottom).toBeLessThanOrEqual(900)}
    evidence.push(measurement);
    const filename=phase==="fix08-13"?`fix08-13-${countryId.toLowerCase()}.png`:`fix08-12-${countryId.toLowerCase()}-${phase}.png`;
    await page.screenshot({path:path.join(process.cwd(),"screenshots",filename)});
  }
  console.log("FIX08_12_RENDER",JSON.stringify({phase,viewport:[1440,900],evidence}));
});
