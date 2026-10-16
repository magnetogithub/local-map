import fs from 'node:fs';
import path from 'node:path';

export const SESSION_BLOCK_START='[세션별 상태·최근 메시지]';
export const SESSION_BLOCK_END='[세션별 상태 끝]';
export const EVENT_READ_LIMIT=256*1024;
const MESSAGE_LIMIT=360;
const clock=new Intl.DateTimeFormat('ko-KR',{timeZone:'Asia/Seoul',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'});
const time=value=>value&&Number.isFinite(Date.parse(value))?`${clock.format(new Date(value))} KST`:'-';
const after=(a,b)=>a&&(!b||Date.parse(a)>=Date.parse(b));
const clean=value=>String(value??'')
  .replaceAll(SESSION_BLOCK_START,'(세션 상태)').replaceAll(SESSION_BLOCK_END,'(세션 상태 끝)')
  .replace(/https:\/\/(?:\w+\.)?discord(?:app)?\.com\/api\/webhooks\/[^\s"'<>]+/gi,'[웹훅 비공개]')
  .replace(/Bearer\s+[^\s"']+/gi,'Bearer [비공개]')
  .replace(/\bsk-[A-Za-z0-9_-]{12,}/g,'[키 비공개]')
  .replace(/[\r\n\t]+/g,' ').replace(/\s+/g,' ').trim().slice(0,MESSAGE_LIMIT);

export function readEventTail(file){
  if(!fs.existsSync(file))return [];
  const size=fs.statSync(file).size,start=Math.max(0,size-EVENT_READ_LIMIT),buffer=Buffer.alloc(size-start),fd=fs.openSync(file,'r');
  let count;
  try{count=fs.readSync(fd,buffer,0,buffer.length,start);}finally{fs.closeSync(fd);}
  const lines=buffer.subarray(0,count).toString('utf8').split('\n');if(start)lines.shift();
  return lines.flatMap(line=>{try{return[JSON.parse(line)];}catch{return[];}});
}

export function collectSessionActivity(state,events,prior={}){
  const taskSessions=state.taskVerificationMode==='controller-vitest'||Object.keys(state.threads??{}).some(key=>/^implementer-15-\d{2}$/.test(key));
  const legacySlots=taskSessions?{}:{'implementer-0':state.threads?.['implementer-0']??null,'verifier-0':state.threads?.['verifier-0']??null};
  const threads={supervisor:state.threads?.supervisor??null,...legacySlots,...state.threads,guardian:state.guardian?.threadId??null};
  const byId=new Map(Object.entries(threads).filter(([,id])=>id).map(([key,id])=>[id,key]));
  const activity={};
  for(const[key,id]of Object.entries(threads))activity[key]={...(id&&prior[key]?.threadId===id?prior[key]:{}),threadId:id};
  for(const event of events){
    const key=byId.get(event.threadId);if(!key)continue;const row=activity[key];
    if(event.kind==='dispatch'){if(after(event.at,row.dispatchedAt)){row.dispatchedAt=event.at;row.taskId=event.taskId??null;row.review=event.review??null;}}
    if(event.kind==='event'&&['commandExecution','mcpToolCall','fileChange','webSearch'].includes(event.itemType)&&after(event.at,row.lastToolAt))row.lastToolAt=event.at;
    if(event.kind==='event'&&event.method==='turn/completed'&&after(event.at,row.completedAt)){row.completedAt=event.at;row.turnStatus=event.status;}
    if(event.kind!=='agent_message'||!after(event.at,row.messageAt))continue;
    let message;
    if(event.phase==='commentary')message=event.text;
    else{try{const result=JSON.parse(event.text);message=result.summary??null;}catch{/* Never display raw structured reports or model reasoning. */}}
    if(message){row.message=clean(message);row.messageAt=event.at;row.messageKind=event.phase==='commentary'?'메시지':'보고';}
  }
  for(const[key,active]of Object.entries(state.activeTurns??{})){
    if(!activity[key])continue;
    if(active.taskId)activity[key].taskId=active.taskId;
    if(after(active.lastToolActivityAt,activity[key].lastToolAt))activity[key].lastToolAt=active.lastToolActivityAt;
  }
  if(state.guardian?.lastSummary&&after(state.guardian.lastCheckedAt,activity.guardian.messageAt)){
    Object.assign(activity.guardian,{message:clean(state.guardian.lastSummary),messageAt:state.guardian.lastCheckedAt,messageKind:'보고'});
  }
  if(state.supervisorOversight?.lastSummary&&after(state.supervisorOversight.lastCheckedAt,activity.supervisor.messageAt)){
    Object.assign(activity.supervisor,{message:clean(state.supervisorOversight.lastSummary),messageAt:state.supervisorOversight.lastCheckedAt,messageKind:'보고'});
  }
  return activity;
}

export function sessionLabel(key){
  const review=key?.match(/^(?:vitest-)?review-verifier-([A-F])$/);if(review)return`리뷰 검증 ${review[1]}`;
  const task=key?.match(/^(implementer|verifier|vitest-verifier)-(15-\d{2})$/);
  if(task)return`${task[1]==='implementer'?'구현':'태스크 검증'} ${task[2]}`;
  const vitest=key?.match(/^vitest-verifier-(\d+)$/);if(vitest)return`태스크 검증 ${Number(vitest[1])+1}`;
  if(key==='vitest-review-verifier')return'리뷰 검증';
  if(key==='guardian-repair')return'운영 코드 수리';
  if(key==='supervisor')return'총괄';if(key==='guardian')return'운영 감시';if(key==='review-verifier')return'리뷰 검증';
  const lane=key?.match(/^(implementer|verifier)-(\d+)$/);
  if(lane)return`${lane[1]==='implementer'?'구현':'태스크 검증'} ${Number(lane[2])+1}`;
  return clean(key??'세션');
}
export function sessionStatusLines(state,activity){
  const keys=Object.keys(activity).sort((a,b)=>{
    const order=key=>key==='supervisor'?0:key.startsWith('implementer')?1:key.includes('review-verifier')?3:key.includes('verifier')?2:key==='guardian'?4:5;
    return order(a)-order(b)||a.localeCompare(b);
  });
  const held=!['running','initializing'].includes(state.status);
  const lines=[SESSION_BLOCK_START,'────────────────────────────────────────────────────────'];
  for(const key of keys){
    const row=activity[key],active=state.activeTurns?.[key],guardianActive=key==='guardian'&&state.guardian?.activeAuditId&&!state.guardian.activeRepairId,repairChecks=key==='guardian-repair'&&state.guardian?.activeRepairId&&!active;
    const oversight=key==='supervisor'?state.supervisorOversight?.status:null,oversightActive=['auditing','repair_pending'].includes(oversight);
    const oversightLabel={auditing:'운영 감시 감사 중',repair_pending:'운영 수리 인계 중',repair_applied_awaiting_product:'운영 수리 적용 · 제품 진척 확인 대기',failed:'운영 감사 실패 · 복구 필요',escalation_exhausted:'운영 감사 복구 한도 도달 · 원인 확인 필요'}[oversight];
    const operating=['supervisor','guardian','guardian-repair'].includes(key),operatingAllowed=!['stopped','standby','manual_hold'].includes(state.status);
    const paused=held&&!(operating&&operatingAllowed&&(active||oversightActive));
    const running=Boolean(row.threadId&&!paused&&(active||guardianActive||repairChecks||oversightActive));
    const status=oversightLabel&&operatingAllowed?`${row.threadId?'':'미생성 · '}${oversightLabel}`:!row.threadId?'미생성 · 배정 시 생성':paused?'대기 · 운영 정지':guardianActive?'운영 점검 중':active?Object.keys(active.runningCommands??{}).length?'도구 실행 중':'작업 중':repairChecks?'운영 수리 검사 중':'대기';
    const task=active?.taskId??row.taskId;
    lines.push(`${running?'▶':'○'} ${sessionLabel(key)}: ${status}${task&&!key.endsWith(task)?` · ${task}`:''} (${row.threadId?.slice(-8)??'-'})`);
    lines.push(`  최근 도구: ${time(row.lastToolAt)}${row.completedAt?` · 최근 응답: ${time(row.completedAt)}`:''}`);
    lines.push(row.message?`  [${time(row.messageAt)} ${row.messageKind??'메시지'}] ${row.message}`:'  아직 메시지가 없습니다.');
  }
  lines.push(SESSION_BLOCK_END);
  return lines;
}

export function withSessionStatus(base,state,activity){
  let stripped=String(base);
  const start=stripped.indexOf(SESSION_BLOCK_START),end=stripped.indexOf(SESSION_BLOCK_END,start);
  if(start>=0&&end>=start)stripped=stripped.slice(0,start).trimEnd()+'\n\n'+stripped.slice(end+SESSION_BLOCK_END.length).trimStart();
  const section=sessionStatusLines(state,activity).join('\n')+'\n\n';
  const index=stripped.indexOf('태스크 상태');
  return (index>=0?stripped.slice(0,index)+section+stripped.slice(index):stripped.trimEnd()+'\n\n'+section).trimEnd();
}

export function taskSessionSnapshot(directory,state){
  const cacheFile=path.join(directory,'session-progress.json');let prior={};
  try{const stat=fs.lstatSync(cacheFile);if(stat.isFile()&&!stat.isSymbolicLink()&&stat.size<128*1024)prior=JSON.parse(fs.readFileSync(cacheFile,'utf8')).sessions??{};}catch{/* Optional display cache; task state/verdicts are never changed. */}
  const sessions=collectSessionActivity(state,readEventTail(path.join(directory,'events.jsonl')),prior);
  const base=fs.readFileSync(path.join(directory,'progress.txt'),'utf8');
  return{text:withSessionStatus(base,state,sessions),cache:{version:1,sessions,lines:sessionStatusLines(state,sessions)},cacheFile};
}
