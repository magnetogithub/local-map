import fs from "node:fs";
import path from "node:path";
import {performance} from "node:perf_hooks";
import {computeCountryLabelLayout} from "../src/lib/map/country-label-layout.ts";
import {createMapLibreCountryLabelMetrics} from "../src/lib/map/font-metrics.ts";

const root=process.cwd();
const countries=JSON.parse(fs.readFileSync(path.join(root,"public/data/maps/countries-10m.geojson"),"utf8"));
const labels=JSON.parse(fs.readFileSync(path.join(root,"public/data/maps/country-labels-2020.geojson"),"utf8"));
const generated=JSON.parse(fs.readFileSync(path.join(root,"public/data/maps/country-label-layout-report-2020.json"),"utf8"));
const geometryById=new Map(countries.features.map(feature=>[feature.properties.countryId,feature.geometry]));
const labelById=new Map(labels.features.map(feature=>[feature.properties.countryId,feature.properties.mapLabelKo]));
const generatedById=new Map(generated.layouts.map(layout=>[layout.countryId,layout]));
const fontFile=fs.readFileSync(path.join(root,"public/fonts/Noto Sans KR/NotoSansCJKkr-Regular.otf"));
const glyphPbfFiles=["0-255.pbf","256-511.pbf"].map(file=>fs.readFileSync(path.join(root,"public/fonts/Open Sans Regular",file))),fontMetrics=createMapLibreCountryLabelMetrics(fontFile.buffer.slice(fontFile.byteOffset,fontFile.byteOffset+fontFile.byteLength),glyphPbfFiles,[...labelById.values()]);
const cases=[
  {countryId:"RUS",threshold:.85,policy:{minComponentAreaRatio:.035}},
  {countryId:"USA",threshold:.85,policy:{minComponentAreaRatio:.035}},
  {countryId:"CHN",threshold:.85,policy:{minComponentAreaRatio:.035}},
  {countryId:"CHL",threshold:.75,policy:{strategy:"vertical",maxRotation:90}},
  {countryId:"IDN",threshold:.75,policy:{strategy:"archipelago",minComponentAreaRatio:.012,componentJoinDistance:24}},
  {countryId:"NOR",threshold:.75,policy:{strategy:"vertical",maxRotation:90}}
];
const inRing=(point,ring)=>{let inside=false;for(let i=0,j=ring.length-1;i<ring.length;j=i++){const a=ring[i],b=ring[j];if((a[1]>point[1])!==(b[1]>point[1])&&point[0]<(b[0]-a[0])*(point[1]-a[1])/(b[1]-a[1])+a[0])inside=!inside}return inside};
const inSelectedTerritory=(point,geometry,componentIds)=>{const polygons=geometry.type==="Polygon"?[geometry.coordinates]:geometry.coordinates,selected=new Set(componentIds.map(id=>Number(id.slice("component-".length))));return polygons.some((polygon,index)=>selected.has(index)&&inRing(point,polygon[0])&&!polygon.slice(1).some(hole=>inRing(point,hole)))};
const round=value=>Math.round(value*1e6)/1e6,results=[];
for(const sample of cases){
  const geometry=geometryById.get(sample.countryId),started=performance.now();
  const layout=computeCountryLabelLayout({countryId:sample.countryId,geometry,label:labelById.get(sample.countryId),policy:{fontMetrics,...sample.policy}}),anchorContained=inSelectedTerritory(layout.anchor,geometry,layout.componentIds),difference=round(layout.insideRatio-layout.sampledInsideRatio),generatedLayout=generatedById.get(sample.countryId),generatedMatch=generatedLayout?.geometryHash===layout.geometryHash&&Math.abs(generatedLayout.insideRatio-layout.insideRatio)<1e-6;
  const pass=anchorContained&&layout.insideRatio>=sample.threshold&&Math.abs(difference)<.15;
  if(!pass)throw new Error(`${sample.countryId} failed footprint gate: exact=${layout.insideRatio}, sampled=${layout.sampledInsideRatio}, anchor=${anchorContained}`);
  results.push({countryId:sample.countryId,exactInsideRatio:layout.insideRatio,sampledInsideRatio:layout.sampledInsideRatio,difference,baselineInsideRatio:layout.baselineInsideRatio,anchor:layout.anchor,anchorContainedInSelectedTerritory:anchorContained,threshold:sample.threshold,generatedLayoutMatch:generatedMatch,milliseconds:round(performance.now()-started),pass});
}
const generatedDatasetMatchesIndependent=results.every(result=>result.generatedLayoutMatch),generatedReportPath=path.join(root,"public/data/maps/country-label-layout-report-2020.json"),algorithmPaths=[path.join(root,"src/lib/map/country-label-layout.ts"),path.join(root,"src/lib/map/font-metrics.ts"),path.join(root,"scripts/prepare-map-data.mjs")],generatedMtime=fs.statSync(generatedReportPath).mtimeMs,latestAlgorithmMtime=Math.max(...algorithmPaths.map(file=>fs.statSync(file).mtimeMs)),regeneratedWithLatestAlgorithm=generatedMtime>=latestAlgorithmMtime,report={subtask:"7F",status:"passed",generatedAt:new Date().toISOString(),source:"Natural Earth 1:10m actual geometry",implementation:{coarseSearch:"153-point sampling",preciseSearch:"polygon-clipping intersection area for the top 16 adaptive-search candidates",holesAndComponents:"intersection preserves Polygon/MultiPolygon components and subtracts hole rings",exactInsideRatio:"intersection area / rotated footprint area",baselineInsideRatio:"65-point independent line containment metric"},results,generatedLayoutReport:{path:"public/data/maps/country-label-layout-report-2020.json",generatedAt:generated.generatedAt,algorithm:generated.algorithm,regeneratedWithLatestAlgorithm,directRawGeometryValuesMatchGenerated:generatedDatasetMatchesIndependent,valueDifferenceReason:generatedDatasetMatchesIndependent?null:"prepare-map-data applies an additional cleanGeometry pass before layout; this independent audit intentionally recomputes from the persisted 1:10m geometry without that second pass"},gates:{representativeCountries:results.length===6,chileRecovered:results.find(result=>result.countryId==="CHL").exactInsideRatio>=.75,allAnchorsContained:results.every(result=>result.anchorContainedInSelectedTerritory),allThresholdsMet:results.every(result=>result.exactInsideRatio>=result.threshold),exactSampleDifferenceValidated:results.every(result=>Math.abs(result.difference)<.15),latestAlgorithmDataRegenerated:regeneratedWithLatestAlgorithm,status:regeneratedWithLatestAlgorithm?"pass":"fail"},limitations:["The precision calculation operates on the shape-preserving simplified projected geometry used by the label search, rather than every raw Natural Earth vertex.","Baseline containment remains dense line sampling because a line has zero intersection area.","Exact intersection of the top candidates adds computation cost; performance optimization remains a later subtask."]};
if(!regeneratedWithLatestAlgorithm)throw new Error("Generated country-label layout report predates the current algorithm sources; run npm.cmd run data:prepare");
fs.mkdirSync(path.join(root,"reports"),{recursive:true});
fs.writeFileSync(path.join(root,"reports/fix07-footprint-validation.json"),JSON.stringify(report,null,2)+"\n");
console.log(JSON.stringify(report,null,2));
