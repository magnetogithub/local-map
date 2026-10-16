import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {gzipSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import {loadSourceSamples,pinFile} from '../source-samples.mjs';
import {loadFullSourceSamples} from '../full-source-samples.mjs';
import {policy,policyIdentity} from '../policy-validation.mjs';
import {assessCompleteSourceScope} from './source-scope-bound.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../..'),report=path.resolve(root,process.argv[2]??'.reports/15-14/feasibility.json.gz');
const relative=path.relative(path.join(root,'.reports'),report);
if(!relative||relative.startsWith('..')||path.isAbsolute(relative)||fs.existsSync(report))throw new Error('NEW_CANDIDATE_REPORT_REQUIRED');
const contextPath=path.resolve(root,'../task-input-context.json'),context=JSON.parse(fs.readFileSync(contextPath,'utf8'));
if(context.taskId!=='15-14'||path.resolve(context.candidateRoot)!==root)throw new Error('CANDIDATE_CONTEXT_MISMATCH');
const prerequisiteNames=['scripts/operational-cells/partition-prototype.mjs','scripts/operational-cells/source-samples.mjs','scripts/operational-cells/full-source-samples.mjs',
  'scripts/operational-cells/metric-chart.mjs','scripts/operational-cells/scoring-policy.json','scripts/operational-cells/policy-validation.mjs','scripts/operational-cells/scope-feasibility.mjs','src/lib/operational-cells/model.ts'];
const prerequisites=prerequisiteNames.map(name=>{const pin=pinFile(path.join(root,name));if(pin.sha256!==context.dirtyInventory.currentSource[name])throw new Error('PREREQUISITE_PIN_MISMATCH: '+name);return pin;});
const small=loadSourceSamples(root),full=loadFullSourceSamples(root);
const samples=[...small.samples,...full.samples].map(sample=>({...sample,projection:{...sample.projection,
  scaleMin:sample.projection.scaleMin??1-sample.projection.relativeErrorBound,scaleMax:sample.projection.scaleMax??1+sample.projection.relativeErrorBound}}));
const rows=samples.map(sample=>{const before=JSON.stringify(sample);
  const scopes=Object.keys(policy.extent).map(extent=>assessCompleteSourceScope(sample.parents,sample.projection,extent));
  if(before!==JSON.stringify(sample))throw new Error('IMMUTABLE_SOURCE_CHANGED');
  return {name:sample.name,sourceIdentities:sample.parents.map(p=>p.administrativeParent.identity),
    geometryPins:sample.parents.map(p=>({parentKey:p.key,sha256:createHash('sha256').update(JSON.stringify(p.geometry)).digest('hex')})),scopes};});
fs.mkdirSync(path.dirname(report),{recursive:true});
if(path.relative(fs.realpathSync(path.join(root,'.reports')),fs.realpathSync(path.dirname(report))).startsWith('..'))throw new Error('REPORT_PATH_ESCAPE');
fs.writeFileSync(report,gzipSync(JSON.stringify({version:1,taskId:'15-14',candidateRoot:root,policyIdentity,
  inputs:[pinFile(contextPath),...prerequisites,...small.sourceInputs,...full.inputs],samples,rows,
  scope:'Current source necessary bounds only, no partition generation or successful scope/REVIEW claim.'})),{flag:'wx'});
process.stdout.write(JSON.stringify({taskId:'15-14',samples:rows.length,certifiedInfeasibleScopes:rows.flatMap(r=>r.scopes.filter(s=>s.status==='infeasible').map(s=>({sample:r.name,extent:s.extent,minimumDepthKm:s.minimumDepthKm,landPathUpperKm:s.landPathUpperKm}))),report,officialVitestExecuted:false})+'\n');
