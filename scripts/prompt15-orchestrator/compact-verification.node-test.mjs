import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {runBoundedCommand, copySmallFixture} from './bounded-output.mjs';
import {runNodeChecks} from './run-node-checks.mjs';
import {CompactVerificationStages, createVerificationStages} from './verification-stages-compact.mjs';
import {VerificationStages, identity} from './verification-stages.mjs';
import {inside} from './protocol.mjs';

function scratch(t) {
  const base = path.resolve('.tmp/compact-verification-tests'); fs.mkdirSync(base, {recursive: true});
  const root = fs.mkdtempSync(path.join(base, 'test-'));
  t.after(() => { assert.ok(inside(base, root) && root !== base); fs.rmSync(root, {recursive: true, force: true}); });
  return root;
}

test('32 MiB of output per stream drains successfully and retains at most 256 KiB each', async t => {
  const root = scratch(t), helper = path.join(root, 'noisy.mjs');
  fs.writeFileSync(helper, `const b=Buffer.alloc(1024*1024,97);for(let i=0;i<32;i++){process.stdout.write(b);process.stderr.write(b);}process.stdout.write('END');`);
  const result = await runBoundedCommand({command: [process.execPath, helper], cwd: root, logPrefix: path.join(root, 'capture')});
  assert.equal(result.exitCode, 0);
  for (const stream of [result.stdout, result.stderr]) {
    assert.equal(stream.byteLength, 256 * 1024); assert.equal(fs.statSync(stream.path).size, stream.byteLength);
    assert.equal(stream.truncated, true); assert.ok(stream.observedBytes >= 32 * 1024 * 1024);
    const expected = createHash('sha256'); for (let i = 0; i < 32; i++) expected.update(Buffer.alloc(1024 * 1024, 97));
    if (stream === result.stdout) expected.update('END');
    assert.equal(stream.observedSha256, expected.digest('hex'));
  }
  assert.ok(fs.readFileSync(result.stdout.path).subarray(-3).equals(Buffer.from('END')));
});

test('small fixtures copy only requested files, enforce their budget, and keep the baseline unchanged', t => {
  const root = scratch(t), source = path.join(root, 'baseline'); fs.mkdirSync(source);
  fs.writeFileSync(path.join(source, 'small.json'), '{"id":1}'); fs.writeFileSync(path.join(source, 'large.bin'), Buffer.alloc(1024 * 1024));
  assert.throws(() => copySmallFixture(source, path.join(root, 'over-budget'), ['large.bin'], 1024), /budget/);
  assert.equal(fs.existsSync(path.join(root, 'over-budget')), false);
  copySmallFixture(source, path.join(root, 'fixture'), ['small.json'], 1024);
  assert.equal(fs.existsSync(path.join(root, 'fixture/large.bin')), false);
  fs.writeFileSync(path.join(root, 'fixture/small.json'), '{"id":2}'); assert.equal(fs.readFileSync(path.join(source, 'small.json'), 'utf8'), '{"id":1}');
  assert.throws(() => copySmallFixture(source, path.join(root, 'escape'), ['../small.json']), /relative/);
});

test('the real Node reporter suppresses noisy diagnostics without hiding failures or skips', async t => {
  const root = scratch(t), relative = path.relative(process.cwd(), root), files = [];
  for (const [name, body] of [['pass', `test('ok',()=>{console.log('x'.repeat(2*1024*1024));});`],
    ['fail', `test('reject malformed input',()=>{assert.equal('accepted','rejected');});`], ['skip', `test.skip('required case',()=>{});`]]) {
    const file = path.join(root, `${name}.mjs`); fs.writeFileSync(file, `import test from 'node:test';import assert from 'node:assert/strict';${body}`); files.push(file);
    const result = await runNodeChecks(process.cwd(), path.join(relative, `${name}-output`), [file]);
    assert.equal(result.pass, name === 'pass', JSON.stringify(result.tests ?? result.execution)); assert.equal(result.tests.complete, true);
    assert.ok(result.execution.stdout.byteLength < 8192);
    if (name === 'pass') assert.ok(result.tests.diagnosticBytes > 1024 * 1024);
    if (name === 'fail') assert.match(result.tests.failures[0].message, /accepted|rejected/);
    if (name === 'skip') assert.equal(result.tests.counts.skipped, 1);
  }
  await assert.rejects(runNodeChecks(process.cwd(), path.join(relative, 'pass-output'), files), /fresh/);
});

async function journalFixture(t) {
  const root = scratch(t), directory = path.join(root, 'verification'); fs.mkdirSync(directory);
  fs.writeFileSync(path.join(root, 'candidate.json'), '{"value":1}');
  const helper = path.join(root, 'check.mjs');
  fs.writeFileSync(helper, `import fs from 'node:fs';const [output,count]=process.argv.slice(2);fs.writeFileSync(count,String((fs.existsSync(count)?Number(fs.readFileSync(count)):0)+1));fs.writeFileSync(output,'{"pass":true}');`);
  const context = {jobId: 'job-compact', review: 'B', taskId: 'task-1', root, reportDirectory: 'verification', requiredGates: ['physical', 'identity']};
  const file = path.join(directory, 'job-context.json'); fs.writeFileSync(file, JSON.stringify(context));
  const inputs = await Promise.all([process.execPath, helper, path.join(root, 'candidate.json')].map(identity));
  const manifest = path.join(directory, 'common-inputs.json'); fs.writeFileSync(manifest, JSON.stringify({version: 1, inputs}));
  const stage = (id, phase, gates, dependsOn = []) => ({id, phase, gates, dependsOn, inputSets: ['common'], inputs: [],
    command: [process.execPath, helper, path.join(directory, `${id}.json`), path.join(directory, `${id}.count`)],
    results: [{path: `verification/${id}.json`, assertions: [{key: 'pass', equals: true}]}]});
  const plan = {version: 2, jobId: context.jobId, role: 'verifier', requiredGates: context.requiredGates, inputSets: {common: await identity(manifest)},
    stages: [stage('regression', 'regression', ['identity']), stage('normal', 'normal', ['physical']), stage('final', 'final', [], ['regression', 'normal'])]};
  return {root, directory, file, manifest, inputs, plan, journal: new CompactVerificationStages(file)};
}

test('shared manifests avoid repeated pin arrays and completed stages remain eligible after restart', async t => {
  const f = await journalFixture(t); await f.journal.register(f.plan); await f.journal.runRemaining();
  const resumed = createVerificationStages(f.file); assert.ok(resumed instanceof CompactVerificationStages);
  await resumed.runRemaining();
  for (const id of ['normal', 'regression', 'final']) {
    assert.equal(fs.readFileSync(path.join(f.directory, `${id}.count`), 'utf8'), '1');
    const record = resumed.record(id); assert.equal(record.before.count, 3); assert.equal(Array.isArray(record.before), false);
    assert.ok(fs.statSync(resumed.recordFile(id)).size < 8192);
  }
  assert.equal(fs.readFileSync(resumed.planFile, 'utf8').includes(f.inputs[2].sha256), false);
  const before = await identity(resumed.summaryFile); await resumed.validateComplete(); assert.deepEqual(await identity(resumed.summaryFile), before);
  assert.equal(resumed.summary().independentReviewIssued, false);
});

test('candidate bytes, shared manifest bytes, results, logs and dependencies invalidate reuse', async t => {
  const f = await journalFixture(t); await f.journal.register(f.plan); await f.journal.runRemaining();
  for (const target of [path.join(f.root, 'candidate.json'), f.manifest, path.join(f.directory, 'regression.json'), f.journal.record('regression').stdout.path]) {
    const original = fs.readFileSync(target); fs.appendFileSync(target, ' ');
    assert.equal(await f.journal.eligible('regression'), false); assert.equal(await f.journal.eligible('final'), false);
    await assert.rejects(f.journal.validateComplete(), /Incomplete\/stale/); fs.writeFileSync(target, original);
    assert.equal(await f.journal.eligible('regression'), true);
  }
});

test('an exit-zero command with a failed assertion cannot certify a stage', async t => {
  const f = await journalFixture(t), bad = path.join(f.root, 'false.mjs'); fs.writeFileSync(bad, `import fs from 'node:fs';fs.writeFileSync(process.argv[2],'{"pass":false}');`);
  f.plan.stages[0].command[1] = bad; f.plan.stages[0].inputs = [await identity(bad)];
  await f.journal.register(f.plan); await assert.rejects(f.journal.run('regression'), /assertion failed/);
  assert.equal(f.journal.record('regression').exitCode, 0); assert.equal(f.journal.record('regression').status, 'incomplete');
  assert.equal(await f.journal.eligible('regression'), false);
});

test('compact plans preserve scope and use legacy execution only for an existing legacy plan', async t => {
  const f = await journalFixture(t); await f.journal.register(f.plan);
  for (const mutate of [p => p.stages.pop(), p => p.stages[0].results[0].assertions[0].equals = false, p => p.role = 'implementer']) {
    const changed = structuredClone(f.plan); mutate(changed); await assert.rejects(f.journal.register(changed, true));
  }
  const legacy = {...f.plan}; delete legacy.version;
  fs.writeFileSync(f.journal.planFile, JSON.stringify(legacy));
  const selected = createVerificationStages(f.file); assert.ok(selected instanceof VerificationStages); assert.equal(selected instanceof CompactVerificationStages, false);
});
