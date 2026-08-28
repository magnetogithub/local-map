import fs from "node:fs";
import path from "node:path";
import {describe,expect,it} from "vitest";
import {computeCountryLabelLayout,type PolygonGeometry,type Position} from "./country-label-layout";
import {createMapLibreCountryLabelMetrics} from "./font-metrics";

type CountryFeature={properties:{countryId:string};geometry:PolygonGeometry};
const collection=JSON.parse(fs.readFileSync(path.join(process.cwd(),"public/data/maps/countries-10m.geojson"),"utf8")) as {features:CountryFeature[]};
const labels=JSON.parse(fs.readFileSync(path.join(process.cwd(),"public/data/maps/country-labels-2020.geojson"),"utf8")) as {features:Array<{properties:{countryId:string;mapLabelKo:string}}>};
const fontBuffer=fs.readFileSync(path.join(process.cwd(),"public/fonts/Noto Sans KR/NotoSansCJKkr-Regular.otf")),glyphPbfFiles=["0-255.pbf","256-511.pbf"].map(file=>fs.readFileSync(path.join(process.cwd(),"public/fonts/Open Sans Regular",file))),fontMetrics=createMapLibreCountryLabelMetrics(fontBuffer.buffer.slice(fontBuffer.byteOffset,fontBuffer.byteOffset+fontBuffer.byteLength),glyphPbfFiles,labels.features.map(item=>item.properties.mapLabelKo));
const cases=[
  {id:"RUS",policy:{minComponentAreaRatio:.035}},
  {id:"USA",policy:{minComponentAreaRatio:.035}},
  {id:"CHN",policy:{minComponentAreaRatio:.035}},
  {id:"CHL",policy:{minComponentAreaRatio:.035,maxRotation:90}},
  {id:"IDN",policy:{minComponentAreaRatio:.035}},
  {id:"FRA",policy:{minComponentAreaRatio:.035}},
  {id:"JPN",policy:{minComponentAreaRatio:.035}},
  {id:"GBR",policy:{minComponentAreaRatio:.035}},
  {id:"CAN",policy:{minComponentAreaRatio:.035}},
];
const inRing=(point:Position,ring:Position[])=>{let inside=false;for(let i=0,j=ring.length-1;i<ring.length;j=i++){const a=ring[i],b=ring[j];if((a[1]>point[1])!==(b[1]>point[1])&&point[0]<(b[0]-a[0])*(point[1]-a[1])/(b[1]-a[1])+a[0])inside=!inside}return inside};
const inGeometry=(point:Position,geometry:PolygonGeometry)=>{const polygons=geometry.type==="Polygon"?[geometry.coordinates]:geometry.coordinates;return polygons.some(polygon=>inRing(point,polygon[0])&&!polygon.slice(1).some(hole=>inRing(point,hole)))};
const vertexCount=(geometry:PolygonGeometry)=>JSON.stringify(geometry.coordinates).match(/\[/g)?.length??0;

describe("shape-aware layouts from actual Natural Earth 1:10m geometry",()=>{
  for(const sample of cases)it(`${sample.id} uses real geometry and records the current baseline`,()=>{
    const feature=collection.features.find(item=>item.properties.countryId===sample.id);
    expect(feature,`${sample.id} 1:10m feature`).toBeDefined();
    expect(vertexCount(feature!.geometry)).toBeGreaterThan(100);
    const label=labels.features.find(item=>item.properties.countryId===sample.id)?.properties.mapLabelKo;
    expect(label).toBeTruthy();
    const input={countryId:sample.id,geometry:feature!.geometry,label:label!,policy:{fontMetrics,...sample.policy}};
    const first=computeCountryLabelLayout(input),second=computeCountryLabelLayout(input);
    expect(first).toEqual(second);
    expect(first.geometryHash).toMatch(/^[0-9a-f]+$/);
    expect(inGeometry(first.anchor,feature!.geometry),`${sample.id} anchor containment`).toBe(true);
    expect(first.baseline.coordinates).toHaveLength(17);
    const chord=first.baseline.coordinates.at(-1)![1]-first.baseline.coordinates[0][1],middle=first.baseline.coordinates[8][1]-(first.baseline.coordinates[0][1]+chord/2);
    expect(Number.isFinite(middle)).toBe(true);
    expect(first.insideRatio).toBeGreaterThan(0);
    expect(first.footprint.coordinates[0]).toHaveLength(5);
    expect(first.baselineInsideRatio).toBeGreaterThan(0);
    expect(Math.abs(first.insideRatio-first.sampledInsideRatio)).toBeLessThan(.15);
    expect(first.coverageRatio).toBeGreaterThan(0);
    expect(Math.abs(first.angle)).toBeLessThanOrEqual(90);
    if(sample.id==="RUS"){
      expect(first.anchor[0]).toBeGreaterThanOrEqual(-180);
      expect(first.anchor[0]).toBeLessThanOrEqual(180);
      expect(first.availableWidthWorld).toBeLessThan(512);
    }
    if(sample.id==="IDN")expect(first.componentIds).toHaveLength(1);
    if(["RUS","USA","CHN"].includes(sample.id))expect(first.insideRatio).toBeGreaterThanOrEqual(.85);
    if(["CHL","IDN"].includes(sample.id))expect(first.insideRatio).toBeGreaterThanOrEqual(.75);
    expect(first.componentEvaluations.filter(component=>component.selected).map(component=>component.componentId)).toEqual(first.componentIds);
    expect(first.componentEvaluations.every(component=>component.reason.length>0)).toBe(true);
    if(sample.id==="USA"){expect(first.componentIds).toHaveLength(1);expect(first.anchor[0]).toBeGreaterThan(-125);expect(first.anchor[0]).toBeLessThan(-65)}
    if(sample.id==="FRA"){expect(first.componentIds).toHaveLength(1);expect(first.anchor[0]).toBeGreaterThan(-10);expect(first.anchor[0]).toBeLessThan(15)}
    if(sample.id==="JPN")expect(first.componentIds).toHaveLength(1);
    if(["RUS","GBR","CAN"].includes(sample.id))expect(first.componentIds).toHaveLength(1);
  },30_000);
});
