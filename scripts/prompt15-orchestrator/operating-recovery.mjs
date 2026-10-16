import fs from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {atomicJSON,fileIdentity,resolveInside,validateIdentities} from './protocol.mjs';
import {digest} from './product-target.mjs';
import {protectedActivity} from './execution-lifecycle.mjs';

function resumeTasks(state,requested){
  const inferred=[...(state.requiredUserInput?.taskIds??[]),...Object.entries(state.tasks??{}).filter(([,row])=>row.parked).map(([id])=>id)];
  const taskIds=requested??inferred;
  if(!Array.isArray(taskIds)||taskIds.some(id=>typeof id!=='string'||!Object.hasOwn(state.tasks??{},id)))throw Error('Explicit resume names an unknown task');
  return [...new Set(taskIds)].sort();
}

// This records a user's request to try once. It does not certify credentials,
// grant platform approval, unpark a task, or claim its external blocker is fixed.
export function recordExplicitResume({root,directory,state,source='resume-command',automatic=false,requestFile=null,requestedAt,taskIds}){
  if(automatic)return null;
  directory=resolveInside(root,directory);
  if(!['resume-command','retry-file'].includes(source)||Boolean(requestFile)!==(source==='retry-file'))throw Error('Invalid explicit resume source');
  let bytes,original=null,request;
  if(requestFile){
    requestFile=resolveInside(root,requestFile);
    if(requestFile!==path.join(directory,'retry.json')||!fs.lstatSync(requestFile).isFile()||fs.lstatSync(requestFile).isSymbolicLink())throw Error('Use this run\'s regular retry.json request');
    if(fs.statSync(requestFile).size>65536)throw Error('Explicit resume request exceeds its metadata budget');
    bytes=fs.readFileSync(requestFile);request=JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/,''));
    if(!request||typeof request!=='object'||Array.isArray(request))throw Error('Invalid explicit retry request');
    original=fileIdentity(root,requestFile);
    requestedAt=request.requestedAt??fs.statSync(requestFile).mtime.toISOString();
  }else{
    requestedAt??=new Date().toISOString();
    request={version:1,requestId:randomUUID(),requestedAt,taskIds:resumeTasks(state,taskIds),source};
    bytes=Buffer.from(JSON.stringify(request)+'\n');
  }
  if(typeof requestedAt!=='string'||!Number.isFinite(Date.parse(requestedAt)))throw Error('Explicit resume needs a valid request time');
  const requestHash=createHash('sha256').update(bytes).digest('hex');
  if(original&&(original.sha256!==requestHash||original.byteLength!==bytes.length))throw Error('Explicit retry changed while it was read');
  const receiptDirectory=path.join(directory,'control/explicit-resume',digest({source,requestHash,originalPath:original?.path??null}));
  const preservedRequest=path.join(receiptDirectory,'request.json'),receiptFile=path.join(receiptDirectory,'receipt.json');
  fs.mkdirSync(receiptDirectory,{recursive:true});
  if(!fs.existsSync(preservedRequest))fs.writeFileSync(preservedRequest,bytes,{flag:'wx'});
  else if(!fs.readFileSync(preservedRequest).equals(bytes))throw Error('Explicit resume request changed after preservation');
  const requestIdentity=fileIdentity(root,preservedRequest);let receipt;
  if(fs.existsSync(receiptFile)){
    receipt=JSON.parse(fs.readFileSync(receiptFile,'utf8'));validateIdentities(root,[receipt.requestIdentity]);
    if(receipt.kind!=='explicit-user-resume'||receipt.source!==source||digest(receipt.requestIdentity)!==digest(requestIdentity)||receipt.runDirectory!==directory)throw Error('Explicit resume receipt changed');
    resumeTasks(state,receipt.taskIds);
  }else{
    receipt={version:1,kind:'explicit-user-resume',source,runDirectory:directory,requestedAt,taskIds:resumeTasks(state,request.taskIds??taskIds),requestIdentity,originalRequestIdentity:original,
      authorization:'One actual continuation or verification per selected task; external inputs and approvals remain unverified.'};
    atomicJSON(receiptFile,receipt);
  }
  state.explicitResume={receiptIdentity:fileIdentity(root,receiptFile),requestedAt:receipt.requestedAt,taskIds:receipt.taskIds};
  return state.explicitResume;
}

// Persist the receipt and its state link before consuming the original request.
// A crash between saving and unlinking reuses the same receipt, never a new try.
export function consumeExplicitRetry({root,directory,state,save}){
  const retry=path.join(resolveInside(root,directory),'retry.json');if(!fs.existsSync(retry))return null;
  const original=fileIdentity(root,retry);
  const result=recordExplicitResume({root,directory,state,source:'retry-file',requestFile:retry});
  if(save)save();else atomicJSON(path.join(directory,'state.json'),state);
  if(fs.existsSync(retry)&&digest(fileIdentity(root,retry))===digest(original))fs.unlinkSync(retry);
  return result;
}

export function needsExternalInput(state){
  return Boolean(state.requiredUserInput)||/Human input required:|requestApproval|approval (?:rejected|required)|automatic approval.*reject|not authenticated|unauthorized|authentication required|missing external (?:input|credential)|flagged for possible|content.*flagged|Manual baseline gate:/i.test(state.error??'');
}
export function oversightExhausted(state){
  return state.supervisorOversight?.status==='escalation_exhausted'&&!(Date.parse(state.explicitResume?.requestedAt)>Date.parse(state.supervisorOversight.exhaustedAt??state.supervisorOversight.lastCheckedAt));
}
export function completedProductBlock(state){
  const held=state.productBlockedHandoff,row=state.tasks?.[held?.taskId];
  return Boolean(state.status==='blocked'&&held?.response&&held.handoff&&held.decision&&row?.status==='blocked'&&held.candidateRoot===row.workspace?.directory&&['blocked','repair'].includes(row.blockedProductHandoff?.status)&&digest(held.response)===digest(row.implementation?.responseIdentity??null)&&digest(held.handoff)===digest(row.blockedProductHandoff.handoff??null)&&digest(held.decision)===digest(row.blockedProductHandoff.decision??null)&&digest(held.executionIncident??null)===digest(state.pendingExecutionIncident??null));
}
// A certified BLOCKED response preserves evidence, not an exemption from
// assigning its next owner. Only a concrete external/user decision can park it.
export function productBlockNeedsResolution(state){
  return completedProductBlock(state)&&!needsExternalInput(state)&&!state.userStopped&&!state.stopRequested;
}
export function automaticRecovery(state,config){return config.taskVerificationMode==='controller-vitest'&&config.automaticRecovery!==false&&(!completedProductBlock(state)||productBlockNeedsResolution(state))&&!needsExternalInput(state)&&!oversightExhausted(state)&&state.status!=='stopped'&&state.status!=='standby';}

const taskProgress=state=>Object.fromEntries(Object.entries(state.tasks??{}).map(([id,t])=>[id,{status:t.status,attempt:t.attempt,verification:t.verification??null,targetId:t.acceptedTarget?.targetId??null}]));
export function markProgress(state){
  const fingerprint=digest({phase:state.phase,status:state.status,tasks:taskProgress(state),operations:state.activeOperations,operation:state.activeOperation,turns:Object.values(state.activeTurns??{}).map(t=>({taskId:t.taskId,turnId:t.turnId,lastToolActivityAt:t.lastToolActivityAt}))});
  if(fingerprint!==state.progressFingerprint){state.progressFingerprint=fingerprint;state.progressAt=new Date().toISOString();}
}
export function beginRecovery(state,incident,reason){
  if(state.operatingRecovery?.status==='recovering')return;
  state.operatingRecovery={status:'recovering',incident,reason,startedAt:new Date().toISOString(),baseline:taskProgress(state),certificates:Object.keys(state.certificates??{})};
}
export function completeRecovery(state){
  const recovery=state.operatingRecovery;if(recovery?.status!=='recovering')return false;
  const progressed=Object.keys(state.certificates??{}).some(review=>!(recovery.certificates??[]).includes(review))||Object.entries(state.tasks??{}).some(([id,t])=>{
    const before=recovery.baseline[id];
    return t.status==='pass'&&before?.status!=='pass'||Boolean(t.verification&&t.verification!==before?.verification);
  });
  if(!progressed)return false;
  recovery.status='resolved';recovery.resolvedAt=new Date().toISOString();recovery.resolution='Original workflow produced a new accepted verification or task PASS';return true;
}
export function stalledController(state,config,now=Date.now()){
  if(!automaticRecovery(state,config)||state.status!=='running')return null;
  const operations=Object.values(state.activeOperations??{}),operation=state.activeOperation;
  if([...operations,operation].some(op=>op?.deadlineAt&&now>Date.parse(op.deadlineAt)+30000))return 'Official test operation exceeded its deadline';
  if(protectedActivity(state,now))return null;
  // Synchronous immutable-input hashing has an explicit bounded operation.
  // A stale main-loop heartbeat during it must not kill a valid repair handoff.
  const bounded=[...operations,operation].some(op=>op?.deadlineAt&&now<=Date.parse(op.deadlineAt)+30000);
  if(state.heartbeatAt&&now-Date.parse(state.heartbeatAt)>Math.max(60000,config.controllerProgressTimeoutMs??300000)&&!bounded)return 'Controller stopped refreshing its heartbeat';
  const turns=Object.values(state.activeTurns??{});
  if(turns.length||state.guardian?.activeAuditId||operation)return null; // Each has its own bounded deadline.
  if(state.progressAt&&now-Date.parse(state.progressAt)>(config.controllerProgressTimeoutMs??300000))return 'Controller heartbeat is alive but task progress has stalled';
  return null;
}
