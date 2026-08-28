import fs from "node:fs";
import path from "node:path";
import polygonClipping from "polygon-clipping";
import {computeCountryLabelLayout,recomputeCountryLabels} from "../src/lib/map/country-label-layout.ts";
import {createMapLibreCountryLabelMetrics} from "../src/lib/map/font-metrics.ts";

const root=process.cwd(),validationStartedAt=new Date().toISOString(),countryGeometryPath=path.join(root,"public/data/maps/countries-10m.geojson"),countries=JSON.parse(fs.readFileSync(countryGeometryPath,"utf8")),labels=JSON.parse(fs.readFileSync(path.join(root,"public/data/maps/country-labels-2020.geojson"),"utf8"));
const labelById=new Map(labels.features.map(feature=>[feature.properties.countryId,feature.properties.mapLabelKo])),geometryById=new Map(countries.features.map(feature=>[feature.properties.countryId,feature.geometry]));
const fontFile=fs.readFileSync(path.join(root,"public/fonts/Noto Sans KR/NotoSansCJKkr-Regular.otf")),glyphPbfFiles=["0-255.pbf","256-511.pbf"].map(file=>fs.readFileSync(path.join(root,"public/fonts/Open Sans Regular",file))),fontMetrics=createMapLibreCountryLabelMetrics(fontFile.buffer.slice(fontFile.byteOffset,fontFile.byteOffset+fontFile.byteLength),glyphPbfFiles,[...labelById.values()]);
const policies={RUS:{minComponentAreaRatio:.035},USA:{minComponentAreaRatio:.035},IDN:{strategy:"archipelago",minComponentAreaRatio:.012,componentJoinDistance:24},CHL:{strategy:"vertical",maxRotation:90}};
const multi=geometry=>geometry.type==="Polygon"?[geometry.coordinates]:geometry.coordinates;
const geometry=result=>{if(!result.length)throw new Error("Border operation produced empty geometry");return result.length===1?{type:"Polygon",coordinates:result[0]}:{type:"MultiPolygon",coordinates:result}};
const rectangle=(west,south,east,north)=>[[[[west,south],[east,south],[east,north],[west,north],[west,south]]]];
const intersect=(source,clip)=>geometry(polygonClipping.intersection(multi(source),clip));
const union=(source,addition)=>geometry(polygonClipping.union(multi(source),addition));
const subtract=(source,cut)=>geometry(polygonClipping.difference(multi(source),cut));
const inRing=(point,ring)=>{let inside=false;for(let i=0,j=ring.length-1;i<ring.length;j=i++){const a=ring[i],b=ring[j];if((a[1]>point[1])!==(b[1]>point[1])&&point[0]<(b[0]-a[0])*(point[1]-a[1])/(b[1]-a[1])+a[0])inside=!inside}return inside};
const inGeometry=(point,value)=>multi(value).some(polygon=>inRing(point,polygon[0])&&!polygon.slice(1).some(hole=>inRing(point,hole)));
const distance=(a,b)=>Math.hypot(a[0]-b[0],a[1]-b[1]),round=value=>Math.round(value*1e6)/1e6;
const input=(countryId,value,previousLayout)=>({countryId,geometry:value,label:labelById.get(countryId),previousLayout,policy:{fontMetrics,...policies[countryId]}});
const baseIds=["USA","RUS","IDN","CHL","CHN"],base=Object.fromEntries(baseIds.map(countryId=>[countryId,computeCountryLabelLayout(input(countryId,geometryById.get(countryId)))]));
const scenarios=[
  {id:"east-territory-removed",countryId:"USA",change:source=>intersect(source,rectangle(-180,-90,-100,90)),operation:"intersection: retain territory west of 100°W"},
  {id:"adjacent-territory-annexed",countryId:"USA",change:source=>union(source,rectangle(-104,25,-101,30)),operation:"union: annex an adjacent southwest rectangle"},
  {id:"territory-split",countryId:"USA",change:source=>subtract(source,rectangle(-103,20,-100,55)),operation:"difference: remove a north-south strip to split the mainland"},
  {id:"two-polygons-merged",countryId:"IDN",change:source=>union(source,rectangle(106,-7,114,-3)),operation:"union: bridge two existing island polygons"},
  {id:"narrow-corridor-added",countryId:"CHL",change:source=>union(source,rectangle(-71,-39,-63,-38.4)),operation:"union: add a narrow eastward corridor"}
];
const results=[];
for(const scenario of scenarios){
  const beforeGeometry=geometryById.get(scenario.countryId),afterGeometry=scenario.change(beforeGeometry),before=base[scenario.countryId];
  const beforePolygonCount=multi(beforeGeometry).length,afterPolygonCount=multi(afterGeometry).length;
  const [withPrevious]=recomputeCountryLabels([input(scenario.countryId,afterGeometry)],base),[withoutPrevious]=recomputeCountryLabels([input(scenario.countryId,afterGeometry)]);
  if(withPrevious.geometryHash===before.geometryHash)throw new Error(`${scenario.id}: geometry hash did not change`);
  if(!inGeometry(withPrevious.anchor,afterGeometry)||!inGeometry(withoutPrevious.anchor,afterGeometry))throw new Error(`${scenario.id}: recomputed anchor is outside changed territory`);
  const minimum=["CHL","IDN"].includes(scenario.countryId)?.75:.85;
  if(withPrevious.insideRatio<minimum||withoutPrevious.insideRatio<minimum)throw new Error(`${scenario.id}: footprint insideRatio below ${minimum}`);
  if(scenario.id==="east-territory-removed"&&inGeometry(before.anchor,afterGeometry))throw new Error(`${scenario.id}: old anchor remained on retained territory; fixture does not exercise removal`);
  if(scenario.id==="territory-split"&&afterPolygonCount<=beforePolygonCount)throw new Error(`${scenario.id}: polygon count did not increase`);
  if(scenario.id==="two-polygons-merged"&&afterPolygonCount>=beforePolygonCount)throw new Error(`${scenario.id}: polygon count did not decrease`);
  if(scenario.id==="narrow-corridor-added"&&afterPolygonCount!==beforePolygonCount)throw new Error(`${scenario.id}: corridor is not connected to the original territory`);
  const withMovement=distance(before.anchor,withPrevious.anchor),withoutMovement=distance(before.anchor,withoutPrevious.anchor),withAngleChange=Math.abs(withPrevious.angle-before.angle),withoutAngleChange=Math.abs(withoutPrevious.angle-before.angle),stabilityDelta=withoutMovement-withMovement,stabilityImproved=stabilityDelta>1e-6||withoutAngleChange-withAngleChange>1e-6,qualityDifference=Math.abs(withPrevious.insideRatio-withoutPrevious.insideRatio);
  if(qualityDifference>.05)throw new Error(`${scenario.id}: stability changed insideRatio by ${qualityDifference}`);
  results.push({scenario:scenario.id,countryId:scenario.countryId,operation:scenario.operation,coordinateOverride:false,inputGeometryHash:before.geometryHash,before:{geometryHash:before.geometryHash,polygonCount:beforePolygonCount,anchor:before.anchor,angle:before.angle,fontSizeWorldUnits:before.fontSizeWorldUnits,insideRatio:before.insideRatio},withPrevious:{geometryHash:withPrevious.geometryHash,polygonCount:afterPolygonCount,anchor:withPrevious.anchor,angle:withPrevious.angle,fontSizeWorldUnits:withPrevious.fontSizeWorldUnits,insideRatio:withPrevious.insideRatio,anchorInside:true,anchorMovement:round(withMovement),angleChange:round(withAngleChange)},withoutPrevious:{geometryHash:withoutPrevious.geometryHash,polygonCount:afterPolygonCount,anchor:withoutPrevious.anchor,angle:withoutPrevious.angle,fontSizeWorldUnits:withoutPrevious.fontSizeWorldUnits,insideRatio:withoutPrevious.insideRatio,anchorInside:true,anchorMovement:round(withoutMovement),angleChange:round(withoutAngleChange)},stabilityDelta:round(stabilityDelta),stabilityImproved,qualityDifference:round(qualityDifference)});
}
const changedIds=results.map(result=>result.countryId),unchangedIds=baseIds.filter(id=>!changedIds.includes(id)),report={subtask:"7H",status:"passed",validationStartedAt,inputGeometry:{path:"public/data/maps/countries-10m.geojson",modifiedAt:fs.statSync(countryGeometryPath).mtime.toISOString(),baseGeometryHashes:Object.fromEntries(baseIds.map(id=>[id,base[id].geometryHash]))},source:"Natural Earth 1:10m actual country geometry",scenarioCount:results.length,recomputeApi:"recomputeCountryLabels",requestedCountryIds:changedIds,recomputedResultCount:results.length,unchangedCountryIds:unchangedIds,unchangedCountriesRecomputed:false,stabilityImprovementCount:results.filter(result=>result.stabilityImproved).length,results};
fs.mkdirSync(path.join(root,"reports"),{recursive:true});fs.writeFileSync(path.join(root,"reports/fix07-border-recomputation.json"),JSON.stringify(report,null,2)+"\n");console.log(JSON.stringify(report,null,2));
