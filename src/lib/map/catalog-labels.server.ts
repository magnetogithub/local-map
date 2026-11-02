import 'server-only';
import {boundedTitleSchema} from '../simulation/simulation-contract-primitives';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import polygonClipping from 'polygon-clipping';
import {computeCountryLabelLayout,type PolygonGeometry,type CountryLabelLayout} from './country-label-layout';
import {shapeFontOutlines} from './font-outline';
import {extractFontMetrics} from './font-metrics';
import overrides from '../../data/country-label-overrides-2020.json';
import {buildCountryLabelGlyphArtifact,countryLabelTypographyPolicy,fitCountryLabelTypographyToLayout} from './country-label-glyph-geometry';
import {loadProductionCatalogSeed} from '../world/production-catalog-seed.server';
import {assertWorldGeometryCatalogRefMatches,createWorldGeometryCatalogRef} from '../world/world-geometry-catalog-ref';
import type {Feature,FeatureCollection,Geometry} from 'geojson';
const sha=(b:Buffer)=>createHash('sha256').update(b).digest('hex');
type Collection=FeatureCollection<Geometry,Record<string,unknown>>;
let seed:Readonly<{placements:Collection;fills:Collection;outlines:Collection;approval:unknown;font:Buffer;fontHash:string}>|undefined;
export function loadCatalogLabelSeed(){
  if(seed)return seed;const ref=loadProductionCatalogSeed().bootstrap.catalogRef;
  const approval=JSON.parse(fs.readFileSync(`data/catalog-consumers/prompt14/${ref.catalogVersion}/label-approval.json`,'utf8'));
  assertWorldGeometryCatalogRefMatches(createWorldGeometryCatalogRef(approval.catalogRef),ref);
  const read=(p:string)=>{const b=fs.readFileSync(p),a=approval.assets.find((a:{path:string})=>a.path===p);if(!a||a.sha256!==sha(b)||a.byteLength!==b.length)throw Error('LABEL_ASSET_IDENTITY');return b;};
  for(const a of approval.assets)read(a.path);
  const collection=(p:string)=>JSON.parse(read(p).toString()) as Collection;
  const font=read('public/fonts/Noto Sans KR/NotoSansCJKkr-Regular.otf');
  seed=Object.freeze({placements:collection('public/data/maps/country-labels-2020.geojson'),fills:collection('public/data/maps/country-label-glyph-fills-2020.geojson'),outlines:collection('public/data/maps/country-label-glyph-outlines-2020.geojson'),approval,font,fontHash:sha(font)});return seed;
}
let geometries:Map<string,PolygonGeometry>|undefined;
function catalogGeometries(){
  if(geometries)return geometries;
  const freeze=JSON.parse(fs.readFileSync('data/catalogs/prompt14/frozen-catalog-ref.json','utf8')),indexBytes=fs.readFileSync(freeze.artifactIndex.path);
  if(sha(indexBytes)!==freeze.artifactIndex.sha256)throw Error('LABEL_CATALOG_IDENTITY');
  const index=JSON.parse(indexBytes.toString()),relative=`build-only/${freeze.ref.catalogVersion}/geometry.geojson`,a=index.artifacts.find((a:{path:string})=>a.path===relative);
  const bytes=fs.readFileSync(path.join(path.dirname(freeze.artifactIndex.path),relative));if(!a||sha(bytes)!==a.sha256)throw Error('LABEL_GEOMETRY_IDENTITY');
  const features=JSON.parse(bytes.toString()).features as Feature<PolygonGeometry,{territoryId:string}>[];
  geometries=new Map(features.map(f=>[f.properties.territoryId,f.geometry]));return geometries;
}
const cache=new Map<string,{placement:Feature;fills:Collection;outlines:Collection}>();
export function buildCatalogCountryLabel(countryId:string,text:string,territoryIds:readonly string[]){
  if(!/^[A-Z]{3}$/.test(countryId)||!boundedTitleSchema.safeParse(text).success||!territoryIds.length||territoryIds.length>6000||new Set(territoryIds).size!==territoryIds.length)throw Error('LABEL_REQUEST_CAP');
  const key=JSON.stringify([countryId,text,[...territoryIds].sort()]),cached=cache.get(key);if(cached)return cached;
  const assets=loadCatalogLabelSeed(),byId=catalogGeometries(),parts=territoryIds.map(id=>{const g=byId.get(id);if(!g)throw Error('UNKNOWN_LABEL_TERRITORY');return g.type==='Polygon'?[g.coordinates]:g.coordinates;});
  const merged=polygonClipping.union(parts[0],...parts.slice(1)),geometry:PolygonGeometry={type:'MultiPolygon',coordinates:merged};
  const fontMetrics=extractFontMetrics(assets.font.buffer.slice(assets.font.byteOffset,assets.font.byteOffset+assets.font.byteLength) as ArrayBuffer,[text]);
  const override=(overrides as Record<string,{minimumCurvatureRatio?:number}>)[countryId];
  const previous=assets.placements.features.find(f=>f.properties.countryId===countryId),layout=computeCountryLabelLayout({countryId,geometry,label:text,previousLayout:previous?.properties as unknown as CountryLabelLayout,policy:{...override,minComponentAreaRatio:.035,fontMetrics}});
  const font=shapeFontOutlines(assets.font,assets.fontHash,text),policy=fitCountryLabelTypographyToLayout(layout,font,countryLabelTypographyPolicy(countryId,font.glyphs.length));
  const glyph=buildCountryLabelGlyphArtifact({countryId,text,geometry,layout,font,...policy});
  // Dense names retain their complete shaped geometry, but use a readable wrapped
  // point label rather than squeezing every glyph into the country footprint.
  const readableFallback=font.glyphs.length>32;
  const characters=[...new Intl.Segmenter('ko',{granularity:'grapheme'}).segment(text)].map(s=>s.segment);
  const fallbackText=Array.from({length:Math.ceil(characters.length/18)},(_,line)=>characters.slice(line*18,(line+1)*18).join('')).join('\n');
  const minZoom=Number(previous?.properties.minZoom??1),properties={...previous?.properties,...layout,countryId,mapLabelKo:text,minZoom,readableFallback,placementMode:readableFallback?'small-country-point':previous?.properties.placementMode??'territory-point',...(readableFallback?{fallbackText,angle:0,letterSpacing:0,overlapAtClose:false}:{})};
  const placement:Feature={type:'Feature',geometry:{type:'Point',coordinates:layout.anchor},properties};
  const fills:Collection={type:'FeatureCollection',features:glyph.glyphs.map(g=>({type:'Feature',geometry:g.fillGeometry,properties:{countryId,labelInstanceId:glyph.labelInstanceId,glyphIndex:g.glyphIndex,role:'fill',minZoom,readableFallback}}))};
  const outlines:Collection={type:'FeatureCollection',features:fills.features.map(f=>({...f,properties:{...f.properties,role:'outline'}}))};
  const result={placement,fills,outlines};cache.set(key,result);while(cache.size>32)cache.delete(cache.keys().next().value!);return result;
}
