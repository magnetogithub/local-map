import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {CELL_EXPERIMENT_POLICY as P} from './prompt15-cell-policy.mjs';
import {REVISION_POLICY as Q} from './prompt15-r3-policy.mjs';
import {loadExperimentSources,generateCountryCells,readJSON,fileIdentity} from './prompt15-cell-core.mjs';
import {hashCanonical,jsonBytes,compareText} from './prompt14-catalog-core.mjs';
import {overlay} from './prompt15-world-preflight.mjs';
import {polygons} from './prompt14-catalog-core.mjs';
import GeoJSONReader from 'jsts/org/locationtech/jts/io/GeoJSONReader.js';
import {validatePositiveGeometry} from './prompt15-r3-validity.mjs';
export function generateMesh(output,countryId){
 const input=readJSON(`${output}/inputs/${countryId}.json`),dir=`${output}/mesh/${countryId}`;fs.mkdirSync(dir,{recursive:true});
 if(fs.existsSync(`${dir}/summary.json`))throw Error('Preserve completed mesh artifacts');
 if(input.unresolved.length||!input.coverage.pass||!input.oldCoverage.every(p=>p.pass))throw Error('Country input gate failed');
 const sources=loadExperimentSources(),old=readJSON(`${output}/old-protected.geojson`).features.filter(f=>f.properties.sourceCountryId===countryId).sort((a,b)=>compareText(a.properties.territoryId,b.properties.territoryId));
 const originalById=new Map(readJSON(`${output}/source-original.geojson`).features.map(f=>[String(f.properties.ne_id),f.geometry])),reader=new GeoJSONReader();
 const candidate=P.candidates.find(c=>c.id==='adaptive-12-24'),chunks=[],start=performance.now();let peakRss=process.memoryUsage().rss;
 for(const [chunkIndex,parent]of old.entries()){
  const partitions=input.partitions.filter(p=>p.oldTerritoryId===parent.properties.territoryId),byId=new Map();
  const features=partitions.map(p=>{const sourceFeatureId=hashCanonical('prompt15-protected-administrative-partition.v1',{policy:Q.version,countryId,oldTerritoryId:p.oldTerritoryId,adminId:p.adminId,geometry:p.geometry});byId.set(sourceFeatureId,p);return {type:'Feature',properties:{countryId,sourceCountryId:countryId,sourceFeatureId,inputRole:'P1'},geometry:p.geometry};});
  const result=generateCountryCells({...sources,selected:{type:'FeatureCollection',features},p0:{type:'FeatureCollection',features:[{...parent,properties:{countryId}}]}},countryId,candidate);
  const records=result.cells.map(c=>{const partition=byId.get(c.parentSourceFeatureId),region=partition.adminId?input.gameRegions.find(r=>r.id===partition.adminId):null;
   // A protected overlay sliver is never automatically a tiny SOURCE exception.
   const sourceTinyProof=region?region.components.find(component=>{
    if(!component.sourceTiny||component.status==='outside-game')return false;
    const a=component.sourceMetrics.bbox,b=c.bbox;if(b[0]<a[0]-1e-12||b[1]<a[1]-1e-12||b[2]>a[2]+1e-12||b[3]>a[3]+1e-12)return false;
    const source={type:'Polygon',coordinates:polygons(originalById.get(partition.adminId))[component.index]};
    return reader.read(overlay('difference',c.geometry,source).geometry).getArea()<=1e-9;
   }):null;
   const sourceTiny=!!sourceTinyProof;
   return {id:c.id,sourceCountryId:countryId,adminId:partition.adminId,oldTerritoryId:partition.oldTerritoryId,partitionId:c.parentSourceFeatureId,geometry:c.geometry,
    metrics:{areaKm2:c.areaKm2,planarArea:c.area,diameterKm:c.diameterUpperBoundKm,aspectRatio:c.aspectRatio,vertices:c.vertices,bbox:c.bbox,centroid:c.centroid},sourceTiny,sourceTinyProof:sourceTinyProof?{sourceIdentity:region.id,originalComponentIndex:sourceTinyProof.index,originalComponentHash:sourceTinyProof.sourceGeometryHash}:null,refined:c.refined};
  }).sort((a,b)=>compareText(a.id,b.id));
  const file=`mesh/${countryId}/${String(chunkIndex).padStart(4,'0')}.json`,bytes=jsonBytes(records);fs.writeFileSync(path.join(output,file),bytes);
  peakRss=Math.max(peakRss,process.memoryUsage().rss);const slivers=records.filter(c=>c.metrics.areaKm2<P.sliver.areaKm2||c.metrics.aspectRatio>P.sliver.aspectRatio);
  chunks.push({path:file,sha256:fileIdentity(path.join(output,file)).sha256,byteLength:bytes.length,oldTerritoryId:parent.properties.territoryId,count:records.length,vertices:result.metrics.vertexCount,
   maxAreaKm2:Math.max(...records.map(c=>c.metrics.areaKm2)),maxDiameterKm:Math.max(...records.map(c=>c.metrics.diameterKm)),sliverCount:slivers.length,nonTinySlivers:slivers.filter(c=>!c.sourceTiny).length,tinyCells:records.filter(c=>c.sourceTiny).length,sliverAreaKm2:slivers.reduce((n,c)=>n+c.metrics.areaKm2,0),areaKm2:records.reduce((n,c)=>n+c.metrics.areaKm2,0),
   checks:{geometry:validatePositiveGeometry(records.map(c=>c.geometry)).pass,partitionCoverage:result.coverage.every(c=>c.pass),oldParentCoverage:result.countryCoverage.pass,localTopology:result.topology.evidence.completeBoundaryCoverage&&result.topology.evidence.symmetricAdjacency},numericalMaximum:result.numericalNoding.maximumNodedSegmentDisplacement});
  console.log(`${countryId} ${chunkIndex+1}/${old.length}: ${records.length} cells, RSS ${Math.round(peakRss/1024**2)} MiB`);
  global.gc?.();
 }
 const count=chunks.reduce((n,c)=>n+c.count,0),tiny=chunks.reduce((n,c)=>n+c.tinyCells,0),area=chunks.reduce((n,c)=>n+c.areaKm2,0);
 const checks={allChunkChecks:chunks.every(c=>Object.values(c.checks).every(Boolean)),countryCellBudget:count<=P.budgets.countryCells,offlineCountryRssBudget:peakRss<=P.budgets.offlineCountryRssBytes,
  maximumDiameter:chunks.every(c=>c.maxDiameterKm<=P.interiorMaximumDiameterKm),maximumArea:chunks.every(c=>c.maxAreaKm2<=P.interiorMaximumAreaKm2),
  sliverCount:chunks.reduce((n,c)=>n+c.nonTinySlivers,0)/Math.max(1,count-tiny)<=P.sliver.maximumNonSourceTinyCellFraction,sliverArea:chunks.reduce((n,c)=>n+c.sliverAreaKm2,0)/area<=P.sliver.maximumSliverAreaFraction};
 const result={countryId,status:Object.values(checks).every(Boolean)?'pass':'fail',checks,chunks,count,peakRss,elapsedMs:performance.now()-start,inputs:[fileIdentity(`${output}/inputs/${countryId}.json`),fileIdentity('scripts/prompt15-r3-mesh.mjs'),fileIdentity('scripts/prompt15-cell-core.mjs')],tools:{node:process.version}};
 fs.writeFileSync(`${dir}/summary.json`,jsonBytes(result));return result;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){try{const r=generateMesh(process.argv[2],process.argv[3]);console.log(JSON.stringify({status:r.status,country:r.countryId,count:r.count,checks:r.checks}));if(r.status!=='pass')process.exitCode=1;}catch(e){const p=`${process.argv[2]}/mesh/${process.argv[3]}`;fs.mkdirSync(p,{recursive:true});fs.writeFileSync(`${p}/failure.json`,jsonBytes({status:'fail',message:e.message,evidence:e.evidence??null,memory:process.memoryUsage()}));console.error(e.stack);process.exitCode=1;}}
