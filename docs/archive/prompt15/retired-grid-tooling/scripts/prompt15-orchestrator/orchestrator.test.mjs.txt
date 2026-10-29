import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {afterEach, describe, expect, test} from 'vitest';
import {Prompt15Orchestrator} from './orchestrator.mjs';
import {atomicJson, fileIdentity, readJson} from './protocol.mjs';
import {acknowledgeOperatingFailure, initialState} from './state-machine.mjs';

const roots = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, {recursive: true, force: true}); });

function fixture(responses) {
  const root = path.resolve('.tmp/prompt15-v2-tests', randomUUID());
  roots.push(root);
  const directory = path.join(root, 'reports/prompt15/orchestrator-v2/run');
  const workspace = path.join(directory, 'workspace');
  fs.mkdirSync(workspace, {recursive: true});
  fs.mkdirSync(path.join(root, 'automation/prompt15'), {recursive: true});
  for (const role of ['implementer', 'verifier']) fs.writeFileSync(path.join(root, `automation/prompt15/${role}.txt`), role);
  atomicJson(path.join(directory, 'state.json'), initialState({runId: 'run', taskId: '15-18', workspace, maxProductAttempts: 2}));
  const calls = [];
  class FakeClient {
    async initialize() {}
    async startThread({role}) { this.role = role.promptPath.includes('implementer') ? 'implementer' : 'verifier'; return `${this.role}-${calls.length + 1}`; }
    async runTurn(options) {
      const value = responses.shift();
      calls.push(this.role);
      if (value instanceof Error) throw value;
      if (this.role === 'verifier') {
        const evidence = path.join(workspace, '.prompt15-v2/verification', `evidence-${calls.length}.json`);
        fs.mkdirSync(path.dirname(evidence), {recursive: true});
        value.verdictPath = evidence;
        value.evidencePaths = [evidence];
        fs.writeFileSync(evidence, `${JSON.stringify({verdict: value.verdict, checks: value.checks})}\n`);
      }
      options.onStarted({threadId: `${this.role}-thread`, turnId: `${this.role}-turn`});
      return {turnId: `${this.role}-turn`, value};
    }
    async close() {}
  }
  const config = {
    promptPath: 'prompt.txt', maxProductAttempts: 2, turnTimeoutMs: 1000,
    roles: {
      implementer: {model: 'test', effort: 'low', promptPath: 'automation/prompt15/implementer.txt'},
      verifier: {model: 'test', effort: 'low', promptPath: 'automation/prompt15/verifier.txt'},
    },
  };
  const plan = {tasks: [{id: '15-18', title: 'restore', sections: ['5', '7']}]};
  return {runtime: new Prompt15Orchestrator({root, directory, config, plan, clientFactory: () => new FakeClient()}), calls, workspace};
}

const implementation = {status: 'complete', summary: 'candidate', changedFiles: [], artifactPaths: [], commands: [], remainingIssues: []};
const failed = {verdict: 'fail', failureKind: 'product', summary: 'unresolved', failures: [{code: 'UNRESOLVED', message: 'one remains'}], commands: [{command: 'v18', exitCode: 1}], checks: {positiveCandidate: false, independentCurrentBytes: true, commandExitCodesAllZero: false}};
const passed = {verdict: 'pass', failureKind: null, summary: 'pass', failures: [], commands: [{command: 'v18', exitCode: 0}], checks: {positiveCandidate: true, independentCurrentBytes: true, commandExitCodesAllZero: true, buildAllowed: true, sourceCountSVN: 193, tracedCountSVN: 193, missing: 0, duplicate: 0, unresolved: 0, componentHoleCorrespondence: true, protectedOverlayCorrespondence: true, missingFixtureRejected: true, unresolvedFixtureRejected: true}};

function inputFixture(phase, verification = passed) {
  const summary = 'Provide supplied-input.txt in the candidate workspace';
  const externalImplementation = {...implementation, status: 'external_input', summary, artifactPaths: ['unrelated-missing-artifact.json']};
  const externalVerification = {...failed, failureKind: 'external', summary};
  const responses = phase === 'implement'
    ? [externalImplementation, implementation, verification]
    : [implementation, externalVerification, verification];
  const f = fixture(structuredClone(responses));
  f.runtime.state.productAttempt = 2;
  f.runtime.state.failures = [{attempt: 1, verification: structuredClone(failed)}];
  return f;
}

function reload(runtime) {
  return new Prompt15Orchestrator({
    root: runtime.root, directory: runtime.directory,
    config: runtime.config, plan: runtime.plan, clientFactory: runtime.clientFactory,
  });
}

describe('orchestrator integration', () => {
  test('creates a new mutable workspace by copying the seed once', () => {
    const root = path.resolve('.tmp/prompt15-v2-create-tests', randomUUID());
    roots.push(root);
    const seed = path.join(root, 'legacy-seed');
    fs.mkdirSync(path.join(root, 'automation/prompt15'), {recursive: true});
    fs.mkdirSync(seed, {recursive: true});
    fs.writeFileSync(path.join(seed, 'marker.txt'), 'preserved seed\n');
    fs.writeFileSync(path.join(root, 'prompt.txt'), 'prompt\n');
    const config = {promptPath: 'prompt.txt', maxProductAttempts: 2};
    const plan = {tasks: [{id: '15-18', title: 'restore', sections: ['5', '7']}]};
    fs.writeFileSync(path.join(root, 'automation/prompt15/config.json'), `${JSON.stringify(config)}\n`);
    fs.writeFileSync(path.join(root, 'automation/prompt15/task-plan.json'), `${JSON.stringify(plan)}\n`);

    const runtime = Prompt15Orchestrator.create({root, taskId: '15-18', seed, config, plan});
    expect(fs.readFileSync(path.join(runtime.state.workspace, 'marker.txt'), 'utf8')).toBe('preserved seed\n');
    fs.writeFileSync(path.join(runtime.state.workspace, 'marker.txt'), 'candidate change\n');
    expect(fs.readFileSync(path.join(seed, 'marker.txt'), 'utf8')).toBe('preserved seed\n');
    expect(runtime.state.inputs).toHaveLength(3);
  });

  test('normal path is implement, verify, implement, verify with no supervisor or guardian', async () => {
    const f = fixture([structuredClone(implementation), structuredClone(failed), structuredClone(implementation), structuredClone(passed)]);
    const result = await f.runtime.run();
    expect(result.status).toBe('passed');
    expect(result.productAttempt).toBe(2);
    expect(f.calls).toEqual(['implementer', 'verifier', 'implementer', 'verifier']);
    expect(result.failures).toHaveLength(1);
  });

  test('an implementation BLOCKED response is still independently verified', async () => {
    const blocked = {...implementation, status: 'blocked', summary: 'candidate rejects'};
    const f = fixture([blocked, structuredClone(failed), structuredClone(implementation), structuredClone(passed)]);
    expect((await f.runtime.run()).status).toBe('passed');
    expect(f.calls.slice(0, 2)).toEqual(['implementer', 'verifier']);
  });

  test('an operating exception stops without an automatic model retry', async () => {
    const error = Object.assign(Error('transport unavailable'), {code: 'TRANSPORT'});
    const f = fixture([error]);
    const result = await f.runtime.run();
    expect(result.status).toBe('operating_failure');
    expect(f.calls).toEqual(['implementer']);
    expect(result.operatingIncident.message).toBe('transport unavailable');
    expect(result.operatingIncident.resumePhase).toBe('implement');
  });

  test.each([
    ['a verifier operating failure', {...failed, failureKind: 'operating', summary: 'verification runtime unavailable'}, () => {}],
    ['a verdict mismatch', passed, value => {
      atomicJson(value.verdictPath, {verdict: 'fail', checks: value.checks});
    }],
    ['missing evidence', passed, value => { fs.unlinkSync(value.verdictPath); }],
    ['mismatched PASS checks', passed, value => {
      atomicJson(value.verdictPath, {verdict: value.verdict, checks: {...value.checks, buildAllowed: false}});
    }],
    ['a non-zero PASS command', {...passed, commands: [{command: 'v18', exitCode: 1}]}, () => {}],
  ])('%s waits for acknowledgement and resumes verification in the same attempt', async (_name, response, alterEvidence) => {
    const f = fixture([structuredClone(implementation), structuredClone(response), structuredClone(passed)]);
    const originalFactory = f.runtime.clientFactory;
    f.runtime.clientFactory = options => {
      const client = originalFactory(options);
      const runTurn = client.runTurn.bind(client);
      client.runTurn = async turnOptions => {
        const result = await runTurn(turnOptions);
        if (f.calls.length === 2) alterEvidence(result.value);
        return result;
      };
      return client;
    };
    // A prior product failure must survive an operating interruption at the
    // attempt limit, without consuming another product attempt.
    const previousFailure = {attempt: 1, verification: structuredClone(failed)};
    f.runtime.state.productAttempt = 2;
    f.runtime.state.failures = [previousFailure];
    const result = await f.runtime.run();
    expect(result.status).toBe('operating_failure');
    expect(result.productAttempt).toBe(2);
    expect(result.failures).toEqual([previousFailure]);
    expect(result.activeTurn).toBeNull();
    expect(result.operatingIncident).toMatchObject({
      resumePhase: 'verify',
      message: result.lastVerification.value.summary,
      identity: result.lastVerification.verdictIdentity,
    });
    expect(f.calls).toEqual(['implementer', 'verifier']);

    const implementationResult = structuredClone(result.lastImplementation);
    const failedVerification = structuredClone(result.lastVerification);
    const failedResponseFile = path.join(f.runtime.root, failedVerification.responseIdentity.path);
    const failedVerdictFile = path.join(f.runtime.root, failedVerification.verdictIdentity.path);
    const candidateFile = path.join(f.workspace, 'candidate.txt');
    fs.writeFileSync(candidateFile, 'preserved implementation\n');
    const candidateIdentity = fileIdentity(f.runtime.root, candidateFile);

    // Reload the persisted state just as the CLI does. No acknowledgement means
    // no model call, even with a healthy verifier response ready to run.
    const reload = () => new Prompt15Orchestrator({
      root: f.runtime.root, directory: f.runtime.directory,
      config: f.runtime.config, plan: f.runtime.plan, clientFactory: f.runtime.clientFactory,
    });
    const pending = reload();
    expect(await pending.run()).toEqual(result);
    expect(f.calls).toEqual(['implementer', 'verifier']);

    pending.state = acknowledgeOperatingFailure(pending.state);
    pending.save();
    const resumed = await reload().run();

    expect(resumed.status).toBe('passed');
    expect(resumed.productAttempt).toBe(2);
    expect(resumed.failures).toEqual([previousFailure]);
    expect(resumed.lastImplementation).toEqual(implementationResult);
    expect(resumed.implementationTurns).toBe(1);
    expect(resumed.verificationTurns).toBe(2);
    expect(resumed.operatingIncident).toMatchObject({
      ...result.operatingIncident, acknowledgedAt: expect.any(String),
    });
    expect(f.calls).toEqual(['implementer', 'verifier', 'verifier']);
    expect(fileIdentity(f.runtime.root, candidateFile)).toEqual(candidateIdentity);
    expect(fileIdentity(f.runtime.root, failedResponseFile)).toEqual(failedVerification.responseIdentity);
    expect(fileIdentity(f.runtime.root, failedVerdictFile)).toEqual(failedVerification.verdictIdentity);
    expect(readJson(failedVerdictFile)).toEqual(failedVerification.value);
  });

  test('an explicitly acknowledged operating failure resumes only its failed phase', async () => {
    const error = Object.assign(Error('transport unavailable'), {code: 'TRANSPORT'});
    const f = fixture([error, structuredClone(implementation), structuredClone(passed)]);
    const failedRun = await f.runtime.run();
    expect(failedRun.status).toBe('operating_failure');

    f.runtime.state = acknowledgeOperatingFailure(failedRun);
    f.runtime.save();
    const resumed = await f.runtime.run();

    expect(resumed.status).toBe('passed');
    expect(f.calls).toEqual(['implementer', 'implementer', 'verifier']);
    expect(resumed.operatingIncident.acknowledgedAt).toBeTruthy();
  });

  test.each(['implement', 'verify'])('%s input waits for explicit acknowledgement, then resumes the same phase and attempt', async phase => {
    const f = inputFixture(phase);
    const waiting = await f.runtime.run();
    const before = structuredClone(waiting);
    const pendingCalls = [...f.calls];
    const stateBytes = fs.readFileSync(f.runtime.stateFile, 'utf8');
    const source = phase === 'implement' ? waiting.lastImplementation : waiting.lastVerification;
    const identities = [source.responseIdentity, ...(source.verdictIdentity ? [source.verdictIdentity] : [])];
    expect(waiting).toMatchObject({status: 'waiting_input', phase, productAttempt: 2});

    // Supplying an input does not itself authorize the next model call.
    fs.writeFileSync(path.join(f.workspace, 'supplied-input.txt'), 'provided input\n');
    const pending = reload(f.runtime);
    expect(await pending.run()).toEqual(before);
    expect(await pending.run({ackInput: false})).toEqual(before);
    expect(f.calls).toEqual(pendingCalls);
    expect(fs.readFileSync(f.runtime.stateFile, 'utf8')).toBe(stateBytes);

    const result = await pending.run({ackInput: true});

    expect(result.status).toBe('passed');
    expect(result.taskId).toBe(before.taskId);
    expect(result.productAttempt).toBe(2);
    expect(result.failures).toEqual(before.failures);
    expect(result).not.toHaveProperty('requiredInput');
    expect(result.inputAcknowledgement).toMatchObject({phase, attempt: 2, requiredInput: before.requiredInput, at: expect.any(String)});
    expect(f.calls).toEqual([...pendingCalls, ...(phase === 'implement' ? ['implementer', 'verifier'] : ['verifier'])]);
    if (phase === 'verify') expect(result.lastImplementation).toEqual(before.lastImplementation);
    for (const identity of identities) expect(fileIdentity(f.runtime.root, path.join(f.runtime.root, identity.path))).toEqual(identity);
    expect(waiting).toEqual(before);

    const turn = phase === 'implement' ? 'implementation' : 'verification';
    const request = readJson(path.join(f.runtime.directory, 'attempts/attempt-002', `${turn}-turn-002/request.json`));
    expect(request.productAttempt).toBe(2);
    expect(request.prompt).toContain(before.requiredInput);
    expect(request.prompt).toContain('A human explicitly confirmed');
    const events = fs.readFileSync(f.runtime.eventFile, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    expect(events.filter(event => event.kind === 'input_acknowledged')).toEqual([
      expect.objectContaining({taskId: before.taskId, phase, attempt: 2, requiredInput: before.requiredInput, responseIdentity: source.responseIdentity}),
    ]);
  });

  test.each([
    ['implement', 'response', runtime => {
      fs.appendFileSync(path.join(runtime.root, runtime.state.lastImplementation.responseIdentity.path), ' ');
    }],
    ['verify', 'response', runtime => {
      fs.appendFileSync(path.join(runtime.root, runtime.state.lastVerification.responseIdentity.path), ' ');
    }],
    ['verify', 'verdict', runtime => {
      fs.appendFileSync(path.join(runtime.root, runtime.state.lastVerification.verdictIdentity.path), ' ');
    }],
    ['implement', 'missing identity', runtime => { delete runtime.state.lastImplementation.responseIdentity; }],
    ['verify', 'unrelated identity', runtime => {
      runtime.state.lastVerification.verdictIdentity = {...runtime.state.lastVerification.verdictIdentity, path: '../outside-verdict.json'};
    }],
    ['implement', 'saved response', runtime => {
      runtime.state.requiredInput = 'a changed request';
      runtime.state.lastImplementation.value.summary = runtime.state.requiredInput;
    }],
  ])('%s input acknowledgement rejects changed %s before clearing the request or calling a model', async (phase, _name, alter) => {
    const f = inputFixture(phase);
    await f.runtime.run();
    const pending = reload(f.runtime);
    alter(pending);
    const before = structuredClone(pending.state);
    const calls = [...f.calls];
    const stateBytes = fs.readFileSync(pending.stateFile, 'utf8');
    const eventBytes = fs.readFileSync(pending.eventFile, 'utf8');

    await expect(pending.run({ackInput: true})).rejects.toThrow(/identity|response|escapes/);

    expect(pending.state).toEqual(before);
    expect(pending.state.status).toBe('waiting_input');
    expect(pending.state).not.toHaveProperty('inputAcknowledgement');
    expect(f.calls).toEqual(calls);
    expect(fs.readFileSync(pending.stateFile, 'utf8')).toBe(stateBytes);
    expect(fs.readFileSync(pending.eventFile, 'utf8')).toBe(eventBytes);
  });

  test('a new input request needs a fresh acknowledgement even in the same phase and attempt', async () => {
    const first = {...implementation, status: 'external_input', summary: 'Supply the first input'};
    const second = {...first, summary: 'Supply the second input'};
    const f = fixture(structuredClone([first, second, implementation, passed]));
    await f.runtime.run();

    const waitingAgain = await f.runtime.run({ackInput: true});

    expect(waitingAgain).toMatchObject({status: 'waiting_input', phase: 'implement', productAttempt: 1, requiredInput: second.summary});
    expect(waitingAgain.inputAcknowledgement.requiredInput).toBe(first.summary);
    expect(f.calls).toEqual(['implementer', 'implementer']);
    expect(await f.runtime.run()).toEqual(waitingAgain);
    expect(f.calls).toEqual(['implementer', 'implementer']);

    expect((await f.runtime.run({ackInput: true})).status).toBe('passed');
    expect(f.calls).toEqual(['implementer', 'implementer', 'implementer', 'verifier']);
    const events = fs.readFileSync(f.runtime.eventFile, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    expect(events.filter(event => event.kind === 'input_acknowledged').map(event => event.requiredInput)).toEqual([first.summary, second.summary]);
  });

  test('input acknowledgement does not grant PASS or relax mandatory verification proof', async () => {
    const f = inputFixture('verify', {...passed, checks: {}});
    await f.runtime.run();

    const result = await f.runtime.run({ackInput: true});

    expect(result.status).toBe('blocked');
    expect(result.productAttempt).toBe(2);
    expect(result.failures).toHaveLength(2);
    expect(result.failures.at(-1).verification.failures.map(row => row.code)).toContain('PASS_PROOF_POSITIVE_CANDIDATE_REQUIRED');
    expect(f.calls).toEqual(['implementer', 'verifier', 'verifier']);
  });
});
