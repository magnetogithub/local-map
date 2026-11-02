import {chromium} from "playwright";
import fs from "node:fs";

const baseURL=process.env.PLAYWRIGHT_BASE_URL||"http://localhost:3000",browser=await chromium.launch({headless:true});
fs.mkdirSync("screenshots",{recursive:true});
const shots=[
  ["world-hoi4-labels",[10,20],1.25],
  ["usa-admin1",[-98,39],4],["china-admin1",[104,35],4],["finland-admin1",[26,64],5],["kazakhstan-admin1",[68,48],4.5],["uk-admin1",[-3,55],5],["france-admin1",[2,46],5],
  ["europe-medium-zoom-labels",[12,50],4],["small-countries-high-zoom",[8,44],7],["dateline-world-wrap",[540,20],1.25],
];
for(const [name,center,zoom] of shots){const page=await browser.newPage({viewport:{width:1440,height:900}});await page.goto(baseURL);await page.getByRole("status").first().waitFor({state:"hidden",timeout:30000});await page.evaluate(({center,zoom})=>window.__PAX_MAP_DEBUG__?.jumpTo(center,zoom),{center,zoom});if(zoom>=2.2)await page.waitForFunction(()=>window.__PAX_MAP_DEBUG__?.getDetailedStatus()==="ready",null,{timeout:60000});await page.waitForTimeout(500);await page.screenshot({path:`screenshots/${name}.png`});await page.close()}
const page=await browser.newPage({viewport:{width:1440,height:900}});await page.goto(baseURL);await page.getByRole("status").first().waitFor({state:"hidden",timeout:30000});await page.locator("#country-search").fill("JPN");await page.getByRole("option",{name:/JPN/}).click();await page.waitForFunction(()=>window.__PAX_MAP_DEBUG__?.getDetailedStatus()==="ready",null,{timeout:60000});await page.waitForTimeout(500);await page.screenshot({path:"screenshots/selected-country-high-resolution.png"});await page.close();await browser.close();
