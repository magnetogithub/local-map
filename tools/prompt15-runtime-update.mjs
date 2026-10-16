// Load one tested operating-policy revision at a durable task boundary.
// Never erase task results, replace a review-adjacent session, or resume a user stop.
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {atomicJSON, inside} from '../scripts/prompt15-orchestrator/protocol.mjs';
import {taskResponsePath} from './prompt15-runtime-update-core.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const base = path.join(root, 'reports/prompt15/orchestration');
const run = JSON.parse(fs.readFileSync(path.join(base, 'latest.json'), 'utf8')).directory;
if (!inside(base, run)) throw Error('Run is outside orchestration');
const read = name => JSON.parse(fs.readFileSync(path.join(run, name), 'utf8'));
const initial = read('state.json');
const versionIndex = process.argv.indexOf('--version');
const targetVersion = versionIndex >= 0 ? Number(process.argv[versionIndex + 1]) : 2;
if (!Number.isInteger(targetVersion) || targetVersion < 2) throw Error('Invalid runtime version');
const readyIndex = process.argv.indexOf('--ready');
const readyFile = readyIndex >= 0 ? path.resolve(root, process.argv[readyIndex + 1]) : null;
if (readyFile && !inside(path.join(root, '.tmp'), readyFile)) throw Error('Validation marker is outside project scratch');
const applyReadyIndex = process.argv.indexOf('--apply-ready');
const applyReadyFile = applyReadyIndex >= 0 ? path.resolve(root, process.argv[applyReadyIndex + 1]) : null;
if (applyReadyFile && !inside(path.join(root, '.tmp'), applyReadyFile)) throw Error('Promotion marker is outside project scratch');
const correctCheckpoint = process.argv.includes('--correct-checkpoint');
const instructionIndex = process.argv.indexOf('--supervisor-instruction');
const instructionPath = instructionIndex >= 0 ? path.resolve(root, process.argv[instructionIndex + 1]) : null;
if (instructionPath && !inside(path.join(run, 'control'), instructionPath)) throw Error('Supervisor instruction is outside this run control directory');
if (correctCheckpoint && instructionPath) throw Error('Choose checkpoint correction or supervisor instruction');
const interruptForControl = correctCheckpoint || Boolean(instructionPath);
const preserveExecutionHold = process.argv.includes('--preserve-execution-hold');
const stopReason = `Apply operating policy revision ${targetVersion} ${instructionPath ? 'for user supervisor instruction' : correctCheckpoint ? 'for checkpoint correction' : 'at completed task boundary'}`;
const marker = path.join(run, 'runtime-update.json');
if (fs.existsSync(marker)) {
  const prior = read('runtime-update.json');
  try { if (!['applied', 'configured_for_future_runs', 'cancelled_by_user_stop', 'restart_failed'].includes(prior.status)) { process.kill(prior.watcherPid, 0); if (prior.watcherPid !== process.pid) throw Error('A runtime updater is already running'); } }
  catch (error) { if (error.message === 'A runtime updater is already running') throw error; }
  const archive = path.join(run, 'runtime-updates', `v${prior.targetVersion ?? 0}-${Date.parse(prior.requestedAt) || Date.now()}.json`);
  if (!fs.existsSync(archive)) atomicJSON(archive, prior);
}
const events = fs.readFileSync(path.join(run, 'events.jsonl'), 'utf8').split('\n').flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
const targets = initial.phase === 'parallel_implementation'
  ? Object.keys(initial.threads).filter(key => key.startsWith('branch-')).map(key => events.filter(event => event.kind === 'dispatch' && event.key === key).at(-1))
  : [events.filter(event => event.kind === 'dispatch').at(-1)];
const responses = targets.filter(Boolean).map(event => {
  const response = taskResponsePath(root, run, event);
  return {role: event.role, key: event.key, path: response};
});
let correction = null;
if (correctCheckpoint) {
  const target = targets[0];
  const prerequisite = initial.latestPrerequisiteVerification && JSON.parse(fs.readFileSync(path.resolve(root, initial.latestPrerequisiteVerification), 'utf8'));
  if (targets.length !== 1 || target?.role !== 'implementer' || initial.phase !== 'implement' || initial.review !== 'C' || prerequisite?.review !== 'B' || prerequisite.verdict === 'pass') throw Error('Checkpoint correction requires the proven B-failure/C-implementation mismatch');
  correction = {origin: 'orchestration-control', review: 'B', checkpoint: '15-3', previousThreadId: target.threadId,
    turnId: events.filter(event => event.method === 'turn/started' && event.threadId === target.threadId).at(-1)?.turnId ?? null,
    reportDirectory: target.reportDirectory, supervisorDecision: initial.latestImplementationHandoff,
    prerequisiteVerification: initial.latestPrerequisiteVerification, previousPendingImplementation: initial.pendingImplementation ?? null,
    requestedAt: new Date().toISOString()};
}
if (instructionPath) {
  const instruction = JSON.parse(fs.readFileSync(instructionPath, 'utf8'));
  const target = targets[0];
  if (targets.length !== 1 || !target || initial.review !== 'B' || instruction.review !== 'B' || instruction.origin !== 'user-instruction' || instruction.targetSupervisorThreadId !== initial.threads.supervisor) throw Error('Supervisor instruction does not match the current B supervisor');
  correction = {origin: 'user-instruction', review: 'B', checkpoint: '15-3', previousThreadId: target.threadId,
    turnId: events.filter(event => event.method === 'turn/started' && event.threadId === target.threadId).at(-1)?.turnId ?? null,
    reportDirectory: target.reportDirectory, supervisorDecision: initial.latestImplementationHandoff,
    prerequisiteVerification: initial.latestPrerequisiteVerification,
    instructionPath: path.relative(root, instructionPath).replaceAll('\\', '/'), requestedAt: new Date().toISOString()};
  const latestImplementation = events.filter(event => event.kind === 'dispatch' && event.role === 'implementer' && !event.key.startsWith('branch-')).at(-1);
  if (latestImplementation && latestImplementation.key !== target.key) {
    const responsePath = path.resolve(root, latestImplementation.reportDirectory, `${latestImplementation.key}-response.json`);
    if (!inside(path.join(run, 'rounds'), responsePath)) throw Error('Implementation response escapes this run');
    responses.push({role: 'implementer', key: latestImplementation.key, path: responsePath});
  }
}
const codexIndex = process.argv.indexOf('--codex');
const codex = codexIndex >= 0 ? process.argv[codexIndex + 1] : null;
const update = {type: 'runtime_update', targetVersion, model: 'gpt-6.1-sol', effort: 'high', requestedAt: new Date().toISOString(), status: 'waiting_for_task_report', previousControllerPid: initial.controllerPid, previousSupervisorPid: initial.runtimeSupervisorPid ?? null, watcherPid: process.pid, responses, ...(readyFile ? {readyFile} : {}), ...(applyReadyFile ? {applyReadyFile} : {}), ...(correction ? {checkpointCorrection: correction} : {})};
const save = () => { update.updatedAt = new Date().toISOString(); atomicJSON(marker, update); };
const alive = pid => { if (!Number.isInteger(pid)) return false; try { process.kill(pid, 0); return true; } catch { return false; } };
let busy = false;
let pausing = false;
let started = false;
const timer = setInterval(check, 500);
function finish() { clearInterval(timer); }

async function check() {
  if (busy) return;
  busy = true;
  try {
    const state = read('state.json');
    if (started) {
      if (state.runtimeSupervisorPid === update.resumedSupervisorPid && state.runtimeVersion === targetVersion && alive(state.controllerPid)) {
        update.resumedControllerPid = state.controllerPid;
        update.status = 'applied'; update.appliedAt = new Date().toISOString(); save(); finish();
      } else if (!alive(update.resumedSupervisorPid)) { update.status = 'restart_failed'; update.error = 'New runtime exited before applying the policy'; save(); finish(); }
      return;
    }
    if (state.status === 'standby') { update.status = 'configured_for_future_runs'; save(); finish(); return; }
    const stopFile = path.join(run, 'stop.json');
    if (fs.existsSync(stopFile) && read('stop.json').reason !== stopReason) {
      update.status = 'cancelled_by_user_stop'; save(); finish(); return;
    }
    if (!pausing) {
      if (readyFile && !fs.existsSync(readyFile)) return;
      if (!interruptForControl && state.status === 'running' && responses.some(response => !fs.existsSync(response.path))) return;
      if (state.status !== 'stopped') {
        for (const response of responses.filter(response => fs.existsSync(response.path))) if (!JSON.parse(fs.readFileSync(response.path, 'utf8')).turnId) throw Error('Task report has no confirmed completed turn');
        update.stopRequestedAt = new Date().toISOString(); update.status = 'pausing_at_task_boundary'; save();
        atomicJSON(stopFile, {requestedAt: update.stopRequestedAt, reason: stopReason});
      }
      pausing = true;
    }
    if (alive(initial.controllerPid) || alive(initial.runtimeSupervisorPid)) return;
    if (readyFile && !fs.existsSync(readyFile)) return;
    if (applyReadyFile && !fs.existsSync(applyReadyFile)) return;
    // The old worker may observe the switch before updating its pending pointer.
    // Choose the actual latest completed implementation report, not an older report.
    const completed = responses.filter(response => response.role === 'implementer' && !response.key.startsWith('branch-') && fs.existsSync(response.path)).at(-1);
    if (completed && state.phase !== 'verify') {
      state.pendingImplementation = {responsePath: path.relative(root, completed.path).replaceAll('\\', '/'), review: state.review};
      atomicJSON(path.join(run, 'state.json'), state);
    }
    if (correction && (!completed || instructionPath)) {
      // An interrupted turn has no completion report. Preserve its files and
      // conversation, discard only the stale pending pointer, and let the
      // supervisor assign a fresh B implementation before another verification.
      state.pendingCheckpointCorrection = {...correction, ...(completed ? {completedResponsePath: path.relative(root, completed.path).replaceAll('\\', '/')} : {})};
      delete state.pendingImplementation;
      atomicJSON(path.join(run, 'state.json'), state);
    }
    const output = fs.openSync(path.join(root, `.tmp/prompt15-runtime-${process.pid}.stdout.log`), 'a');
    const errors = fs.openSync(path.join(root, `.tmp/prompt15-runtime-${process.pid}.stderr.log`), 'a');
    const child = spawn(process.execPath, ['tools/prompt15-runtime.mjs', 'resume', '--run', run, ...(codex ? ['--codex', codex] : [])], {cwd: root, detached: true, windowsHide: true, env: {...process.env, PROMPT15_PRESERVE_EXECUTION_HOLD: preserveExecutionHold ? '1' : '0'}, stdio: ['ignore', output, errors]});
    fs.closeSync(output); fs.closeSync(errors);
    child.once('error', error => { update.status = 'restart_failed'; update.error = error.message; save(); finish(); });
    child.unref();
    update.resumedSupervisorPid = child.pid; update.resumedAt = new Date().toISOString(); update.status = 'resuming_runtime'; started = true; save();
  } catch (error) { update.error = error.message; save(); }
  finally { busy = false; }
}
save();
await check();
