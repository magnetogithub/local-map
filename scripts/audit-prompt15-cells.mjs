import fs from 'node:fs';
import path from 'node:path';
import {spawn,spawnSync} from 'node:child_process';
import {CELL_EXPERIMENT_POLICY as P} from './prompt15-cell-policy.mjs';
import {readJSON,fileIdentity,loadExperimentSources,sourceGeometryStats} from './prompt15-cell-core.mjs';
import {jsonBytes} from './prompt14-catalog-core.mjs';
const dir='reports/prompt15';
const write=(name,data)=>{const p=`${dir}/${name}`;fs.writeFileSync(p,jsonBytes(data));return fileIdentity(p);};
const summaryPath=(c,id,run='first')=>`${dir}/cell-experiments/${c}/${id}/${run}/summary.json`;
const policyPath=`${dir}/15-03-predeclared-policy.json`;
if(!fs.existsSync(policyPath))write('15-03-predeclared-policy.json',P);
if(!fs.readFileSync(policyPath).equals(jsonBytes(P)))throw Error('Frozen experiment thresholds changed');
const stageA=readJSON(`${dir}/15-REVIEW-A.json`);if(stageA.status!=='pass')throw Error('REVIEW A has not passed');
for(const a of stageA.evidence){const b=fileIdentity(a.path);if(a.sha256!==b.sha256||a.byteLength!==b.byteLength)throw Error(`Stale REVIEW A: ${a.path}`);}

function launch(country,candidate,run){return new Promise(resolve=>{
 const start=performance.now(),args=['--expose-gc','scripts/run-prompt15-cell-experiment.mjs',country,candidate,run],child=spawn(process.execPath,args,{stdio:['ignore','pipe','pipe']});let stdout='',stderr='';
 child.stdout.on('data',d=>{stdout+=d;});child.stderr.on('data',d=>{stderr+=d;});child.on('error',e=>{stderr+=e.message;});
 child.on('close',exitCode=>{const artifact=write(`15-03-${candidate}-${country}-${run}-execution.json`,{command:`node ${args.join(' ')}`,exitCode,elapsedMs:performance.now()-start,stdout,stderr});console.log(`${candidate}/${country}/${run}: exit ${exitCode}`);resolve({country,candidate,run,exitCode,artifact});});
});}
async function runJobs(jobs){const queue=jobs.slice(),results=[];await Promise.all([0,1].map(async()=>{while(queue.length){const [country,candidate,run]=queue.shift();results.push(await launch(country,candidate,run));}}));return results;}

if(process.argv[2]==='first'){
 const existing=spawnSync('git',['status','--short'],{encoding:'utf8'}).stdout;
 const frozen=readJSON('data/catalogs/prompt14/frozen-catalog-ref.json'),base=path.dirname(frozen.artifactIndex.path),index=readJSON(frozen.artifactIndex.path);
 const preserve=[...stageA.evidence.map(a=>a.path),...index.artifacts.map(a=>`${base}/${a.path}`),...index.artifacts.filter(a=>a.path.startsWith('public/')).map(a=>a.path),
  'data/source-locks/prompt14-derived-game-input-lock.json','data/derived/prompt14/shared-game-p0.geojson','data/derived/prompt14/shared-admin1-input.geojson','data/derived/prompt14/selected-game-input.geojson',
  ...spawnSync('git',['diff','--name-only'],{encoding:'utf8'}).stdout.trim().split(/\r?\n/).filter(Boolean)];
 write('15-03-start-snapshot.json',{dirtyAtStart:existing,inputs:[...new Set(preserve)].map(fileIdentity),policy:fileIdentity(policyPath),reviewA:fileIdentity(`${dir}/15-REVIEW-A.json`)});
 const candidateFilter=process.argv[3];if(candidateFilter&&!P.candidates.some(c=>c.id===candidateFilter))throw Error('Unknown candidate filter');
 const results=await runJobs(P.candidates.filter(c=>!candidateFilter||c.id===candidateFilter).flatMap(c=>P.representativeCountries.map(id=>[id,c.id,'first'])));
 write('15-03-first-executions.json',{status:results.every(r=>r.exitCode===0)?'pass':'fail',results});
}else if(process.argv[2]==='second'){
 const candidate=process.argv[3]??'adaptive-12-24';if(!P.candidates.some(c=>c.id===candidate))throw Error('Unknown candidate');
 write('15-03-second-executions.json',{candidate,results:await runJobs(P.representativeCountries.map(id=>[id,candidate,'second']))});
}else if(process.argv[2]==='review'){
 const sources=loadExperimentSources(),stats=sourceGeometryStats(sources),comparisons=[];
 for(const candidate of P.candidates){
  const samples=P.representativeCountries.map(country=>{const p=summaryPath(candidate.id,country);return fs.existsSync(p)?{...readJSON(p),summary:fileIdentity(p)}:{status:'fail',countryId:country,reason:readJSON(p.replace('summary.json','failure.json')).message};});
  const measured=samples.filter(s=>s.metrics),count=measured.reduce((n,s)=>n+s.metrics.cellCount,0),area=measured.reduce((n,s)=>n+s.coverage.reduce((a,p)=>a+(p.p0Area??0),0),0);
  // Conservative analytic estimate includes source partition perimeter and country border bands.
  const baseCells=stats.areaKm2/(candidate.baseKm**2),fragmentAllowance=2*stats.parentPerimeterKm/candidate.baseKm+stats.components;
  const refinedAreaUpperKm2=candidate.refineKm?Math.min(stats.areaKm2,2*(P.borderRefinementBandKm+candidate.baseKm*Math.SQRT2)*stats.uniqueLandBoundaryKm):0;
  const analyticWorldCells=Math.ceil(baseCells+fragmentAllowance+(candidate.refineKm?refinedAreaUpperKm2*(1/candidate.refineKm**2-1/candidate.baseKm**2):0));
  const sampleCellsPerKm2=measured.reduce((n,s)=>n+s.metrics.cellCount,0)/measured.reduce((n,s)=>n+s.countryCoverage.p0Area,0); // degrees² is NOT used for physical extrapolation below.
  const measuredArea=measured.reduce((n,s)=>n+readJSON(`${dir}/cell-experiments/${candidate.id}/${s.countryId}/first/membership.json`).reduce((a,p)=>a+p.metrics.areaKm2,0),0);
  const empiricalWorldCells=Math.ceil(stats.areaKm2*count/measuredArea);
  const projectedWorldCells=Math.max(analyticWorldCells,empiricalWorldCells);
  const maxPerCell=field=>Math.max(0,...measured.map(s=>field(s)/Math.max(1,s.metrics.cellCount)));
  const costs={worldCells:projectedWorldCells,worldVertices:Math.ceil(projectedWorldCells*maxPerCell(s=>s.metrics.vertexCount)),worldEdges:Math.ceil(projectedWorldCells*maxPerCell(s=>s.metrics.edgeCount)),
   renderBytes:Math.ceil(projectedWorldCells*maxPerCell(s=>s.render.totalBytes)),initialMetadataBytes:Math.ceil(projectedWorldCells*maxPerCell(s=>s.proxy.metadataBytes)),
   initialStateBytes:Math.ceil(projectedWorldCells*maxPerCell(s=>s.proxy.stateBytes)),clientInitialHeapBytes:Math.ceil(projectedWorldCells*maxPerCell(s=>s.proxy.retainedHeapBytes)*2),
   serverInitialHeapBytes:Math.ceil(projectedWorldCells*maxPerCell(s=>s.proxy.retainedHeapBytes)*3),initialConstructionMs:Math.ceil(projectedWorldCells*maxPerCell(s=>s.proxy.constructionMs))};
  const budgetChecks=Object.fromEntries(Object.entries(costs).map(([k,v])=>[k,v<=P.budgets[k]]));
  comparisons.push({candidate,samples:samples.map(s=>({countryId:s.countryId,status:s.status,checks:s.checks??null,metrics:s.metrics??null,summary:s.summary??null,reason:s.reason??null})),allSampleChecksPassed:samples.every(s=>s.status==='pass'),
   worldProjection:{analyticWorldCells,empiricalWorldCells,costs,budgetChecks,sourceStats:stats,method:'Maximum of conservative physical area/perimeter/frontier-band estimate and measured stratified sample density. Resource costs use worst observed bytes/heap per cell; not global actual-byte proof.',samplePhysicalAreaKm2:measuredArea,sampleCellCount:count,unusedPlanarDiagnosticArea:area,unusedPlanarDiagnosticDensity:sampleCellsPerKm2}});
 }
 const choice=P.selectionOrder.map(id=>comparisons.find(c=>c.candidate.id===id)).find(c=>c.allSampleChecksPassed&&Object.values(c.worldProjection.budgetChecks).every(Boolean));
 const selected=choice?.candidate.id??null,independence=[];
 if(selected)for(const country of P.representativeCountries){const first=summaryPath(selected,country),second=summaryPath(selected,country,'second');
  if(!fs.existsSync(second)){independence.push({country,status:'missing'});continue;}
  const a=readJSON(first),b=readJSON(second);const rootsEqual=JSON.stringify(a.deterministicRoots)===JSON.stringify(b.deterministicRoots);
  const bytesEqual=['geometry.geojson','topology.json','membership.json','cell-measurements.json'].every(name=>fs.readFileSync(first.replace('summary.json',name)).equals(fs.readFileSync(second.replace('summary.json',name))));
  independence.push({country,status:rootsEqual&&bytesEqual&&b.status==='pass'?'pass':'fail',rootsEqual,bytesEqual,first:fileIdentity(first),second:fileIdentity(second),scope:'Geometry/topology/membership/measurements bytes and every PBF tile identity root; timing/heap summaries are intentionally nondeterministic'});
 }
 const snapshot=readJSON(`${dir}/15-03-start-snapshot.json`),preservation=snapshot.inputs.map(a=>{const b=fileIdentity(a.path);return {path:a.path,pass:a.sha256===b.sha256&&a.byteLength===b.byteLength};});
 const status=selected&&independence.length===P.representativeCountries.length&&independence.every(i=>i.status==='pass')&&preservation.every(p=>p.pass)?'pass':'fail';
 write('15-03-policy-decision.json',{checkpoint:'15-3',status,selectedCandidate:selected,policy:fileIdentity(policyPath),comparisons,independence,preservation,
  inputs:[fileIdentity('scripts/prompt15-cell-core.mjs'),fileIdentity('scripts/run-prompt15-cell-experiment.mjs'),fileIdentity('scripts/audit-prompt15-cells.mjs')],command:'node scripts/audit-prompt15-cells.mjs first; node scripts/audit-prompt15-cells.mjs second <candidate>; node scripts/audit-prompt15-cells.mjs review',tools:{node:process.version},
  next:status==='pass'?'15-4: global recovered/protected overlay common refinement and actual-byte budget gates':'15-3: resolve failed physical/behavior/resource gates; retain predeclared thresholds or explicitly open a new experiment policy, never relabel a failed one as pass',
  limitations:['Authalic spherical physical measurements, not ellipsoidal surveying','Current-frontier/qualitative selection is an offline graph experiment; production enforcement deferred','Global cost projections must be replaced by actual world bytes at REVIEW C','Stage A fallback recovery blocks remain prerequisites for 15-4','No migration/API/browser/runtime cutover executed in 15-3']});
 write('15-REVIEW-B.json',{review:'B',status,selectedCandidate:selected,checkpoint:fileIdentity(`${dir}/15-03-policy-decision.json`),criteria:{predeclaredPolicy:true,multiGeographySamples:!!choice?.allSampleChecksPassed,costBudgets:!!choice&&Object.values(choice.worldProjection.budgetChecks).every(Boolean),independentReproduction:independence.length===P.representativeCountries.length&&independence.every(i=>i.status==='pass'),preservation:preservation.every(p=>p.pass)},resumeAt:status==='pass'?'15-4':'15-3',productionCutover:false});
 console.log(JSON.stringify({status,selected,comparisons:comparisons.map(c=>({candidate:c.candidate.id,passed:c.allSampleChecksPassed,worldCells:c.worldProjection.costs.worldCells,budgets:c.worldProjection.budgetChecks,failedSamples:c.samples.filter(s=>s.status!=='pass').map(s=>({country:s.countryId,checks:s.checks,reason:s.reason}))})),independence:independence.map(i=>({country:i.country,status:i.status}))}));
}else throw Error('Usage: first | second <candidate> | review');
