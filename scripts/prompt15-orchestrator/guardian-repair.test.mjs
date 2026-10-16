// Canonical Vitest suite; test bodies and assertions retained from the prior control suite.
import fs from 'node:fs';
import path from 'node:path';
import {test as vitestTest} from 'vitest';
const test=(name,body)=>vitestTest(name,context=>body({after:fn=>context.onTestFinished(fn)}),600000);
import assert from 'node:assert/strict';
import {GuardianControllerRepair,REPAIR_SCHEMA,REPAIR_TESTS,REPAIR_ENGINE_VERSION} from './guardian-repair.mjs';
import {fileIdentity} from './protocol.mjs';

function fixture(t,options={}){
  const base=path.resolve('.tmp/guardian-repair-tests');fs.mkdirSync(base,{recursive:true});const root=fs.mkdtempSync(path.join(base,'case-')),directory=path.join(root,'reports/run'),scripts=path.join(root,'scripts/prompt15-orchestrator');fs.mkdirSync(scripts,{recursive:true});fs.mkdirSync(directory,{recursive:true});
  fs.writeFileSync(path.join(scripts,'task-workflow.mjs'),'export const value=1;\n');fs.writeFileSync(path.join(scripts,'protocol.mjs'),'export const protectedValue=1;\n');fs.copyFileSync(new URL('./compact-vitest-reporter.mjs',import.meta.url),path.join(scripts,'compact-vitest-reporter.mjs'));
  const testCode=`import {test,expect} from 'vitest';import {value} from './task-workflow.mjs';test('actual repair behavior',()=>expect(value).toBe(2));\n`;
  for(const name of REPAIR_TESTS)fs.writeFileSync(path.join(root,name),testCode);
  const state={guardian:{threadId:'guardian-original'},activeTurns:{},currentTasks:['15-01'],tasks:{'15-01':{status:'implemented',attempt:2}}};
  const file=path.join(directory,'original-audit.json');fs.writeFileSync(file,JSON.stringify({auditId:'audit-5',guardianThreadId:'guardian-original',phase:'implementation_handoff',result:{decision:'hold',reason:'reproduced progress defect',recovery:{action:'repair_controller',reason:'Fix actual control code, preserve implementation'}}}));const auditIdentity=fileIdentity(root,file);
  const server={calls:0,async request(method,params){if(method==='thread/name/set')return{};assert.equal(method,'thread/start');assert.ok(params.developerInstructions.includes('task-workflow.mjs'));return{thread:{id:'repair-worker'}};},async runTurn(threadId,prompt,schema,overrides){this.calls++;assert.equal(schema,REPAIR_SCHEMA);assert.equal(threadId,'repair-worker');assert.equal(state.guardian.threadId,'guardian-original');assert.deepEqual(overrides.sandboxPolicy.writableRoots,[overrides.cwd]);assert.notEqual(overrides.cwd,root);
    fs.writeFileSync(path.join(overrides.cwd,'scripts/prompt15-orchestrator/task-workflow.mjs'),`export const value=${options.fail?1:2};\n// repair attempt ${this.calls}\n`);
    const changedFiles=['scripts/prompt15-orchestrator/task-workflow.mjs'];
    if(options.protected){fs.appendFileSync(path.join(overrides.cwd,options.protected),'\n// forbidden edit');changedFiles.push(options.protected);}
    if(options.concurrent)fs.appendFileSync(path.join(scripts,'task-workflow.mjs'),'\n// concurrent owner');
    if(options.stop)fs.writeFileSync(path.join(directory,'stop.json'),'{}');
    return{turnId:'repair-'+this.calls,value:{status:'repaired',summary:'fixed control behavior',changedFiles:options.undeclared?[]:changedFiles,reason:'actual patch'}};
  }};
  const repairer=new GuardianControllerRepair({root,directory,state,config:{roles:{guardian:{}}},server});
  t.after(()=>{assert.ok(root.startsWith(base+path.sep));fs.rmSync(root,{recursive:true,force:true});});return{root,directory,scripts,state,server,repairer,args:{auditIdentity,phase:'implementation_handoff'}};
}
test('guardian actually repairs operating code, fixed regressions run, original incident and completed task remain intact',async t=>{
  const f=fixture(t),before=JSON.stringify(f.state.tasks),result=await f.repairer.repair(f.args);assert.equal(result.status,'applied');assert.match(fs.readFileSync(path.join(f.scripts,'task-workflow.mjs'),'utf8'),/value=2/);assert.equal(JSON.stringify(f.state.tasks),before);
  const receipt=JSON.parse(fs.readFileSync(path.resolve(f.root,result.receiptIdentity.path),'utf8'));assert.equal(receipt.attempts[0].passed,true);assert.equal(receipt.attempts[0].tests.counts.passed,REPAIR_TESTS.length);assert.ok(receipt.attempts[0].execution.stdout.byteLength<=256*1024);assert.equal(receipt.sourceAudit.sha256,f.args.auditIdentity.sha256);
  await f.repairer.repair(f.args);assert.equal(f.server.calls,1,'applied incident must not be repaired twice');
});
test('failed repair checks cannot merge and automatic correction is bounded to two turns',async t=>{
  const f=fixture(t,{fail:true}),result=await f.repairer.repair(f.args);assert.equal(result.status,'blocked');assert.match(fs.readFileSync(path.join(f.scripts,'task-workflow.mjs'),'utf8'),/value=1/);assert.equal(f.server.calls,2);
});
for(const protectedFile of ['scripts/prompt15-orchestrator/protocol.mjs','scripts/prompt15-orchestrator/task-progress.test.mjs'])test(`repair cannot change protected authority or its fixed test: ${protectedFile}`,async t=>{
  const f=fixture(t,{protected:protectedFile}),result=await f.repairer.repair(f.args);assert.equal(result.status,'blocked');assert.match(result.summary,/protected/);assert.match(fs.readFileSync(path.join(f.scripts,'task-workflow.mjs'),'utf8'),/value=1/);
});
for(const flag of ['concurrent','stop','undeclared'])test(`repair does not merge after ${flag}`,async t=>{
  const f=fixture(t,{[flag]:true}),result=await f.repairer.repair(f.args);assert.equal(result.status,'blocked');assert.doesNotMatch(fs.readFileSync(path.join(f.scripts,'task-workflow.mjs'),'utf8'),/value=2/);
});
test('an active product turn prevents dispatching an operating repair',async t=>{
  const f=fixture(t);f.state.activeTurns.implementer={taskId:'15-01'};await assert.rejects(f.repairer.repair(f.args),/stopped product handoff/);assert.equal(f.server.calls,0);
});

test('repair admission stays reserved while an existing supervisor audit drains and is released on failure',async t=>{
  const f=fixture(t);f.repairer.waitForAudit=async()=>{assert.equal(f.repairer.busy,true);throw Error('bounded audit drain failure');};
  await assert.rejects(f.repairer.repair(f.args),/bounded audit drain failure/);
  assert.equal(f.repairer.busy,false);assert.equal(f.server.calls,0);
});

test('a confirmed supervisor authorization fences off a racing older guardian repair',async t=>{
  const f=fixture(t);f.state.supervisorOversight={pendingRepairIdentity:{path:'supervisor-incident.json',sha256:'new-supervisor-owner'}};
  await assert.rejects(f.repairer.repair(f.args),error=>error.code==='SUPERVISOR_RECONCILE'&&error.guardianHandled===true);
  assert.equal(f.server.calls,0);assert.equal(fs.existsSync(path.join(f.directory,'control/operating-repair-owner.json')),false);
});
test('a corrected worker binding can repair a prior blocked engine while preserving the old failure receipt',async t=>{
  const f=fixture(t),file=path.join(f.directory,'old-repair.json');fs.writeFileSync(file,JSON.stringify({status:'blocked',reason:'old audit-only developer contract'}));
  const old={status:'blocked',engineVersion:1,sourceAudit:f.args.auditIdentity,receiptIdentity:fileIdentity(f.root,file)};f.state.guardian.lastControllerRepair=old;
  const result=await f.repairer.repair(f.args);assert.equal(result.status,'applied');assert.equal(result.engineVersion,REPAIR_ENGINE_VERSION);assert.deepEqual(f.state.guardian.controllerRepairHistory,[old]);assert.equal(fileIdentity(f.root,file).sha256,old.receiptIdentity.sha256);assert.equal(f.state.guardian.threadId,'guardian-original');assert.equal(f.state.guardian.repairThreadId,'repair-worker');
});

for(const status of ['completed','interrupted','failed'])test(`a restarted repair reconciles its exact ${status} native turn before clearing stale ownership`,async t=>{
  const f=fixture(t),id='repair-audit-5-original',directory=path.join(f.directory,'guardian/repairs',id),mirror=path.join(directory,'mirror');fs.mkdirSync(mirror,{recursive:true});
  fs.writeFileSync(path.join(directory,'request-1.json'),JSON.stringify({threadId:'old-worker',mirror,sourceAudit:f.args.auditIdentity,prompt:'original repair assignment'}));
  f.state.guardian.activeRepairId=id;f.state.guardian.activeAuditId=id;f.state.activeTurns['guardian-repair']={threadId:'old-worker',turnId:'exact-old-turn',runningCommands:{old:{}}};
  const tasks=JSON.stringify(f.state.tasks);f.server.request=async(method,params)=>{assert.equal(params.threadId,'old-worker');return method==='thread/resume'?{}:{thread:{id:'old-worker',turns:[{id:'exact-old-turn',status,items:status==='completed'?[{type:'agentMessage',phase:'final',text:'{"status":"repaired"}'}]:[]}]}};};
  const receipt=await f.repairer.reconcilePending();assert.ok(receipt.sha256);assert.deepEqual(f.state.activeTurns,{});assert.equal(f.state.guardian.activeRepairId,undefined);assert.equal(f.server.calls,0);assert.equal(JSON.stringify(f.state.tasks),tasks);
  assert.equal(fs.readFileSync(path.join(f.scripts,'task-workflow.mjs'),'utf8'),'export const value=1;\n');
  const proof=JSON.parse(fs.readFileSync(path.resolve(f.root,receipt.path)));assert.equal(proof.status,status);assert.equal(proof.applied,false);assert.equal(proof.turnId,'exact-old-turn');assert.ok(fs.existsSync(path.join(directory,'request-1.json')));
  assert.equal(await f.repairer.reconcilePending(),null);assert.equal(f.state.guardian.interruptedRepairHistory.length,1);
});

test('an unknown or still-running repair cannot be erased or replaced by a new worker',async t=>{
  const f=fixture(t),id='repair-audit-5-unconfirmed',directory=path.join(f.directory,'guardian/repairs',id),mirror=path.join(directory,'mirror');fs.mkdirSync(mirror,{recursive:true});
  fs.writeFileSync(path.join(directory,'request-1.json'),JSON.stringify({threadId:'old-worker',mirror,sourceAudit:f.args.auditIdentity}));
  f.state.guardian.activeRepairId=id;f.state.activeTurns['guardian-repair']={threadId:'old-worker',turnId:'exact-old-turn'};
  f.server.request=async(method)=>method==='thread/resume'?{}:{thread:{id:'old-worker',turns:[{id:'another-turn',status:'completed'}]}};
  await assert.rejects(f.repairer.repair(f.args),/absent from native history/);assert.equal(f.server.calls,0);assert.equal(f.state.activeTurns['guardian-repair'].turnId,'exact-old-turn');
});

for(const scenario of ['unique-running','no-native-turn','ambiguous','unrelated-running'])test(`lost repair acknowledgement: ${scenario} uses authenticated request matching without accepting an unchecked patch`,async t=>{
  const f=fixture(t),id='repair-audit-5-lost',directory=path.join(f.directory,'guardian/repairs',id),mirror=path.join(directory,'mirror');fs.mkdirSync(mirror,{recursive:true});
  const request=path.join(directory,'request-1.json');fs.writeFileSync(request,JSON.stringify({threadId:'old-worker',mirror,sourceAudit:f.args.auditIdentity,prompt:'exact mutating repair request'}));
  const dispatchFile=path.join(directory,'dispatch-1.json');fs.writeFileSync(dispatchFile,JSON.stringify({threadId:'old-worker',cwd:mirror,requestIdentity:fileIdentity(f.root,request)}));
  f.state.guardian.activeRepairId=id;f.state.activeTurns['guardian-repair']={threadId:'old-worker',dispatchFile};
  const owned={id:'owned-turn',status:'inProgress',items:[{type:'userMessage',content:[{type:'text',text:'exact mutating repair request'}]}]};
  const turns=scenario==='unique-running'?[owned]:scenario==='ambiguous'?[owned,{...owned,id:'duplicate'}]:scenario==='unrelated-running'?[{id:'unrelated',status:'inProgress'}]:[];
  const interrupts=[];f.server.request=async(method,params)=>{
    if(method==='thread/resume')return{};
    if(method==='turn/interrupt'){interrupts.push(params.turnId);turns.find(turn=>turn.id===params.turnId).status='interrupted';return{};}
    return{thread:{id:'old-worker',turns}};
  };
  if(['ambiguous','unrelated-running'].includes(scenario)){
    await assert.rejects(f.repairer.reconcilePending(),/ambiguous|unrelated active/);assert.equal(f.state.guardian.activeRepairId,id);assert.deepEqual(interrupts,[]);
  }else{
    const receipt=await f.repairer.reconcilePending(),proof=JSON.parse(fs.readFileSync(path.resolve(f.root,receipt.path)));
    assert.equal(proof.applied,false);assert.equal(proof.turnId,scenario==='unique-running'?'owned-turn':null);assert.equal(proof.status,scenario==='unique-running'?'interrupted':'no-active-native-turn');
    assert.deepEqual(interrupts,scenario==='unique-running'?['owned-turn']:[]);assert.equal(f.state.guardian.activeRepairId,undefined);assert.equal(f.server.calls,0);
  }
  assert.equal(fs.readFileSync(path.join(f.scripts,'task-workflow.mjs'),'utf8'),'export const value=1;\n');
});
