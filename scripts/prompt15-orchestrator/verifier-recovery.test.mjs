import {test,expect,onTestFinished} from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {readVerifierRecovery,captureEnvironmentEvidence} from './verifier-recovery.mjs';
import {TaskWorkflow} from './task-workflow.mjs';
import {captureProductTarget} from './product-target.mjs';
import {atomicJSON,fileIdentity,validateVerification,TASK_GATES} from './protocol.mjs';
import {identity} from './verification-stages.mjs';
import {guardianSnapshot} from './task-guardian.mjs';

async function fixture(){
  const base=path.resolve('.tmp/verifier-recovery-tests');fs.mkdirSync(base,{recursive:true});const root=fs.mkdtempSync(path.join(base,'case-')),directory=path.join(root,'reports/run'),attempt=path.join(directory,'tasks/15-01/attempt-002'),oldReport=path.join(attempt,'verification-vitest-001'),report=path.join(attempt,'verification-vitest-002'),candidate=path.join(attempt,'candidate');
  onTestFinished(()=>{expect(root.startsWith(base+path.sep)).toBe(true);fs.rmSync(root,{recursive:true,force:true});});
  fs.mkdirSync(path.join(candidate,'src'),{recursive:true});fs.writeFileSync(path.join(candidate,'package.json'),'{}');fs.writeFileSync(path.join(candidate,'src/base.txt'),'immutable');fs.mkdirSync(oldReport);fs.mkdirSync(report);
  const target=captureProductTarget(root,candidate,path.join(attempt,'target'),{review:'A'}),state={runId:'run',review:'A',activeTurns:{},repairAttempts:0,tasks:{'15-01':{status:'verifying',attempt:2,attemptDirectory:attempt,target}},pendingExecutionIncident:{path:'retained-incident.json',sha256:'old',byteLength:1}};
  const blocked={cwd:candidate,result:{taskId:'15-01',targetId:target.targetId,verdict:'blocked',nonPassKind:'environment'}};atomicJSON(path.join(oldReport,'response.json'),blocked);
  const context={root,reportDirectory:path.relative(root,report),productRoot:candidate,productTarget:target,verificationFramework:'vitest'};atomicJSON(path.join(report,'job-context.json'),context);
  const suite=path.join(report,'actual.test.mjs');fs.writeFileSync(suite,"import {test,expect} from 'vitest';test('condition',()=>expect(true).toBe(true));");
  const output=path.join(report,'sandbox-vitest');fs.mkdirSync(output);const counts={passed:1,failed:0,skipped:0,pending:0,total:1,errors:0};
  atomicJSON(path.join(output,'result.json'),{kind:'vitest-bound-target',pass:true,inputsUnchanged:true,allFilesExecuted:true,targetId:target.targetId,productRoot:candidate,temporaryDirectory:path.join(output,'temp'),tests:{complete:true,counts}});atomicJSON(path.join(output,'test-inputs.json'),{inputs:[await identity(suite)]});
  const check=path.join(directory,'control-checks.json');atomicJSON(check,{kind:'vitest',pass:true,inputsUnchanged:true,allFilesExecuted:true,tests:{complete:true,counts}});
  const proofFile=path.join(directory,'proof.json'),readyFile=path.join(directory,'control/environment-recovery-ready.json');
  const proof={kind:'windows-verifier-environment-recovery',pass:true,runId:'run',taskId:'15-01',attempt:2,targetId:target.targetId,productRoot:candidate,oldRevision:'vitest-001',newRevision:'vitest-002',oldResponse:fileIdentity(root,path.join(oldReport,'response.json')),newContext:fileIdentity(root,path.join(report,'job-context.json')),test:fileIdentity(root,suite),vitestResult:fileIdentity(root,path.join(output,'result.json')),testInputs:fileIdentity(root,path.join(output,'test-inputs.json')),policyUnchanged:true,policy:{type:'workspaceWrite',writableRoots:[report],networkAccess:true,excludeTmpdirEnvVar:true,excludeSlashTmp:true},execution:{exitCode:0}};
  const ready={evidence:null,inputs:[],checks:[fileIdentity(root,check)]};
  const save=()=>{atomicJSON(proofFile,proof);ready.evidence=fileIdentity(root,proofFile);atomicJSON(readyFile,ready);};save();
  return{root,directory,state,oldReport,report,proof,ready,readyFile,suite,blocked,save};
}

test('exact successful sandbox Vitest proof proposes a new report without changing product state',async()=>{
  const f=await fixture(),before=structuredClone(f.state),plan=await readVerifierRecovery(f.root,f.directory,f.state);expect(plan.revision).toBe('vitest-002');expect(plan.row).toBe(f.state.tasks['15-01']);expect(f.state).toEqual(before);
});

test('a broader sandbox policy cannot be used as environment recovery',async()=>{
  const f=await fixture();f.proof.policy.writableRoots=[f.root];f.save();await expect(readVerifierRecovery(f.root,f.directory,f.state)).rejects.toThrow('same sandbox restrictions');
});

test('product failures cannot be relabelled as environment recovery',async()=>{
  const f=await fixture();f.blocked.result.verdict='fail';f.blocked.result.nonPassKind='implementation';atomicJSON(path.join(f.oldReport,'response.json'),f.blocked);f.proof.oldResponse=fileIdentity(f.root,path.join(f.oldReport,'response.json'));f.save();await expect(readVerifierRecovery(f.root,f.directory,f.state)).rejects.toThrow('environment BLOCKED');
});

test('changed tests invalidate the recovery evidence',async()=>{
  const f=await fixture();fs.appendFileSync(f.suite,'// changed');await expect(readVerifierRecovery(f.root,f.directory,f.state)).rejects.toThrow('bytes changed');
});

test('new report cannot overwrite an uncertain dispatch',async()=>{
  const f=await fixture();atomicJSON(path.join(f.report,'dispatch.json'),{});await expect(readVerifierRecovery(f.root,f.directory,f.state)).rejects.toThrow('existing dispatch');
});

test('an already applied recovery is idempotent after later operating code changes',async()=>{
  const f=await fixture();f.state.tasks['15-01'].environmentRecoveryHistory=[{evidence:f.ready.evidence}];f.ready.inputs=[{path:'later-missing-input',sha256:'old',byteLength:1}];atomicJSON(f.readyFile,f.ready);expect(await readVerifierRecovery(f.root,f.directory,f.state)).toBeNull();
});

test('controller resumes only after guardian approval and preserves the old incident and product counters',async()=>{
  const f=await fixture(),audits=[],control=Object.assign(Object.create(TaskWorkflow.prototype),{root:f.root,directory:f.directory,state:f.state,async audit(phase,extra){audits.push({phase,extra});expect(f.state.tasks['15-01'].verificationRevision).toBeUndefined();},save(){},event(){}});
  expect(await control.restoreVerifierEnvironment()).toBe(true);expect(audits[0].phase).toBe('environment_recovery');expect(f.state.tasks['15-01']).toMatchObject({status:'verifying',attempt:2,verificationRevision:'vitest-002'});expect(f.state.repairAttempts).toBe(0);expect(f.state.pendingExecutionIncident).toBeUndefined();expect(f.state.resolvedExecutionIncidents[0].incident.path).toBe('retained-incident.json');expect(fs.existsSync(path.join(f.oldReport,'response.json'))).toBe(true);expect(await control.restoreVerifierEnvironment()).toBe(false);
});

test('guardian rejection keeps the exact blocked task and incident',async()=>{
  const f=await fixture(),before=structuredClone(f.state),control=Object.assign(Object.create(TaskWorkflow.prototype),{root:f.root,directory:f.directory,state:f.state,async audit(){throw Error('guardian hold');},save(){},event(){}});await expect(control.restoreVerifierEnvironment()).rejects.toThrow('guardian hold');expect(f.state).toEqual(before);
});

test('environment recovery audit binds the task candidate rather than the review workspace',async()=>{
  const f=await fixture();f.state.currentTasks=['15-01'];f.state.certificates={};f.state.reviewWorkspace={directory:path.join(f.root,'other-review-workspace')};let snapshot;
  const control=Object.assign(Object.create(TaskWorkflow.prototype),{root:f.root,directory:f.directory,state:f.state,oversight:{async poll(){},async applyPendingRepair(){}},ensureRunning(){},save(){},guardian:{async inspect(value){snapshot=value;return{decision:'continue'};}}});
  await control.audit('environment_recovery');expect(snapshot.productRoot).toBe(f.state.tasks['15-01'].target.productRoot);expect(snapshot.targetId).toBe(f.state.tasks['15-01'].target.targetId);
});

test('recovery evidence survives the real guardian allowlist and secret filter',async()=>{
  const f=await fixture();f.state.currentTasks=['15-01'];f.state.certificates={};let delivered;
  const control=Object.assign(Object.create(TaskWorkflow.prototype),{root:f.root,directory:f.directory,state:f.state,oversight:{async poll(){},async applyPendingRepair(){}},ensureRunning(){},save(){},event(){},guardian:{async inspect(snapshot){delivered=guardianSnapshot(snapshot);return{decision:'continue'};}}});
  expect(await control.restoreVerifierEnvironment()).toBe(true);expect(delivered.commandEvidence.recoveryReceipt.sha256).toBe(fileIdentity(f.root,f.readyFile).sha256);expect(guardianSnapshot({environment:{secret:'do not pass'}})).toEqual({});
});

test('controller can attest an environment error while retaining BLOCKED and the original response',async()=>{
  const f=await fixture(),error=path.join(f.oldReport,'error.json');atomicJSON(error,{error:'sandbox setup failed'});
  const native={review:'A',verdict:'blocked',nonPassKind:'environment',summary:'could not execute',checks:TASK_GATES.map(id=>({id,status:'blocked',evidencePaths:[error],detail:'not executed'})),inputs:[],evidence:[],commands:[{command:'read candidate',exitCode:null,evidencePath:error}],failures:['sandbox setup failed']};atomicJSON(path.join(f.oldReport,'response.json'),{result:native});const bytes=fs.readFileSync(path.join(f.oldReport,'response.json'),'utf8');
  const result=captureEnvironmentEvidence(f.root,f.oldReport,native);expect(()=>validateVerification(f.root,f.oldReport,'A',result,TASK_GATES)).not.toThrow();expect(result.verdict).toBe('blocked');expect(native.evidence).toHaveLength(0);expect(fs.readFileSync(path.join(f.oldReport,'response.json'),'utf8')).toBe(bytes);
});

test('environment capture cannot attest a reference outside its report',async()=>{
  const f=await fixture();await expect(async()=>captureEnvironmentEvidence(f.root,f.oldReport,{verdict:'blocked',nonPassKind:'environment',checks:[{evidencePaths:[path.join(f.root,'private.txt')]}],commands:[],evidence:[]})).rejects.toThrow('stay in the verifier report');
});
