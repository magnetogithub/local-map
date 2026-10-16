import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {collectSessionActivity,sessionStatusLines,withSessionStatus,readEventTail,SESSION_BLOCK_START,EVENT_READ_LIMIT} from './prompt15-session-progress-core.mjs';

const state=()=>({implementationUnit:'task',status:'running',phase:'implement',threads:{supervisor:'s','implementer-0':'i','implementer-1':'i2','verifier-0':'v'},guardian:{threadId:'g'},activeTurns:{'implementer-0':{taskId:'15-01',runningCommands:{a:{}}}}});
const message=(threadId,text,at='2026-10-15T03:00:00.000Z')=>({kind:'agent_message',phase:'commentary',threadId,text,at});

test('every session retains its own latest message and displays concurrent activity separately',()=>{
  const s=state();s.activeTurns['implementer-1']={taskId:'15-02',runningCommands:{}};
  const rows=collectSessionActivity(s,[message('s','배정 확정'),message('i','입력 확인'),message('i2','다른 분기 작업'),message('v','이전 판정'),message('g','운영 점검 완료')]);
  const text=sessionStatusLines(s,rows).join('\n');
  assert.match(text,/총괄: 대기/);assert.match(text,/구현 1: 도구 실행 중 · 15-01/);assert.match(text,/구현 2: 작업 중 · 15-02/);
  for(const value of ['배정 확정','입력 확인','다른 분기 작업','이전 판정','운영 점검 완료','12:00:00 KST'])assert.ok(text.includes(value));
  const later=collectSessionActivity(s,[message('i','진행 갱신','2026-10-15T03:01:00.000Z')],rows);assert.equal(later.supervisor.message,'배정 확정');assert.equal(later['implementer-0'].message,'진행 갱신');
});
test('guardian execution is separate and heartbeat cannot make held sessions appear active',()=>{
  const s=state();s.guardian.activeAuditId='audit';
  assert.match(sessionStatusLines(s,collectSessionActivity(s,[])).join('\n'),/▶ 운영 감시: 운영 점검 중/);
  s.status='waiting_execution';s.heartbeatAt=new Date().toISOString();const text=sessionStatusLines(s,collectSessionActivity(s,[])).join('\n');assert.doesNotMatch(text,/▶/);assert.match(text,/대기 · 운영 정지/);
});
test('authorized repair worker has separate activity and host checks without pretending the audit thread is running',()=>{
  const s=state();s.activeTurns={};s.threads['guardian-repair']='repair';s.guardian.activeAuditId='repair-incident';s.guardian.activeRepairId='repair-incident';s.activeTurns['guardian-repair']={taskId:'15-01',runningCommands:{edit:{}}};
  let text=sessionStatusLines(s,collectSessionActivity(s,[])).join('\n');assert.match(text,/▶ 운영 코드 수리: 도구 실행 중/);assert.match(text,/○ 운영 감시: 대기/);
  delete s.activeTurns['guardian-repair'];text=sessionStatusLines(s,collectSessionActivity(s,[])).join('\n');assert.match(text,/▶ 운영 코드 수리: 운영 수리 검사 중/);
  s.status='waiting_execution';assert.doesNotMatch(sessionStatusLines(s,collectSessionActivity(s,[])).join('\n'),/▶/);
});
test('uncreated roles remain uncreated and raw final output/reasoning never becomes a status message',()=>{
  const s=state();delete s.threads['verifier-0'];
  const rows=collectSessionActivity(s,[{kind:'event',threadId:'i',itemType:'reasoning',at:'2026-10-15T03:00:00Z'},message('i','확인 중'),{kind:'agent_message',threadId:'i',text:'{"summary":"완료 보고","inputs":["private data"]}',at:'2026-10-15T03:01:00Z'}]);
  const text=sessionStatusLines(s,rows).join('\n');assert.match(text,/태스크 검증 1: 미생성/);assert.match(text,/완료 보고/);assert.doesNotMatch(text,/private data|reasoning/);assert.equal(rows['implementer-0'].lastToolAt,undefined);
});
test('messages are bounded and credentials are redacted before display/cache',()=>{
  const rows=collectSessionActivity(state(),[message('i','Bearer test-secret https://discord.com/api/webhooks/123/test-secret '+ 'x'.repeat(10000))]);
  assert.ok(rows['implementer-0'].message.length<=360);assert.doesNotMatch(rows['implementer-0'].message,/test-secret|api\/webhooks/);
});
test('redecorating controller output is idempotent and preserves the task progress',()=>{
  const s=state(),rows=collectSessionActivity(s,[message('i','현재 메시지')]),base='현재 태스크: 15-01\n\n태스크 상태\n15-01 [running]\n';
  let text=withSessionStatus(base,s,rows);for(let i=0;i<20;i++)text=withSessionStatus(text,s,rows);
  assert.equal(text,withSessionStatus(base,s,rows));assert.equal(text.split(SESSION_BLOCK_START).length,2);assert.match(text,/15-01 \[running\]/);
});
test('event reads are bounded and keep recent complete records from large logs',t=>{
  const base=path.resolve('.tmp/session-progress-tests');fs.mkdirSync(base,{recursive:true});const dir=fs.mkdtempSync(path.join(base,'case-')),file=path.join(dir,'events.jsonl');
  t.after(()=>{assert.ok(path.resolve(dir).startsWith(base+path.sep));fs.rmSync(dir,{recursive:true,force:true});});
  fs.writeFileSync(file,'x'.repeat(EVENT_READ_LIMIT*2)+'\n'+JSON.stringify(message('i','최신 기록'))+'\n');
  const result=readEventTail(file);assert.equal(result.length,1);assert.equal(result[0].text,'최신 기록');
});
test('live progress monitor restores role messages after controller rewrites without changing state',async t=>{
  const base=path.resolve('reports/prompt15/orchestration');fs.mkdirSync(base,{recursive:true});const dir=fs.mkdtempSync(path.join(base,'session-display-test-')),s=state(),stateFile=path.join(dir,'state.json'),progressFile=path.join(dir,'progress.txt');
  const saved=JSON.stringify(s);fs.writeFileSync(stateFile,saved);fs.writeFileSync(progressFile,'태스크 상태\n15-01 [running]\n');fs.writeFileSync(path.join(dir,'events.jsonl'),JSON.stringify(message('i','첫 상태'))+'\n');
  const child=spawn(process.execPath,['tools/prompt15-monitor.mjs','--run',dir,'--write','--quiet'],{cwd:path.resolve('.'),windowsHide:true,stdio:['ignore','ignore','pipe']});let errors='';child.stderr.on('data',value=>{errors+=value;});
  t.after(async()=>{if(child.exitCode===null){const ended=new Promise(resolve=>child.once('close',resolve));child.kill();await ended;}assert.ok(path.resolve(dir).startsWith(base+path.sep));fs.rmSync(dir,{recursive:true,force:true});});
  const waitFor=async needle=>{const deadline=Date.now()+5000;while(Date.now()<deadline){if(child.exitCode!==null)throw Error(errors||'Monitor exited');if(fs.readFileSync(progressFile,'utf8').includes(needle))return;await new Promise(resolve=>setTimeout(resolve,30));}throw Error('Status update did not arrive: '+errors);};
  await waitFor('첫 상태');fs.writeFileSync(progressFile,'태스크 상태\n15-01 [running]\n');await waitFor('첫 상태');fs.appendFileSync(path.join(dir,'events.jsonl'),JSON.stringify(message('i','두 번째 상태','2026-10-15T03:01:00Z'))+'\n');await waitFor('두 번째 상태');assert.equal(fs.readFileSync(stateFile,'utf8'),saved);assert.equal(fs.readFileSync(progressFile,'utf8').split(SESSION_BLOCK_START).length,2);
});
