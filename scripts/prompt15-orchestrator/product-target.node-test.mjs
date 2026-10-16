import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {captureProductTarget,validateProductTarget,attestProductTarget,failureAttemptKey,productSnapshot} from './product-target.mjs';
import {prepareManualBaselineReceipt,validateManualBaseline,assertLaunchAllowed} from './launch-policy.mjs';
import {fileIdentity,inside,PROMPT14_GATES} from './protocol.mjs';
import {recordReviewResult,classifyFailure} from './policy.mjs';
import {CompactVerificationStages} from './verification-stages-compact.mjs';
import {identity} from './verification-stages.mjs';

function fixture(t){
  const base=path.resolve('.tmp/product-target-tests');fs.mkdirSync(base,{recursive:true});
  const root=fs.mkdtempSync(path.join(base,'case-'));
  const candidate=path.join(root,'reports/candidate');fs.mkdirSync(path.join(candidate,'src'),{recursive:true});
  fs.writeFileSync(path.join(candidate,'package.json'),'{}');fs.writeFileSync(path.join(candidate,'src/value.ts'),'export const value = 1;');
  fs.writeFileSync(path.join(candidate,'tsconfig.json'),'{}');
  t.after(()=>{assert.ok(inside(base,root)&&root!==base);fs.rmSync(root,{recursive:true,force:true});});
  return {root,candidate,capture:(name='target',options)=>captureProductTarget(root,candidate,path.join(root,'reports',name),options)};
}
function manualVerdict(root,candidate,verdict='pass'){
  const directory=path.join(root,'reports/manual');fs.mkdirSync(directory,{recursive:true});
  const evidence=path.join(directory,'execution.json');fs.writeFileSync(evidence,JSON.stringify({exitCode:0,fixture:'control protocol only'}));
  const pin=fileIdentity(root,evidence);
  const value={review:'prompt14',verdict,nonPassKind:verdict==='pass'?'none':'implementation',summary:'Manual fixture',
    checks:PROMPT14_GATES.map(id=>({id,status:verdict,evidencePaths:[pin.path],detail:'Control fixture'})),
    inputs:Object.keys(productSnapshot(candidate)).map(relative=>fileIdentity(root,path.join(candidate,relative))),evidence:[pin],
    commands:[{command:'control fixture check',exitCode:verdict==='pass'?0:1,evidencePath:pin.path}],failures:verdict==='pass'?[]:['fixture defect'],suggestedRepairPrompt:'Repair the fixture'};
  const file=path.join(directory,'result.json');fs.writeFileSync(file,JSON.stringify(value));return {file,value,pin};
}

test('an explicit target keeps product cwd separate from control storage and attests the actual manifest',t=>{
  const f=fixture(t),target=f.capture();validateProductTarget(f.root,target);
  assert.equal(target.productRoot,f.candidate);
  const verification={candidateRoot:f.candidate,targetId:target.targetId,inputs:[target.manifest]};
  attestProductTarget(f.root,target,verification);assert.equal(verification.candidateRevision,target.revision);
  assert.throws(()=>attestProductTarget(f.root,target,{...verification,candidateRoot:f.root}),/different product target/);
  assert.throws(()=>attestProductTarget(f.root,target,{...verification,inputs:[]}),/manifest/);
});
test('missing bindings, altered manifests and changed/new/deleted product files are rejected',t=>{
  const f=fixture(t),target=f.capture();
  assert.throws(()=>validateProductTarget(f.root,null),/no repository fallback/);
  assert.throws(()=>validateProductTarget(f.root,{...target,productRoot:f.root}),/identity changed/);
  fs.writeFileSync(path.join(f.candidate,'src/new.ts'),'new');assert.throws(()=>validateProductTarget(f.root,target),/source changed/);
  fs.unlinkSync(path.join(f.candidate,'src/new.ts'));fs.unlinkSync(path.join(f.candidate,'src/value.ts'));
  assert.throws(()=>validateProductTarget(f.root,target),/source changed/);
});
test('a target pins the confirmed implementation turn and its original assignment',t=>{
  const f=fixture(t),request=path.join(f.root,'request.txt'),response=path.join(f.root,'response.json');
  fs.writeFileSync(request,'complete A assignment');fs.writeFileSync(response,JSON.stringify({turnId:'confirmed',result:{status:'blocked'}}));
  const options={requestIdentity:fileIdentity(f.root,request),responseIdentity:fileIdentity(f.root,response),turnId:'confirmed'};
  const target=f.capture('target',options);validateProductTarget(f.root,target);
  assert.throws(()=>f.capture('bad',{...options,turnId:null}),/confirmed implementation/);
  fs.writeFileSync(request,'different assignment');assert.throws(()=>validateProductTarget(f.root,target),/bytes changed/);
});
test('additional generation input bytes are bound instead of being inferred from report folder names',t=>{
  const f=fixture(t),data=path.join(f.candidate,'data');fs.mkdirSync(data);fs.writeFileSync(path.join(data,'value.json'),'1');
  const manifest=path.join(f.candidate,'inputs.json');fs.writeFileSync(manifest,JSON.stringify({version:1,inputs:[fileIdentity(f.root,path.join(data,'value.json'))]}));
  const target=f.capture('target',{artifactManifest:manifest});validateProductTarget(f.root,target);
  fs.writeFileSync(path.join(data,'value.json'),'2');assert.throws(()=>validateProductTarget(f.root,target),/bytes changed/);
});
test('same revision and failed gates count once across report folders; changed revision counts again',t=>{
  const f=fixture(t),a=f.capture('a'),b=f.capture('b');assert.equal(a.revision,b.revision);assert.notEqual(a.targetId,b.targetId);
  const state={},report={review:'A',verdict:'fail',nonPassKind:'implementation',candidateRevision:a.revision,checks:[{id:'source',status:'fail'}]};
  report.failureAttemptKey=failureAttemptKey(report);recordReviewResult(state,report,'first');recordReviewResult(state,report,'second');
  assert.equal(state.reviewStrikes.A.totalFailures,1);assert.equal(state.strikeHistory.length,2);
  fs.writeFileSync(path.join(f.candidate,'src/value.ts'),'changed');report.candidateRevision=f.capture('c').revision;report.failureAttemptKey=failureAttemptKey(report);
  recordReviewResult(state,report,'third');assert.equal(state.reviewStrikes.A.totalFailures,2);
  recordReviewResult(state,{...report,nonPassKind:'environment'},'environment');assert.equal(state.reviewStrikes.A.totalFailures,2);
});
test('manual mode blocks start/resume even when a valid receipt exists, and old baseline loops cannot resume',t=>{
  const f=fixture(t);assert.throws(()=>assertLaunchAllowed(f.root,{executionMode:'manual-prompt14',manualBaselineReceipt:'anything'}),/disabled/);
  assert.throws(()=>assertLaunchAllowed(f.root,{}, {baselinePending:true}),/retired/);
  assert.equal(classifyFailure(Error('Target binding: missing target'),{}),'waiting_execution');
  assert.equal(classifyFailure(Error('Manual baseline gate: disabled'),{}),'waiting_execution');
});
test('offline intake requires a complete independently attested candidate and never enables execution',t=>{
  const f=fixture(t),v=manualVerdict(f.root,f.candidate);
  const result=prepareManualBaselineReceipt(f.root,v.file,f.candidate,path.join(f.root,'reports/accepted'));
  assert.equal(validateManualBaseline(f.root,result.path).target.productRoot,f.candidate);
  assert.throws(()=>assertLaunchAllowed(f.root,{boundProductTargets:true,executionMode:'manual-prompt14',manualBaselineReceipt:result.path}),/disabled/);
  assert.equal(assertLaunchAllowed(f.root,{boundProductTargets:true,executionMode:'orchestrated',manualBaselineReceipt:result.path}).verdict,'pass');
  fs.writeFileSync(path.join(f.candidate,'src/value.ts'),'mutated');assert.throws(()=>validateManualBaseline(f.root,result.path),/source changed|bytes changed/);
});
test('FAIL/BLOCKED, missing source coverage, and modified evidence cannot authorize execution',t=>{
  const f=fixture(t),v=manualVerdict(f.root,f.candidate,'fail');
  assert.throws(()=>prepareManualBaselineReceipt(f.root,v.file,f.candidate,path.join(f.root,'reports/failed')),/not PASS/);
  v.value.verdict='pass';v.value.nonPassKind='none';v.value.failures=[];v.value.commands[0].exitCode=0;v.value.checks.forEach(c=>c.status='pass');v.value.inputs.pop();
  fs.writeFileSync(v.file,JSON.stringify(v.value));assert.throws(()=>prepareManualBaselineReceipt(f.root,v.file,f.candidate,path.join(f.root,'reports/missing')),/missing verified product input/);
  assert.equal(fs.existsSync(path.join(f.root,'reports/missing/baseline-receipt.json')),false);
});
test('a shared input manifest is accepted only when attested and its actual bytes still match',t=>{
  const f=fixture(t),v=manualVerdict(f.root,f.candidate),manifest=path.join(f.root,'reports/manual/inputs.json');
  fs.writeFileSync(manifest,JSON.stringify({version:1,inputs:v.value.inputs}));
  const pin=fileIdentity(f.root,manifest);v.value.inputs=[pin];v.value.inputManifests=[pin];fs.writeFileSync(v.file,JSON.stringify(v.value));
  const accepted=prepareManualBaselineReceipt(f.root,v.file,f.candidate,path.join(f.root,'reports/shared-accepted'));
  assert.equal(validateManualBaseline(f.root,accepted.path).verdict,'pass');
  fs.writeFileSync(manifest,'{}');assert.throws(()=>validateManualBaseline(f.root,accepted.path),/bytes changed/);
});
test('copied operating task definitions are not mistaken for product source approval inputs',t=>{
  const f=fixture(t),operating=path.join(f.candidate,'scripts/prompt15-orchestrator');fs.mkdirSync(operating,{recursive:true});
  fs.writeFileSync(path.join(operating,'unused-control.mjs'),'old copied operator');const target=f.capture();
  fs.writeFileSync(path.join(operating,'unused-control.mjs'),'new copied operator');validateProductTarget(f.root,target);
  assert.equal(Object.hasOwn(productSnapshot(f.candidate),'scripts/prompt15-orchestrator/unused-control.mjs'),false);
});
test('bound stage journals automatically pin candidate sources and reject repository product inputs',async t=>{
  const f=fixture(t),target=f.capture(),directory=path.join(f.root,'reports/verify');fs.mkdirSync(directory);
  const helper=path.join(directory,'check.mjs'),output=path.join(directory,'result.json');
  fs.writeFileSync(helper,"import fs from 'node:fs';fs.writeFileSync(process.argv[2],JSON.stringify({pass:true,cwd:process.cwd()}));");
  const context={root:f.root,reportDirectory:'reports/verify',jobId:'bound-fixture',review:'A',requiredGates:['source'],productRoot:f.candidate,productTarget:target};
  const file=path.join(directory,'context.json');fs.writeFileSync(file,JSON.stringify(context));
  const plan={version:2,jobId:context.jobId,role:'verifier',requiredGates:['source'],stages:[{id:'check',phase:'audit',gates:['source'],dependsOn:[],
    command:[process.execPath,helper,output],inputs:await Promise.all([process.execPath,helper].map(identity)),
    results:[{path:'reports/verify/result.json',assertions:[{key:'pass',equals:true},{key:'cwd',equals:f.candidate}]}]}]};
  const journal=new CompactVerificationStages(file);await journal.register(plan);await journal.runRemaining();await journal.validateComplete();assert.equal(journal.record('check').cwd,f.candidate);
  fs.writeFileSync(path.join(f.candidate,'src/value.ts'),'changed');assert.equal(await journal.eligible('check'),false);
  await assert.rejects(journal.validateComplete(),/Incomplete\/stale/);
  fs.writeFileSync(path.join(f.candidate,'src/value.ts'),'export const value = 1;');
  fs.mkdirSync(path.join(f.root,'src'));const wrong=path.join(f.root,'src/value.ts');fs.writeFileSync(wrong,'wrong root');
  plan.stages[0].inputs.push(await identity(wrong));await assert.rejects(journal.register(plan,true),/repository product input/);
});
