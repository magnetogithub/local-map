import {test,expect} from "./legacy-fixture";
import path from "node:path";

const representative=["AUS","RUS","USA","CHN"];

test("8-5 geometry renderer integration",async({page})=>{
  await page.goto("/");
  await expect(page.getByRole("status").first()).toBeHidden({timeout:90_000});
  await expect.poll(()=>page.evaluate(()=>window.__PAX_MAP_DEBUG__?.isRenderSettled()??false),{timeout:30_000}).toBe(true);
  expect(await page.evaluate(()=>!window.__PAX_MAP_DEBUG__!.hasLayer("country-labels-prototype")&&!window.__PAX_MAP_DEBUG__!.hasLayer("country-labels-territory"))).toBe(true);
  const counts=await page.evaluate(ids=>Object.fromEntries(ids.map(id=>[id,window.__PAX_MAP_DEBUG__!.getGlyphLabelFeatureCount?.(id)??0])),representative);
  for(const id of representative)expect(counts[id]).toBeGreaterThan(0);
  await expect.poll(()=>page.evaluate(ids=>ids.every(id=>window.__PAX_MAP_DEBUG__!.getRenderedGlyphLabelIds?.().includes(id)),representative),{timeout:15_000}).toBe(true);
  const order=await page.evaluate(()=>window.__PAX_MAP_DEBUG__!.getCountryLabelLayerOrder?.()??[]),fill=order.indexOf("country-label-glyph-fills"),outline=order.indexOf("country-label-glyph-outlines");
  expect(order.indexOf("country-fill-low")).toBeLessThan(order.indexOf("country-borders-low"));expect(order.indexOf("country-borders-low")).toBeLessThan(outline);expect(outline).toBeLessThan(fill);expect(order.indexOf("selected-country-highlight-low")).toBeLessThan(fill);expect(order.indexOf("player-country-highlight-low")).toBeLessThan(fill);
  await page.screenshot({path:path.join(process.cwd(),"screenshots/fix08-5-world-default.png")});
  await expect.poll(()=>page.evaluate(()=>window.__PAX_MAP_DEBUG__!.getRenderedGlyphLabelIds?.().length),{timeout:10_000}).toBeGreaterThan(0);
  const before=await page.evaluate(()=>window.__PAX_MAP_DEBUG__!.getGlyphLabelFeatureCount?.("USA")??0);await page.evaluate(()=>window.__PAX_MAP_DEBUG__!.setCountryInteractionState?.({hoveredCountryId:"USA",selectedCountryId:"USA",playerCountryId:"USA"}));
  expect(await page.evaluate(()=>window.__PAX_MAP_DEBUG__!.getGlyphLabelFeatureCount?.("USA")??0)).toBe(before);
  expect(await page.evaluate(()=>window.__PAX_MAP_DEBUG__!.hasLayer("country-labels-small")&&window.__PAX_MAP_DEBUG__!.hasLayer("country-labels-ultra-small"))).toBe(true);
});
