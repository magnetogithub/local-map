import fs from 'node:fs';import path from 'node:path';import {test,expect} from 'vitest';
import {TaskWorkflow} from './task-workflow.mjs';import {readTaskPlan} from './task-plan.mjs';
import {taskContract,deterministicAssignment} from './task-contracts.mjs';
import {atomicJSON,fileIdentity,GATES} from './protocol.mjs';
import {captureProductTarget,productSnapshot,digest,validateProductTarget} from './product-target.mjs';
import {workspaceSnapshot} from './workspaces.mjs';
import {freezeAcceptanceSuite,verifyControllerTask,frozenAcceptanceSuite,selectedHarnessRevisionFile} from './controller-task-verification.mjs';
import {attestVitest} from './vitest-acceptance.mjs';import {runTargetChecks} from './run-target-checks.mjs';
import {applyHarnessFailureResolution,harnessRecoveryInstructions} from './harness-recovery.mjs';

function fixture(t){
  const base=path.resolve('.tmp/task17-handoff-tests');fs.mkdirSync(base,{recursive:true});const root=fs.mkdtempSync(path.join(base,'case-'));
  t.onTestFinished(()=>{expect(root.startsWith(base+path.sep)).toBe(true);fs.rmSync(root,{recursive:true,force:true});});
  const directory=path.join(root,'reports/run'),plan=readTaskPlan(),task=plan.tasks.find(t=>t.id==='15-17'),taskDirectory=path.join(directory,'tasks/15-17'),candidate=path.join(taskDirectory,'attempt-002/candidate');fs.mkdirSync(path.join(candidate,'src'),{recursive:true});atomicJSON(path.join(candidate,'package.json'),{type:'module'});
  fs.writeFileSync(path.join(candidate,'src/policy.ts'),"export const report={eligible:[],exceptions:[],heapOption:'--max-old-space-size=1536',approved:false,retainedApprovedCatalog:true,returnTo:'15-13'};");
  const contract=taskContract(task,'B'),contractFile=path.join(taskDirectory,'contract.json');atomicJSON(contractFile,contract);const source=path.join(candidate,'.reports/tests');fs.mkdirSync(source,{recursive:true});
  const testSource="import {test,expect} from 'vitest';import {report} from '@/policy';test('15-17:acceptance truthful diagnostic',()=>{expect(report.eligible).toEqual([]);expect(report.returnTo).toBe('15-13');expect(report.retainedApprovedCatalog).toBe(true);expect(report.approved).toBe(false);expect(report.exceptions).toEqual([]);expect(report.heapOption).toMatch(/^--max-old-space-size=[0-9]+$/);});test('15-17:preservation no approval',()=>expect(report.approved).toBe(false));";
  fs.writeFileSync(path.join(source,'acceptance.test.ts'),testSource);const planFile=path.join(source,'test-plan.json');atomicJSON(planFile,{version:1,taskId:task.id,contractDigest:contract.contractDigest,groups:[{environment:'node',files:['acceptance.test.ts']}],supportFiles:[]});
  const impl=path.join(taskDirectory,'attempt-002/implementation');atomicJSON(path.join(impl,'request.json'),{taskId:task.id});atomicJSON(path.join(impl,'response.json'),{turnId:'completed-fixture'});const requestIdentity=fileIdentity(root,path.join(impl,'request.json')),responseIdentity=fileIdentity(root,path.join(impl,'response.json'));
  const target=captureProductTarget(root,candidate,path.join(taskDirectory,'attempt-002/target'),{review:'B',requestIdentity,responseIdentity,turnId:'completed-fixture'}),row={attempt:2,attemptDirectory:path.dirname(impl),contractIdentity:fileIdentity(root,contractFile),implementation:{requestIdentity},target};
  const suite=freezeAcceptanceSuite(root,taskDirectory,candidate,planFile,contract,{prepareOnly:true});return{root,directory,plan,task,taskDirectory,candidate,contract,row,suite,target,source};
}

test('saved diagnostic task completes real Vitest, independent B fails, and the real controller dispatches responsible task 13',async t=>{
  const f=fixture(t),report=path.join(f.taskDirectory,'attempt-002/verification'),verdict=await verifyControllerTask({...f,report});expect(verdict.verdict).toBe('pass');atomicJSON(path.join(report,'verdict.json'),verdict);
  const assignment=deterministicAssignment(f.task,'B',f.candidate,'context',f.contract);expect(assignment.instructions).toContain('Complete the summary module');expect(assignment.instructions).not.toContain('Require a real successful selection');
  const tasks=Object.fromEntries(f.plan.tasks.map(task=>[task.id,{status:'pending',attempt:0}]));
  for(const task of f.plan.tasks.filter(task=>Number(task.id.slice(3))<=17)){tasks[task.id]={...f.row,status:'pass',attempt:1,acceptedTarget:f.target,verification:path.relative(f.root,path.join(report,'verdict.json')),workspace:{directory:f.candidate,baseline:workspaceSnapshot(f.candidate)},assignment:{writablePaths:[]},artifacts:[]};}
  const state={runId:'saved-diagnostic-run',review:'B',tasks,certificates:{A:{verification:fileIdentity(f.root,path.join(report,'verdict.json')),target:f.target}},reviewWorkspace:{review:'B',directory:f.candidate},approvedProductTarget:f.target,activeTurns:{},activeOperations:{},threads:{},guardian:{},repairAttempts:0};
  const w=Object.assign(Object.create(TaskWorkflow.prototype),{root:f.root,directory:f.directory,state,plan:f.plan,config:{taskVerificationMode:'controller-vitest',verificationFramework:'vitest'},save(){},event(){},stageInstructions(){return '';},audit:async()=>({decision:'continue'}),vitestAttestor:attestVitest,confirmedImplementationChanges(){return [];}});
  w.turn=async(role,key,cwd,report,prompt,schema,context)=>{
    fs.mkdirSync(report,{recursive:true});atomicJSON(path.join(report,'request.json'),{role,key,cwd,prompt,schemaDigest:digest(schema),...context});const requestIdentity=fileIdentity(f.root,path.join(report,'request.json'));let result;
    if(role==='verifier'){
      const testFile=path.join(report,'review-b.test.ts');fs.writeFileSync(testFile,"import {test,expect} from 'vitest';import {report} from '@/policy';test('REVIEW B must select a qualified policy',()=>expect(report.eligible.length).toBeGreaterThan(0));");
      const actual=await runTargetChecks(path.join(report,'job-context.json'),path.join(report,'independent-vitest'),[testFile]);expect(actual.pass).toBe(false);const pin=fileIdentity(f.root,path.join(report,'independent-vitest/result.json')),target=JSON.parse(fs.readFileSync(path.join(report,'job-context.json'))).productTarget;
      result={taskId:'REVIEW-B',review:'B',candidateRoot:cwd,targetId:target.targetId,verdict:'fail',nonPassKind:'implementation',summary:'No qualified policy in real fixture',checks:GATES.B.map(id=>({id,status:'fail',evidencePaths:[pin.path],detail:'Actual policy acceptance failed'})),inputs:[target.manifest],evidence:[pin],commands:[{command:actual.command.join(' '),exitCode:actual.execution.exitCode,evidencePath:pin.path}],failures:['No qualified policy'],suggestedRepairPrompt:'Repair 15-13'};
    }else result={review:'B',action:'repair',repairTaskIds:['15-13'],summary:'Repair responsible prototype',instructions:'Fix actual physical and generation-budget failures; keep all fixed criteria.'};
    const turnId=role+'-confirmed';atomicJSON(path.join(report,'dispatch.json'),{threadId:role+'-thread',turnId,requestIdentity,cwd});atomicJSON(path.join(report,'response.json'),{turnId,requestIdentity,cwd,schemaDigest:digest(schema),result});return{turnId,requestIdentity,responseIdentity:fileIdentity(f.root,path.join(report,'response.json')),result};
  };
  const before11=JSON.stringify(tasks['15-11']),before12=JSON.stringify(tasks['15-12']);expect(await w.review()).toBe(false);expect(state.certificates.B).toBeUndefined();expect(tasks['15-13'].status).toBe('repair');expect(tasks['15-17'].status).toBe('pending');expect(tasks['15-18'].status).toBe('pending');expect(JSON.stringify(tasks['15-11'])).toBe(before11);expect(JSON.stringify(tasks['15-12'])).toBe(before12);
  w.recoverReviewRepairHandoff();w.validatePrerequisites=()=>{};await w.assign(f.plan.tasks.find(t=>t.id==='15-13'));expect(tasks['15-13'].assignment.instructions).toContain('Fix actual physical and generation-budget failures');
  w.turn=async(role,key,cwd,report,prompt)=>{expect(role).toBe('implementer');expect(cwd).toBe(tasks['15-13'].assignment.candidateRoot);expect(prompt).toContain('Fix actual physical and generation-budget failures');throw Error('Fresh responsible implementation dispatched');};
  await expect(w.implement(f.plan.tasks.find(t=>t.id==='15-13'),0)).rejects.toThrow('Fresh responsible implementation dispatched');
},120000);

test('versioned harness selection preserves legacy receipt bytes and rejects selection outside its task',async t=>{
  const f=fixture(t);await verifyControllerTask({...f,report:path.join(f.taskDirectory,'verification')});
  const frozenFile=path.join(f.taskDirectory,'acceptance-suite/frozen.json'),frozen=JSON.parse(fs.readFileSync(frozenFile)),legacyFile=path.join(f.taskDirectory,'acceptance-suite/harness-revision.json'),authorization=path.join(f.taskDirectory,'authorization.json');atomicJSON(authorization,{kind:'explicit-user-harness-repair',taskId:f.task.id,reason:'Correct attempt metadata'});
  const revision=path.join(f.taskDirectory,'harness-revisions/next/source');fs.mkdirSync(revision,{recursive:true});fs.copyFileSync(path.join(f.source,'acceptance.test.ts'),path.join(revision,'acceptance.test.ts'));atomicJSON(path.join(revision,'test-plan.json'),{version:1,taskId:f.task.id,contractDigest:f.contract.contractDigest,groups:f.suite.groups,supportFiles:[]});
  const suite=freezeAcceptanceSuite(f.root,path.dirname(revision),f.candidate,path.join(revision,'test-plan.json'),f.contract,{planRoot:revision,prepareOnly:true}),pointer={kind:'controller-authorized-harness-repair',originalFrozen:fileIdentity(f.root,frozenFile),originalSuite:frozen.suite,authorization:fileIdentity(f.root,authorization),suite:fileIdentity(f.root,suite.receiptFile)};atomicJSON(legacyFile,pointer);const legacyBytes=fs.readFileSync(legacyFile);
  const oldInputs=path.join(f.taskDirectory,'legacy-bound-inputs.json');atomicJSON(oldInputs,{version:1,inputs:[fileIdentity(f.root,legacyFile)]});const legacyTarget=captureProductTarget(f.root,f.candidate,path.join(f.taskDirectory,'legacy-bound-target'),{review:'B',artifactManifest:oldInputs});
  const selected=path.join(f.taskDirectory,'acceptance-suite/harness-revision-002.json');atomicJSON(selected,pointer);const selection=path.join(f.taskDirectory,'acceptance-suite/harness-selection.json');atomicJSON(selection,{kind:'controller-harness-selection',revision:fileIdentity(f.root,selected)});
  expect(frozenAcceptanceSuite(f.root,f.taskDirectory).receiptFile).toBe(suite.receiptFile);expect(selectedHarnessRevisionFile(f.root,f.taskDirectory)).toBe(selected);expect(fs.readFileSync(legacyFile).equals(legacyBytes)).toBe(true);validateProductTarget(f.root,legacyTarget);
  atomicJSON(selection,{kind:'controller-harness-selection',revision:fileIdentity(f.root,authorization)});expect(()=>frozenAcceptanceSuite(f.root,f.taskDirectory)).toThrow('Invalid versioned harness selection');
},60000);

test('same-candidate proof resolves only the exact harness-caused strike once and cannot certify a different candidate',async t=>{
  const f=fixture(t),report=path.join(f.taskDirectory,'verification'),verdict=await verifyControllerTask({...f,report}),checked=path.join(report,'verdict.json');atomicJSON(checked,verdict);
  const original=path.join(f.taskDirectory,'old-failed-verdict.json');atomicJSON(original,{...verdict,verdict:'fail',nonPassKind:'implementation',failures:['Historical exception-count assumption']});
  const authorization=path.join(f.taskDirectory,'authorization.json');atomicJSON(authorization,{kind:'explicit-user-harness-repair',taskId:f.task.id,reason:'Same candidate passes current diagnostic metadata'});
  const receiptFile=path.join(f.taskDirectory,'harness-recovery.json'),receipt={kind:'verified-task-harness-recovery',runId:'fixture',taskId:f.task.id,allowedAction:'fresh-task-assignment',productApprovalIssued:false,originalVerdict:fileIdentity(f.root,original),sameCandidateVerification:fileIdentity(f.root,checked),selectedSuite:fileIdentity(f.root,f.suite.receiptFile),authorization:fileIdentity(f.root,authorization),contract:f.row.contractIdentity,resolvedFailureRevision:'original-failure'};atomicJSON(receiptFile,receipt);
  const state={runId:'fixture',repairAttempts:5,tasks:{[f.task.id]:{...f.row,verification:original,failedRevision:'original-failure',failures:1,harnessRecovery:fileIdentity(f.root,receiptFile)}}};
  expect(applyHarnessFailureResolution(f.root,f.directory,state,f.task)).toBe(true);expect(state.tasks[f.task.id].failures).toBe(0);expect(state.repairAttempts).toBe(4);expect(applyHarnessFailureResolution(f.root,f.directory,state,f.task)).toBe(false);expect(state.repairAttempts).toBe(4);expect(state.harnessFailureResolutions).toHaveLength(1);
  const other=path.join(f.taskDirectory,'different-candidate.json');atomicJSON(other,{...verdict,targetId:'different-target'});atomicJSON(receiptFile,{...receipt,sameCandidateVerification:fileIdentity(f.root,other)});state.tasks[f.task.id].harnessRecovery=fileIdentity(f.root,receiptFile);expect(()=>harnessRecoveryInstructions(f.root,f.directory,state,f.task)).toThrow('Unconfirmed task harness recovery');
},60000);

test('a historical harness correction cannot suppress a newer genuine task failure in its next assignment',async t=>{
  const f=fixture(t),report=path.join(f.taskDirectory,'verification'),verdict=await verifyControllerTask({...f,report}),checked=path.join(report,'verdict.json');atomicJSON(checked,verdict);
  const original=path.join(f.taskDirectory,'historical-harness-failure.json');atomicJSON(original,{...verdict,verdict:'fail',nonPassKind:'implementation',summary:'Resolved historical assumption',failures:['Historical exception count']});
  const authorization=path.join(f.taskDirectory,'authorization.json');atomicJSON(authorization,{kind:'explicit-user-harness-repair',taskId:f.task.id,reason:'Resolved historical assumption'});
  const receiptFile=path.join(f.taskDirectory,'recovery.json');atomicJSON(receiptFile,{kind:'verified-task-harness-recovery',runId:'fixture',taskId:f.task.id,allowedAction:'fresh-task-assignment',productApprovalIssued:false,originalVerdict:fileIdentity(f.root,original),sameCandidateVerification:fileIdentity(f.root,checked),selectedSuite:fileIdentity(f.root,f.suite.receiptFile),authorization:fileIdentity(f.root,authorization),contract:f.row.contractIdentity});
  const current=path.join(f.taskDirectory,'new-product-failure.json');atomicJSON(current,{...verdict,verdict:'fail',nonPassKind:'implementation',summary:'NEW_PRODUCT_FAILURE_MUST_REACH_IMPLEMENTER',failures:['New current-candidate preservation failure']});
  const row={...f.row,status:'repair',verification:current,harnessRecovery:fileIdentity(f.root,receiptFile)},state={runId:'fixture',review:'B',tasks:{[f.task.id]:row},certificates:{},approvedProductTarget:f.target,reviewWorkspace:{directory:f.candidate}};
  const w=Object.assign(Object.create(TaskWorkflow.prototype),{root:f.root,directory:f.directory,state,plan:f.plan,config:{taskVerificationMode:'controller-vitest'},save(){},event(){},validatePrerequisites(){}});
  await w.assign(f.task);expect(row.assignment.instructions).toContain('NEW_PRODUCT_FAILURE_MUST_REACH_IMPLEMENTER');expect(row.assignment.instructions).toContain('Explicit user-authorized harness recovery');
},60000);
