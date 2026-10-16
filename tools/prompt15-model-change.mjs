// Apply model configuration at a durable task boundary without discarding that task's report.
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const base = path.join(root, 'reports/prompt15/orchestration');
const run = JSON.parse(fs.readFileSync(path.join(base, 'latest.json'), 'utf8')).directory;
const relative = path.relative(base, run);
if (path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`)) throw Error('Run is outside orchestration');
const read = name => JSON.parse(fs.readFileSync(path.join(run, name), 'utf8'));
const initial = read('state.json');
const log = fs.readFileSync(path.join(run, 'events.jsonl'), 'utf8').split('\n').flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
const dispatched = log.filter(event => event.kind === 'dispatch').at(-1);
const responseDirectory = dispatched?.role === 'verifier' ? path.dirname(dispatched.reportDirectory) : dispatched?.reportDirectory;
const response = dispatched ? path.resolve(root, responseDirectory, `${dispatched.key}-response.json`) : null;
if (response) {
  const responseRelative = path.relative(path.join(run, 'rounds'), response);
  if (path.isAbsolute(responseRelative) || responseRelative === '..' || responseRelative.startsWith(`..${path.sep}`)) throw Error('Task response path escapes this run');
}
const codexIndex = process.argv.indexOf('--codex');
const codex = codexIndex >= 0 ? process.argv[codexIndex + 1] : null;
const marker = path.join(run, 'model-change.json');
const change = {requestedAt: new Date().toISOString(), model: 'gpt-6.1-sol', effort: 'high', status: 'waiting_for_task_report', previousControllerPid: initial.controllerPid, watcherPid: process.pid, responsePath: response};
let stopped = false;
let restarting = false;
let watcher;

function save() {
  change.updatedAt = new Date().toISOString();
  const temporary = `${marker}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(change, null, 2) + '\n');
  fs.renameSync(temporary, marker);
}
function alive(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }

async function check() {
  if (restarting) return;
  try {
    const state = read('state.json');
    if (state.status === 'standby') { change.status = 'configured_for_future_runs'; save(); finish(); return; }
    if (!stopped) {
      if (state.status === 'running' && (!response || !fs.existsSync(response))) return;
      if (state.status === 'running') {
        change.stopRequestedAt = new Date().toISOString();
        change.status = 'pausing_at_task_boundary';
        save();
        fs.writeFileSync(path.join(run, 'stop.json'), JSON.stringify({requestedAt: change.stopRequestedAt, reason: 'Apply explicit gpt-6.1-sol/high settings after completed task report'}) + '\n');
      }
      stopped = true;
      save();
    }
    if (alive(initial.controllerPid)) return;
    if (state.requiredUserInput) {
      change.status = 'configured_waiting_for_required_user_input'; save(); finish(); return;
    }
    restarting = true;
    const stdout = fs.openSync(path.join(root, `.tmp/prompt15-high-resume-${process.pid}.stdout.log`), 'a');
    const stderr = fs.openSync(path.join(root, `.tmp/prompt15-high-resume-${process.pid}.stderr.log`), 'a');
    const child = spawn(process.execPath, ['scripts/prompt15-orchestrator/run.mjs', 'resume', '--run', run, ...(codex ? ['--codex', codex] : [])], {cwd: root, detached: true, windowsHide: true, stdio: ['ignore', stdout, stderr]});
    fs.closeSync(stdout); fs.closeSync(stderr);
    child.once('error', error => { change.status = 'restart_failed'; change.error = error.message; save(); });
    child.unref();
    change.resumedControllerPid = child.pid;
    change.resumedAt = new Date().toISOString();
    change.status = 'resuming_with_high';
    save();
    finish();
  } catch (error) { change.error = error.message; save(); console.error(error.message); }
}
const timer = setInterval(check, 500);
function finish() { clearInterval(timer); watcher?.close(); }
save();
if (response && fs.existsSync(path.dirname(response))) watcher = fs.watch(path.dirname(response), () => { check(); });
await check();
