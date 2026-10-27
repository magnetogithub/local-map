// Prompt 15 task 15-19: offline, immutable, all-country operational-cell draft.
// Nothing in this module is imported by runtime code and it never updates a
// production catalog reference.
import fs from 'node:fs';
import path from 'node:path';
import {gzipSync} from 'node:zlib';
import {pathToFileURL} from 'node:url';
import {CELL_EXPERIMENT_POLICY as POLICY} from './prompt15-cell-policy.mjs';
import {fileIdentity,generateCountryCells,loadExperimentSources,readJSON} from './prompt15-cell-core.mjs';
import {compareText,digest,hashCanonical,jsonBytes,normalizeGeometry,polygons} from './prompt14-catalog-core.mjs';
import {overlay} from './prompt15-world-preflight.mjs';

export const TASK_15_19_VERSION='prompt15-task-15-19-world-catalog-v1';
export const ADMINISTRATIVE_ROOT='data/derived/prompt15/15-18-administrative-input-v1-161260049c9100b09cb5';
const ADMINISTRATIVE_INDEX={path:`${ADMINISTRATIVE_ROOT}/artifact-index.json`,byteLength:1981,sha256:'bb977fd802809430ee07b240cb68aa61299701f30a762c987d1890767d226256'};
const V18={path:'reports/prompt15/15-18-v18-reset-v2.json',byteLength:24851,sha256:'829caa452075f1c325f951167f01071caab21cdc792f76ebfd4e1083ff2afece'};
const POLICY_DECISION='reports/prompt15/15-03-policy-decision.json';
const POLICY_FILE='scripts/prompt15-cell-policy.mjs';
const CELL_CORE_FILE='scripts/prompt15-cell-core.mjs';
const SELECTED_CANDIDATE='adaptive-12-24-v6';
const slash=value=>String(value).replaceAll('\\','/');
const same=(actual,expected)=>actual.byteLength===expected.byteLength&&actual.sha256===expected.sha256;
const segmentKey=(a,b)=>JSON.stringify(compareText(`${a[0]},${a[1]}`,`${b[0]},${b[1]}`)<=0?[a,b]:[b,a]);

function assertInputs(){
 const admin=fileIdentity(ADMINISTRATIVE_INDEX.path),v18=fileIdentity(V18.path),decision=readJSON(POLICY_DECISION),verification=readJSON(V18.path);
 if(!same(admin,ADMINISTRATIVE_INDEX))throw Error('15-19 prerequisite failure: current 15-18 artifact index bytes changed');
 if(!same(v18,V18)||verification.status!=='pass'||verification.counts?.unresolved!==0||verification.counts?.errorCount!==0)throw Error('15-19 prerequisite failure: V18 is not the pinned zero-error PASS');
 if(decision.status!=='pass'||decision.selectedCandidate!==SELECTED_CANDIDATE)throw Error('15-19 prerequisite failure: REVIEW B policy decision is not adaptive-12-24-v6 PASS');
 const candidate=POLICY.candidates.find(item=>item.id===SELECTED_CANDIDATE);if(!candidate)throw Error('15-19 prerequisite failure: selected candidate is absent from the current policy');
 return {admin,v18,decision:fileIdentity(POLICY_DECISION),policy:fileIdentity(POLICY_FILE),candidate};
}

function clippedToEnvelope(geometry,envelope){
 const coordinates=polygons(overlay('intersection',geometry,envelope).geometry);
 if(!coordinates.length)return null;return normalizeGeometry({type:'MultiPolygon',coordinates});
}

export function loadWorldCellSources(){
 const pins=assertInputs(),sources=loadExperimentSources(),admin=readJSON(`${ADMINISTRATIVE_ROOT}/administrative-restoration.geojson`),remainders=readJSON(`${ADMINISTRATIVE_ROOT}/residuals.geojson`),protectedOverlay=readJSON(`${ADMINISTRATIVE_ROOT}/protected-overlay.geojson`),p0=sources.p0,envelopes=new Map(p0.features.map(feature=>[feature.properties.countryId,feature.geometry]));
 const selected=[];
 for(const feature of admin.features){const countryId=feature.properties.sourceCountryId,geometry=clippedToEnvelope(feature.geometry,envelopes.get(countryId));if(!geometry)throw Error(`15-19 source identity is outside its P0 envelope: ${feature.properties.sourceFeatureId}`);selected.push({type:'Feature',properties:{...feature.properties,countryId,inputRole:'P1'},geometry});}
 for(const feature of remainders.features){const countryId=feature.properties.countryId;selected.push({type:'Feature',properties:{...feature.properties,countryId,sourceFeatureId:`country-envelope:${feature.properties.residualId}`,inputRole:'P0R'},geometry:normalizeGeometry(feature.geometry)});}
 selected.sort((a,b)=>compareText(a.properties.countryId,b.properties.countryId)||compareText(String(a.properties.sourceFeatureId),String(b.properties.sourceFeatureId)));
 const oldTerritories=new Map();for(const feature of protectedOverlay.features){const countryId=feature.properties.sourceCountryId,list=oldTerritories.get(countryId)??[];list.push({id:feature.properties.territoryId,geometry:feature.geometry,sourceFeatureIds:[]});oldTerritories.set(countryId,list);}for(const list of oldTerritories.values())list.sort((a,b)=>compareText(a.id,b.id));
 const refinement=new Map();for(const [countryId,segments] of sources.land)refinement.set(countryId,segments.slice());
 for(const feature of protectedOverlay.features){const countryId=feature.properties.sourceCountryId,list=refinement.get(countryId)??[],seen=new Set(list.map(segment=>segmentKey(segment.a,segment.b)));for(const polygon of polygons(feature.geometry))for(const ring of polygon)for(let index=1;index<ring.length;index++){const a=ring[index-1],b=ring[index],key=segmentKey(a,b);if(a[0]===b[0]&&a[1]===b[1]||seen.has(key))continue;seen.add(key);list.push({a,b,neighbor:null,protectedTerritoryId:feature.properties.territoryId});}refinement.set(countryId,list);}
 return {...sources,selected:{type:'FeatureCollection',features:selected},oldTerritories,refinement,protectOldBoundaries:true,protectedOverlay,pins};
}

export function auditCountryResult(result){
 const checks={
  validGeometry:result.validity.pass,
  parentUnion:result.coverage.length===result.parents.length&&result.coverage.every(item=>item.pass),
  countryCoverage:result.countryCoverage.pass,
  crossBorder:result.countryCoverage.outOfCountryArea<=result.countryCoverage.tolerance,
  protectedParent:result.cells.every(cell=>typeof cell.oldTerritoryId==='string'&&cell.oldTerritoryId!=='protected-overlay-split'),
  administrativeParent:result.cells.every(cell=>cell.adminId===null||cell.adminId===String(cell.parentSourceFeatureId)),
  componentSeparated:result.cells.every(cell=>polygons(cell.geometry).length===1),
  countryCap:result.cells.length<=POLICY.budgets.countryCells,
  diameter:result.cells.every(cell=>cell.diameterUpperBoundKm<=(cell.refined?POLICY.boundaryMaximumDiameterKm:POLICY.interiorMaximumDiameterKm)),
  area:result.cells.every(cell=>cell.areaKm2<=(cell.refined?POLICY.boundaryMaximumAreaKm2:POLICY.interiorMaximumAreaKm2)),
  numericalNoding:result.numericalNoding.maximumNodedSegmentDisplacement<=1e-12,
  protectedFragmentConservation:result.metrics.numericalProtectedFragmentsSkipped===0&&(result.numericalProtectedFragmentRepairs??[]).every(item=>item.area>0&&typeof item.geometryHash==='string'&&typeof item.sourceOldTerritoryId==='string'&&typeof item.assignedOldTerritoryId==='string'),
  cellFragmentConservation:(result.numericalCellRepairs??[]).every(item=>['lost-source-face-union','pre-noding-collapsed-ring-union','post-noding-degenerate-ring-union','collapsed-hole-fill','collapsed-component-ledger'].includes(item.kind)&&item.area>0&&typeof item.lostGeometryHash==='string'&&typeof item.parentKey==='string'),
  numericalGapRepair:(result.numericalGapRepairs??[]).every(item=>item.kind==='ambiguous-gap'&&item.area>0&&item.area<=1e-12),
 };
 return {status:Object.values(checks).every(Boolean)?'pass':'fail',checks};
}

const cellEntry=cell=>({id:cell.id,sourceCountryId:cell.sourceCountryId,oldTerritoryId:cell.oldTerritoryId,adminId:cell.adminId,parentKey:cell.parentKey,parentSourceFeatureId:cell.parentSourceFeatureId,sourceComponentHash:cell.sourceComponentHash,componentIndex:cell.componentIndex,sourceTiny:cell.sourceTiny,refined:cell.refined,areaKm2:cell.areaKm2,diameterKm:cell.diameterUpperBoundKm,bbox:cell.bbox,centroid:cell.centroid});
const cellFeature=cell=>({type:'Feature',properties:{cellId:cell.id,sourceCountryId:cell.sourceCountryId,oldTerritoryId:cell.oldTerritoryId,adminId:cell.adminId,parentKey:cell.parentKey,parentSourceFeatureId:cell.parentSourceFeatureId,componentIndex:cell.componentIndex,refined:cell.refined},geometry:cell.geometry});

export function generateWorldCatalog({outputBase='data/derived/prompt15',countryIds=null,onProgress=console.log}={}){
 const sources=loadWorldCellSources(),candidate=sources.pins.candidate,generator=fileIdentity('scripts/prompt15-world-catalog.mjs'),inputs=[sources.pins.admin,sources.pins.v18,sources.pins.decision,sources.pins.policy,generator,fileIdentity(CELL_CORE_FILE),fileIdentity(`${ADMINISTRATIVE_ROOT}/administrative-restoration.geojson`),fileIdentity(`${ADMINISTRATIVE_ROOT}/residuals.geojson`),fileIdentity(`${ADMINISTRATIVE_ROOT}/protected-overlay.geojson`)];
 const allCountries=sources.p0.features.map(feature=>feature.properties.countryId).sort(compareText),countries=countryIds?countryIds.slice().sort(compareText):allCountries;if(countries.some(id=>!allCountries.includes(id)))throw Error('15-19 contains an unknown country ID');
 const worldBuild=countries.length===allCountries.length&&countries.every((id,index)=>id===allCountries[index]);
 const rootKey=hashCanonical('prompt15-task-15-19-root.v1',{version:TASK_15_19_VERSION,candidate,inputs}).slice(0,20),root=path.join(outputBase,`${worldBuild?'15-19-operational-catalog':'15-19-partial'}-v1-${rootKey}`),staging=path.join(outputBase,`.15-19-staging-${rootKey}-${process.pid}`);
 if(fs.existsSync(root)||fs.existsSync(staging))throw Error(`Refusing to overwrite 15-19 output: ${fs.existsSync(root)?root:staging}`);fs.mkdirSync(staging,{recursive:true});
 const artifacts=[],write=(name,value,compressed=false)=>{const target=path.join(staging,name);fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,compressed?gzipSync(jsonBytes(value),{level:9,mtime:0}):jsonBytes(value),{flag:'wx'});const identity=fileIdentity(target);artifacts.push({path:slash(name),sha256:identity.sha256,byteLength:identity.byteLength,compression:compressed?'gzip':null});return identity;};
 const countrySummaries=[],globalIds=new Set();let worldCells=0,worldVertices=0,worldEdges=0;
 for(const [index,countryId] of countries.entries()){
  onProgress(`[${index+1}/${countries.length}] ${countryId}`);const result=generateCountryCells(sources,countryId,candidate,onProgress),audit=auditCountryResult(result),duplicates=[];for(const cell of result.cells){if(globalIds.has(cell.id))duplicates.push(cell.id);globalIds.add(cell.id);}
  if(duplicates.length)audit.checks.uniqueCellIds=false;worldCells+=result.cells.length;worldVertices+=result.metrics.vertexCount;worldEdges+=result.metrics.edgeCount;
  const prefix=`countries/${countryId}`;write(`${prefix}/catalog.json.gz`,{schemaVersion:TASK_15_19_VERSION,policyVersion:POLICY.version,candidateId:candidate.id,countryId,entries:result.cells.map(cellEntry)},true);write(`${prefix}/geometry.geojson.gz`,{type:'FeatureCollection',features:result.cells.map(cellFeature)},true);
  const generation={countryId,status:audit.status,checks:audit.checks,metrics:result.metrics,parents:result.parents,sourceComponents:result.sourceComponents,coverage:result.coverage,countryCoverage:result.countryCoverage,validity:result.validity,numericalNoding:result.numericalNoding,numericalProtectedFragmentRepairs:result.numericalProtectedFragmentRepairs,numericalCellRepairs:result.numericalCellRepairs,numericalGapRepairs:result.numericalGapRepairs,componentSeparation:result.componentSeparation,cellRoot:digest(jsonBytes(result.cells.map(cell=>cell.id).sort(compareText)))};write(`${prefix}/generation.json.gz`,generation,true);
  countrySummaries.push({countryId,status:audit.status,checks:audit.checks,metrics:result.metrics,cellRoot:generation.cellRoot,files:artifacts.slice(-3).map(item=>({...item}))});global.gc?.();
 }
 const capChecks={worldCells:worldCells<=POLICY.budgets.worldCells,worldVertices:worldVertices<=POLICY.budgets.worldVertices,worldEdges:worldEdges<=POLICY.budgets.worldEdges,countryCells:countrySummaries.every(item=>item.metrics.cellCount<=POLICY.budgets.countryCells)};
 const checks={allCountries:worldBuild,countryCount:countries.length===247,countriesPassed:countrySummaries.every(item=>item.status==='pass'),uniqueCellIds:globalIds.size===worldCells,protectedOverlayCount:sources.protectedOverlay.features.length===4231,...capChecks};
 const status=Object.values(checks).every(Boolean)?'pass':'fail',summary={task:'15-19',schemaVersion:TASK_15_19_VERSION,status,root:slash(root),candidate,checks,counts:{countries:countries.length,cells:worldCells,vertices:worldVertices,edges:worldEdges,administrativeParents:sources.selected.features.filter(feature=>feature.properties.inputRole==='P1').length,countryEnvelopeParents:sources.selected.features.filter(feature=>feature.properties.inputRole==='P0R').length,protectedTerritories:sources.protectedOverlay.features.length},budgets:{worldCells:POLICY.budgets.worldCells,worldVertices:POLICY.budgets.worldVertices,worldEdges:POLICY.budgets.worldEdges,countryCells:POLICY.budgets.countryCells},countries:countrySummaries,next:status==='pass'?'15-20 (not executed)':'15-19 repair; no immutable candidate admitted'};
 const provenance={task:'15-19',generatorVersion:TASK_15_19_VERSION,generator,command:'node --expose-gc scripts/prompt15-world-catalog.mjs',inputs,candidate,policyVersion:POLICY.version,administrativeInputRoot:ADMINISTRATIVE_ROOT,protectedOverlayRole:'Every positive cell is intersected with the exact 15-18 previous-territory overlay before common noding.',runtimeRegeneration:false,productionPublication:false,scope:'Offline immutable catalog draft only; topology/membership index, render delivery, migration, runtime, API, browser and cutover are not executed.'};
 write('catalog-root.json',{schemaVersion:TASK_15_19_VERSION,candidateId:candidate.id,countryOrder:countries,countryRoots:Object.fromEntries(countrySummaries.map(item=>[item.countryId,item.cellRoot])),cellCount:worldCells});write('provenance.json',provenance);write('summary.json',summary);
 const artifactIndex={schemaVersion:TASK_15_19_VERSION,root:slash(root),artifacts:artifacts.slice().sort((a,b)=>compareText(a.path,b.path)),totalByteLength:artifacts.reduce((sum,item)=>sum+item.byteLength,0),command:provenance.command};fs.writeFileSync(path.join(staging,'artifact-index.json'),jsonBytes(artifactIndex),{flag:'wx'});
 if(status!=='pass')throw Object.assign(Error(`15-19 world catalog rejected: ${JSON.stringify(checks)}`),{summary,staging});fs.renameSync(staging,root);
 return {root,summary,artifactIndexIdentity:fileIdentity(path.join(root,'artifact-index.json'))};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){try{const result=generateWorldCatalog();console.log(JSON.stringify({status:result.summary.status,root:result.root,counts:result.summary.counts,checks:result.summary.checks,artifactIndex:result.artifactIndexIdentity,next:result.summary.next}));}catch(error){console.error(JSON.stringify({status:'fail',message:error.message,staging:error.staging??null,checks:error.summary?.checks??null}));process.exitCode=1;}}
