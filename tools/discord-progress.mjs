// Read-only Prompt 15 observer. Discord delivery never changes orchestration state.
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {DiscordProgressReporter, DiscordRequestError, readProgress, captureNotifications} from './discord-progress-core.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const folder = path.join(root, '.tmp/discord-progress');
const configFile = path.join(folder, 'config.json');
const stateFile = path.join(folder, 'state.json');
const statusFile = path.join(folder, 'status.json');
const lockFile = path.join(folder, 'observer.lock');
const base = path.join(root, 'reports/prompt15/orchestration');
let stopped = false, busy = false, reporter, state, nextAttempt = 0, nextProgress = 0, rejectedFingerprint;

async function readJson(file) {return JSON.parse((await fs.readFile(file, 'utf8')).replace(/^\uFEFF/, ''));}
async function writeJson(file, value) {
  const temp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(temp, JSON.stringify(value, null, 2)+'\n', {mode:0o600});
  await fs.rename(temp, file);
}
async function status(value, details = {}) {
  await writeJson(statusFile, {status:value, pid:process.pid, updatedAt:new Date().toISOString(), ...details});
}
async function save() {if (state) await writeJson(stateFile, state);}
async function runDirectory() {
  const selected = path.resolve((await readJson(path.join(base, 'latest.json'))).directory);
  const relative = path.relative(base, selected);
  if (!relative || path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`) ||
      (await fs.realpath(selected)).toLowerCase() !== selected.toLowerCase()) throw Error('유효하지 않은 Prompt 15 실행 경로입니다.');
  return selected;
}
async function initializeState(directory, fingerprint) {
  const notificationFile = path.join(directory, 'notifications.jsonl');
  let offset = 0;
  try {offset = (await fs.stat(notificationFile)).size;} catch (error) {if (error.code !== 'ENOENT') throw error;}
  return {version:1, directory, webhookFingerprint:fingerprint, messageId:null, progressHash:null,
    activatedAt:new Date().toISOString(), offset, pending:'', notificationQueue:[], seen:[]};
}
function link() {
  return state?.guildId && state?.channelId && state?.messageId ? `https://discord.com/channels/${state.guildId}/${state.channelId}/${state.messageId}` : undefined;
}
async function poll() {
  if (busy || stopped) return;
  busy = true;
  try {
    const config = await readJson(configFile);
    if (!config.webhookUrl) {await status('waiting_for_webhook', {configFile}); return;}
    const candidate = new DiscordProgressReporter({webhookUrl:config.webhookUrl});
    if (rejectedFingerprint === candidate.fingerprint) {await status('webhook_needs_attention'); return;}
    if (!reporter || reporter.fingerprint !== candidate.fingerprint) {
      reporter = candidate;
      nextAttempt = 0; nextProgress = 0;
      try {state = await readJson(stateFile);} catch (error) {if (error.code !== 'ENOENT') throw error; state = null;}
    }
    if (Date.now() < nextAttempt || Date.now() < reporter.blockedUntil) return;
    const directory = await runDirectory();
    if (!state || state.directory !== directory || state.webhookFingerprint !== reporter.fingerprint) {
      // Reuse the existing progress message when following a new run in the same channel.
      const messageId = state?.webhookFingerprint === reporter.fingerprint ? state.messageId : null;
      state = await initializeState(directory, reporter.fingerprint);
      state.messageId = messageId;
      nextProgress = 0;
      await save();
    }
    if (!state.channelId) {Object.assign(state, await reporter.metadata()); await save();}
    const interval = Math.min(300, Math.max(15, Number(config.intervalSeconds) || 20));
    if (Date.now() >= nextProgress) {
      const text = await readProgress(path.join(directory, 'progress.txt'));
      await reporter.syncProgress(text, state, interval);
      nextProgress = Date.now() + interval * 1000;
      await save();
      if (link()) await fs.writeFile(path.join(folder, 'message-link.txt'), link()+'\n');
    }
    if (config.completionNotifications !== false) {
      await captureNotifications(path.join(directory, 'notifications.jsonl'), state);
      await save();
      // A durable queue retains events through network failures and observer restarts.
      for (let sent = 0; state.notificationQueue.length && sent < 3; sent++) {
        const notification = state.notificationQueue[0];
        await reporter.sendNotification(notification);
        state.seen.push(notification.id);
        if (state.seen.length > 2000) state.seen.splice(0, state.seen.length - 2000);
        state.notificationQueue.shift();
        state.lastNotificationAt = new Date().toISOString();
        await save();
      }
    }
    nextAttempt = 0;
    await status('running', {runDirectory:directory, messageUrl:link(), lastProgressAt:state.lastProgressAt,
      lastNotificationAt:state.lastNotificationAt, pendingNotifications:state.notificationQueue.length});
  } catch (error) {
    await save();
    if (error instanceof DiscordRequestError && [401, 403, 404].includes(error.status) && error.code !== 10008) {
      rejectedFingerprint = reporter?.fingerprint;
      await status('webhook_needs_attention', {error:error.message});
    } else {
      nextAttempt = Date.now() + (error instanceof DiscordRequestError && error.retryAfterMs ? error.retryAfterMs : 20000);
      // Never include HTTP URLs, response bodies or transport errors containing credentials in logs.
      await status('retry_wait', {error:error instanceof DiscordRequestError ? error.message : '파일 또는 연결 상태를 확인하고 자동 재시도합니다.', nextAttemptAt:new Date(nextAttempt).toISOString(), messageUrl:link()});
    }
  } finally {busy = false;}
}

async function claimLock() {
  try {await fs.writeFile(lockFile, JSON.stringify({pid:process.pid}), {flag:'wx'});}
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const owner = await readJson(lockFile);
    let alive = true;
    try {process.kill(owner.pid, 0);} catch (probe) {if (probe.code === 'ESRCH') alive = false;}
    if (alive) throw Error('디스코드 진행 관찰 프로그램이 이미 실행 중입니다.');
    await fs.unlink(lockFile);
    await fs.writeFile(lockFile, JSON.stringify({pid:process.pid}), {flag:'wx'});
  }
}
async function releaseLock() {
  try {if ((await readJson(lockFile)).pid === process.pid) await fs.unlink(lockFile);} catch { /* Already released. */ }
}
async function main() {
  await fs.mkdir(folder, {recursive:true});
  try {await fs.access(configFile);} catch {await writeJson(configFile, {webhookUrl:'', intervalSeconds:20, completionNotifications:true});}
  if (process.argv.includes('--preview')) {
    const directory = await runDirectory();
    await fs.writeFile(path.join(folder, 'preview.txt'), await readProgress(path.join(directory, 'progress.txt')));
    await status('preview_ready', {networkRequests:0});
    return;
  }
  await claimLock();
  try {
    await poll();
    if (process.argv.includes('--once')) return;
    const timer = setInterval(() => {poll().catch(() => {busy = false;});}, 2000);
    const stop = async () => {stopped = true; clearInterval(timer); while (busy) await new Promise(resolve => setTimeout(resolve, 100)); await status('stopped', {messageUrl:link()}); await releaseLock();};
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    console.log('Discord progress observer is running. Local status: .tmp/discord-progress/status.json');
  } finally {if (process.argv.includes('--once')) await releaseLock();}
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(async () => {await releaseLock(); console.error('디스코드 관찰 프로그램을 시작하지 못했습니다. 로컬 설정과 실행 상태를 확인하세요.'); process.exitCode = 1;});
}
