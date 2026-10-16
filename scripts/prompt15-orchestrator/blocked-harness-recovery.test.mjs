import fs from 'node:fs';import path from 'node:path';import {test,expect} from 'vitest';
import {TaskWorkflow} from './task-workflow.mjs';
import {atomicJSON,fileIdentity} from './protocol.mjs';
import {digest,productSnapshot} from './product-target.mjs';
import {taskContract} from './task-contracts.mjs';import {readTaskPlan} from './task-plan.mjs';
import {CONTROLLER_TASK_IMPLEMENTATION_SCHEMA} from './task-protocol.mjs';
import {freezeAcceptanceSuite} from './controller-task-verification.mjs';

function fixture(t){
  const base=path.resolve('.tmp/blocked-harness-recovery-tests');fs.mkdirSync(base,{recursive:true});const root=fs.mkdtempSync(path.join(base,'case-'));
  t.onTestFinished(()=>{expect(root.startsWith(base+path.sep)).toBe(true);fs.rmSync(root,{recursive:true,force:true});});
  const task=readTaskPlan().tasks[0],directory=path.join(root,'run'),taskDirectory=path.join(directory,'tasks',task.id),attemptDirectory=path.join(taskDirectory,'attempt-002'),candidate=path.join(attemptDirectory,'candidate');
  fs.mkdirSync(path.join(candidate,'src'),{recursive:true});fs.writeFileSync(path.join(candidate,'src/base.ts'),'export const value=42;');atomicJSON(path.join(candidate,'package.json'),{type:'module'});
  const contract=taskContract(task,'A'),contractFile=path.join(taskDirectory,'contract.json');atomicJSON(contractFile,contract);const contractIdentity=fileIdentity(root,contractFile);
  const source=path.join(candidate,'.reports');fs.mkdirSync(source);fs.writeFileSync(path.join(source,'acceptance.test.ts'),"import {test,expect} from 'vitest';test('15-01:acceptance',()=>expect(42).toBe(42));test('15-01:preservation',()=>expect(42).not.toBe(99));");
  const plan=path.join(source,'test-plan.json');atomicJSON(plan,{version:1,taskId:task.id,contractDigest:contract.contractDigest,groups:[{environment:'node',files:['acceptance.test.ts']}],supportFiles:[]});
  const original=freezeAcceptanceSuite(root,taskDirectory,candidate,plan,contract,{prepareOnly:true});atomicJSON(path.join(taskDirectory,'acceptance-suite/frozen.json'),{suite:fileIdentity(root,original.receiptFile)});
  const assignment={taskId:task.id,review:'A',candidateRoot:candidate};const assignmentFile=path.join(attemptDirectory,'assignment/response.json');atomicJSON(assignmentFile,{contract:contractIdentity,assignment});
  const report=path.join(attemptDirectory,'implementation'),request={role:'implementer',taskId:task.id,review:'A',cwd:candidate,schemaDigest:digest(CONTROLLER_TASK_IMPLEMENTATION_SCHEMA)};
  atomicJSON(path.join(report,'request.json'),request);const requestIdentity=fileIdentity(root,path.join(report,'request.json'));atomicJSON(path.join(report,'dispatch.json'),{requestIdentity,threadId:'original-implementer',turnId:'original-turn',cwd:candidate});
  const manifest=path.join(source,'inputs.json');atomicJSON(manifest,{version:1,inputs:[]});
  const result={taskId:task.id,status:'blocked',candidateRoot:candidate,changedFiles:['src/base.ts'],inputManifestPath:manifest,testPlanPath:plan,artifactPaths:[],remainingIssues:['Historical context pin'],summary:'Context binding is blocked'};
  const response={cwd:candidate,requestIdentity,turnId:'original-turn',completedAt:new Date().toISOString(),schemaDigest:request.schemaDigest,productSourceDigest:digest(productSnapshot(candidate)),result};atomicJSON(path.join(report,'response.json'),response);
  const row={status:'blocked',attempt:2,attemptDirectory,workspace:{directory:candidate},contractIdentity,assignment,assignmentReceipt:fileIdentity(root,assignmentFile),implementation:{result,requestIdentity,turnId:response.turnId,responseIdentity:fileIdentity(root,path.join(report,'response.json'))}};
  const decisions=[];const control=Object.assign(Object.create(TaskWorkflow.prototype),{root,directory,plan:{tasks:[task]},state:{review:'A',tasks:{[task.id]:row}},save(){},event(){},async resolveInternalProductBlock(){throw Error('supervisor blocked; separate internal resolution boundary');},async turn(role,key,cwd,report,prompt,schema,context){
    decisions.push({report,prompt,context});const requestFile=path.join(report,'request.json');atomicJSON(requestFile,{role,key,cwd,schemaDigest:digest(schema),...context});const requestIdentity=fileIdentity(root,requestFile),result={taskId:task.id,review:'A',candidateRoot:candidate,action:'blocked',repairTaskIds:[],instructions:'Wait for correction',summary:'Fixture routing only'};
    atomicJSON(path.join(report,'dispatch.json'),{threadId:'supervisor',turnId:'routing-turn-'+decisions.length,cwd,requestIdentity});atomicJSON(path.join(report,'response.json'),{requestIdentity,cwd,turnId:'routing-turn-'+decisions.length,schemaDigest:digest(schema),result});return {turnId:'routing-turn-'+decisions.length,result,responseIdentity:fileIdentity(root,path.join(report,'response.json'))};
  }});
  function revise(){
    const revision=path.join(taskDirectory,'harness-revisions/current-context'),source=path.join(revision,'source');fs.mkdirSync(source,{recursive:true});fs.copyFileSync(path.join(original.directory,'acceptance.test.ts'),path.join(source,'acceptance.test.ts'));atomicJSON(path.join(source,'test-plan.json'),{version:1,taskId:task.id,contractDigest:contract.contractDigest,groups:original.groups,supportFiles:[]});
    const suite=freezeAcceptanceSuite(root,revision,candidate,path.join(source,'test-plan.json'),contract,{planRoot:source,prepareOnly:true});const authorization=path.join(revision,'authorization.json');atomicJSON(authorization,{kind:'explicit-user-harness-repair',taskId:task.id,reason:'Correct current context binding'});
    const pointer=path.join(taskDirectory,'acceptance-suite/harness-revision.json');atomicJSON(pointer,{kind:'controller-authorized-harness-repair',originalFrozen:fileIdentity(root,path.join(taskDirectory,'acceptance-suite/frozen.json')),originalSuite:fileIdentity(root,original.receiptFile),authorization:fileIdentity(root,authorization),suite:fileIdentity(root,suite.receiptFile)});return {suite,pointer,authorization};
  }
  return {control,task,row,decisions,revise,root};
}

test('authorized harness repair creates a fresh supervisor route for the exact blocked implementation and preserves its prior decision',async t=>{
  const f=fixture(t),before=structuredClone(f.row.implementation);await expect(f.control.handoffBlockedProduct(f.task,{},'old')).rejects.toThrow(/supervisor blocked/);
  const old=f.row.blockedProductHandoff.decision,oldBytes=fs.readFileSync(path.resolve(f.root,old.path));const revision=f.revise();
  await expect(f.control.handoffBlockedProduct(f.task,{},'new')).rejects.toThrow(/supervisor blocked/);
  expect(f.decisions).toHaveLength(2);expect(f.decisions[1].report).not.toBe(f.decisions[0].report);expect(f.decisions[1].prompt).toContain('explicit user-authorized harness correction');expect(f.row.implementation).toEqual(before);
  expect(fs.readFileSync(path.resolve(f.root,old.path)).equals(oldBytes)).toBe(true);expect(f.row.status).toBe('blocked');expect(f.row.target).toBeUndefined();
  const handoff=JSON.parse(fs.readFileSync(path.resolve(f.root,f.row.blockedProductHandoff.handoff.path)));expect(handoff.acceptanceRevision.suite).toEqual(fileIdentity(f.root,revision.suite.receiptFile));expect(handoff.confirmedResponseIdentity).toEqual(before.responseIdentity);
});

test('changed or weakened harness inputs cannot obtain a fresh blocked-product routing decision',async t=>{
  const f=fixture(t),revision=f.revise();fs.appendFileSync(path.join(revision.suite.directory,'acceptance.test.ts'),'// changed');
  await expect(f.control.handoffBlockedProduct(f.task,{},'new')).rejects.toThrow(/Evidence bytes changed/);expect(f.decisions).toHaveLength(0);expect(f.row.status).toBe('blocked');
});
