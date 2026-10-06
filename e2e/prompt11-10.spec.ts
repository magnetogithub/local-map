import {expect,test} from "./catalog-fixture";

test("V3 catalog source, selection, focus, and revision agree",async({page})=>{
  test.setTimeout(120_000);
  await page.setViewportSize({width:1440,height:900});
  await page.goto("/");
  await expect(page.getByRole("status").first()).toBeHidden({timeout:60_000});
  const revision=Number(await page.locator(".app-shell").getAttribute("data-world-revision"));
  await expect.poll(()=>page.evaluate(()=>window.__PAX_CATALOG_DEBUG__?.projectionRevision())).toBe(revision);
  const initialSource=await page.evaluate(()=>window.__PAX_CATALOG_DEBUG__!.territoryFeatures());
  expect(new Set(initialSource.map(feature=>feature.id)).size).toBe(initialSource.length);
  expect(initialSource.some(feature=>feature.countryId==="USA")).toBe(true);
  expect(initialSource.find(feature=>feature.countryId==="CHN")?.mapColor).toBe("#88494A");
  expect(initialSource.find(feature=>feature.countryId==="RUS")?.mapColor).toBe("#3B5E4D");
  expect(await page.evaluate(()=>window.__PAX_CATALOG_DEBUG__!.getSnapshot())).toMatchObject({fullProjectionBuilds:1,labelFailures:[]});
  await expect.poll(()=>page.evaluate(()=>window.__PAX_CATALOG_DEBUG__?.renderedLabelIds())).toContain("FRA");

  await page.getByLabel("국가 검색").fill("FRA");
  await page.getByRole("option",{name:/FRA/}).click();
  await expect.poll(()=>page.evaluate(()=>JSON.stringify(window.__PAX_CATALOG_DEBUG__?.selectedCountry()))).toContain("FRA");
  await page.evaluate(()=>window.dispatchEvent(new CustomEvent("pax:focus-country",{detail:"FRA"})));
  await expect.poll(()=>page.evaluate(()=>window.__PAX_CATALOG_DEBUG__?.inspectMap().getCenter().lng)).toBeGreaterThan(-5);
  await expect.poll(()=>page.evaluate(()=>window.__PAX_CATALOG_DEBUG__?.inspectMap().getCenter().lng)).toBeLessThan(12);
  expect(await page.evaluate(()=>window.__PAX_CATALOG_DEBUG__?.projectionRevision())).toBe(revision);
});
