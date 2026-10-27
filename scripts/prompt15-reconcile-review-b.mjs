import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {atomicJSON, fileIdentity, validateIdentities} from './prompt15-orchestrator/protocol.mjs';
import {captureProductTarget, validateProductTarget} from './prompt15-orchestrator/product-target.mjs';

const RUN = 'reports/prompt15/orchestration/20261015T115644-KST-eae9ad74';
const REVIEW = 'reports/prompt15/15-REVIEW-B.json';
const RECHECK = 'reports/prompt15/15-review-b-recheck.json';
const DECISION = 'reports/prompt15/15-03-policy-decision.json';
const VALIDATION = 'reports/prompt15/15-03-validation.json';
const POLICY = 'reports/prompt15/prompt15-cell-experiment-v6.json';
const EXPECTED = {
  review: 'a88cd0ad88ae7bf2bbaabb83cb57b6dc58f880480ffd8aaee006ad110b455183',
  recheck: '8c1ac1315f03bebf0400b0da4e6bc088cdeb173125066533c26a4d52b5500c35',
  decision: '1cb1047e25bb32901539d9c876dbc22027973d778f155a44ba96204dd841c048',
  validation: 'bc3e016e1559973ddcf56312b5bdd14c9441eb44cf49171e91ab962fa87dd44f',
  policy: 'beadd1031fe22c781dfbab24f6307bd13f16c994ec0df298bc3d2a4d7f93cde0',
};
const STAGES = ['15-14', '15-15', '15-16', '15-17'];
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const resolve = (root, relative) => path.join(root, relative);

export function validateReviewBCheckpoint(root, state) {
  const pins = {
    review: fileIdentity(root, REVIEW), recheck: fileIdentity(root, RECHECK),
    decision: fileIdentity(root, DECISION), validation: fileIdentity(root, VALIDATION),
    policy: fileIdentity(root, POLICY),
  };
  for (const [name, pin] of Object.entries(pins)) {
    if (pin.sha256 !== EXPECTED[name]) throw Error(`REVIEW B ${name} bytes changed`);
  }
  const review = read(resolve(root, REVIEW));
  const recheck = read(resolve(root, RECHECK));
  if (review.review !== 'B' || review.status !== 'pass' || review.resumeAt !== '15-18' ||
      review.selectedCandidate !== 'adaptive-12-24-v6') throw Error('REVIEW B checkpoint is not the approved v6 PASS');
  if (recheck.review !== 'B' || recheck.status !== 'pass' || recheck.resumeAt !== '15-18' ||
      recheck.selectedCandidate !== review.selectedCandidate || recheck.failures?.length) throw Error('Independent REVIEW B recheck is not PASS');
  for (const id of ['15-11', '15-12', '15-13', ...STAGES]) {
    if (review.stages?.[id]?.status !== 'pass' || recheck.stages?.[id]?.status !== 'pass') throw Error(`${id} is not PASS in both REVIEW B records`);
  }
  if (review.checkpoint?.sha256 !== EXPECTED.decision || review.validation?.sha256 !== EXPECTED.validation ||
      review.independentRecheck?.sha256 !== EXPECTED.recheck || review.stages['15-12'].evidence?.sha256 !== EXPECTED.policy)
    throw Error('REVIEW B internal identity pins disagree');
  if (state.status !== 'stopped' || state.review !== 'B') throw Error('Controller must be stopped at REVIEW B');
  if (state.tasks?.['15-18']?.status !== 'pending' || state.tasks?.['15-18']?.attempt !== 0) throw Error('15-18 is not an untouched pending task');
  for (const id of STAGES) {
    const row = state.tasks?.[id];
    if (!row || row.status !== 'pending' || !row.verification || !row.passedAt || !row.target) throw Error(`${id} does not retain its historical verified candidate`);
  }
  for (const id of Object.keys(state.tasks ?? {}).filter(id => Number(id.slice(3)) >= 19)) {
    if (state.tasks[id].status !== 'pending' || state.tasks[id].attempt !== 0) throw Error(`${id} has already started`);
  }
  return {pins, review, recheck};
}

function progressText(state, plan) {
  const passed = Object.values(state.tasks).filter(row => row.status === 'pass').length;
  return [
    'PROMPT 15 — 48개 독립 태스크 오케스트레이션',
    `상태: ${state.status} | REVIEW ${state.review} | 단계: ${state.phase}`,
    `검증 PASS: ${passed}/48`,
    '현재 태스크: -',
    `다음 동작: ${state.nextAction}`,
    `제품 기준 후보: ${state.approvedProductTarget.productRoot}`,
    `REVIEW: A ${state.certificates.A ? 'PASS' : '대기'} → B ${state.certificates.B ? 'PASS' : '대기'} → C 대기 → D 대기 → E 대기 → F 대기`,
    '', '태스크 상태',
    ...plan.tasks.map(task => `${task.id} [${state.tasks[task.id].status}] ${task.title}`),
    '', `갱신: ${state.updatedAt}`,
  ].join('\n') + '\n';
}

export function reconcileReviewB(root, {dryRun = false} = {}) {
  const run = resolve(root, RUN);
  const stateFile = path.join(run, 'state.json');
  const state = read(stateFile);
  const {pins} = validateReviewBCheckpoint(root, state);
  const key = EXPECTED.review.slice(0, 16);
  const directory = path.join(run, 'control', `review-b-reconciliation-${key}`);
  if (dryRun) return {status: 'validated', run: RUN, pins, directory};
  if (fs.existsSync(directory)) throw Error('Preserve existing REVIEW B reconciliation root');
  fs.mkdirSync(directory, {recursive: true});
  fs.copyFileSync(stateFile, path.join(directory, 'before-state.json'));
  const beforeState = fileIdentity(root, path.join(directory, 'before-state.json'));
  const inputsFile = path.join(directory, 'input-manifest.json');
  atomicJSON(inputsFile, {version: 1, inputs: Object.values(pins)});
  const productRoot = path.join(run, 'work', 'review-B-15');
  const target = captureProductTarget(root, productRoot, path.join(directory, 'target'), {
    review: 'B', artifactManifest: inputsFile,
  });
  validateProductTarget(root, target);
  const previousActive = structuredClone(state.activeTurns ?? {});
  const previousGuardian = {
    activeAuditId: state.guardian?.activeAuditId ?? null,
    activeRepairId: state.guardian?.activeRepairId ?? null,
    lastControllerRepair: state.guardian?.lastControllerRepair ?? null,
  };
  for (const id of STAGES) {
    const row = state.tasks[id];
    row.status = 'pass';
    row.acceptedTarget = target;
    row.reconciledReviewB = {source: pins.review, independentRecheck: pins.recheck};
  }
  state.certificates ??= {};
  state.certificates.B = {verification: pins.review, target, independentRecheck: pins.recheck};
  state.approvedProductTarget = target;
  state.review = 'C';
  state.reviewWorkspace = null;
  state.productRoot = target.productRoot;
  state.status = 'stopped';
  state.phase = 'stopped';
  state.currentTasks = [];
  state.error = null;
  state.nextAction = 'REVIEW B PASS reconciled from current bytes; resume at 15-18 only';
  state.activeReviewAttempt = null;
  state.activeTurns = {};
  state.activeOperations = {};
  delete state.activeOperation;
  if (state.guardian) {
    delete state.guardian.activeAuditId;
    delete state.guardian.activeRepairId;
    state.guardian.reconciledStoppedRepair = {at: new Date().toISOString(), previousActive, previousGuardian};
  }
  state.reviewBCheckpointReconciliation = {
    version: 1, authorization: 'User explicitly requested controller REVIEW B PASS reconciliation.',
    source: pins.review, independentRecheck: pins.recheck, beforeState,
  };
  state.updatedAt = new Date().toISOString();
  atomicJSON(stateFile, state);
  const plan = read(resolve(root, 'automation/prompt15/task-plan.json'));
  fs.writeFileSync(path.join(run, 'progress.txt'), progressText(state, plan), 'utf8');
  const afterState = fileIdentity(root, stateFile);
  const receiptFile = path.join(directory, 'receipt.json');
  atomicJSON(receiptFile, {
    version: 1, kind: 'prompt15-review-b-controller-reconciliation', status: 'pass',
    authorization: 'User explicitly requested controller REVIEW B PASS reconciliation.',
    reviewB: pins.review, independentRecheck: pins.recheck, policy: pins.policy,
    checkpoint: pins.decision, validation: pins.validation, beforeState, afterState,
    adoptedTarget: target, reconciledTasks: STAGES, resumeAt: '15-18',
    laterTasksStarted: false, reviewCDecisionMade: false,
    preservedStoppedOperation: {activeTurns: previousActive, guardian: previousGuardian},
    createdAt: state.updatedAt,
  });
  validateIdentities(root, [beforeState, afterState, ...Object.values(pins), target.manifest]);
  return {status: 'pass', receipt: fileIdentity(root, receiptFile), state: afterState, target, resumeAt: '15-18'};
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = reconcileReviewB(process.cwd(), {dryRun: process.argv.includes('--dry-run')});
  console.log(JSON.stringify(result, null, 2));
}
