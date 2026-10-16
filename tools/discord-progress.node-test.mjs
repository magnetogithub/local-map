import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {DiscordProgressReporter, DiscordRequestError, validateWebhook, captureNotifications, readProgress} from './discord-progress-core.mjs';

const webhook = 'https://discord.com/api/webhooks/123456789012345678/' + 'x'.repeat(64);
const messageId = '234567890123456789';
const json = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), {status, headers:{'Content-Type':'application/json', ...headers}});

test('only the intended Discord HTTPS webhook destination is accepted', () => {
  assert.equal(validateWebhook(webhook), webhook);
  assert.equal(validateWebhook(webhook.replace('/api/', '/api/v10/')).includes('/v10/'), true);
  for (const invalid of ['http://discord.com/api/webhooks/123/token', webhook+'?redirect=evil', webhook+'#secret', webhook.replace('discord.com','discord.com.evil.test'), webhook.replace('discord.com', 'discord.com@evil.test'), webhook.replace('discord.com', 'discord.com:8766'), 'not a URL']) {
    assert.throws(() => validateWebhook(invalid));
  }
});

test('one live message is created, edited with replaced attachment, and reused after restart', async () => {
  const requests = [];
  const reporter = new DiscordProgressReporter({webhookUrl:webhook, fetchImpl:async (url, options) => {
    const payload = JSON.parse(options.body.get('payload_json'));
    requests.push({url, options, payload, file:await options.body.get('files[0]').text()});
    return json({id:messageId});
  }});
  const state = {};
  const initial = 'REVIEW B 진행 중\n@everyone ```\n' + '새 내용'.repeat(3000);
  assert.equal(await reporter.syncProgress(initial, state), true);
  assert.equal(requests[0].options.method, 'POST');
  assert.equal(requests[0].options.redirect, 'error');
  assert.equal(requests[0].file, initial);
  assert.deepEqual(requests[0].payload.allowed_mentions, {parse:[]});
  assert.ok(requests[0].payload.embeds[0].description.length < 4096);
  assert.ok(requests[0].payload.embeds[0].description.includes('전체 내용은 첨부'));
  assert.equal(requests[0].payload.flags, 4096);
  assert.equal(await reporter.syncProgress(initial, state), false);
  assert.equal(requests.length, 1);
  const restored = JSON.parse(JSON.stringify(state));
  assert.equal(await reporter.syncProgress('새 진행 상황', restored), true);
  assert.equal(requests[1].options.method, 'PATCH');
  assert.ok(requests[1].url.endsWith('/messages/'+messageId));
  assert.deepEqual(requests[1].payload.attachments, []);
  assert.equal(requests[1].payload.flags, undefined);
  assert.equal(requests[1].file, '새 진행 상황');
  assert.equal(restored.messageId, messageId);
});

test('task notification preserves FAIL and disables unintended mentions', async () => {
  let request;
  const reporter = new DiscordProgressReporter({webhookUrl:webhook, fetchImpl:async (url, options) => {request={url, options, payload:JSON.parse(options.body)}; return json({id:messageId});}});
  await reporter.sendNotification({title:'검증 프롬프트 수행 FAIL', body:'태스크 판정 (전체 REVIEW 판정과 별도) · @everyone'});
  assert.match(request.payload.content, /FAIL/);
  assert.match(request.payload.content, /전체 REVIEW 판정과 별도/);
  assert.deepEqual(request.payload.allowed_mentions, {parse:[]});
  assert.equal(request.options.method, 'POST');
  assert.ok(request.url.endsWith('?wait=true'));
});

test('rate-limit retry time prevents another network request until the server deadline', async () => {
  let now = 100000, calls = 0;
  const reporter = new DiscordProgressReporter({webhookUrl:webhook, now:() => now, fetchImpl:async () => {calls++; return json({retry_after:4.5},429,{'Retry-After':'4.5'});}});
  await assert.rejects(reporter.sendNotification({title:'test',body:''}), error => error instanceof DiscordRequestError && error.retryAfterMs >= 4500);
  assert.equal(calls, 1);
  await assert.rejects(reporter.sendNotification({title:'test',body:''}), /HTTP 429/);
  assert.equal(calls, 1);
  now += 5000;
  await assert.rejects(reporter.sendNotification({title:'test',body:''}), /HTTP 429/);
  assert.equal(calls, 2);
});

test('successful exhausted-bucket response also delays subsequent requests', async () => {
  let calls = 0;
  const reporter = new DiscordProgressReporter({webhookUrl:webhook, now:() => 100000, fetchImpl:async () => {calls++; return json({id:messageId},200,{'X-RateLimit-Remaining':'0','X-RateLimit-Reset-After':'2'});}});
  await reporter.sendNotification({title:'one',body:''});
  await assert.rejects(reporter.sendNotification({title:'two',body:''}), /HTTP 429/);
  assert.equal(calls, 1);
});

test('a deleted live message is recreated; an invalid webhook is not mistaken for a missing message', async () => {
  const state = {messageId};
  const reporter = new DiscordProgressReporter({webhookUrl:webhook, fetchImpl:async () => json({code:10008},404)});
  await assert.rejects(reporter.syncProgress('updated',state), /HTTP 404/);
  assert.equal(state.messageId, null);
  const invalid = new DiscordProgressReporter({webhookUrl:webhook, fetchImpl:async () => json({code:10015,message:webhook},404)});
  await assert.rejects(invalid.syncProgress('updated',{}), error => !error.message.includes('xxxx') && error.code === 10015);
});

test('queued completion events survive partial UTF-8 writes and deduplicate through restart', async t => {
  const base = path.resolve('.tmp/discord-progress-tests');
  await fs.mkdir(base,{recursive:true});
  const directory = await fs.mkdtemp(path.join(base,'case-'));
  t.after(async () => {assert.ok(directory.startsWith(base+path.sep)); await fs.rm(directory,{recursive:true,force:true});});
  const file = path.join(directory,'notifications.jsonl');
  const old = {id:'old', at:'2026-10-13T00:00:00Z', title:'지난 작업', body:'이전'};
  const fresh = {id:'fresh', at:'2026-10-13T01:00:01Z', title:'검증 PASS', body:'태스크 판정'};
  const bytes = Buffer.from(JSON.stringify(old)+'\n'+JSON.stringify(fresh)+'\n');
  await fs.writeFile(file,bytes.subarray(0,bytes.length-5));
  let state = {activatedAt:'2026-10-13T01:00:00Z',offset:0};
  await captureNotifications(file,state);
  assert.equal(state.notificationQueue.length,0);
  state = JSON.parse(JSON.stringify(state));
  await fs.appendFile(file,bytes.subarray(bytes.length-5));
  await captureNotifications(file,state);
  assert.deepEqual(state.notificationQueue,[{id:fresh.id,title:fresh.title,body:fresh.body}]);
  await fs.appendFile(file,JSON.stringify(fresh)+'\n');
  await captureNotifications(file,state);
  assert.equal(state.notificationQueue.length,1);
  state.notificationQueue=[]; state.seen=[fresh.id];
  await fs.appendFile(file,JSON.stringify(fresh)+'\n');
  await captureNotifications(file,state);
  assert.equal(state.notificationQueue.length,0);
  const progress = path.join(directory,'progress.txt');
  await fs.writeFile(progress,'현재 상태');
  assert.equal(await readProgress(progress),'현재 상태');
  await assert.rejects(readProgress(file), /유효한 progress/);
});
