import fs from 'node:fs';
import path from 'node:path';
import {test,expect} from 'vitest';
import {freezeAcceptanceSuite,frozenAcceptanceSuite,verifyControllerTask} from './controller-task-verification.mjs';
import {taskContract} from './task-contracts.mjs';
import {captureProductTarget} from './product-target.mjs';
import {fileIdentity,atomicJSON} from './protocol.mjs';
import {readTaskPlan} from './task-plan.mjs';
import {runTargetChecks} from './run-target-checks.mjs';

function fixture(context,{missing=false,secondGroup=false,value=42}={}){
  const base=path.resolve('.tmp/controller-acceptance-tests');fs.mkdirSync(base,{recursive:true});const root=fs.mkdtempSync(path.join(base,'case-'));
  context.onTestFinished(()=>{if(!root.startsWith(base+path.sep))throw Error('Unsafe fixture cleanup');fs.rmSync(root,{recursive:true,force:true});});
  const task=readTaskPlan().tasks[0],taskDirectory=path.join(root,'reports/tasks',task.id),candidateRoot=path.join(taskDirectory,'attempt-001/candidate'),report=path.join(taskDirectory,'attempt-001/verification');
  fs.mkdirSync(path.join(candidateRoot,'src'),{recursive:true});fs.mkdirSync(path.join(candidateRoot,'.reports/tests'),{recursive:true});
  atomicJSON(path.join(candidateRoot,'package.json'),{type:'module'});fs.writeFileSync(path.join(candidateRoot,'src/value.ts'),`export const value=${value};`);
  const contract=taskContract(task,'A'),contractFile=path.join(taskDirectory,'contract.json');atomicJSON(contractFile,contract);
  const implementation=path.join(taskDirectory,'attempt-001/implementation');fs.mkdirSync(implementation,{recursive:true});atomicJSON(path.join(implementation,'request.json'),{taskId:task.id});
  atomicJSON(path.join(implementation,'response.json'),{turnId:'fixture-confirmed-turn'});
  const requestIdentity=fileIdentity(root,path.join(implementation,'request.json')),responseIdentity=fileIdentity(root,path.join(implementation,'response.json'));
  const target=captureProductTarget(root,candidateRoot,path.join(taskDirectory,'attempt-001/target'),{requestIdentity,responseIdentity,turnId:'fixture-confirmed-turn',review:'A'});
  const source=`import {test,expect} from 'vitest';import {value} from '@/value';test('${task.id}:acceptance actual candidate import and cwd',()=>{expect(value).toBe(42);expect(process.cwd()).toBe(process.env.PROMPT15_CANDIDATE_ROOT);});${missing?'':`test('${task.id}:preservation actual negative assertion',()=>{expect(value).not.toBe(99);});`}`;
  const planFile=path.join(candidateRoot,'.reports/tests/test-plan.json');fs.writeFileSync(path.join(path.dirname(planFile),'acceptance.test.ts'),source);
  const groups=[{environment:'node',files:['acceptance.test.ts']}];
  if(secondGroup){fs.writeFileSync(path.join(path.dirname(planFile),'second.test.ts'),"import {test,expect} from 'vitest';test('second actual group',()=>expect(2+2).toBe(4));");groups.push({environment:'node',files:['second.test.ts']});}
  atomicJSON(planFile,{version:1,taskId:task.id,contractDigest:contract.contractDigest,groups,supportFiles:[]});
  const row={attempt:1,target,contractIdentity:fileIdentity(root,contractFile),implementation:{requestIdentity}};
  const suite=freezeAcceptanceSuite(root,taskDirectory,candidateRoot,planFile,contract);
  return {root,taskDirectory,candidateRoot,report,task,row,contract,suite,planFile};
}

test('official acceptance runs real candidate-bound Vitest once and reuses its authenticated completed result',async context=>{
  const f=fixture(context);let runs=0;const run=(...args)=>{runs++;return runTargetChecks(...args);};
  const first=await verifyControllerTask({...f,run});expect(first.verdict).toBe('pass');expect(runs).toBe(1);
  const resumed=await verifyControllerTask({...f,run:()=>{throw Error('A completed group must not execute twice');}});
  expect(resumed.verdict).toBe('pass');expect(resumed.evidence).toEqual(first.evidence);
},60000);

test('a changed product fails real assertions even if implementation rewrites its original test to accept the defect',async context=>{
  const f=fixture(context,{value:41});const first=await verifyControllerTask(f);expect(first.verdict).toBe('fail');
  fs.writeFileSync(path.join(path.dirname(f.planFile),'acceptance.test.ts'),"import {test,expect} from 'vitest';test('15-01:acceptance fake replacement',()=>expect(41).toBe(41));");
  const frozen=freezeAcceptanceSuite(f.root,f.taskDirectory,f.candidateRoot,f.planFile,f.contract);expect(frozen).toEqual(f.suite);
  const verdict=await verifyControllerTask(f);expect(verdict.verdict).toBe('fail');expect(verdict.nonPassKind).toBe('implementation');expect(verdict.failures.join(' ')).toContain('actual candidate import');
},60000);

test('passing tests without all fixed acceptance criteria cannot release dependencies',async context=>{
  const f=fixture(context,{missing:true}),result=await verifyControllerTask(f);
  expect(result.verdict).toBe('blocked');expect(result.failures.join(' ')).toContain('15-01:preservation');
},60000);

test('a context identity decoded as a filename is an operating delivery block rather than a product defect',async context=>{
  const f=fixture(context),directory=path.join(f.candidateRoot,'.reports/delivery');fs.mkdirSync(directory,{recursive:true});
  const input=path.join(f.taskDirectory,'task-input-context.json');atomicJSON(input,{version:1});f.row.inputContext=fileIdentity(f.root,input);
  fs.writeFileSync(path.join(directory,'acceptance.test.ts'),`import fs from 'node:fs';import path from 'node:path';import {test,expect} from 'vitest';test('${f.task.id}:acceptance',()=>expect(42).toBe(42));test('${f.task.id}:preservation',()=>{fs.readFileSync(path.resolve(process.env.PROMPT15_TASK_INPUT_CONTEXT));});`);
  const plan=path.join(directory,'test-plan.json');atomicJSON(plan,{version:1,taskId:f.task.id,contractDigest:f.contract.contractDigest,groups:[{environment:'node',files:['acceptance.test.ts']}],supportFiles:[]});
  const suite=freezeAcceptanceSuite(f.root,f.taskDirectory,f.candidateRoot,plan,f.contract,{prepareOnly:true});
  const verdict=await verifyControllerTask({...f,suite});expect(verdict.verdict).toBe('blocked');expect(verdict.nonPassKind).toBe('environment');expect(verdict.operatingFailureKind).toBe('input_delivery');
  expect(fs.existsSync(path.join(f.taskDirectory,'acceptance-suite/frozen.json'))).toBe(false);
},60000);

test('controller restart preserves completed groups and executes only the interrupted group',async context=>{
  const f=fixture(context,{secondGroup:true});let calls=0;
  await expect(verifyControllerTask({...f,run:(...args)=>{if(++calls===2)throw Error('Injected controller disconnect');return runTargetChecks(...args);}})).rejects.toThrow('Injected controller disconnect');
  expect(calls).toBe(2);let resumed=0;
  const result=await verifyControllerTask({...f,run:(...args)=>{resumed++;return runTargetChecks(...args);}});
  expect(result.verdict).toBe('pass');expect(resumed).toBe(1);
},60000);

test('frozen suite byte changes and paths outside the candidate report are rejected',context=>{
  const f=fixture(context);fs.appendFileSync(path.join(f.suite.directory,'acceptance.test.ts'),'\n// unauthorized edit');
  expect(()=>freezeAcceptanceSuite(f.root,f.taskDirectory,f.candidateRoot,f.planFile,f.contract)).toThrow(/bytes changed|Evidence/i);
  const other=path.join(f.root,'outside.json');atomicJSON(other,{});
  expect(()=>freezeAcceptanceSuite(f.root,path.join(f.root,'reports/other'),f.candidateRoot,other,f.contract)).toThrow();
});

test('an explicitly authorized harness revision preserves the original failure and cannot hide a real product defect',async context=>{
  const f=fixture(context,{value:41});expect((await verifyControllerTask(f)).verdict).toBe('fail');
  const frozenFile=path.join(f.taskDirectory,'acceptance-suite/frozen.json'),frozenBytes=fs.readFileSync(frozenFile),frozen=JSON.parse(frozenBytes);
  const source=path.join(f.taskDirectory,'harness-revisions/revision-001/source');fs.mkdirSync(source,{recursive:true});
  fs.writeFileSync(path.join(source,'acceptance.test.ts'),fs.readFileSync(path.join(f.suite.directory,'acceptance.test.ts'),'utf8')+'\n// Controller-reviewed harness metadata revision; all assertions retained.\n');
  const plan=path.join(source,'test-plan.json');atomicJSON(plan,{version:1,taskId:f.task.id,contractDigest:f.contract.contractDigest,groups:f.suite.groups,supportFiles:[]});
  const selected=freezeAcceptanceSuite(f.root,path.dirname(source),f.candidateRoot,plan,f.contract,{planRoot:source,prepareOnly:true}),authorizationFile=path.join(f.taskDirectory,'harness-authorization.json');
  atomicJSON(authorizationFile,{kind:'explicit-user-harness-repair',taskId:f.task.id,reason:'Preserve functional assertions while correcting a confirmed harness defect'});
  const pointer=path.join(f.taskDirectory,'acceptance-suite/harness-revision.json'),revision={version:1,kind:'controller-authorized-harness-repair',originalFrozen:fileIdentity(f.root,frozenFile),originalSuite:frozen.suite,authorization:fileIdentity(f.root,authorizationFile),suite:fileIdentity(f.root,selected.receiptFile)};atomicJSON(pointer,revision);
  expect(frozenAcceptanceSuite(f.root,f.taskDirectory)).toEqual(selected);
  const actual=await verifyControllerTask({...f,suite:selected,report:path.join(f.taskDirectory,'revision-verification')});expect(actual.verdict).toBe('fail');expect(actual.failures.join(' ')).toContain('actual candidate import');
  expect(fs.readFileSync(frozenFile).equals(frozenBytes)).toBe(true);
  const altered=JSON.parse(fs.readFileSync(selected.receiptFile));altered.requirements[0].text='weakened requirement';atomicJSON(selected.receiptFile,altered);atomicJSON(pointer,{...revision,suite:fileIdentity(f.root,selected.receiptFile)});
  expect(()=>frozenAcceptanceSuite(f.root,f.taskDirectory)).toThrow(/cannot change product requirements/);
},60000);

test('current attempt context is checked against controller identity and changed bytes cannot be accepted',async context=>{
  const f=fixture(context),input=path.join(f.taskDirectory,'task-input-context.json');atomicJSON(input,{attempt:2,dependencies:['new-current-input']});f.row.inputContext=fileIdentity(f.root,input);
  const source=path.join(f.candidateRoot,'.reports/current-context');fs.mkdirSync(source);
  fs.writeFileSync(path.join(source,'acceptance.test.ts'),`import fs from 'node:fs';import {createHash} from 'node:crypto';import {test,expect} from 'vitest';import {value} from '@/value';test('15-01:acceptance',()=>expect(value).toBe(42));test('15-01:preservation',()=>{const pin=JSON.parse(process.env.PROMPT15_TASK_INPUT_CONTEXT_IDENTITY);const bytes=fs.readFileSync(process.env.PROMPT15_TASK_INPUT_CONTEXT_PATH);expect(createHash('sha256').update(bytes).digest('hex')).toBe(pin.sha256);expect(bytes.length).toBe(pin.byteLength);expect(JSON.parse(bytes).attempt).toBe(2);});`);
  const plan=path.join(source,'test-plan.json');atomicJSON(plan,{version:1,taskId:f.task.id,contractDigest:f.contract.contractDigest,groups:[{environment:'node',files:['acceptance.test.ts']}],supportFiles:[]});
  const suite=freezeAcceptanceSuite(f.root,f.taskDirectory,f.candidateRoot,plan,f.contract,{prepareOnly:true});expect((await verifyControllerTask({...f,suite})).verdict).toBe('pass');
  fs.appendFileSync(input,' ');await expect(verifyControllerTask({...f,suite,report:path.join(f.taskDirectory,'tampered-context')})).rejects.toThrow(/Evidence bytes changed/);
},60000);
