import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {gzipSync,gunzipSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import {loadRepresentatives,generateSample,measureExperiment,CANDIDATES} from './experiments.mjs';
import {loadSourceSamples,pinFile} from '../source-samples.mjs';
import {freezeReceiptDigest,policyIdentity} from '../policy-validation.mjs';
import {packPartition} from '../compact-partition.mjs';
import {assessCompleteSourceScope} from './source-scope-bound.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../..');
const output=path.resolve(root,process.argv[2]??'.reports/15-14/current'),reports=path.join(root,'.reports');
const relative=path.relative(reports,output);
if(!relative||relative.startsWith('..')||path.isAbsolute(relative))throw new Error('CANDIDATE_REPORT_DIRECTORY_REQUIRED');
fs.mkdirSync(output,{recursive:true});
if(path.relative(fs.realpathSync(reports),fs.realpathSync(output)).startsWith('..'))throw new Error('REPORT_SYMLINK_ESCAPE');
const contextFile=path.resolve(process.env.PROMPT15_TASK_INPUT_CONTEXT_PATH??path.join(root,'../task-input-context.json'));
const context=JSON.parse(fs.readFileSync(contextFile,'utf8'));
if(context.taskId!=='15-14'||path.resolve(context.candidateRoot)!==root)throw new Error('CANDIDATE_CONTEXT_MISMATCH');
const prerequisiteNames=['src/lib/operational-cells/model.ts','scripts/operational-cells/common-refinement.mjs',
  'scripts/operational-cells/partition-prototype.mjs','scripts/operational-cells/source-samples.mjs','scripts/operational-cells/full-source-samples.mjs',
  'scripts/operational-cells/metric-chart.mjs','scripts/operational-cells/prototype-frontier.mjs','scripts/operational-cells/prototype-assessment.mjs',
  'scripts/operational-cells/compact-partition.mjs','scripts/operational-cells/scope-feasibility.mjs','scripts/operational-cells/policy-validation.mjs','scripts/operational-cells/scoring-policy.json'];
const preserved=prerequisiteNames.map(p=>{const pin=pinFile(path.join(root,p));if(pin.sha256!==context.dirtyInventory.currentSource[p])throw new Error('PREREQUISITE_PIN_MISMATCH: '+p);return pin;});
const taskRoot=path.resolve(root,'../../..'),receiptPath=path.join(taskRoot,'15-12/attempt-001/candidate/.reports/15-12/freeze-receipt.json');
const receipt=JSON.parse(fs.readFileSync(receiptPath,'utf8')),receiptDigest=freezeReceiptDigest(receipt);
if(receipt.policySha256!==policyIdentity.sha256)throw new Error('FREEZE_POLICY_MISMATCH');
const full=loadRepresentatives(root),small=loadSourceSamples(root);
const samples=[...full.samples,...small.samples.map(s=>({...s,projection:{...s.projection,scaleMin:1-s.projection.relativeErrorBound,scaleMax:1+s.projection.relativeErrorBound}}))];
const dependencyEvidencePath=path.join(taskRoot,'15-13/attempt-004/candidate/.reports/15-13/blocked-evidence.json');
const dependencyEvidence=JSON.parse(fs.readFileSync(dependencyEvidencePath,'utf8'));
const ownDirectory=path.dirname(fileURLToPath(import.meta.url));
const inputs=[pinFile(contextFile),...preserved,...full.inputs,...small.sourceInputs,pinFile(receiptPath),pinFile(dependencyEvidencePath),
  ...fs.readdirSync(ownDirectory).filter(n=>n.endsWith('.mjs')||n==='README.md').sort().map(n=>pinFile(path.join(ownDirectory,n))),
  ...['package.json','package-lock.json','node_modules/polygon-clipping/package.json','node_modules/jsts/package.json','node_modules/zod/package.json','node_modules/vitest/package.json','validation/node_modules/fast-check/package.json'].map(p=>pinFile(path.join(root,p)))];
fs.mkdirSync(path.join(root,'.reports/15-14/final'),{recursive:true});
const uniqueInputs=[...new Map(inputs.map(p=>[p.path,p])).values()];
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const runIdentity=sha(JSON.stringify({candidateRoot:root,inputs:uniqueInputs}));
const writeBytes=(file,bytes)=>{
  if(fs.existsSync(file)){if(!fs.readFileSync(file).equals(bytes))throw new Error('EXISTING_REPORT_CHANGED: '+file);return;}
  fs.writeFileSync(file,bytes,{flag:'wx'});
};
const write=(file,value,gzip=false)=>writeBytes(file,gzip?gzipSync(JSON.stringify(value)):Buffer.from(JSON.stringify(value,null,2)));
write(path.join(output,'run-inputs.json'),{version:1,taskId:'15-14',candidateRoot:root,runIdentity,inputs:uniqueInputs});
// Preserve the actual pre-experiment receipt bytes, never create/refreeze a policy.
writeBytes(path.join(root,'.reports/15-14/final-freeze-receipt.json'),fs.readFileSync(receiptPath));
write(path.join(root,'.reports/15-14/preserved-inputs.json'),{version:1,inputs:uniqueInputs});
const rows=[],cases=[];
for(const sample of samples)for(const candidate of CANDIDATES){
  const start=performance.now(),file=path.join(output,`case-${String(rows.length+1).padStart(2,'0')}.json.gz`);
  const caseReceipt=file+'.receipt.json';
  try{
    let record;
    if(fs.existsSync(file)){
      if(!fs.existsSync(caseReceipt))throw new Error('INCOMPLETE_CASE_CHECKPOINT: '+file);
      const checkpoint=JSON.parse(fs.readFileSync(caseReceipt,'utf8')),actual=pinFile(file);
      if(checkpoint.runIdentity!==runIdentity||checkpoint.identity.sha256!==actual.sha256||checkpoint.identity.byteLength!==actual.byteLength)throw new Error('CASE_CHECKPOINT_PIN_MISMATCH');
      record=JSON.parse(gunzipSync(fs.readFileSync(file)));
      if(JSON.stringify(record.sample)!==JSON.stringify(sample)||record.result.candidate!==candidate||record.freezeReceiptSha256!==receiptDigest)throw new Error('CASE_INPUT_MISMATCH');
    }else{
    const immutableBefore=JSON.stringify(sample),generationStarted=performance.now(),result=generateSample(sample,candidate),generationMs=performance.now()-generationStarted;
    const measurementStarted=performance.now(),measurement=measureExperiment(sample,result),measurementMs=performance.now()-measurementStarted;
    const packingStarted=performance.now(),packed=packPartition(result),packingMs=performance.now()-packingStarted;
    if(JSON.stringify(sample)!==immutableBefore)throw new Error('SOURCE_INPUT_MUTATED');
    const cost={scope:'actual representative partition only; world extrapolation and complete cost selection belong to 15-16',
      cells:result.cells.length,positiveEdges:result.edges.filter(e=>e.lengthMetres>0).length,
      vertices:result.cells.reduce((s,c)=>s+c.geometry.coordinates.flat(c.geometry.type==='Polygon'?1:2).length,0),
      membershipEntries:packed.membershipEntries,packedBytes:packed.byteLength,decodedTypedArrayBytes:packed.decodedTypedArrayBytes,
      provenanceDictionaryEntries:packed.provenanceDictionaryEntries,layout:packed.layout,
      generationMs,measurementMs,packingMs,elapsedMs:performance.now()-start,processPeakRssBytes:process.resourceUsage().maxRSS*1024,
      observedHeapUsedBytes:process.memoryUsage().heapUsed,heapMeasurement:'endpoint observation; processPeakRssBytes is cumulative OS peak, not per-case heap peak'};
    record={version:1,taskId:'15-14',sample,result,measurement,cost,freezeReceiptSha256:receiptDigest,
      sourceScopeFeasibility:Object.keys(measurement.advances.initial.reduce((s,a)=>(s[a.extent]=true,s),{})).map(extent=>assessCompleteSourceScope(sample.parents,sample.projection,extent))};
    write(file,record,true);
    write(caseReceipt,{version:1,runIdentity,sample:sample.name,candidate,identity:pinFile(file)});
    }
    const {result,measurement}=record;cases.push(record);
    rows.push({name:sample.name,candidate,file:path.relative(root,file).replaceAll('\\','/'),identity:pinFile(file),cells:result.cells.length,
      physicalStatus:measurement.physical.status,initialNear:measurement.advances.initial[0].status,subsequentNear:measurement.advances.subsequent[0].status,
      initialRetained:measurement.advances.initial[0].perAdmin.map(p=>p.retainedInteriorFractionLower),subsequentRetained:measurement.advances.subsequent[0].perAdmin.map(p=>p.retainedInteriorFractionLower),
      elapsedMs:record.cost.elapsedMs,generationMs:record.cost.generationMs});
  }catch(error){const record={version:1,taskId:'15-14',sample:sample.name,candidate,status:'generation-or-measurement-error',error:error.message};
    write(file+'.error.json',record);rows.push({...record,file});process.exitCode=1;}
  process.stdout.write(JSON.stringify(rows.at(-1))+'\n');
}
write(path.join(output,'index.json'),{version:1,taskId:'15-14',policyIdentity,freezeReceiptSha256:receiptDigest,rows});
write(path.join(root,'.reports/15-14/final/experiments.json.gz'),{version:1,taskId:'15-14',cases},true);
const allScopes=cases.flatMap(r=>['initial','subsequent'].flatMap(phase=>r.measurement.advances[phase].map(s=>({sample:r.sample.name,candidate:r.result.candidate,phase,...s}))));
const scopeStatusCounts=Object.fromEntries(['eligible','rejected','infeasible'].map(s=>[s,allScopes.filter(r=>r.status===s).length]));
write(path.join(root,'.reports/15-14/final/summary.json'),{version:1,taskId:'15-14',candidateRoot:root,runIdentity,
  expectedCases:samples.length*CANDIDATES.length,expectedScopes:samples.length*CANDIDATES.length*6,
  measuredCases:cases.length,measuredScopes:allScopes.length,matrixComplete:cases.length===36&&allScopes.length===216,
  completeSourceParents:true,rows,scopeStatusCounts,
  physical:cases.map(r=>({sample:r.sample.name,candidate:r.result.candidate,status:r.measurement.physical.status,
    perParent:r.measurement.physical.perParent,perCountry:r.measurement.physical.perCountry,stages:r.measurement.physical.stages,stageFailures:r.measurement.physical.stageFailures})),
  scopes:allScopes,
  sourceScopeFeasibility:cases.map(r=>({sample:r.sample.name,candidate:r.result.candidate,scopes:r.sourceScopeFeasibility})),
  actualRepresentativeCosts:cases.map(r=>({sample:r.sample.name,candidate:r.result.candidate,...r.cost})),
  historicalWorldCostEstimates:{evidence:pinFile(dependencyEvidencePath),...dependencyEvidence.generationBudget,
    provenance:'Historical extrapolations retained verbatim, separate from current representative timings. No new world extrapolation or budget approval.'},
  freezeReceiptSource:pinFile(receiptPath),inputPreservation:'preserved-inputs.json before; preserved-inputs-after.json after',
  fullParentPolicyApproval:false,policySelectionOwner:'15-17; this flag does not score success or rejection of a candidate',
  verification:'prepared only; controller owns official Vitest',limitations:['Source experiments do not approve restored administrative country envelopes or migration.',
    'Grid/adaptive failures and physically infeasible small scopes remain explicit. No exceptions or policy thresholds changed.',
    'No full-world generation, production tool, browser/E2E, publication or cutover performed.']});
for(const p of inputs){const now=pinFile(p.path);if(now.sha256!==p.sha256||now.byteLength!==p.byteLength)throw new Error('SHARED_INPUT_CHANGED: '+p.path);}
write(path.join(root,'.reports/15-14/preserved-inputs-after.json'),{version:1,inputs:uniqueInputs.map(p=>pinFile(p.path)),matchesBefore:true});
