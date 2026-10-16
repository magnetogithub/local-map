import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileIdentity, inside} from './protocol.mjs';
import {reviewBOutcome} from './review-b-outcome.mjs';
import {Workflow} from './workflow.mjs';

function fixture(t, verdict = 'fail') {
  const base = path.resolve('.tmp/review-b-outcome-tests');
  fs.mkdirSync(base, {recursive: true});
  const root = fs.mkdtempSync(path.join(base, 'test-'));
  t.after(() => {
    assert.ok(inside(base, root));
    fs.rmSync(root, {recursive: true, force: true});
  });
  const directory = path.join(root, 'reports/run');
  fs.mkdirSync(path.join(directory, 'control'), {recursive: true});
  fs.mkdirSync(path.join(root, 'reports/maintenance'), {recursive: true});
  const cleanupManifest = 'reports/maintenance/deletion-candidates.json';
  fs.writeFileSync(path.join(root, cleanupManifest), JSON.stringify({rows: [{path: 'reports/duplicate-fixture'}]}));
  const policy = {version: 1, origin: 'user-instruction', id: 'current-B-only', review: 'B',
    jobId: 'job-19', taskId: 'implementation-18', round: 19,
    verificationPath: 'reports/run/rounds/0019-B/verification.json', cleanupManifest,
    cleanupIdentity: fileIdentity(root, cleanupManifest)};
  const writePolicy = () => fs.writeFileSync(path.join(directory, 'control/review-b-outcome-policy.json'), JSON.stringify(policy));
  writePolicy();
  const state = {review: 'B', latestPrerequisiteVerification: policy.verificationPath,
    lastVerificationJob: {review: 'B', jobId: policy.jobId, taskId: policy.taskId, round: 19, verdict, completedAt: new Date().toISOString()}};
  const verification = {review: 'B', verdict, nonPassKind: verdict === 'pass' ? 'none' : 'implementation', implementationTaskId: policy.taskId};
  return {root, directory, policy, writePolicy, state, verification};
}

test('the completed current implementation failure authorizes only assessed cleanup and selective B rebuilding', t => {
  const f = fixture(t);
  const result = reviewBOutcome(f.root, f.directory, f.state, f.verification);
  assert.equal(result.action, 'compact-evidence-cleanup-and-selective-B-rebuild');
  assert.equal(result.cleanupAuthorized, true);
  assert.equal(result.cleanupManifest, f.policy.cleanupManifest);
  assert.match(result.instructions, /Prompt 14/);
  assert.match(result.instructions, /작은 증거 묶음/);
  assert.match(result.instructions, /worker가 종료/);
  assert.match(result.instructions, /reparse link/);
  assert.deepEqual(reviewBOutcome(f.root, f.directory, f.state, f.verification), result);
  assert.ok(fs.existsSync(path.join(f.root, f.policy.cleanupManifest)));
});

test('current B PASS continues to compact C without authorizing or requiring cleanup', t => {
  const f = fixture(t, 'pass');
  fs.unlinkSync(path.join(f.root, f.policy.cleanupManifest));
  const result = reviewBOutcome(f.root, f.directory, f.state, f.verification);
  assert.equal(result.action, 'continue-C-with-compact-verification');
  assert.equal(result.cleanupAuthorized, false);
  assert.equal(result.cleanupManifest, undefined);
  assert.match(result.instructions, /모든 원문 통과 조건은 유지/);
});

test('stale reviews, other jobs, missing completion and different implementation tasks do not select a cleanup branch', t => {
  const f = fixture(t);
  const changes = [
    state => { state.review = 'C'; },
    state => { delete state.lastVerificationJob; },
    state => { delete state.lastVerificationJob.completedAt; },
    state => { state.lastVerificationJob.jobId = 'older-job'; },
    state => { state.lastVerificationJob.taskId = 'older-implementation'; },
    state => { state.lastVerificationJob.round = 18; },
    state => { state.lastVerificationJob.review = 'C'; },
    state => { state.lastVerificationJob.verdict = 'pass'; },
    state => { state.latestPrerequisiteVerification = 'reports/run/rounds/0018-B/verification.json'; },
  ];
  for (const change of changes) {
    const state = structuredClone(f.state);
    change(state);
    assert.equal(reviewBOutcome(f.root, f.directory, state, f.verification), null);
  }
  assert.equal(reviewBOutcome(f.root, f.directory, f.state, {...f.verification, implementationTaskId: 'other-task'}), null);
  assert.equal(reviewBOutcome(f.root, f.directory, f.state, {...f.verification, review: 'C'}), null);
});

test('environment failures, blocked and incomplete executions never authorize destructive cleanup', t => {
  const f = fixture(t);
  assert.equal(reviewBOutcome(f.root, f.directory, f.state, {...f.verification, nonPassKind: 'environment'}), null);
  for (const verdict of ['blocked', 'timeout', 'running']) {
    const state = structuredClone(f.state);
    state.lastVerificationJob.verdict = verdict;
    assert.equal(reviewBOutcome(f.root, f.directory, state, {...f.verification, verdict}), null);
  }
});

test('cleanup requires the originally assessed bytes and a project maintenance path', t => {
  const f = fixture(t);
  fs.appendFileSync(path.join(f.root, f.policy.cleanupManifest), 'changed');
  assert.throws(() => reviewBOutcome(f.root, f.directory, f.state, f.verification), /bytes changed/);
  f.policy.cleanupManifest = 'src/delete.json';
  f.writePolicy();
  assert.throws(() => reviewBOutcome(f.root, f.directory, f.state, f.verification), /escapes authorized maintenance/);
  f.policy.cleanupManifest = '../outside.json';
  f.writePolicy();
  assert.throws(() => reviewBOutcome(f.root, f.directory, f.state, f.verification), /escapes project/);
});

test('absent user instruction does not change existing workflow decisions', t => {
  const f = fixture(t);
  fs.unlinkSync(path.join(f.directory, 'control/review-b-outcome-policy.json'));
  assert.equal(reviewBOutcome(f.root, f.directory, f.state, f.verification), null);
});

for (const verdict of ['fail', 'pass']) test(`the actual supervisor handoff persists the user's ${verdict} branch even when its generated plan omits it`, async t => {
  const f = fixture(t, verdict);
  const workflow = Object.assign(Object.create(Workflow.prototype), {
    root: f.root, directory: f.directory, state: {...f.state, repairAttempts: 16},
    stateFile: path.join(f.directory, 'state.json'), roundDirectory: path.join(f.directory, 'rounds/0019-B'), reviewUnits: true,
    turn: async (role, key, prompt) => {
      assert.equal(role, 'supervisor');
      assert.equal(key, 'supervisor');
      assert.match(prompt, /현재 사용자의 결과 분기 지시/);
      return {review: 'B', action: verdict === 'pass' ? 'advance' : 'repair', repairReview: 'B',
        repairPrompt: 'A concrete plan with no user branch text.', summary: 'Plan', repairCoverage: [],
        branchPlans: [], blockerKind: 'none', blockerEvidence: ''};
    },
  });
  const decision = await workflow.supervise(f.verification);
  assert.match(decision.repairPrompt, /현재 사용자의 결과 분기 지시/);
  const persisted = JSON.parse(fs.readFileSync(path.join(workflow.roundDirectory, 'decision.json'), 'utf8'));
  assert.equal(persisted.repairPrompt, decision.repairPrompt);
  const receipt = JSON.parse(fs.readFileSync(path.join(workflow.roundDirectory, 'review-b-user-outcome.json'), 'utf8'));
  assert.equal(receipt.jobId, f.policy.jobId);
  assert.equal(receipt.cleanupAuthorized, verdict === 'fail');
  assert.equal(JSON.parse(fs.readFileSync(workflow.stateFile, 'utf8')).reviewBUserOutcome.verdict, verdict);
});
