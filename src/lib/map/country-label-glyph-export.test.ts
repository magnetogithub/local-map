import {describe,expect,it} from "vitest";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import metrics from "@/data/country-label-metrics-2020.json";
import countries from "@/data/countries-2020.json";
import {shapeFontOutlines} from "./font-outline";
import {buildCountryLabelGlyphArtifact,countryLabelTypographyPolicy,fitCountryLabelTypographyToLayout} from "./country-label-glyph-geometry";
import type {CountryLabelLayout,PolygonGeometry} from "./country-label-layout";

describe("all-country glyph GeoJSON export",()=>{
  it("exports deterministic fill and diagnostic outline collections",()=>{
    const root=process.cwd(),geometry=JSON.parse(fs.readFileSync(path.join(root,"public/data/maps/countries-10m.geojson"),"utf8")) as {features:Array<{properties:{countryId:string};geometry:PolygonGeometry}>},font=fs.readFileSync(path.join(root,"public/fonts/Noto Sans KR/NotoSansCJKkr-Regular.otf")),fontHash=crypto.createHash("sha256").update(font).digest("hex"),geometryById=new Map(geometry.features.map(feature=>[feature.properties.countryId,feature.geometry])),metricById=new Map((metrics as unknown as Array<CountryLabelLayout&{placementMode:string;minZoom:number}>).map(metric=>[metric.countryId,metric])),countryById=new Map(countries.map(country=>[country.id,country])),ids=countries.map(country=>country.id).filter(countryId=>metricById.get(countryId)?.placementMode!=="small-country-point"),fills:unknown[]=[];
    for(const countryId of ids){const text=countryById.get(countryId)!.mapLabelKo,layout=metricById.get(countryId)!,shapedFont=shapeFontOutlines(font,fontHash,text,1,.06),baseTypography=process.env.PAX_FIX08_12_COMMON_ONLY==="1"?{...countryLabelTypographyPolicy(countryId,[...text].length),glyphHeightRatio:.23}:countryLabelTypographyPolicy(countryId,[...text].length),typography=fitCountryLabelTypographyToLayout(layout,shapedFont,baseTypography),artifact=buildCountryLabelGlyphArtifact({countryId,text,geometry:geometryById.get(countryId)!,layout,font:shapedFont,...typography});for(const glyph of artifact.glyphs)fills.push({type:"Feature",properties:{countryId,labelInstanceId:artifact.labelInstanceId,glyphIndex:glyph.glyphIndex,codePoint:glyph.codePoint,role:"fill",minZoom:layout.minZoom,geometryHash:artifact.geometryHash,fontHash:artifact.fontHash,layoutVersion:artifact.layoutVersion},geometry:glyph.fillGeometry})}
    const fillCollection={type:"FeatureCollection",features:fills},outlineCollection={type:"FeatureCollection",features:[]};
    if(process.env.PAX_FIX08_5_EXPORT==="1"){fs.writeFileSync(path.join(root,"public/data/maps/country-label-glyph-fills-2020.geojson"),JSON.stringify(fillCollection));fs.writeFileSync(path.join(root,"public/data/maps/country-label-glyph-outlines-2020.geojson"),JSON.stringify(outlineCollection))}
    const pointIds=countries.map(country=>country.id).filter(countryId=>metricById.get(countryId)?.placementMode==="small-country-point");expect(fills).toHaveLength(ids.reduce((sum,id)=>sum+[...countryById.get(id)!.mapLabelKo].length,0));expect(new Set((fills as Array<{properties:{countryId:string}}>).map(feature=>feature.properties.countryId))).toEqual(new Set(ids));expect(new Set([...ids,...pointIds])).toEqual(new Set(countries.map(country=>country.id)));expect(ids.filter(id=>pointIds.includes(id))).toEqual([]);expect(outlineCollection.features).toEqual([]);
  },30_000);
});
