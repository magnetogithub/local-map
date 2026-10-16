import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import test from 'node:test';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {TaskGuardian,GUARDIAN_RULE_FILES,GUARDIAN_SCHEMA,guardianSnapshot} from './task-guardian.mjs';

const workspace=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const tempBase=path.join(workspace,'.tmp','task-guardian-tests');fs.mkdirSync(tempBase,{recursive:true});
function fixture(t,execute=async()=>({decision:'continue',summary:'Operating handoff verified',ruleChanges:[],reason:'Actual identities match'})){
  const root=fs.mkdtempSync(path.join(tempBase,'case-'));
  t.after(()=>{assert.ok(root.startsWith(tempBase+path.sep));fs.rmSync(root,{recursive:true,force:true});});
  function write(name,body){const file=path.join(root,name);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,body);}
  for(const name of GUARDIAN_RULE_FILES)write(name,`Operating rules: ${name}\n`);
  write('automation/prompt15/config.json','{"executionMode":"orchestrated"}\n');write('automation/prompt15/task-plan.json','{"tasks":48}\n');
  write('prompts/prompt15.txt','PRODUCT FUNCTIONAL SPEC SENTINEL - MUST NOT ENTER GUARDIAN THREAD');write('scripts/prompt15-orchestrator/protocol.mjs','export const GATES=["protected"];\n');
  write('candidate/src/actual.ts','export const product=41;\n');write('candidate/package.json','{"private":true}\n');
  const requests=[],turns=[],state={runId:'guardian-fixture',productRoot:path.join(root,'candidate')};
  const server={async request(method,params){requests.push({method,params});if(method==='thread/start')return{thread:{id:'independent-guardian-thread'}};if(method==='thread/resume')return{thread:{id:params.threadId}};return{};},
    async runTurn(threadId,input,schema,overrides,options){turns.push({threadId,input,schema,overrides,options});return{turnId:`confirmed-guardian-turn-${turns.length}`,value:await execute({root,threadId,input,schema,overrides,options,write,state})};}};
  const config={promptPath:'prompts/prompt15.txt',approvalPolicy:'on-request',approvalsReviewer:'auto_review',roles:{supervisor:{model:'existing-model',effort:'high'}}};
  const directory=path.join(root,'reports/run');fs.mkdirSync(directory,{recursive:true});let saves=0;
  const args={root,directory,config,server,state,save:()=>saves++};
  return{root,state,requests,turns,args,write,guardian:new TaskGuardian(args),snapshot:{taskId:'15-01',review:'A',productRoot:state.productRoot,phase:'handoff',targetId:'candidate-41'},get saves(){return saves;}};
}

function identity(file){const bytes=fs.readFileSync(file);return{path:file,sha256:createHash('sha256').update(bytes).digest('hex'),byteLength:bytes.length};}
function addBlockedHandoff(f,{blockerKind='operating_handoff',issues=['Missing operating comparison manifest'],nonPassKind='environment'}={}){
  const at='reports/run/tasks/15-01/attempt-001/';
  const files={assignmentIdentity:at+'assignment/response.json',requestIdentity:at+'implementation/request.json',confirmedResponseIdentity:at+'implementation/response.json',inputManifestIdentity:at+'input-manifest.json'};
  f.write(files.assignmentIdentity,'{"taskId":"15-01","action":"implement"}\n');f.write(files.requestIdentity,'{"taskId":"15-01","cwd":"candidate"}\n');
  f.write(files.confirmedResponseIdentity,JSON.stringify({turnId:'confirmed-blocked-turn',result:{taskId:'15-01',status:'blocked',nonPassKind,remainingIssues:issues,summary:'Actual handoff did not provide an operating comparison manifest'}})+'\n');
  f.write(files.inputManifestIdentity,'{"version":1,"inputs":[]}\n');
  f.write('reports/run/control/repair-ready.json','{"controlChecksPassed":true,"productUnchanged":true}\n');f.write('reports/run/control/repair-input-context.json','{"approvedBaseline":"candidate","comparisonBasis":"immutable-source-manifest"}\n');
  const blocked={taskId:'15-01',status:'blocked',blockerKind,nonPassKind,remainingIssues:issues,...Object.fromEntries(Object.entries(files).map(([key,name])=>[key,identity(path.join(f.root,name))])),artifactIdentities:[],repairEvidenceIdentities:['repair-ready.json','repair-input-context.json'].map(name=>identity(path.join(f.root,'reports/run/control',name)))};
  f.snapshot.blockedTask=blocked;return blocked;
}
function recoveryResult(f,overrides,{action='reassign_task',decision='reload',edit=true,evidence=true}={}){
  const rule=GUARDIAN_RULE_FILES[2];if(edit)fs.appendFileSync(path.join(overrides.cwd,rule),'Resolve operating input context before task implementation.\n');
  return{decision,summary:'Repair the blocked operating handoff',ruleChanges:edit?[rule]:[],reason:'Actual confirmed BLOCKED and operating repair evidence were reviewed',recovery:{action,taskId:'15-01',evidencePaths:evidence?[f.snapshot.blockedTask.confirmedResponseIdentity.path,...f.snapshot.blockedTask.repairEvidenceIdentities.map(pin=>pin.path),...(edit?[path.join(overrides.cwd,rule)]:[])]:[],reason:'Recorded controller checks and supplied comparison context resolve the original operating blocker'}};
}

test('guardian is an independent persistent operating thread with isolated rule writes and pinned actual output',async t=>{
  const f=fixture(t);
  assert.equal((await f.guardian.inspect(f.snapshot,{phase:'launch'})).decision,'continue');
  assert.equal((await f.guardian.inspect(f.snapshot)).decision,'continue');
  assert.equal(f.requests.filter(request=>request.method==='thread/start').length,1);
  assert.equal(f.requests.find(request=>request.method==='thread/start').params.model,'existing-model');
  assert.ok(f.requests.find(request=>request.method==='thread/start').params.developerInstructions.includes('운영 감사'));
  for(const turn of f.turns){assert.equal(turn.threadId,'independent-guardian-thread');assert.deepEqual(turn.overrides.sandboxPolicy.writableRoots,[turn.overrides.cwd]);assert.ok(turn.overrides.cwd.startsWith(path.join(f.args.directory,'guardian','audits')));assert.equal(turn.overrides.sandboxPolicy.networkAccess,false);assert.ok(!turn.input.includes('PRODUCT FUNCTIONAL SPEC SENTINEL'));}
  const pin=f.state.guardian.lastAuditIdentity,bytes=fs.readFileSync(pin.path);assert.equal(pin.sha256,createHash('sha256').update(bytes).digest('hex'));assert.equal(pin.byteLength,bytes.length);
  const receipt=JSON.parse(bytes),response=JSON.parse(fs.readFileSync(receipt.responseIdentity.path,'utf8'));
  const context=JSON.parse(fs.readFileSync(path.join(path.dirname(pin.path),'audit-context.json'),'utf8'));
  assert.equal(context.runDirectory,f.args.directory);assert.equal(context.controlRoot,f.root);assert.equal(context.runStatePath,path.join(f.args.directory,'state.json'));assert.equal(context.agentsPath,path.join(f.root,'AGENTS.md'));assert.equal(context.guardianThreadId,'independent-guardian-thread');
  assert.equal(response.turnId,'confirmed-guardian-turn-2');assert.equal(response.requestIdentity.sha256,receipt.requestIdentity.sha256);
  const responseBytes=fs.readFileSync(receipt.responseIdentity.path);assert.equal(receipt.responseIdentity.sha256,createHash('sha256').update(responseBytes).digest('hex'));
  assert.equal(response.result.recovery,undefined,'legacy original output is preserved');
  const normalized=JSON.parse(fs.readFileSync(receipt.normalizedResponseIdentity.path,'utf8'));assert.equal(normalized.result.recovery.action,'none');
  assert.ok(GUARDIAN_SCHEMA.required.includes('recovery'),'native model responses require the explicit recovery field');
  assert.equal(f.state.guardian.lastDecision,'continue');assert.ok(f.saves>0);
  const resumed=new TaskGuardian(f.args);assert.equal((await resumed.inspect(f.snapshot)).decision,'continue');
  assert.equal(f.requests.filter(request=>request.method==='thread/start').length,1);assert.equal(f.requests.filter(request=>request.method==='thread/resume').length,1);
});

test('allowed mirror rule edit is diff checked, backed up and merged with reload',async t=>{
  const changed=GUARDIAN_RULE_FILES[2];const f=fixture(t,async({overrides})=>{fs.appendFileSync(path.join(overrides.cwd,changed),'Require confirmed task target before handoff.\n');return{decision:'reload',summary:'Fixed operating rule',ruleChanges:[changed],reason:'Reproduced missing handoff check'};});
  const baseline=fs.readFileSync(path.join(f.root,changed),'utf8'),result=await f.guardian.inspect(f.snapshot);
  assert.equal(result.decision,'reload');assert.deepEqual(result.ruleChanges,[changed]);assert.match(fs.readFileSync(path.join(f.root,changed),'utf8'),/confirmed task target/);
  const auditDir=path.dirname(f.state.guardian.incidentPath),patch=JSON.parse(fs.readFileSync(path.join(auditDir,'rule-patches.json'),'utf8')).patches[0];
  assert.equal(fs.readFileSync(patch.backup.path,'utf8'),baseline);assert.equal(patch.before.sha256,createHash('sha256').update(baseline).digest('hex'));
  assert.equal(fs.readFileSync(path.join(f.root,'candidate/src/actual.ts'),'utf8'),'export const product=41;\n');
});

test('protected task plan or product paths in output are refused without merging',async t=>{
  const f=fixture(t,async({overrides})=>{fs.appendFileSync(path.join(overrides.cwd,GUARDIAN_RULE_FILES[2]),'unauthorized accompanying edit');return{decision:'reload',summary:'Bad path',ruleChanges:['automation/prompt15/task-plan.json'],reason:'Forbidden'};});
  const before=fs.readFileSync(path.join(f.root,GUARDIAN_RULE_FILES[2]),'utf8');const result=await f.guardian.inspect(f.snapshot);
  assert.equal(result.decision,'hold');assert.match(result.reason,/unauthorized/);assert.equal(fs.readFileSync(path.join(f.root,GUARDIAN_RULE_FILES[2]),'utf8'),before);
});

test('undeclared file creation or mismatched ruleChanges is held and never merged',async t=>{
  for(const mode of ['extra','undeclared']){const f=fixture(t,async({overrides})=>{const file=mode==='extra'?'src/forbidden.ts':GUARDIAN_RULE_FILES[0];fs.mkdirSync(path.dirname(path.join(overrides.cwd,file)),{recursive:true});fs.appendFileSync(path.join(overrides.cwd,file),'bad write');return{decision:'continue',summary:'Claimed safe',ruleChanges:[],reason:'Claim'};});
    const before=fs.readFileSync(path.join(f.root,GUARDIAN_RULE_FILES[0]),'utf8');const result=await f.guardian.inspect(f.snapshot);assert.equal(result.decision,'hold');assert.match(result.reason,/outside|do not match/);assert.equal(fs.readFileSync(path.join(f.root,GUARDIAN_RULE_FILES[0]),'utf8'),before);}
});

test('concurrent rule modification is preserved and blocks mirror merge',async t=>{
  const name=GUARDIAN_RULE_FILES[2];const f=fixture(t,async({root,overrides})=>{fs.appendFileSync(path.join(overrides.cwd,name),'guardian edit');fs.appendFileSync(path.join(root,name),'concurrent owner edit');return{decision:'reload',summary:'Changed',ruleChanges:[name],reason:'Fix'};});
  const result=await f.guardian.inspect(f.snapshot);assert.equal(result.decision,'hold');assert.match(result.reason,/concurrently/);const body=fs.readFileSync(path.join(f.root,name),'utf8');assert.ok(body.endsWith('concurrent owner edit'));assert.ok(!body.includes('guardian edit'));
});

test('protected inputs changed by another writer invalidate the audit rather than claiming healthy',async t=>{
  const f=fixture(t,async({write})=>{write('candidate/src/actual.ts','export const product=42;\n');return{decision:'continue',summary:'Stale snapshot',ruleChanges:[],reason:'Stale'};});
  const result=await f.guardian.inspect(f.snapshot);assert.equal(result.decision,'hold');assert.match(result.reason,/protected input changed/);
});

test('missing confirmed turn, transport failure and malformed structured output each hold',async t=>{
  const f=fixture(t);f.args.server.runTurn=async()=>({value:{decision:'continue',summary:'No turn',ruleChanges:[],reason:'No confirmation'}});
  assert.match((await f.guardian.inspect(f.snapshot)).reason,/confirmed completed turn/);
  f.args.server.runTurn=async()=>{throw Error('Lost guardian transport');};assert.match((await f.guardian.inspect(f.snapshot)).reason,/Lost guardian transport/);
  f.args.server.runTurn=async()=>({turnId:'confirmed',value:{decision:'pass'}});assert.match((await f.guardian.inspect(f.snapshot)).reason,/structured result/);assert.equal(f.state.guardian.lastDecision,'hold');
});

test('audit snapshot excludes product prompts, raw events and credentials',()=>{
  const snapshot=guardianSnapshot({taskId:'15-01',sourceCode:'source',prompt:'functional prompt',instructions:'private',webhook:'secret',events:'unbounded',tasks:[{id:'15-02',status:'ready',apiKey:'hidden',reasoning:'hidden'}],reason:'Bearer abc https://discord.com/api/webhooks/1/token'});
  assert.deepEqual(snapshot.tasks,[{id:'15-02',status:'ready'}]);assert.equal(snapshot.taskId,'15-01');for(const key of ['sourceCode','prompt','instructions','webhook','events'])assert.equal(snapshot[key],undefined);assert.ok(!snapshot.reason.includes('abc'));assert.ok(!snapshot.reason.includes('/webhooks/'));
});

test('duplicate guardian inspection holds while original audit retains its single turn',async t=>{
  let finish;const pending=new Promise(resolve=>finish=resolve);const f=fixture(t,async()=>{await pending;return{decision:'continue',summary:'Complete',ruleChanges:[],reason:'Checked'};});
  const first=f.guardian.inspect(f.snapshot);while(!f.turns.length)await new Promise(resolve=>setTimeout(resolve,1));
  const second=await f.guardian.inspect(f.snapshot);assert.equal(second.decision,'hold');assert.match(second.reason,/active inspection/);finish();assert.equal((await first).decision,'continue');assert.equal(f.turns.length,1);
});

test('oversized rule writes and symlinked mirror directories are held without touching operating rules',async t=>{
  for(const mode of ['large','junction']){const f=fixture(t,async({root,overrides})=>{
    if(mode==='large')fs.writeFileSync(path.join(overrides.cwd,GUARDIAN_RULE_FILES[0]),Buffer.alloc(1024*1024+1));
    else{const docs=path.join(overrides.cwd,'docs');assert.ok(docs.startsWith(overrides.cwd+path.sep));fs.rmSync(docs,{recursive:true});fs.symlinkSync(path.join(root,'docs'),docs,'junction');}
    return{decision:'reload',summary:'Bad write boundary',ruleChanges:[GUARDIAN_RULE_FILES[0]],reason:'No'};});
    const original=fs.readFileSync(path.join(f.root,GUARDIAN_RULE_FILES[0]),'utf8'),result=await f.guardian.inspect(f.snapshot);
    assert.equal(result.decision,'hold');assert.match(result.reason,/byte budget|symlink/);assert.equal(fs.readFileSync(path.join(f.root,GUARDIAN_RULE_FILES[0]),'utf8'),original);
  }
});

test('state storage exceptions become a hold result instead of escaping inspect',async t=>{
  const f=fixture(t);f.guardian.save=()=>{throw Error('State storage unavailable');};
  const result=await f.guardian.inspect(f.snapshot);assert.equal(result.decision,'hold');assert.match(result.reason,/State storage unavailable/);
});

test('blocked handoff reaches guardian with preserved remaining issues and explicit input/output identities',async t=>{
  const f=fixture(t),blocked=addBlockedHandoff(f);blocked.rawEvents=['do not send'];blocked.apiKey='secret';
  const result=await f.guardian.inspect(f.snapshot,{phase:'implementation_blocked'});assert.equal(result.decision,'hold');assert.match(result.reason,/unresolved blocked task/);
  const context=JSON.parse(fs.readFileSync(path.join(path.dirname(f.state.guardian.lastAuditIdentity.path),'audit-context.json'),'utf8'));
  assert.deepEqual(context.snapshot.blockedTask.remainingIssues,blocked.remainingIssues);assert.deepEqual(context.snapshot.blockedTask.confirmedResponseIdentity,blocked.confirmedResponseIdentity);
  assert.equal(context.snapshot.blockedTask.apiKey,undefined);assert.equal(context.snapshot.blockedTask.rawEvents,undefined);assert.equal(context.blockedEvidenceIdentities.length,6);
});

test('confirmed assignment and verifier BLOCKED forms retain their original verdicts during operating recovery',async t=>{
  for(const mode of ['assignment','verifier']){let f;f=fixture(t,async({overrides})=>recoveryResult(f,overrides));const blocked=addBlockedHandoff(f),file=blocked.confirmedResponseIdentity.path,record=JSON.parse(fs.readFileSync(file,'utf8'));
    delete record.result.status;if(mode==='assignment')record.result.action='blocked';else record.result.verdict='blocked';fs.writeFileSync(file,JSON.stringify(record)+'\n');blocked.confirmedResponseIdentity=identity(file);
    const original=fs.readFileSync(file),result=await f.guardian.inspect(f.snapshot);assert.equal(result.decision,'reload',result.reason);assert.equal(result.recovery.action,'reassign_task');assert.deepEqual(fs.readFileSync(file),original);
  }
});

test('a rule repair plus actual blocked response and all operating repair evidence permits scoped reassignment',async t=>{
  let f;f=fixture(t,async({overrides})=>recoveryResult(f,overrides));const blocked=addBlockedHandoff(f),original=fs.readFileSync(blocked.confirmedResponseIdentity.path);
  const result=await f.guardian.inspect(f.snapshot,{phase:'implementation_blocked'});
  assert.equal(result.decision,'reload',result.reason);assert.equal(result.recovery.action,'reassign_task');assert.equal(result.recovery.taskId,'15-01');
  assert.deepEqual(fs.readFileSync(blocked.confirmedResponseIdentity.path),original,'original blocked report must remain intact');
  const receipt=JSON.parse(fs.readFileSync(f.state.guardian.lastAuditIdentity.path,'utf8')),proof=JSON.parse(fs.readFileSync(receipt.recoveryEvidenceIdentity.path,'utf8'));
  assert.equal(proof.action,'reassign_task');assert.equal(proof.evidence.length,4);assert.equal(proof.patches.length,1);
  assert.ok(proof.evidence.some(pin=>pin.kind==='rule-patch'));assert.equal(receipt.recoveryEvidenceIdentity.sha256,identity(receipt.recoveryEvidenceIdentity.path).sha256);
});

test('reassignment without actual rule edits, repair evidence, blocked citation or matching task is rejected',async t=>{
  for(const mode of ['no-rule','no-repair','no-blocked-citation','wrong-task']){
    let f;f=fixture(t,async({overrides})=>{const result=recoveryResult(f,overrides,{edit:mode!=='no-rule'});
      if(mode==='no-repair'){f.snapshot.blockedTask.repairEvidenceIdentities=[];result.recovery.evidencePaths=result.recovery.evidencePaths.filter(name=>!name.includes('/control/'));}
      if(mode==='no-blocked-citation')result.recovery.evidencePaths=result.recovery.evidencePaths.filter(name=>name!==f.snapshot.blockedTask.confirmedResponseIdentity.path);
      if(mode==='wrong-task')result.recovery.taskId='15-02';return result;});
    addBlockedHandoff(f);if(mode==='no-repair')f.snapshot.blockedTask.repairEvidenceIdentities=[];
    const before=fs.readFileSync(path.join(f.root,GUARDIAN_RULE_FILES[2]),'utf8'),result=await f.guardian.inspect(f.snapshot);
    assert.equal(result.decision,'hold',mode);assert.equal(result.recovery.action,'none');assert.match(result.reason,/real rule repair|repair evidence|blocked response|different blocked task/);assert.equal(fs.readFileSync(path.join(f.root,GUARDIAN_RULE_FILES[2]),'utf8'),before);
  }
});

test('external permission, platform denial, missing external input and actual product failures cannot automatically reassign',async t=>{
  for(const settings of [{blockerKind:'external_permission'},{blockerKind:'platform_rejection'},{blockerKind:'missing_external_input'},{issues:['Automatic approval rejected this action']},{nonPassKind:'implementation'}]){
    let f;f=fixture(t,async({overrides})=>recoveryResult(f,overrides));addBlockedHandoff(f,settings);
    const before=fs.readFileSync(path.join(f.root,GUARDIAN_RULE_FILES[2]),'utf8'),result=await f.guardian.inspect(f.snapshot);
    assert.equal(result.decision,'hold');assert.equal(result.recovery.action,'none');assert.match(result.reason,/external\/permission\/platform|product failure/);assert.equal(fs.readFileSync(path.join(f.root,GUARDIAN_RULE_FILES[2]),'utf8'),before);
  }
});

test('external and controller incidents retain explicit nonretry recovery decisions',async t=>{
  for(const action of ['hold_external','repair_controller']){let f;f=fixture(t,async({overrides})=>recoveryResult(f,overrides,{action,decision:'hold',edit:false}));addBlockedHandoff(f,{blockerKind:action==='hold_external'?'external_permission':'operating_handoff'});
    const result=await f.guardian.inspect(f.snapshot);assert.equal(result.decision,'hold');assert.equal(result.recovery.action,action);assert.equal(result.recovery.taskId,'15-01');}
});

test('every changed rule must be cited and blocked evidence must remain unchanged throughout inspection',async t=>{
  for(const mode of ['uncited-rule','changed-evidence']){let f;f=fixture(t,async({overrides})=>{
    const result=recoveryResult(f,overrides);
    if(mode==='uncited-rule'){fs.appendFileSync(path.join(overrides.cwd,GUARDIAN_RULE_FILES[0]),'Another operating rule edit\n');result.ruleChanges.push(GUARDIAN_RULE_FILES[0]);}
    else fs.appendFileSync(f.snapshot.blockedTask.repairEvidenceIdentities[0].path,'changed after initial pin check');
    return result;});addBlockedHandoff(f);
    const before=fs.readFileSync(path.join(f.root,GUARDIAN_RULE_FILES[2]),'utf8'),result=await f.guardian.inspect(f.snapshot);
    assert.equal(result.decision,'hold');assert.equal(result.recovery.action,'none');assert.match(result.reason,/every actual rule repair|evidence changed/);assert.equal(fs.readFileSync(path.join(f.root,GUARDIAN_RULE_FILES[2]),'utf8'),before);
  }
});

test('changed, oversized or excessive blocker evidence holds before permitting a recovery',async t=>{
  const f=fixture(t);const blocked=addBlockedHandoff(f);fs.appendFileSync(blocked.confirmedResponseIdentity.path,'changed');assert.match((await f.guardian.inspect(f.snapshot)).reason,/evidence changed/);assert.equal(f.turns.length,0);
  const many=Array.from({length:65},(_,i)=>({path:`proof-${i}.json`,sha256:'a'.repeat(64),byteLength:1}));assert.throws(()=>guardianSnapshot({blockedTask:{artifactIdentities:many}}),/64 identities/);
  const oversized=fixture(t);addBlockedHandoff(oversized);oversized.write('reports/oversized.json',Buffer.alloc(16*1024*1024+1));oversized.snapshot.blockedTask.artifactIdentities=[identity(path.join(oversized.root,'reports/oversized.json'))];assert.match((await oversized.guardian.inspect(oversized.snapshot)).reason,/byte budget/);assert.equal(oversized.turns.length,0);
});

test('display-only advisory can continue a confirmed handoff and carries the actual controller repair receipt',async t=>{
  let f;f=fixture(t,async({input})=>{
    assert.match(input,/severity=low advisory/);assert.match(input,/nextAction/);assert.match(input,/fresh controller/);
    return{decision:'continue',summary:'low advisory: nextAction alone is stale; confirmed handoff is intact',ruleChanges:[],reason:'The completed turn, target and source identity support proceeding to independent verification.',recovery:{action:'none',taskId:'',evidencePaths:[],reason:''}};
  });
  f.write('reports/run/control/repair-result.json','{"status":"applied","checksPassed":true}\n');const receipt=identity(path.join(f.root,'reports/run/control/repair-result.json'));
  f.snapshot={...f.snapshot,phase:'implementation_handoff',taskStatus:'implemented',nextAction:'태스크 15-01 구현 중',activeTurns:{},operatingRepair:{status:'applied',sourceAudit:{path:'old-audit.json',sha256:'a'.repeat(64),byteLength:1},receiptIdentity:receipt,summary:'Actual operating code repaired'}};
  const before=fs.readFileSync(path.join(f.root,'candidate/src/actual.ts'),'utf8'),result=await f.guardian.inspect(f.snapshot);
  assert.equal(result.decision,'continue');assert.equal(result.recovery.action,'none');assert.deepEqual(result.ruleChanges,[]);
  const context=JSON.parse(fs.readFileSync(path.join(path.dirname(f.state.guardian.lastAuditIdentity.path),'audit-context.json'),'utf8'));
  assert.deepEqual(context.snapshot.operatingRepair.receiptIdentity,receipt);assert.equal(context.snapshot.operatingRepair.status,'applied');assert.equal(context.snapshot.taskStatus,'implemented');assert.deepEqual(context.snapshot.activeTurns,{});
  assert.match(context.decisionPolicy.mandatoryHold,/heartbeat/);assert.match(context.decisionPolicy.controllerRepair,/자동 재시작/);assert.equal(fs.readFileSync(path.join(f.root,'candidate/src/actual.ts'),'utf8'),before);
  const operatingContract=f.requests.find(request=>request.method==='thread/start').params.developerInstructions;
  assert.ok(operatingContract.includes('전용 수리 worker 세션으로 자동 인계'));assert.ok(operatingContract.includes('기존 감시 세션의 계약을 덮어쓰지 않는다'));
});

test('stale display text never automatically downgrades a guardian hold for uncertain execution',async t=>{
  const f=fixture(t,async()=>({decision:'hold',summary:'nextAction is stale, and the actual turn is unconfirmed',ruleChanges:[],reason:'Execution cannot be certified; retain the completed work and repair the controller handoff.',recovery:{action:'repair_controller',taskId:'15-01',evidencePaths:[],reason:'Reconcile the actual turn and source identity in the authorized repair turn'}}));
  const result=await f.guardian.inspect({...f.snapshot,nextAction:'태스크 15-01 구현 중'});
  assert.equal(result.decision,'hold');assert.equal(result.recovery.action,'repair_controller');assert.match(result.reason,/cannot be certified/);
});
