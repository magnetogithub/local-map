import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {VerificationStages, identity} from './verification-stages.mjs';
import {inside, atomicJSON} from './protocol.mjs';
import {runBoundedCommand} from './bounded-output.mjs';
import {validateProductTarget} from './product-target.mjs';

const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const same = (a, b) => digest(a) === digest(b);
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const pinOnly = ({path: file, sha256, byteLength}) => ({path: file, sha256, byteLength});
const engineFiles = ['verification-stages-compact.mjs', 'verification-stages.mjs', 'bounded-output.mjs', 'protocol.mjs'];

// A separate engine preserves in-flight v9 evidence and its engine binding.
// The old engine remains available only for already registered legacy jobs.
export class CompactVerificationStages extends VerificationStages {
  scope(plan) { return {...super.scope(plan), version: 2}; }

  plan() {
    const plan = read(this.planFile);
    if (plan.version !== 2 || plan.jobId !== this.context.jobId || plan.role !== 'verifier' || !same(plan.requiredGates, this.context.requiredGates) || !plan.stages?.length || !same(this.scope(plan), read(this.contractFile))) throw Error('Stage plan identity/scope mismatch');
    return plan;
  }

  async inputRows(stage, plan) {
    const rows = [...(stage.inputs ?? [])], manifests = [];
    if (this.context.productTarget) {
      const target=this.context.productTarget;
      if (this.context.productRoot !== target.productRoot) throw Error('Target binding: stage context/root mismatch');
      const product=validateProductTarget(this.root,target,{checkSource:false,checkExtra:false});
      rows.push(target.manifest);
      for (const [relative,sha256] of Object.entries(product.source)) {
        const file=path.join(target.productRoot,relative);
        rows.push({path:file,sha256,byteLength:fs.statSync(file).size});
      }
    }
    for (const key of stage.inputSets ?? []) {
      const expected = plan.inputSets?.[key]; if (!expected) throw Error(`Unknown shared input set: ${key}`);
      const pin = await identity(this.resolveInput(expected.path));
      if (pin.sha256 !== expected.sha256 || pin.byteLength !== expected.byteLength) throw Error(`Stage input changed: ${expected.path}`);
      const manifest = read(pin.path);
      if (manifest.version !== 1 || !Array.isArray(manifest.inputs) || !manifest.inputs.length) throw Error('Invalid shared input manifest');
      rows.push(...manifest.inputs); manifests.push(pin);
    }
    const unique = new Map();
    for (const row of rows) {
      const file = this.resolveInput(row.path), key = file.toLowerCase(), pin = {...row, path: file};
      const relative=path.relative(this.root,file).replaceAll('\\','/');
      if (this.context.productTarget && !inside(this.context.productRoot,file) && /^(src\/|e2e\/|validation\/|scripts\/|package(?:-lock)?\.json$|tsconfig.*\.json$|.*config\.[cm]?[jt]s$)/.test(relative) && !relative.startsWith('scripts/prompt15-orchestrator/')) throw Error(`Target binding: stage selected repository product input ${relative}`);
      if (unique.has(key) && !same(unique.get(key), pin)) throw Error(`Conflicting stage input pins: ${file}`);
      unique.set(key, pin);
    }
    if (!unique.size) throw Error('Stage needs explicit pre-execution input identities');
    return {rows: [...unique.values()].sort((a, b) => a.path.localeCompare(b.path)), manifests};
  }

  async fingerprint(stage, plan) {
    const {rows, manifests} = await this.inputRows(stage, plan), hash = createHash('sha256');
    for (const row of rows) {
      const pin = await identity(row.path);
      if (pin.sha256 !== row.sha256 || pin.byteLength !== row.byteLength) throw Error(`Stage input changed: ${row.path}`);
      hash.update(JSON.stringify(pin) + '\n');
    }
    return {sha256: hash.digest('hex'), count: rows.length, manifests};
  }

  binding(stage, plan = this.plan()) {
    return digest({context: this.context, scope: read(this.contractFile), stage,
      inputSets: Object.fromEntries((stage.inputSets ?? []).map(key => [key, plan.inputSets[key]])),
      engines: [...engineFiles,...(this.context.productTarget ? ['product-target.mjs'] : [])].map(file => fs.readFileSync(new URL(file, import.meta.url), 'utf8'))});
  }

  async register(plan, revise = false) {
    if (plan.version !== 2 || plan.jobId !== this.context.jobId || plan.role !== 'verifier' || !same(plan.requiredGates, this.context.requiredGates)) throw Error('Stage plan must preserve the independent job and every required gate');
    if (!Array.isArray(plan.stages) || !plan.stages.length || Buffer.byteLength(JSON.stringify(plan)) > 1024 * 1024) throw Error('Use a compact stage plan <=1 MiB with shared input manifests');
    const ids = new Set(), covered = new Set();
    for (const stage of plan.stages) {
      if (typeof stage.id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/.test(stage.id) || ids.has(stage.id)) throw Error('Invalid/duplicate stage id');
      ids.add(stage.id);
      if (!['regression', 'normal', 'audit', 'final'].includes(stage.phase) || !Array.isArray(stage.dependsOn) || !Array.isArray(stage.gates) || stage.gates.some(gate => !this.context.requiredGates.includes(gate))) throw Error('Invalid stage scope/dependencies');
      stage.gates.forEach(gate => covered.add(gate));
      if (!Array.isArray(stage.command) || stage.command.length < 2 || stage.command.some(arg => typeof arg !== 'string')) throw Error('Use a direct executable/argv command');
      if (!Array.isArray(stage.inputs ?? []) || !Array.isArray(stage.inputSets ?? [])) throw Error('Invalid stage input references');
      const {rows} = await this.inputRows(stage, plan);
      if (![stage.command[0], stage.command[1]].every(file => rows.some(row => row.path.toLowerCase() === this.resolveInput(file).toLowerCase()))) throw Error('Pin executable and stage entry point');
      await this.fingerprint(stage, plan);
      if (!Array.isArray(stage.results) || !stage.results.length) throw Error('Stage needs actual result artifacts and assertions');
      for (const result of stage.results) {
        if (!inside(this.directory, path.resolve(this.root, result.path)) || !Array.isArray(result.assertions) || !result.assertions.length) throw Error('Stage needs attested results inside this verification');
        for (const assertion of result.assertions) if (typeof assertion.key !== 'string' || !Object.hasOwn(assertion, 'equals')) throw Error('Invalid result assertion');
      }
    }
    if (this.context.requiredGates.some(gate => !covered.has(gate))) throw Error('Stage plan omits a required gate');
    const visiting = new Set(), visited = new Set();
    const visit = id => {
      if (visiting.has(id)) throw Error('Stage dependency cycle'); if (visited.has(id)) return;
      const stage = plan.stages.find(stage => stage.id === id); if (!stage) throw Error('Unknown stage dependency');
      visiting.add(id); stage.dependsOn.forEach(visit); visiting.delete(id); visited.add(id);
    };
    ids.forEach(visit);
    if (fs.existsSync(this.planFile)) {
      const previous = read(this.planFile);
      if (!same(previous, plan)) {
        if (!revise || !same(read(this.contractFile), this.scope(plan))) throw Error('Stage scope is immutable; revise only execution helpers/input identities');
        const archive = path.join(this.storage, `plan-${digest(previous)}.json`);
        if (!fs.existsSync(archive)) fs.copyFileSync(this.planFile, archive);
        atomicJSON(this.planFile, plan);
      }
    } else { fs.writeFileSync(this.planFile, JSON.stringify(plan), {flag: 'wx'}); fs.writeFileSync(this.contractFile, JSON.stringify(this.scope(plan)), {flag: 'wx'}); }
    return this.summary();
  }

  async eligible(id, visiting = new Set()) {
    if (visiting.has(id)) throw Error('Stage dependency cycle'); visiting.add(id);
    try {
      const plan = this.plan(), stage = plan.stages.find(stage => stage.id === id), record = this.record(id);
      if (!stage || record?.status !== 'completed' || record.jobId !== this.context.jobId || record.role !== 'verifier' || record.binding !== this.binding(stage, plan) || record.exitCode !== 0 || record.signal) return false;
      const current = await this.fingerprint(stage, plan);
      if (!same(current, record.before) || !same(current, record.after) || !same(await this.results(stage), record.outputs)) return false;
      for (const stream of [record.stdout, record.stderr]) if (!stream || !same(await identity(stream.path), pinOnly(stream))) return false;
      for (const dependency of stage.dependsOn) if (!await this.eligible(dependency, visiting) || record.dependencies?.[dependency] !== digest(this.record(dependency))) return false;
      return true;
    } catch { return false; } finally { visiting.delete(id); }
  }

  async execute(id) {
    const plan = this.plan(), stage = plan.stages.find(stage => stage.id === id);
    if (!stage) throw Error(`Unknown stage: ${id}`);
    if (await this.eligible(id)) return {reused: true, record: this.record(id)};
    for (const dependency of stage.dependsOn) if (!await this.eligible(dependency)) throw Error(`Dependency not completed/current: ${dependency}`);
    const before = await this.fingerprint(stage, plan), prior = this.record(id), attempt = (prior?.attempt ?? 0) + 1;
    if (prior) fs.copyFileSync(this.recordFile(id), path.join(this.storage, `${id}.attempt-${prior.attempt}.json`));
    const record = {jobId: this.context.jobId, role: 'verifier', id, status: 'running', attempt, binding: this.binding(stage, plan), before,
      command: stage.command, cwd: this.context.productRoot ?? this.root, startedAt: new Date().toISOString(), dependencies: Object.fromEntries(stage.dependsOn.map(key => [key, digest(this.record(key))]))};
    atomicJSON(this.recordFile(id), record); this.summary();
    try {
      const execution = await runBoundedCommand({command: [this.resolveInput(stage.command[0]), ...stage.command.slice(1)], cwd: record.cwd,
        logPrefix: path.join(this.storage, `${id}.attempt-${attempt}`),
        onStart: pid => { record.pid = pid; atomicJSON(this.recordFile(id), record); }});
      Object.assign(record, execution);
      if (record.exitCode !== 0 || record.signal) throw Error(`Stage execution did not complete successfully: ${id} (${record.exitCode ?? record.signal})`);
      record.after = await this.fingerprint(stage, plan); record.outputs = await this.results(stage); record.status = 'completed';
    } catch (error) { record.status = 'incomplete'; record.error = error.message; throw error; }
    finally { record.finishedAt = new Date().toISOString(); atomicJSON(this.recordFile(id), record); this.summary(); }
    return {reused: false, record};
  }
}

export function createVerificationStages(contextFile) {
  const context = read(contextFile), planFile = path.resolve(context.root, context.reportDirectory, 'stages/plan.json');
  // Never convert an already executed v9 plan in place.
  return fs.existsSync(planFile) && read(planFile).version !== 2 ? new VerificationStages(contextFile) : new CompactVerificationStages(contextFile);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [operation, context, argument] = process.argv.slice(2), journal = createVerificationStages(context);
  const result = ['register', 'revise'].includes(operation) ? await journal.register(read(argument), operation === 'revise') : operation === 'run' ? await journal.run(argument) : operation === 'remaining' ? await journal.runRemaining() : operation === 'check' ? await journal.validateComplete() : null;
  if (!result) throw Error('Use register|revise|run|remaining|check <job-context.json> [plan.json|stage-id]');
  console.log(JSON.stringify(result.reused === undefined ? result : {reused: result.reused, id: result.record.id, status: result.record.status}));
}
