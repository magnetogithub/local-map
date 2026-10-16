import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {atomicJSON, inside} from './protocol.mjs';

const digest = value => createHash('sha256').update(JSON.stringify(value) ?? 'undefined').digest('hex');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const same = (a, b) => digest(a) === digest(b);
const stamp = () => new Date().toISOString();
const safeId = id => typeof id === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/.test(id);

// Stream large artifacts; mtime and an old PASS never establish eligibility.
export async function identity(file) {
  const resolved = path.resolve(file), hash = createHash('sha256');
  if (!fs.lstatSync(resolved).isFile() || fs.realpathSync(resolved).toLowerCase() !== resolved.toLowerCase()) throw Error(`Stage input must be a regular file: ${resolved}`);
  let byteLength = 0;
  for await (const chunk of fs.createReadStream(resolved)) { hash.update(chunk); byteLength += chunk.length; }
  return {path: resolved, sha256: hash.digest('hex'), byteLength};
}

export class VerificationStages {
  constructor(contextFile) {
    this.contextFile = path.resolve(contextFile);
    this.context = read(this.contextFile);
    this.root = path.resolve(this.context.root);
    this.directory = path.resolve(this.root, this.context.reportDirectory);
    if (!inside(this.root, this.directory) || !inside(this.directory, this.contextFile) || this.directory === this.root) throw Error('Invalid stage context location');
    this.storage = path.join(this.directory, 'stages');
    this.planFile = path.join(this.storage, 'plan.json');
    this.contractFile = path.join(this.storage, 'scope.json');
    this.summaryFile = path.join(this.storage, 'progress.json');
    fs.mkdirSync(this.storage, {recursive: true});
  }

  resolveInput(name) {
    const file = path.resolve(this.root, name);
    if (!inside(this.root, file) && file.toLowerCase() !== process.execPath.toLowerCase()) throw Error(`Stage input escapes project: ${name}`);
    return file;
  }

  async pins(rows) {
    if (!Array.isArray(rows) || !rows.length) throw Error('Stage needs explicit pre-execution input identities');
    const seen = new Set(), actual = [];
    for (const row of rows) {
      const file = this.resolveInput(row.path), key = file.toLowerCase();
      if (seen.has(key)) throw Error(`Duplicate stage input: ${row.path}`);
      seen.add(key);
      const pin = await identity(file);
      if (pin.sha256 !== row.sha256 || pin.byteLength !== row.byteLength) throw Error(`Stage input changed: ${row.path}`);
      actual.push(pin);
    }
    return actual;
  }

  scope(plan) {
    return {jobId: plan.jobId, role: plan.role, requiredGates: plan.requiredGates, stages: plan.stages.map(stage => ({id: stage.id, phase: stage.phase, gates: stage.gates, dependsOn: stage.dependsOn,
      assertions: stage.results.map(result => result.assertions)}))};
  }

  async register(plan, revise = false) {
    if (plan.jobId !== this.context.jobId || plan.role !== 'verifier' || !same(plan.requiredGates, this.context.requiredGates)) throw Error('Stage plan must preserve the independent job and every required gate');
    if (!Array.isArray(plan.stages) || !plan.stages.length) throw Error('Empty stage plan');
    const ids = new Set(), covered = new Set();
    for (const stage of plan.stages) {
      if (!safeId(stage.id) || ids.has(stage.id)) throw Error('Invalid/duplicate stage id');
      ids.add(stage.id);
      if (!['regression', 'normal', 'audit', 'final'].includes(stage.phase)) throw Error('Invalid stage phase');
      if (!Array.isArray(stage.dependsOn) || !Array.isArray(stage.gates) || stage.gates.some(id => !this.context.requiredGates.includes(id))) throw Error('Invalid stage scope/dependencies');
      stage.gates.forEach(id => covered.add(id));
      if (!Array.isArray(stage.command) || stage.command.length < 2 || stage.command.some(arg => typeof arg !== 'string')) throw Error('Use a direct executable/argv command, without a shell');
      const exe = this.resolveInput(stage.command[0]), entry = this.resolveInput(stage.command[1]);
      if (![exe, entry].every(file => stage.inputs.some(pin => this.resolveInput(pin.path).toLowerCase() === file.toLowerCase()))) throw Error('Pin executable and stage entry point');
      await this.pins(stage.inputs);
      if (!Array.isArray(stage.results) || !stage.results.length) throw Error('Stage needs actual result artifacts and assertions');
      for (const result of stage.results) {
        if (!inside(this.directory, path.resolve(this.root, result.path)) || !Array.isArray(result.assertions) || !result.assertions.length) throw Error('Stage needs attested results inside this verification');
        for (const assertion of result.assertions) if (typeof assertion.key !== 'string' || !Object.hasOwn(assertion, 'equals')) throw Error('Invalid result assertion');
      }
    }
    for (const stage of plan.stages) if (stage.dependsOn.some(id => !ids.has(id) || id === stage.id)) throw Error('Unknown stage dependency');
    const visited = new Set(), visiting = new Set();
    const visit = id => { if (visiting.has(id)) throw Error('Stage dependency cycle'); if (visited.has(id)) return; visiting.add(id); plan.stages.find(s => s.id === id).dependsOn.forEach(visit); visiting.delete(id); visited.add(id); };
    ids.forEach(visit);
    if (this.context.requiredGates.some(id => !covered.has(id))) throw Error('Stage plan omits a required gate');
    if (fs.existsSync(this.planFile)) {
      if (!same(read(this.planFile), plan)) {
        if (!revise || !same(read(this.contractFile), this.scope(plan))) throw Error('Stage scope is immutable; revise only execution helpers/input identities, preserving all stages and assertions');
        const archived = path.join(this.storage, `plan-${digest(read(this.planFile))}.json`);
        if (!fs.existsSync(archived)) fs.copyFileSync(this.planFile, archived);
        atomicJSON(this.planFile, plan);
      }
    } else {
      fs.writeFileSync(this.planFile, JSON.stringify(plan, null, 2), {flag: 'wx'});
      fs.writeFileSync(this.contractFile, JSON.stringify(this.scope(plan), null, 2), {flag: 'wx'});
    }
    return this.summary();
  }

  plan() {
    const plan = read(this.planFile);
    if (plan.jobId !== this.context.jobId || plan.role !== 'verifier' || !same(plan.requiredGates, this.context.requiredGates) || !plan.stages?.length || !same(this.scope(plan), read(this.contractFile))) throw Error('Stage plan identity/scope mismatch');
    return plan;
  }

  recordFile(id) { if (!safeId(id)) throw Error('Invalid stage id'); return path.join(this.storage, `${id}.json`); }
  record(id) { const file = this.recordFile(id); return fs.existsSync(file) ? read(file) : null; }
  binding(stage) { return digest({context: this.context, scope: read(this.contractFile), stage, engine: fs.readFileSync(fileURLToPath(import.meta.url), 'utf8')}); }

  async results(stage) {
    const rows = [];
    for (const result of stage.results) {
      const file = path.resolve(this.root, result.path);
      if (!inside(this.directory, file)) throw Error('Result escapes verification');
      const value = read(file);
      for (const assertion of result.assertions) {
        const actual = assertion.key.split('.').reduce((v, k) => v?.[k], value);
        if (!same(actual, assertion.equals)) throw Error(`Stage result assertion failed: ${result.path} ${assertion.key}`);
      }
      rows.push(await identity(file));
    }
    return rows;
  }

  async eligible(id, visiting = new Set()) {
    if (visiting.has(id)) throw Error('Stage dependency cycle');
    visiting.add(id);
    try {
      const stage = this.plan().stages.find(s => s.id === id), record = this.record(id);
      if (!stage || record?.status !== 'completed' || record.jobId !== this.context.jobId || record.role !== 'verifier' || record.binding !== this.binding(stage) || record.exitCode !== 0) return false;
      const inputs = await this.pins(stage.inputs);
      if (!same(inputs, record.before) || !same(inputs, record.after)) return false;
      if (!same(await this.results(stage), record.outputs)) return false;
      if (!same(await identity(record.stdout.path), record.stdout) || !same(await identity(record.stderr.path), record.stderr)) return false;
      for (const dependency of stage.dependsOn) if (!await this.eligible(dependency, visiting) || record.dependencies?.[dependency] !== digest(this.record(dependency))) return false;
      return true;
    } catch { return false; }
    finally { visiting.delete(id); }
  }

  summary() {
    const plan = this.plan(), stages = plan.stages.map(stage => ({id: stage.id, phase: stage.phase, status: this.record(stage.id)?.status ?? 'pending'}));
    const value = {jobId: this.context.jobId, review: this.context.review, taskId: this.context.taskId, updatedAt: stamp(), total: stages.length, completed: stages.filter(s => s.status === 'completed').length, stages, independentReviewIssued: false};
    if (fs.existsSync(this.summaryFile)) {
      const prior = read(this.summaryFile);
      if (same({...prior, updatedAt: null}, {...value, updatedAt: null})) return prior;
    }
    atomicJSON(this.summaryFile, value);
    return value;
  }

  async run(id) {
    if (!safeId(id)) throw Error('Invalid stage id');
    const lock = path.join(this.storage, `${id}.lock`);
    if (fs.existsSync(lock)) {
      const owner = read(lock);
      let alive = true; try { process.kill(owner.pid, 0); } catch (error) { if (error.code === 'ESRCH') alive = false; }
      if (alive) throw Error(`Stage already running: ${id}`);
      const running = this.record(id);
      if (running?.status === 'running' && running.jobId === this.context.jobId && running.pid) {
        let childAlive = true; try { process.kill(running.pid, 0); } catch (error) { if (error.code === 'ESRCH') childAlive = false; }
        if (childAlive) throw Error(`Stage child is still running after dispatcher interruption: ${id}`);
      }
      fs.unlinkSync(lock);
    }
    fs.writeFileSync(lock, JSON.stringify({pid: process.pid, at: stamp()}), {flag: 'wx'});
    try { return await this.execute(id); } finally { fs.unlinkSync(lock); }
  }

  async execute(id) {
    const stage = this.plan().stages.find(s => s.id === id);
    if (!stage) throw Error(`Unknown stage: ${id}`);
    // Dependencies and fingerprints are rechecked even when resuming a completed stage.
    if (await this.eligible(id)) return {reused: true, record: this.record(id)};
    for (const dependency of stage.dependsOn) if (!await this.eligible(dependency)) throw Error(`Dependency not completed/current: ${dependency}`);
    const before = await this.pins(stage.inputs), prior = this.record(id), attempt = (prior?.attempt ?? 0) + 1;
    if (prior) fs.copyFileSync(this.recordFile(id), path.join(this.storage, `${id}.attempt-${prior.attempt}.json`));
    const logPrefix = path.join(this.storage, `${id}.attempt-${attempt}`);
    const record = {jobId: this.context.jobId, role: 'verifier', id, status: 'running', attempt, binding: this.binding(stage), before, startedAt: stamp(), command: stage.command, cwd: this.root,
      dependencies: Object.fromEntries(stage.dependsOn.map(key => [key, digest(this.record(key))]))};
    atomicJSON(this.recordFile(id), record); this.summary();
    const stdout = fs.openSync(`${logPrefix}.stdout.log`, 'wx'), stderr = fs.openSync(`${logPrefix}.stderr.log`, 'wx');
    try {
      const execution = await new Promise((resolve, reject) => {
        const child = spawn(this.resolveInput(stage.command[0]), stage.command.slice(1), {cwd: this.root, windowsHide: true, shell: false, stdio: ['ignore', stdout, stderr]});
        record.pid = child.pid; atomicJSON(this.recordFile(id), record);
        child.once('error', reject); child.once('close', (exitCode, signal) => resolve({exitCode, signal}));
      });
      Object.assign(record, execution);
      if (execution.exitCode !== 0 || execution.signal) throw Error(`Stage execution did not complete successfully: ${id} (${execution.exitCode ?? execution.signal})`);
      record.after = await this.pins(stage.inputs);
      record.outputs = await this.results(stage);
      record.stdout = await identity(`${logPrefix}.stdout.log`); record.stderr = await identity(`${logPrefix}.stderr.log`);
      record.status = 'completed';
    } catch (error) { record.status = 'incomplete'; record.error = error.message; throw error; }
    finally { fs.closeSync(stdout); fs.closeSync(stderr); record.finishedAt = stamp(); atomicJSON(this.recordFile(id), record); this.summary(); }
    return {reused: false, record};
  }

  async runRemaining() {
    const order = {regression: 0, normal: 1, audit: 2, final: 3}, remaining = [...this.plan().stages].sort((a, b) => order[a.phase] - order[b.phase]);
    while (remaining.length) {
      let index = -1;
      for (let i = 0; i < remaining.length; i++) {
        let ready = true;
        for (const dependency of remaining[i].dependsOn) if (!await this.eligible(dependency)) { ready = false; break; }
        if (ready) { index = i; break; }
      }
      if (index < 0) throw Error('No stage can run with current dependencies');
      await this.run(remaining.splice(index, 1)[0].id);
    }
    return this.validateComplete();
  }

  async validateComplete() {
    for (const stage of this.plan().stages) if (!await this.eligible(stage.id)) throw Error(`Incomplete/stale independent stage: ${stage.id}`);
    return this.summary();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [operation, context, argument] = process.argv.slice(2), journal = new VerificationStages(context);
  const result = ['register', 'revise'].includes(operation) ? await journal.register(read(argument), operation === 'revise') : operation === 'run' ? await journal.run(argument) : operation === 'remaining' ? await journal.runRemaining() : operation === 'check' ? await journal.validateComplete() : null;
  if (!result) throw Error('Use register|revise|run|remaining|check <job-context.json> [plan.json|stage-id]');
  console.log(JSON.stringify(result.reused === undefined ? result : {reused: result.reused, id: result.record.id, status: result.record.status}));
}
