import {expect,test} from "@playwright/test";

test("v2 map source, selection, focus, and revision agree",async({page})=>{
  test.setTimeout(120_000);
  await page.setViewportSize({width:1440,height:900});
  await page.goto("/");
  await expect(page.getByRole("status").first()).toBeHidden({timeout:60_000});
  const revision=Number(await page.locator(".app-shell").getAttribute("data-world-revision"));
  await expect.poll(()=>page.evaluate(()=>window.__PAX_MAP_DEBUG__?.getMapProjectionRevision?.())).toBe(revision);
  const initialSource=await page.evaluate(()=>window.__PAX_MAP_DEBUG__!.getMapSourceFeatures!("countries-low"));
  expect(new Set(initialSource.map(feature=>feature.id)).size).toBe(initialSource.length);
  expect(initialSource.some(feature=>feature.countryId==="USA")).toBe(true);
  expect(initialSource.find(feature=>feature.countryId==="CHN")?.mapColor).toBe("#88494a");
  expect(initialSource.find(feature=>feature.countryId==="RUS")?.mapColor).toBe("#3b5e4d");
  expect(await page.evaluate(()=>window.__PAX_MAP_DEBUG__!.getMapSourceSyncSnapshot!())).toMatchObject({resyncRequired:false,error:null});
  await expect.poll(()=>page.evaluate(()=>window.__PAX_MAP_DEBUG__?.queryRenderedCountryIds())).toContain("FRA");

  await page.getByLabel("국가 검색").fill("FRA");
  await page.getByRole("option",{name:/FRA/}).click();
  await expect.poll(()=>page.evaluate(()=>JSON.stringify(window.__PAX_MAP_DEBUG__?.getSelectedFilter()))).toContain("FRA");
  await page.evaluate(()=>window.dispatchEvent(new CustomEvent("pax:focus-country",{detail:"FRA"})));
  await expect.poll(()=>page.evaluate(()=>window.__PAX_MAP_DEBUG__?.getCenter()[0])).toBeGreaterThan(-5);
  await expect.poll(()=>page.evaluate(()=>window.__PAX_MAP_DEBUG__?.getCenter()[0])).toBeLessThan(12);
  expect(await page.evaluate(()=>window.__PAX_MAP_DEBUG__?.getMapProjectionRevision?.())).toBe(revision);
});
