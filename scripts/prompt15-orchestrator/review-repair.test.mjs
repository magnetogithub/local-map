import fs from 'node:fs';
import path from 'node:path';
import {test,expect} from 'vitest';
import {TaskWorkflow} from './task-workflow.mjs';
import {confirmedReviewRepair,taskAttemptMismatch} from './review-repair.mjs';
import {atomicJSON,fileIdentity} from './protocol.mjs';
import {digest,captureProductTarget} from './product-target.mjs';
import {REVIEW_DECISION_SCHEMA} from './task-protocol.mjs';
import {readTaskPlan} from './task-plan.mjs';

function fixture(t){
  const base=path.resolve('.tmp/review-repair-tests');fs.mkdirSync(base,{recursive:true});const root=fs.mkdtempSync(path.join(base,'case-'));
  t.onTestFinished(()=>{if(!root.startsWith(base+path.sep))throw Error('Unsafe fixture cleanup');fs.rmSync(root,{recursive:true,force:true});});
  const directory=path.join(root,'reports/run'),candidate=path.join(root,'reports/source');fs.mkdirSync(path.join(candidate,'src'),{recursive:true});fs.writeFileSync(path.join(candidate,'src/base.txt'),'preserved');atomicJSON(path.join(candidate,'package.json'),{type:'module'});
  const target=captureProductTarget(root,candidate,path.join(directory,'target'),{review:'B'});
  const plan=readTaskPlan(),invalid=plan.tasks.filter(task=>Number(task.id.slice(3))>=13).map(task=>task.id);
  const verdict={review:'B',verdict:'fail',nonPassKind:'implementation',summary:'Actual whole-parent assertion failure',failures:['NUMERICAL_CHART_LIMIT'],productTarget:target,inputs:[],evidence:[]};
  const decisionDirectory=path.join(directory,'reviews/B-1/decision'),verdictFile=path.join(directory,'reviews/B-1/verdict.json');atomicJSON(verdictFile,verdict);
  const action={review:'B',action:'repair',repairTaskIds:['15-13'],summary:'Repair the partition prototype',instructions:'Fix complete-parent geometry; preserve 15-12 criteria.'};
  const requestFile=path.join(decisionDirectory,'request.json');atomicJSON(requestFile,{role:'supervisor',review:'B',cwd:candidate,schemaDigest:digest(REVIEW_DECISION_SCHEMA),prompt:'Whole REVIEW B independent verdict '+JSON.stringify(verdict)});
  const requestIdentity=fileIdentity(root,requestFile);atomicJSON(path.join(decisionDirectory,'dispatch.json'),{turnId:'confirmed-decision',requestIdentity});
  atomicJSON(path.join(decisionDirectory,'response.json'),{turnId:'confirmed-decision',requestIdentity,schemaDigest:digest(REVIEW_DECISION_SCHEMA),cwd:candidate,result:action});
  const old=path.join(directory,'tasks/15-13/attempt-001/candidate'),attempt=path.join(directory,'tasks/15-13/attempt-002');
  const tasks=Object.fromEntries(plan.tasks.map(task=>[task.id,{status:'pending',attempt:0}]));
  tasks['15-12']={status:'pass',attempt:1,proof:'unchanged'};
  tasks['15-13']={status:'implemented',attempt:2,attemptDirectory:attempt,workspace:{directory:old},target:{productRoot:old},assignment:{candidateRoot:path.join(attempt,'candidate')},implementation:{result:{candidateRoot:old}},verification:path.relative(root,verdictFile)};
  const state={review:'B',reviewAttempt:{B:1},repairRouting:{review:'B',invalid,reason:action.summary,instructions:action.instructions},tasks,activeTurns:{},approvedProductTarget:target,reviewWorkspace:{directory:candidate}};
  const w=Object.create(TaskWorkflow.prototype);Object.assign(w,{root,directory,state,plan,config:{taskVerificationMode:'controller-vitest'},save(){},event(){},validatePrerequisites(){}});
  return {root,directory,state,plan,w,target,decisionDirectory,action};
}

test('whole REVIEW failure recovers a mixed historical attempt and delivers the actual repair to a fresh assignment',async t=>{
  const f=fixture(t),prior=JSON.stringify(f.state.tasks['15-12']);
  expect(taskAttemptMismatch(f.state.tasks['15-13'])).toBe(true);
  f.w.recoverReviewRepairHandoff();expect(f.state.tasks['15-13'].status).toBe('repair');
  f.state.tasks['15-13'].operatingContinuation={revision:'old-attempt-continuation'};f.state.tasks['15-13'].operatingHandoff={binding:'old-attempt-handoff'};
  await f.w.assign(f.plan.tasks.find(task=>task.id==='15-13'));
  const row=f.state.tasks['15-13'];expect(row.attempt).toBe(3);expect(row.workspace).toBeUndefined();expect(row.target).toBeUndefined();
  expect(row.attemptHistory).toHaveLength(1);expect(row.attemptHistory[0].attempt).toBe(2);
  expect(row.assignment.instructions).toContain(f.action.instructions);
  expect(row.operatingContinuation).toBeUndefined();expect(row.operatingHandoff).toBeUndefined();
  expect(row.assignment.instructions).toContain('observations, not permanent success criteria');
  const input=JSON.parse(fs.readFileSync(path.resolve(f.root,row.inputContext.path)));
  expect(input.candidateRoot).toBe(row.assignment.candidateRoot);expect(input.reviewRepair.decision.sha256).toBe(row.reviewRepair.decision.sha256);
  expect(JSON.stringify(f.state.tasks['15-12'])).toBe(prior);
  expect(f.state.tasks['15-18'].reviewRepair).toBeUndefined();
  f.w.turn=async(role,key,cwd,report,prompt)=>{expect(cwd).toBe(row.assignment.candidateRoot);expect(prompt).toContain(f.action.instructions);throw Error('Confirmed fresh dispatch boundary');};
  await expect(f.w.implement(f.plan.tasks.find(task=>task.id==='15-13'),0)).rejects.toThrow('Confirmed fresh dispatch boundary');
});

for(const tamper of ['routing','native-turn','verdict'])test(`review repair authority refuses ${tamper} changes before mutating tasks`,t=>{
  const f=fixture(t),before=JSON.stringify(f.state.tasks);
  if(tamper==='routing')f.state.repairRouting.instructions='Weaken the criteria';
  if(tamper==='native-turn'){const file=path.join(f.decisionDirectory,'dispatch.json'),j=JSON.parse(fs.readFileSync(file));atomicJSON(file,{...j,turnId:'wrong-turn'});}
  if(tamper==='verdict'){const file=path.join(f.directory,'reviews/B-1/verdict.json'),j=JSON.parse(fs.readFileSync(file));atomicJSON(file,{...j,verdict:'pass'});}
  expect(()=>f.w.recoverReviewRepairHandoff()).toThrow();expect(JSON.stringify(f.state.tasks)).toBe(before);
});

test('a matched current attempt is retained and repeated recovery never archives or reassigns it',t=>{
  const f=fixture(t),row=f.state.tasks['15-13'],current=path.join(row.attemptDirectory,'candidate');
  row.workspace.directory=current;row.target.productRoot=current;row.implementation.result.candidateRoot=current;
  f.state.activeTurns={implementer:{taskId:'15-13',turnId:'current-owned-turn'}};
  f.w.recoverReviewRepairHandoff();f.w.recoverReviewRepairHandoff();expect(row.status).toBe('implemented');expect(row.attemptHistory).toBeUndefined();
  f.state.reviewAttempt.B=2;f.w.recoverReviewRepairHandoff();expect(row.reviewRepair.verification.path).toContain('B-1/verdict.json');
  expect(confirmedReviewRepair(f.root,f.directory,{...f.state,repairRouting:null},f.plan,()=>{})).toBeNull();
});

test('a corrupt attempt with an unresolved native owner is held without changing execution authority',t=>{
  const f=fixture(t);f.state.activeTurns={implementer:{taskId:'15-13',turnId:'unresolved-turn'}};
  const before=JSON.stringify(f.state.tasks);expect(()=>f.w.recoverReviewRepairHandoff()).toThrow('quiescent product handoff');
  expect(JSON.stringify(f.state.tasks)).toBe(before);expect(f.state.activeTurns.implementer.turnId).toBe('unresolved-turn');
});
