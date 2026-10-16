import {test,expect,onTestFinished} from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {collectMessageHistory,messageStatusLines,taskMessageSnapshot,ALL_TASK_MESSAGES_START,MESSAGE_CACHE_READ_LIMIT} from './prompt15-session-messages.mjs';
import {SESSION_BLOCK_START,sessionLabel,collectSessionActivity,sessionStatusLines} from './prompt15-session-progress-core.mjs';

const state=()=>({implementationUnit:'task',status:'running',threads:{supervisor:'s','implementer-0':'i','vitest-verifier-0':'v'},guardian:{threadId:'g'},activeTurns:{}});
const at=n=>new Date(Date.UTC(2026,9,15,6,0,n)).toISOString();
const message=(threadId,text,n)=>({kind:'agent_message',phase:'commentary',threadId,text,at:at(n)});
const dispatch=(threadId,taskId,n)=>({kind:'dispatch',threadId,taskId,at:at(n),review:'A',sessionName:threadId==='i'?'implementer-0':'vitest-verifier-0'});

function fixture(){
  const base=path.resolve('reports/prompt15/orchestration');fs.mkdirSync(base,{recursive:true});const directory=fs.mkdtempSync(path.join(base,'message-display-test-'));
  onTestFinished(()=>{expect(directory.startsWith(base+path.sep)).toBe(true);fs.rmSync(directory,{recursive:true,force:true});});
  fs.writeFileSync(path.join(directory,'progress.txt'),'태스크 상태\n15-01 [running]\n');return directory;
}

test('each session keeps five newest messages with the original task assignment',()=>{
  const events=[dispatch('i','15-01',0),...Array.from({length:4},(_,n)=>message('i',`first-${n}`,n+1)),dispatch('i','15-02',5),...Array.from({length:3},(_,n)=>message('i',`second-${n}`,n+6)),...Array.from({length:7},(_,n)=>message('v',`verify-${n}`,n+1))];
  const history=collectMessageHistory(state(),events),rows=history.sessions['implementer-0'].messages;
  expect(rows.map(row=>row.text)).toEqual(['second-2','second-1','second-0','first-3','first-2']);expect(rows.map(row=>row.taskId)).toEqual(['15-02','15-02','15-02','15-01','15-01']);expect(history.sessions['vitest-verifier-0'].messages).toHaveLength(5);
});

test('global latest five include all sessions and survive repeated polling without duplicates',()=>{
  const s=state(),events=[dispatch('i','15-01',0),dispatch('v','15-02',0),...Array.from({length:8},(_,n)=>message(n%2?'v':'i',`message-${n}`,n+1))];
  let history=collectMessageHistory(s,events);for(let n=0;n<20;n++)history=collectMessageHistory(s,events,history);
  expect(history.recentMessages.map(row=>row.text)).toEqual(['message-7','message-6','message-5','message-4','message-3']);expect(new Set(history.recentMessages.map(row=>row.taskId))).toEqual(new Set(['15-01','15-02']));
  const later=state();later.threads['implementer-0']='replacement';history=collectMessageHistory(later,[],history);expect(history.recentMessages.map(row=>row.text)).toContain('message-6');expect(history.sessions['implementer-0'].messages).toHaveLength(0);
});

test('task session keys display task identity while legacy lanes remain readable',()=>{
  expect(sessionLabel('implementer-15-08')).toBe('구현 15-08');
  expect(sessionLabel('implementer-0')).toBe('구현 1');
  expect(sessionLabel('verifier-15-08')).toBe('태스크 검증 15-08');
  expect(sessionLabel('vitest-verifier-2')).toBe('태스크 검증 3');
  expect(sessionLabel('review-verifier')).toBe('리뷰 검증');
  expect(sessionLabel('vitest-review-verifier')).toBe('리뷰 검증');
  const s={status:'running',taskVerificationMode:'controller-vitest',threads:{supervisor:'s','implementer-15-08':'i','review-verifier':'r'},guardian:{threadId:'g'},activeTurns:{'implementer-15-08':{taskId:'15-08'}}};
  const history=collectMessageHistory(s,[message('i','task-scoped update',1),message('r','review update',2)]);
  expect(history.sessions['implementer-15-08'].messages[0].taskId).toBe('15-08');
  expect(history.sessions).not.toHaveProperty('implementer-0');
  expect(history.sessions).not.toHaveProperty('verifier-0');
  const text=messageStatusLines(s,history).lines.join('\n');
  expect(text).toContain('구현 15-08: 작업 중');
  expect(text).toContain('15-08 · 구현 15-08: task-scoped update');
  expect(text).toContain('태스크 검증: 제어기 Vitest 자동 실행');
  expect(text).toContain('리뷰 검증: 대기');
  expect(text).not.toContain('전체 REVIEW 검증');
});

test('supervisor oversight is visible during operating recovery and respects an explicit stop',()=>{
  const s={status:'waiting_execution',threads:{supervisor:'s','implementer-15-08':'i'},activeTurns:{supervisor:{},'implementer-15-08':{taskId:'15-08'}},guardian:{threadId:'g'},supervisorOversight:{status:'auditing',activeAuditId:'audit-1',lastSummary:'same cause detected',lastCheckedAt:at(2)}};
  let text=sessionStatusLines(s,collectSessionActivity(s,[])).join('\n');
  expect(text).toContain('▶ 총괄: 운영 감시 감사 중');
  expect(text).toContain('○ 구현 15-08: 대기 · 운영 정지');
  expect(text).toContain('same cause detected');
  s.supervisorOversight.status='repair_pending';
  text=sessionStatusLines(s,collectSessionActivity(s,[])).join('\n');
  expect(text).toContain('▶ 총괄: 운영 수리 인계 중');
  s.status='stopped';
  text=sessionStatusLines(s,collectSessionActivity(s,[])).join('\n');
  expect(text).toContain('○ 총괄: 대기 · 운영 정지');
  expect(text).not.toContain('▶');
});

test('old single-message caches upgrade while actual history is preferred',()=>{
  const prior={sessions:{'implementer-0':{threadId:'i',message:'previous',messageAt:at(1),taskId:'15-01'}}};
  expect(collectMessageHistory(state(),[],prior).sessions['implementer-0'].messages[0].text).toBe('previous');
  const history=collectMessageHistory(state(),[message('i','actual one',2),message('i','actual two',3)],prior);expect(history.sessions['implementer-0'].messages.map(row=>row.text)).toEqual(['actual two','actual one']);
});

test('history and global display redact credentials and omit raw reports and reasoning',()=>{
  const history=collectMessageHistory(state(),[message('i','Bearer secret-value https://discord.com/api/webhooks/123/secret-value '+ 'x'.repeat(10000),1),{kind:'agent_message',threadId:'v',phase:'final_answer',text:JSON.stringify({summary:'검증 완료',private:'do-not-display'}),at:at(2)},{kind:'agent_message',threadId:'v',phase:'final_answer',text:'raw-report-do-not-display',at:at(3)},{kind:'event',threadId:'i',itemType:'reasoning',text:'reasoning-do-not-display',at:at(4)}]);
  const serialized=JSON.stringify({...history,lines:messageStatusLines(state(),history).lines});expect(serialized).not.toMatch(/secret-value|api\/webhooks|do-not-display/);expect(history.sessions['implementer-0'].messages[0].text.length).toBeLessThanOrEqual(360);expect(serialized).toContain('검증 완료');
});

test('rotated event backfill and cache preserve five messages after controller refreshes',()=>{
  const directory=fixture(),s=state();fs.writeFileSync(path.join(directory,'events.jsonl.previous'),[dispatch('i','15-01',0),...Array.from({length:7},(_,n)=>message('i',`saved-${n}`,n+1))].map(JSON.stringify).join('\n')+'\n');fs.writeFileSync(path.join(directory,'events.jsonl'),JSON.stringify(message('v','latest verification',9))+'\n');
  const first=taskMessageSnapshot(directory,s);expect(first.cache.sessions['implementer-0'].messages).toHaveLength(5);expect(first.cache.recentMessages).toHaveLength(5);fs.writeFileSync(first.cacheFile,JSON.stringify(first.cache));fs.writeFileSync(path.join(directory,'progress.txt'),first.text);
  const second=taskMessageSnapshot(directory,s);expect(second.text).toBe(first.text);expect(second.text.split(ALL_TASK_MESSAGES_START)).toHaveLength(2);expect(second.cache.lines.length).toBeLessThan(150);expect(second.cache.lines.every(line=>line.length<=1000&&!line.includes('\n'))).toBe(true);
  fs.writeFileSync(path.join(directory,'events.jsonl.previous'),'');fs.writeFileSync(path.join(directory,'events.jsonl'),'');fs.writeFileSync(path.join(directory,'progress.txt'),'태스크 상태\n15-01 [running]\n');const refreshed=taskMessageSnapshot(directory,s);expect(refreshed.cache.sessions['implementer-0'].messages).toHaveLength(5);expect(refreshed.text).toContain('saved-6');
});

test('all forty-eight task sessions retain five bounded Korean messages after event rotation',()=>{
  const directory=fixture(),s={implementationUnit:'task',status:'running',taskVerificationMode:'controller-vitest',threads:{supervisor:'s'},guardian:{threadId:'g'},activeTurns:{}},events=[];
  for(let n=1;n<=48;n++){
    const taskId=`15-${String(n).padStart(2,'0')}`,key=`implementer-${taskId}`,threadId=`thread-${taskId}`;
    s.threads[key]=threadId;
    events.push({kind:'dispatch',threadId,taskId,review:'A',sessionName:key,at:at(0)},...Array.from({length:7},(_,i)=>message(threadId,`${taskId}-${i} ${'문'.repeat(340)}`,i+1)));
  }
  fs.writeFileSync(path.join(directory,'events.jsonl'),events.map(JSON.stringify).join('\n')+'\n');
  const first=taskMessageSnapshot(directory,s),serialized=JSON.stringify(first.cache,null,2);
  expect(Buffer.byteLength(serialized)).toBeLessThan(MESSAGE_CACHE_READ_LIMIT);
  expect(Buffer.byteLength(JSON.stringify(first.cache.lines))).toBeLessThan(512*1024);
  expect(first.cache.lines.length).toBeLessThan(600);
  fs.writeFileSync(first.cacheFile,serialized);fs.writeFileSync(path.join(directory,'events.jsonl'),'');
  const afterRotation=taskMessageSnapshot(directory,s);
  for(let n=1;n<=48;n++)expect(afterRotation.cache.sessions[`implementer-15-${String(n).padStart(2,'0')}`].messages).toHaveLength(5);
  expect(afterRotation.cache.recentMessages).toHaveLength(5);
});

test('live monitor updates both five-message lists without changing task state',async()=>{
  const directory=fixture(),s=state(),stateFile=path.join(directory,'state.json'),progress=path.join(directory,'progress.txt'),events=path.join(directory,'events.jsonl'),saved=JSON.stringify(s);fs.writeFileSync(stateFile,saved);fs.writeFileSync(events,[dispatch('i','15-01',0),...Array.from({length:6},(_,n)=>message('i',`live-${n}`,n+1))].map(JSON.stringify).join('\n')+'\n');
  const child=spawn(process.execPath,['tools/prompt15-monitor.mjs','--run',directory,'--write','--quiet'],{cwd:process.cwd(),windowsHide:true,stdio:['ignore','ignore','pipe']});let errors='';child.stderr.on('data',chunk=>{errors+=chunk;});
  onTestFinished(async()=>{if(child.exitCode===null){const ended=new Promise(resolve=>child.once('close',resolve));child.kill();await ended;}});
  const waitFor=async needle=>{const deadline=Date.now()+5000;while(Date.now()<deadline){if(child.exitCode!==null)throw Error(errors||'Monitor exited');if(fs.readFileSync(progress,'utf8').includes(needle))return;await new Promise(resolve=>setTimeout(resolve,30));}throw Error('Live display did not update: '+errors);};
  await waitFor(ALL_TASK_MESSAGES_START);const cache=JSON.parse(fs.readFileSync(path.join(directory,'session-progress.json'),'utf8'));expect(cache.sessions['implementer-0'].messages).toHaveLength(5);expect(cache.recentMessages).toHaveLength(5);expect(fs.readFileSync(progress,'utf8')).not.toContain('live-0');
  fs.writeFileSync(progress,'태스크 상태\n15-01 [running]\n');await waitFor('live-5');fs.appendFileSync(events,JSON.stringify(message('v','new verification message',10))+'\n');await waitFor('new verification message');expect(fs.readFileSync(stateFile,'utf8')).toBe(saved);expect(fs.readFileSync(progress,'utf8').split(SESSION_BLOCK_START)).toHaveLength(2);
});
