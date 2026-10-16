import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {VerificationStages, identity} from './verification-stages.mjs';
import {inside} from './protocol.mjs';
import {classifyFailure, recordRuntimeFailure} from './policy.mjs';

async function fixture(t) {
  const base = path.resolve('.tmp/stage-journal-tests'); fs.mkdirSync(base, {recursive: true});
  const root = fs.mkdtempSync(path.join(base, 'test-')), report = path.join(root, 'verification'); fs.mkdirSync(report);
  t.after(() => { assert.ok(inside(base, root) && root !== base); fs.rmSync(root, {recursive: true, force: true}); });
  fs.writeFileSync(path.join(root, 'candidate.json'), '{"value":1}');
  const helper = path.join(root, 'check.mjs');
  fs.writeFileSync(helper, `import fs from 'node:fs'; const [output,count]=process.argv.slice(2); const n=fs.existsSync(count)?Number(fs.readFileSync(count,'utf8')):0; fs.writeFileSync(count,String(n+1)); fs.writeFileSync(output,JSON.stringify({pass:true}));`);
  const context = {version: 1, jobId: 'job-1', review: 'B', taskId: 'implementation-1', root, reportDirectory: 'verification', requiredGates: ['physical', 'near']};
  const file = path.join(report, 'job-context.json'); fs.writeFileSync(file, JSON.stringify(context));
  const inputs = await Promise.all([process.execPath, helper, path.join(root, 'candidate.json')].map(identity));
  const stage = (id, phase, gates, dependsOn = []) => ({id, phase, gates, dependsOn, inputs,
    command: [process.execPath, helper, path.join(report, `${id}.json`), path.join(report, `${id}.count`)],
    results: [{path: `verification/${id}.json`, assertions: [{key: 'pass', equals: true}]}]});
  const plan = {jobId: context.jobId, role: 'verifier', requiredGates: context.requiredGates, stages: [stage('normal', 'normal', ['physical']), stage('regression', 'regression', ['near']), stage('final', 'final', [], ['normal', 'regression'])]};
  return {root, report, file, plan, journal: new VerificationStages(file)};
}

test('a resumed job skips only completed current independent stages and prioritizes regression', async t => {
  const f = await fixture(t); await f.journal.register(f.plan);
  await f.journal.run('regression');
  const resumed = new VerificationStages(f.file); await resumed.runRemaining();
  for (const id of ['normal', 'regression', 'final']) assert.equal(fs.readFileSync(path.join(f.report, `${id}.count`), 'utf8'), '1');
  assert.ok(resumed.record('regression').finishedAt <= resumed.record('normal').startedAt);
  const before = await identity(resumed.summaryFile); await resumed.validateComplete(); assert.deepEqual(await identity(resumed.summaryFile), before, 'final attested summary must remain stable');
  assert.equal(resumed.summary().independentReviewIssued, false);
});

test('candidate, helper, output and dependency changes invalidate cached success', async t => {
  const f = await fixture(t); await f.journal.register(f.plan); await f.journal.runRemaining();
  fs.appendFileSync(path.join(f.root, 'candidate.json'), ' ');
  assert.equal(await f.journal.eligible('normal'), false);
  await assert.rejects(f.journal.validateComplete(), /Incomplete\/stale/);
  fs.writeFileSync(path.join(f.root, 'candidate.json'), '{"value":1}');
  fs.writeFileSync(path.join(f.report, 'normal.json'), '{"pass":false}');
  assert.equal(await f.journal.eligible('normal'), false); assert.equal(await f.journal.eligible('final'), false);
  fs.writeFileSync(path.join(f.report, 'normal.json'), '{"pass":true}');
  assert.equal(await f.journal.eligible('normal'), true);
  fs.appendFileSync(path.join(f.root, 'check.mjs'), '\n'); assert.equal(await f.journal.eligible('regression'), false);
});

test('an incomplete execution is preserved and never reused or approved', async t => {
  const f = await fixture(t); await f.journal.register(f.plan);
  const stage = f.plan.stages[1], bad = path.join(f.root, 'bad.mjs');
  fs.writeFileSync(bad, 'process.exitCode=1;');
  stage.command[1] = bad; stage.inputs = [...stage.inputs, await identity(bad)];
  await f.journal.register(f.plan, true);
  await assert.rejects(f.journal.run('regression'), /did not complete/);
  assert.equal(f.journal.record('regression').status, 'incomplete'); assert.equal(await f.journal.eligible('regression'), false);
  stage.command[1] = path.join(f.root, 'check.mjs');
  await f.journal.register(f.plan, true); await f.journal.run('regression');
  assert.equal(f.journal.record('regression').attempt, 2);
  assert.ok(fs.existsSync(path.join(f.report, 'stages/regression.attempt-1.json')));
});

test('plan scope cannot omit a case/gate/assertion, acquire producer authority, or change jobs', async t => {
  const f = await fixture(t); await f.journal.register(f.plan);
  for (const mutate of [p => p.stages.pop(), p => p.stages[0].results[0].assertions[0].equals = false, p => p.role = 'implementer', p => p.jobId = 'another']) {
    const p = structuredClone(f.plan); mutate(p); await assert.rejects(f.journal.register(p, true));
  }
  const forged = structuredClone(f.plan); forged.stages.pop(); fs.writeFileSync(f.journal.planFile, JSON.stringify(forged));
  await assert.rejects(f.journal.validateComplete(), /identity\/scope/);
});

test('helper correction invalidates only affected stages and dependent checks', async t => {
  const f = await fixture(t); await f.journal.register(f.plan); await f.journal.runRemaining();
  const replacement = path.join(f.root, 'corrected.mjs'); fs.copyFileSync(path.join(f.root, 'check.mjs'), replacement);
  const stage = f.plan.stages[0]; stage.command[1] = replacement; stage.inputs = [...stage.inputs, await identity(replacement)];
  stage.results[0].path = 'verification/normal-corrected.json'; stage.command[2] = path.join(f.report, 'normal-corrected.json');
  await f.journal.register(f.plan, true);
  assert.equal(await f.journal.eligible('regression'), true); assert.equal(await f.journal.eligible('normal'), false); assert.equal(await f.journal.eligible('final'), false);
  await f.journal.runRemaining(); assert.equal(fs.readFileSync(path.join(f.report, 'regression.count'), 'utf8'), '1');
  assert.equal(fs.readFileSync(path.join(f.report, 'normal.count'), 'utf8'), '2');
});

test('platform rejection waits immediately; timeout remains recoverable without REVIEW strikes', () => {
  const state = {review: 'B', phase: 'verify', reviewStrikes: {B: {totalFailures: 4}}};
  const error = Error('Turn failed: This content was flagged for possible cybersecurity risk');
  assert.equal(classifyFailure(error, state), 'waiting_execution'); recordRuntimeFailure(state, error);
  assert.equal(state.executionFailure.kind, 'platform_rejection'); assert.equal(state.reviewStrikes.B.totalFailures, 4);
  assert.equal(classifyFailure(Error('Turn timeout for thread; no completion was certified'), state), 'recovering');
});

test('an interrupted dispatcher never duplicates its still-running child stage', async t => {
  const f = await fixture(t); await f.journal.register(f.plan);
  fs.writeFileSync(path.join(f.report, 'stages/regression.lock'), JSON.stringify({pid: 2147483647}));
  fs.writeFileSync(f.journal.recordFile('regression'), JSON.stringify({jobId: f.journal.context.jobId, status: 'running', pid: process.pid, attempt: 1}));
  await assert.rejects(f.journal.run('regression'), /child is still running/);
  assert.equal(await f.journal.eligible('regression'), false);
});
