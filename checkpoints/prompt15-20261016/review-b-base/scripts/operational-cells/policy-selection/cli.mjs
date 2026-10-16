import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {gzipSync,gunzipSync} from 'node:zlib';
import {buildPolicyHandoff,verifyPinnedBytes} from './summary.mjs';
import {pinFile} from '../source-samples.mjs';
import {policyIdentity} from '../policy-validation.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../..'),reports=path.join(root,'.reports');
const inside=(base,p)=>{const rel=path.relative(base,p);return !!rel&&!rel.startsWith('..')&&!path.isAbsolute(rel);};
const local=p=>{const file=path.resolve(root,p);if(!inside(reports,file))throw new Error('CANDIDATE_REPORT_REQUIRED');return file;};
const out=local(process.argv[2]),configFile=local(process.argv[3]);
const json=p=>JSON.parse(fs.readFileSync(p,'utf8'));
const config=json(configFile),inputs=[pinFile(configFile)],copies=[];
const consume=pin=>{const bytes=fs.readFileSync(pin.path);verifyPinnedBytes(bytes,pin);inputs.push(pinFile(pin.path));return bytes;};
const context=JSON.parse(consume(config.contextIdentity));
if(context.taskId!=='15-17'||context.candidateRoot!==root)throw new Error('CANDIDATE_CONTEXT_MISMATCH');
if(fs.existsSync(out))throw new Error('NEW_OUTPUT_REQUIRED');
fs.mkdirSync(out,{recursive:true});
if(!inside(fs.realpathSync(reports),fs.realpathSync(out)))throw new Error('REPORT_SYMLINK_ESCAPE');
const write=(name,value,gzip=false)=>fs.writeFileSync(path.join(out,name),gzip?gzipSync(JSON.stringify(value)):JSON.stringify(value,null,2),{flag:'wx'});
for(const pin of config.inputs??[])consume(pin);
for(const pin of config.verdicts??[])if(JSON.parse(consume(pin)).verdict!=='pass')throw new Error('DEPENDENCY_NOT_PASSED: '+pin.path);
for(const d of context.dependencies){const p={...d.identity,path:path.join(root,d.logicalPath)};consume(p);}
// Only this candidate's product code is loaded. An upstream report is evidence,
// never a source-code import, runtime/config replacement or alternate cwd.
for(const [relative,sha256]of Object.entries(context.dirtyInventory.currentSource)){
  if(!/^(scripts\/operational-cells\/|src\/lib\/operational-cells\/|package(?:-lock)?\.json$)/.test(relative))continue;
  const pin=pinFile(path.join(root,relative));
  if(pin.sha256!==sha256)throw new Error('INHERITED_SOURCE_CHANGED: '+relative);
  inputs.push(pin);
}
for(const [name,pin]of Object.entries(config.copies)){
  if(path.basename(name)!==name)throw new Error('INVALID_COPY_NAME');
  const bytes=consume(pin),file=path.join(out,name);fs.writeFileSync(file,bytes,{flag:'wx'});
  const localPin=pinFile(file);inputs.push(localPin);copies.push({name,source:pin,local:localPin});
}
const read=name=>{const b=fs.readFileSync(path.join(out,name));return JSON.parse(name.endsWith('.gz')?gunzipSync(b):b);};
const fixture=read('identity-fixture.json'),freeze=read('criteria-freeze-receipt.json');
if(freeze.policySha256!==policyIdentity.sha256||freeze.policyByteLength!==policyIdentity.byteLength||freeze.candidateResultsConsumed!==0)throw new Error('CRITERIA_FREEZE_MISMATCH');
verifyPinnedBytes(fs.readFileSync(path.join(out,'identity-generator-closure.json')),fixture.provenance.generation.generator.artifact);
verifyPinnedBytes(fs.readFileSync(path.join(out,'identity-projection-definition.json')),fixture.provenance.generation.projection.definition);
for(const group of ['source','envelope'])for(const key of ['rawSource','approvedGeometry','correspondence']){
  const expected=fixture.provenance[group][key],relative=expected.path.replaceAll('\\','/').split('/candidate/')[1];
  if(!relative)throw new Error('CANDIDATE_SOURCE_PATH_REQUIRED');
  consume({...expected,path:path.join(root,relative)});
}
for(const dependency of fixture.provenance.generation.dependencies){
  const expected=dependency.artifact,relative=expected.path.replaceAll('\\','/').split('/candidate/')[1];
  if(!relative)throw new Error('CANDIDATE_DEPENDENCY_PATH_REQUIRED');
  consume({...expected,path:path.join(root,relative)});
}
const publicManifest=path.join(root,'public',fixture.face.previousGeometryParent.catalogRef.manifestPath.slice(1));
const retainedCatalogExpected=freeze.sourceInputs.find(p=>p.path.replaceAll('\\','/').endsWith('/public'+fixture.face.previousGeometryParent.catalogRef.manifestPath));
if(!retainedCatalogExpected)throw new Error('RETAINED_CATALOG_PIN_REQUIRED');
consume({...retainedCatalogExpected,path:publicManifest});
const retainedCatalogPin=pinFile(publicManifest);
const experiments=read('experiments.json.gz'),measurements=read('measurements.json.gz');
// Current complete generation failures only. Historical rejected policies and
// numerical chart errors remain separate explicit negative inputs in config.
const diagnostics={version:1,records:experiments.cases.filter(r=>!r.result).map(r=>({sample:r.sample,candidate:r.candidate,status:r.status,error:r.error})),
  historicalNegativeFixtures:config.historicalNegativeFixtures??[]};
write('diagnostics.json.gz',diagnostics,true);
const handoff=buildPolicyHandoff({experiments,measurements,costSummary:read('cost-summary.json'),areas:read('areas.json'),
  identityFixture:fixture,identitySummary:read('identity-summary.json'),diagnostics});
const parents=read('generation-parents.json'),commands=read('cost-reproduction-commands.json'),generationEvidence=read('generation-evidence.json');
const experimentPin=copies.find(p=>p.name==='experiments.json.gz').source;
if(generationEvidence.generationRerun!==false||generationEvidence.sourceReport.sha256!==experimentPin.sha256||
  generationEvidence.sourceReport.byteLength!==experimentPin.byteLength)throw new Error('GENERATION_SOURCE_IDENTITY_MISMATCH');
const workerCommands=commands.commands.map(c=>{
  const record=experiments.cases.find(r=>r.sample.name===c.stdin.sample&&r.result.candidate===c.stdin.candidate);
  if(!record)throw new Error('REPRODUCTION_INPUT_MISSING');
  const stdin=parents[record.sample.name]?{...record,generationParents:parents[record.sample.name]}:record;
  const bytes=Buffer.from(JSON.stringify(stdin));verifyPinnedBytes(bytes,{path:'worker stdin',byteLength:bytes.length,sha256:c.stdin.sha256});
  // Rebind the complete actual worker signature, including the generation
  // receipt and row index. Node options are measured metadata, not thresholds.
  const workerIndex=c.command.findIndex(arg=>path.basename(arg)==='worker.mjs');
  if(workerIndex<1||c.command.length!==workerIndex+4)throw new Error('UNSUPPORTED_REPRODUCTION_COMMAND');
  const options=c.command.slice(1,workerIndex),rowIndex=Number(c.command[workerIndex+3]);
  const row=generationEvidence.rows[rowIndex],measurement=measurements.cases.find(m=>m.sample===record.sample.name&&m.candidate===record.result.candidate);
  if(!row||row.sample!==record.sample.name||row.candidate!==record.result.candidate||
    row.resultSha256!==measurement.regenerationSha256||row.generationMs!==measurement.timings.generationMs||c.generationRerun!==false)
    throw new Error('GENERATION_RECEIPT_MISMATCH');
  return {command:[process.execPath,...options,path.join(root,'scripts/operational-cells/cost-comparison/worker.mjs'),
    path.join(out,'identity-fixture.json'),path.join(out,'generation-evidence.json'),String(rowIndex)],
    historicalCommand:c.command,stdin:c.stdin,exitCode:c.exitCode,
    generationRerun:false,generationEvidenceRow:rowIndex,
    stdinRecipe:'Find sample/candidate in experiments.json.gz; append generationParents from generation-parents.json when keyed by sample.name; JSON.stringify with no whitespace.',
    execution:'Pinned historical encoding measurement. Candidate-bound command is a reproduction recipe only; neither generation nor benchmark is rerun by task 15-17.'};
});
handoff.candidateRoot=root;handoff.reproduction={workerCommands,evidence:copies,summaryCommand:
  ['node','scripts/operational-cells/policy-selection/cli.mjs','.reports/15-17/new-final',path.relative(root,configFile)],
  generator:'Current complete-parent experiments and all immutable generator/projection/dependency pins are retained; no bounded-chart fallback.',
  generationReceipt:pinFile(path.join(out,'generation-evidence.json')),
  generatorSourcePins:inputs.filter(p=>p.path.startsWith(path.join(root,'scripts/operational-cells'))),
  dependencyPins:inputs.filter(p=>p.path.startsWith(path.join(root,'node_modules'))||p.path.startsWith(path.join(root,'validation/archives'))),
  scope:'Pinned prerequisite bytes reused without geometry generation or cost benchmark. Diagnostic artifact completion does not approve a policy or REVIEW B.'};
write('policy-handoff.json.gz',handoff,true);
write('decision.json',{version:1,taskId:'15-17',status:handoff.status,selectedPolicy:handoff.selectedPolicy,
  candidates:handoff.candidates.map(c=>({candidate:c.candidate,eligible:c.eligible,physicalFailures:c.physicalFailures.length,
    scopeFailures:c.scopeFailures.length,exceededBudgets:c.exceededBudgets,maxMeasuredNearCells:c.maxMeasuredNearCells,returnTo:c.returnTo})),
  failureCheckpoint:handoff.failureCheckpoint,worldGenerationApproved:false,reviewBApproved:false,
  retainedCatalog:{ref:fixture.face.previousGeometryParent.catalogRef,manifest:retainedCatalogPin},
  artifactCompletion:'complete',
  completion:handoff.selectedPolicy?'Eligible policy selection artifacts prepared for independent verification.':'Diagnostic handoff complete: no policy qualifies. Retain the approved existing catalog and route linked geometry/scope/cost failures to the responsible repair checkpoint; no policy or REVIEW B approval.'});
write('evidence-index.json',{version:1,candidateRoot:root,copies});
for(const f of ['summary.mjs','cli.mjs','README.md'])inputs.push(pinFile(path.join(root,'scripts/operational-cells/policy-selection',f)));
for(const pin of inputs)verifyPinnedBytes(fs.readFileSync(pin.path),pin);
write('input-manifest.json',{version:1,inputs:[...new Map(inputs.map(p=>[p.path,p])).values()]});
process.stdout.write(JSON.stringify({taskId:'15-17',status:handoff.status,selectedPolicy:handoff.selectedPolicy,cases:handoff.witnesses.length,
  verification:'controller Vitest not run',output:out})+'\n');
