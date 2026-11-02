import fs from "node:fs";
import path from "node:path";
import polygonClipping from "polygon-clipping";
import {computeCountryGeometryHash,computeCountryLabelLayout as computeLayout} from "../src/lib/map/country-label-layout.ts";
import {createMapLibreCountryLabelMetrics} from "../src/lib/map/font-metrics.ts";

const root=process.cwd(),rawDir=path.join(root,"data/raw"),mapDir=path.join(root,"public/data/maps");
const readRaw=name=>JSON.parse(fs.readFileSync(path.join(rawDir,name),"utf8"));
const readProject=name=>JSON.parse(fs.readFileSync(path.join(root,name),"utf8"));
const round=n=>Math.round(n*1e5)/1e5;
const palette=["#c9d8b6","#e6c9a8","#b8d5d1","#d7c6dc","#e3d6a4","#bfcde0","#d9b9b0"];
const MAP_COLOR_OVERRIDES={
  CAN:"#914c5b",USA:"#536e96",MEX:"#637256",BLZ:"#a75b68",GTM:"#718094",HND:"#4f7552",SLV:"#b6a24a",NIC:"#507395",CRI:"#a6535f",PAN:"#3e6681",
  CUB:"#a94d58",BHS:"#47869c",JAM:"#899a3f",HTI:"#c19a45",DOM:"#b55f67",PRI:"#5e78a0",TCA:"#6f91a4",CYM:"#756b92",VIR:"#b69b58",VGB:"#7d6f98",AIA:"#6d8ba0",KNA:"#6e7694",ATG:"#9e5668",MSR:"#607e5d",DMA:"#4e765d",GLP:"#a05a65",MTQ:"#58799a",LCA:"#b18f4d",VCT:"#527b89",BRB:"#706a94",GRD:"#9a5265",TTO:"#b18d48",
  ECU:"#776d57",COL:"#aa9b56",VEN:"#994754",GUY:"#b2a75b",SUR:"#7e3f4c",GUF:"#7897b4",BRA:"#1e5d3c",PER:"#aaa9b3",BOL:"#817469",PRY:"#5d78a3",CHL:"#94434d",ARG:"#9eafc2",URY:"#4f5489",
  IRL:"#3f7458",GBR:"#b2636d",PRT:"#3f7049",ESP:"#d0aa4b",FRA:"#7895c4",BEL:"#b68b49",NLD:"#b47e50",LUX:"#557b58",DEU:"#66676d",CHE:"#9d5058",ITA:"#3f764a",AUT:"#786f7b",CZE:"#565363",SVK:"#a55762",POL:"#b57080",DNK:"#9e4c57",NOR:"#833e47",SWE:"#426b8d",FIN:"#d0ced0",ISL:"#68818d",
  EST:"#b7c8ce",LVA:"#a45d68",LTU:"#78815e",BLR:"#8e8a5b",UKR:"#567dac",MDA:"#99744f",ROU:"#998975",HUN:"#315d48",SVN:"#a85660",HRV:"#5c6e80",BIH:"#b49a49",SRB:"#a4515e",MNE:"#315945",XKX:"#575f83",ALB:"#9e4b56",MKD:"#ac5f58",BGR:"#32705c",GRC:"#7d91a9",
  RUS:"#3b5e4d",KAZ:"#7296aa",MNG:"#c2ad65",CHN:"#88494a",IND:"#d1a077",IRN:"#234f45",TUR:"#98464d",GEO:"#d0ccc6",ARM:"#c8785f",AZE:"#63a0b0",SYR:"#bd747c",IRQ:"#89aaa0",LBN:"#a8a56d",JOR:"#d4d1ca",ISR:"#4d5f8f",SAU:"#856654",YEM:"#a37d73",OMN:"#aa9279",PAK:"#526c3d",AFG:"#c4c1ba",NPL:"#d0cdc7",BTN:"#aa7050",BGD:"#315f43",LKA:"#b59a4b",
  UZB:"#70759a",TKM:"#a85f6b",KGZ:"#a77950",TJK:"#5f6485",MMR:"#2f7962",THA:"#3b4e7a",LAO:"#718a40",VNM:"#cbb943",KHM:"#a04465",MYS:"#60528a",IDN:"#c9aeb0",PHL:"#596183",JPN:"#cf99a5",TWN:"#a2515e",PRK:"#9b4c57",KOR:"#344f82",
  MAR:"#a45261",ESH:"#718264",DZA:"#4b4648",TUN:"#60785d",LBY:"#7198a4",EGY:"#a88a50",MRT:"#5e765d",MLI:"#9a813f",NER:"#59634b",TCD:"#929653",SDN:"#4f654c",SDS:"#55598c",ERI:"#b15770",ETH:"#455986",DJI:"#438566",SOL:"#b76f68",SOM:"#75a5b8",
  SEN:"#b15c68",GMB:"#c3aa55",GNB:"#607683",GIN:"#2f6862",SLE:"#684b91",LBR:"#417590",CIV:"#b77d60",GHA:"#8d4354",TGO:"#bba84e",BEN:"#65714e",BFA:"#a5536d",NGA:"#b46a58",CMR:"#315a49",CAF:"#a64b69",GNQ:"#426d80",GAB:"#c1a64f",COG:"#a34e58",
  COD:"#4f6e9b",AGO:"#994c52",NAM:"#b8c58b",ZAF:"#ba8b50",BWA:"#8e9eba",ZMB:"#306b36",ZWE:"#a65a5e",MOZ:"#205954",TZA:"#789399",KEN:"#9c4b53",UGA:"#99884e",RWA:"#294f3f",BDI:"#774b56",MWI:"#b25367",LSO:"#3f5087",SWZ:"#625b88",MDG:"#bd6570",
  AUS:"#426657",PNG:"#465882",NZL:"#8d647f"
};
const ID_OVERRIDES={KOS:"XKX",SAH:"ESH",US1:"USA",CH1:"CHN",FI1:"FIN",KA1:"KAZ",GB1:"GBR",FR1:"FRA",KAS:"IND",KAB:"KAZ",SPI:"CHL",BRT:"SDN",BRI:"URY",ESB:"GBR",WSB:"GBR",USG:"USA"};
const MERGED_MAP_UNIT_IDS=new Set(["KAS","KAB","SPI","BRT","BRI","ESB","WSB","USG"]);
const EXCLUDED_MAP_UNIT_IDS=new Set(["BJN","SER","SCR"]);
const REMOVED_MAP_UNIT_IDS=new Set([...MERGED_MAP_UNIT_IDS,...EXCLUDED_MAP_UNIT_IDS]);
const MAP_UNIT_NAME_OVERRIDES={PGA:{nameEn:"Spratly Islands",nameKo:"스프래틀리 군도"}};
const REQUIRED=["KOR","PRK","USA","CHN","JPN","SGP","BHR","MDV","MLT","AND","LIE","MCO","SMR","VAT"];
const ADMIN_SAMPLES=["USA","CHN","FIN","KAZ","GBR","FRA","KOR","PRK","JPN","CAN","RUS","IND","BRA","AUS","DEU","ESP","ITA","NLD","NZL"];
const MAJOR_LABELS=new Set(["RUS","CAN","USA","CHN","BRA","AUS","IND"]);
const LABEL_ALGORITHM_VERSION="shape-curvature-fit-v17-two-glyph-cap";
const mapLabelKo={CHN:"중화인민공화국",PRK:"북한",KOR:"대한민국",USA:"미합중국",GBR:"영국",RUS:"러시아",NLD:"네덜란드",CZE:"체코",ARE:"아랍에미리트",COD:"콩고민주공화국",COG:"콩고공화국"};
const capitalKo={KOR:"서울",PRK:"평양",JPN:"도쿄",CHN:"베이징",FRA:"파리",DEU:"베를린",GBR:"런던",USA:"워싱턴 D.C.",CAN:"오타와",RUS:"모스크바",ITA:"로마",ESP:"마드리드",IND:"뉴델리",AUS:"캔버라",BRA:"브라질리아",SGP:"싱가포르",BHR:"마나마",MDV:"말레",MLT:"발레타",AND:"안도라라베야",LIE:"파두츠",MCO:"모나코",SMR:"산마리노",VAT:"바티칸 시국"};
const validId=value=>typeof value==="string"&&/^[A-Z]{3}$/.test(value)&&value!=="-99";
const normalizeId=value=>validId(value)?(ID_OVERRIDES[value]??value):null;
const admin0Id=p=>normalizeId(p.ADM0_A3)||normalizeId(p.GU_A3)||normalizeId(p.SOV_A3)||normalizeId(p.ISO_A3)||`NE-${p.NE_ID}`;

function closeRing(points){
  const clean=points.filter(p=>Array.isArray(p)&&p.length>=2&&Number.isFinite(p[0])&&Number.isFinite(p[1])).map(p=>[round(p[0]),round(p[1])]);
  if(clean.length<3)return null;
  if(clean[0][0]!==clean.at(-1)[0]||clean[0][1]!==clean.at(-1)[1])clean.push([...clean[0]]);
  return clean.length>=4?clean:null;
}
function simplifyRing(points,tolerance){
  const ring=closeRing(points);if(!ring)return null;if(!tolerance)return ring;
  const sq=tolerance*tolerance,out=[ring[0]];let last=ring[0];
  for(let i=1;i<ring.length-1;i++){const p=ring[i],dx=p[0]-last[0],dy=p[1]-last[1];if(dx*dx+dy*dy>=sq){out.push(p);last=p}}
  out.push([...out[0]]);return out.length>=4?out:ring;
}
function cleanGeometry(g,tolerance=0){
  if(!g)return null;
  if(g.type==="Polygon"){const rings=g.coordinates.map(r=>simplifyRing(r,tolerance)).filter(Boolean);return rings.length?{type:"Polygon",coordinates:rings}:null}
  if(g.type==="MultiPolygon"){const polygons=g.coordinates.map(p=>p.map(r=>simplifyRing(r,tolerance)).filter(Boolean)).filter(p=>p.length);return polygons.length?{type:"MultiPolygon",coordinates:polygons}:null}
  return null;
}
function stripPolygonHoles(geometry){
  if(geometry.type==="Polygon")return {type:"Polygon",coordinates:[geometry.coordinates[0]]};
  return {type:"MultiPolygon",coordinates:geometry.coordinates.map(p=>[p[0]])};
}
function exteriorBorderGeometry(geometry){
  const polygons=geometry.type==="Polygon"?[geometry.coordinates]:geometry.coordinates,lines=[];
  for(const polygon of polygons){const ring=polygon[0];let run=[ring[0]];for(let i=1;i<ring.length;i++){const a=ring[i-1],b=ring[i],dateLine=Math.abs(Math.abs(a[0])-180)<1e-5&&Math.abs(Math.abs(b[0])-180)<1e-5;if(dateLine){if(run.length>=2)lines.push(run);run=[b]}else run.push(b)}if(run.length>=2)lines.push(run)}
  return lines.length?{type:"MultiLineString",coordinates:lines}:null;
}
function unionGeometries(geometries){
  const polygons=geometries.map(g=>g.type==="Polygon"?[g.coordinates]:g.coordinates),coordinates=polygonClipping.union(...polygons);
  if(!coordinates.length)return null;return coordinates.length===1?{type:"Polygon",coordinates:coordinates[0]}:{type:"MultiPolygon",coordinates};
}
function differenceGeometries(geometry,mask){
  const subject=geometry.type==="Polygon"?[geometry.coordinates]:geometry.coordinates,clip=mask.type==="Polygon"?[mask.coordinates]:mask.coordinates,coordinates=polygonClipping.difference(subject,clip);
  if(!coordinates.length)return null;return coordinates.length===1?{type:"Polygon",coordinates:coordinates[0]}:{type:"MultiPolygon",coordinates};
}
function dissolveCollection(collection,tolerance){
  const groups=new Map();for(const feature of collection.features){if(EXCLUDED_MAP_UNIT_IDS.has(feature.properties.ADM0_A3))continue;const id=admin0Id(feature.properties),entry=groups.get(id)??{properties:feature.properties,geometries:[]};const geometry=cleanGeometry(feature.geometry,tolerance);if(geometry)entry.geometries.push(geometry);if(!REMOVED_MAP_UNIT_IDS.has(feature.properties.ADM0_A3))entry.properties=feature.properties;groups.set(id,entry)}
  const dissolved=new Map([...groups].map(([id,entry])=>[id,{type:"Feature",properties:entry.properties,geometry:unionGeometries(entry.geometries)}]).filter(([,f])=>f.geometry));
  for(const [rawId,targetId] of [["KAS","IND"],["KAB","KAZ"]]){const masks=collection.features.filter(f=>f.properties.ADM0_A3===rawId).map(f=>cleanGeometry(f.geometry,tolerance)).filter(Boolean);if(!masks.length)continue;const mask=unionGeometries(masks);if(!mask)continue;for(const [id,feature] of dissolved){if(id===targetId)continue;const geometry=differenceGeometries(feature.geometry,mask);if(geometry)feature.geometry=geometry;else dissolved.delete(id)}}
  return dissolved;
}
const ringArea=ring=>Math.abs(ring.reduce((sum,p,i)=>{const q=ring[(i+1)%ring.length];return sum+p[0]*q[1]-q[0]*p[1]},0)/2);
const countries10=readRaw("ne_10m_admin_0_countries.geojson"),countries50=readRaw("ne_50m_admin_0_countries.geojson"),admin1Raw=readRaw("ne_10m_admin_1_states_provinces.geojson"),places=readRaw("ne_10m_populated_places_simple.geojson");
const overrides=readProject("src/data/country-label-overrides-2020.json"),playableIds=new Set(readProject("src/data/playable-country-ids-2020.json"));
const sourceById=dissolveCollection(countries10,0);
const capitals=new Map();for(const f of places.features){if(f.properties.adm0cap!==1)continue;const id=normalizeId(f.properties.adm0_a3)||normalizeId(f.properties.sov_a3);if(id&&!capitals.has(id))capitals.set(id,f)}
const metadata=[...sourceById].map(([id,f],i)=>{const p=f.properties,cap=capitals.get(id),center=cap?.geometry.coordinates??[p.LABEL_X,p.LABEL_Y],iso2=[p.ISO_A2,p.ISO_A2_EH,p.WB_A2].find(v=>typeof v==="string"&&/^[A-Z]{2}$/.test(v))??"";let unitType="dependent-territory";if(playableIds.has(id))unitType="sovereign-country";else if(/Base/.test(p.TYPE)||/Base/.test(p.ADMIN))unitType="military-base";else if(/Buffer/.test(p.ADMIN))unitType="buffer-zone";else if(id==="ATA"||/Island|Islands|Reef|Bank|Shoal/.test(p.TYPE)||/Island|Islands|Reef|Bank|Shoal/.test(p.ADMIN))unitType="uninhabited-territory";else if(/Disputed|Indeterminate/.test(p.TYPE))unitType="disputed-territory";return {id,iso3:normalizeId(p.ISO_A3)??id,nameKo:p.NAME_KO||p.NAME_EN||p.ADMIN,nameEn:p.NAME_EN||p.ADMIN,mapLabelKo:mapLabelKo[id]||p.NAME_KO||p.NAME_EN||p.ADMIN,capitalKo:capitalKo[id]||cap?.properties.nameascii||"—",capitalEn:cap?.properties.nameascii||"—",flagCode:iso2,region:p.SUBREGION||p.CONTINENT,mapColor:MAP_COLOR_OVERRIDES[id]??palette[(Number(p.MAPCOLOR7)||i)%palette.length],center:center.map(round),defaultZoom:p.TINY===1?7:p.CONTINENT==="Europe"?4.5:3.8,unitType,playable:playableIds.has(id),labelRank:Number(p.LABELRANK)||5};}).sort((a,b)=>a.id.localeCompare(b.id));
for(const country of metadata){const override=MAP_UNIT_NAME_OVERRIDES[country.id];if(!override)continue;country.nameEn=override.nameEn;country.nameKo=override.nameKo;country.mapLabelKo=override.nameKo;country.unitType="disputed-territory"}
const byId=new Map(metadata.map(c=>[c.id,c]));
function normalizeCountries(collection,tolerance){return {type:"FeatureCollection",features:[...dissolveCollection(collection,tolerance)].map(([id,f])=>{const country=byId.get(id);if(!country)return null;return {type:"Feature",properties:{countryId:id,nameKo:country.nameKo,mapColor:country.mapColor,playable:country.playable,unitType:country.unitType},geometry:f.geometry}}).filter(Boolean)}}
const country50=normalizeCountries(countries50,.006),country10=normalizeCountries(countries10,.0015);
function normalizeBorders(collection,tolerance){return {type:"FeatureCollection",features:[...dissolveCollection(collection,tolerance)].map(([countryId,f])=>{const geometry=exteriorBorderGeometry(f.geometry);return byId.has(countryId)&&geometry?{type:"Feature",properties:{countryId},geometry}:null}).filter(Boolean)}}
const borders50=normalizeBorders(countries50,.006),borders10=normalizeBorders(countries10,.0015);

function resolveAdmin1CountryId(p){
  for(const value of [p.adm0_a3,p.sov_a3,p.gu_a3]){const id=normalizeId(value);if(id&&byId.has(id))return id}
  const iso3=typeof p.iso_3166_2==="string"?p.iso_3166_2.split("-")[0]:null;
  if(iso3){const match=metadata.find(c=>c.flagCode===iso3);if(match)return match.id}
  if(typeof p.iso_a2==="string"){const match=metadata.find(c=>c.flagCode===p.iso_a2);if(match)return match.id}
  return null;
}
const segmentKey=(a,b)=>[`${a[0]},${a[1]}`,`${b[0]},${b[1]}`].sort().join("|");
const removedAdminSegments=new Set();for(const feature of admin1Raw.features){if(!REMOVED_MAP_UNIT_IDS.has(feature.properties.adm0_a3))continue;const geometry=cleanGeometry(feature.geometry,0);if(!geometry)continue;const polygons=geometry.type==="Polygon"?[geometry.coordinates]:geometry.coordinates;for(const polygon of polygons)for(const ring of polygon)for(let i=1;i<ring.length;i++)removedAdminSegments.add(segmentKey(ring[i-1],ring[i]))}
const unresolved=[],invalidAdmin=[],removedAdmin=[],adminFeatures=[],rawCounts=new Map(),generatedCounts=new Map(),adminIds=new Set();
for(let index=0;index<admin1Raw.features.length;index++){
  const f=admin1Raw.features[index],p=f.properties;
  if(REMOVED_MAP_UNIT_IDS.has(p.adm0_a3)){removedAdmin.push({index,adm0_a3:p.adm0_a3,name:p.name,reason:"map-unit-merged-into-parent"});continue}
  const rawId=normalizeId(p.adm0_a3);if(rawId)rawCounts.set(rawId,(rawCounts.get(rawId)||0)+1);
  const countryId=resolveAdmin1CountryId(p);if(!countryId){unresolved.push({index,adm0_a3:p.adm0_a3,sov_a3:p.sov_a3,gu_a3:p.gu_a3,name:p.name,reason:"parent-unresolved"});continue}
  const cleanedGeometry=cleanGeometry(f.geometry,0);if(!cleanedGeometry){invalidAdmin.push({index,countryId,name:p.name,reason:"invalid-or-empty-geometry"});continue}const geometry=stripPolygonHoles(cleanedGeometry);
  let admin1Id=String(p.adm1_code||p.iso_3166_2||`${countryId}-${p.ne_id||index}`),uniqueKey=`${countryId}:${admin1Id}`;if(adminIds.has(uniqueKey))admin1Id=`${admin1Id}-${p.ne_id||index}`;uniqueKey=`${countryId}:${admin1Id}`;adminIds.add(uniqueKey);
  adminFeatures.push({type:"Feature",properties:{admin1Id,countryId,nameEn:p.name_en||p.name,nameLocal:p.name_local||p.name_ko||p.name,type:p.type_en||p.type,rank:Number(p.scalerank)||9},geometry});generatedCounts.set(countryId,(generatedCounts.get(countryId)||0)+1);
}
const seenAdminSegments=new Set();function adminBoundaryGeometry(geometry){const polygons=geometry.type==="Polygon"?[geometry.coordinates]:geometry.coordinates,lines=[];for(const polygon of polygons)for(const ring of polygon){let run=[];for(let i=1;i<ring.length;i++){const a=ring[i-1],b=ring[i],artificial=(Math.abs(Math.abs(a[0])-180)<.05&&Math.abs(Math.abs(b[0])-180)<.05)||Math.abs(a[0]-b[0])>180,key=segmentKey(a,b);if(artificial||removedAdminSegments.has(key)||seenAdminSegments.has(key)){if(run.length>=2)lines.push(run);run=[];continue}seenAdminSegments.add(key);if(!run.length)run.push(a);run.push(b)}if(run.length>=2)lines.push(run)}return lines.length?{type:"MultiLineString",coordinates:lines}:null}
const admin1={type:"FeatureCollection",features:adminFeatures.map(f=>({...f,geometry:adminBoundaryGeometry(f.geometry)})).filter(f=>f.geometry)};
const finalBoundaryCounts=new Map();for(const feature of admin1.features){const id=feature.properties.countryId;finalBoundaryCounts.set(id,(finalBoundaryCounts.get(id)||0)+1)}
const adminReport=[...new Set([...rawCounts.keys(),...generatedCounts.keys(),...finalBoundaryCounts.keys()])].sort().map(countryId=>{const rawAdmin1Count=rawCounts.get(countryId)||0,validGeometryCount=generatedCounts.get(countryId)||0,generatedBoundaryFeatureCount=finalBoundaryCounts.get(countryId)||0;return {countryId,rawAdmin1Count,validGeometryCount,generatedBoundaryFeatureCount,generatedAdmin1Count:generatedBoundaryFeatureCount,filteredBoundaryFeatureCount:validGeometryCount-generatedBoundaryFeatureCount,unresolvedCount:unresolved.filter(x=>normalizeId(x.adm0_a3)===countryId).length,excludedInvalidGeometryCount:invalidAdmin.filter(x=>x.countryId===countryId).length}});

const fontFile=fs.readFileSync(path.join(root,"public/fonts/Noto Sans KR/NotoSansCJKkr-Regular.otf")),glyphPbfFiles=["0-255.pbf","256-511.pbf"].map(file=>fs.readFileSync(path.join(root,"public/fonts/Open Sans Regular",file))),fontMetrics=createMapLibreCountryLabelMetrics(fontFile.buffer.slice(fontFile.byteOffset,fontFile.byteOffset+fontFile.byteLength),glyphPbfFiles,metadata.map(country=>country.mapLabelKo)),computeCountryLabelLayout=input=>{try{return computeLayout({...input,policy:{fontMetrics,...input.policy}})}catch(error){throw new Error(`Country label layout failed for ${input.countryId}: ${error instanceof Error?error.message:String(error)}`,{cause:error})}};
function classifyLabelShape(geometry){
  const polygons=geometry.type==="Polygon"?[geometry.coordinates]:geometry.coordinates,areas=polygons.map(p=>ringArea(p[0])),largestIndex=areas.indexOf(Math.max(...areas)),largest=polygons[largestIndex][0],total=areas.reduce((a,b)=>a+b,0),significantIndexes=areas.map((area,index)=>({area,index})).filter(item=>item.area/Math.max(1e-12,total)>=.012).map(item=>item.index),meanLat=largest.reduce((sum,p)=>sum+p[1],0)/largest.length,scale=Math.max(.15,Math.cos(meanLat*Math.PI/180)),xs=largest.map(p=>p[0]*scale),ys=largest.map(p=>p[1]),width=Math.max(...xs)-Math.min(...xs),height=Math.max(...ys)-Math.min(...ys),aspect=height/Math.max(1e-9,width),center=ring=>[ring.reduce((sum,p)=>sum+p[0]*scale,0)/ring.length,ring.reduce((sum,p)=>sum+p[1],0)/ring.length],largestCenter=center(largest),significantDistances=significantIndexes.filter(index=>index!==largestIndex).map(index=>Math.hypot(...center(polygons[index][0]).map((value,axis)=>value-largestCenter[axis]))),dispersion=Math.sqrt(areas[largestIndex])*.8,dispersedCount=significantDistances.filter(distance=>distance>=dispersion).length;
  if(aspect>=1.65||(Math.abs(meanLat)>=55&&significantIndexes.length>=3&&dispersedCount>=2))return {className:"vertical",policy:{minComponentAreaRatio:.035}};
  if(polygons.length>1)return {className:"separated-territory",policy:{minComponentAreaRatio:.035}};
  return {className:"mainland",policy:{minComponentAreaRatio:.035}};
}
const previousReportPath=path.join(mapDir,"country-label-layout-report-2020.json"),previousReport=fs.existsSync(previousReportPath)?readProject("public/data/maps/country-label-layout-report-2020.json"):null,previousLayouts=new Map((previousReport?.layouts??[]).map(layout=>[layout.countryId,layout]));
const labelFeatures=[],baselineFeatures=[],metrics=[],layoutStarted=performance.now(),layoutTimes=[],worldScale=512/360;let cacheHits=0,cacheMisses=0;
for(const country of metadata){const source=sourceById.get(country.id),geometry=cleanGeometry(source?.geometry,.0015);if(!source||!geometry)continue;const started=performance.now(),classification=classifyLabelShape(geometry),policy={...classification.policy,...overrides[country.id]},geometryHash=computeCountryGeometryHash(geometry),cacheKey=`${LABEL_ALGORITHM_VERSION}:${geometryHash}:${country.mapLabelKo}:${classification.className}`,cached=previousReport?.algorithm===LABEL_ALGORITHM_VERSION?previousLayouts.get(country.id):null,layout=cached?.cacheKey===cacheKey?cached:computeCountryLabelLayout({countryId:country.id,geometry,label:country.mapLabelKo,policy});if(cached?.cacheKey===cacheKey)cacheHits++;else cacheMisses++;const area=(geometry.type==="Polygon"?[geometry.coordinates]:geometry.coordinates).reduce((sum,p)=>sum+ringArea(p[0]),0),mainPartArea=Math.max(...(geometry.type==="Polygon"?[geometry.coordinates]:geometry.coordinates).map(p=>ringArea(p[0]))),labelLength=[...country.mapLabelKo].length,needed=Math.max(8,labelLength*layout.fontSizeWorldUnits),computedMinZoom=Math.max(1,Math.min(8.5,Math.log2(needed/Math.max(1,layout.targetTextWidthWorld)))),minZoom=overrides[country.id]?.minZoom??(MAJOR_LABELS.has(country.id)?1:computedMinZoom),placementMode=overrides[country.id]?.placementMode==="small-country-point"||minZoom>=5.3||mainPartArea<.1?"small-country-point":"territory-point",overlapAtClose=placementMode==="small-country-point"&&mainPartArea<.005,metric={...layout,geometryHash,cacheKey,shapeClass:classification.className,area:round(area),mainPartArea:round(mainPartArea),baselineLengthDegrees:round(layout.availableWidthWorld/worldScale),baselineLength:layout.availableWidthWorld,labelRank:country.labelRank,minZoom:round(minZoom),maxZoom:9,labelLength,fontSizeWorld:layout.fontSizeWorldUnits,fontSizeMid:layout.fontSizeWorldUnits*8,fontSizeClose:layout.fontSizeWorldUnits*64,letterSpacingWorld:layout.letterSpacing,letterSpacingMid:layout.letterSpacing,letterSpacingClose:layout.letterSpacing,maxWidthUsage:layout.coverageRatio,desiredTextWidthWorld:layout.targetTextWidthWorld,estimatedTextWidthWorld:layout.targetTextWidthWorld,priority:MAJOR_LABELS.has(country.id)?1:Math.min(90,10+country.labelRank*10),placementMode,overlapAtClose};layoutTimes.push(performance.now()-started);metrics.push(metric);labelFeatures.push({type:"Feature",properties:{...metric,nameKo:country.nameKo,nameEn:country.nameEn,mapLabelKo:country.mapLabelKo},geometry:{type:"Point",coordinates:layout.anchor}})}
baselineFeatures.push(...metrics.filter(metric=>metric.placementMode==="territory-point").map(metric=>({type:"Feature",properties:{countryId:metric.countryId,mapLabelKo:metadata.find(country=>country.id===metric.countryId)?.mapLabelKo,nameEn:metadata.find(country=>country.id===metric.countryId)?.nameEn,fontSizeWorldUnits:metric.fontSizeWorldUnits,targetTextWidthWorld:metric.targetTextWidthWorld,letterSpacing:metric.letterSpacing,priority:metric.priority,minZoom:metric.minZoom,placementMode:"curved-line",angle:metric.angle,insideRatio:metric.insideRatio,baselineInsideRatio:metric.baselineInsideRatio,geometryHash:metric.geometryHash},geometry:metric.baseline})));
const layoutPerformance={countryCount:metrics.length,totalMilliseconds:round(performance.now()-layoutStarted),averageMilliseconds:round(layoutTimes.reduce((a,b)=>a+b,0)/Math.max(1,layoutTimes.length)),maxSingleMilliseconds:round(Math.max(...layoutTimes)),cacheHits,cacheMisses};
const baselines={type:"FeatureCollection",features:baselineFeatures};
const labels={type:"FeatureCollection",features:labelFeatures};
const capitalGeo={type:"FeatureCollection",features:metadata.filter(c=>c.capitalEn!=="—").map(c=>({type:"Feature",properties:{countryId:c.id,nameKo:c.capitalKo,nameEn:c.capitalEn,capitalType:"national",labelRank:c.labelRank},geometry:{type:"Point",coordinates:c.center}}))};
const smallIds=new Set(metadata.filter(c=>c.defaultZoom>=7||REQUIRED.includes(c.id)).map(c=>c.id));
const small={type:"FeatureCollection",features:metadata.filter(c=>smallIds.has(c.id)).map(c=>({type:"Feature",properties:{countryId:c.id,nameKo:c.mapLabelKo,playable:c.playable},geometry:{type:"Point",coordinates:c.center}}))};

fs.mkdirSync(mapDir,{recursive:true});const sizes={};const write=(name,data)=>{const text=JSON.stringify(data)+"\n",target=path.join(root,name);fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,text);sizes[name]=Buffer.byteLength(text);console.log(`${name}: ${(sizes[name]/1048576).toFixed(2)} MiB`)};
write("public/data/maps/countries-50m.geojson",country50);write("public/data/maps/countries-10m.geojson",country10);write("public/data/maps/country-borders-50m.geojson",borders50);write("public/data/maps/country-borders-10m.geojson",borders10);write("public/data/maps/admin1-boundaries-10m.geojson",admin1);write("public/data/maps/country-label-baselines-2020.geojson",baselines);write("public/data/maps/country-labels-2020.geojson",labels);write("public/data/maps/capitals-2020.geojson",capitalGeo);write("public/data/maps/small-country-points-2020.geojson",small);write("public/data/maps/admin1-validation-2020.json",{summary:adminReport,samples:Object.fromEntries(ADMIN_SAMPLES.map(id=>[id,adminReport.find(r=>r.countryId===id)])),unresolved,excluded:invalidAdmin,removedMapUnits:removedAdmin});write("src/data/country-label-metrics-2020.json",metrics);write("public/data/maps/country-label-layout-report-2020.json",{generatedAt:new Date().toISOString(),algorithm:LABEL_ALGORITHM_VERSION,cache:{strategy:"geometry-hash",hits:cacheHits,misses:cacheMisses},performance:layoutPerformance,layouts:metrics});write("src/data/countries-2020.json",metadata);
const missingRequired=REQUIRED.filter(id=>!byId.has(id)),missingLabels=metadata.filter(c=>c.playable&&!labelFeatures.some(f=>f.properties.countryId===c.id)).map(c=>c.id),mismatches=adminReport.filter(r=>r.rawAdmin1Count!==r.validGeometryCount+r.excludedInvalidGeometryCount||r.generatedBoundaryFeatureCount>r.validGeometryCount||r.unresolvedCount);
console.log(JSON.stringify({mapUnits:metadata.length,playable:metadata.filter(c=>c.playable).length,admin1:admin1.features.length,labels:labelFeatures.length,capitals:capitalGeo.features.length,smallMarkers:small.features.length,missingRequired,missingLabels,unresolved:unresolved.length,invalidAdmin:invalidAdmin.length,removedMapUnits:removedAdmin,mismatches,samples:Object.fromEntries(ADMIN_SAMPLES.map(id=>[id,adminReport.find(r=>r.countryId===id)])),sizes},null,2));
if(missingRequired.length||missingLabels.length||unresolved.length||mismatches.length)process.exitCode=1;
