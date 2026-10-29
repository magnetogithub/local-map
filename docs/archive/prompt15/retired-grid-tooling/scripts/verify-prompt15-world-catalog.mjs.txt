// Prompt 15 V19: independent byte-level and country-level verification of the
// offline immutable catalog draft. This script never regenerates catalog data.
import fs from 'node:fs';
import path from 'node:path';
import {gunzipSync} from 'node:zlib';
import {pathToFileURL} from 'node:url';
import {CELL_EXPERIMENT_POLICY as POLICY} from './prompt15-cell-policy.mjs';
import {fileIdentity} from './prompt15-cell-core.mjs';
import {compareText,digest,jsonBytes,polygons} from './prompt14-catalog-core.mjs';
import {TASK_15_19_VERSION} from './prompt15-world-catalog.mjs';

const slash=value=>String(value).replaceAll('\\','/');
const readJSON=file=>JSON.parse(fs.readFileSync(file,'utf8'));
const readGzipJSON=file=>JSON.parse(gunzipSync(fs.readFileSync(file)).toString('utf8'));
const equalIdentity=(actual,expected)=>actual.byteLength===expected.byteLength&&actual.sha256===expected.sha256;

function filesBelow(root,current=root,result=[]){
 for(const entry of fs.readdirSync(current,{withFileTypes:true}).sort((a,b)=>compareText(a.name,b.name))){
  const target=path.join(current,entry.name);
  if(entry.isDirectory())filesBelow(root,target,result);
  else if(entry.isFile())result.push(slash(path.relative(root,target)));
  else result.push(`unsupported:${slash(path.relative(root,target))}`);
 }
 return result;
}

export function verifyWorldCatalog(root){
 const errors=[],fail=(code,detail)=>errors.push({code,detail}),safeRead=(label,read)=>{try{return read();}catch(error){fail(label,error.message);return null;}};
 const index=safeRead('artifact-index-readable',()=>readJSON(path.join(root,'artifact-index.json')));
 const summary=safeRead('summary-readable',()=>readJSON(path.join(root,'summary.json')));
 const provenance=safeRead('provenance-readable',()=>readJSON(path.join(root,'provenance.json')));
 const catalogRoot=safeRead('catalog-root-readable',()=>readJSON(path.join(root,'catalog-root.json')));
 if(!index||!summary||!provenance||!catalogRoot)return {status:'fail',root:slash(root),errors,checks:{documentsReadable:false}};

 const checks={
  schema:[index.schemaVersion,summary.schemaVersion,catalogRoot.schemaVersion].every(value=>value===TASK_15_19_VERSION),
  generatedPass:summary.status==='pass',
  immutableOffline:provenance.runtimeRegeneration===false&&provenance.productionPublication===false,
  candidateConsistent:summary.candidate?.id===catalogRoot.candidateId&&summary.candidate?.id===provenance.candidate?.id,
 };
 const indexed=new Map();
 for(const artifact of index.artifacts??[]){
  if(typeof artifact.path!=='string'||path.isAbsolute(artifact.path)||artifact.path.split('/').includes('..')){fail('unsafe-artifact-path',artifact.path);continue;}
  if(indexed.has(artifact.path)){fail('duplicate-artifact-path',artifact.path);continue;}
  indexed.set(artifact.path,artifact);
  const target=path.join(root,...artifact.path.split('/')),actual=safeRead('artifact-readable',()=>fileIdentity(target));
  if(actual&&!equalIdentity(actual,artifact))fail('artifact-identity',artifact.path);
 }
 const diskFiles=filesBelow(root).filter(name=>name!=='artifact-index.json');
 checks.artifactSet=diskFiles.length===indexed.size&&diskFiles.every(name=>indexed.has(name))&&[...indexed].every(([name])=>diskFiles.includes(name));
 checks.artifactCount=indexed.size===247*3+3;
 checks.artifactBytes=[...indexed.values()].reduce((sum,item)=>sum+item.byteLength,0)===index.totalByteLength;

 const countryOrder=catalogRoot.countryOrder??[],countrySummary=new Map((summary.countries??[]).map(item=>[item.countryId,item]));
 checks.countrySet=countryOrder.length===247&&new Set(countryOrder).size===247&&countrySummary.size===247;
 const globalIds=new Set(),countryAudits=[];let cells=0,vertices=0,edges=0;
 for(const countryId of countryOrder){
  const prefix=path.join(root,'countries',countryId),catalog=safeRead('country-catalog-readable',()=>readGzipJSON(path.join(prefix,'catalog.json.gz'))),geometry=safeRead('country-geometry-readable',()=>readGzipJSON(path.join(prefix,'geometry.geojson.gz'))),generation=safeRead('country-generation-readable',()=>readGzipJSON(path.join(prefix,'generation.json.gz'))),listed=countrySummary.get(countryId),countryErrors=[];
  const reject=(code,detail)=>{countryErrors.push({code,detail});fail(`country-${code}`,`${countryId}: ${detail}`);};
  if(!catalog||!geometry||!generation||!listed){reject('documents','missing catalog, geometry, generation or summary');countryAudits.push({countryId,status:'fail',errors:countryErrors});continue;}
  const entries=catalog.entries??[],features=geometry.features??[],ids=entries.map(item=>item.id);
  if(catalog.schemaVersion!==TASK_15_19_VERSION||catalog.countryId!==countryId)reject('catalog-contract','schema or country mismatch');
  if(geometry.type!=='FeatureCollection'||features.length!==entries.length)reject('geometry-count',`${features.length}/${entries.length}`);
  if(features.some(feature=>polygons(feature.geometry).length!==1))reject('component-separation','an operational cell contains disconnected polygon components');
  if(generation.status!=='pass'||!Object.values(generation.checks??{}).every(Boolean))reject('generation-gate','generation evidence is not an all-check PASS');
  if((generation.coverage??[]).length!==(generation.parents??[]).length||!(generation.coverage??[]).every(item=>item.pass))reject('parent-union','parent coverage failure');
  if(!generation.countryCoverage?.pass||generation.countryCoverage.outOfCountryArea>generation.countryCoverage.tolerance)reject('country-coverage','country coverage or cross-border failure');
  if(entries.length!==generation.metrics?.cellCount||entries.length!==listed.metrics?.cellCount)reject('cell-count','catalog/generation/summary mismatch');
  if(ids.some((id,index)=>features[index]?.properties?.cellId!==id))reject('geometry-order','catalog and geometry IDs differ');
  if(entries.some(entry=>entry.sourceCountryId!==countryId||typeof entry.oldTerritoryId!=='string'||!entry.oldTerritoryId||entry.oldTerritoryId==='protected-overlay-split'||entry.adminId!==null&&String(entry.adminId)!==String(entry.parentSourceFeatureId)))reject('lineage','country, protected parent or administrative parent mismatch');
  for(const id of ids){if(globalIds.has(id))reject('duplicate-cell-id',id);globalIds.add(id);}
  const cellRoot=digest(jsonBytes(ids.slice().sort(compareText)));
  if(cellRoot!==generation.cellRoot||cellRoot!==listed.cellRoot||cellRoot!==catalogRoot.countryRoots?.[countryId])reject('cell-root',cellRoot);
  if(entries.length>POLICY.budgets.countryCells)reject('country-cap',entries.length);
  cells+=entries.length;vertices+=generation.metrics.vertexCount;edges+=generation.metrics.edgeCount;
  countryAudits.push({countryId,status:countryErrors.length?'fail':'pass',cells:entries.length,vertices:generation.metrics.vertexCount,edges:generation.metrics.edgeCount,numericalProtectedFragmentsSkipped:generation.metrics.numericalProtectedFragmentsSkipped,numericalProtectedFragmentRepairs:generation.metrics.numericalProtectedFragmentRepairs,numericalCellRepairs:generation.metrics.numericalCellRepairs,numericalGapRepairs:generation.metrics.numericalGapRepairs,errors:countryErrors});
 }
 checks.countriesPassed=countryAudits.length===247&&countryAudits.every(item=>item.status==='pass');
 checks.uniqueCellIds=globalIds.size===cells;
 checks.counts=summary.counts?.countries===247&&summary.counts?.cells===cells&&summary.counts?.vertices===vertices&&summary.counts?.edges===edges&&catalogRoot.cellCount===cells;
 checks.worldCaps=cells<=POLICY.budgets.worldCells&&vertices<=POLICY.budgets.worldVertices&&edges<=POLICY.budgets.worldEdges;
 checks.summaryChecks=Object.values(summary.checks??{}).every(Boolean);
 checks.inputPins=(provenance.inputs??[]).every(expected=>{const actual=safeRead('input-pin-readable',()=>fileIdentity(expected.path));return actual?equalIdentity(actual,expected):false;});
 checks.rootIdentity=slash(summary.root)===slash(root)&&slash(index.root)===slash(root);
 for(const [name,value] of Object.entries(checks))if(!value)fail(`check-${name}`,value);
 return {task:'V19',status:errors.length?'fail':'pass',root:slash(root),generatorVersion:TASK_15_19_VERSION,checks,counts:{countries:countryAudits.length,cells,vertices,edges,uniqueCellIds:globalIds.size,numericalProtectedFragmentsSkipped:countryAudits.reduce((sum,item)=>sum+(item.numericalProtectedFragmentsSkipped??0),0),numericalProtectedFragmentRepairs:countryAudits.reduce((sum,item)=>sum+(item.numericalProtectedFragmentRepairs??0),0),numericalCellRepairs:countryAudits.reduce((sum,item)=>sum+(item.numericalCellRepairs??0),0),numericalGapRepairs:countryAudits.reduce((sum,item)=>sum+(item.numericalGapRepairs??0),0)},budgets:POLICY.budgets,countryAudits,errors};
}

export function writeV19Report(root,reportPath='reports/prompt15/15-19-v19.json'){
 const report=verifyWorldCatalog(root);report.verifier=fileIdentity('scripts/verify-prompt15-world-catalog.mjs');
 fs.writeFileSync(reportPath,jsonBytes(report),{flag:'wx'});
 if(report.status!=='pass')throw Object.assign(Error(`V19 failed with ${report.errors.length} errors`),{report});
 return {report,identity:fileIdentity(reportPath)};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 const root=process.argv[2];if(!root){console.error('Usage: node scripts/verify-prompt15-world-catalog.mjs <catalog-root> [report-path]');process.exitCode=2;}
 else try{const result=writeV19Report(root,process.argv[3]);console.log(JSON.stringify({status:result.report.status,root:result.report.root,counts:result.report.counts,report:result.identity,next:'15-20 (not executed)'}));}catch(error){console.error(JSON.stringify({status:'fail',message:error.message,errors:error.report?.errors?.slice(0,20)??[]}));process.exitCode=1;}
}
