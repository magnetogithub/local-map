import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import GeoJSONReader from 'jsts/org/locationtech/jts/io/GeoJSONReader.js';
import GeoJSONWriter from 'jsts/org/locationtech/jts/io/GeoJSONWriter.js';
import Polygonizer from 'jsts/org/locationtech/jts/operation/polygonize/Polygonizer.js';
import PointLocator from 'jsts/org/locationtech/jts/algorithm/PointLocator.js';
import InteriorPointArea from 'jsts/org/locationtech/jts/algorithm/InteriorPointArea.js';
import STRtree from 'jsts/org/locationtech/jts/index/strtree/STRtree.js';
import Envelope from 'jsts/org/locationtech/jts/geom/Envelope.js';
import UnaryUnionOp from 'jsts/org/locationtech/jts/operation/union/UnaryUnionOp.js';
import {commonNodeRings} from './prompt14-boundary-arrangement.mjs';
import {polygons,normalizeGeometry,jsonBytes,digest,compareText} from './prompt14-catalog-core.mjs';
import {validatePartitionCoverage,normalizeCountryId,resolveAdmin1Parents,UPSTREAM_RELEASE,validatePolygonFeatureCollection,CANONICAL_P0_VALIDATOR_POLICY} from './prompt14-source-gate.mjs';
import {readJSON,fileIdentity,physicalAreaKm2} from './prompt15-cell-core.mjs';
import {sourceComponentsAgainstEnvelope,overlay} from './prompt15-world-preflight.mjs';
import {REVISION_POLICY as Q} from './prompt15-r3-policy.mjs';
const reader=new GeoJSONReader(),writer=new GeoJSONWriter(),locator=new PointLocator();
export const shape=g=>({components:polygons(g).length,holes:polygons(g).reduce((n,p)=>n+p.length-1,0)});
export const union=geometries=>geometries.length?writer.write(UnaryUnionOp.union(reader.read({type:'GeometryCollection',geometries}))):{type:'MultiPolygon',coordinates:[]};
const positiveArea=g=>reader.read(g).getArea();
export function partitionCountry(envelope,administrative,oldParents){
 const countryId=envelope.properties.countryId;
 const selected={type:'FeatureCollection',features:[...administrative.map(f=>({...f,properties:{countryId,sourceFeatureId:String(f.properties.ne_id),layer:'admin'}})),...oldParents.map(f=>({...f,properties:{countryId,sourceFeatureId:f.properties.territoryId,layer:'old'}}))]};
 const common=commonNodeRings({type:'FeatureCollection',features:[envelope]},selected);
 const country=reader.read(common.p0.features[0].geometry),index=new STRtree();
 const sources=common.selected.features.map(f=>reader.read(f.geometry));sources.forEach((g,i)=>index.insert(g.getEnvelopeInternal(),i));
 const polygonizer=new Polygonizer();for(const e of common.edges.values())polygonizer.add(reader.read({type:'LineString',coordinates:[e.a,e.b]}));
 const faces=[],unresolved=[];
 for(const it=polygonizer.getPolygons().iterator();it.hasNext();){const polygon=it.next(),point=InteriorPointArea.getInteriorPoint(polygon);if(locator.locate(point,country)===2)continue;
  const claims=[],old=[];for(const it=index.query(new Envelope(point)).iterator();it.hasNext();){const i=it.next();if(locator.locate(point,sources[i])!==2)(selected.features[i].properties.layer==='admin'?claims:old).push(selected.features[i].properties.sourceFeatureId);}
  const geometry=normalizeGeometry(writer.write(polygon));
  if(claims.length>1||old.length!==1){unresolved.push({claims,old,geometry,areaDegreesSquared:polygon.getArea()});continue;}
  faces.push({adminId:claims[0]??null,oldTerritoryId:old[0],sourceCountryId:countryId,geometry});
 }
 if(polygonizer.getInvalidRingLines().size())unresolved.push({kind:'invalid-arrangement-ring',count:polygonizer.getInvalidRingLines().size()});
 const grouped=new Map();for(const f of faces){const key=`${f.oldTerritoryId}:${f.adminId??'country-residual'}`,group=grouped.get(key)??{adminId:f.adminId,oldTerritoryId:f.oldTerritoryId,sourceCountryId:countryId,geometries:[]};group.geometries.push(f.geometry);grouped.set(key,group);}
 const partitions=[...grouped.values()].map(g=>({adminId:g.adminId,oldTerritoryId:g.oldTerritoryId,sourceCountryId:g.sourceCountryId,geometry:normalizeGeometry(union(g.geometries))})).sort((a,b)=>compareText(a.oldTerritoryId,b.oldTerritoryId)||compareText(a.adminId??'',b.adminId??''));
 const gameRegions=administrative.map(f=>{const id=String(f.properties.ne_id),members=partitions.filter(p=>p.adminId===id),geometry=members.length?normalizeGeometry(union(members.map(p=>p.geometry))):null;return {id,name:f.properties.name,sourceCountryId:countryId,active:!!geometry,geometry};});
 const coverage=validatePartitionCoverage(envelope.geometry,[union(partitions.map(p=>p.geometry))]);
 const oldCoverage=oldParents.map(f=>({oldTerritoryId:f.properties.territoryId,...validatePartitionCoverage(f.geometry,[union(partitions.filter(p=>p.oldTerritoryId===f.properties.territoryId).map(p=>p.geometry))])}));
 return {countryId,partitions,gameRegions,coverage,oldCoverage,unresolved,numerical:{maximumNodedSegmentDisplacement:common.evidence.maximumNodedSegmentDisplacement,insertedNodes:common.evidence.insertedNodes},validity:validatePolygonFeatureCollection({type:'FeatureCollection',features:partitions.map(p=>({type:'Feature',properties:{},geometry:p.geometry}))},'r3 input partition',CANONICAL_P0_VALIDATOR_POLICY)};
}
export function generateInputs(output,onProgress=console.log){
 if(fs.existsSync(path.join(output,'input-summary.json')))throw Error('Input artifacts already exist; preserve revision');fs.mkdirSync(output,{recursive:true});
 const write=(name,data)=>{const p=path.join(output,name);fs.mkdirSync(path.dirname(p),{recursive:true});fs.writeFileSync(p,jsonBytes(data));return {...fileIdentity(p),path:name};};
 const rawPath='data/raw/ne_10m_admin_1_states_provinces.geojson',raw=readJSON(rawPath),prepared=readJSON('data/derived/prompt14/shared-admin1-input.geojson'),p0=readJSON('data/derived/prompt14/shared-game-p0.geojson');
 if(fileIdentity(rawPath).sha256!==UPSTREAM_RELEASE.admin1Sha256)throw Error('Original admin source hash mismatch');
 const freeze=readJSON('data/catalogs/prompt14/frozen-catalog-ref.json'),base=path.dirname(freeze.artifactIndex.path),old=readJSON(`${base}/build-only/${freeze.ref.catalogVersion}/geometry.geojson`);
 const parents=resolveAdmin1Parents(raw,p0.features.map(f=>f.properties.countryId),readJSON('src/data/countries-2020.json'));
 parents.entries.forEach((e,i)=>{if(['ESB','WSB','USG','KAS','KAB'].includes(raw.features[i].properties.adm0_a3)){e.excluded=false;e.normalizedParentCountryId=normalizeCountryId(raw.features[i].properties.adm0_a3);e.resolutionRule='existing-P0-map-unit-owner-assignment';}});
 const inputPaths=[rawPath,'data/derived/prompt14/shared-admin1-input.geojson','data/derived/prompt14/shared-game-p0.geojson','src/data/countries-2020.json','data/catalogs/prompt14/frozen-catalog-ref.json',freeze.artifactIndex.path,`${base}/build-only/${freeze.ref.catalogVersion}/geometry.geojson`,'scripts/prompt15-r3-policy.mjs','scripts/prompt15-r3-input.mjs'];
 const inputs=inputPaths.map(fileIdentity),artifacts=[write('contract.json',Q),write('source-records.json',raw.features.map((f,i)=>({id:String(f.properties.ne_id),name:f.properties.name,geometryHash:digest(jsonBytes(f.geometry)),originalShape:shape(f.geometry),preparedGeometryHash:digest(jsonBytes(prepared.features.find(x=>String(x.properties.ne_id)===String(f.properties.ne_id)).geometry)),parent:parents.entries[i]})))];
 for(const [name,p]of [['source-original.geojson',rawPath],['source-prepared.geojson','data/derived/prompt14/shared-admin1-input.geojson'],['fixed-p0.geojson','data/derived/prompt14/shared-game-p0.geojson'],['old-protected.geojson',`${base}/build-only/${freeze.ref.catalogVersion}/geometry.geojson`]]){fs.copyFileSync(p,path.join(output,name));artifacts.push({...fileIdentity(path.join(output,name)),path:name});}
 const countries=[];
 for(const envelope of p0.features.slice().sort((a,b)=>compareText(a.properties.countryId,b.properties.countryId))){
  const id=envelope.properties.countryId,source=raw.features.filter((f,i)=>!parents.entries[i].excluded&&parents.entries[i].normalizedParentCountryId===id);
  const administrative=source.map(f=>prepared.features.find(x=>String(x.properties.ne_id)===String(f.properties.ne_id))),oldParents=old.features.filter(f=>f.properties.sourceCountryId===id);
  const result=partitionCountry(envelope,administrative,oldParents);
  const records=source.map(f=>{const game=result.gameRegions.find(g=>g.id===String(f.properties.ne_id)),components=sourceComponentsAgainstEnvelope(f.geometry,envelope.geometry),clipped=union(components.map(c=>overlay('intersection',{type:'Polygon',coordinates:polygons(f.geometry)[c.index]},envelope.geometry).geometry));
   const outside=overlay('difference',f.geometry,envelope.geometry).geometry;
   const addition=game.geometry?overlay('difference',game.geometry,clipped).geometry:{type:'MultiPolygon',coordinates:[]},removal=game.geometry?overlay('difference',clipped,game.geometry).geometry:clipped;
   return {...game,sourceGeometryHash:digest(jsonBytes(f.geometry)),gameGeometryHash:game.geometry?digest(jsonBytes(game.geometry)):null,originalShape:shape(f.geometry),gameShape:game.geometry?shape(game.geometry):{components:0,holes:0},components:components.map(({outsideGeometry,...c})=>({...c,outsideGeometryHash:digest(jsonBytes(outsideGeometry)),status:c.completelyOutside?'outside-game':c.outsideAreaDegreesSquared>0?'partial-crossing':'inside-game'})),
    clipping:{removedAreaDegreesSquared:positiveArea(outside),removedAreaKm2:physicalAreaKm2(outside),addedAreaDegreesSquared:0,reason:'Intersection with unchanged fixed P0; original geometry kept in source-original.geojson',displacement:'Set restriction only, not boundary translation'},
    additionalAlignment:{addedAreaDegreesSquared:positiveArea(addition),removedAreaDegreesSquared:positiveArea(removal),maximumNumericalDisplacementDegrees:result.numerical.maximumNodedSegmentDisplacement,reason:'Prepared exact self-touch source boundary and common 1e-12 numerical arrangement only; no actual gap fill'}};});
  const artifact=write(`inputs/${id}.json`,{...result,gameRegions:records,envelope});artifacts.push(artifact);
  const residuals=result.partitions.filter(p=>p.adminId===null),summary={countryId:id,sourceIdentityCount:source.length,activeIdentities:records.filter(r=>r.active).length,inactiveIdentities:records.filter(r=>!r.active).length,components:{inside:0,partial:0,outside:0},clippingRemovedAreaKm2:records.reduce((n,r)=>n+r.clipping.removedAreaKm2,0),additionalAlignmentAddedAreaDegreesSquared:records.reduce((n,r)=>n+r.additionalAlignment.addedAreaDegreesSquared,0),additionalAlignmentRemovedAreaDegreesSquared:records.reduce((n,r)=>n+r.additionalAlignment.removedAreaDegreesSquared,0),residualAreaKm2:residuals.reduce((n,p)=>n+physicalAreaKm2(p.geometry),0),residualCount:residuals.length,unresolved:result.unresolved.length,coverage:result.coverage,oldCoveragePassed:result.oldCoverage.every(c=>c.pass),validGeometry:result.validity.pass,artifact};
  for(const r of records)for(const c of r.components)summary.components[c.status==='outside-game'?'outside':c.status==='partial-crossing'?'partial':'inside']++;
  summary.pass=!summary.unresolved&&summary.coverage.pass&&summary.oldCoveragePassed&&summary.validGeometry;countries.push(summary);onProgress(`${id}: ${summary.pass?'pass':'fail'}, ${summary.activeIdentities} active, ${summary.residualCount} residual partitions, ${summary.unresolved} unresolved`);
 }
 const result={revision:Q.version,status:countries.every(c=>c.pass)?'pass':'fail',countries,inputs,artifacts,oldCatalogRef:freeze.ref,tools:{node:process.version,jsts:'2.12.1',polygonClipping:'0.15.7'},command:'node scripts/prompt15-r3-input.mjs <output>'};write('input-summary.json',result);return result;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){const r=generateInputs(process.argv[2]);console.log(JSON.stringify({status:r.status,failed:r.countries.filter(c=>!c.pass).map(c=>c.countryId)}));if(r.status!=='pass')process.exitCode=1;}
