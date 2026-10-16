import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  GATES, VERIFICATION_SCHEMA, SUPERVISION_SCHEMA, IMPLEMENTATION_SCHEMA,
  fileIdentity, validateVerification, validateDecision, validateBranchPlans, inside, normalizeVerification, atomicJSON, sourceSnapshot,
  IMPLEMENTATION_HANDOFF_SCHEMA, validateImplementationHandoff,
  TASK_RELAY_SCHEMA, TASK_VERIFICATION_SCHEMA, TASK_GATES, validateTaskVerification,
} from './protocol.mjs';
import {Workflow} from './workflow.mjs';
import {AppServer} from './app-server.mjs';
import {spawn} from 'node:child_process';
import {recordReviewResult, recordTaskResult, strategyInstruction, classifyFailure, TERMINAL_STATUSES, RUNTIME_VERSION} from './policy.mjs';
import {taskResponsePath} from '../../tools/prompt15-runtime-update-core.mjs';
import {prepareWorkspace, planWorkspaceMerge, applyWorkspaceMerge} from './workspaces.mjs';
import {VerificationStages, identity as stageIdentity} from './verification-stages.mjs';
import {CompactVerificationStages} from './verification-stages-compact.mjs';

const fixtureCleanup = new Map();
function fixture(t) {
  const base = path.resolve('.tmp/prompt15-orchestrator-tests');
  fs.mkdirSync(base, {recursive: true});
  const root = fs.mkdtempSync(path.join(base, 'test-'));
  fixtureCleanup.set(root, []);
  t.after(async () => {
    for (const cleanup of fixtureCleanup.get(root)) await cleanup();
    fixtureCleanup.delete(root);
    assert.ok(inside(base, root));
    fs.rmSync(root, {recursive: true, force: true});
  });
  return root;
}

function report(root, review, directory, verdict = 'pass') {
  fs.mkdirSync(directory, {recursive: true});
  const relative = path.relative(root, path.join(directory, 'executed-checks.json')).replaceAll('\\', '/');
  fs.writeFileSync(path.join(root, relative), JSON.stringify({review, exitCode: verdict === 'pass' ? 0 : 1}));
  if (!fs.existsSync(path.join(root, 'input.txt'))) fs.writeFileSync(path.join(root, 'input.txt'), 'fixed candidate');
  return {
    review, verdict, summary: verdict, nonPassKind: verdict === 'pass' ? 'none' : 'implementation',
    checks: GATES[review].map(id => ({id, status: verdict, evidencePaths: [relative], detail: id})),
    evidence: [fileIdentity(root, relative)], inputs: [fileIdentity(root, 'input.txt')],
    commands: [{command: 'independent check', exitCode: verdict === 'pass' ? 0 : 1, evidencePath: relative}],
    failures: verdict === 'pass' ? [] : ['Actual failing gate'], suggestedRepairPrompt: 'Reproduce the failure, repair the cause, preserve the fixed policy, and regenerate the evidence.',
  };
}

test('old PASS, missing gates, altered bytes and escaped evidence never certify a review', t => {
  const root = fixture(t), directory = path.join(root, 'fresh');
  const valid = report(root, 'C', directory);
  assert.equal(validateVerification(root, directory, 'C', valid).verdict, 'pass');
  assert.throws(() => validateVerification(root, path.join(root, 'another-round'), 'C', valid), /fresh/);
  assert.throws(() => validateVerification(root, directory, 'C', {...valid, checks: valid.checks.slice(1)}), /Missing required gate/);
  assert.throws(() => validateVerification(root, directory, 'C', {...valid, verdict: 'pass', failures: ['not executed']}), /zero failures/);
  const outside = structuredClone(valid);
  outside.evidence[0].path = '../outside.json';
  assert.throws(() => validateVerification(root, directory, 'C', outside), /escapes/);
  fs.appendFileSync(path.join(root, valid.evidence[0].path), 'altered');
  assert.throws(() => validateVerification(root, directory, 'C', valid), /bytes changed/);
});

test('a brief Windows state-file lock retries atomic replacement without truncating the old state', t => {
  const root = fixture(t), file = path.join(root, 'state.json');
  atomicJSON(file, {value: 'old'});
  const rename = fs.renameSync;
  let attempts = 0;
  fs.renameSync = (source, destination) => {
    if (destination === file && ++attempts < 3) {
      assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).value, 'old');
      throw Object.assign(Error('Temporary Windows lock'), {code: 'EPERM'});
    }
    return rename(source, destination);
  };
  try { atomicJSON(file, {value: 'new'}); } finally { fs.renameSync = rename; }
  assert.equal(attempts, 3);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).value, 'new');
});

test('supervisor cannot advance a failed review, skip a gate, or dispatch after F', () => {
  const decision = {review: 'C', action: 'advance', repairReview: 'C', repairPrompt: '', branchPlans: []};
  assert.throws(() => validateDecision('C', {verdict: 'fail'}, decision), /concrete repair/);
  assert.throws(() => validateDecision('C', {verdict: 'fail'}, {...decision, action: 'repair', repairReview: 'D', repairPrompt: 'Fix'}), /skip forward/);
  assert.throws(() => validateDecision('F', {verdict: 'pass'}, {...decision, review: 'F', repairReview: 'F'}), /past F/);
  assert.equal(validateDecision('F', {verdict: 'pass'}, {...decision, review: 'F', repairReview: 'F', action: 'wait'}).action, 'wait');
});

test('report-relative evidence is normalized without bypassing hash checks or project boundaries', t => {
  const root = fixture(t), directory = path.join(root, 'fresh');
  const original = report(root, 'C', directory, 'fail');
  const relative = structuredClone(original);
  relative.evidence[0].path = 'executed-checks.json';
  relative.inputs[0].path = path.join(root, 'input.txt');
  for (const check of relative.checks) check.evidencePaths = ['executed-checks.json'];
  relative.commands[0].evidencePath = 'executed-checks.json';
  const normalized = normalizeVerification(root, directory, relative);
  assert.equal(normalized.evidence[0].path, 'fresh/executed-checks.json');
  assert.equal(normalized.inputs[0].path, 'input.txt');
  assert.equal(validateVerification(root, directory, 'C', normalized).verdict, 'fail');
  const invalid = structuredClone(relative);
  invalid.evidence[0].path = '../../../outside.txt';
  assert.throws(() => normalizeVerification(root, directory, invalid), /within project/);
});

test('parallel file ownership rejects shared files, containing directories and reserved paths', t => {
  const root = fixture(t);
  const plans = [
    {checkpoint: '15-5', instructions: 'lookup', writablePaths: ['src/lookup']},
    {checkpoint: '15-6', instructions: 'migration', writablePaths: ['src/migration']},
  ];
  assert.equal(validateBranchPlans(root, plans).length, 2);
  assert.throws(() => validateBranchPlans(root, [plans[0], {...plans[1], writablePaths: ['src/lookup/shared.ts']}]), /overlaps/);
  assert.throws(() => validateBranchPlans(root, [plans[0], {...plans[1], writablePaths: ['../other']}]), /escapes/);
  assert.throws(() => validateBranchPlans(root, [plans[0], {...plans[1], writablePaths: ['automation/prompt15/config.json']}]), /Reserved/);
});

class FakeServer {
  constructor(root, {failFirstC = false, failCCount = 0, failBCount = 0, failFirstD = false, branchArtifacts = false, modifyDuringVerify = false, failedCAdvance = false, blockFirstImplementation = false, handoffAction = 'repair', taskFailFirst = false, taskFailCount = 0, partialTaskFirst = false, omitCombinedGate = false, omitCombinedPromptPin = false, missingRepairCoverage = false, interruptFirstImplementation = null} = {}) {
    this.root = root;
    this.options = {failFirstC, failCCount, failBCount, failFirstD, branchArtifacts, modifyDuringVerify, failedCAdvance, blockFirstImplementation, handoffAction, taskFailFirst, taskFailCount, partialTaskFirst, omitCombinedGate, omitCombinedPromptPin, missingRepairCoverage, interruptFirstImplementation};
    this.runs = [];
    this.threads = [];
    this.next = 0;
    this.verifications = 0;
    this.concurrentBranches = 0;
    this.maximumBranches = 0;
    this.implementations = 0;
    this.handoffs = 0;
    this.names = [];
    this.deleted = [];
    this.reviewCounts = {};
    this.taskVerifications = 0;
  }
  async initialize() {}
  async request(method, params) {
    if (method === 'thread/name/set') { this.names.push(params); return {}; }
    if (method === 'thread/delete') { this.deleted.push(params.threadId); return {}; }
    if (method === 'thread/start') {
      const id = `thread-${++this.next}`;
      this.threads.push({id, params});
      return {thread: {id}};
    }
    assert.equal(method, 'thread/resume');
    return {thread: {id: params.threadId}};
  }
  async runTurn(threadId, input, schema, overrides) {
    const role = [VERIFICATION_SCHEMA, TASK_VERIFICATION_SCHEMA].includes(schema) ? 'verifier' : [SUPERVISION_SCHEMA, IMPLEMENTATION_HANDOFF_SCHEMA, TASK_RELAY_SCHEMA].includes(schema) ? 'supervisor' : 'implementer';
    assert.ok(schema === IMPLEMENTATION_SCHEMA || role !== 'implementer');
    const dispatched = {role, threadId, input, overrides, schema};
    this.runs.push(dispatched);
    let value;
    if (schema === TASK_VERIFICATION_SCHEMA) {
      const review = input.match(/현재 REVIEW ([ABCDEF])/)[1];
      const taskId = input.match(/taskId: (.*)/)[1];
      const implementation = JSON.parse(fs.readFileSync(path.join(this.root, taskId), 'utf8')).result;
      this.taskVerifications++;
      const verdict = this.taskVerifications <= (this.options.taskFailCount || Number(this.options.taskFailFirst)) ? 'fail' : implementation.status === 'blocked' || input.includes('원본 구현 프롬프트 존재: false') ? 'blocked' : 'pass';
      value = {...report(this.root, review, overrides.cwd, verdict), taskId, readyForReview: verdict === 'pass' && !taskId.includes('branch-') && !(this.options.partialTaskFirst && this.taskVerifications === 1)};
      const requestFile = path.join(this.root, taskId.replace(/-response\.json$/, '-request.txt'));
      if (fs.existsSync(requestFile)) value.inputs.push(fileIdentity(this.root, requestFile));
      value.checks = TASK_GATES.map(id => ({id, status: verdict, evidencePaths: [value.evidence[0].path], detail: id}));
      this.lastTaskVerification = value;
    } else if (schema === TASK_RELAY_SCHEMA) {
      value = {review: input.match(/현재 REVIEW ([ABCDEF])/)[1], taskId: input.match(/taskId: (.*)/)[1], verificationPrompt: 'Check every instruction in the original prompt and the actual bytes before another implementation assignment'};
    } else if (role === 'verifier') {
      const review = input.match(/현재 REVIEW ([ABCDEF])/)[1];
      this.verifications++;
      this.reviewCounts[review] = (this.reviewCounts[review] ?? 0) + 1;
      const fail = review === 'A' && this.reviewCounts.A <= (this.options.failACount ?? 0) || review === 'B' && this.reviewCounts.B <= this.options.failBCount || review === 'C' && this.reviewCounts.C <= (this.options.failCCount || Number(this.options.failFirstC)) || review === 'D' && this.options.failFirstD && this.reviewCounts.D === 1;
      const verdict = fail ? 'fail' : 'pass';
      value = report(this.root, review, overrides.cwd, verdict);
      if (input.includes('이번 검증은 전체 REVIEW와 원본 구현 프롬프트 수행을 함께 판정한다.')) {
        const taskId = input.match(/taskId: (.*)/)[1];
        const implementation = JSON.parse(fs.readFileSync(path.join(this.root, taskId), 'utf8')).result;
        if (implementation.status === 'blocked') value = report(this.root, review, overrides.cwd, 'blocked');
        value.checks.push(...TASK_GATES.map(id => ({id, status:value.verdict, evidencePaths:[value.evidence[0].path], detail:id})));
        if (this.options.omitCombinedGate) value.checks.pop();
        if (!this.options.omitCombinedPromptPin) value.inputs.push(fileIdentity(this.root, taskId.replace(/-response\.json$/, '-request.txt')));
      }
      if (this.options.modifyDuringVerify) fs.writeFileSync(path.join(this.root, 'src', 'altered.ts'), 'not independent');
      this.lastVerification = value;
    } else if (role === 'supervisor') {
      if (schema === IMPLEMENTATION_HANDOFF_SCHEMA) {
        this.handoffs++;
        const control = input.includes('사용자가 기존 총괄 세션에 REVIEW') || input.includes('운영 전환 기록: REVIEW');
        const action = !control && this.lastTaskVerification?.readyForReview ? 'reverify' : this.handoffs === 1 ? this.options.handoffAction : 'repair';
        const review = input.match(/(?:구현 세션이 REVIEW |운영 전환 기록: REVIEW |사용자가 기존 총괄 세션에 REVIEW )([ABCDEF])/)[1];
        value = {action, repairReview: review, summary: 'Supervisor receives implementation report', repairPrompt: 'Integrate the generic generator, preserve frozen bounds, then return for independent verification', verificationPrompt: 'Independently verify the current REVIEW B policy and dependency closure', blockerKind: action === 'blocked' ? 'user_decision' : 'none', blockerEvidence: action === 'blocked' ? 'Explicit user policy decision is required by the fixed input contract' : ''};
      }
      else if (input.includes('새 실행 시작:')) value = {review:'A', action:'repair', repairReview:'A', summary:'Fresh A assignment', repairPrompt:'Implement every 15-1/15-2 gate before independent review', branchPlans:[], blockerKind:'none'};
      else if (input.includes('병렬 구현 결과를 함께')) value = {review: 'D', action: 'repair', repairReview: 'D', summary: 'Integrate', repairPrompt: 'Integrate agreed contracts', branchPlans: []};
      else {
        const v = this.lastVerification;
        value = {review: v.review, action: v.verdict === 'pass' ? v.review === 'F' ? 'wait' : 'advance' : this.options.failedCAdvance ? 'advance' : 'repair', repairReview: v.review, summary: 'Supervisor', repairPrompt: v.suggestedRepairPrompt, branchPlans: v.review === 'C' && v.verdict === 'pass' ? [
          {checkpoint: '15-5', instructions: 'Implement lookup with agreed contract', writablePaths: ['src/lookup.ts']},
          {checkpoint: '15-6', instructions: 'Implement migration with agreed contract', writablePaths: ['src/migration.ts']},
        ] : []};
      }
    } else {
      this.implementations++;
      if (this.options.interruptFirstImplementation && this.implementations === 1) {
        fs.writeFileSync(path.join(this.root,'src','unfinished.ts'),'preserved incomplete implementation');
        throw Error(this.options.interruptFirstImplementation === 'timeout' ? `Turn timeout for ${threadId}; no completion was certified` : 'Codex app-server exited unexpectedly');
      }
      const branch = input.includes('다른 분기와 동시에');
      if (branch) {
        this.concurrentBranches++;
        this.maximumBranches = Math.max(this.maximumBranches, this.concurrentBranches);
        await new Promise(resolve => setTimeout(resolve, 20));
        this.concurrentBranches--;
      }
      value = {status: this.options.blockFirstImplementation && this.implementations === 1 ? 'blocked' : 'completed', summary: 'Report REVIEW B impact to supervisor', changedFiles: [], artifactPaths: [], commands: [], remainingIssues: []};
      if (branch && this.options.branchArtifacts) {
        fs.writeFileSync(path.join(overrides.cwd, '.reports/result.json'), JSON.stringify({threadId}));
        value.artifactPaths = ['.reports/result.json'];
      }
    }
    dispatched.result = value;
    if ([SUPERVISION_SCHEMA, IMPLEMENTATION_HANDOFF_SCHEMA].includes(schema)) {
      value.repairCoverage = [...GATES[value.action === 'advance' && value.review === 'A' ? 'B' : value.action === 'advance' && value.review === 'B' ? 'C' : value.repairReview ?? value.review]];
      if (this.options.missingRepairCoverage) value.repairCoverage.pop();
    }
    return {turnId: `turn-${this.runs.length}`, text: JSON.stringify(value), value};
  }
}

function workflowFixture(t, options = {}) {
  const root = fixture(t);
  fs.mkdirSync(path.join(root, 'src'));
  const roles = {};
  for (const role of ['supervisor', 'implementer', 'verifier']) {
    fs.writeFileSync(path.join(root, `${role}.txt`), `Independent ${role}`);
    roles[role] = {promptPath: `${role}.txt`, model: null, effort: null};
  }
  fs.writeFileSync(path.join(root, 'prompt.txt'), 'Prompt 15 fixed requirements');
  fs.writeFileSync(path.join(root, 'rules.txt'), 'C failure first; F then standby');
  const config = {promptPath: 'prompt.txt', rulesPath: 'rules.txt', approvalPolicy: 'on-request', approvalsReviewer: 'auto_review', maxRepairAttempts: null, roles, startReview:options.startReview, implementationUnit:options.reviewUnits ? 'review' : 'checkpoint'};
  const server = new FakeServer(root, options);
  const directory = path.join(root, 'reports/run');
  return {root, config, server, directory, workflow: new Workflow({root, directory, config, server})};
}

test('fresh A starts with a complete supervisor assignment and implementation, then approves A before B', async t => {
  const {workflow,server}=workflowFixture(t,{reviewUnits:true,startReview:'A'});
  const result=await workflow.run();
  assert.equal(result.status,'standby',result.error);
  assert.deepEqual(server.runs.slice(0,4).map(run=>run.schema),[SUPERVISION_SCHEMA,IMPLEMENTATION_SCHEMA,TASK_RELAY_SCHEMA,VERIFICATION_SCHEMA]);
  assert.equal(server.runs[3].result.review,'A');
  for(const gate of GATES.A) assert.ok(server.runs[1].input.includes(gate));
  assert.deepEqual(server.runs.filter(run=>run.schema===VERIFICATION_SCHEMA).map(run=>run.result.review),['A','B','C','D','E','F']);
  assert.equal(result.startupPending,false);
  assert.equal(result.repairAttempts,0,'startup is not an implementation failure');
  assert.ok(result.certificates.A); assert.ok(result.prerequisiteCertificates.B);
  assert.equal(result.productionCutover,'not-executed-by-user-instruction');
});

test('fresh A failure is repaired within A and cannot skip to B', async t => {
  const {workflow,server}=workflowFixture(t,{reviewUnits:true,startReview:'A'});
  server.options.failACount=1;
  const result=await workflow.run();
  assert.equal(result.status,'standby',result.error);
  assert.deepEqual(server.runs.filter(run=>run.schema===VERIFICATION_SCHEMA).slice(0,3).map(run=>run.result.review),['A','A','B']);
  assert.equal(result.reviewStrikes.A.totalFailures,1);
});

test('interrupted fresh A assignment resumes the original scope without duplicating startup or inventing PASS', async t => {
  const {root,config,directory,workflow,server}=workflowFixture(t,{reviewUnits:true,startReview:'A',interruptFirstImplementation:'timeout'});
  const interrupted=await workflow.run();
  assert.equal(interrupted.status,'recovering',interrupted.error);
  assert.equal(server.verifications,0); assert.ok(interrupted.interruptedImplementation);
  const resumed=new Workflow({root,directory,config,server,resume:true});
  const result=await resumed.run();
  assert.equal(result.status,'standby',result.error);
  assert.equal(server.runs.filter(run=>run.input.includes('새 실행 시작:')).length,1);
  assert.equal(server.runs.find(run=>run.schema===VERIFICATION_SCHEMA).result.review,'A');
});

test('missing A approval invalidates B and later approvals in a fresh run', t => {
  const {workflow}=workflowFixture(t,{reviewUnits:true,startReview:'A'});
  workflow.state.review='C'; workflow.state.prerequisiteCertificates={B:{}}; workflow.state.certificates.C={};
  assert.equal(workflow.certificatesStillValid(),false);
  assert.equal(workflow.state.review,'A');
  assert.equal(workflow.state.prerequisiteCertificates.B,undefined); assert.equal(workflow.state.certificates.C,undefined);
});

test('review units cover every B gate and use one combined independent review after implementation', async t => {
  const {workflow, server} = workflowFixture(t, {reviewUnits:true, failBCount:1});
  workflow.state.review = 'B';
  const result = await workflow.run();
  assert.equal(result.status,'standby',result.error);
  const firstImplementation = server.runs.findIndex(run => run.role === 'implementer');
  const implementation = server.runs[firstImplementation];
  for (const gate of GATES.B) assert.ok(implementation.input.includes(gate));
  assert.match(implementation.input,/AIA\/LIE/);
  assert.match(implementation.input,/필수 24개국/);
  assert.equal(server.runs[firstImplementation+1].schema,TASK_RELAY_SCHEMA);
  assert.equal(server.runs[firstImplementation+2].schema,VERIFICATION_SCHEMA);
  assert.equal(server.runs[firstImplementation+3].schema,SUPERVISION_SCHEMA);
  for (const gate of [...GATES.B,...TASK_GATES]) assert.ok(server.runs[firstImplementation+2].result.checks.some(check => check.id === gate));
  assert.ok(server.runs[firstImplementation+2].input.includes(implementation.input));
  assert.equal(server.reviewCounts.B,2,'initial B failure and one complete B verification');
  assert.equal(server.runs.filter(run => run.schema === TASK_VERIFICATION_SCHEMA && run.result.review === 'B').length,0);
  assert.ok(result.prerequisiteCertificates.B);
  assert.equal(result.runtimeVersion,RUNTIME_VERSION);
  assert.equal(result.implementationUnit,'review');
  assert.equal(result.productionCutover,'not-executed-by-user-instruction');
});

test('each combined review failure counts once and retains the review implementation session', async t => {
  const {workflow,server} = workflowFixture(t,{reviewUnits:true,failCCount:2});
  const result = await workflow.run();
  assert.equal(result.status,'standby',result.error);
  assert.equal(result.reviewStrikes.C.totalFailures,2);
  const repairs = server.runs.filter(run => run.role === 'implementer' && run.input.includes('총괄이 전달하는 REVIEW C 보완'));
  assert.equal(repairs.length,2);
  assert.equal(repairs[0].threadId,repairs[1].threadId);
  const failed = result.taskVerificationHistory.find(item => item.fullReview && item.verdict === 'fail');
  assert.ok(failed);
  recordTaskResult(result,JSON.parse(fs.readFileSync(path.join(workflow.root,failed.path),'utf8')),failed.path);
  assert.equal(result.reviewStrikes.C.totalFailures,2,'recovery does not double count the combined task/review failure');
});

for (const interruption of ['timeout','transport']) test(`an unfinished ${interruption} resumes implementation through the supervisor before verification`, async t => {
  const {workflow,server,root,directory,config} = workflowFixture(t,{reviewUnits:true,failFirstC:true,interruptFirstImplementation:interruption});
  const interrupted = await workflow.run();
  assert.equal(interrupted.status,'recovering');
  const original = server.runs.at(-1);
  assert.equal(original.role,'implementer');
  assert.equal(interrupted.pendingImplementation,undefined);
  assert.ok(interrupted.interruptedImplementation.requestIdentity);
  const index = server.runs.length;
  const resumed = new Workflow({root,directory,config,server,resume:true});
  const result = await resumed.run();
  assert.equal(result.status,'standby',result.error);
  const continuation = server.runs.slice(index);
  assert.equal(continuation[0].schema,IMPLEMENTATION_HANDOFF_SCHEMA);
  assert.ok(continuation[0].input.includes(JSON.stringify(original.input).slice(1,-1)),'the supervisor receives the frozen full original request in its structured handoff');
  assert.equal(continuation[1].role,'implementer');
  assert.equal(continuation[1].threadId,original.threadId,'the same review implementation history is retained');
  assert.equal(continuation[2].schema,TASK_RELAY_SCHEMA);
  assert.equal(continuation[3].schema,VERIFICATION_SCHEMA);
  assert.equal(fs.readFileSync(path.join(root,'src/unfinished.ts'),'utf8'),'preserved incomplete implementation');
  assert.equal(result.reviewStrikes.C.totalFailures,1,'a runtime interruption does not add a strike');
  assert.equal(result.activeImplementation,undefined);
  assert.equal(result.interruptedImplementation,undefined);
});

test('a combined REVIEW PASS requires every prompt gate and the exact original request pin', async t => {
  for (const option of ['omitCombinedGate','omitCombinedPromptPin']) {
    const {workflow} = workflowFixture(t,{reviewUnits:true,failFirstC:true,[option]:true});
    const result = await workflow.run();
    assert.notEqual(result.status,'standby');
    assert.match(result.error,option === 'omitCombinedGate' ? /Missing required gate/ : /exact original implementation prompt/);
    assert.equal(result.certificates.C,undefined);
  }
});

test('a narrow repair cannot be dispatched as a complete review implementation', async t => {
  const {workflow,server} = workflowFixture(t,{reviewUnits:true,failFirstC:true,missingRepairCoverage:true});
  const result = await workflow.run();
  assert.match(result.error,/cover every REVIEW C gate/);
  assert.equal(server.runs.filter(run => run.role === 'implementer').length,0);
});

test('combined blocked implementation still reaches independent review and branches retain scoped verification', async t => {
  const {workflow,server} = workflowFixture(t,{reviewUnits:true,failFirstC:true,blockFirstImplementation:true});
  const result = await workflow.run();
  assert.equal(result.status,'standby',result.error);
  const blocked = server.runs.findIndex(run => run.role === 'implementer' && run.result.status === 'blocked');
  assert.equal(server.runs[blocked+1].schema,TASK_RELAY_SCHEMA);
  assert.equal(server.runs[blocked+2].schema,VERIFICATION_SCHEMA);
  assert.equal(server.runs[blocked+2].result.verdict,'blocked');
  assert.equal(result.reviewStrikes.C.totalFailures,2);
  for (const checkpoint of ['15-5','15-6']) assert.ok(server.runs.some(run => run.schema === TASK_VERIFICATION_SCHEMA && run.result.taskId.includes(`branch-${checkpoint}-response.json`)));
  assert.equal(server.maximumBranches,2);
});

test('every whole-prompt implementation return reaches independent verification before another assignment', async t => {
  const {workflow, server} = workflowFixture(t, {failFirstC: true, taskFailFirst: true});
  const result = await workflow.run();
  assert.equal(result.status, 'standby', result.error);
  for (const [index, run] of server.runs.entries()) {
    if (run.role !== 'implementer' || run.input.includes('다른 분기와 동시에')) continue;
    assert.equal(server.runs[index + 1].schema, TASK_RELAY_SCHEMA);
    assert.equal(server.runs[index + 2].schema, TASK_VERIFICATION_SCHEMA);
    assert.equal(server.runs[index + 3].schema, IMPLEMENTATION_HANDOFF_SCHEMA);
    assert.equal(server.runs[index + 1].overrides.sandboxPolicy.type, 'readOnly');
    assert.equal(server.runs[index + 2].overrides.sandboxPolicy.writableRoots.includes(workflow.root), false);
    assert.ok(server.runs[index + 2].input.includes(run.input), 'the verifier receives the entire original prompt');
  }
  assert.equal(result.taskVerificationHistory[0].verdict, 'fail', 'the verifier can reject an implementer completed report');
  assert.equal(result.reviewStrikes.C.totalFailures, 2, 'the task failure adds a strike when independently judged');
});

test('a partial-task PASS cannot approve a review or skip the next implementation prompt', async t => {
  const {workflow, server} = workflowFixture(t, {failFirstC: true, partialTaskFirst: true});
  const result = await workflow.run();
  assert.equal(result.status, 'standby', result.error);
  const index = server.runs.findIndex(run => run.schema === TASK_VERIFICATION_SCHEMA);
  assert.equal(server.runs[index].result.verdict, 'pass');
  assert.equal(server.runs[index].result.readyForReview, false);
  assert.equal(server.runs[index + 1].result.action, 'repair');
  assert.equal(server.runs[index + 2].schema, IMPLEMENTATION_SCHEMA);
  assert.equal(server.runs[index + 3].schema, TASK_RELAY_SCHEMA);
  assert.equal(server.runs[index + 4].schema, TASK_VERIFICATION_SCHEMA);
  assert.equal(result.reviewStrikes.C.totalFailures, 1);
});

test('parallel prompts are each independently judged before integration implementation', async t => {
  const {workflow, server} = workflowFixture(t);
  const result = await workflow.run();
  assert.equal(result.status, 'standby', result.error);
  const integration = server.runs.findIndex(run => run.input.includes('총괄이 전달하는 15-5·15-6 통합 지시'));
  for (const checkpoint of ['15-5', '15-6']) {
    const index = server.runs.findIndex(run => run.schema === TASK_VERIFICATION_SCHEMA && run.result.taskId.includes(`branch-${checkpoint}-response.json`));
    assert.ok(index >= 0 && index < integration);
    assert.equal(server.runs[index - 1].schema, TASK_RELAY_SCHEMA);
  }
  assert.equal(server.maximumBranches, 2);
});

test('task verification enforces prompt identity, all task gates and current evidence bytes', t => {
  const root = fixture(t), directory = path.join(root, 'task-verification');
  const evidence = report(root, 'B', directory);
  const task = {...evidence, taskId: 'one-prompt', readyForReview: false, checks: TASK_GATES.map(id => ({id, status: 'pass', evidencePaths: [evidence.evidence[0].path], detail: id}))};
  assert.equal(validateTaskVerification(root, directory, 'B', 'one-prompt', task).verdict, 'pass');
  assert.throws(() => validateTaskVerification(root, directory, 'B', 'another-prompt', task), /identity/);
  assert.throws(() => validateTaskVerification(root, directory, 'B', 'one-prompt', {...task, checks: task.checks.slice(1)}), /Missing required gate/);
  assert.throws(() => validateTaskVerification(root, directory, 'B', 'one-prompt', {...task, verdict: 'blocked', readyForReview: true}), /unsuccessful task/);
  fs.appendFileSync(path.join(root, evidence.evidence[0].path), 'altered');
  assert.throws(() => validateTaskVerification(root, directory, 'B', 'one-prompt', task), /changed/);
});

for (const status of ['completed', 'blocked']) test(`recovery verifies a saved ${status} prompt before a new implementation`, async t => {
  const {workflow, server, root, directory, config} = workflowFixture(t);
  const round = path.join(directory, 'rounds/0001-C');
  const responsePath = path.join(round, 'implementer-response.json');
  atomicJSON(responsePath, {turnId: 'saved-turn', result: {status, summary: 'Implementation reports its work', changedFiles: [], artifactPaths: [], commands: [], remainingIssues: []}});
  fs.writeFileSync(path.join(round, 'implementer-request.txt'), 'Complete every instruction in this implementation prompt');
  Object.assign(workflow.state, {status: 'stopped', phase: 'implement', round: 1, pendingImplementation: {responsePath: workflow.relative(responsePath), review: 'C'}});
  workflow.save();
  const resumed = new Workflow({root, directory, config, server, resume: true});
  const result = await resumed.run();
  assert.equal(result.status, 'standby', result.error);
  assert.equal(server.runs[0].schema, TASK_RELAY_SCHEMA);
  assert.equal(server.runs[1].schema, TASK_VERIFICATION_SCHEMA);
  assert.ok(server.runs[1].input.includes('Complete every instruction'));
  assert.equal(server.runs[2].schema, IMPLEMENTATION_HANDOFF_SCHEMA);
});

test('failed C goes through supervisor and implementer before revalidation; both branches run concurrently; F enters standby', async t => {
  const {workflow, server, directory} = workflowFixture(t, {failFirstC: true});
  const result = await workflow.run();
  assert.equal(result.status, 'standby', result.error);
  assert.equal(result.review, 'F');
  assert.deepEqual(Object.keys(result.certificates), ['C', 'D', 'E', 'F']);
  assert.deepEqual(server.runs.slice(0, 7).map(r => r.role), ['verifier', 'supervisor', 'implementer', 'supervisor', 'verifier', 'supervisor', 'verifier']);
  assert.equal(server.maximumBranches, 2);
  assert.equal(result.repairAttempts, 1);
  assert.equal(result.productionCutover, 'not-executed-by-user-instruction');
  assert.equal(new Set(server.threads.slice(0, 3).map(thread => thread.id)).size, 3);
  assert.equal(result.threads.implementer, undefined, 'F completion retires the final implementation session');
  const count = server.runs.length;
  const resumed = new Workflow({root: workflow.root, config: workflow.config, server, directory, resume: true});
  await resumed.run();
  assert.equal(server.runs.length, count, 'standby resume must not dispatch more work');
});

test('three failed C verifications change the repair assignment without changing the original prompt', async t => {
  const {workflow, server, root} = workflowFixture(t, {failCCount: 3});
  const prompt = fs.readFileSync(path.join(root, 'prompt.txt'), 'utf8');
  const result = await workflow.run();
  assert.equal(result.status, 'standby', result.error);
  assert.equal(result.reviewStrikes.C.totalFailures, 3);
  assert.equal(result.reviewStrikes.C.strategyChanges, 1);
  assert.equal(result.strategyHistory.length, 1);
  assert.equal(server.runs.filter(run => run.role === 'supervisor' && run.input.includes('3스트라이크:')).length, 1);
  assert.equal(fs.readFileSync(path.join(root, 'prompt.txt'), 'utf8'), prompt);
});

test('failed B uses a separate 15-3 session until B passes, then resumes the retained 15-4 session', async t => {
  const {workflow, server} = workflowFixture(t, {failFirstC: true, blockFirstImplementation: true, handoffAction: 'verify_b', failBCount: 3});
  const result = await workflow.run();
  assert.equal(result.status, 'standby', result.error);
  const cSession = server.runs.find(run => run.role === 'implementer').threadId;
  const names = Object.fromEntries(server.names.map(item => [item.threadId, item.name]));
  const bRepairs = server.runs.filter(run => run.role === 'implementer' && run.input.includes('REVIEW B 보완 프롬프트'));
  assert.equal(bRepairs.length, 3);
  assert.equal(new Set(bRepairs.map(run => run.threadId)).size, 1);
  assert.equal(names[bRepairs[0].threadId], '[15-3] 구현');
  assert.notEqual(bRepairs[0].threadId, cSession);
  const bStart = server.runs.findIndex(run => run.role === 'verifier' && run.result.review === 'B');
  const bPass = server.runs.findIndex(run => run.role === 'verifier' && run.result.review === 'B' && run.result.verdict === 'pass');
  assert.ok(server.runs.slice(bStart, bPass).every(run => run.role !== 'implementer' || run.threadId !== cSession));
  const returned = server.runs.find(run => run.role === 'implementer' && run.input.includes('보관한 [15-4] 구현 세션으로 복귀'));
  assert.equal(returned.threadId, cSession);
  assert.ok(server.runs.indexOf(returned) > bPass);
  assert.ok(server.deleted.includes(bRepairs[0].threadId));
  assert.ok(result.prerequisiteCertificates.B);
  assert.equal(result.reviewStrikes.B.totalFailures, 3);
  assert.equal(result.reviewStrikes.B.strategyChanges, 1);
});

test('runtime migration preserves the completed B report and parks the legacy C conversation', async t => {
  const {workflow, server, root, directory, config} = workflowFixture(t, {failBCount: 1});
  await workflow.initialize();
  const cSession = workflow.state.threads.implementer;
  const bDirectory = path.join(directory, 'rounds/0002-B');
  const bReport = report(root, 'B', path.join(bDirectory, 'verification'), 'fail');
  atomicJSON(path.join(bDirectory, 'verification.json'), bReport);
  const cDirectory = path.join(directory, 'rounds/0001-C');
  atomicJSON(path.join(cDirectory, 'verification.json'), report(root, 'C', path.join(cDirectory, 'verification'), 'fail'));
  const responsePath = path.join(bDirectory, 'legacy-implementation-response.json');
  atomicJSON(responsePath, {threadId: cSession, turnId: 'completed-before-correction', result: {status: 'completed', summary: 'Completed B repair', changedFiles: [], artifactPaths: [], commands: [], remainingIssues: []}});
  const savedResponse = fs.readFileSync(responsePath, 'utf8');
  Object.assign(workflow.state, {runtimeVersion: 2, status: 'stopped', phase: 'implement', round: 2,
    latestVerification: workflow.relative(path.join(cDirectory, 'verification.json')),
    latestPrerequisiteVerification: workflow.relative(path.join(bDirectory, 'verification.json')),
    pendingImplementation: {responsePath: workflow.relative(responsePath), review: 'C'}});
  workflow.save();
  const resumed = new Workflow({root, directory, config, server, resume: true});
  assert.equal(resumed.state.review, 'B');
  assert.equal(resumed.state.pendingImplementation.review, 'B');
  const result = await resumed.run();
  assert.equal(result.status, 'standby', result.error);
  const names = Object.fromEntries(server.names.map(item => [item.threadId, item.name]));
  const bRepair = server.runs.find(run => run.role === 'implementer' && run.input.includes('REVIEW B 보완 프롬프트'));
  assert.equal(names[bRepair.threadId], '[15-3] 구현');
  assert.notEqual(bRepair.threadId, cSession);
  const restored = server.runs.find(run => run.role === 'implementer' && run.input.includes('보관한 [15-4] 구현 세션으로 복귀'));
  assert.equal(restored.threadId, cSession);
  assert.equal(fs.readFileSync(responsePath, 'utf8'), savedResponse);
  assert.equal(JSON.parse(fs.readFileSync(path.join(cDirectory, 'verification.json'), 'utf8')).verdict, 'fail');
});

test('B failure cannot be assigned to C and C repairs may return to the B checkpoint', () => {
  const decision = {review: 'B', action: 'repair', repairReview: 'B', repairPrompt: 'Fix B', branchPlans: []};
  assert.equal(validateDecision('B', {verdict: 'fail'}, decision).repairReview, 'B');
  assert.throws(() => validateDecision('B', {verdict: 'fail'}, {...decision, repairReview: 'C'}), /skip forward/);
  assert.equal(validateDecision('C', {verdict: 'fail'}, {...decision, review: 'C'}).repairReview, 'B');
  const handoff = {action: 'repair', repairReview: 'B', repairPrompt: 'Fix B', blockerKind: 'none', blockerEvidence: ''};
  assert.equal(validateImplementationHandoff('C', handoff).repairReview, 'B');
  assert.throws(() => validateImplementationHandoff('B', {...handoff, repairReview: 'C'}), /skip a review/);
});

test('an interrupted checkpoint correction goes to the supervisor before fresh B implementation and preserves partial files', async t => {
  const {workflow, server, root, directory, config} = workflowFixture(t);
  await workflow.initialize();
  const cSession = workflow.state.threads.implementer;
  const bDirectory = path.join(directory, 'rounds/0002-B');
  atomicJSON(path.join(bDirectory, 'verification.json'), report(root, 'B', path.join(bDirectory, 'verification'), 'fail'));
  const partial = path.join(bDirectory, 'implementation-partial');
  fs.mkdirSync(partial);
  fs.writeFileSync(path.join(partial, 'unfinished.json'), '{"completed":false}');
  atomicJSON(path.join(bDirectory, 'decision.json'), {action: 'repair', repairReview: 'C', repairPrompt: 'Return to 15-3'});
  const correction = {origin: 'orchestration-control', review: 'B', checkpoint: '15-3', previousThreadId: cSession,
    reportDirectory: workflow.relative(partial), supervisorDecision: workflow.relative(path.join(bDirectory, 'decision.json')),
    prerequisiteVerification: workflow.relative(path.join(bDirectory, 'verification.json'))};
  Object.assign(workflow.state, {runtimeVersion: 2, status: 'stopped', phase: 'implement', round: 2,
    latestPrerequisiteVerification: correction.prerequisiteVerification, pendingCheckpointCorrection: correction});
  workflow.save();
  const resumed = new Workflow({root, directory, config, server, resume: true});
  const result = await resumed.run();
  assert.equal(result.status, 'standby', result.error);
  assert.deepEqual(server.runs.slice(0, 4).map(run => run.role), ['supervisor', 'implementer', 'supervisor', 'verifier']);
  assert.match(server.runs[0].input, /미완료 작업/);
  assert.match(server.runs[0].input, /구현 세션의 완료 보고가 아니다/);
  const bImplementation = server.runs[1];
  assert.notEqual(bImplementation.threadId, cSession);
  assert.ok(server.names.some(item => item.threadId === bImplementation.threadId && item.name === '[15-3] 구현'));
  assert.equal(server.runs[3].result.review, 'B');
  assert.equal(fs.readFileSync(path.join(partial, 'unfinished.json'), 'utf8'), '{"completed":false}');
  const operatorRecord = JSON.parse(fs.readFileSync(path.join(directory, 'rounds/0003-B-handoff/checkpoint-correction.json'), 'utf8'));
  assert.equal(operatorRecord.completedTurn, false);
  assert.equal(operatorRecord.taskStatus, 'incomplete');
  assert.equal(result.reviewStrikes.B.totalFailures, 1, 'an interrupted implementation is not a failed review');
  assert.equal(result.pendingCheckpointCorrection, undefined);
});

for (const completed of [false, true]) test(`user priorities reach the existing supervisor and B session with ${completed ? 'a completed report' : 'an incomplete turn'}`, async t => {
  const {workflow, server, root, directory, config} = workflowFixture(t);
  await workflow.initialize();
  workflow.state.review = 'B';
  await workflow.ensureImplementationSession();
  const bSession = workflow.state.threads.implementer, supervisor = workflow.state.threads.supervisor;
  const bDirectory = path.join(directory, 'rounds/0002-B');
  atomicJSON(path.join(bDirectory, 'verification.json'), report(root, 'B', path.join(bDirectory, 'verification'), 'fail'));
  atomicJSON(path.join(bDirectory, 'decision.json'), {action: 'repair', repairReview: 'B'});
  const instructionPath = path.join(directory, 'control/priority.json');
  const instruction = {id: 'priority-one', origin: 'user-instruction', review: 'B', targetSupervisorThreadId: supervisor,
    message: 'Analyze AIA/LIE constraints and reproduce PRK second advance before all-24 generation.', evidencePaths: []};
  atomicJSON(instructionPath, instruction);
  const correction = {origin: 'user-instruction', review: 'B', checkpoint: '15-3', reportDirectory: workflow.relative(bDirectory),
    supervisorDecision: workflow.relative(path.join(bDirectory, 'decision.json')), prerequisiteVerification: workflow.relative(path.join(bDirectory, 'verification.json')), instructionPath: workflow.relative(instructionPath)};
  if (completed) {
    const responsePath = path.join(bDirectory, 'current-response.json');
    atomicJSON(responsePath, {threadId: bSession, turnId: 'completed-current', result: {status: 'blocked', summary: 'Latest report', changedFiles: [], artifactPaths: [], commands: [], remainingIssues: []}});
    correction.completedResponsePath = workflow.relative(responsePath);
  }
  const stale = path.join(bDirectory, 'stale-response.json');
  atomicJSON(stale, {turnId: 'old-turn', result: {status: 'blocked', summary: 'STALE REPORT MUST NOT BE REPLAYED', changedFiles: [], artifactPaths: [], commands: [], remainingIssues: []}});
  Object.assign(workflow.state, {runtimeVersion: 3, status: 'stopped', phase: 'implement', round: 2,
    latestPrerequisiteVerification: correction.prerequisiteVerification, pendingCheckpointCorrection: correction,
    pendingImplementation: {responsePath: workflow.relative(stale), review: 'B'}});
  workflow.save();
  const resumed = new Workflow({root, directory, config, server, resume: true});
  const result = await resumed.run();
  assert.equal(result.status, 'standby', result.error);
  assert.equal(server.runs[0].role, 'supervisor');
  assert.equal(server.runs[0].threadId, supervisor);
  assert.match(server.runs[0].input, /Analyze AIA\/LIE constraints/);
  assert.doesNotMatch(server.runs[0].input, /STALE REPORT MUST NOT BE REPLAYED/);
  assert.equal(server.runs[1].role, 'implementer');
  assert.equal(server.runs[1].threadId, bSession);
  assert.ok(server.runs[1].input.includes(server.runs[0].result.repairPrompt));
  assert.equal(JSON.parse(fs.readFileSync(instructionPath, 'utf8')).message, instruction.message);
  const receipt = JSON.parse(fs.readFileSync(`${instructionPath}.receipt.json`, 'utf8'));
  assert.equal(receipt.status, 'implementation_dispatched');
  assert.equal(receipt.supervisorThreadId, supervisor);
  assert.equal(receipt.implementationThreadId, bSession);
  assert.ok(fs.existsSync(path.join(root, receipt.implementationRequest)));
  assert.equal(result.reviewStrikes.B.totalFailures, 1, 'a user instruction is not a review failure');
  const record = JSON.parse(fs.readFileSync(path.join(directory, 'rounds/0003-B-handoff/supervisor-instruction.json'), 'utf8'));
  assert.equal(record.completedTurn, completed);
});

test('strike counting is review-specific and replay-safe; runtime recovery and external waiting are not terminal', () => {
  const state = {};
  recordReviewResult(state, {review: 'C', verdict: 'fail'}, 'one');
  recordReviewResult(state, {review: 'C', verdict: 'fail'}, 'one');
  recordReviewResult(state, {review: 'B', verdict: 'blocked'}, 'two');
  assert.equal(state.reviewStrikes.C.totalFailures, 1);
  assert.equal(state.reviewStrikes.B.totalFailures, 1);
  assert.equal(strategyInstruction(state, 'C'), '');
  assert.equal(classifyFailure(Error('Server disconnected'), state), 'recovering');
  assert.equal(classifyFailure(Error('Missing file'), {requiredUserInput: {kind: 'missing_external_input'}}), 'waiting_input');
  assert.equal(classifyFailure(Error('Server disconnected'), state, true), 'stopped');
  assert.deepEqual(TERMINAL_STATUSES, ['stopped', 'standby']);
  assert.throws(() => validateDecision('C', {verdict: 'fail'}, {review: 'C', action: 'blocked', repairReview: 'C'}), /evidenced external/);
});

test('strikes accrue on verifier judgments and task PASS never resets the review', () => {
  const state = {};
  const failed = taskId => ({review: 'B', taskId, verdict: 'fail', nonPassKind: 'implementation'});
  recordTaskResult(state, failed('first-prompt'), 'first-result');
  recordTaskResult(state, failed('first-prompt'), 'first-result');
  recordTaskResult(state, failed('first-prompt'), 'retry-result');
  recordReviewResult(state, {...failed('first-prompt'), taskId: undefined, implementationTaskId: 'first-prompt'}, 'full-review-result');
  assert.equal(state.reviewStrikes.B.totalFailures, 1, 'recovery and task/full-review repeats count once');
  recordTaskResult(state, {review: 'B', taskId: 'partial-prompt', verdict: 'pass', nonPassKind: 'none'}, 'partial-pass');
  assert.equal(state.reviewStrikes.B.sinceStrategyChange, 1);
  recordTaskResult(state, {...failed('environment-prompt'), verdict: 'blocked', nonPassKind: 'environment'}, 'environment-result');
  assert.equal(state.reviewStrikes.B.totalFailures, 1);
  recordTaskResult(state, {...failed('second-prompt'), verdict: 'blocked'}, 'second-result');
  recordTaskResult(state, failed('third-prompt'), 'third-result');
  assert.equal(state.reviewStrikes.B.sinceStrategyChange, 3);
  assert.match(strategyInstruction(state, 'B'), /3스트라이크/);
  recordTaskResult(state, {review: 'B', taskId: 'another-partial-prompt', verdict: 'pass', nonPassKind: 'none'}, 'another-partial-pass');
  assert.equal(state.reviewStrikes.B.sinceStrategyChange, 3);
  recordReviewResult(state, {review: 'B', verdict: 'pass', nonPassKind: 'none'}, 'full-pass');
  assert.equal(state.reviewStrikes.B.sinceStrategyChange, 0);
  assert.equal(state.reviewStrikes.B.totalFailures, 3);
  assert.equal(state.strikeHistory.filter(record => record.counted).length, 3);
});

test('a task failure is counted before the supervisor assigns a different approach at three strikes', async t => {
  const {workflow, server} = workflowFixture(t, {failFirstC: true, taskFailCount: 2});
  const original = server.runTurn.bind(server);
  let changed = false;
  server.runTurn = async (...args) => {
    if (args[2] === TASK_RELAY_SCHEMA) assert.ok(workflow.state.reviewStrikes.C.sinceStrategyChange < 3);
    if (args[2] === IMPLEMENTATION_HANDOFF_SCHEMA && args[1].includes('3스트라이크:')) {
      assert.equal(workflow.state.reviewStrikes.C.sinceStrategyChange, 3, 'the verifier judgment was already recorded');
      changed = true;
    }
    return original(...args);
  };
  const result = await workflow.run();
  assert.equal(result.status, 'standby', result.error);
  assert.equal(changed, true);
  assert.equal(result.reviewStrikes.C.totalFailures, 3);
  assert.equal(result.reviewStrikes.C.strategyChanges, 1);
  assert.equal(result.strategyHistory.length, 1);
});

test('v5 completed task failures migrate once and rechecking the same implementation cannot add a strike', async t => {
  const {workflow, server, root, directory, config} = workflowFixture(t);
  const round = path.join(directory, 'rounds/0001-B');
  const response = path.join(round, 'implementer-response.json');
  atomicJSON(response, {turnId: 'completed-old-task', result: {status: 'blocked', summary: 'Actual implementation failure', changedFiles: [], artifactPaths: [], commands: [], remainingIssues: []}});
  fs.writeFileSync(path.join(round, 'implementer-request.txt'), 'Implement the whole assigned prompt');
  const taskId = workflow.relative(response);
  const taskReport = path.join(round, 'tasks/old/verification.json');
  const old = {...report(root, 'B', path.dirname(taskReport), 'fail'), taskId, readyForReview: false};
  delete old.nonPassKind;
  atomicJSON(taskReport, old);
  Object.assign(workflow.state, {runtimeVersion: 5, status: 'stopped', phase: 'task_verify', review: 'B', round: 1,
    pendingImplementation: {responsePath: taskId, review: 'B'}, taskVerificationHistory: [{path: workflow.relative(taskReport), taskId, review: 'B', verdict: 'fail'}]});
  workflow.save();
  const resumed = new Workflow({root, directory, config, server, resume: true});
  const result = await resumed.run();
  assert.equal(result.status, 'standby', result.error);
  assert.equal(result.reviewStrikes.B.totalFailures, 1, 'the legacy failure and fresh recheck belong to the same implementation');
  assert.equal(result.strikeCountingVersion, 2);
  assert.equal(result.strikeHistory.filter(item => item.counted && item.review === 'B').length, 1);
});

test('runtime updates locate nested task verifier responses at the round root', t => {
  const root = fixture(t), run = path.join(root, 'reports/run');
  const round = path.join(run, 'rounds/0001-B-handoff');
  assert.equal(taskResponsePath(root, run, {key: 'task-verifier-1', reportDirectory: path.join(round, 'tasks/0001-implementer/verification')}), path.join(round, 'task-verifier-1-response.json'));
  assert.equal(taskResponsePath(root, run, {key: 'verifier', reportDirectory: path.join(round, 'verification')}), path.join(round, 'verifier-response.json'));
  assert.throws(() => taskResponsePath(root, run, {key: 'verifier', reportDirectory: path.join(root, 'other-run')}), /escapes/);
  assert.throws(() => taskResponsePath(root, run, {key: '../../escape', reportDirectory: round}), /escapes/);
});

for (const changed of [false, true]) test(`a confirmed task FAIL is ${changed ? 'reverified when inputs change' : 'forwarded directly on policy resume'}`, async t => {
  const {workflow, server, root, directory, config} = workflowFixture(t);
  const round = path.join(directory, 'rounds/0001-B'), taskDirectory = path.join(round, 'tasks/0001-implementer');
  const responsePath = path.join(round, 'implementer-response.json');
  atomicJSON(responsePath, {turnId: 'confirmed-turn', result: {status: 'blocked', summary: 'Actual implementation error', changedFiles: [], artifactPaths: [], commands: [], remainingIssues: []}});
  fs.writeFileSync(path.join(round, 'implementer-request.txt'), 'Implement all assigned instructions');
  const taskId = workflow.relative(responsePath), reportPath = path.join(taskDirectory, 'verification.json');
  const failed = {...report(root, 'B', path.join(taskDirectory, 'verification'), 'fail'), taskId, readyForReview: false};
  failed.checks = TASK_GATES.map(id => ({id, status: 'fail', evidencePaths: [failed.evidence[0].path], detail: id}));
  atomicJSON(reportPath, failed);
  atomicJSON(path.join(taskDirectory, 'source-before.json'), sourceSnapshot(root));
  atomicJSON(path.join(taskDirectory, 'source-changes.json'), {changes: []});
  Object.assign(workflow.state, {runtimeVersion: 5, status: 'stopped', phase: 'implementation_handoff', review: 'B', round: 1,
    pendingImplementation: {responsePath: taskId, review: 'B'}, latestTaskVerification: workflow.relative(reportPath),
    taskVerificationHistory: [{path: workflow.relative(reportPath), taskId, review: 'B', verdict: 'fail'}]});
  workflow.save();
  if (changed) fs.writeFileSync(path.join(root, 'input.txt'), 'different current inputs');
  const resumed = new Workflow({root, directory, config, server, resume: true});
  const result = await resumed.run();
  assert.equal(result.status, 'standby', result.error);
  assert.equal(server.runs[0].schema, changed ? TASK_RELAY_SCHEMA : IMPLEMENTATION_HANDOFF_SCHEMA);
  assert.equal(result.reviewStrikes.B.totalFailures, 1);
});

test('implementation sessions are fresh per task and review-adjacent sessions survive review repairs', async t => {
  const {workflow, server} = workflowFixture(t, {failCCount: 2, failFirstD: true});
  const result = await workflow.run();
  assert.equal(result.status, 'standby', result.error);
  const cRepairs = server.runs.filter(run => run.role === 'implementer' && run.input.includes('REVIEW C 보완 프롬프트'));
  assert.equal(new Set(cRepairs.map(run => run.threadId)).size, 1);
  const names = Object.fromEntries(server.names.map(item => [item.threadId, item.name]));
  const branch5 = server.runs.find(run => run.input.includes('15-5를 구현한다'));
  const branch6 = server.runs.find(run => run.input.includes('15-6를 구현한다'));
  assert.equal(names[branch5.threadId], '[15-5] 구현');
  assert.equal(names[branch6.threadId], '[15-6] 구현');
  assert.notEqual(branch5.overrides.cwd, branch6.overrides.cwd);
  assert.notEqual(branch5.overrides.cwd, workflow.root);
  assert.deepEqual(branch5.overrides.sandboxPolicy.writableRoots, [branch5.overrides.cwd]);
  const dRepair = server.runs.find(run => run.input.includes('REVIEW D 보완 프롬프트'));
  assert.equal(dRepair.threadId, branch6.threadId);
  const integration = server.runs.find(run => run.role === 'implementer' && run.input.includes('통합 지시:'));
  assert.equal(integration.threadId, branch6.threadId);
  assert.equal(integration.overrides.cwd, workflow.root);
  assert.ok(server.deleted.includes(branch5.threadId));
  assert.ok(server.deleted.includes(branch6.threadId));
  const task7 = server.runs.find(run => run.role === 'implementer' && names[run.threadId] === '[15-7] 구현');
  const task8 = server.runs.find(run => run.role === 'implementer' && names[run.threadId] === '[15-8] 구현');
  assert.notEqual(task7.threadId, task8.threadId);
});

test('returning to an earlier review preserves the unfinished later-review implementation history', async t => {
  const {workflow, server} = workflowFixture(t);
  await server.initialize();
  workflow.state.review = 'D';
  await workflow.ensureImplementationSession();
  const pendingD = workflow.state.threads.implementer;
  workflow.state.review = 'C';
  await workflow.ensureImplementationSession();
  assert.notEqual(workflow.state.threads.implementer, pendingD);
  assert.equal(workflow.state.threads['review-D-implementation'], pendingD);
  assert.equal(server.deleted.includes(pendingD), false);
  workflow.state.review = 'D';
  await workflow.ensureImplementationSession();
  assert.equal(workflow.state.threads.implementer, pendingD);
});

test('parallel copies cannot modify another worker or merge over concurrent main-workspace edits', t => {
  const root = fixture(t);
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'src/lookup.ts'), 'original lookup');
  fs.writeFileSync(path.join(root, 'src/migration.ts'), 'original migration');
  const plans = [{checkpoint: '15-5', writablePaths: ['src/lookup.ts']}, {checkpoint: '15-6', writablePaths: ['src/migration.ts']}];
  const work = plans.map(plan => prepareWorkspace(root, path.join(root, 'reports/run/workspaces', plan.checkpoint), plan));
  fs.writeFileSync(path.join(work[0].directory, 'src/lookup.ts'), 'new lookup');
  assert.equal(fs.readFileSync(path.join(root, 'src/lookup.ts'), 'utf8'), 'original lookup');
  assert.equal(fs.readFileSync(path.join(work[1].directory, 'src/lookup.ts'), 'utf8'), 'original lookup');
  fs.writeFileSync(path.join(work[1].directory, 'src/migration.ts'), 'new migration');
  const lookupChanges = planWorkspaceMerge(root, work[0], plans[0], ['src/lookup.ts']);
  fs.writeFileSync(path.join(root, 'src/migration.ts'), 'another operator edit');
  assert.throws(() => planWorkspaceMerge(root, work[1], plans[1], ['src/migration.ts']), /changed since branch baseline/);
  assert.equal(fs.readFileSync(path.join(root, 'src/lookup.ts'), 'utf8'), 'original lookup', 'neither branch is merged before both validations pass');
  fs.writeFileSync(path.join(root, 'src/migration.ts'), 'original migration');
  applyWorkspaceMerge([...lookupChanges, ...planWorkspaceMerge(root, work[1], plans[1], ['src/migration.ts'])]);
  assert.equal(fs.readFileSync(path.join(root, 'src/lookup.ts'), 'utf8'), 'new lookup');
  fs.writeFileSync(path.join(work[0].directory, 'src/lookup.ts'), 'original lookup');
  fs.writeFileSync(path.join(work[0].directory, 'src/migration.ts'), 'unowned write');
  assert.throws(() => planWorkspaceMerge(root, work[0], plans[0], []), /outside assigned ownership/);
});

test('same-named branch reports reach the supervisor with distinct canonical paths', async t => {
  const {workflow, server, root} = workflowFixture(t, {branchArtifacts: true});
  const result = await workflow.run();
  assert.equal(result.status, 'standby', result.error);
  const handoff = server.runs.find(run => run.role === 'supervisor' && run.input.includes('병렬 구현 결과를 함께'));
  assert.match(handoff.input, /workspaces\/15-5\/\.reports\/result\.json/);
  assert.match(handoff.input, /workspaces\/15-6\/\.reports\/result\.json/);
  assert.equal(fs.existsSync(path.join(root, '.reports/result.json')), false);
});

function liveControllerFixture(t, failureMessage = 'Transport disconnected') {
  const {root, config} = workflowFixture(t);
  const scripts = path.join(root, 'scripts/prompt15-orchestrator');
  fs.mkdirSync(scripts, {recursive: true});
  for (const name of ['run.mjs', 'task-workflow.mjs', 'task-inputs.mjs', 'guardian-repair.mjs', 'vitest-acceptance.mjs', 'vitest-transition.mjs', 'verifier-recovery.mjs', 'task-protocol.mjs', 'task-guardian.mjs', 'workflow.mjs', 'protocol.mjs', 'app-server.mjs', 'execution-progress.mjs', 'policy.mjs', 'workspaces.mjs', 'units.mjs', 'task-plan.mjs', 'verification-stages.mjs', 'verification-stages-compact.mjs', 'bounded-output.mjs', 'review-b-outcome.mjs', 'product-target.mjs', 'launch-policy.mjs']) fs.copyFileSync(new URL(name,import.meta.url), path.join(scripts, name));
  if(fs.existsSync(new URL('task-progress.mjs',import.meta.url)))fs.copyFileSync(new URL('task-progress.mjs',import.meta.url),path.join(scripts,'task-progress.mjs'));
  const serverScript = path.join(root, 'fake-server.mjs');
  fs.writeFileSync(serverScript, `import fs from 'node:fs'; import {createInterface} from 'node:readline';
const countFile = 'launch-count.txt'; const count = Number(fs.existsSync(countFile) ? fs.readFileSync(countFile, 'utf8') : 0) + 1; fs.writeFileSync(countFile, String(count));
const output = value => process.stdout.write(JSON.stringify(value) + '\\n'); let next = 0;
createInterface({input:process.stdin}).on('line', line => { const message = JSON.parse(line); if (!message.id) return;
if (message.method === 'initialize') output({id:message.id,result:{userAgent:'fixture'}});
else if (message.method === 'thread/start') output({id:message.id,result:{thread:{id:'root-'+(++next)}}});
else if (message.method === 'thread/resume') output({id:message.id,result:{thread:{id:message.params.threadId}}});
else if (message.method === 'turn/start') { const threadId=message.params.threadId; output({id:message.id,result:{turn:{id:'fixture-turn',status:'inProgress'}}});
output({method:'turn/started',params:{threadId,turn:{id:'fixture-turn'}}});
if (count === 1) output({method:'turn/completed',params:{threadId,turn:{id:'fixture-turn',status:'failed',error:{message:${JSON.stringify(failureMessage)}}}}});
else output({id:'approval-required',method:'item/commandExecution/requestApproval',params:{threadId}});
} else output({id:message.id,result:{}}); });`);
  const automation = path.join(root, 'automation/prompt15');
  fs.mkdirSync(automation, {recursive: true});
  fs.copyFileSync(new URL('../../automation/prompt15/task-plan.json',import.meta.url),path.join(automation,'task-plan.json'));
  fs.writeFileSync(path.join(automation, 'config.json'), JSON.stringify({...config, appServerArgs: [serverScript], turnTimeoutMs: 2000}));
  return {root, scripts};
}

test('the live controller recovers a transport failure, stays alive for input, and exits only on user stop', async t => {
  const {root, scripts} = liveControllerFixture(t);
  const child = spawn(process.execPath, [path.join(scripts, 'run.mjs'), 'start', '--codex', process.execPath], {cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']});
  let errors = '';
  child.stderr.on('data', data => { errors += data; });
  child.stdout.resume();
  fixtureCleanup.get(root).push(async () => {
    if (child.exitCode !== null) return;
    const closed = new Promise(resolve => child.once('close', resolve));
    child.kill('SIGKILL'); await closed;
  });
  const waitUntil = async predicate => { const deadline = Date.now() + 18000; while (Date.now() < deadline) { if (predicate()) return; if (child.exitCode !== null) throw Error(`Controller exited unexpectedly: ${errors}`); await new Promise(resolve => setTimeout(resolve, 50)); } throw Error(`Timed out: ${errors}`); };
  let run;
  await waitUntil(() => { const index = path.join(root, 'reports/prompt15/orchestration/latest.json'); if (!fs.existsSync(index)) return false; run = JSON.parse(fs.readFileSync(index, 'utf8')).directory; return fs.existsSync(path.join(run, 'state.json')); });
  const state = () => JSON.parse(fs.readFileSync(path.join(run, 'state.json'), 'utf8'));
  await waitUntil(() => state().status === 'waiting_input');
  assert.equal(fs.readFileSync(path.join(root, 'launch-count.txt'), 'utf8'), '2');
  assert.equal(child.exitCode, null);
  assert.equal(state().reviewStrikes?.C, undefined, 'transport and approval failures do not count as review verdicts');
  const exited = new Promise(resolve => child.once('exit', resolve));
  fs.writeFileSync(path.join(run, 'stop.json'), JSON.stringify({requestedAt: new Date().toISOString()}));
  await exited;
  assert.equal(state().status, 'stopped');
  assert.equal(child.exitCode, 0, errors);
});

test('the local observer replaces a crashed controller without retrying unresolved input or a user stop', async t => {
  const {root} = liveControllerFixture(t);
  fs.mkdirSync(path.join(root, 'tools'));
  fs.copyFileSync(path.resolve('tools/prompt15-runtime.mjs'), path.join(root, 'tools/prompt15-runtime.mjs'));
  const launcher = spawn(process.execPath, ['tools/prompt15-runtime.mjs', 'start', '--codex', process.execPath], {cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']});
  let errors = '';
  launcher.stderr.on('data', value => { errors += value; }); launcher.stdout.resume();
  let run;
  const state = () => JSON.parse(fs.readFileSync(path.join(run, 'state.json'), 'utf8'));
  fixtureCleanup.get(root).push(async () => {
    if (launcher.exitCode !== null) return;
    const owned = run && fs.existsSync(path.join(run, 'state.json')) ? state() : null;
    if (owned?.runtimeSupervisorPid === launcher.pid && !['stopped', 'standby'].includes(owned.status)) {
      try { process.kill(owned.controllerPid, 'SIGKILL'); } catch { /* Worker already exited. */ }
    }
    const closed = new Promise(resolve => launcher.once('close', resolve));
    launcher.kill('SIGKILL'); await closed;
  });
  const waitUntil = async predicate => { const deadline = Date.now() + 18000; while (Date.now() < deadline) { if (predicate()) return; if (launcher.exitCode !== null) throw Error(`Observer exited unexpectedly: ${errors}`); await new Promise(resolve => setTimeout(resolve, 50)); } throw Error(`Observer timed out: ${errors}`); };
  await waitUntil(() => { const index = path.join(root, 'reports/prompt15/orchestration/latest.json'); if (!fs.existsSync(index)) return false; run = JSON.parse(fs.readFileSync(index, 'utf8')).directory; return fs.existsSync(path.join(run, 'state.json')) && state().status === 'waiting_input'; });
  const old = state();
  assert.equal(old.runtimeSupervisorPid, launcher.pid);
  process.kill(old.controllerPid, 'SIGKILL'); // Exactly the test worker owned by this test launcher.
  await waitUntil(() => state().controllerPid !== old.controllerPid && state().status === 'waiting_input' && fs.readFileSync(path.join(root, 'launch-count.txt'), 'utf8') === '3');
  assert.equal(launcher.exitCode, null);
  assert.equal(state().runtimeSupervisorPid, launcher.pid);
  assert.equal(fs.readFileSync(path.join(root, 'launch-count.txt'), 'utf8'), '3', 'the replacement server does not dispatch another inference while input is unresolved');
  const exited = new Promise(resolve => launcher.once('exit', resolve));
  fs.writeFileSync(path.join(run, 'stop.json'), JSON.stringify({requestedAt: new Date().toISOString()}));
  await exited;
  assert.equal(state().status, 'stopped');
  assert.equal(launcher.exitCode, 0, errors);
});

test('invalid supervisor advance on C failure blocks all downstream work', async t => {
  const {workflow, server} = workflowFixture(t, {failFirstC: true, failedCAdvance: true});
  const result = await workflow.run();
  assert.equal(result.status, 'recovering');
  assert.equal(result.review, 'C');
  assert.equal(server.runs.some(r => r.role === 'implementer'), false);
});

test('explicit model and high effort apply to every root and parallel implementation turn', async t => {
  const {workflow, server, config} = workflowFixture(t);
  for (const role of Object.values(config.roles)) { role.model = 'gpt-6.1-sol'; role.effort = 'high'; }
  const result = await workflow.run();
  assert.equal(result.status, 'standby', result.error);
  for (const thread of server.threads) {
    assert.equal(thread.params.model, 'gpt-6.1-sol');
    assert.equal(thread.params.config.model_reasoning_effort, 'high');
  }
  for (const turn of server.runs) {
    assert.equal(turn.overrides.model, 'gpt-6.1-sol');
    assert.equal(turn.overrides.effort, 'high');
  }
});

test('an implementation blocker is handed to the supervisor and repaired instead of ending the workflow', async t => {
  const {workflow, server} = workflowFixture(t, {failFirstC: true, blockFirstImplementation: true});
  const result = await workflow.run();
  assert.equal(result.status, 'standby', result.error);
  assert.deepEqual(server.runs.slice(0, 10).map(r => r.role), ['verifier', 'supervisor', 'implementer', 'supervisor', 'verifier', 'supervisor', 'implementer', 'supervisor', 'verifier', 'supervisor']);
  assert.equal(result.repairAttempts, 2);
  assert.equal(result.pendingImplementation, undefined);
});

test('the supervisor can request independent B certification and return to C without advancing it', async t => {
  const {workflow, server} = workflowFixture(t, {failFirstC: true, blockFirstImplementation: true, handoffAction: 'verify_b'});
  const result = await workflow.run();
  assert.equal(result.status, 'standby', result.error);
  assert.equal(result.prerequisiteCertificates.B.verification.includes('-B/'), true);
  const reviewers = server.runs.filter(r => r.schema === VERIFICATION_SCHEMA).map(r => r.input.match(/현재 REVIEW ([ABCDEF])/)[1]);
  assert.deepEqual(reviewers, ['C', 'B', 'C', 'D', 'E', 'F']);
  const bVerification = server.runs.findIndex(run => run.role === 'verifier' && run.result.review === 'B');
  assert.equal(server.runs[bVerification + 1].role, 'supervisor');
  assert.equal(server.runs[bVerification + 1].result.review, 'B');
  assert.equal(server.runs[bVerification + 1].result.action, 'advance');
  assert.match(server.runs[bVerification + 2].input, /보관한 \[15-4\] 구현 세션으로 복귀/);
});

test('an evidenced external condition enters input waiting without terminating the prompt', async t => {
  const {workflow} = workflowFixture(t, {failFirstC: true, blockFirstImplementation: true, handoffAction: 'blocked'});
  const result = await workflow.run();
  assert.equal(result.status, 'waiting_input');
  assert.equal(result.requiredUserInput.kind, 'user_decision');
  assert.match(result.nextAction, /Explicit user policy decision/);
  assert.equal(result.certificates.C, undefined);
  assert.throws(() => validateImplementationHandoff('C', {action: 'blocked', repairReview: 'C', blockerKind: 'none', blockerEvidence: ''}), /evidenced external blocker/);
});

test('resume forwards the saved implementation report to the supervisor before dispatching new verification', async t => {
  const {workflow, server, directory, root, config} = workflowFixture(t);
  const oldRound = path.join(directory, 'rounds', '0001-C');
  fs.mkdirSync(oldRound, {recursive: true});
  fs.writeFileSync(path.join(oldRound, 'implementer-response.json'), JSON.stringify({turnId: 'completed-implementation', result: {status: 'blocked', summary: 'REVIEW B impact returned to supervisor', changedFiles: [], artifactPaths: [], commands: [], remainingIssues: ['Needs supervisor assignment']}}));
  Object.assign(workflow.state, {status: 'blocked', phase: 'implement', round: 1, error: 'Implementation requires attention: REVIEW B impact'});
  workflow.save();
  const resumed = new Workflow({root, directory, config, server, resume: true});
  const result = await resumed.run();
  assert.equal(result.status, 'standby', result.error);
  assert.deepEqual(server.runs.slice(0, 4).map(r => r.role), ['supervisor', 'verifier', 'supervisor', 'implementer']);
  assert.equal(server.runs[0].input.includes('REVIEW B impact returned to supervisor'), true);
});

test('code mutation during verification prevents certification', async t => {
  const {workflow, server} = workflowFixture(t, {modifyDuringVerify: true});
  const result = await workflow.run();
  assert.equal(result.status, 'waiting_execution');
  assert.match(result.error, /Source changed/);
  assert.deepEqual(Object.keys(result.certificates), []);
  assert.equal(server.runs.length, 1);
});

test('an interrupted independent review resumes the same job, round and evidence folder', async t => {
  const {root, config, server, directory, workflow} = workflowFixture(t);
  config.verificationStages = true;
  await workflow.initialize();
  const original = server.runTurn.bind(server);
  server.runTurn = async () => { throw Error('Turn timeout for verifier; no completion was certified'); };
  await assert.rejects(workflow.verify(), /Turn timeout/);
  const first = structuredClone(workflow.state.activeVerification), originalRequest = fs.readFileSync(path.join(directory, 'rounds/0001-C/verifier-request.txt'), 'utf8');
  workflow.state.status = 'recovering'; workflow.save();
  const resumed = new Workflow({root, config, server, directory, resume: true}); await resumed.initialize();
  server.runTurn = async (...args) => { const result = await original(...args); result.value.verdict = 'fail'; result.value.nonPassKind = 'implementation'; result.value.failures = ['Actual defect']; result.value.checks[0].status = 'fail'; return result; };
  await resumed.verify();
  assert.equal(resumed.state.round, first.round); assert.equal(resumed.state.lastVerificationJob.jobId, first.jobId);
  assert.equal(resumed.state.lastVerificationJob.attempt, 2);
  assert.equal(fs.readFileSync(path.join(directory, 'rounds/0001-C/verifier-request.txt'), 'utf8'), originalRequest);
  assert.ok(fs.existsSync(path.join(directory, 'rounds/0001-C/verifier-resume-2-request.txt')));
  assert.ok(fs.existsSync(path.join(directory, 'rounds/0001-C/source-before-verification-resume-2.json')));
  assert.equal(taskResponsePath(root, directory, {key: 'verifier', responseKey: 'verifier-resume-2', reportDirectory: 'reports/run/rounds/0001-C/verification'}), path.join(directory, 'rounds/0001-C/verifier-resume-2-response.json'));
});

test('the controller preserves a platform rejection without automatically dispatching another turn', async t => {
  const {root, scripts} = liveControllerFixture(t, 'This content was flagged for possible cybersecurity risk');
  const child = spawn(process.execPath, [path.join(scripts, 'run.mjs'), 'start', '--codex', process.execPath], {cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']});
  child.stdout.resume(); child.stderr.resume();
  let run;
  fixtureCleanup.get(root).push(async () => {
    if (child.exitCode !== null) return;
    if (run) fs.writeFileSync(path.join(run, 'stop.json'), '{}');
    else child.kill('SIGKILL');
    await new Promise(resolve => child.once('close', resolve));
  });
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) {
    const index = path.join(root, 'reports/prompt15/orchestration/latest.json');
    if (fs.existsSync(index)) {
      run = JSON.parse(fs.readFileSync(index, 'utf8')).directory;
      const file = path.join(run, 'state.json');
      if (fs.existsSync(file) && JSON.parse(fs.readFileSync(file, 'utf8')).status === 'waiting_execution') break;
    }
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  assert.equal(JSON.parse(fs.readFileSync(path.join(run, 'state.json'), 'utf8')).status, 'waiting_execution');
  await new Promise(resolve => setTimeout(resolve, 500));
  assert.equal(fs.readFileSync(path.join(root, 'launch-count.txt'), 'utf8'), '1');
});

test('a review PASS requires a complete current independent journal and attested summary', async t => {
  const f = workflowFixture(t); f.config.verificationStages = true; await f.workflow.initialize();
  await assert.rejects(f.workflow.verify(), /plan.json/);
  assert.deepEqual(f.workflow.state.certificates, {});
  // Same job may complete its missing stages without creating another round.
  const helper = path.join(f.root, 'stage-check.mjs'); fs.writeFileSync(helper, `import fs from 'node:fs'; fs.writeFileSync(process.argv[2],'{"pass":true}');`);
  const original = f.server.runTurn.bind(f.server);
  f.server.runTurn = async (...args) => {
    const result = await original(...args), journal = new VerificationStages(path.join(f.root, f.workflow.state.activeVerification.contextPath));
    const inputs = await Promise.all([process.execPath, helper].map(stageIdentity));
    const output = path.join(journal.directory, 'stage-result.json');
    await journal.register({jobId: journal.context.jobId, role: 'verifier', requiredGates: journal.context.requiredGates,
      stages: [{id: 'actual-check', phase: 'regression', gates: journal.context.requiredGates, dependsOn: [], command: [process.execPath, helper, output], inputs,
        results: [{path: path.relative(f.root, output), assertions: [{key: 'pass', equals: true}]}]}]});
    await journal.runRemaining(); result.value.evidence.push(fileIdentity(f.root, journal.summaryFile)); return result;
  };
  const result = await f.workflow.verify(); assert.equal(result.verdict, 'pass'); assert.equal(f.workflow.state.round, 1);
});

test('compact verification requires actual execution and a current complete attested journal', async t => {
  const f = workflowFixture(t); f.config.verificationStages = true; f.config.compactVerification = true;
  await f.workflow.initialize(); await assert.rejects(f.workflow.verify(), /plan.json/);
  const helper = path.join(f.root, 'compact-check.mjs'); fs.writeFileSync(helper, `import fs from 'node:fs';fs.writeFileSync(process.argv[2],'{"pass":true}');`);
  const original = f.server.runTurn.bind(f.server);
  f.server.runTurn = async (...args) => {
    const result = await original(...args), journal = new CompactVerificationStages(path.join(f.root, f.workflow.state.activeVerification.contextPath));
    const manifest = path.join(journal.directory, 'shared-inputs.json');
    fs.writeFileSync(manifest, JSON.stringify({version: 1, inputs: await Promise.all([process.execPath, helper].map(stageIdentity))}));
    const output = path.join(journal.directory, 'compact-result.json');
    await journal.register({version: 2, jobId: journal.context.jobId, role: 'verifier', requiredGates: journal.context.requiredGates, inputSets: {common: await stageIdentity(manifest)},
      stages: [{id: 'actual-compact-check', phase: 'regression', gates: journal.context.requiredGates, dependsOn: [], command: [process.execPath, helper, output], inputs: [], inputSets: ['common'],
        results: [{path: path.relative(f.root, output), assertions: [{key: 'pass', equals: true}]}]}]});
    await journal.runRemaining(); result.value.evidence.push(fileIdentity(f.root, journal.summaryFile)); return result;
  };
  const result = await f.workflow.verify(); assert.equal(result.verdict, 'pass'); assert.equal(f.workflow.state.round, 1);
  assert.match(f.workflow.verificationStageInstructions(f.workflow.state.lastVerificationJob), /256KiB/);
});

test('changed certified inputs invalidate C before a later review', t => {
  const {workflow, root} = workflowFixture(t);
  fs.writeFileSync(path.join(root, 'candidate.json'), 'original');
  workflow.state.review = 'E';
  workflow.state.certificates.C = {inputs: [fileIdentity(root, 'candidate.json')], evidence: []};
  workflow.state.certificates.D = {inputs: [], evidence: []};
  fs.writeFileSync(path.join(root, 'candidate.json'), 'modified');
  assert.equal(workflow.certificatesStillValid(), false);
  assert.equal(workflow.state.review, 'C');
  assert.deepEqual(workflow.state.certificates, {});
});

test('a resumed state with missing approvals cannot skip straight to a later review', t => {
  const {workflow} = workflowFixture(t);
  workflow.state.review = 'F';
  workflow.state.certificates = {};
  assert.equal(workflow.certificatesStillValid(), false);
  assert.equal(workflow.state.review, 'C');
});

test('resume recreates only unused unpersisted threads and preserves used conversation history', async t => {
  const {workflow, server, directory} = workflowFixture(t);
  workflow.state.threads.supervisor = 'unused-root';
  workflow.state.threads.verifier = 'used-root';
  fs.mkdirSync(directory, {recursive: true});
  fs.writeFileSync(path.join(directory, 'events.jsonl'), JSON.stringify({kind: 'event', method: 'turn/started', threadId: 'used-root'}) + '\n');
  const request = server.request.bind(server);
  server.request = async (method, params) => {
    if (method === 'thread/resume') throw Error(`-32600: no rollout found for thread id ${params.threadId}`);
    return request(method, params);
  };
  assert.notEqual(await workflow.thread('supervisor'), 'unused-root');
  await assert.rejects(workflow.thread('verifier'), /no rollout found/);
  assert.equal(workflow.state.threads.verifier, 'used-root');
});

test('JSONL transport handles interleaved thread completions and no further inference on close', async t => {
  const root = fixture(t), script = path.join(root, 'server.mjs');
  fs.writeFileSync(script, `import {createInterface} from 'node:readline';
const output = value => process.stdout.write(JSON.stringify(value) + '\\n');
createInterface({input:process.stdin}).on('line', line => {
  const message = JSON.parse(line);
  if (message.method === 'initialize') output({id:message.id,result:{userAgent:'fixture'}});
  if (message.method === 'turn/start') {
    const id = message.params.threadId;
    output({id:message.id,result:{turn:{id:'turn-'+id,status:'inProgress'}}});
    setTimeout(() => {
      output({method:'item/completed',params:{threadId:id,item:{type:'agentMessage',phase:'final_answer',text:JSON.stringify({thread:id})}}});
      output({method:'turn/completed',params:{threadId:id,turn:{id:'turn-'+id,status:'completed',items:[]}}});
    }, id === 'a' ? 30 : 5);
  }
});`);
  const client = new AppServer({binary: process.execPath, cwd: root, serverArgs: [script], requestTimeoutMs: 1000, turnTimeoutMs: 1000});
  try {
    await client.initialize();
    const [a, b] = await Promise.all([client.runTurn('a', 'A', {}), client.runTurn('b', 'B', {})]);
    assert.deepEqual(a.value, {thread: 'a'});
    assert.deepEqual(b.value, {thread: 'b'});
  } finally { await client.close(); await client.close(); }
});
