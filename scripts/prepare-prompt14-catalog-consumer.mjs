import fs from 'node:fs';
import path from 'node:path';
import GeoJSONReader from 'jsts/org/locationtech/jts/io/GeoJSONReader.js';
import PointLocator from 'jsts/org/locationtech/jts/algorithm/PointLocator.js';
import InteriorPointArea from 'jsts/org/locationtech/jts/algorithm/InteriorPointArea.js';
import Coordinate from 'jsts/org/locationtech/jts/geom/Coordinate.js';
import {digest,jsonBytes,writeArtifact,assertBuildOutput} from './prompt14-catalog-core.mjs';
import {verifyCatalogArtifactBytes} from './prompt14-catalog-artifacts.mjs';
const output=path.resolve(process.argv[2]??'.tmp/prompt14-consumer/first');
assertBuildOutput(process.cwd(),output);
if(fs.existsSync(output)&&fs.readdirSync(output).length)throw new Error('Consumer preparation requires an empty directory');
const read=p=>JSON.parse(fs.readFileSync(p,'utf8')),freeze=read('data/catalogs/prompt14/frozen-catalog-ref.json');
const base=path.dirname(freeze.artifactIndex.path),verified=verifyCatalogArtifactBytes(base),version=freeze.ref.catalogVersion;
if(JSON.stringify(verified.ref)!==JSON.stringify(freeze.ref))throw new Error('Frozen catalog mismatch');
const indexBytes=fs.readFileSync(freeze.artifactIndex.path);
if(digest(indexBytes)!==freeze.artifactIndex.sha256||indexBytes.length!==freeze.artifactIndex.byteLength)throw new Error('Frozen artifact index mismatch');
const catalog=read(`${base}/build-only/${version}/catalog.json`),geometry=read(`${base}/build-only/${version}/geometry.geojson`);
const reader=new GeoJSONReader(),locator=new PointLocator(),geometryById=new Map(geometry.features.map(f=>[f.properties.territoryId,reader.read(f.geometry)]));
const territories=catalog.entries.map(e=>{const g=geometryById.get(e.id),interior=InteriorPointArea.getInteriorPoint(g),anchor=[interior.x,interior.y];if(locator.locate(interior,g)===2)throw new Error('Invalid interior anchor');return {id:e.id,sourceCountryId:e.sourceCountryId,bbox:e.bbox,area:e.area,anchor};});
const byCountry=new Map();for(const t of territories){const a=byCountry.get(t.sourceCountryId)??[];a.push(t);byCountry.set(t.sourceCountryId,a);}
const containing=(country,point)=>(byCountry.get(country)??[]).find(t=>locator.locate(new Coordinate(...point),geometryById.get(t.id))!==2);
const capitals=new Map(read('public/data/maps/capitals-2020.geojson').features.map(f=>[f.properties.countryId,f]));
const labels=new Map(read('public/data/maps/country-labels-2020.geojson').features.map(f=>[f.properties.countryId,f]));
const countries=read('src/data/countries-2020.json').map(c=>{
  const label=labels.get(c.id),labelAnchor=label?.properties.anchor,capital=capitals.get(c.id),capitalTerritory=capital&&containing(c.id,capital.geometry.coordinates);
  const largest=[...byCountry.get(c.id)].sort((a,b)=>b.area-a.area||(a.id<b.id?-1:a.id>b.id?1:0))[0],labelTerritory=labelAnchor&&containing(c.id,labelAnchor);
  return {countryId:c.id,iso3:c.iso3,flagCode:c.flagCode,region:c.region,
    label:{territoryId:labelTerritory?.id??largest.id,anchor:labelTerritory?labelAnchor:largest.anchor},
    capital:capitalTerritory?{territoryId:capitalTerritory.id,coordinates:capital.geometry.coordinates,...capital.properties}:null};
}).sort((a,b)=>a.countryId<b.countryId?-1:1);
const metadata={schemaVersion:'catalog-consumer-metadata-v1',catalogRef:freeze.ref,territories,countries};
const metadataArtifact=writeArtifact(output,'consumer-metadata.json',jsonBytes(metadata));
const artifacts=JSON.parse(indexBytes).artifacts,manifest=artifacts.find(a=>a.path.endsWith('/manifest.json')),tileIndex=artifacts.find(a=>a.path.endsWith('/tile-index.json'));
const publicIdentity=a=>({...a,path:a.path.replace(/^public/,'')});
const approval={schemaVersion:'catalog-consumer-approval-v1',catalogRef:freeze.ref,frozenArtifactIndexSha256:freeze.artifactIndex.sha256,
  metadata:{...metadataArtifact,path:`/data/territory-catalog/${version}/consumer-metadata.json`},manifest:publicIdentity(manifest),tileIndex:publicIdentity(tileIndex)};
writeArtifact(output,'consumer-approval.json',jsonBytes(approval));
writeArtifact(output,'preparation-evidence.json',jsonBytes({status:'pass',catalogRef:freeze.ref,territories:territories.length,countries:countries.length,
  allInteriorAnchorsValidated:true,capitalContainmentValidated:true,omittedCapitalCountryIds:countries.filter(c=>!c.capital).map(c=>c.countryId),
  fullGeometryOrTopologyInBrowserMetadata:false,productionWorldSchema:2,productionCutover:false,
  inputs:['data/catalogs/prompt14/frozen-catalog-ref.json',`${base}/build-only/${version}/catalog.json`,`${base}/build-only/${version}/geometry.geojson`,'src/data/countries-2020.json','public/data/maps/capitals-2020.geojson','public/data/maps/country-labels-2020.geojson'].map(p=>{const b=fs.readFileSync(p);return {path:p,sha256:digest(b),byteLength:b.length};}),metadata:metadataArtifact}));
console.log(JSON.stringify({status:'pass',territories:territories.length,countries:countries.length,metadataBytes:metadataArtifact.byteLength}));
