import fs from "node:fs";
import path from "node:path";

const root=process.cwd();
const source=JSON.parse(fs.readFileSync(path.join(root,"data/raw/ne_10m_admin_1_states_provinces.geojson"),"utf8"));
const names={AH:"안후이",BJ:"베이징",CQ:"충칭",FJ:"푸젠",GD:"광둥",GS:"간쑤",GX:"광시",GZ:"구이저우",HA:"허난",HB:"후베이",HE:"허베이",HI:"하이난",HL:"헤이룽장",HN:"후난",JL:"지린",JS:"장쑤",JX:"장시",LN:"랴오닝",NM:"내몽골",NX:"닝샤",QH:"칭하이",SC:"쓰촨",SD:"산둥",SH:"상하이",SN:"산시(섬서)",SX:"산시(산서)",TJ:"톈진",XJ:"신장",XZ:"티베트",YN:"윈난",ZJ:"저장"};
const colors=["#a9c6b5","#d8c18f","#b9b5d8","#d6aaa1","#9fc4d1","#c8d39a"];
const vertices=value=>{const result=[];const visit=item=>{if(Array.isArray(item)&&item.length===2&&item.every(Number.isFinite))result.push(item);else if(Array.isArray(item))item.forEach(visit)};visit(value);return result};
const features=source.features.filter(feature=>feature.properties.adm0_a3==="CHN"&&/^CN-[A-Z]{2}$/.test(feature.properties.iso_3166_2)).map((feature,index)=>{const suffix=feature.properties.iso_3166_2.slice(3),points=vertices(feature.geometry.coordinates),west=Math.min(...points.map(point=>point[0])),east=Math.max(...points.map(point=>point[0])),south=Math.min(...points.map(point=>point[1])),north=Math.max(...points.map(point=>point[1]));return {type:"Feature",properties:{countryId:`CHN-${suffix}`,iso3:`C${suffix}`,nameKo:names[suffix]??feature.properties.name_en,nameEn:feature.properties.name_en,mapLabelKo:names[suffix]??feature.properties.name_en,mapColor:colors[index%colors.length],playable:true,unitType:"sovereign-country",parentCountryId:"CHN",center:[(west+east)/2,(south+north)/2]},geometry:feature.geometry}}).sort((a,b)=>a.properties.countryId.localeCompare(b.properties.countryId));
if(features.length!==31)throw new Error(`Expected 31 Chinese province-level polygons, got ${features.length}`);
const output={type:"FeatureCollection",scenario:"china-provinces-test-v1",rollbackCountryId:"CHN",features};
fs.writeFileSync(path.join(root,"public/data/maps/china-province-countries-test.geojson"),JSON.stringify(output));
console.log(JSON.stringify({scenario:output.scenario,countries:features.length,ids:features.map(feature=>feature.properties.countryId)}));
