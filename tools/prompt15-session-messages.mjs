import fs from 'node:fs';
import path from 'node:path';
import {collectSessionActivity,sessionStatusLines,sessionLabel,withSessionStatus,readEventTail,SESSION_BLOCK_START,SESSION_BLOCK_END} from './prompt15-session-progress-core.mjs';

export const MESSAGE_HISTORY_LIMIT=5;
export const ALL_TASK_MESSAGES_START='[전체 태스크 최근 메시지 5개]';
export const MESSAGE_CACHE_READ_LIMIT=1024*1024;
const BACKFILL_LIMIT=8*1024*1024;
const clock=new Intl.DateTimeFormat('ko-KR',{timeZone:'Asia/Seoul',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'});
const time=at=>`${clock.format(new Date(at))} KST`;
const clean=value=>String(value??'').replaceAll(SESSION_BLOCK_START,'(세션 상태)').replaceAll(SESSION_BLOCK_END,'(세션 상태 끝)')
  .replaceAll(ALL_TASK_MESSAGES_START,'(전체 태스크 최근 메시지)')
  .replace(/https:\/\/(?:\w+\.)?discord(?:app)?\.com\/api\/webhooks\/[^\s"'<>]+/gi,'[웹훅 비공개]')
  .replace(/Bearer\s+[^\s"']+/gi,'Bearer [비공개]').replace(/\bsk-[A-Za-z0-9_-]{12,}/g,'[키 비공개]')
  .replace(/[\r\n\t]+/g,' ').replace(/\s+/g,' ').trim().slice(0,360);
const scope=message=>message.taskId??(message.review?`REVIEW ${message.review}`:'운영');

function recent(messages){
  const unique=new Map();
  for(const value of messages){
    if(!value||typeof value.text!=='string'||!Number.isFinite(Date.parse(value.at)))continue;
    const message={at:value.at,text:clean(value.text),kind:value.kind==='보고'?'보고':'메시지',threadId:value.threadId??null,sessionKey:value.sessionKey??null,taskId:value.taskId??null,review:value.review??null};
    if(message.text)unique.set(JSON.stringify([message.threadId,message.at,message.kind,message.text]),message);
  }
  return [...unique.values()].sort((a,b)=>Date.parse(b.at)-Date.parse(a.at)||JSON.stringify(a).localeCompare(JSON.stringify(b))).slice(0,MESSAGE_HISTORY_LIMIT);
}

export function collectMessageHistory(state,events,prior={}){
  const sessions=collectSessionActivity(state,events,prior.sessions??{}),contexts=new Map(),histories={},all=[...(prior.recentMessages??[])];
  for(const[key,row]of Object.entries(sessions)){
    const previous=prior.sessions?.[key];
    histories[key]=previous?.threadId===row.threadId?recent(previous.messages??[]):[];
    if(row.threadId)contexts.set(row.threadId,{sessionKey:key,taskId:row.taskId??key.match(/^(?:implementer|(?:vitest-)?verifier)-(15-\d{2})$/)?.[1]??null,review:row.review??null,at:row.dispatchedAt??null});
    all.push(...histories[key]);
  }
  for(const message of prior.recentMessages??[])if(message.threadId&&!contexts.has(message.threadId))contexts.set(message.threadId,{sessionKey:message.sessionKey,taskId:message.taskId,review:message.review,at:message.at});
  for(const event of events){
    if(event.kind==='dispatch'&&event.threadId){
      const previous=contexts.get(event.threadId);
      contexts.set(event.threadId,{sessionKey:previous?.sessionKey??event.sessionName??event.role??null,taskId:event.taskId??null,review:event.review??null,at:event.at});
      continue;
    }
    if(event.kind!=='agent_message')continue;
    let text=event.phase==='commentary'?event.text:null;
    if(!text)try{text=JSON.parse(event.text).summary;}catch{/* Raw reports and reasoning are never displayed. */}
    if(typeof text!=='string'||!text.trim())continue;
    const context=contexts.get(event.threadId),known=!context?.at||Date.parse(event.at)>=Date.parse(context.at);
    const message={at:event.at,text,kind:event.phase==='commentary'?'메시지':'보고',threadId:event.threadId,sessionKey:context?.sessionKey??null,taskId:event.taskId??(known?context?.taskId:null),review:event.review??(known?context?.review:null)};
    all.push(message);
    if(histories[context?.sessionKey]&&sessions[context.sessionKey].threadId===event.threadId)histories[context.sessionKey].push(message);
  }
  for(const[key,row]of Object.entries(sessions)){
    // Upgrade old single-message caches only when actual message history is absent.
    if(!histories[key].length&&row.message&&row.messageAt)histories[key].push({at:row.messageAt,text:row.message,kind:row.messageKind,threadId:row.threadId,sessionKey:key,taskId:row.taskId??null,review:row.review??null});
    row.messages=recent(histories[key]);all.push(...row.messages);
  }
  return{sessions,recentMessages:recent(all)};
}

export function messageStatusLines(state,history){
  const display=Object.fromEntries(Object.entries(history.sessions).map(([key,row])=>{
    const messages=row.messages??[],latest=messages[0];if(!latest)return[key,row];
    const rest=messages.slice(1).map(message=>`\n  [${time(message.at)} ${message.kind}] ${scope(message)} · ${message.text}`).join('');
    return[key,{...row,messageAt:latest.at,messageKind:latest.kind,message:`${scope(latest)} · ${latest.text}${rest}`}];
  }));
  const visible=state.taskVerificationMode==='controller-vitest'?Object.fromEntries(Object.entries(display).filter(([key])=>!(/^(?:verifier-|vitest-verifier-)/.test(key)))):display;
  const lines=sessionStatusLines(state,visible).flatMap(line=>line.split('\n'));
  if(state.taskVerificationMode==='controller-vitest')lines.splice(1,0,`태스크 검증: 제어기 Vitest 자동 실행 · 별도 태스크 검증 AI 없음${state.phase==='task_test'?' · 검사 실행 중':''}`);
  lines.splice(1,0,ALL_TASK_MESSAGES_START,...(history.recentMessages.length?history.recentMessages.map(message=>`  [${time(message.at)} ${message.kind}] ${scope(message)} · ${sessionLabel(message.sessionKey)}: ${message.text}`):['  아직 메시지가 없습니다.']),'','세션별 최근 메시지 (최대 5개 · 최신순)');
  return{lines,display};
}

function readBackfill(file){
  if(!fs.existsSync(file))return[];
  const size=fs.statSync(file).size,start=Math.max(0,size-BACKFILL_LIMIT),buffer=Buffer.alloc(size-start),fd=fs.openSync(file,'r');let count;
  try{count=fs.readSync(fd,buffer,0,buffer.length,start);}finally{fs.closeSync(fd);}
  const lines=buffer.subarray(0,count).toString('utf8').split('\n');if(start)lines.shift();
  return lines.flatMap(line=>{try{return[JSON.parse(line)];}catch{return[];}});
}

export function taskMessageSnapshot(directory,state){
  const cacheFile=path.join(directory,'session-progress.json');let prior={};
  try{const stat=fs.lstatSync(cacheFile);if(stat.isFile()&&!stat.isSymbolicLink()&&stat.size<MESSAGE_CACHE_READ_LIMIT)prior=JSON.parse(fs.readFileSync(cacheFile,'utf8'));}catch{/* Display cache is optional. */}
  const read=prior.messageHistoryVersion===1?readEventTail:readBackfill;
  const events=[...read(path.join(directory,'events.jsonl.previous')),...read(path.join(directory,'events.jsonl'))];
  const history=collectMessageHistory(state,events,prior),{lines,display}=messageStatusLines(state,history);
  const decorated=withSessionStatus(fs.readFileSync(path.join(directory,'progress.txt'),'utf8'),state,display);
  const start=decorated.indexOf(SESSION_BLOCK_START),end=decorated.indexOf(SESSION_BLOCK_END,start)+SESSION_BLOCK_END.length;
  return{text:(decorated.slice(0,start)+lines.join('\n')+decorated.slice(end)).trimStart(),cache:{version:1,messageHistoryVersion:1,...history,lines},cacheFile};
}
