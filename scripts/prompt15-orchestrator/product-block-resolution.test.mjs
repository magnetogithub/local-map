import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {test,expect} from 'vitest';
import {atomicJSON,fileIdentity} from './protocol.mjs';
import {digest,productSnapshot} from './product-target.mjs';
import {automaticRecovery,productBlockNeedsResolution} from './operating-recovery.mjs';
import {observeProductProgress,evaluateSupervisorOversight} from './supervisor-oversight-policy.mjs';
import {resolveInternalProductBlock,internalBlockInstructions,inspectBlockedArtifacts,PRODUCT_BLOCK_RESOLUTION_SCHEMA} from './product-block-resolution.mjs';
import {deterministicAssignment,taskContract} from './task-contracts.mjs';
import {readTaskPlan} from './task-plan.mjs';

function fixture(t){
  const base=path.resolve('.tmp/product-block-resolution-tests');fs.mkdirSync(base,{recursive:true});const root=fs.mkdtempSync(path.join(base,'case-'));
  t.onTestFinished(()=>{if(!root.startsWith(base+path.sep))throw Error('Unsafe fixture cleanup');fs.rmSync(root,{recursive:true,force:true});});
  const directory=path.join(root,'run'),candidate=path.join(directory,'tasks/15-14/attempt-004/candidate');fs.mkdirSync(path.join(candidate,'scripts'),{recursive:true});atomicJSON(path.join(candidate,'package.json'),{type:'module'});fs.writeFileSync(path.join(candidate,'scripts/experiment.mjs'),'export const current=42;');
  const task={id:'15-14',dependsOn:[]},sibling={id:'15-15',dependsOn:[]},dependent={id:'15-16',dependsOn:['15-14','15-15']};
  const pin=(name,value)=>{const file=path.join(root,name);atomicJSON(file,value);return fileIdentity(root,file);};
  const contract=pin('contract.json',{taskId:task.id,contractDigest:'unchanged',requirements:[{id:'acceptance',text:'Compare experiments'}]});
  const testFile=path.join(root,'frozen/acceptance.test.ts');fs.mkdirSync(path.dirname(testFile),{recursive:true});fs.writeFileSync(testFile,"const experiments=read('.reports/15-14/final/experiments.json.gz');const summary=read('.reports/15-14/final/summary.json');");
  const suite=pin('frozen/suite.json',{inputs:[fileIdentity(root,testFile)]});
  const request=pin('implementation/request.json',{taskId:task.id,cwd:candidate});
  const response=pin('implementation/response.json',{turnId:'implementation-turn',result:{taskId:task.id,status:'blocked',candidateRoot:candidate}});
  const packet={taskId:task.id,review:'B',attempt:4,candidateRoot:candidate,productSourceDigest:digest(productSnapshot(candidate)),confirmedResponseIdentity:response,contractIdentity:contract,inputs:[contract,request,response],acceptanceRevision:{suite}};
  const handoff=pin('handoff/inputs.json',packet),blockedDecision=pin('handoff/decision/response.json',{turnId:'blocked-decision-turn',result:{action:'blocked',candidateRoot:candidate}});
  const held={taskId:task.id,candidateRoot:candidate,response,handoff,decision:blockedDecision,executionIncident:null};
  const row={status:'blocked',attempt:4,attemptDirectory:path.dirname(candidate),workspace:{directory:candidate},contractIdentity:contract,implementation:{responseIdentity:response},blockedProductHandoff:{status:'blocked',handoff,decision:blockedDecision},failures:1};
  const state={status:'blocked',phase:'blocked_product_handoff',review:'B',createdAt:new Date(Date.now()-600000).toISOString(),tasks:{'15-14':row,'15-15':{status:'pass',verification:'certified-sibling',acceptedTarget:{targetId:'sibling'}},'15-16':{status:'pending'}},productBlockedHandoff:held,activeTurns:{},activeOperations:{},repairAttempts:4};
  let calls=0,action={taskId:task.id,review:'B',candidateRoot:candidate,action:'complete_task',classification:'missing_artifacts',summary:'The unchanged experiment suite permits infeasible scopes; required reports are missing.',instructions:'Regenerate all experiments and final evidence in a new candidate. Preserve failed gates and run the unchanged controller suite.',question:'',inputKind:'none'};
  const control={root,directory,state,plan:{tasks:[task,sibling,dependent]},ensureRunning(){if(fs.existsSync(path.join(directory,'stop.json')))throw Error('Task controller stopped');},retainTaskAttempt(r){r.attemptHistory??=[];r.attemptHistory.push(structuredClone(r));},save(){},event(){},async turn(role,key,cwd,report,prompt,schema,context){
    calls++;const requestFile=path.join(report,'request.json');atomicJSON(requestFile,{role,key,cwd,schemaDigest:digest(schema),...context});const requestIdentity=fileIdentity(root,requestFile);atomicJSON(path.join(report,'dispatch.json'),{threadId:'supervisor-thread',turnId:'resolution-turn',cwd,requestIdentity});const file=path.join(report,'response.json');atomicJSON(file,{turnId:'resolution-turn',cwd,schemaDigest:digest(schema),requestIdentity,result:action});return{result:action,turnId:'resolution-turn',responseIdentity:fileIdentity(root,file)};
  }};
  return{root,directory,candidate,task,state,row,control,held,packet,calls:()=>calls,setAction(value){action={...action,...value};}};
}

test('an authenticated internal BLOCKED handoff stays recoverable and under oversight until a next owner exists',async t=>{
  const f=fixture(t),config={taskVerificationMode:'controller-vitest',automaticRecovery:true};
  const recovery=process.env.PROMPT15_BLOCK_RECOVERY_MODULE?await import(pathToFileURL(process.env.PROMPT15_BLOCK_RECOVERY_MODULE).href):{automaticRecovery};
  expect(recovery.automaticRecovery(f.state,config)).toBe(true);
  expect(productBlockNeedsResolution(f.state)).toBe(true);
  const now=Date.now(),observation=observeProductProgress(f.state,null,now),decision=evaluateSupervisorOversight(f.state,{},observation,now);
  expect(decision.decision).toBe('audit');expect(decision.reasonCode).toBe('product_execution_gap');
});

test('independent artifact inspection records actual missing frozen-suite inputs without issuing a product failure',t=>{
  const f=fixture(t),result=inspectBlockedArtifacts(f.root,f.packet);
  expect(result.artifactReads).toEqual([{path:'.reports/15-14/final/experiments.json.gz',exists:false},{path:'.reports/15-14/final/summary.json',exists:false}]);
  expect(f.row.failures).toBe(1);expect(f.state.repairAttempts).toBe(4);
});

test('prerequisite test artifacts are not mistaken for missing outputs in the blocked candidate',t=>{
  const f=fixture(t),file=path.join(f.root,'upstream/acceptance.test.ts');fs.mkdirSync(path.dirname(file));fs.writeFileSync(file,"read('.reports/15-13/only-in-upstream.json');");f.packet.inputs.push(fileIdentity(f.root,file));
  expect(inspectBlockedArtifacts(f.root,f.packet).artifactReads.some(p=>p.path.includes('15-13'))).toBe(false);
});

test('confirmed internal resolution assigns a fresh same-task repair, preserves accepted sibling and all counters, and delivers its instructions once',async t=>{
  const f=fixture(t),sibling=structuredClone(f.state.tasks['15-15']),oldResponse=fs.readFileSync(path.resolve(f.root,f.held.response.path));
  expect(await resolveInternalProductBlock(f.control,f.task)).toBe(true);
  expect(f.row.status).toBe('repair');expect(f.row.attempt).toBe(4);expect(f.row.attemptHistory).toHaveLength(1);
  expect(f.state.tasks['15-15']).toEqual(sibling);expect(f.row.failures).toBe(1);expect(f.state.repairAttempts).toBe(4);expect(f.state.productBlockedHandoff).toBeUndefined();
  expect(internalBlockInstructions(f.root,f.state,f.task)).toContain('Regenerate all experiments');
  expect(fs.readFileSync(path.resolve(f.root,f.held.response.path)).equals(oldResponse)).toBe(true);
  expect(await resolveInternalProductBlock(f.control,f.task)).toBe(false);expect(f.calls()).toBe(1);
});

test('a changed candidate or stale confirmed response cannot be rerouted',async t=>{
  const f=fixture(t);fs.appendFileSync(path.join(f.candidate,'scripts/experiment.mjs'),'// altered');
  await expect(resolveInternalProductBlock(f.control,f.task)).rejects.toThrow(/binding changed/);expect(f.calls()).toBe(0);expect(f.row.status).toBe('blocked');
});

test('mutating an original confirmed response preserves the block and never dispatches a resolution',async t=>{
  const f=fixture(t);fs.appendFileSync(path.resolve(f.root,f.held.response.path),' ');
  await expect(resolveInternalProductBlock(f.control,f.task)).rejects.toThrow(/Evidence bytes changed/);expect(f.calls()).toBe(0);expect(f.row.status).toBe('blocked');
});

test('a resolution for a different task cannot reach the scheduler',async t=>{
  const f=fixture(t);f.setAction({taskId:'15-13'});
  await expect(resolveInternalProductBlock(f.control,f.task)).rejects.toThrow(/task scope/);expect(f.row.status).toBe('blocked');expect(f.state.productBlockedHandoff).toEqual(f.held);
});

test('a supervisor resolution cannot revoke an already accepted descendant from a BLOCKED claim',async t=>{
  const f=fixture(t);f.state.tasks['15-16']={status:'pass',acceptedTarget:{targetId:'accepted'},verification:'original-verdict'};
  await expect(resolveInternalProductBlock(f.control,f.task)).rejects.toThrow(/cannot invalidate accepted work/);
  expect(f.state.tasks['15-16'].status).toBe('pass');expect(f.row.status).toBe('blocked');expect(f.row.failures).toBe(1);
});

test('real external input and explicit user stop remain protected from internal recovery',async t=>{
  const f=fixture(t);f.state.requiredUserInput={kind:'external_credentials',external:true,taskIds:[f.task.id]};
  expect(await resolveInternalProductBlock(f.control,f.task)).toBe(false);expect(automaticRecovery(f.state,{taskVerificationMode:'controller-vitest'})).toBe(false);
  delete f.state.requiredUserInput;atomicJSON(path.join(f.directory,'stop.json'),{reason:'user stop'});
  await expect(resolveInternalProductBlock(f.control,f.task)).rejects.toThrow(/controller stopped/);expect(f.calls()).toBe(0);
});

test('internal missing artifacts cannot be relabeled as an unspecified user-input wait',async t=>{
  const f=fixture(t);f.setAction({action:'request_input',inputKind:'policy_decision',question:'Please complete the missing internal reports'});
  await expect(resolveInternalProductBlock(f.control,f.task)).rejects.toThrow(/cannot become unspecified external input/);expect(f.state.requiredUserInput).toBeUndefined();
});

test('an actual protected policy question has an explicit owner, question and authenticated evidence',async t=>{
  const f=fixture(t);f.setAction({action:'request_input',classification:'scope_conflict',inputKind:'policy_decision',question:'Which explicitly conflicting protected policy should take precedence?'});
  await expect(resolveInternalProductBlock(f.control,f.task)).rejects.toThrow(/protected policy/);
  expect(f.state.status).toBe('waiting_input');expect(f.state.requiredUserInput.evidence.sha256).toHaveLength(64);expect(f.state.requiredUserInput.decision.sha256).toHaveLength(64);
});

test('task 14 completes original comparisons and diagnostic outputs without turning whole-REVIEW policy eligibility into an output prerequisite',()=>{
  const task=readTaskPlan().tasks.find(t=>t.id==='15-14'),contract=taskContract(task,'B'),assignment=deterministicAssignment(task,'B','candidate','inputs.json',contract);
  expect(assignment.instructions).toContain('not reasons to omit required outputs');expect(assignment.instructions).toContain('unchanged acceptance assertions');expect(assignment.instructions).toContain('does not select or approve');
  expect(taskContract(task,'B')).toEqual(contract);expect(PRODUCT_BLOCK_RESOLUTION_SCHEMA.properties.action.enum).not.toContain('pass');
});
