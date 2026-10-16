import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {test,expect} from 'vitest';
import {automaticRecovery,markProgress,beginRecovery,completeRecovery,stalledController,recordExplicitResume,consumeExplicitRetry} from './operating-recovery.mjs';
import {atomicJSON,resolveInside,validateIdentities} from './protocol.mjs';
import {runBoundedCommand,MAX_LOG_BYTES} from './bounded-output.mjs';

const config={taskVerificationMode:'controller-vitest',automaticRecovery:true,controllerProgressTimeoutMs:1000};
test('local delivery, tool and controller errors recover automatically; external approvals still require their real resolution',()=>{
  for(const error of ['Evidence file not found within project: coverage.json','EPERM: temp directory','Controller exited unexpectedly','Turn timeout'])expect(automaticRecovery({status:'waiting_execution',error},config)).toBe(true);
  for(const error of ['Human input required: requestApproval','Unauthorized','automatic approval review rejected action','Manual baseline gate: disabled'])expect(automaticRecovery({status:'waiting_execution',error},config)).toBe(false);
  expect(automaticRecovery({status:'stopped'},config)).toBe(false);
});
test('heartbeat refresh cannot hide missing product progress',()=>{
  const s={status:'running',phase:'implement',tasks:{'15-01':{status:'implemented'}},activeTurns:{}};markProgress(s);const before=s.progressAt;s.heartbeatAt=new Date().toISOString();markProgress(s);expect(s.progressAt).toBe(before);
  expect(stalledController(s,config,Date.parse(before)+2000)).toMatch(/progress has stalled/);
  s.activeOperation={deadlineAt:new Date(Date.parse(before)+10000).toISOString()};expect(stalledController(s,config,Date.parse(before)+2000)).toBe(null);
  expect(stalledController(s,config,Date.parse(before)+50000)).toMatch(/deadline/);
});
test('bounded input validation survives a stale heartbeat but its deadline still terminates a real stall',()=>{
  const now=Date.now(),s={status:'running',heartbeatAt:new Date(now-120000).toISOString(),activeOperations:{validation:{kind:'operating-input-validation',deadlineAt:new Date(now+60000).toISOString()}}};
  expect(stalledController(s,config,now)).toBe(null);
  expect(stalledController(s,config,now+100000)).toMatch(/deadline/);
  delete s.activeOperations;expect(stalledController(s,config,now)).toMatch(/heartbeat/);
});
test('repair PASS and controller restart do not close an incident until original task verification advances',()=>{
  const s={tasks:{'15-01':{status:'verifying'}},status:'running'};beginRecovery(s,{path:'original-incident.json'},'delivery failure');
  s.guardian={lastControllerRepair:{status:'applied'}};s.phase='startup';expect(completeRecovery(s)).toBe(false);expect(s.operatingRecovery.status).toBe('recovering');
  s.tasks['15-01'].verification='reports/actual-verdict.json';expect(completeRecovery(s)).toBe(true);expect(s.operatingRecovery.status).toBe('resolved');
});
test('a hung child process is terminated and remains an operating timeout, with bounded output',async context=>{
  const base=path.resolve('.tmp/recovery-timeout-tests');fs.mkdirSync(base,{recursive:true});const d=fs.mkdtempSync(path.join(base,'case-'));
  context.onTestFinished(()=>{if(!d.startsWith(base+path.sep))throw Error('Unsafe fixture cleanup');fs.rmSync(d,{recursive:true,force:true});});
  const execution=await runBoundedCommand({command:[process.execPath,'-e',"process.stdout.write('x'.repeat(400000));setInterval(()=>{},1000)"],cwd:d,logPrefix:path.join(d,'hung'),timeoutMs:500});
  expect(execution.timedOut).toBe(true);expect(execution.exitCode).not.toBe(0);expect(execution.stdout.byteLength).toBeLessThanOrEqual(MAX_LOG_BYTES);expect(execution.stdout.observedBytes).toBeGreaterThan(MAX_LOG_BYTES);
},10000);

function resumeFixture(context){
  const base=path.resolve('.tmp/explicit-resume-tests');fs.mkdirSync(base,{recursive:true});const root=fs.mkdtempSync(path.join(base,'case-'));
  context.onTestFinished(()=>{if(!root.startsWith(base+path.sep))throw Error('Unsafe fixture cleanup');fs.rmSync(root,{recursive:true,force:true});});
  const directory=path.join(root,'reports/prompt15/orchestration/original-run');fs.mkdirSync(directory,{recursive:true});
  const state={status:'waiting_input',review:'A',tasks:{'15-02':{status:'blocked',parked:true},'15-03':{status:'pass'}},requiredUserInput:{kind:'missing_external_input',taskIds:['15-02']}};
  atomicJSON(path.join(directory,'state.json'),state);return{root,directory,state};
}

test('an explicit dead-controller resume preserves a unique request without certifying or clearing its blocker',context=>{
  const f=resumeFixture(context),original=structuredClone(f.state),first=recordExplicitResume(f);
  expect(first.taskIds).toEqual(['15-02']);validateIdentities(f.root,[first.receiptIdentity]);
  const receipt=JSON.parse(fs.readFileSync(resolveInside(f.root,first.receiptIdentity.path),'utf8'));
  validateIdentities(f.root,[receipt.requestIdentity]);expect(receipt.source).toBe('resume-command');expect(receipt.authorization).toContain('remain unverified');
  expect(f.state.tasks).toEqual(original.tasks);expect(f.state.requiredUserInput).toEqual(original.requiredUserInput);
  const second=recordExplicitResume(f);expect(second.receiptIdentity.sha256).not.toBe(first.receiptIdentity.sha256);
});

test('an automatic restart cannot manufacture an explicit user resume',context=>{
  const f=resumeFixture(context),original=structuredClone(f.state);
  expect(recordExplicitResume({...f,automatic:true})).toBe(null);expect(f.state).toEqual(original);
  expect(fs.existsSync(path.join(f.directory,'control'))).toBe(false);
});

test('retry bytes and state link survive before consumption; replaying the same request gives the same authorization token',context=>{
  const f=resumeFixture(context),retry=path.join(f.directory,'retry.json'),bytes=Buffer.from('{\n  "requestedAt": "2026-10-15T10:00:00.000Z", "requestId": "literal-user-request", "note": "사용자 재개"\n}\n');
  fs.writeFileSync(retry,bytes);let saved=false;
  const first=consumeExplicitRetry({...f,save:()=>{expect(fs.existsSync(retry)).toBe(true);validateIdentities(f.root,[f.state.explicitResume.receiptIdentity]);atomicJSON(path.join(f.directory,'state.json'),f.state);saved=true;}});
  expect(saved).toBe(true);expect(fs.existsSync(retry)).toBe(false);
  const receipt=JSON.parse(fs.readFileSync(resolveInside(f.root,first.receiptIdentity.path),'utf8'));
  expect(fs.readFileSync(resolveInside(f.root,receipt.requestIdentity.path)).equals(bytes)).toBe(true);
  expect(JSON.parse(fs.readFileSync(path.join(f.directory,'state.json'),'utf8')).explicitResume).toEqual(first);
  fs.writeFileSync(retry,bytes);f.state.tasks['15-02'].lastExplicitResume=first.receiptIdentity.sha256;
  const replay=consumeExplicitRetry(f);expect(replay.receiptIdentity).toEqual(first.receiptIdentity);
  expect(replay.receiptIdentity.sha256).toBe(f.state.tasks['15-02'].lastExplicitResume);
});

test('a failed state save keeps the original retry request and reuses its already preserved receipt',context=>{
  const f=resumeFixture(context),retry=path.join(f.directory,'retry.json');atomicJSON(retry,{requestedAt:'2026-10-15T10:00:00Z'});
  expect(()=>consumeExplicitRetry({...f,save:()=>{throw Error('Injected durable-save failure');}})).toThrow('durable-save failure');
  const preserved=f.state.explicitResume.receiptIdentity;expect(fs.existsSync(retry)).toBe(true);
  expect(consumeExplicitRetry(f).receiptIdentity).toEqual(preserved);expect(fs.existsSync(retry)).toBe(false);
});

test('a second user request arriving during state save is retained as a different authorization',context=>{
  const f=resumeFixture(context),retry=path.join(f.directory,'retry.json');atomicJSON(retry,{requestedAt:'2026-10-15T10:00:00Z',requestId:'first'});
  const first=consumeExplicitRetry({...f,save:()=>{atomicJSON(path.join(f.directory,'state.json'),f.state);atomicJSON(retry,{requestedAt:'2026-10-15T10:00:01Z',requestId:'second'});}});
  expect(fs.existsSync(retry)).toBe(true);const second=consumeExplicitRetry(f);
  expect(second.receiptIdentity.sha256).not.toBe(first.receiptIdentity.sha256);expect(fs.existsSync(retry)).toBe(false);
});

test('retry authorization cannot name an unknown task or borrow another run request',context=>{
  const f=resumeFixture(context),retry=path.join(f.directory,'retry.json');atomicJSON(retry,{requestedAt:'2026-10-15T10:00:00Z',taskIds:['15-99']});
  expect(()=>consumeExplicitRetry(f)).toThrow('unknown task');expect(fs.existsSync(retry)).toBe(true);expect(f.state.explicitResume).toBeUndefined();
  const other=path.join(f.root,'other.json');atomicJSON(other,{});
  expect(()=>recordExplicitResume({...f,source:'retry-file',requestFile:other})).toThrow('regular retry.json');
});

function controllerFixture(context,{required=false,stub}={}){
  const f=resumeFixture(context),scripts=path.join(f.root,'scripts/prompt15-orchestrator');fs.mkdirSync(scripts,{recursive:true});fs.mkdirSync(path.join(f.root,'tools'));
  for(const name of fs.readdirSync(new URL('.',import.meta.url)))if(name.endsWith('.mjs'))fs.copyFileSync(new URL(name,import.meta.url),path.join(scripts,name));
  fs.copyFileSync(path.resolve('tools/prompt15-runtime.mjs'),path.join(f.root,'tools/prompt15-runtime.mjs'));
  fs.mkdirSync(path.join(f.root,'automation/prompt15'),{recursive:true});atomicJSON(path.join(f.root,'automation/prompt15/config.json'),{implementationUnit:'task',executionMode:'orchestrated',boundProductTargets:false,taskVerificationMode:'controller-vitest'});
  fs.writeFileSync(path.join(scripts,'app-server.mjs'),'export class AppServer {async close(){}}\n');
  fs.writeFileSync(path.join(scripts,'task-workflow.mjs'),`import fs from 'node:fs';import path from 'node:path';import {atomicJSON} from './protocol.mjs';export class TaskWorkflow {constructor({directory}){this.directory=directory;this.state=JSON.parse(fs.readFileSync(path.join(directory,'state.json'),'utf8'));}save(){atomicJSON(path.join(this.directory,'state.json'),this.state);}async run(){fs.appendFileSync('actual-launches.jsonl',JSON.stringify({pid:process.pid,automatic:process.env.PROMPT15_AUTOMATIC_RECOVERY??null,resume:this.state.explicitResume??null})+'\\n');${stub??"this.state.status='standby';this.save();return this.state;"}}}`);
  f.state.status=required?'waiting_input':'stopped';if(!required)delete f.state.requiredUserInput;
  atomicJSON(path.join(f.directory,'state.json'),f.state);return f;
}

async function runController(context,f,entry,{automatic='0'}={}){
  const child=spawn(process.execPath,[entry,'resume','--run',f.directory],{cwd:f.root,windowsHide:true,env:{...process.env,PROMPT15_AUTOMATIC_RECOVERY:automatic},stdio:['ignore','ignore','pipe']});
  let errors='';child.stderr.on('data',bytes=>{errors+=bytes;});
  context.onTestFinished(async()=>{if(child.exitCode===null){const stopped=new Promise(resolve=>child.once('close',resolve));child.kill();await stopped;}});
  const exit=await Promise.race([new Promise(resolve=>child.once('close',resolve)),new Promise(resolve=>{const timer=setTimeout(()=>resolve('timeout'),12000);timer.unref();})]);
  expect(exit,errors).toBe(0);
  return fs.readFileSync(path.join(f.root,'actual-launches.jsonl'),'utf8').trim().split('\n').map(line=>JSON.parse(line));
}

test('the actual direct resume CLI records user authorization before dispatching a waiting run',async context=>{
  const f=controllerFixture(context,{required:true});
  const launches=await runController(context,f,'scripts/prompt15-orchestrator/run.mjs');
  expect(launches).toHaveLength(1);expect(launches[0].resume.taskIds).toEqual(['15-02']);validateIdentities(f.root,[launches[0].resume.receiptIdentity]);
},20000);

for(const automatic of ['0','1'])test(`the actual wrapper records only an explicit first resume, not its fresh automatic reload; inherited automatic=${automatic}`,async context=>{
  const f=controllerFixture(context,{stub:"if(!fs.existsSync('reloaded.txt')){fs.writeFileSync('reloaded.txt','yes');const error=Error('Tested operating reload');error.code='OPERATING_REPAIR_APPLIED';throw error;}this.state.status='standby';this.save();return this.state;"});
  const launches=await runController(context,f,'tools/prompt15-runtime.mjs',{automatic});
  expect(launches).toHaveLength(2);expect(launches.map(v=>v.automatic)).toEqual([automatic,'1']);expect(launches[1].pid).not.toBe(launches[0].pid);
  if(automatic==='1'){expect(launches.every(v=>v.resume===null)).toBe(true);expect(fs.existsSync(path.join(f.directory,'control/explicit-resume'))).toBe(false);}
  else{expect(launches[1].resume).toEqual(launches[0].resume);expect(fs.readdirSync(path.join(f.directory,'control/explicit-resume'))).toHaveLength(1);}
},20000);

test('exhausted operating recovery cannot spin until a new explicit user resume',()=>{
 const s={status:'waiting_execution',supervisorOversight:{status:'escalation_exhausted',exhaustedAt:'2026-10-15T10:00:00Z'}};
 const config={taskVerificationMode:'controller-vitest',automaticRecovery:true};
 expect(automaticRecovery(s,config)).toBe(false);
 s.explicitResume={requestedAt:'2026-10-15T09:59:00Z'};expect(automaticRecovery(s,config)).toBe(false);
 s.explicitResume={requestedAt:'2026-10-15T10:01:00Z'};expect(automaticRecovery(s,config)).toBe(true);
 expect(s.supervisorOversight.status).toBe('escalation_exhausted');
});
