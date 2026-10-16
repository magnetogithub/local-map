// Local lifecycle observer. It never infers a review PASS or sends a model prompt.
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {atomicJSON, inside} from '../scripts/prompt15-orchestrator/protocol.mjs';
import {assertLaunchAllowed} from '../scripts/prompt15-orchestrator/launch-policy.mjs';
import {automaticRecovery,stalledController,consumeExplicitRetry,completedProductBlock} from '../scripts/prompt15-orchestrator/operating-recovery.mjs';
import {observeProductProgress,evaluateSupervisorOversight,recordSupervisorOversight} from '../scripts/prompt15-orchestrator/supervisor-oversight-policy.mjs';
import {repairProtected,auditRequestState,auditWatchdogTimeout} from '../scripts/prompt15-orchestrator/execution-lifecycle.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const base = path.join(root, 'reports/prompt15/orchestration');
const args = process.argv.slice(2);
let command = args.shift() ?? 'resume';
if (!['start', 'resume'].includes(command)) throw Error('Use start or resume');
const value = name => { const index = args.indexOf(name); return index < 0 ? null : args[index + 1]; };
let run = value('--run') ? path.resolve(root, value('--run')) : command === 'resume' ? JSON.parse(fs.readFileSync(path.join(base, 'latest.json'), 'utf8')).directory : null;
if (run && !inside(base, run)) throw Error('Run escapes orchestration');
assertLaunchAllowed(root, JSON.parse(fs.readFileSync(path.join(root, 'automation/prompt15/config.json'), 'utf8')), run ? JSON.parse(fs.readFileSync(path.join(run,'state.json'),'utf8')) : null);
const codex = value('--codex');
fs.mkdirSync(path.join(root, '.tmp'), {recursive: true});
const alive = pid => { if (!Number.isInteger(pid)) return false; try { process.kill(pid, 0); return true; } catch { return false; } };
const readState = () => JSON.parse(fs.readFileSync(path.join(run, 'state.json'), 'utf8'));
if (run) {
  const state = readState();
  if (alive(state.controllerPid) || alive(state.runtimeSupervisorPid)) throw Error('An existing runtime is already alive');
  if (state.status === 'standby') process.exit(0);
}
let userStopped = false;
let failures = 0;
let first = true;
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const stop = () => {
  userStopped = true;
  if (run) atomicJSON(path.join(run, 'stop.json'), {requestedAt: new Date().toISOString()});
};
process.once('SIGINT', stop); process.once('SIGTERM', stop);

while (!userStopped) {
  const output = fs.openSync(path.join(root, `.tmp/prompt15-controller-${process.pid}.stdout.log`), 'a');
  const errors = fs.openSync(path.join(root, `.tmp/prompt15-controller-${process.pid}.stderr.log`), 'a');
  const child = spawn(process.execPath, ['scripts/prompt15-orchestrator/run.mjs', command, ...(run ? ['--run', run] : []), ...(codex ? ['--codex', codex] : [])], {
    cwd: root, windowsHide: true, env: {...process.env, PROMPT15_SUPERVISOR_PID: String(process.pid), PROMPT15_AUTOMATIC_RECOVERY: first ? (process.env.PROMPT15_AUTOMATIC_RECOVERY??'0') : '1'}, stdio: ['ignore', output, errors],
  });
  fs.closeSync(output); fs.closeSync(errors);
  const exited = new Promise(resolve => { child.once('exit', resolve); child.once('error', resolve); });
  let terminatedForStall=false;
  let stalledAuditRequest=null;
  const watchdog=setInterval(()=>{
    if(!run||terminatedForStall||fs.existsSync(path.join(run,'stop.json')))return;
    try{
      const state=readState(),config=JSON.parse(fs.readFileSync(path.join(root,'automation/prompt15/config.json'),'utf8'));
      if(state.controllerPid!==child.pid)return;
      let oversightTimeout=null;
      if(config.supervisorOversight?.enabled!==false){
        const observationFile=path.join(run,'control/supervisor-observation.json'),mailbox=path.join(run,'control/supervisor-audit-request.json');
        let observation=observeProductProgress(state,fs.existsSync(observationFile)?JSON.parse(fs.readFileSync(observationFile,'utf8')):null,Date.now());
        let pending=fs.existsSync(mailbox)?JSON.parse(fs.readFileSync(mailbox,'utf8')):null;
        if(pending&&state.supervisorOversight?.handledRequestId!==pending.id&&!observation.oversight?.[pending.decision.incidentFingerprint])observation=recordSupervisorOversight(observation,pending.decision,{at:pending.requestedAt,status:'requested',deadlineAt:pending.deadlineAt});
        if(pending&&auditRequestState(state,observation,pending)==='handled'){
          if(observation.oversight?.[pending.decision.incidentFingerprint])observation=recordSupervisorOversight(observation,pending.decision,{at:Date.now(),status:state.supervisorOversight.status==='failed'?'failed':'completed'});pending=null;
        }
        const decision=evaluateSupervisorOversight(state,config,observation,Date.now());
        const supervisedRepairActive=repairProtected(state,Date.now());
        if(!pending&&!supervisedRepairActive&&['audit','escalate'].includes(decision.decision)){
          const at=Date.now(),deadlineAt=new Date(at+(config.supervisorOversight?.auditTimeoutMs??180000)).toISOString();
          const request={version:1,id:`oversight-${randomUUID()}`,runId:state.runId,requestedAt:new Date(at).toISOString(),deadlineAt,decision};
          observation=recordSupervisorOversight(observation,decision,{at,status:'requested',deadlineAt});atomicJSON(mailbox,request);pending=request;
        }
        if(decision.exhausted)atomicJSON(path.join(run,'control/supervisor-attention.json'),{version:1,status:'escalation_exhausted',at:new Date().toISOString(),decision});
        atomicJSON(observationFile,observation);
        oversightTimeout=auditWatchdogTimeout(state,observation,pending,Date.now());
        if(oversightTimeout)stalledAuditRequest=pending;
      }
      const reason=oversightTimeout??stalledController(state,config);if(!reason)return;
      terminatedForStall=true;
      atomicJSON(path.join(run,'control/watchdog-incident.json'),{version:1,reason,controllerPid:child.pid,at:new Date().toISOString(),progressAt:state.progressAt});
      if(process.platform==='win32'){
        const killer=spawn('taskkill.exe',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});killer.once('error',()=>child.kill());
      }else child.kill('SIGKILL');
    }catch{/* Transient atomic state replacement is retried by the next tick. */}
  },5000);
  const discovery = setInterval(() => {
    if (run) return;
    try {
      const selected = JSON.parse(fs.readFileSync(path.join(base, 'latest.json'), 'utf8')).directory;
      if (!inside(base, selected)) return;
      const state = JSON.parse(fs.readFileSync(path.join(selected, 'state.json'), 'utf8'));
      if (state.runtimeSupervisorPid === process.pid) { run = selected; if (userStopped) stop(); }
    } catch { /* The first worker may still be creating its state file. */ }
  }, 1000);
  await exited;
  clearInterval(watchdog);
  clearInterval(discovery);
  if (!run) {
    const latest = path.join(base, 'latest.json');
    if (!fs.existsSync(latest)) throw Error('Controller exited before creating a run; inspect local controller log');
    run = JSON.parse(fs.readFileSync(latest, 'utf8')).directory;
    if (!inside(base, run)) throw Error('Run escapes orchestration');
  }
  const state = readState();
  // Never take ownership of an existing controller rejected by the child startup.
  if (state.runtimeSupervisorPid && state.runtimeSupervisorPid !== process.pid || alive(state.controllerPid)) throw Error('Another runtime owns this run');
  if (state.status === 'standby' || fs.existsSync(path.join(run, 'stop.json')) || userStopped) break;
  if(stalledAuditRequest){
    // A corrupt/unprovable native owner must not become an endless watchdog
    // restart loop. Only the lifecycle owner writes this state after child exit.
    const retryFile=path.join(run,'control/supervisor-watchdog-retries.json');
    const ledger=fs.existsSync(retryFile)?JSON.parse(fs.readFileSync(retryFile,'utf8')):{version:1,requests:{}};
    const resumeIdentity=state.explicitResume?.receiptIdentity?.sha256??null,retryKey=`${stalledAuditRequest.id}:${resumeIdentity??'automatic'}`;
    const prior=ledger.requests[retryKey]??{count:0};
    const record={count:prior.count+1,at:new Date().toISOString(),controllerPid:child.pid,requestId:stalledAuditRequest.id,resumeIdentity};
    ledger.requests[retryKey]=record;atomicJSON(retryFile,ledger);
    atomicJSON(path.join(run,'control',`supervisor-watchdog-${stalledAuditRequest.id}-${resumeIdentity?.slice(0,12)??'automatic'}-${record.count}.json`),record);
    if(record.count>=3){
      state.supervisorOversight={...state.supervisorOversight,status:'escalation_exhausted',exhaustedAt:record.at,lastCheckedAt:record.at,lastSummary:'The same supervisor audit exceeded its deadline across three controller replacements; exact native ownership remains unconfirmed. Original receipts are preserved.'};
      state.status='waiting_recovery';state.error=state.supervisorOversight.lastSummary;atomicJSON(path.join(run,'state.json'),state);
    }
  }
  if(state.status==='reloading_orchestration'){
    // A tested guardian code repair needs a fresh module graph, not an operator
    // retry or a new implementation attempt. Preserve this run and all turns.
    command='resume';first=false;continue;
  }
  failures++;
  const controllerError = `Controller exited unexpectedly (${child.exitCode ?? 'spawn error'}). Last saved task report is retained.`;
  state.lastControllerFailure = {at: new Date().toISOString(), reason: controllerError};
  if (!completedProductBlock(state)&&!['waiting_input', 'waiting_execution'].includes(state.status)) state.error = controllerError;
  const auto=automaticRecovery(state,JSON.parse(fs.readFileSync(path.join(root,'automation/prompt15/config.json'),'utf8')));
  state.status = auto?'recovering':completedProductBlock(state)||['waiting_input', 'waiting_execution', 'waiting_recovery'].includes(state.status) ? state.status : failures >= 5 ? 'waiting_recovery' : 'recovering';
  state.runtimeSupervisorPid = process.pid;
  atomicJSON(path.join(run, 'state.json'), state);
  fs.appendFileSync(path.join(run, 'events.jsonl'), JSON.stringify({at: new Date().toISOString(), kind: 'workflow_waiting', status: state.status, review: state.review, reason: state.error}) + '\n');
  const deadline = Date.now() + Math.min(60000, 2000 * 2 ** Math.min(failures, 5));
  // Replace a dead controller even while it is waiting. The replacement itself
  // restores the hold before inference; the observer must not strand a dead PID.
  while (!userStopped && (state.status === 'waiting_recovery' || Date.now() < deadline)) {
    if (fs.existsSync(path.join(run, 'stop.json'))) { userStopped = true; break; }
    const retry = path.join(run, 'retry.json');
    if (fs.existsSync(retry)) {
      consumeExplicitRetry({root,directory:run,state,save:()=>{state.status='recovering';delete state.requiredUserInput;atomicJSON(path.join(run,'state.json'),state);}});
      failures=0;break;
    }
    await delay(1000);
  }
  command = 'resume'; first = false;
}
if (userStopped && run) {
  const state = readState();
  if (state.status !== 'standby' && state.status !== 'stopped') {
    state.status = 'stopped'; state.activeRole = null;
    atomicJSON(path.join(run, 'state.json'), state);
    fs.appendFileSync(path.join(run, 'events.jsonl'), JSON.stringify({at: new Date().toISOString(), kind: 'workflow_stopped', status: 'stopped', review: state.review, reason: 'User stop requested'}) + '\n');
  }
}
