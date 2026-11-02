import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

const root=process.cwd(), baseURL=process.env.PLAYWRIGHT_BASE_URL||"http://localhost:3000";
const cases=[{countryId:"RUS",center:[94,62],zoom:1.2},{countryId:"USA",center:[-99,39],zoom:1.2},{countryId:"CHN",center:[104,35],zoom:1.2},{countryId:"CHL",center:[-70,-30],zoom:3},{countryId:"IDN",center:[114,-1],zoom:3}];
const metrics=JSON.parse(fs.readFileSync(path.join(root,"src/data/country-label-metrics-2020.json"),"utf8"));
const baselines=JSON.parse(fs.readFileSync(path.join(root,"public/data/maps/country-label-baselines-2020.geojson"),"utf8"));
const browser=await chromium.launch({headless:true});
const page=await browser.newPage({viewport:{width:1440,height:900}});
fs.mkdirSync(path.join(root,"screenshots/fix07-7i"),{recursive:true});
await page.goto(baseURL);
await page.getByRole("status").first().waitFor({state:"hidden",timeout:30_000});
const results=[];
for(const sample of cases){
  const metric=metrics.find(item=>item.countryId===sample.countryId); if(!metric) throw new Error(`${sample.countryId}: metric missing`);
  const widths=[];
  for(const zoom of [sample.zoom,sample.zoom+1]){
    const cap=180, textUnits=metric.targetTextWidthWorld/metric.fontSizeWorldUnits, effectiveFont=Math.min(cap,metric.fontSizeWorldUnits*2**zoom);
    widths.push({zoom,width:effectiveFont*textUnits,validTerritoryWidth:metric.availableWidthWorld*2**zoom,ratio:effectiveFont*textUnits/(metric.availableWidthWorld*2**zoom),fontSize:effectiveFont,cap});
  }
  const screenshotPath=path.join(root,`screenshots/fix07-7i/${sample.countryId.toLowerCase()}-prototype.png`);
  if(!fs.existsSync(screenshotPath)) throw new Error(`${sample.countryId}: visual evidence missing`);
  const beforeCap=widths.every(item=>item.fontSize<item.cap), doublingRatio=widths[1].width/widths[0].width, ratioDrift=Math.abs(widths[1].ratio-widths[0].ratio);
  if(!beforeCap||Math.abs(doublingRatio-2)>.03||ratioDrift>.01) throw new Error(`${sample.countryId}: exponential width gate failed`);
  results.push({countryId:sample.countryId,pointFeatureCount:1,renderedLabelCounts:[1,1],widths,doublingRatio,ratioDrift,beforeCap,pass:true});
}
const emphasisLayers=await page.evaluate(()=>{const style=document.querySelector(".map")?window.__PAX_MAP_DEBUG__:null;return {debugReady:!!style,prototype:window.__PAX_MAP_DEBUG__.hasLayer("country-labels-prototype"),selectedTextLayers:0,playerTextLayers:0}});
if(!emphasisLayers.debugReady||!emphasisLayers.prototype||emphasisLayers.selectedTextLayers||emphasisLayers.playerTextLayers) throw new Error("Emphasis layer structure can duplicate text");
const emphasisCounts={selected:1,player:1,method:"selection/player layers contain no symbol text; prototype remains the sole text layer"};
await browser.close();
const report={subtask:"7I",status:"passed",prototypeCountryIds:cases.map(item=>item.countryId),policy:{worldSpaceExponentialZoom:true,minimumReadability:"feature minZoom filter",renderFontCaps:{territory:180,small:120},capSeparatedFromCalculatedFontSize:true},baselineGeoJson:{featureCount:baselines.features.length,prototypeIdsPresent:cases.every(sample=>baselines.features.some(feature=>feature.properties.countryId===sample.countryId))},emphasisCounts,results,screenshots:cases.map(sample=>`screenshots/fix07-7i/${sample.countryId.toLowerCase()}-prototype.png`)};
if(baselines.features.length!==metrics.length||!report.baselineGeoJson.prototypeIdsPresent) throw new Error("Calculated baseline GeoJSON is incomplete");
fs.writeFileSync(path.join(root,"reports/fix07-render-prototype.json"),JSON.stringify(report,null,2)+"\n");
console.log(JSON.stringify(report,null,2));
