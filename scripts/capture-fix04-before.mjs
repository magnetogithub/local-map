import {chromium} from "playwright";
import fs from "node:fs";
const browser=await chromium.launch({headless:true});fs.mkdirSync("screenshots",{recursive:true});
for(const [name,center,zoom] of [["siachen",[76.9,35.2],7],["baykonur",[63.3,46.0],7],["chukotka",[179.2,66],5.5]]){const page=await browser.newPage({viewport:{width:1440,height:900}});await page.goto("http://localhost:3000");await page.waitForFunction(()=>window.__PAX_MAP_DEBUG__);await page.evaluate(({center,zoom})=>window.__PAX_MAP_DEBUG__.jumpTo(center,zoom),{center,zoom});await page.waitForFunction(()=>window.__PAX_MAP_DEBUG__.getDetailedStatus()==="ready",null,{timeout:60000});await page.waitForTimeout(800);await page.screenshot({path:`screenshots/fix04-${name}-before.png`});await page.close()}await browser.close();
