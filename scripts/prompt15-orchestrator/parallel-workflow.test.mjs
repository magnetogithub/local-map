import fs from 'node:fs';
import path from 'node:path';
import {test, expect} from 'vitest';
import {TaskWorkflow} from './task-workflow.mjs';
import {CONTROLLER_TASK_IMPLEMENTATION_SCHEMA} from './task-protocol.mjs';
import {atomicJSON, fileIdentity, PROMPT14_GATES} from './protocol.mjs';
import {productSnapshot} from './product-target.mjs';
import {prepareManualBaselineReceipt} from './launch-policy.mjs';

const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return {promise, resolve};
};

// These are scheduling control fixtures, not product acceptance verdicts. The
// actual run/assignment/native implementation path stays intact; only product
// acceptance and merge are replaced by explicit synthetic control boundaries.
function fixture(context, {taskCount = 5, beforeNativeCompletion = async () => {}, repairOnce = false} = {}) {
  const base = path.resolve('.tmp/parallel-workflow-tests');
  fs.mkdirSync(base, {recursive: true});
  const root = fs.mkdtempSync(path.join(base, 'case-'));
  context.onTestFinished(() => {
    if (!root.startsWith(base + path.sep)) throw Error('Unsafe scheduling fixture cleanup');
    fs.rmSync(root, {recursive: true, force: true});
  });
  const candidate = path.join(root, 'reports/manual-candidate');
  fs.mkdirSync(path.join(candidate, 'src'), {recursive: true});
  atomicJSON(path.join(candidate, 'package.json'), {type: 'module'});
  fs.writeFileSync(path.join(candidate, 'src/base.txt'), 'preserved scheduling fixture');
  const proofFile = path.join(root, 'reports/manual-proof.json');
  atomicJSON(proofFile, {kind: 'synthetic scheduling fixture only'});
  const proof = fileIdentity(root, proofFile);
  const verdictFile = path.join(root, 'reports/manual-verdict.json');
  atomicJSON(verdictFile, {
    review: 'prompt14', verdict: 'pass', nonPassKind: 'none',
    summary: 'Synthetic scheduling control fixture; never a project acceptance claim',
    checks: PROMPT14_GATES.map(id => ({id, status: 'pass', evidencePaths: [proof.path], detail: 'control fixture'})),
    inputs: Object.keys(productSnapshot(candidate)).map(file => fileIdentity(root, path.join(candidate, file))),
    evidence: [proof], commands: [{command: 'control fixture', exitCode: 0, evidencePath: proof.path}],
    failures: [], suggestedRepairPrompt: '',
  });
  const baseline = prepareManualBaselineReceipt(root, verdictFile, candidate, path.join(root, 'reports/accepted'));
  atomicJSON(path.join(root, 'package.json'), {});
  for (const file of ['worker.txt', 'prompt.txt', 'rules.txt']) fs.writeFileSync(path.join(root, file), 'Scheduling control fixture only');
  const config = {
    manualBaselineReceipt: baseline.path, executionMode: 'orchestrated', boundProductTargets: true,
    implementationUnit: 'task', taskVerificationMode: 'controller-vitest', verificationFramework: 'vitest',
    maxConcurrentTasks: 4, promptPath: 'prompt.txt', rulesPath: 'rules.txt',
    roles: {implementer: {promptPath: 'worker.txt'}},
  };
  const events = [], nativeCalls = [], active = new Set();
  let workflow, nextThread = 0, nextTurn = 0, peak = 0, notification;
  const server = {
    on(event, callback) { notification = callback; },
    off() { notification = null; },
    async initialize() {},
    async request(method, params) {
      return {thread: {id: params.threadId ?? `control-thread-${++nextThread}`}};
    },
    async runTurn(threadId, prompt, schema, overrides) {
      expect(schema).toBe(CONTROLLER_TASK_IMPLEMENTATION_SCHEMA);
      const id = prompt.match(/taskId=(15-\d+)/)[1];
      const turnId = `control-turn-${++nextTurn}`;
      nativeCalls.push({id, threadId, attempt: workflow.state.tasks[id].attempt});
      active.add(id); peak = Math.max(peak, active.size);
      events.push(`native-start:${id}`);
      notification?.({method: 'turn/started', params: {threadId, turn: {id: turnId}}});
      try {
        await beforeNativeCompletion({id, workflow, active});
        const directory = path.join(overrides.cwd, '.reports/scheduling-control');
        fs.mkdirSync(directory, {recursive: true});
        const artifact = path.join(directory, 'artifact.json');
        atomicJSON(artifact, {kind: 'synthetic scheduling fixture', id, attempt: workflow.state.tasks[id].attempt});
        const inputManifestPath = path.join(directory, 'inputs.json');
        atomicJSON(inputManifestPath, {version: 1, inputs: [fileIdentity(root, artifact)]});
        const testPlanPath = path.join(directory, 'test-plan.json');
        atomicJSON(testPlanPath, {kind: 'synthetic fixture; not an accepted test suite'});
        events.push(`native-end:${id}`);
        return {turnId, value: {
          taskId: id, candidateRoot: overrides.cwd, status: 'completed', summary: 'Synthetic scheduling fixture',
          changedFiles: [], artifactPaths: [artifact], commands: [], remainingIssues: [], inputManifestPath, testPlanPath,
        }};
      } finally { active.delete(id); }
    },
  };
  const directory = path.join(root, 'reports/run');
  fs.mkdirSync(directory, {recursive: true});
  workflow = new TaskWorkflow({root, directory, config, server});
  workflow.plan = {...workflow.plan, tasks: workflow.plan.tasks.slice(0, taskCount).map(task => ({
    ...task, dependsOn: task.id === '15-01' ? [] : ['15-01'],
  }))};
  workflow.guardian = {async inspect() { return {decision: 'continue', summary: 'Synthetic control boundary inspection', ruleChanges: []}; }};
  workflow.verify = async task => {
    const row = workflow.state.tasks[task.id];
    events.push(`verify:${task.id}:${row.attempt}`);
    const repaired = repairOnce && task.id === '15-01' && row.attempt === 1;
    const file = path.join(row.attemptDirectory, 'synthetic-control-verdict.json');
    atomicJSON(file, {kind: 'synthetic scheduling fixture only', verdict: repaired ? 'fail' : 'pass', inputs: [row.target.manifest], evidence: []});
    row.verification = path.relative(root, file);
    row.status = repaired ? 'repair' : 'verified';
    workflow.save();
  };
  workflow.merge = task => {
    const row = workflow.state.tasks[task.id];
    row.status = 'pass'; row.acceptedTarget = row.target;
    events.push(`merge:${task.id}:${row.attempt}`);
    workflow.save();
  };
  workflow.review = async () => { throw Error('Controlled scheduling fixture boundary; no product REVIEW issued'); };
  return {workflow, events, nativeCalls, get peak() { return peak; }};
}

test('four actual implementation sessions run concurrently and fast branches verify and merge before the slow sibling finishes', async context => {
  const allStarted = deferred(), releaseSlow = deferred(), fastMerged = deferred();
  const f = fixture(context, {beforeNativeCompletion: async ({id, active}) => {
    if (id === '15-01') return;
    if (active.size === 4) allStarted.resolve();
    await allStarted.promise;
    if (id === '15-02') await releaseSlow.promise;
  }});
  const merge = f.workflow.merge;
  f.workflow.merge = task => {
    merge(task);
    if (['15-03', '15-04', '15-05'].every(id => f.workflow.state.tasks[id].status === 'pass')) fastMerged.resolve();
  };
  const running = f.workflow.run().catch(error => error);
  let timer, completedBeforeSlowRelease, slowState;
  try {
    completedBeforeSlowRelease = await Promise.race([
      fastMerged.promise.then(() => true),
      new Promise(resolve => { timer = setTimeout(() => resolve(false), 5000); }),
    ]);
    slowState = f.workflow.state.tasks['15-02'].status;
  } finally {
    clearTimeout(timer);
    allStarted.resolve(); releaseSlow.resolve();
  }
  const finish = await running;
  expect(finish.message).toMatch(/Controlled scheduling fixture boundary/);
  expect(completedBeforeSlowRelease).toBe(true);
  expect(slowState).toBe('running');
  expect(f.peak).toBe(4);
  const slowEnd = f.events.indexOf('native-end:15-02');
  for (const id of ['15-03', '15-04', '15-05']) {
    expect(f.events.indexOf(`verify:${id}:1`)).toBeLessThan(slowEnd);
    expect(f.events.indexOf(`merge:${id}:1`)).toBeLessThan(slowEnd);
  }
  const keys = f.workflow.plan.tasks.map(task => f.workflow.state.tasks[task.id].implementationKey);
  expect(keys).toEqual(['15-01', '15-02', '15-03', '15-04', '15-05'].map(id => `implementer-${id}`));
  expect(new Set(f.nativeCalls.map(call => call.threadId)).size).toBe(5);
}, 30000);

test('an actual same-task implementation repair keeps its native session while incrementing the attempt', async context => {
  const f = fixture(context, {taskCount: 1, repairOnce: true});
  await expect(f.workflow.run()).rejects.toThrow(/Controlled scheduling fixture boundary/);
  expect(f.nativeCalls.map(call => call.attempt)).toEqual([1, 2]);
  expect(f.nativeCalls.map(call => call.id)).toEqual(['15-01', '15-01']);
  expect(f.nativeCalls[1].threadId).toBe(f.nativeCalls[0].threadId);
  expect(f.workflow.state.tasks['15-01'].implementationKey).toBe('implementer-15-01');
  expect(f.workflow.state.tasks['15-01'].status).toBe('pass');
  expect(f.events.filter(event => event.startsWith('verify:'))).toEqual(['verify:15-01:1', 'verify:15-01:2']);
}, 30000);

test('a newly released dependency fills a slot while an unrelated sibling is still running', async context => {
  const allStarted=deferred(),releaseSlow=deferred(),childStarted=deferred();
  const f=fixture(context,{taskCount:7,beforeNativeCompletion:async({id,active})=>{
    if(id==='15-01')return;
    if(id==='15-07'){childStarted.resolve();return;}
    if(active.size===4)allStarted.resolve();
    await allStarted.promise;
    if(id==='15-03')await releaseSlow.promise;
  }});
  f.workflow.plan.tasks=f.workflow.plan.tasks.filter(task=>task.id!=='15-06').map(task=>task.id==='15-07'?{...task,dependsOn:['15-04']}:task);
  const running=f.workflow.run().catch(error=>error);let timer,startedBeforeSlow;
  try{
    startedBeforeSlow=await Promise.race([childStarted.promise.then(()=>true),new Promise(resolve=>{timer=setTimeout(()=>resolve(false),5000);})]);
    expect(f.workflow.state.tasks['15-03'].status).toBe('running');
  }finally{clearTimeout(timer);allStarted.resolve();releaseSlow.resolve();}
  await running;expect(startedBeforeSlow).toBe(true);expect(f.peak).toBeLessThanOrEqual(4);
  expect(f.events.indexOf('merge:15-04:1')).toBeLessThan(f.events.indexOf('native-start:15-07'));
  expect(f.events.indexOf('native-start:15-07')).toBeLessThan(f.events.indexOf('native-end:15-03'));
},30000);

test('pending operating repair fences new children, drains admitted work, and applies at the first empty product handoff',async context=>{
  const started=deferred(),releaseSlow=deferred(),repairPending=deferred();
  const f=fixture(context,{taskCount:7,beforeNativeCompletion:async({id,active})=>{
    if(id==='15-01')return;
    if(active.size===4)started.resolve();await started.promise;
    if(id==='15-03')await releaseSlow.promise;
  }});
  f.workflow.plan.tasks=f.workflow.plan.tasks.filter(t=>t.id!=='15-06').map(t=>t.id==='15-07'?{...t,dependsOn:['15-04']}:t);
  const merge=f.workflow.merge;f.workflow.merge=task=>{merge(task);if(task.id==='15-04'){f.workflow.state.supervisorOversight={pendingRepairIdentity:{sha256:'synthetic-operating-repair'}};repairPending.resolve();}};
  let applied=false;f.workflow.oversight.applyPendingRepair=async()=>{
    if(!f.workflow.state.supervisorOversight?.pendingRepairIdentity||Object.values(f.workflow.state.activeOperations??{}).some(op=>op.kind==='product-handoff'))return false;
    applied=true;throw Error('Controlled drained repair boundary');
  };
  const running=f.workflow.run().catch(error=>error);let timer;
  try{await Promise.race([repairPending.promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Repair did not become pending')),5000);})]);expect(f.workflow.state.tasks['15-03'].status).toBe('running');expect(f.nativeCalls.some(call=>call.id==='15-07')).toBe(false);}
  finally{clearTimeout(timer);started.resolve();releaseSlow.resolve();}
  const result=await running;expect(result.code).toBe('SUPERVISOR_RECONCILE');expect(applied).toBe(true);expect(f.nativeCalls.some(call=>call.id==='15-07')).toBe(false);
},30000);
