import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import {Workflow} from './workflow.mjs';
import {GATES,TASK_GATES,PROMPT14_GATES,BOUND_IMPLEMENTATION_SCHEMA,BOUND_VERIFICATION_SCHEMA,BOUND_TASK_VERIFICATION_SCHEMA,SUPERVISION_SCHEMA,TASK_RELAY_SCHEMA,fileIdentity,inside} from './protocol.mjs';
import {prepareManualBaselineReceipt} from './launch-policy.mjs';
import {productSnapshot,captureProductTarget} from './product-target.mjs';

function fixture(t,options={}){
  const base=path.resolve('.tmp/bound-workflow-tests');fs.mkdirSync(base,{recursive:true});
  const root=fs.mkdtempSync(path.join(base,'case-')),candidate=path.join(root,'reports/manual-candidate');
  fs.mkdirSync(path.join(candidate,'src'),{recursive:true});fs.writeFileSync(path.join(candidate,'src/value.ts'),'valid');fs.writeFileSync(path.join(candidate,'package.json'),'{}');
  const manual=path.join(root,'reports/manual');fs.mkdirSync(manual,{recursive:true});const proof=path.join(manual,'proof.json');fs.writeFileSync(proof,'{"fixture":"control flow only"}');
  const evidence=fileIdentity(root,proof),verdict=path.join(manual,'result.json');
  fs.writeFileSync(verdict,JSON.stringify({review:'prompt14',verdict:'pass',nonPassKind:'none',summary:'Control fixture',
    checks:PROMPT14_GATES.map(id=>({id,status:'pass',evidencePaths:[evidence.path],detail:'Control fixture'})),
    inputs:Object.keys(productSnapshot(candidate)).map(file=>fileIdentity(root,path.join(candidate,file))),evidence:[evidence],commands:[{command:'control fixture',exitCode:0,evidencePath:evidence.path}],failures:[],suggestedRepairPrompt:''}));
  const accepted=prepareManualBaselineReceipt(root,verdict,candidate,path.join(root,'reports/baseline'));
  fs.writeFileSync(path.join(root,'prompt.txt'),'Fixed functional specification');fs.writeFileSync(path.join(root,'rules.txt'),'Control fixture rules');
  const roles=Object.fromEntries(['supervisor','implementer','verifier'].map(role=>{fs.writeFileSync(path.join(root,role+'.txt'),role);return [role,{model:null,effort:null,promptPath:role+'.txt'}];}));
  const config={roles,promptPath:'prompt.txt',rulesPath:'rules.txt',executionMode:'orchestrated',boundProductTargets:true,manualBaselineReceipt:accepted.path,implementationUnit:'review',startReview:'A'};
  const server={runs:[],implementations:0,verifications:0,next:0,async initialize(){},async request(method,params){return {thread:{id:params?.threadId??'thread-'+(++this.next)}};},async runTurn(threadId,input,schema,overrides){
    this.runs.push({schema,input,cwd:overrides.cwd});let value;
    if(schema===BOUND_IMPLEMENTATION_SCHEMA){
      this.implementations++;const broken=(options.failFirst||options.unchanged)&&this.implementations===1||options.unchanged;
      const changed=overrides.cwd.endsWith('15-5')?'src/lookup.ts':overrides.cwd.endsWith('15-6')?'src/migration.ts':'src/value.ts';
      fs.writeFileSync(path.join(overrides.cwd,changed),broken?'broken':'valid-'+this.implementations);
      value={status:options.blockedFirst&&this.implementations===1?'blocked':'completed',summary:'Control implementation',changedFiles:[changed],artifactPaths:[],commands:[],remainingIssues:[],candidateRoot:overrides.cwd,inputManifestPath:''};
    }else if(schema===TASK_RELAY_SCHEMA){value={review:workflow.state.review,taskId:input.match(/taskId: (.*)/)[1],verificationPrompt:'Independently inspect the actual candidate and entire assigned scope'};
    }else if(schema===BOUND_VERIFICATION_SCHEMA||schema===BOUND_TASK_VERIFICATION_SCHEMA){
      this.verifications++;const task=schema===BOUND_TASK_VERIFICATION_SCHEMA;
      if(options.unrelatedRootWrite){fs.mkdirSync(path.join(root,'src'),{recursive:true});fs.writeFileSync(path.join(root,'src/unrelated.ts'),'not the inspected product');}
      if(options.controlPolicyWrite){const directory=path.join(root,'scripts/prompt15-orchestrator');fs.mkdirSync(directory,{recursive:true});fs.writeFileSync(path.join(directory,'policy-change.mjs'),'changed while verifier ran');}
      const actualRoot=input.match(task?/구현 작업 경로: ([^\n]+)/:/프로젝트: ([^\n]+)/)[1];
      const target=task?Object.values(workflow.state.branchWorkspaces).find(workspace=>workspace.directory===actualRoot).target:workflow.state.currentProductTarget;
      assert.equal(actualRoot,target.productRoot);assert.notEqual(actualRoot,root);
      const pass=fs.readFileSync(path.join(actualRoot,'src/value.ts'),'utf8').startsWith('valid');
      const file=path.join(overrides.cwd,'proof.json');fs.writeFileSync(file,JSON.stringify({actualRoot,pass}));const pin=fileIdentity(root,file);
      value={review:workflow.state.review,verdict:pass?'pass':'fail',nonPassKind:pass?'none':'implementation',summary:'Actual fixture bytes checked',
        checks:(task?TASK_GATES:[...GATES[workflow.state.review],...TASK_GATES]).map(id=>({id,status:pass?'pass':'fail',evidencePaths:[pin.path],detail:'Actual candidate fixture'})),
        evidence:[pin],inputs:[target.manifest,target.requestIdentity],commands:[{command:'read actual candidate fixture',exitCode:pass?0:1,evidencePath:pin.path}],failures:pass?[]:['broken fixture'],suggestedRepairPrompt:'Repair all assigned gates',
        targetId:target.targetId,candidateRoot:options.wrongRoot?root:actualRoot,...(task?{taskId:input.match(/taskId: (.*)/)[1],readyForReview:false}:{})};
    }else if(schema===SUPERVISION_SCHEMA){
      const review=workflow.state.review,passed=review==='B'?workflow.state.latestPrerequisiteVerification:workflow.state.latestVerification;
      const result=passed?JSON.parse(fs.readFileSync(path.join(root,passed),'utf8')):null;
      const boundary=review==='B'&&!options.fullRun,integration=input.includes('병렬 구현 결과를 함께');
      value={review,repairReview:review,action:boundary?'blocked':integration?'repair':result?.verdict==='pass'?review==='F'?'wait':'advance':'repair',summary:'Control supervisor',repairPrompt:'Implement the entire next assigned review',
        repairCoverage:GATES[!integration&&result?.verdict==='pass'&&['A','B'].includes(review)?review==='A'?'B':'C':review],
        branchPlans:review==='C'&&result?.verdict==='pass'?[{checkpoint:'15-5',instructions:'lookup branch',writablePaths:['src/lookup.ts']},{checkpoint:'15-6',instructions:'migration branch',writablePaths:['src/migration.ts']}]:[],
        blockerKind:boundary?'user_decision':'none',blockerEvidence:boundary?'Control test boundary after B verification':''};
    }else throw Error('Unexpected control schema');
    return {turnId:'turn-'+this.runs.length,value,text:JSON.stringify(value)};
  }};
  const directory=path.join(root,'reports/run');let workflow=new Workflow({root,directory,config,server});
  t.after(()=>{assert.ok(inside(base,root)&&root!==base);fs.rmSync(root,{recursive:true,force:true});});
  return {root,candidate,directory,config,server,get workflow(){return workflow;},resume(){workflow=new Workflow({root,directory,config,server,resume:true});return workflow;}};
}

test('completed and blocked implementations both reach the verifier with the exact candidate and original request',async t=>{
  const f=fixture(t,{blockedFirst:true});const result=await f.workflow.run();
  assert.equal(result.status,'waiting_input',result.error);assert.ok(result.certificates.A);assert.equal(f.server.verifications,2);
  assert.equal(fs.readFileSync(path.join(f.candidate,'src/value.ts'),'utf8'),'valid','manual approved baseline remains immutable');
  assert.notEqual(result.certificates.A.productTarget.productRoot,result.currentProductTarget.productRoot,'B works in a fresh copy of approved A');
  const verifier=f.server.runs.find(run=>run.schema===BOUND_VERIFICATION_SCHEMA);
  assert.match(verifier.input,/고정 제품 targetId=/);assert.match(verifier.input,/원본 구현 프롬프트/);
});
test('an actual broken fixture is repaired and a new revision is verified without inspecting the control root',async t=>{
  const f=fixture(t,{failFirst:true});const result=await f.workflow.run();
  assert.equal(result.status,'waiting_input',result.error);assert.equal(result.reviewStrikes.A.totalFailures,1);assert.equal(result.repairAttempts,1);assert.equal(f.server.verifications,3);
});
test('returning the same failed bytes stops before another verifier/model call',async t=>{
  const f=fixture(t,{unchanged:true});const result=await f.workflow.run();
  assert.equal(result.status,'waiting_execution',result.error);assert.match(result.error,/Candidate unchanged/);assert.equal(f.server.verifications,1);assert.equal(result.reviewStrikes.A.totalFailures,1);
});
test('a verdict for the repository root cannot approve a separately bound candidate',async t=>{
  const f=fixture(t,{wrongRoot:true});const result=await f.workflow.run();
  assert.equal(result.status,'waiting_execution',result.error);assert.match(result.error,/different product target/);assert.equal(result.certificates.A,undefined);
});
test('a crash after confirmed implementation response forwards that saved report without implementing A again',async t=>{
  const f=fixture(t),original=f.workflow.bindImplementationResult.bind(f.workflow);let first=true;
  f.workflow.bindImplementationResult=(...args)=>{if(first){first=false;throw Error('Transport interrupted after completed response');}return original(...args);};
  const interrupted=await f.workflow.run();assert.equal(interrupted.status,'recovering',interrupted.error);assert.ok(interrupted.pendingImplementation);
  const result=await f.resume().run();assert.equal(result.status,'waiting_input',result.error);assert.equal(f.server.implementations,2,'one A and one B implementation');
});
test('a crash after confirmed verifier response revalidates the saved verdict without rerunning the verifier',async t=>{
  const f=fixture(t),record=f.workflow.record.bind(f.workflow);let first=true;
  f.workflow.record=(name,value)=>{if(name==='verification'&&first){first=false;throw Error('Transport interrupted before publishing verdict');}return record(name,value);};
  const interrupted=await f.workflow.run();assert.equal(interrupted.status,'recovering',interrupted.error);assert.ok(interrupted.completedVerificationTurn);
  const result=await f.resume().run();assert.equal(result.status,'waiting_input',result.error);assert.equal(f.server.verifications,2,'one A and one B verifier turn');
});
test('A through F preserve candidate targets across parallel D branches and stop before cutover',async t=>{
  const f=fixture(t,{fullRun:true});const result=await f.workflow.run();
  assert.equal(result.status,'standby',result.error);assert.equal(result.productionCutover,'not-executed-by-user-instruction');
  assert.deepEqual(Object.keys(result.certificates),['A','C','D','E','F']);assert.ok(result.prerequisiteCertificates.B);
  const d=result.certificates.D.productTarget.productRoot;
  assert.ok(fs.existsSync(path.join(d,'src/lookup.ts')));assert.ok(fs.existsSync(path.join(d,'src/migration.ts')));
  assert.equal(fs.existsSync(path.join(f.candidate,'src/lookup.ts')),false,'the manually approved baseline was not merged into');
  assert.equal(f.server.runs.filter(run=>run.schema===BOUND_TASK_VERIFICATION_SCHEMA).length,2);
});
test('rewinding to A forks its approved source and discards descendant workspace pointers without deleting history',async t=>{
  const f=fixture(t,{fullRun:true});const result=await f.workflow.run();assert.equal(result.status,'standby',result.error);
  const oldA=result.certificates.A.productTarget.productRoot,oldB=result.prerequisiteCertificates.B.productTarget.productRoot;
  const before=fs.readFileSync(path.join(oldA,'src/value.ts'),'utf8');
  f.workflow.invalidateFrom('A');f.workflow.state.review='A';
  const next=f.workflow.ensureProductWorkspace();assert.notEqual(next.directory,oldA);assert.equal(f.workflow.state.productWorkspaces.B,undefined);
  fs.writeFileSync(path.join(next.directory,'src/value.ts'),'repaired A');assert.equal(fs.readFileSync(path.join(oldA,'src/value.ts'),'utf8'),before);
  f.workflow.state.approvedProductTarget=captureProductTarget(f.root,next.directory,path.join(f.root,'reports/rewind-test-target'));
  f.workflow.state.review='B';const b=f.workflow.ensureProductWorkspace();
  assert.notEqual(b.directory,oldB);assert.equal(fs.readFileSync(path.join(b.directory,'src/value.ts'),'utf8'),'repaired A');assert.ok(fs.existsSync(oldB));
});
test('unrelated repository product edits do not replace or invalidate a separate inspected candidate',async t=>{
  const f=fixture(t,{unrelatedRootWrite:true});const result=await f.workflow.run();
  assert.equal(result.status,'waiting_input',result.error);assert.ok(result.certificates.A);
});
test('an unfinished next review cannot be verified using a previous review or manual baseline target',async t=>{
  const f=fixture(t);await f.workflow.initialize();
  await assert.rejects(f.workflow.verify({review:'B'}),/no confirmed implementation target/);
  assert.equal(f.server.verifications,0);
});
test('changes to actual controller policy during verification withhold approval even when the product is unchanged',async t=>{
  const f=fixture(t,{controlPolicyWrite:true});const result=await f.workflow.run();
  assert.equal(result.status,'waiting_execution',result.error);assert.match(result.error,/Source changed/);assert.equal(result.certificates.A,undefined);
});

test('legacy review dispatches preserve flat target-task IDs and D ownership without claiming task scheduling',async t=>{
  const f=fixture(t,{fullRun:true}),result=await f.workflow.run();assert.equal(result.status,'standby',result.error);
  const implementations=f.server.runs.filter(run=>run.schema===BOUND_IMPLEMENTATION_SCHEMA);
  assert.match(implementations[0].input,/15-01 /);assert.match(implementations[0].input,/15-10 /);assert.doesNotMatch(implementations[0].input,/\n\n15-11 /);
  assert.match(implementations.find(run=>run.input.includes('15-11 ')).input,/15-17 /);
  const lookup=implementations.find(run=>run.cwd.endsWith('15-5')),migration=implementations.find(run=>run.cwd.endsWith('15-6'));
  assert.match(lookup.input,/15-30 /);assert.doesNotMatch(lookup.input,/\n\n15-31 /);
  assert.match(migration.input,/15-35 /);assert.doesNotMatch(migration.input,/\n\n15-25 /);
  assert.equal(f.server.runs.filter(run=>run.schema===BOUND_VERIFICATION_SCHEMA).length,6,'one independent whole review per A-F');
  assert.equal(f.server.runs.filter(run=>run.schema===BOUND_TASK_VERIFICATION_SCHEMA).length,2,'existing D branch checks only');
});
