import {createHash} from 'node:crypto';
import {repairProtected} from './execution-lifecycle.mjs';
import {completedProductBlock,productBlockNeedsResolution} from './operating-recovery.mjs';

const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).filter(([,v])=>v!==undefined).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>[k,canonical(v)])):value;
const hash=value=>createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const clone=value=>structuredClone(value);
const time=value=>typeof value==='number'&&Number.isFinite(value)?value:typeof value==='string'&&Number.isFinite(Date.parse(value))?Date.parse(value):null;
const iso=value=>new Date(value).toISOString();
const clock=value=>{const result=time(value);if(result===null)throw Error('Supervisor policy requires an explicit observation time');return result;};
const positive=(value,fallback)=>Number.isFinite(value)&&value>0?value:fallback;
const terminal=new Set(['completed','failed','interrupted','cancelled','canceled','finished']);

function activityKind(key,value){
  if(['product-handoff','product-input-validation'].includes(value.kind))return value.kind;
  const name=`${key} ${value.role??''} ${value.kind??''}`.toLowerCase();
  if(/guardian|operating|oversight|supervisor/.test(name))return 'operating';
  if(/implementer|implementation/.test(name))return 'implementation';
  if(/test[-_ ]?preparer|test[-_ ]?preparation/.test(name))return 'test-preparation';
  if(/review[-_ ]?verif|vitest-review-verifier/.test(name))return 'review-verification';
  if(/verifier|verification|vitest/.test(name))return 'task-verification';
  return 'unknown';
}

function activities(state){
  const values=[],seen=new Set();
  const add=(key,value,type)=>{
    if(!value||typeof value!=='object'||value.active===false||terminal.has(value.status))return;
    const fingerprint=hash({type,key:value.taskId??key,threadId:value.threadId,turnId:value.turnId,pid:value.pid,startedAt:value.startedAt,deadlineAt:value.deadlineAt});
    if(seen.has(fingerprint))return;seen.add(fingerprint);
    values.push({key,type,kind:activityKind(key,value),taskId:value.taskId??null,review:value.review??null,threadId:value.threadId??null,turnId:value.turnId??null,pid:value.pid??null,startedAt:time(value.startedAt),lastToolActivityAt:time(value.lastToolActivityAt),deadlineAt:time(value.deadlineAt)});
  };
  for(const [key,value]of Object.entries(state.activeTurns??{}))add(key,value,'turn');
  for(const [key,value]of Object.entries(state.activeOperations??{}))add(key,value,'operation');
  if(state.activeOperation)add(state.activeOperation.taskId??'legacy-operation',state.activeOperation,'operation');
  if(state.guardian?.activeAuditId&&state.guardian.activeAuditDeadlineAt)add('guardian-audit',{...state.guardian,startedAt:state.guardian.activeAuditStartedAt,deadlineAt:state.guardian.activeAuditDeadlineAt},'operation');
  return values;
}

const isProduct=value=>value.kind!=='operating'&&value.kind!=='unknown';
const taskScope=state=>({runId:state.runId??null,review:state.review??null,tasks:[...(state.currentTasks??[])].sort().map(id=>({id,attempt:state.tasks?.[id]?.attempt??null}))});
const normalizedCause=value=>String(value??'').replace(/\b\d{4}-\d\d-\d\dT[\d:.]+Z\b/g,'<time>').replace(/\b[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}\b/gi,'<id>').replace(/\b[\da-f]{32,}\b/gi,'<hash>').replace(/(?:runtime|audit)-\d{8,}/gi,'event-<id>').replace(/guardian[\\/]audits[\\/][^\\/\s]+/gi,'guardian/audits/<id>').replace(/\b(?:auditId|audit|repair)(?:\s*[=:]\s*|-)\d{3,}-[a-f0-9]{6,}\b/gi,'audit:<id>').replace(/\s+/g,' ').trim();

function productMarkers(state,active){
  const values=new Map(),add=(key,value,at)=>{if(value!==null&&value!==undefined)values.set(key,{value:hash(value),at:time(at)});};
  for(const [id,row]of Object.entries(state.tasks??{})){
    add(`implementation:${id}`,row.implementation?.responseIdentity,row.implementation?.completedAt);
    add(`verification:${id}`,row.verificationIdentity??row.verification,row.verifiedAt);
    add(`accepted:${id}`,row.acceptedTarget?.targetId,row.passedAt);
  }
  for(const [review,certificate]of Object.entries(state.certificates??{}))add(`review:${review}`,certificate.verification,certificate.passedAt);
  for(const [key,receipt]of Object.entries(state.productResponses??{}))add(`response:${key}`,receipt.identity,receipt.completedAt);
  for(const item of active.filter(isProduct)){
    if(['product-handoff','product-input-validation'].includes(item.kind))continue;
    // A dispatch draft is not execution. Native turn identity or a real child
    // PID is required; generic activity/messages and role phase do not count.
    const identity=item.type==='turn'?item.turnId:item.pid;
    if(!identity)continue;
    const at=item.lastToolActivityAt??item.startedAt;
    add(`execution:${item.type}:${item.threadId??item.taskId??item.key}:${identity}`,{identity,at},at);
  }
  return values;
}

function legacyProgressTime(state,active,now){
  const candidates=[state.productProgress?.lastProductProgressAt,state.productProgress?.lastExecutionAt];
  for(const row of Object.values(state.tasks??{}))candidates.push(row.implementation?.completedAt,row.verifiedAt,row.passedAt);
  for(const item of active.filter(isProduct))candidates.push(item.lastToolActivityAt,item.startedAt);
  const valid=candidates.map(time).filter(value=>value!==null&&value<=now);
  return valid.length?Math.max(...valid):Math.min(time(state.createdAt)??now,now);
}

// Pure observations live in the external runtime's own control file. Neither
// heartbeat, a task-status flip, nor any guardian tool updates this clock.
export function observeProductProgress(state,previousObservation=null,now){
  now=clock(now);
  const previous=previousObservation??(state.productProgress?.version===1?state.productProgress:null);
  let observation=previous?clone(previous):{version:1,productEvidence:{},guardianAudits:{seen:[],groups:{}},oversight:{}};
  observation.oversight??={};
  const explicitRetry=state.explicitResume?.receiptIdentity?.sha256;
  if(previous&&explicitRetry&&explicitRetry!==previous.explicitRetryIdentity){
    // A validated user resume grants a fresh bounded audit budget, not product
    // approval and not a fictional reset of the product progress clock.
    observation.oversight={};observation.guardianAudits={seen:[],groups:{}};
  }
  if(explicitRetry)observation.explicitRetryIdentity=explicitRetry;
  const maintenance=state.operatingMaintenance?.acceptedReceiptSha;
  if(previous&&maintenance&&maintenance!==previous.maintenanceIdentity){observation.oversight={};observation.guardianAudits={seen:[],groups:{}};}
  if(maintenance)observation.maintenanceIdentity=maintenance;
  const active=activities(state),markers=productMarkers(state,active),evidence=observation.productEvidence??{};
  let last=time(observation.lastProductProgressAt)??legacyProgressTime(state,active,now),progressed=false;
  for(const [key,item]of markers){
    if(evidence[key]?.value===item.value)continue;
    const at=Math.min(item.at??(previous?now:last),now);
    evidence[key]={value:item.value,at};
    if(previous){last=Math.max(last,at);progressed=true;}
  }
  // Keep every current marker and only a bounded tail of retired executions.
  const retired=Object.keys(evidence).filter(key=>!markers.has(key)).sort((a,b)=>evidence[b].at-evidence[a].at);
  for(const key of retired.slice(128))delete evidence[key];
  observation.productEvidence=evidence;observation.productFingerprint=hash(Object.fromEntries(Object.entries(evidence).map(([key,value])=>[key,value.value])));
  observation.productGeneration=(previous?.productGeneration??0)+(progressed?1:0);
  observation.lastProductProgressAt=iso(last);observation.lastObservedAt=iso(now);observation.productProgressed=progressed;observation.activeProducts=active.filter(isProduct);
  for(const failure of state.supervisorOversight?.operatingFailures??[]){
    if(!failure.incidentFingerprint||!failure.identity?.sha256)continue;
    if((failure.resumeIdentity??null)!==(explicitRetry??null)||(failure.maintenanceIdentity??null)!==(maintenance??null))continue;
    const row=observation.oversight[failure.incidentFingerprint];if(!row)continue;
    row.failureIds??=[];
    if(!row.failureIds.includes(failure.identity.sha256)){row.failureIds.push(failure.identity.sha256);row.failureCount=(row.failureCount??0)+1;}
  }
  const guardian=state.guardian;
  if(guardian?.lastAuditIdentity){
    const incident=state.operatingRecovery?.status==='recovering'?state.operatingRecovery.incident:state.pendingExecutionIncident;
    observation=recordGuardianAudit(observation,{identity:guardian.lastAuditIdentity,incidentId:incident??{scope:taskScope(state),cause:normalizedCause(state.error??guardian.lastSummary)},cause:guardian.lastCauseCode??state.error??guardian.lastSummary,decision:guardian.lastDecision,at:guardian.lastCheckedAt},now);
  }
  return observation;
}

// The audit identity is counted once even when polled thousands of times.
// Cause content is hashed, so policy state contains no raw logs or credentials.
export function recordGuardianAudit(observation,audit,now){
  now=clock(now);const result=clone(observation),ledger=result.guardianAudits??={seen:[],groups:{}};
  if(!audit?.identity||!audit.incidentId)return result;
  const identity=hash(audit.identity);if(ledger.seen.includes(identity))return result;
  const incidentFingerprint=hash(audit.incidentId),causeFingerprint=hash(normalizedCause(audit.cause)),productGeneration=result.productGeneration??0,group=hash({incidentFingerprint,causeFingerprint,productGeneration});
  const previous=ledger.groups[group];
  ledger.groups[group]={incidentFingerprint,causeFingerprint,productGeneration,count:(previous?.count??0)+1,firstAt:previous?.firstAt??iso(Math.min(time(audit.at)??now,now)),lastAt:iso(Math.min(time(audit.at)??now,now)),lastDecision:audit.decision??null};
  ledger.seen=[...ledger.seen,identity].slice(-128);
  const groups=Object.entries(ledger.groups).sort(([,a],[,b])=>time(b.lastAt)-time(a.lastAt));ledger.groups=Object.fromEntries(groups.slice(0,32));
  return result;
}

function excluded(state){
  if(['stopped','stopping','standby'].includes(state.status)||state.userStopped||state.stopRequested)return 'user_stop_or_standby';
  if(state.status!=='waiting_input')return null;
  const input=state.requiredUserInput;
  if(input&&(input.external===true||/approval|permission|auth|credential|missing_external_input|user_decision/.test(input.kind??'')))return 'external_input_wait';
  if(/Human input required:|requestApproval|approval (?:rejected|required)|automatic approval.*reject|not authenticated|unauthorized|authentication required|missing external (?:input|credential)/i.test(state.error??''))return 'external_input_wait';
  return null;
}

export function evaluateSupervisorOversight(state,config={},observation,now){
  now=clock(now);if(!observation?.lastProductProgressAt)throw Error('Observe product progress before evaluating supervisor oversight');
  const policy=config.supervisorOversight??{},gapMs=positive(policy.productGapMs,300000),repeatLimit=positive(policy.repeatedAuditLimit,3),cooldownMs=positive(policy.escalationCooldownMs,60000),maxAudits=Math.max(2,Math.floor(positive(policy.maxAuditsPerIncident,3)));
  const none=(reasonCode,extra={})=>({decision:'none',reasonCode,incidentFingerprint:null,level:0,preserveProductExecution:true,...extra});
  const exclusion=excluded(state);if(exclusion)return none(exclusion);
  if(repairProtected(state,now))return none('operating_repair_within_deadline');
  const active=activities(state).map(item=>({...item,deadlineAt:item.deadlineAt??(item.type==='turn'&&isProduct(item)&&item.startedAt!==null&&Number.isFinite(config.turnTimeoutMs)&&config.turnTimeoutMs>0?item.startedAt+config.turnTimeoutMs:null)}));
  const expired=active.filter(item=>item.deadlineAt!==null&&now>=item.deadlineAt).sort((a,b)=>a.deadlineAt-b.deadlineAt);
  const protectedProducts=active.filter(item=>isProduct(item)&&(item.type!=='turn'||item.turnId)&&item.deadlineAt!==null&&now<item.deadlineAt);
  const repeats=Object.values(observation.guardianAudits?.groups??{}).filter(item=>item.productGeneration===(observation.productGeneration??0)&&item.count>=repeatLimit&&time(item.lastAt)>=time(observation.lastProductProgressAt)).sort((a,b)=>time(b.lastAt)-time(a.lastAt));
  const gap=Math.max(0,now-time(observation.lastProductProgressAt));let reasonCode,fingerprint,evidence;
  if(expired.length){
    const {key,type,threadId,turnId,pid,startedAt,deadlineAt}=expired[0];
    reasonCode='deadline_exceeded';fingerprint=hash({scope:taskScope(state),deadline:{key,type,threadId,turnId,pid,startedAt,deadlineAt}});evidence={expiredActivities:expired,productGapMs:gap};
  }else{
    if(!active.length&&completedProductBlock(state)&&!productBlockNeedsResolution(state))return none('completed_product_blocked_handoff');
    if(protectedProducts.length)return none('product_execution_within_deadline',{nextEligibleAt:iso(Math.min(...protectedProducts.map(item=>item.deadlineAt)))});
    if(repeats.length)reasonCode='repeated_guardian_cause';else if(gap>=gapMs)reasonCode='product_execution_gap';else return none('product_progress_recent',{nextEligibleAt:iso(time(observation.lastProductProgressAt)+gapMs)});
    fingerprint=hash({scope:taskScope(state),productFingerprint:observation.productFingerprint,outage:'no-product-progress'});
    evidence={productGapMs:gap,lastProductProgressAt:observation.lastProductProgressAt,repeatedAudit:repeats[0]??null,operatingActivities:active.filter(item=>!isProduct(item))};
  }
  const prior=observation.oversight?.[fingerprint],count=prior?.count??0;
  const pending=prior?.status==='requested'&&time(prior.deadlineAt)!==null&&now<time(prior.deadlineAt);
  if(pending)return none('oversight_in_progress',{incidentFingerprint:fingerprint,level:count,nextEligibleAt:prior.deadlineAt,evidence});
  if((prior?.failureCount??0)>=maxAudits)return none('escalation_exhausted',{incidentFingerprint:fingerprint,level:count,exhausted:true,requiresSupervisorIntervention:true,evidence});
  const eligibleAt=prior?Math.max(time(prior.requestedAt)+cooldownMs,pending?time(prior.deadlineAt):0):now;
  if(prior&&now<eligibleAt)return none(pending?'oversight_in_progress':'oversight_cooldown',{incidentFingerprint:fingerprint,level:count,nextEligibleAt:iso(eligibleAt),evidence});
  return {decision:count?'escalate':'audit',reasonCode,incidentFingerprint:fingerprint,level:count+1,preserveProductExecution:true,evidence,nextEligibleAt:iso(now)};
}

// Call on dispatch, and again on completion without incrementing count. An
// exhausted incident stays visibly unresolved; it is never reported recovered.
export function recordSupervisorOversight(observation,decision,{at,status='requested',deadlineAt=null,failureIdentity=null}={}){
  const now=clock(at),result=clone(observation),key=decision.incidentFingerprint;
  if(!key||!['audit','escalate'].includes(decision.decision)||!['requested','completed','failed'].includes(status))throw Error('Record a concrete supervisor oversight decision');
  result.oversight??={};const previous=result.oversight[key];
  if(status!=='requested'&&!previous)throw Error('Oversight completion has no recorded dispatch');
  const duplicate=status==='requested'&&previous&&decision.level<=previous.count;
  if(duplicate)return result;
  const failureIds=[...(previous?.failureIds??[])];
  if(status==='failed'&&failureIdentity?.sha256&&!failureIds.includes(failureIdentity.sha256))failureIds.push(failureIdentity.sha256);
  result.oversight[key]={count:status==='requested'?(previous?.count??0)+1:previous.count,failureCount:failureIds.length,failureIds,status,requestedAt:status==='requested'?iso(now):previous.requestedAt,deadlineAt:status==='requested'?deadlineAt===null?null:iso(clock(deadlineAt)):previous.deadlineAt,reasonCode:decision.reasonCode,...(status!=='requested'?{completedAt:iso(now)}:{})};
  const entries=Object.entries(result.oversight).sort(([,a],[,b])=>time(b.requestedAt)-time(a.requestedAt));result.oversight=Object.fromEntries(entries.slice(0,32));return result;
}
