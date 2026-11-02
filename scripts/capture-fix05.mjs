import {chromium} from "playwright";
import fs from "node:fs";

const baseURL=process.env.PLAYWRIGHT_BASE_URL||"http://localhost:3000",browser=await chromium.launch({headless:true}),page=await browser.newPage({viewport:{width:1440,height:900}});
fs.mkdirSync("screenshots",{recursive:true});
await page.goto(baseURL);await page.waitForFunction(()=>window.__PAX_MAP_DEBUG__);
const settle=async(detail=false)=>{if(detail)await page.waitForFunction(()=>window.__PAX_MAP_DEBUG__.getDetailedStatus()==="ready",null,{timeout:90000});await page.waitForFunction(()=>window.__PAX_MAP_DEBUG__.isRenderSettled(),null,{timeout:90000})};
const capture=async(name,center,zoom,ids=[],detail=zoom>=2.2)=>{const path=`screenshots/${name}.png`;if(process.env.FIX05_RESUME&&fs.existsSync(path)){console.log(`skip ${name}`);return}console.log(`capture ${name}`);await page.evaluate(({center,zoom})=>window.__PAX_MAP_DEBUG__.jumpTo(center,zoom),{center,zoom});await settle(detail);for(const id of ids){const count=await page.evaluate(id=>window.__PAX_MAP_DEBUG__.getRenderedCountryLabelCount(id),id);if(count!==1)throw new Error(`${name}: expected one ${id} label, got ${count}`)}await page.screenshot({path})};

await capture("fix05-russia-world",[90,60],1.25,["RUS"],false);
await capture("fix05-russia-mid",[90,60],2.1,["RUS"],false);
await capture("fix05-canada-usa",[-105,50],2.1,["CAN","USA"],false);
await capture("fix05-china",[104,35],2.1,["CHN"],false);
await capture("fix05-brazil-australia-india",[42,4],1.9,["BRA","AUS","IND"],false);
await capture("fix05-europe-label-density",[12,50],4,[],true);
await capture("fix05-russia-close",[90,60],4,["RUS"],true);
await capture("fix05-small-label-before-minzoom",[12.453,41.903],6.2,[],true);if(await page.evaluate(()=>window.__PAX_MAP_DEBUG__.getRenderedCountryLabelCount("VAT"))!==0)throw new Error("VAT rendered before minZoom");
await capture("fix05-small-label-after-minzoom",[12.453,41.903],7,["VAT"],true);
await capture("fix05-world-copy-before-drag",[179,20],1.25,[],false);
if(!(process.env.FIX05_RESUME&&fs.existsSync("screenshots/fix05-world-copy-after-drag.png"))){
const canvas=page.locator(".maplibregl-canvas"),box=await canvas.boundingBox();if(!box)throw new Error("map canvas missing");for(let i=0;i<4;i++){await page.mouse.move(box.x+250,box.y+400);await page.mouse.down();await page.mouse.move(box.x+850,box.y+400,{steps:6});await page.mouse.up()}await settle(false);if((await page.evaluate(()=>window.__PAX_MAP_DEBUG__.queryRenderedCountryIds())).includes("USA")===false)throw new Error("USA missing after real world-copy drag");await page.screenshot({path:"screenshots/fix05-world-copy-after-drag.png"});
}
await capture("fix05-siachen",[76.9,35.2],7,[],true);
await capture("fix05-baykonur",[63.3,46],7,[],true);
await capture("fix05-chukotka",[179.2,66],5.5,[],true);
await browser.close();
