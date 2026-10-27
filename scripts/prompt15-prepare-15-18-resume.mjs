import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {atomicJSON, fileIdentity, validateIdentities} from './prompt15-orchestrator/protocol.mjs';

const RUN = 'reports/prompt15/orchestration/20261015T115644-KST-eae9ad74';
const V18 = 'reports/prompt15/15-18-v18-independent-fail-2919b8dd8c58e7a4540a.json';
const EXPECTED_V18 = 'a5e5e388aed2360504eee2cb2b50558a51cd0839bf6e14d45bd0d02b78ebcc15';
const EXPECTED_REVIEW_B = 'a88cd0ad88ae7bf2bbaabb83cb57b6dc58f880480ffd8aaee006ad110b455183';
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const samePin = (left, right) => left?.path === right?.path && left?.sha256 === right?.sha256 && left?.byteLength === right?.byteLength;

function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

export function prepare1518Resume(root) {
  const run = path.join(root, RUN);
  const stateFile = path.join(run, 'state.json');
  const state = read(stateFile);
  const v18 = fileIdentity(root, V18);
  const reviewB = fileIdentity(root, 'reports/prompt15/15-REVIEW-B.json');
  const row = state.tasks?.['15-18'];

  if (alive(state.controllerPid) || alive(state.runtimeSupervisorPid)) throw Error('Prompt 15 runtime is still alive');
  if (state.status !== 'stopped' || state.review !== 'C' || state.certificates?.C) throw Error('Controller is not stopped before REVIEW C at 15-18');
  if (reviewB.sha256 !== EXPECTED_REVIEW_B || state.certificates?.B?.verification?.sha256 !== EXPECTED_REVIEW_B) throw Error('REVIEW B PASS bytes changed');
  if (v18.sha256 !== EXPECTED_V18 || !samePin(row?.verification, v18) || row?.status !== 'blocked' || row?.attempt !== 0) throw Error('Preserved V18 FAIL state changed');
  validateIdentities(root, [state.certificates.B.verification, state.certificates.B.independentRecheck, state.certificates.B.target.manifest, v18]);
  for (let number = 1; number <= 17; number++) {
    const id = `15-${String(number).padStart(2, '0')}`;
    if (state.tasks[id]?.status !== 'pass') throw Error(`${id} is not PASS`);
  }
  for (let number = 19; number <= 48; number++) {
    const id = `15-${String(number).padStart(2, '0')}`;
    if (state.tasks[id]?.status !== 'pending' || state.tasks[id]?.attempt !== 0) throw Error(`${id} has already started`);
  }

  const receiptDirectory = path.join(run, 'control', `resume-15-18-${EXPECTED_V18.slice(0, 16)}`);
  if (fs.existsSync(receiptDirectory)) throw Error('15-18 resume receipt already exists');
  fs.mkdirSync(receiptDirectory, {recursive: true});
  fs.copyFileSync(stateFile, path.join(receiptDirectory, 'before-state.json'));
  const beforeState = fileIdentity(root, path.join(receiptDirectory, 'before-state.json'));

  row.failureHistory ??= [];
  row.failureHistory.push({
    verdict: row.verdict,
    verification: row.verification,
    verifier: row.v18Verifier,
    blocker: row.blocker,
    blockedAt: row.blockedAt,
  });
  row.status = 'repair';
  delete row.verdict;
  delete row.v18Verifier;
  delete row.blocker;
  delete row.blockedAt;

  const reconciledIncident = state.scopedTaskRepair?.completedAt && samePin(state.pendingExecutionIncident, state.scopedTaskRepair.historicalExecutionIncident)
    ? state.pendingExecutionIncident : null;
  if (reconciledIncident) {
    state.lastExecutionIncident = reconciledIncident;
    delete state.pendingExecutionIncident;
  }
  state.phase = 'prepare';
  state.currentTasks = [];
  state.error = null;
  state.nextAction = 'Resume 15-18 repair from the frozen REVIEW B target; 15-19 and later remain pending';
  state.updatedAt = new Date().toISOString();
  state.resume1518 = {version: 1, authorizedAt: state.updatedAt, sourceV18: v18, reviewB: state.certificates.B.verification};
  atomicJSON(stateFile, state);

  const afterState = fileIdentity(root, stateFile);
  const receiptFile = path.join(receiptDirectory, 'receipt.json');
  atomicJSON(receiptFile, {
    version: 1,
    kind: 'prompt15-task-resume',
    taskId: '15-18',
    status: 'repair',
    authorization: 'User explicitly requested orchestration resume at 15-18.',
    reviewB: state.certificates.B.verification,
    sourceV18: v18,
    beforeState,
    afterState,
    reconciledHistoricalIncident: reconciledIncident,
    laterTasksStarted: false,
    createdAt: state.updatedAt,
  });
  validateIdentities(root, [beforeState, afterState, v18, state.certificates.B.verification]);
  return {status: 'prepared', taskId: '15-18', receipt: fileIdentity(root, receiptFile), state: afterState};
}

export function clearStale1518RuntimeOwner(root) {
  const run = path.join(root, RUN);
  const stateFile = path.join(run, 'state.json');
  const state = read(stateFile);
  if (state.review !== 'C' || state.tasks?.['15-18']?.status !== 'repair') throw Error('Controller is not prepared to resume 15-18');
  if (alive(state.controllerPid) || alive(state.runtimeSupervisorPid)) throw Error('Prompt 15 runtime is still alive');
  const sourceState = fileIdentity(root, stateFile);
  const directory = path.join(run, 'control', `runtime-owner-reset-${sourceState.sha256.slice(0, 16)}`);
  if (fs.existsSync(directory)) throw Error('Runtime owner reset receipt already exists');
  fs.mkdirSync(directory, {recursive: true});
  fs.copyFileSync(stateFile, path.join(directory, 'before-state.json'));
  const beforeState = fileIdentity(root, path.join(directory, 'before-state.json'));
  const staleOwners = {controllerPid: state.controllerPid ?? null, runtimeSupervisorPid: state.runtimeSupervisorPid ?? null};
  delete state.controllerPid;
  delete state.runtimeSupervisorPid;
  state.status = 'stopped';
  state.phase = 'prepare';
  state.error = null;
  state.recoveryAttempts = 0;
  state.currentTasks = [];
  state.nextAction = 'Resume 15-18 repair from the frozen REVIEW B target; 15-19 and later remain pending';
  state.updatedAt = new Date().toISOString();
  state.lastRuntimeOwnerReset = {version: 1, at: state.updatedAt, staleOwners, reason: 'Verified dead runtime owners after interrupted background launch.'};
  atomicJSON(stateFile, state);
  const afterState = fileIdentity(root, stateFile);
  const receiptFile = path.join(directory, 'receipt.json');
  atomicJSON(receiptFile, {version: 1, kind: 'prompt15-runtime-owner-reset', taskId: '15-18', staleOwners, beforeState, afterState, createdAt: state.updatedAt});
  validateIdentities(root, [beforeState, afterState]);
  return {status: 'prepared', taskId: '15-18', receipt: fileIdentity(root, receiptFile), state: afterState};
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const action = process.argv.includes('--clear-stale-owner') ? clearStale1518RuntimeOwner : prepare1518Resume;
  console.log(JSON.stringify(action(process.cwd()), null, 2));
}
