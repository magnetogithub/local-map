// Local event observer: no model requests, no dispatches, no changes to workflow state.
import fs from 'node:fs';
import path from 'node:path';
import {spawn, spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {consumeEvent} from './prompt15-notification-core.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const base = path.join(root, 'reports/prompt15/orchestration');
const args = process.argv.slice(2);
const activationAt = new Date().toISOString();
const koreanTime = new Intl.DateTimeFormat('ko-KR', {timeZone: 'Asia/Seoul', dateStyle: 'short', timeStyle: 'medium', hourCycle: 'h23'});
let busy = false;
let previousDirectory = null;
let checkpoint = null;
let stopped = false;

function ensureNotificationHelper() {
  if (process.platform !== 'win32') throw Error('Windows task notifications require Windows.');
  const source = path.join(root, 'tools/prompt15-notify.cs');
  const executable = path.join(root, '.tmp/prompt15-notify.exe');
  if (fs.existsSync(executable) && fs.statSync(executable).mtimeMs >= fs.statSync(source).mtimeMs) return;
  fs.mkdirSync(path.dirname(executable), {recursive: true});
  const compiler = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'Microsoft.NET/Framework64/v4.0.30319/csc.exe');
  const result = spawnSync(compiler, ['/nologo', '/target:exe', `/out:${executable}`, '/reference:System.Windows.Forms.dll', '/reference:System.Drawing.dll', '/reference:System.Web.Extensions.dll', source], {cwd: root, windowsHide: true, encoding: 'utf8', timeout: 30000});
  if (result.status !== 0) throw Error(result.error?.message ?? result.stderr ?? result.stdout ?? 'Notification helper compilation failed');
}

function atomic(file, value) {
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n');
  fs.renameSync(temporary, file);
}
function directory() {
  const runIndex = args.indexOf('--run');
  const selected = runIndex >= 0 ? path.resolve(root, args[runIndex + 1]) : JSON.parse(fs.readFileSync(path.join(base, 'latest.json'), 'utf8')).directory;
  const relative = path.relative(base, selected);
  if (path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`)) throw Error('Notification run must be inside the project orchestration folder');
  return selected;
}
async function sendToast(run, notification) {
  const folder = path.join(run, 'notification-payloads');
  fs.mkdirSync(folder, {recursive: true});
  const tag = createHash('sha256').update(notification.id).digest('hex').slice(0, 16);
  const payload = path.join(folder, `${tag}.json`);
  atomic(payload, {...notification, tag});
  return new Promise(resolve => {
    const child = spawn(path.join(root, '.tmp/prompt15-notify.exe'), [payload], {cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']});
    let output = '', errorOutput = '';
    const timeout = setTimeout(() => child.kill(), 30000);
    child.stdout.on('data', value => { output += value; });
    child.stderr.on('data', value => { errorOutput += value; });
    child.once('error', error => { clearTimeout(timeout); resolve({sent: false, error: error.message}); });
    child.once('close', code => {
      clearTimeout(timeout);
      try { resolve({...JSON.parse(output.trim()), exitCode: code}); }
      catch { resolve({sent: false, error: errorOutput.trim() || `Notification helper exited ${code}`, exitCode: code}); }
    });
  });
}

function readEvents(run) {
  const file = path.join(run, 'events.jsonl');
  if (!fs.existsSync(file)) return [];
  const size = fs.statSync(file).size;
  if (size < checkpoint.offset) { checkpoint.offset = 0; checkpoint.pending = ''; }
  const count = Math.min(size - checkpoint.offset, 1024 * 1024);
  const buffer = Buffer.alloc(count);
  const fd = fs.openSync(file, 'r');
  let actual;
  try { actual = fs.readSync(fd, buffer, 0, count, checkpoint.offset); }
  finally { fs.closeSync(fd); }
  checkpoint.offset += actual;
  const combined = Buffer.concat([Buffer.from(checkpoint.pending ?? '', 'base64'), buffer.subarray(0, actual)]);
  const newline = combined.lastIndexOf(10);
  if (newline < 0) { checkpoint.pending = combined.toString('base64'); return []; }
  checkpoint.pending = combined.subarray(newline + 1).toString('base64');
  return combined.subarray(0, newline).toString('utf8').split('\n').flatMap(line => {
    try { return [JSON.parse(line)]; } catch { return []; }
  });
}

function attach(run) {
  if (run === previousDirectory) return;
  const file = path.join(run, 'notification-state.json');
  if (fs.existsSync(file)) {
    checkpoint = JSON.parse(fs.readFileSync(file, 'utf8'));
    try { process.kill(checkpoint.pid, 0); if (checkpoint.pid !== process.pid && checkpoint.status === 'watching') throw Error('A notification observer is already running'); }
    catch (error) { if (error.message === 'A notification observer is already running') throw error; }
  } else checkpoint = {offset: 0, pending: '', seen: [], tasks: {}, finalMessages: {}, activatedAt: activationAt};
  checkpoint.pid = process.pid;
  checkpoint.status = 'watching';
  checkpoint.updatedAt = new Date().toISOString();
  previousDirectory = run;
  atomic(file, checkpoint);
}

async function deliver(run, notification) {
  const recordedAt = new Date().toISOString();
  fs.appendFileSync(path.join(run, 'notifications.txt'), `[${koreanTime.format(new Date(recordedAt))}] ${notification.title}\n${notification.body}\n\n`, 'utf8');
  const delivery = await sendToast(run, notification);
  fs.appendFileSync(path.join(run, 'notifications.jsonl'), JSON.stringify({...notification, recordedAt, delivery}) + '\n');
  checkpoint.latestNotificationAt = recordedAt;
  checkpoint.latestDelivery = delivery;
  if (!delivery.sent) console.error(delivery.error);
  return delivery;
}

async function poll() {
  if (busy || stopped) return;
  busy = true;
  try {
    const run = directory();
    attach(run);
    let modelChange = null;
    try { modelChange = JSON.parse(fs.readFileSync(path.join(run, 'model-change.json'), 'utf8')); } catch { /* Ordinary runs have no model transition. */ }
    try {
      const runtimeUpdate = JSON.parse(fs.readFileSync(path.join(run, 'runtime-update.json'), 'utf8'));
      if (!modelChange || runtimeUpdate.requestedAt > modelChange.requestedAt) modelChange = runtimeUpdate;
    } catch { /* No runtime update is pending. */ }
    for (const event of readEvents(run)) {
      if (modelChange?.type === 'runtime_update' && event.kind === 'workflow_stopped') {
        const verification = modelChange.responses?.find(response => response.role === 'verifier');
        try { modelChange.operatorVerificationChanges = JSON.parse(fs.readFileSync(path.join(path.dirname(verification.path), 'verification-source-changes.json'), 'utf8')).changes; }
        catch { delete modelChange.operatorVerificationChanges; }
      }
      const notification = consumeEvent(event, checkpoint, modelChange);
      if (notification && event.at >= checkpoint.activatedAt) await deliver(run, notification);
    }
    checkpoint.updatedAt = new Date().toISOString();
    atomic(path.join(run, 'notification-state.json'), checkpoint);
  } catch (error) { console.error(error.message); }
  finally { busy = false; }
}

async function main() {
  ensureNotificationHelper();
  if (args.includes('--test')) {
    const run = directory();
    // A setup message is independent of task outcomes and does not advance the workflow.
    checkpoint = {};
    const result = await deliver(run, {id: `setup:${Date.now()}`, at: activationAt, title: 'Prompt 15 · 작업 완료 알림 연결', body: '앞으로 총괄·구현·검증 작업이 끝날 때마다 결과를 알려드립니다.', role: '설정', review: null, outcome: '알림 테스트'});
    console.log(JSON.stringify(result));
    if (!result.sent) process.exitCode = 1;
    return;
  }
  await poll();
  const timer = setInterval(poll, 2000);
  process.once('SIGINT', () => {
    stopped = true;
    clearInterval(timer);
    if (checkpoint && previousDirectory) { checkpoint.status = 'stopped'; atomic(path.join(previousDirectory, 'notification-state.json'), checkpoint); }
  });
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
