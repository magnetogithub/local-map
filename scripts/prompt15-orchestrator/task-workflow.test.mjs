// Canonical Vitest suite; test bodies and assertions retained from the prior control suite.
import fs from 'node:fs';
import path from 'node:path';
import {test as vitestTest} from 'vitest';
const test=(name,body)=>vitestTest(name,context=>body({after:fn=>context.onTestFinished(fn)}),600000);
import assert from 'node:assert/strict';
import {TaskWorkflow} from './task-workflow.mjs';
import {TASK_ASSIGNMENT_SCHEMA,TASK_IMPLEMENTATION_SCHEMA,TASK_ASSESSMENT_SCHEMA,TASK_RELAY_SCHEMA,REVIEW_DECISION_SCHEMA,validateAssignment,readyTasks,disjointAssignments,invalidateDescendants} from './task-protocol.mjs';
import {fileIdentity,PROMPT14_GATES,TASK_GATES,inside} from './protocol.mjs';
import {productSnapshot} from './product-target.mjs';
import {prepareManualBaselineReceipt} from './launch-policy.mjs';
import {CompactVerificationStages} from './verification-stages-compact.mjs';
import {identity} from './verification-stages.mjs';
import {readTaskPlan} from './task-plan.mjs';
import {prepareTaskInputs} from './task-inputs.mjs';

function fixture(t,options={}){
  const base=path.resolve('.tmp/task-workflow-tests');fs.mkdirSync(base,{recursive:true});const root=fs.mkdtempSync(path.join(base,'case-')),candidate=path.join(root,'reports/manual-candidate');
  fs.mkdirSync(path.join(candidate,'src'),{recursive:true});fs.writeFileSync(path.join(candidate,'package.json'),'{}');fs.writeFileSync(path.join(candidate,'src/base.txt'),'immutable');
  const manual=path.join(root,'reports/manual');fs.mkdirSync(manual,{recursive:true});fs.writeFileSync(path.join(manual,'proof.json'),'{}');const proof=fileIdentity(root,path.join(manual,'proof.json'));
  const verdict={review:'prompt14',verdict:'pass',nonPassKind:'none',summary:'Control fixture only',checks:PROMPT14_GATES.map(id=>({id,status:'pass',evidencePaths:[proof.path],detail:'fixture'})),inputs:Object.keys(productSnapshot(candidate)).map(file=>fileIdentity(root,path.join(candidate,file))),evidence:[proof],commands:[{command:'fixture',exitCode:0,evidencePath:proof.path}],failures:[],suggestedRepairPrompt:''};
  fs.writeFileSync(path.join(manual,'verdict.json'),JSON.stringify(verdict));const receipt=prepareManualBaselineReceipt(root,path.join(manual,'verdict.json'),candidate,path.join(root,'reports/accepted'));
  const roles=Object.fromEntries(['supervisor','implementer','verifier'].map(role=>{fs.writeFileSync(path.join(root,role+'.txt'),role);return[role,{promptPath:role+'.txt',model:null,effort:null}];}));
  fs.writeFileSync(path.join(root,'prompt.txt'),'Fixed fixture functional spec');fs.writeFileSync(path.join(root,'rules.txt'),'Fixture rules');
  const config={roles,promptPath:'prompt.txt',rulesPath:'rules.txt',manualBaselineReceipt:receipt.path,executionMode:'orchestrated',implementationUnit:'task',boundProductTargets:true};
  let workflow;const order=[],audits=[],active=new Set();let maxActive=0,implementationCalls=0;
  const server={next:0,turns:[],async initialize(){},async request(method,params){return{thread:{id:params?.threadId??'thread-'+(++this.next)}};},async runTurn(threadId,input,schema,overrides){
    let value;const taskId=workflow.state.currentTasks?.find(id=>input.includes(id))??null,report=overrides.sandboxPolicy.type==='workspaceWrite'?overrides.sandboxPolicy.writableRoots[0]:null;
    this.turns.push({threadId,schema,input,cwd:overrides.cwd});
    if(schema===TASK_ASSIGNMENT_SCHEMA){
      const id=input.match(/Assign exactly (15-\d+)/)[1];const task=workflow.plan.tasks.find(t=>t.id===id);for(const dep of task.dependsOn)assert.equal(workflow.state.tasks[dep].status,'pass',`no premature assignment ${id}`);
      if(options.boundary===id)throw Error('Orchestration guardian hold: test boundary');
      value={taskId:id,review:workflow.state.review,candidateRoot:path.join(workflow.state.tasks[id].attemptDirectory,'candidate'),inputContextPath:path.join(workflow.state.tasks[id].attemptDirectory,'task-input-context.json'),action:'implement',instructions:'Write actual unique task output and preserve base.txt',writablePaths:[`src/${id}.txt`],summary:'fixture scope'};order.push(id);
      if(options.assignmentBlocked)value={...value,action:'blocked',summary:'Operating assignment handoff missing'};
    }else if(schema===TASK_IMPLEMENTATION_SCHEMA){
      if(options.rpcFailure){this.failure=Error('Fixture disconnected RPC');throw this.failure;}
      const id=input.match(/taskId=(15-\d+)/)[1];active.add(id);maxActive=Math.max(maxActive,active.size);await new Promise(resolve=>setTimeout(resolve,5));
      fs.writeFileSync(path.join(overrides.cwd,`src/${id}.txt`),id);fs.writeFileSync(path.join(overrides.cwd,'.reports/inputs.json'),'{"version":1,"inputs":[]}');
      active.delete(id);value={taskId:id,status:'completed',summary:'actual fixture change',changedFiles:[`src/${id}.txt`],artifactPaths:[],commands:[],remainingIssues:[],candidateRoot:overrides.cwd,inputManifestPath:path.join(overrides.cwd,'.reports/inputs.json')};
      if(++implementationCalls<=(options.blockedImplementations??0))value={...value,status:'blocked',summary:'Operating handoff missing',remainingIssues:[options.blockReason??'Explicit current input authority and controller handoff missing']};
    }else if(schema===TASK_RELAY_SCHEMA){const id=input.match(/Relay only task (15-\d+)/)[1];value={taskId:id,review:workflow.state.review,verificationPrompt:'Check exact output bytes and unchanged base.txt'};
    }else if(schema===TASK_ASSESSMENT_SCHEMA){
      const contextFile=path.join(report,'job-context.json'),context=JSON.parse(fs.readFileSync(contextFile)),id=context.taskId??`REVIEW-${context.review}`,row=context.taskId?workflow.state.tasks[id]:null;
      assert.equal(overrides.cwd,context.productRoot);assert.notEqual(overrides.cwd,root);
      const helper=path.join(report,'assert.mjs'),output=path.join(report,'actual.json');
      fs.writeFileSync(helper,`import fs from 'node:fs';import assert from 'node:assert/strict';assert.equal(fs.readFileSync(${JSON.stringify(path.join(overrides.cwd,'src/base.txt'))},'utf8'),'immutable');${row?`assert.equal(fs.readFileSync(${JSON.stringify(path.join(overrides.cwd,`src/${id}.txt`))},'utf8'),${JSON.stringify(id)});`:''}fs.writeFileSync(${JSON.stringify(output)},JSON.stringify({passed:true}));`);
      const journal=new CompactVerificationStages(contextFile);await journal.register({version:2,jobId:context.jobId,role:'verifier',requiredGates:context.requiredGates,stages:[{id:'actual',phase:'normal',gates:context.requiredGates,dependsOn:[],command:[process.execPath,helper],inputs:await Promise.all([process.execPath,helper].map(identity)),results:[{path:output,assertions:[{key:'passed',equals:true}]}]}]});await journal.runRemaining();
      const pins=[fileIdentity(root,output),fileIdentity(root,journal.summaryFile),fileIdentity(root,journal.recordFile('actual'))];
      value={review:context.review,taskId:id,candidateRoot:options.wrongRoot?root:context.productRoot,targetId:context.productTarget.targetId,verdict:options.environment&&row?'blocked':'pass',nonPassKind:options.environment&&row?'environment':'none',summary:'Actual fixture assertion executed',checks:context.requiredGates.map(gate=>({id:gate,status:options.environment&&row?'blocked':'pass',evidencePaths:[pins[0].path],detail:'Independent bytes'})),inputs:[context.productTarget.manifest,...(row?[row.implementation.requestIdentity]:[])],evidence:pins,commands:[{command:'actual assertion helper',exitCode:0,evidencePath:pins[2].path}],failures:options.environment&&row?['fixture missing external input']:[],suggestedRepairPrompt:''};
    }else if(schema===REVIEW_DECISION_SCHEMA)value={review:workflow.state.review,action:'advance',repairTaskIds:[],summary:'All scoped actual assertions pass',instructions:''};
    else throw Error('Unexpected schema '+taskId);
    return{value,text:JSON.stringify(value),turnId:'turn-'+this.turns.length};
  }};
  const directory=path.join(root,'reports/run');fs.mkdirSync(directory,{recursive:true});
  const reset=(resume=false)=>{workflow=new TaskWorkflow({root,directory,config,server,resume,vitestAttestor:async()=>null});workflow.guardian={async inspect(snapshot){audits.push(JSON.parse(JSON.stringify(snapshot)));return options.audit?options.audit(snapshot,workflow):{decision:'continue',summary:'Fixture operating audit',ruleChanges:[]};}};return workflow;};reset();
  t.after(()=>{assert.ok(inside(base,root)&&base!==root);fs.rmSync(root,{recursive:true,force:true});});
  return{root,candidate,config,directory,server,order,audits,get workflow(){return workflow;},get maxActive(){return maxActive;},resume:()=>reset(true)};
}

test('all 48 independent tasks release only verified dependencies and all six reviews gate the next work',async t=>{
  const f=fixture(t),result=await f.workflow.run();assert.equal(result.status,'standby',result.error);assert.deepEqual(Object.keys(result.certificates),['A','B','C','D','E','F']);assert.equal(f.order.length,48);assert.equal(new Set(f.order).size,48);assert.equal(Object.values(result.tasks).filter(row=>row.status==='pass').length,48);assert.equal(f.maxActive,4);assert.equal(fs.readFileSync(path.join(f.candidate,'src/base.txt'),'utf8'),'immutable');
  const verifiers=f.server.turns.filter(turn=>turn.schema===TASK_ASSESSMENT_SCHEMA);assert.equal(verifiers.length,54);for(const turn of verifiers.filter(turn=>turn.input.startsWith('Independently verify only task')))assert.ok(TASK_GATES.every(gate=>turn.input.includes(gate)));
  assert.equal(new Set(verifiers.filter(turn=>turn.input.startsWith('Independently verify whole REVIEW')).map(turn=>turn.threadId)).size,6,'each REVIEW owns its verification session until acceptance');
  const count=f.server.turns.length;await f.resume().run();assert.equal(f.server.turns.length,count,'standby never dispatches deployment or extra checks');
});
test('environmental verification holds task and descendants without repair/retry',async t=>{
  const f=fixture(t,{environment:true});await assert.rejects(f.workflow.run(),/blocked/);assert.equal(f.workflow.state.tasks['15-01'].status,'blocked');assert.equal(f.workflow.state.tasks['15-02'].status,'pending');assert.equal(f.workflow.state.repairAttempts,0);const count=f.server.turns.filter(turn=>turn.schema===TASK_ASSESSMENT_SCHEMA).length;await assert.rejects(f.resume().run(),/blocked/);assert.equal(f.server.turns.filter(turn=>turn.schema===TASK_ASSESSMENT_SCHEMA).length,count);
});
test('wrong-root verifier cannot release task 2',async t=>{const f=fixture(t,{wrongRoot:true});await assert.rejects(f.workflow.run(),/different product target/);assert.equal(f.workflow.state.tasks['15-02'].status,'pending');assert.equal(Object.keys(f.workflow.state.certificates).length,0);});
test('a confirmed implementation is replayed once, changed candidate cannot be adopted',async t=>{
  const f=fixture(t,{boundary:'15-02'});await assert.rejects(f.workflow.run(),/test boundary/);const row=f.workflow.state.tasks['15-01'],turn=f.server.turns.find(turn=>turn.schema===TASK_IMPLEMENTATION_SCHEMA);const request=JSON.parse(fs.readFileSync(path.join(row.attemptDirectory,'implementation/request.json')));const count=f.server.turns.length;
  await f.workflow.turn('implementer',row.implementationKey,turn.cwd,path.join(row.attemptDirectory,'implementation'),request.prompt,TASK_IMPLEMENTATION_SCHEMA,{taskId:'15-01',review:'A'});assert.equal(f.server.turns.length,count);
  fs.writeFileSync(path.join(turn.cwd,'src/15-01.txt'),'uncertain change');await assert.rejects(f.workflow.turn('implementer',row.implementationKey,turn.cwd,path.join(row.attemptDirectory,'implementation'),request.prompt,TASK_IMPLEMENTATION_SCHEMA,{taskId:'15-01',review:'A'}),/candidate changed/);
});
test('ownership overlap, control mutation and descendant invalidation are enforced',()=>{
  const plan=readTaskPlan(),task=plan.tasks[0];assert.throws(()=>validateAssignment(task,'A',{taskId:task.id,review:'A',action:'implement',instructions:'x',writablePaths:['automation/prompt15/config.json']}),/protected/);assert.throws(()=>validateAssignment(task,'A',{taskId:task.id,review:'A',action:'implement',instructions:'x',writablePaths:['src']}),/broad/);
  assert.equal(disjointAssignments({writablePaths:['src/a']},{writablePaths:['src/a/b']}),false);
  const state={certificates:{},tasks:Object.fromEntries(plan.tasks.map(t=>[t.id,{status:'pending'}]))};assert.deepEqual(readyTasks(plan,state,'A').map(t=>t.id),['15-01']);state.tasks['15-01'].status='pass';assert.equal(readyTasks(plan,state,'A').length,4);assert.equal(readyTasks(plan,state,'B').length,0);
  for(const row of Object.values(state.tasks))row.status='pass';const invalid=invalidateDescendants(plan,state,['15-31']);assert.ok(invalid.includes('15-35')&&invalid.includes('15-48'));assert.equal(state.tasks['15-30'].status,'pass');
});

function repairedAudit(snapshot,workflow){
  if(snapshot.phase!=='task_blocked')return{decision:'continue',summary:'Fixture audit',ruleChanges:[]};
  fs.appendFileSync(path.join(workflow.root,'rules.txt'),'\nExplicit controller-owned handoff repair');
  return{decision:'reload',summary:'Actual operating repair',ruleChanges:['rules.txt'],recovery:{action:'reassign_task',taskId:snapshot.taskId,evidencePaths:[snapshot.blockedTask.confirmedResponseIdentity.path,...snapshot.blockedTask.repairEvidenceIdentities.map(pin=>pin.path),'rules.txt'],reason:'Missing authority and handoff supplied'}};
}

test('blocked implementation reaches guardian with confirmed evidence and cannot silently retry',async t=>{
  const f=fixture(t,{blockedImplementations:1});await assert.rejects(f.workflow.run(),/blocked/);
  const blocked=f.audits.find(a=>a.phase==='task_blocked');assert.ok(blocked);const row=f.workflow.state.tasks['15-01'];
  assert.equal(row.implementation.result.status,'blocked');assert.equal(blocked.blockedTask.confirmedResponseIdentity.sha256,row.implementation.responseIdentity.sha256);
  assert.ok(blocked.blockedTask.repairEvidenceIdentities.some(pin=>pin.path.endsWith('repair-input-context.json')));
  assert.equal(f.server.turns.filter(turn=>turn.schema===TASK_IMPLEMENTATION_SCHEMA).length,1);assert.equal(f.workflow.state.tasks['15-02'].status,'pending');assert.equal(f.workflow.state.repairAttempts,0);
});

test('a proven operating repair retains blocked attempt and independently verifies same task before dependents',async t=>{
  const f=fixture(t,{blockedImplementations:1,boundary:'15-02',audit:repairedAudit});await assert.rejects(f.workflow.run(),/test boundary/);
  const row=f.workflow.state.tasks['15-01'];assert.equal(row.status,'pass');assert.equal(row.attempt,2);assert.equal(row.operationalRecoveryAttempts,1);assert.equal(row.retainedAttempts.length,1);assert.equal(f.workflow.state.repairAttempts,0);
  const original=JSON.parse(fs.readFileSync(path.resolve(f.root,row.retainedAttempts[0].response.path)));assert.equal(original.result.status,'blocked');
  assert.equal(f.server.turns.filter(turn=>turn.schema===TASK_IMPLEMENTATION_SCHEMA).length,2);assert.equal(f.server.turns.filter(turn=>turn.schema===TASK_ASSESSMENT_SCHEMA).length,1);assert.deepEqual(f.order,['15-01','15-01']);
});

test('rule-free recovery and external permission blockers cannot release a task',async t=>{
  for(const external of [false,true]){
    const f=fixture(t,{blockedImplementations:1,blockReason:external?'Approval rejected: permission denied':undefined,audit:external?repairedAudit:(snapshot)=>snapshot.phase==='task_blocked'?{decision:'reload',summary:'No actual patch',ruleChanges:['rules.txt'],recovery:{action:'reassign_task',taskId:'15-01',reason:'Claim only'}}:{decision:'continue',summary:'Fixture audit',ruleChanges:[]}});
    await assert.rejects(f.workflow.run(),/blocked/);assert.equal(f.workflow.state.tasks['15-01'].attempt,1);assert.equal(f.workflow.state.tasks['15-02'].status,'pending');assert.equal(f.workflow.state.repairAttempts,0);
    if(external)assert.equal(f.audits.find(a=>a.phase==='task_blocked').blockedTask.blockerKind,'external_permission');
  }
});

test('old blocked response is restored only with unchanged candidate bytes',async t=>{
  for(const changed of [false,true]){
    const f=fixture(t,{blockedImplementations:1});await assert.rejects(f.workflow.run(),/blocked/);const row=f.workflow.state.tasks['15-01'];delete row.implementation;f.workflow.save();
    if(changed)fs.writeFileSync(path.join(row.workspace.directory,'src/15-01.txt'),'changed after turn');const count=f.server.turns.length;
    await assert.rejects(f.resume().run(),changed?/cannot be recovered/:/blocked/);assert.equal(f.server.turns.length,count);
    if(!changed)assert.equal(f.workflow.state.tasks['15-01'].implementation.result.status,'blocked');
  }
});

test('blocked assignment and environmental verifier report are both routed to the operating guardian',async t=>{
  for(const options of [{assignmentBlocked:true},{environment:true}]){
    const f=fixture(t,options);await assert.rejects(f.workflow.run(),/blocked/);const snapshot=f.audits.find(a=>a.phase==='task_blocked');assert.ok(snapshot?.blockedTask.confirmedResponseIdentity);
    const response=JSON.parse(fs.readFileSync(path.resolve(f.root,snapshot.blockedTask.confirmedResponseIdentity.path))).result;assert.ok(response.action==='blocked'||response.verdict==='blocked');assert.equal(f.workflow.state.repairAttempts,0);
  }
});

test('disconnected execution is queued for guardian before any dispatch after reconnect and uncertain turn is never replayed',async t=>{
  const f=fixture(t,{rpcFailure:true});await assert.rejects(f.workflow.run(),/disconnected RPC/);assert.ok(f.workflow.state.pendingExecutionIncident);assert.ok(!f.audits.some(a=>a.phase==='execution_failure'));const count=f.server.turns.length,audits=f.audits.length;
  delete f.server.failure;await assert.rejects(f.resume().run(),/no certified response/);assert.equal(f.audits[audits].phase,'execution_failure');assert.equal(f.audits[audits].executionFailure.reconnected,true);assert.equal(f.server.turns.length,count);assert.equal(f.workflow.state.tasks['15-02'].status,'pending');
});

test('task input context binds exact candidate, approved source delta and nested dependencies with immutable evidence',async t=>{
  const f=fixture(t,{boundary:'15-01'}),dependency=path.join(f.root,'shared/next');fs.mkdirSync(dependency,{recursive:true});fs.writeFileSync(path.join(dependency,'package.json'),'{"name":"next"}');
  fs.mkdirSync(path.join(f.candidate,'node_modules'),{recursive:true});fs.symlinkSync(dependency,path.join(f.candidate,'node_modules/next'),'junction');
  fs.mkdirSync(path.join(f.root,'prompts'));fs.writeFileSync(path.join(f.root,'prompts/PROMPT_14_MICRO_TERRITORY_OCCUPATION_AND_COUNTRY_COLORS.txt'),'original requirement');
  await assert.rejects(f.workflow.run(),/test boundary/);const row=f.workflow.state.tasks['15-01'],context=JSON.parse(fs.readFileSync(path.resolve(f.root,row.inputContext.path)));
  assert.equal(context.candidateRoot,path.join(row.attemptDirectory,'candidate'));assert.equal(context.readOnlySourceRoot,f.workflow.state.reviewWorkspace.directory);assert.notEqual(context.candidateRoot,context.readOnlySourceRoot);assert.equal(context.dirtyInventory.complete,true);assert.deepEqual(context.dirtyInventory.changes,[]);
  assert.equal(context.dependencies[0].resolvedPath,fs.realpathSync(path.join(dependency,'package.json')));assert.equal(context.referenceDocuments.length,1);assert.equal(context.historicalEvidence[0].sha256,f.workflow.state.baselineCertificate.verification.sha256);
  fs.writeFileSync(path.join(context.readOnlySourceRoot,'src/new.txt'),'unmerged change');const output=path.join(f.directory,'delta.json'),args={state:f.workflow.state,taskId:'15-01',candidateRoot:context.candidateRoot,outputFile:output};
  const delta=prepareTaskInputs(f.root,args).value;assert.deepEqual(delta.dirtyInventory.changes.map(change=>change.path),['src/new.txt']);fs.writeFileSync(path.join(context.readOnlySourceRoot,'src/new.txt'),'changed again');assert.throws(()=>prepareTaskInputs(f.root,args),/input context changed/);
});

test('guardian controller repair is invoked automatically and reload preserves completed implementation instead of assigning again',async t=>{
  let first=true;const f=fixture(t,{boundary:'15-02',audit:async(snapshot,w)=>{
    if(snapshot.phase==='implementation_handoff'&&first){first=false;const file=path.join(w.directory,'guardian-controller-incident.json');fs.writeFileSync(file,JSON.stringify({result:{decision:'hold',recovery:{action:'repair_controller'}}}));w.state.guardian.lastAuditIdentity=fileIdentity(w.root,file);return{decision:'hold',summary:'Controller defect',ruleChanges:[],recovery:{action:'repair_controller'}};}
    return{decision:'continue',summary:'Fixture audit',ruleChanges:[]};
  }});
  let repairs=0;f.workflow.controllerRepair={async repair({phase,targets,auditIdentity}){repairs++;assert.equal(phase,'implementation_handoff');assert.ok(targets.length);assert.ok(auditIdentity);return{status:'applied'};}};
  await assert.rejects(f.workflow.run(),error=>error.code==='OPERATING_REPAIR_APPLIED');assert.equal(repairs,1);assert.equal(f.workflow.state.status,'reloading_orchestration');assert.equal(f.workflow.state.tasks['15-01'].status,'implemented');assert.equal(f.workflow.state.tasks['15-01'].attempt,1);assert.equal(f.server.turns.filter(turn=>turn.schema===TASK_ASSESSMENT_SCHEMA).length,0);
  f.workflow.state.guardian.lastControllerRepair={sourceAudit:f.workflow.state.guardian.lastAuditIdentity};f.workflow.save();
  await assert.rejects(f.resume().run(),/test boundary/);assert.equal(f.workflow.state.tasks['15-01'].status,'pass');assert.equal(f.workflow.state.tasks['15-01'].attempt,1);assert.equal(f.server.turns.filter(turn=>turn.schema===TASK_IMPLEMENTATION_SCHEMA).length,1);assert.equal(f.workflow.state.repairAttempts,0);
});
