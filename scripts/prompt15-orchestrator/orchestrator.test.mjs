import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {afterEach, describe, expect, test} from 'vitest';
import {Prompt15Orchestrator} from './orchestrator.mjs';
import {atomicJson} from './protocol.mjs';
import {initialState} from './state-machine.mjs';

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

  test('a verifier response that disagrees with its evidence is an operating failure, not a product retry', async () => {
    const dishonest = structuredClone(passed);
    dishonest.verdict = 'fail';
    dishonest.failureKind = 'product';
    const f = fixture([structuredClone(implementation), dishonest]);
    const originalFactory = f.runtime.clientFactory;
    f.runtime.clientFactory = options => {
      const client = originalFactory(options);
      const runTurn = client.runTurn.bind(client);
      client.runTurn = async turnOptions => {
        const result = await runTurn(turnOptions);
        if (result.value.verdictPath) {
          fs.writeFileSync(result.value.verdictPath, `${JSON.stringify({verdict: 'pass', checks: result.value.checks})}\n`);
        }
        return result;
      };
      return client;
    };
    const result = await f.runtime.run();
    expect(result.status).toBe('operating_failure');
    expect(result.productAttempt).toBe(1);
    expect(f.calls).toEqual(['implementer', 'verifier']);
  });

  test('an explicitly acknowledged operating failure resumes only its failed phase', async () => {
    const error = Object.assign(Error('transport unavailable'), {code: 'TRANSPORT'});
    const f = fixture([error, structuredClone(implementation), structuredClone(passed)]);
    const failedRun = await f.runtime.run();
    expect(failedRun.status).toBe('operating_failure');

    const {acknowledgeOperatingFailure} = await import('./state-machine.mjs');
    f.runtime.state = acknowledgeOperatingFailure(failedRun);
    f.runtime.save();
    const resumed = await f.runtime.run();

    expect(resumed.status).toBe('passed');
    expect(f.calls).toEqual(['implementer', 'implementer', 'verifier']);
    expect(resumed.operatingIncident.acknowledgedAt).toBeTruthy();
  });
});
