import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import polygonClipping from 'polygon-clipping';
import GeoJSONReader from 'jsts/org/locationtech/jts/io/GeoJSONReader.js';
import GeoJSONWriter from 'jsts/org/locationtech/jts/io/GeoJSONWriter.js';
import UnaryUnionOp from 'jsts/org/locationtech/jts/operation/union/UnaryUnionOp.js';
import OverlayOp from 'jsts/org/locationtech/jts/operation/overlay/OverlayOp.js';
import {polygons,normalizeGeometry,jsonBytes,digest} from './prompt14-catalog-core.mjs';
import {resolveAdmin1Parents,validatePartitionCoverage} from './prompt14-source-gate.mjs';
import {ARRANGEMENT_POLICY} from './prompt14-boundary-arrangement.mjs';
import {GAME_SELECTION_POLICY,sourceBoundaryDistance} from './prompt14-game-selection.mjs';
import {fileIdentity,readJSON,physicalMetrics} from './prompt15-cell-core.mjs';
import {CELL_EXPERIMENT_POLICY as P} from './prompt15-cell-policy.mjs';
const reader=new GeoJSONReader(),writer=new GeoJSONWriter();
const mp=coordinates=>({type:'MultiPolygon',coordinates});
const area=g=>reader.read(g).getArea();
export function overlay(op,a,b){
 try{return {geometry:mp(polygonClipping[op](polygons(a),polygons(b))),algorithm:'polygon-clipping 0.15.7'};}
 catch(error){const operations={intersection:OverlayOp.intersection,difference:OverlayOp.difference};if(!operations[op])throw error;
  const g=writer.write(operations[op](reader.read(a),reader.read(b)));
  const coordinates=g.type==='Polygon'?[g.coordinates]:g.type==='MultiPolygon'?g.coordinates:[];
  if(g.type==='GeometryCollection'&&g.geometries.some(x=>x.type==='Polygon'||x.type==='MultiPolygon'))throw Error('Unexpected polygon collection; do not discard positive pieces');
  return {geometry:mp(coordinates),algorithm:'Independent JSTS OverlayOp fallback',firstError:error.message};
 }
}
export function identitySetAudit(raw,candidate){
 const original=raw.map(f=>String(f.properties.ne_id??f.properties.sourceFeatureId));
 const actual=candidate.filter(f=>f.properties.inputRole==='P1').map(f=>String(f.properties.sourceFeatureId));
 const missing=original.filter(id=>!actual.includes(id)),additional=actual.filter(id=>!original.includes(id));
 const duplicates=actual.filter((id,i)=>actual.indexOf(id)!==i);
 return {pass:!missing.length&&!additional.length&&!duplicates.length,sourceCount:original.length,retainedCount:new Set(actual.filter(id=>original.includes(id))).size,missing,additional,duplicates};
}
export function sourceComponentsAgainstEnvelope(source,envelope){
 return polygons(source).map((polygon,index)=>{
  const geometry=normalizeGeometry({type:'Polygon',coordinates:polygon}),intersection=overlay('intersection',geometry,envelope),outside=overlay('difference',geometry,envelope);
  const m=physicalMetrics(geometry),insideArea=area(intersection.geometry),outsideArea=area(outside.geometry);
  return {index,sourceGeometryHash:digest(jsonBytes(geometry)),sourceMetrics:m,insideAreaDegreesSquared:insideArea,outsideAreaDegreesSquared:outsideArea,
   completelyOutside:insideArea===0&&outsideArea>0,sourceTiny:m.areaKm2<=P.tinySourceComponent.maximumAreaKm2&&m.diameterUpperBoundKm<=P.tinySourceComponent.maximumDiameterKm,
   intersectionAlgorithm:intersection.algorithm,differenceAlgorithm:outside.algorithm,outsideGeometry:outside.geometry,
   implication:insideArea===0&&outsideArea>0?'A nonempty cell inside fixed P0 cannot cover any positive area of this source component. Restoring it requires changing P0 or explicitly revising source-component preservation; numerical noding cannot resolve disjoint sets.':null};
 });
}
function boundaryWitness(fragment,source){
 const ceiling=GAME_SELECTION_POLICY.maximumResidualBoundaryDistanceDegrees;
 for(const polygon of polygons(fragment))for(const ring of polygon)for(let i=1;i<ring.length;i++)for(const point of [ring[i-1],[(ring[i-1][0]+ring[i][0])/2,(ring[i-1][1]+ring[i][1])/2]]){
  const distance=sourceBoundaryDistance(point,source);if(distance>ceiling)return {point,distanceDegrees:distance,ceilingDegrees:ceiling,segment:[ring[i-1],ring[i]],pass:false};
 }
 return {pass:null,reason:'No sampled witness beyond the ceiling. Sampling cannot override a failed continuous certificate.'};
}
export async function runWorldPreflight(label='first'){
 if(!['first','second'].includes(label))throw Error('Invalid run label');
 const output=`reports/prompt15/world-preflight/${label}`;if(fs.existsSync(`${output}/summary.json`))throw Error('Preserve existing preflight: use a separate run label/environment');
 fs.mkdirSync(output,{recursive:true});
 const write=(name,value)=>{const p=`${output}/${name}`;fs.writeFileSync(p,jsonBytes(value));return fileIdentity(p);};
 const review=readJSON('reports/prompt15/15-REVIEW-B.json');if(review.status!=='pass')throw Error('REVIEW B must pass');
 const verify=a=>{const b=fileIdentity(a.path);if(a.sha256!==b.sha256||a.byteLength!==b.byteLength)throw Error(`Stale evidence ${a.path}`);};
 for(const a of [review.checkpoint,review.validation,review.independentRecheck])if(a)verify(a);
 const stageA=readJSON('reports/prompt15/15-02-recovery.json');for(const a of stageA.allFallbackRecoveryPlan)verify(a.artifact);
 const freeze=readJSON('data/catalogs/prompt14/frozen-catalog-ref.json'),base=path.dirname(freeze.artifactIndex.path),oldPrefix=`${base}/build-only/${freeze.ref.catalogVersion}`;
 const inputPaths=['scripts/prompt15-world-preflight.mjs','scripts/prompt15-cell-policy.mjs','scripts/prompt15-cell-core.mjs','scripts/prompt14-source-gate.mjs','scripts/prompt14-game-selection.mjs','scripts/prompt14-boundary-arrangement.mjs',
  'reports/prompt15/15-REVIEW-B.json','reports/prompt15/15-02-recovery.json','reports/prompt15/15-03-predeclared-policy.json',
  'data/derived/prompt14/shared-game-p0.geojson','data/derived/prompt14/shared-admin1-input.geojson','data/derived/prompt14/selected-game-input.geojson','data/source-locks/prompt14-derived-game-input-lock.json','src/data/countries-2020.json',
  'data/catalogs/prompt14/frozen-catalog-ref.json',freeze.artifactIndex.path,`${oldPrefix}/catalog.json`,`${oldPrefix}/geometry.geojson`,...stageA.allFallbackRecoveryPlan.map(x=>x.artifact.path)];
 const inputs=inputPaths.map(fileIdentity);write('execution-inputs.json',inputs);
 const p0=readJSON('data/derived/prompt14/shared-game-p0.geojson'),raw=readJSON('data/derived/prompt14/shared-admin1-input.geojson'),selected=readJSON('data/derived/prompt14/selected-game-input.geojson');
 const resolution=resolveAdmin1Parents(raw,p0.features.map(f=>f.properties.countryId),readJSON('src/data/countries-2020.json'));
 for(const recovery of stageA.allFallbackRecoveryPlan.filter(r=>r.status==='pass')){
  const candidate=readJSON(recovery.artifact.path);selected.features=selected.features.filter(f=>f.properties.countryId!==recovery.countryId).concat(candidate.selected.features);
 }
 const old=readJSON(`${oldPrefix}/geometry.geojson`),oldIds=new Set(readJSON(`${oldPrefix}/catalog.json`).entries.map(x=>x.id));
 if(old.features.length!==oldIds.size||old.features.some(f=>!oldIds.has(f.properties.territoryId)))throw Error('Old protected overlay geometry/ID mismatch');
 const summaries=[],artifacts=[];
 for(const envelope of p0.features.slice().sort((a,b)=>a.properties.countryId.localeCompare(b.properties.countryId))){
  const countryId=envelope.properties.countryId,original=raw.features.filter((f,i)=>resolution.entries[i].normalizedParentCountryId===countryId&&!resolution.entries[i].excluded);
  const candidate=selected.features.filter(f=>f.properties.countryId===countryId),identities=identitySetAudit(original,candidate);
  const oldParents=old.features.filter(f=>f.properties.sourceCountryId===countryId);
  const oldCoverage=validatePartitionCoverage(envelope.geometry,oldParents.map(f=>f.geometry));
  const recovery=stageA.allFallbackRecoveryPlan.find(r=>r.countryId===countryId);
  const sourceAudit=[];let rawCoverage=null,gap=null,sourceUnionError=null;
  if(recovery?.rolloutBlock){
   for(const f of original){const sourceId=String(f.properties.ne_id),recovered=readJSON(recovery.artifact.path).selected.features.find(x=>x.properties.sourceFeatureId===sourceId);
    const components=sourceComponentsAgainstEnvelope(f.geometry,envelope.geometry);
    const added=recovered?overlay('difference',recovered.geometry,f.geometry):null,removed=recovered?overlay('difference',f.geometry,recovered.geometry):null;
    sourceAudit.push({sourceId,sourceName:f.properties.name,components,candidateGeometryHash:recovered?digest(jsonBytes(recovered.geometry)):null,
     added:added?.geometry??null,removed:removed?.geometry??null,
     addedWitness:added&&area(added.geometry)>0?boundaryWitness(added.geometry,f.geometry):null,
     removedWitness:removed&&area(removed.geometry)>0?boundaryWitness(removed.geometry,f.geometry):null});
   }
   try{
    const union=writer.write(UnaryUnionOp.union(reader.read({type:'GeometryCollection',geometries:original.map(f=>f.geometry)})));
    rawCoverage=validatePartitionCoverage(envelope.geometry,[union]);gap=overlay('difference',envelope.geometry,union).geometry;
   }catch(e){sourceUnionError=e.message;}
  }
  const failedRecovery=recovery?.rolloutBlock?Object.entries(readJSON(recovery.artifact.path).checks??{}).filter(([,v])=>!v).map(([k])=>k):[];
  const removedComponents=sourceAudit.flatMap(s=>s.components.filter(c=>c.completelyOutside).map(c=>({sourceId:s.sourceId,index:c.index,hash:c.sourceGeometryHash,areaKm2:c.sourceMetrics.areaKm2,diameterKm:c.sourceMetrics.diameterUpperBoundKm,sourceTiny:c.sourceTiny})));
  const entry={countryId,identities,oldProtectedParents:oldParents.length,oldCoverage,recoveryStatus:recovery?.status??'existing-selection',failedRecovery,
   completelyOutsideSourceComponents:removedComponents,sourceUnionError,rawCoverage,sourceCountryException:original.length===0?'Pinned source has no administrative identity; keep country provenance, never invent an ADM1':null,
   generationAllowed:identities.pass&&oldCoverage.pass&&!recovery?.rolloutBlock};
  // No ADM1 source is an explicit model case, not a fake identity or mesh exception.
  if(!original.length)entry.generationAllowed=oldCoverage.pass&&!recovery?.rolloutBlock;
  if(sourceAudit.length){artifacts.push(write(`${countryId}-source-correspondence.json`,{...entry,sourceAudit,uncoveredP0:gap,inputs:inputs.filter(x=>x.path.includes('shared-')||x.path===recovery.artifact.path)}));}
  summaries.push(entry);console.log(`${label}/${countryId}: ${entry.generationAllowed?'ready':'fail'} (${identities.retainedCount}/${identities.sourceCount} administrative identities)`);
 }
 const blocked=summaries.filter(x=>!x.generationAllowed),preservation=inputs.map(a=>{const b=fileIdentity(a.path);return {path:a.path,pass:a.sha256===b.sha256&&a.byteLength===b.byteLength};});
 const status=blocked.length||preservation.some(x=>!x.pass)?'fail':'pass';
 const result={checkpoint:'15-4',phase:'immutable-world-input-preflight',status,countries:summaries,blockedCountries:blocked.map(x=>x.countryId),
  count:{countries:summaries.length,sourceIdentities:summaries.reduce((n,x)=>n+x.identities.sourceCount,0),retainedIdentities:summaries.reduce((n,x)=>n+x.identities.retainedCount,0),oldProtectedTerritories:old.features.length,completelyOutsideComponents:summaries.reduce((n,x)=>n+x.completelyOutsideSourceComponents.length,0)},
  inputs,artifacts,preservation,oldCatalogRef:freeze.ref,policy:{numerical:ARRANGEMENT_POLICY.numericalModel,maximumActualAlignmentAreaFraction:ARRANGEMENT_POLICY.maximumActualAlignmentAreaFraction,maximumActualAlignmentDisplacementDegrees:ARRANGEMENT_POLICY.maximumActualAlignmentDisplacementDegrees,operational:P.version},
  tools:{node:process.version,polygonClipping:readJSON('node_modules/polygon-clipping/package.json').version,jsts:readJSON('node_modules/jsts/package.json').version},
  generatedOperationalCells:false,publishedCatalog:false,reason:status==='fail'?'Required source restoration fails before global meshing. Do not turn source loss or excessive boundary changes into successful catalog bytes.':'World input gate passed; global common arrangement/mesh/topology/delivery still required',
  next:status==='fail'?'15-4 source restoration: resolve recorded real P0/P1 contradictions while retaining fixed P0, source identities/components and existing bounds; do not advance to 15-5/15-6':'15-4 global common arrangement with old protected overlay'};
 write('summary.json',result);console.log(JSON.stringify({status,blocked:result.blockedCountries,count:result.count}));return result;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){const r=await runWorldPreflight(process.argv[2]??'first');if(r.status!=='pass')process.exitCode=1;}
