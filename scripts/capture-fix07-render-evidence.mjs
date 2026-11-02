import fs from "node:fs";
import path from "node:path";
import polygonClipping from "polygon-clipping";
import {chromium} from "playwright";

const root=process.cwd(),baseURL=process.env.PLAYWRIGHT_BASE_URL||"http://localhost:3000",viewport={width:1440,height:900};
const shots=[
  {name:"fix07-russia-z1",countryId:"RUS",center:[94,62],zoom:1.25},
  {name:"fix07-russia-z2",countryId:"RUS",center:[94,62],zoom:2.1},
  {name:"fix07-russia-z3",countryId:"RUS",center:[94,62],zoom:4},
  {name:"fix07-usa",countryId:"USA",center:[-99,39],zoom:2.1},
  {name:"fix07-china",countryId:"CHN",center:[104,35],zoom:2.1},
  {name:"fix07-chile",countryId:"CHL",center:[-70,-30],zoom:3},
  {name:"fix07-indonesia",countryId:"IDN",center:[114,-1],zoom:3},
];
const metrics=JSON.parse(fs.readFileSync(path.join(root,"src/data/country-label-metrics-2020.json"),"utf8"));
const countries=JSON.parse(fs.readFileSync(path.join(root,"public/data/maps/countries-10m.geojson"),"utf8"));
const borders=JSON.parse(fs.readFileSync(path.join(root,"public/data/maps/country-borders-10m.geojson"),"utf8"));
const labels=JSON.parse(fs.readFileSync(path.join(root,"public/data/maps/country-labels-2020.geojson"),"utf8"));
const recomputation=JSON.parse(fs.readFileSync(path.join(root,"reports/fix07-border-recomputation.json"),"utf8"));
const browser=await chromium.launch({headless:true}),page=await browser.newPage({viewport});
fs.mkdirSync(path.join(root,"screenshots"),{recursive:true});fs.mkdirSync(path.join(root,"reports"),{recursive:true});
await page.goto(baseURL);await page.getByRole("status").first().waitFor({state:"hidden",timeout:30_000});
const settle=async(detail=false)=>{if(detail)await page.waitForFunction(()=>window.__PAX_MAP_DEBUG__.getDetailedStatus()==="ready",null,{timeout:90_000});await page.waitForFunction(()=>window.__PAX_MAP_DEBUG__.isRenderSettled(),null,{timeout:90_000})};
const evidence=[];
const capture=async(sample)=>{await page.evaluate(({center,zoom})=>window.__PAX_MAP_DEBUG__.jumpTo(center,zoom),sample);await settle(sample.zoom>=2.2);const visible=await page.evaluate(id=>window.__PAX_MAP_DEBUG__.queryRenderedCountryIds().includes(id),sample.countryId);if(!visible)throw new Error(`${sample.name}: ${sample.countryId} territory is not visible`);const raw=await page.evaluate(id=>window.__PAX_MAP_DEBUG__.getRawRenderedCountryLabels().filter(label=>label.countryId===id),sample.countryId);if(!raw.length)throw new Error(`${sample.name}: ${sample.countryId} label is not visible`);const perCopy=Object.fromEntries([...new Set(raw.map(label=>label.worldCopy??0))].map(copy=>[copy,raw.filter(label=>(label.worldCopy??0)===copy).length]));if(Object.values(perCopy).some(count=>count!==1))throw new Error(`${sample.name}: raw labels are duplicated per world copy`);const camera=await page.evaluate(()=>({center:window.__PAX_MAP_DEBUG__.getCenter(),zoom:window.__PAX_MAP_DEBUG__.getZoom(),bearing:0,pitch:0}));const file=`screenshots/${sample.name}.png`;if(!(process.env.FIX07_RESUME&&fs.existsSync(path.join(root,file))))await page.screenshot({path:path.join(root,file)});const layout=metrics.find(metric=>metric.countryId===sample.countryId);evidence.push({file,viewport,camera,targetCountryId:sample.countryId,targetVisible:visible,layout:{anchor:layout.anchor,angle:layout.angle,fontSizeWorldUnits:layout.fontSizeWorldUnits,targetTextWidthWorld:layout.targetTextWidthWorld,availableWidthWorld:layout.availableWidthWorld,insideRatio:layout.insideRatio,minZoom:layout.minZoom,placementMode:layout.placementMode},rawLabelCount:raw.length,rawLabels:raw,rawPerWorldCopy:perCopy})};
for(const sample of shots)await capture(sample);

const borderCamera={center:[-110,40],zoom:3.2},borderBase={name:"fix07-border-change-before",countryId:"USA",...borderCamera};
await capture(borderBase);
const sourceUsa=countries.features.find(feature=>feature.properties.countryId==="USA"),sourcePolygons=sourceUsa.geometry.type==="Polygon"?[sourceUsa.geometry.coordinates]:sourceUsa.geometry.coordinates,clip=[[[[-180,-90],[-100,-90],[-100,90],[-180,90],[-180,-90]]]],changed=polygonClipping.intersection(sourcePolygons,clip),changedGeometry=changed.length===1?{type:"Polygon",coordinates:changed[0]}:{type:"MultiPolygon",coordinates:changed};
const afterLayout=recomputation.results.find(result=>result.scenario==="east-territory-removed").withPrevious,afterCountries=structuredClone(countries),afterBorders=structuredClone(borders),afterLabels=structuredClone(labels);
afterCountries.features.find(feature=>feature.properties.countryId==="USA").geometry=changedGeometry;
const rings=changedGeometry.type==="Polygon"?changedGeometry.coordinates:changedGeometry.coordinates.flat();afterBorders.features.find(feature=>feature.properties.countryId==="USA").geometry={type:"MultiLineString",coordinates:rings};
const usaLabel=afterLabels.features.find(feature=>feature.properties.countryId==="USA");usaLabel.geometry.coordinates=afterLayout.anchor;Object.assign(usaLabel.properties,{anchor:afterLayout.anchor,angle:afterLayout.angle,fontSizeWorldUnits:afterLayout.fontSizeWorldUnits});
const injected=await page.evaluate(({countries,borders,labels})=>[window.__PAX_MAP_DEBUG__.setEvidenceSourceData?.("countries-high",countries),window.__PAX_MAP_DEBUG__.setEvidenceSourceData?.("borders-high",borders),window.__PAX_MAP_DEBUG__.setEvidenceSourceData?.("country-label-placements",labels)],{countries:afterCountries,borders:afterBorders,labels:afterLabels});if(injected.some(value=>value!==true))throw new Error(`border-change source injection failed: ${injected}`);
await page.waitForTimeout(100);await capture({name:"fix07-border-change-after",countryId:"USA",...borderCamera});
const before=evidence.find(item=>item.file.endsWith("border-change-before.png")),after=evidence.find(item=>item.file.endsWith("border-change-after.png"));if(JSON.stringify(before.camera)!==JSON.stringify(after.camera))throw new Error("border-change before/after camera mismatch");
after.layout={...after.layout,anchor:afterLayout.anchor,angle:afterLayout.angle,fontSizeWorldUnits:afterLayout.fontSizeWorldUnits,insideRatio:afterLayout.insideRatio,geometryHash:afterLayout.geometryHash};
await browser.close();
const files=evidence.map(item=>item.file),missing=files.filter(file=>!fs.existsSync(path.join(root,file))||fs.statSync(path.join(root,file)).size===0);if(missing.length)throw new Error(`empty evidence files: ${missing.join(", ")}`);
const report={subtask:"7K",status:"passed",generatedAt:new Date().toISOString(),renderSettledMethod:"MapLibre loaded + not moving + detailed source ready at zoom >= 2.2",viewport,captureCount:evidence.length,borderChange:{scenario:"7H east-territory-removed",sameCamera:true,beforeGeometryHash:recomputation.results[0].before.geometryHash,afterGeometryHash:afterLayout.geometryHash,afterLayout},evidence};
fs.writeFileSync(path.join(root,"reports/fix07-render-evidence.json"),JSON.stringify(report,null,2)+"\n");console.log(JSON.stringify({status:report.status,captureCount:report.captureCount,files},null,2));
