import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';

const digest = value => createHash('sha256').update(value).digest('hex');
const clean = value => String(value ?? '').replace(/```/g, '`\u200b`\u200b`');

export function validateWebhook(value) {
  let url;
  try {url = new URL(value);} catch {throw Error('디스코드 웹훅 URL을 설정하세요.');}
  if (url.protocol !== 'https:' || url.hostname !== 'discord.com' || url.port || url.username || url.password || url.search || url.hash ||
      !/^\/api\/(?:v10\/)?webhooks\/\d{16,22}\/[A-Za-z0-9_-]{32,200}$/.test(url.pathname)) {
    throw Error('discord.com의 HTTPS 웹훅 URL만 사용할 수 있습니다.');
  }
  return url.href;
}

export class DiscordRequestError extends Error {
  constructor(status, code, retryAfterMs = 0) {
    super(`Discord HTTP ${status}${Number.isInteger(code) ? ` (code ${code})` : ''}`);
    this.status = status;
    this.code = code;
    this.retryAfterMs = retryAfterMs;
  }
}

export class DiscordProgressReporter {
  constructor({webhookUrl, fetchImpl = fetch, now = Date.now}) {
    this.webhookUrl = validateWebhook(webhookUrl);
    this.fingerprint = digest(this.webhookUrl);
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.blockedUntil = 0;
  }

  async request(suffix, options = {}) {
    if (this.now() < this.blockedUntil) throw new DiscordRequestError(429, null, this.blockedUntil - this.now());
    const response = await this.fetchImpl(this.webhookUrl + suffix, {...options, redirect:'error', signal:AbortSignal.timeout(15000)});
    let data;
    try {data = await response.json();} catch {data = {};}
    const remaining = response.headers.get('x-ratelimit-remaining');
    const resetAfter = Number(response.headers.get('x-ratelimit-reset-after'));
    if (remaining === '0' && Number.isFinite(resetAfter) && resetAfter > 0) this.blockedUntil = this.now() + Math.ceil(resetAfter * 1000) + 250;
    if (!response.ok) {
      const seconds = Math.max(Number(data.retry_after) || 0, Number(response.headers.get('retry-after')) || 0);
      const delay = response.status === 429 ? Math.max(1000, Math.ceil(seconds * 1000) + 250) : 0;
      if (delay) this.blockedUntil = Math.max(this.blockedUntil, this.now() + delay);
      throw new DiscordRequestError(response.status, data.code, delay);
    }
    return data;
  }

  async metadata() {
    const info = await this.request('');
    if (info.type !== 1 || !info.channel_id || !info.guild_id) throw Error('일반 서버 텍스트 채널의 웹훅이 필요합니다.');
    return {guildId:info.guild_id, channelId:info.channel_id};
  }

  async syncProgress(text, state, intervalSeconds = 20) {
    const hash = digest(text);
    if (state.messageId && state.progressHash === hash) return false;
    const safe = clean(text);
    const preview = safe.length > 3700 ? safe.slice(0, 3700) + '\n… 전체 내용은 첨부 파일에서 확인하세요.' : safe;
    const payload = {
      embeds:[{title:'Prompt 15 · 실시간 진행 상황', description:'```text\n'+preview+'\n```', color:0x245cbb,
        timestamp:new Date(this.now()).toISOString(), footer:{text:`약 ${intervalSeconds}초마다 갱신 · progress.txt 전체 내용 첨부`}}],
      allowed_mentions:{parse:[]}, attachments:[],
    };
    const creating = !state.messageId;
    if (creating) payload.flags = 4096;
    const form = new FormData();
    form.set('payload_json', JSON.stringify(payload));
    form.set('files[0]', new Blob([text], {type:'text/plain;charset=utf-8'}), 'progress.txt');
    let message;
    try {message = await this.request(creating ? '?wait=true' : `/messages/${state.messageId}`, {method:creating ? 'POST' : 'PATCH', body:form});}
    catch (error) {
      if (!creating && error instanceof DiscordRequestError && error.status === 404 && error.code === 10008) {
        state.messageId = null;
        state.progressHash = null;
      }
      throw error;
    }
    if (!/^\d{16,22}$/.test(message.id ?? '')) throw Error('메시지 저장 확인 응답이 없습니다.');
    state.messageId = message.id;
    state.progressHash = hash;
    state.lastProgressAt = new Date(this.now()).toISOString();
    return true;
  }

  async sendNotification(notification) {
    const content = (`**${clean(notification.title).slice(0, 250)}**\n${clean(notification.body)}`).slice(0, 1900);
    return this.request('?wait=true', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({content, allowed_mentions:{parse:[]}})});
  }
}

export async function readProgress(file) {
  const fixed = path.resolve(file);
  const stat = await fs.lstat(fixed);
  if (path.basename(fixed) !== 'progress.txt' || !stat.isFile() || stat.isSymbolicLink() || stat.size > 262144 ||
      (await fs.realpath(fixed)).toLowerCase() !== fixed.toLowerCase()) throw Error('유효한 progress.txt 파일이 필요합니다.');
  const data = await fs.readFile(fixed);
  if (data.length > 262144) throw Error('진행 파일 크기 제한을 초과했습니다.');
  return data.toString('utf8');
}

export async function captureNotifications(file, state) {
  state.notificationQueue ??= [];
  state.seen ??= [];
  let stat;
  try {stat = await fs.lstat(file);} catch (error) {if (error.code === 'ENOENT') return; throw error;}
  if (!stat.isFile() || stat.isSymbolicLink() || (await fs.realpath(file)).toLowerCase() !== path.resolve(file).toLowerCase()) throw Error('유효하지 않은 알림 기록입니다.');
  if (stat.size < state.offset) {state.offset = 0; state.pending = '';}
  const count = Math.min(131072, stat.size - state.offset);
  if (count <= 0) return;
  const handle = await fs.open(file, 'r');
  const bytes = Buffer.alloc(count);
  let bytesRead;
  try {({bytesRead} = await handle.read(bytes, 0, count, state.offset));} finally {await handle.close();}
  state.offset += bytesRead;
  const combined = Buffer.concat([Buffer.from(state.pending ?? '', 'base64'), bytes.subarray(0, bytesRead)]);
  const newline = combined.lastIndexOf(10);
  state.pending = (newline < 0 ? combined : combined.subarray(newline + 1)).toString('base64');
  if (newline < 0) return;
  for (const line of combined.subarray(0, newline).toString('utf8').split('\n')) {
    let notification;
    try {notification = JSON.parse(line);} catch {continue;}
    if (typeof notification.id !== 'string' || typeof notification.title !== 'string' || typeof notification.body !== 'string' ||
        notification.id.length > 200 || notification.title.length > 500 || notification.body.length > 4000 ||
        !Number.isFinite(Date.parse(notification.at)) || Date.parse(notification.at) < Date.parse(state.activatedAt) ||
        state.seen.includes(notification.id) || state.notificationQueue.some(item => item.id === notification.id)) continue;
    state.notificationQueue.push({id:notification.id, title:notification.title, body:notification.body});
  }
}
