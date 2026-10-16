import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {AppServer} from './app-server.mjs';
import {Workflow, runName} from './workflow.mjs';
import {TaskWorkflow} from './task-workflow.mjs';
import {atomicJSON, inside} from './protocol.mjs';
import {TERMINAL_STATUSES, classifyFailure, recordRuntimeFailure, RUNTIME_VERSION} from './policy.mjs';
import {assertLaunchAllowed} from './launch-policy.mjs';
import {automaticRecovery,beginRecovery,recordExplicitResume,consumeExplicitRetry,needsExternalInput,oversightExhausted,completedProductBlock,productBlockNeedsResolution} from './operating-recovery.mjs';
import {auditRequestState} from './execution-lifecycle.mjs';
import {drainSupervisorAudit} from './supervisor-oversight.mjs';
import {acceptOperatingMaintenance} from './operating-maintenance.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const base = path.join(projectRoot, 'reports/prompt15/orchestration');
const configPath = path.join(projectRoot, 'automation/prompt15/config.json');
const args = process.argv.slice(2);
const command = args.shift() ?? 'status';
const usage = 'node scripts/prompt15-orchestrator/run.mjs start|resume|status|stop|check [--run <directory>] [--codex <executable>]';
function argument(name) { const index = args.indexOf(name); return index < 0 ? null : args[index + 1]; }
function currentDirectory() {
  const supplied = argument('--run');
  const directory = supplied ? path.resolve(projectRoot, supplied) : fs.existsSync(path.join(base, 'latest.json')) ? JSON.parse(fs.readFileSync(path.join(base, 'latest.json'), 'utf8')).directory : null;
  if (!directory) throw Error('No run exists. Use start.');
  if (!inside(base, directory)) throw Error('Run directory must stay in reports/prompt15/orchestration');
  return directory;
}
function alive(pid) { if (!Number.isInteger(pid)) return false; try { process.kill(pid, 0); return true; } catch { return false; } }

async function main() {
  if (command === 'help' || command === '--help') { console.log(usage); return; }
  if (args.some((value, index) => index % 2 === 0 && !['--run', '--codex'].includes(value)) || args.length % 2) throw Error(usage);
  if (command === 'status') {
    const directory = currentDirectory();
    const state = JSON.parse(fs.readFileSync(path.join(directory, 'state.json'), 'utf8'));
    console.log(JSON.stringify({...state, controllerAlive: alive(state.controllerPid), runtimeSupervisorAlive: alive(state.runtimeSupervisorPid)}, null, 2));
    return;
  }
  if (command === 'stop') {
    const directory = currentDirectory();
    atomicJSON(path.join(directory, 'stop.json'), {requestedAt: new Date().toISOString()});
    console.log('Stop requested. Only this run and its own turns will stop.');
    return;
  }
  if (!['start', 'resume', 'check'].includes(command)) throw Error(usage);
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const binary = argument('--codex') ?? config.codexBinary ?? 'codex';
  fs.mkdirSync(base, {recursive: true});
  if (command === 'check') {
    const server = new AppServer({binary, cwd: projectRoot, serverArgs: config.appServerArgs, turnTimeoutMs: config.turnTimeoutMs, log: event => {
      if (event.kind === 'server_stderr') console.error(event.text);
    }});
    try {
      const initialization = await server.initialize();
      const auth = await server.request('account/read', {});
      // No token, raw account object, or inference request is printed.
      console.log(JSON.stringify({appServer: 'connected', userAgent: initialization.userAgent, authenticated: Boolean(auth.account), accountType: auth.account?.type ?? null}, null, 2));
      if (!auth.account) process.exitCode = 1;
    } finally { await server.close(); }
    return;
  }
  // Before creating run folders, replacing latest.json, releasing a stop marker,
  // writing retry.json, or spawning an authenticated model process.
  assertLaunchAllowed(projectRoot, config, command === 'resume' ? JSON.parse(fs.readFileSync(path.join(currentDirectory(), 'state.json'), 'utf8')) : null);
  const directory = command === 'start' ? path.join(base, runName()) : currentDirectory();
  if (command === 'resume') {
    const previousState = JSON.parse(fs.readFileSync(path.join(directory, 'state.json'), 'utf8'));
    const managedByAnother = alive(previousState.runtimeSupervisorPid) && previousState.runtimeSupervisorPid !== Number(process.env.PROMPT15_SUPERVISOR_PID);
    if (alive(previousState.controllerPid) || managedByAnother) {
      if(process.env.PROMPT15_AUTOMATIC_RECOVERY==='1')throw Error('An automatic restart cannot request another live controller to retry');
      if (!completedProductBlock(previousState)&&!['waiting_input', 'waiting_recovery', 'waiting_execution'].includes(previousState.status)) throw Error('This controller is already running');
      atomicJSON(path.join(directory, 'retry.json'), {requestedAt: new Date().toISOString(),requestId:randomUUID()});
      console.log('Waiting controller will retry with the existing run and sessions.');
      return;
    }
  }
  if (command === 'start' && fs.existsSync(path.join(base, 'latest.json'))) {
    const previous = JSON.parse(fs.readFileSync(path.join(base, 'latest.json'), 'utf8'));
    const stateFile = path.join(previous.directory, 'state.json');
    if (fs.existsSync(stateFile)) {
      const previousState = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      if (alive(previousState.controllerPid) || alive(previousState.runtimeSupervisorPid)) throw Error('Another controller is running. Stop it first.');
    }
  }
  fs.mkdirSync(directory, {recursive: true});
  const globalLock = path.join(base, 'active-controller.lock');
  if (fs.existsSync(globalLock)) {
    const previous = JSON.parse(fs.readFileSync(globalLock, 'utf8'));
    if (alive(previous.pid)) throw Error('Another Prompt 15 controller is already running');
    fs.unlinkSync(globalLock);
  }
  fs.writeFileSync(globalLock, JSON.stringify({pid: process.pid, directory}), {flag: 'wx'});
  // An exclusive lock prevents two controllers from dispatching the same session.
  const lockFile = path.join(directory, 'controller.lock');
  if (fs.existsSync(lockFile)) {
    const prior = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
    if (alive(prior.pid)) {
      fs.unlinkSync(globalLock);
      throw Error('This run already has a live controller');
    }
    fs.unlinkSync(lockFile);
  }
  fs.writeFileSync(lockFile, JSON.stringify({pid: process.pid, startedAt: new Date().toISOString()}), {flag: 'wx'});
  const eventFile = path.join(directory, 'events.jsonl');
  const log = event => {
    // Raw command output is never stored here. Keep bounded summaries, rotate
    // once at 8 MiB, and preserve actual execution receipts in task directories.
    const bounded={...event};if(typeof bounded.text==='string')bounded.text=bounded.text.slice(0,8192);
    if(fs.existsSync(eventFile)&&fs.statSync(eventFile).size>8*1024*1024){const previous=eventFile+'.previous';if(fs.existsSync(previous))fs.unlinkSync(previous);fs.renameSync(eventFile,previous);}
    fs.appendFileSync(eventFile, `${JSON.stringify({at: new Date().toISOString(), ...bounded})}\n`);
  };
  let server;
  let workflow;
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    if (workflow) workflow.stopped = true;
    if (server) await server.close();
  };
  const monitor = setInterval(() => {
    if (fs.existsSync(path.join(directory, 'stop.json'))) stop().catch(error => log({kind: 'stop_error', text: error.message}));
    if (JSON.parse(fs.readFileSync(configPath,'utf8')).executionMode === 'manual-prompt14') stop().catch(error=>log({kind:'stop_error',text:error.message}));
    if (workflow) {
      workflow.state.heartbeatAt = new Date().toISOString(); workflow.save();
      // Runs while the guardian is awaiting inference, not behind its approval.
      workflow.oversight?.poll().catch(error=>log({kind:'supervisor_audit_error',text:error.message}));
    }
  }, 5000);
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
  const waitForRecovery = async state => {
    const retryFile = path.join(directory, 'retry.json');
    const auto=automaticRecovery(state,config);
    const manual = !auto&&(completedProductBlock(state)||['waiting_input', 'waiting_recovery', 'waiting_execution'].includes(state.status));
    const deadline = Date.now() + Math.min(60000, 2000 * 2 ** Math.min(state.recoveryAttempts ?? 0, 5));
    while (!stopping) {
      if((!completedProductBlock(state)||productBlockNeedsResolution(state))&&workflow?.state.supervisorOversight?.pendingRepairIdentity){workflow.oversightReloadRequested=false;return;}
      const auditMailbox=path.join(directory,'control/supervisor-audit-request.json');
      if((!completedProductBlock(state)||productBlockNeedsResolution(state))&&!needsExternalInput(state)&&!oversightExhausted(state)&&fs.existsSync(auditMailbox)&&auditRequestState(state,null,JSON.parse(fs.readFileSync(auditMailbox,'utf8')))==='pending')return;
      if (fs.existsSync(retryFile)) {
        consumeExplicitRetry({root:projectRoot,directory,state,save:()=>{delete state.requiredUserInput;state.recoveryAttempts=0;workflow.save();}});
        return;
      }
      if (!manual && Date.now() >= deadline) {if(auto){state.status='recovering';workflow.save();}return;}
      await delay(1000);
    }
  };
  try {
    if (command === 'resume' && fs.existsSync(path.join(directory, 'stop.json'))) fs.unlinkSync(path.join(directory, 'stop.json'));
    atomicJSON(path.join(base, 'latest.json'), {directory, runId: path.basename(directory)});
    console.log(`Prompt 15 controller: ${directory}`);
    let resume = command === 'resume';
    let explicitResumePending=resume&&process.env.PROMPT15_AUTOMATIC_RECOVERY!=='1';
    while (!stopping) {
      let state;
      try {
        server = new AppServer({binary, cwd: projectRoot, serverArgs: config.appServerArgs, log, turnTimeoutMs: config.turnTimeoutMs});
        const Runtime=config.implementationUnit==='task'?TaskWorkflow:Workflow;
        workflow = new Runtime({root: projectRoot, directory, config, configFile: configPath, server, log, resume});
        acceptOperatingMaintenance(projectRoot,workflow.state);
        workflow.state.controllerPid = process.pid;
        workflow.state.heartbeatAt = new Date().toISOString();
        if (process.env.PROMPT15_SUPERVISOR_PID) workflow.state.runtimeSupervisorPid = Number(process.env.PROMPT15_SUPERVISOR_PID);
        let explicitlyRequested=false;
        if(fs.existsSync(path.join(directory,'retry.json'))){
          consumeExplicitRetry({root:projectRoot,directory,state:workflow.state,save:()=>{delete workflow.state.requiredUserInput;workflow.state.recoveryAttempts=0;workflow.save();}});
          explicitlyRequested=true;
        }
        if(explicitResumePending){
          recordExplicitResume({root:projectRoot,directory,state:workflow.state});
          delete workflow.state.requiredUserInput;workflow.state.recoveryAttempts=0;
          explicitResumePending=false;explicitlyRequested=true;
        }
        workflow.save();
        if (!completedProductBlock(workflow.state)&&!explicitlyRequested&&process.env.PROMPT15_PRESERVE_EXECUTION_HOLD === '1' && workflow.state.error && classifyFailure(Error(workflow.state.error), workflow.state) === 'waiting_execution') {
          workflow.state.status = 'waiting_execution'; workflow.state.runtimeVersion = RUNTIME_VERSION; workflow.state.activeRole = null;
          recordRuntimeFailure(workflow.state, Error(workflow.state.error));
          workflow.state.nextAction = workflow.state.executionFailure.resumeCondition;
          workflow.save();
          log({kind: 'workflow_waiting', status: 'waiting_execution', review: workflow.state.review, reason: workflow.state.error});
          await waitForRecovery(workflow.state);
        } else if (!explicitlyRequested&&process.env.PROMPT15_AUTOMATIC_RECOVERY === '1' && ['waiting_input', 'waiting_recovery', 'waiting_execution'].includes(workflow.state.status)) await waitForRecovery(workflow.state);
        if (stopping) break;
        state = await workflow.run();
      } catch (error) {
        if (!workflow) throw error;
        state = workflow.state;
        const controlReload=['OPERATING_REPAIR_APPLIED','SUPERVISOR_RECONCILE'].includes(error.code);
        state.status = controlReload?'reloading_orchestration':classifyFailure(error, state, stopping);
        state.error = controlReload?null:error.message;
        if(!controlReload&&automaticRecovery(state,config))state.status='recovering';
        if (state.status !== 'stopped'&&state.status!=='reloading_orchestration') recordRuntimeFailure(state, error);
        state.activeRole = null;
        workflow.save();
        log({kind: error.code==='OPERATING_REPAIR_APPLIED'?'guardian_controller_reload':'workflow_waiting', status: state.status, review: state.review, reason: error.message});
      }
      await drainSupervisorAudit(workflow);
      console.log(JSON.stringify({status: state.status, review: state.review, nextAction: state.nextAction, error: state.error}, null, 2));
      if (server) await server.close();
      server = null;
      if (state.status==='reloading_orchestration') break;
      if (TERMINAL_STATUSES.includes(state.status)) break;
      if (state.status === 'recovering') state.recoveryAttempts = (state.recoveryAttempts ?? 0) + 1;
      if (state.status === 'recovering' && state.recoveryAttempts >= 5&&!automaticRecovery(state,config)) {
        state.status = 'waiting_recovery';
        state.nextAction = 'Runtime recovery repeatedly failed. Controller stays alive; inspect logs and use resume to retry.';
        log({kind: 'workflow_waiting', status: state.status, review: state.review, reason: state.error});
      }
      workflow.save();
      await waitForRecovery(state);
      resume = true;
    }
    if (stopping && workflow && workflow.state.status !== 'standby' && workflow.state.status !== 'stopped') {
      workflow.state.status = 'stopped'; workflow.state.activeRole = null; workflow.save();
      log({kind: 'workflow_stopped', status: 'stopped', review: workflow.state.review, reason: 'User stop requested'});
    }
  } catch (error) {
    if (!workflow) throw error;
    workflow.state.status = classifyFailure(error, workflow.state, stopping);
    workflow.state.error = error.message;
    workflow.state.activeRole = null;
    workflow.save();
    log({kind: 'workflow_waiting', status: workflow.state.status, review: workflow.state.review, reason: error.message});
    // An unexpected controller error remains visible and alive for operator recovery.
    if(!['waiting_input','waiting_execution','waiting_recovery'].includes(workflow.state.status))workflow.state.status='waiting_recovery';
    await waitForRecovery(workflow.state);
  } finally {
    clearInterval(monitor);
    if (server) await server.close();
    if (fs.existsSync(lockFile)) fs.unlinkSync(lockFile);
    if (fs.existsSync(globalLock)) fs.unlinkSync(globalLock);
  }
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
