import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {Prompt15Orchestrator} from './orchestrator.mjs';
import {atomicJson, readJson, resolveInside} from './protocol.mjs';
import {acknowledgeOperatingFailure} from './state-machine.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const config = readJson(path.join(root, 'automation/prompt15/config.json'));
const plan = readJson(path.join(root, 'automation/prompt15/task-plan.json'));
const args = process.argv.slice(2);
const command = args.shift() ?? 'status';
const value = name => { const index = args.indexOf(name); return index < 0 ? null : args[index + 1]; };
const base = path.join(root, 'reports/prompt15/orchestrator-v2');

function runDirectory() {
  const supplied = value('--run');
  if (supplied) return resolveInside(base, path.resolve(root, supplied), 'run');
  const latest = path.join(base, 'latest.json');
  if (!fs.existsSync(latest)) throw Error('No v2 run exists');
  return resolveInside(base, readJson(latest).directory, 'run');
}

async function main() {
  if (command === 'start') {
    const taskId = value('--task') ?? config.startTask;
    const seed = value('--seed');
    if (!seed) throw Error('start requires --seed <preserved candidate or clean source>');
    const runtime = Prompt15Orchestrator.create({root, taskId, seed, config, plan});
    console.log(JSON.stringify({runId: runtime.state.runId, directory: runtime.directory, taskId, workspace: runtime.state.workspace}, null, 2));
    const state = await runtime.run();
    console.log(JSON.stringify({status: state.status, phase: state.phase, taskId: state.taskId, productAttempt: state.productAttempt}, null, 2));
    process.exitCode = state.status === 'passed' ? 0 : 1;
    return;
  }
  const directory = runDirectory();
  if (command === 'status') {
    const state = readJson(path.join(directory, 'state.json'));
    console.log(JSON.stringify({directory, status: state.status, phase: state.phase, taskId: state.taskId, productAttempt: state.productAttempt, requiredInput: state.requiredInput, activeTurn: state.activeTurn, updatedAt: state.updatedAt}, null, 2));
    return;
  }
  if (command === 'stop') {
    atomicJson(path.join(directory, 'stop.json'), {requestedAt: new Date().toISOString(), reason: 'Explicit user stop'});
    console.log('Stop requested for this v2 run.');
    return;
  }
  if (command === 'resume') {
    let state = readJson(path.join(directory, 'state.json'));
    if (state.status === 'operating_failure' && !args.includes('--ack-operating')) throw Error('Operating failure requires explicit --ack-operating after the cause is fixed');
    if (state.status === 'operating_failure') {
      state = acknowledgeOperatingFailure(state);
      atomicJson(path.join(directory, 'state.json'), state);
    }
    const runtime = new Prompt15Orchestrator({root, directory, config, plan});
    const result = await runtime.run({ackInput: args.includes('--ack-input')});
    console.log(JSON.stringify({status: result.status, phase: result.phase, taskId: result.taskId, productAttempt: result.productAttempt, requiredInput: result.requiredInput}, null, 2));
    process.exitCode = result.status === 'passed' ? 0 : 1;
    return;
  }
  throw Error('Use start, resume, status, or stop');
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
