import {test,expect} from 'vitest';
import {observeProductProgress,evaluateSupervisorOversight,recordGuardianAudit,recordSupervisorOversight} from './supervisor-oversight-policy.mjs';

const start=Date.parse('2026-10-15T10:00:00.000Z'),stamp=offset=>new Date(start+offset).toISOString();
const state=()=>({runId:'fixture-run',status:'running',createdAt:stamp(0),review:'A',phase:'execution_failure',currentTasks:['15-03'],tasks:{'15-03':{status:'blocked',attempt:2}},activeTurns:{},activeOperations:{},guardian:{},pendingExecutionIncident:{path:'incidents/current.json',sha256:'incident-pin',byteLength:100}});
const evaluate=(s,o,offset,config={})=>evaluateSupervisorOversight(s,config,o,start+offset);
const observe=(s,o,offset)=>observeProductProgress(s,o,start+offset);
const freeze=value=>{if(value&&typeof value==='object'){Object.freeze(value);for(const item of Object.values(value))freeze(item);}return value;};

test('verified maintenance resets only the audit budget once while preserving the stalled product clock',()=>{
  const s=state();let observation=observe(s,null,300000),decision=evaluate(s,observation,300000);
  observation=recordSupervisorOversight(observation,decision,{at:start+300000,deadlineAt:start+301000});const productTime=observation.lastProductProgressAt;
  s.operatingMaintenance={acceptedReceiptSha:'verified-source-and-test-receipt'};observation=observe(s,observation,310000);
  expect(observation.oversight).toEqual({});expect(observation.lastProductProgressAt).toBe(productTime);expect(observation.productProgressed).toBe(false);
  decision=evaluate(s,observation,310000);observation=recordSupervisorOversight(observation,decision,{at:start+310000,deadlineAt:start+400000});
  expect(observe(s,observation,311000).oversight).toEqual(observation.oversight);
});

test('03 fixture: a bounded guardian repair keeps the product clock honest and protects its own execution deadline',()=>{
  const s=state();let observation=observe(s,null,0);
  s.phase='operating_repair';s.activeRole='guardian-repair';s.activeTurns['guardian-repair']={threadId:'operating-thread',turnId:'operating-turn',taskId:'15-03',startedAt:stamp(1000),deadlineAt:stamp(3600000),lastToolActivityAt:stamp(300000)};
  s.heartbeatAt=stamp(300000);s.updatedAt=stamp(300000);s.lastToolActivityAt=stamp(300000);
  observation=observe(s,observation,300000);
  expect(observation.lastProductProgressAt).toBe(stamp(0));expect(observation.activeProducts).toEqual([]);
  const decision=evaluate(s,observation,300000);expect(decision.decision).toBe('none');expect(decision.reasonCode).toBe('operating_repair_within_deadline');
  expect(evaluate(s,observation,3630001).reasonCode).toBe('deadline_exceeded');
});

test('three unique guardian audits for the same incident and cause trigger oversight without guardian approval',()=>{
  const s=state();let observation=observe(s,null,0);
  for(let index=1;index<=3;index++){
    s.guardian={lastAuditIdentity:{path:`guardian/audits/${index}/audit-result.json`,sha256:`audit-${index}`},lastDecision:'hold',lastSummary:'Current blocked candidate has no target',lastCheckedAt:stamp(index*10000)};
    observation=observe(s,observation,index*10000);
  }
  expect(observation.lastProductProgressAt).toBe(stamp(0));const decision=evaluate(s,observation,30000);
  expect(decision.decision).toBe('audit');expect(decision.reasonCode).toBe('repeated_guardian_cause');expect(decision.evidence.repeatedAudit.count).toBe(3);
});

test('polling one guardian receipt repeatedly never counts it as multiple audits',()=>{
  const s=state();s.guardian={lastAuditIdentity:{sha256:'one-audit'},lastDecision:'hold',lastSummary:'Same cause',lastCheckedAt:stamp(1000)};
  let observation=observe(s,null,1000);
  for(let index=2;index<=20;index++)observation=observe(s,observation,index*1000);
  expect(Object.values(observation.guardianAudits.groups).map(group=>group.count)).toEqual([1]);expect(evaluate(s,observation,20000).decision).toBe('none');
});

test('stable runtime error groups repeated audits despite changing audit labels and operating prose',()=>{
  const s=state();s.error='Current implementation has no target';let observation=observe(s,null,0);
  for(let index=1;index<=3;index++){
    s.guardian={lastAuditIdentity:{sha256:`audit-${index}`},lastDecision:'hold',lastSummary:`auditId=0000${index}-abcdef12 inspection sequence ${index}`,lastCheckedAt:stamp(index*1000)};
    observation=observe(s,observation,index*1000);
  }
  expect(evaluate(s,observation,3000).reasonCode).toBe('repeated_guardian_cause');
});

test('different incidents or actual causes are not merged into a false repeated-cause alarm',()=>{
  const s=state();let observation=observe(s,null,0);
  for(let index=1;index<=3;index++)observation=recordGuardianAudit(observation,{identity:`audit-${index}`,incidentId:index===3?'another-incident':'original',cause:index===2?'another cause':'same cause',at:stamp(index*1000)},start+index*1000);
  expect(Object.values(observation.guardianAudits.groups)).toHaveLength(3);expect(evaluate(s,observation,3000).decision).toBe('none');
});

for(const key of ['implementer-0','verifier-0','vitest-review-verifier','test-preparer-15-03'])test(`normal long product execution remains protected until its configured deadline: ${key}`,()=>{
  const s=state();s.activeTurns[key]={threadId:'product-thread',turnId:'exact-turn',taskId:'15-03',startedAt:stamp(0),lastActivityAt:stamp(700000)};
  const observation=observe(s,null,700000),config={turnTimeoutMs:3600000};
  expect(observation.activeProducts).toHaveLength(1);expect(evaluate(s,observation,700000,config).reasonCode).toBe('product_execution_within_deadline');
  const expired=evaluate(s,observation,3600000,config);expect(expired.decision).toBe('audit');expect(expired.reasonCode).toBe('deadline_exceeded');
});

test('product and operating validation keep separate clocks and both respect their bounded deadlines',()=>{
  const s=state();s.activeOperations['15-03']={kind:'vitest',taskId:'15-03',pid:100,startedAt:stamp(0),deadlineAt:stamp(1200000)};
  s.activeOperation={...s.activeOperations['15-03']};let observation=observe(s,null,600000);
  expect(observation.activeProducts).toHaveLength(1);expect(evaluate(s,observation,600000).decision).toBe('none');expect(evaluate(s,observation,1200000).reasonCode).toBe('deadline_exceeded');
  delete s.activeOperation;delete s.activeOperations['15-03'];s.activeOperations['guardian-input-validation']={kind:'operating-input-validation',pid:101,startedAt:stamp(600000),deadlineAt:stamp(1800000)};
  observation=observe(s,observation,610000);expect(observation.lastProductProgressAt).toBe(stamp(0));expect(evaluate(s,observation,610000).reasonCode).toBe('operating_repair_within_deadline');
});

test('an unconfirmed native dispatch cannot masquerade as a long running product turn',()=>{
  const s=state();s.activeTurns['implementer-0']={threadId:'draft-only',startedAt:stamp(0),lastActivityAt:stamp(600000)};
  const observation=observe(s,null,600000),decision=evaluate(s,observation,600000,{turnTimeoutMs:3600000});
  expect(decision.reasonCode).toBe('product_execution_gap');expect(decision.decision).toBe('audit');
});

test('a real product tool event or confirmed result advances the clock; status and phase changes alone do not',()=>{
  const s=state();let observation=observe(s,null,0);
  s.tasks['15-03'].status='implemented';s.phase='task_test';s.round=100;s.recoveryAttempts=500;observation=observe(s,observation,200000);expect(observation.lastProductProgressAt).toBe(stamp(0));
  s.activeTurns['implementer-0']={threadId:'product',turnId:'turn',startedAt:stamp(200000),lastToolActivityAt:stamp(250000)};observation=observe(s,observation,250000);expect(observation.lastProductProgressAt).toBe(stamp(250000));
  delete s.activeTurns['implementer-0'];observation=observe(s,observation,260000);expect(observation.lastProductProgressAt).toBe(stamp(250000));
  s.tasks['15-03'].implementation={responseIdentity:{sha256:'actual-confirmed-response',path:'implementation/response.json'}};observation=observe(s,observation,270000);expect(observation.lastProductProgressAt).toBe(stamp(270000));
  s.tasks['15-03'].verification='current-attempt/verification/verdict.json';observation=observe(s,observation,280000);expect(observation.lastProductProgressAt).toBe(stamp(280000));
});

test('migration derives old product time instead of treating fresh heartbeat/operating tools as fresh product work',()=>{
  const s=state();s.heartbeatAt=stamp(3600000);s.updatedAt=stamp(3600000);s.progressAt=stamp(3600000);s.lastToolActivityAt=stamp(3600000);
  s.tasks['15-03'].passedAt=stamp(1000);s.tasks['15-03'].acceptedTarget={targetId:'old-target'};
  s.activeTurns['guardian-repair']={threadId:'repair',turnId:'repair-turn',startedAt:stamp(3500000),lastToolActivityAt:stamp(3600000)};
  const observation=observe(s,null,3600000);expect(observation.lastProductProgressAt).toBe(stamp(1000));expect(evaluate(s,observation,3600000).decision).toBe('audit');
});

test('a completely undated legacy state receives one migration window which heartbeat cannot renew',()=>{
  const s=state();delete s.createdAt;let observation=observe(s,null,1000);expect(observation.lastProductProgressAt).toBe(stamp(1000));
  s.heartbeatAt=stamp(301000);observation=observe(s,observation,301000);expect(evaluate(s,observation,301000).decision).toBe('audit');
});

for(const mode of ['stopped','stopping','standby','approval','authentication'])test(`actual user stop or external waiting is excluded: ${mode}`,()=>{
  const s=state();if(['approval','authentication'].includes(mode)){s.status='waiting_input';s.requiredUserInput={kind:mode};}else s.status=mode;
  const observation=observe(s,null,3600000);expect(evaluate(s,observation,3600000).decision).toBe('none');
});

test('a generic operating hold is not misclassified as an external approval wait',()=>{
  const s=state();s.status='waiting_input';s.requiredUserInput={kind:'operating_handoff'};s.error='Guardian hold: inconsistent current target';
  expect(evaluate(s,observe(s,null,600000),600000).decision).toBe('audit');
});

test('oversight requests retain stable identity and cooldown without counting completed audits as failures',()=>{
  const s=state();let observation=observe(s,null,300000),decision=evaluate(s,observation,300000);const fingerprint=decision.incidentFingerprint;
  observation=recordSupervisorOversight(observation,decision,{at:start+300000,status:'requested',deadlineAt:start+330000});
  const snapshot=structuredClone(observation);observation=recordSupervisorOversight(observation,decision,{at:start+310000,status:'requested',deadlineAt:start+999999});expect(observation).toEqual(snapshot);
  s.heartbeatAt=stamp(310000);s.phase='operating_repair';observation=observe(s,observation,310000);
  expect(evaluate(s,observation,310000).incidentFingerprint).toBe(fingerprint);expect(evaluate(s,observation,310000).reasonCode).toBe('oversight_in_progress');
  observation=recordSupervisorOversight(observation,decision,{at:start+320000,status:'completed'});expect(evaluate(s,observation,320000).reasonCode).toBe('oversight_cooldown');
  for(const offset of [360000,420000]){
    decision=evaluate(s,observation,offset);expect(decision.decision).toBe('escalate');expect(decision.incidentFingerprint).toBe(fingerprint);
    observation=recordSupervisorOversight(observation,decision,{at:start+offset});observation=recordSupervisorOversight(observation,decision,{at:start+offset+1,status:'completed'});
  }
  expect(evaluate(s,observation,480000).decision).toBe('escalate');expect(observation.oversight[fingerprint].failureCount).toBe(0);
  s.tasks['15-03'].implementation={responseIdentity:{sha256:'real-new-product-work'}};observation=observe(s,observation,490000);expect(evaluate(s,observation,490000).reasonCode).toBe('product_progress_recent');
});

test('the third pending audit is allowed to finish; only unique proven failures consume the failure budget',()=>{
  const s=state();let observation=observe(s,null,300000),decision;
  for(const [index,offset]of [300000,360000,420000].entries()){
    decision=evaluate(s,observation,offset);
    observation=recordSupervisorOversight(observation,decision,{at:start+offset,deadlineAt:start+offset+30000});
    expect(evaluate(s,observation,offset+1000).reasonCode).toBe('oversight_in_progress');
    observation=recordSupervisorOversight(observation,decision,{at:start+offset+2000,status:'failed',failureIdentity:{sha256:`actual-failure-${index}`}});
    const once=structuredClone(observation);
    observation=recordSupervisorOversight(observation,decision,{at:start+offset+2000,status:'failed',failureIdentity:{sha256:`actual-failure-${index}`}});
    expect(observation).toEqual(once);
  }
  const exhausted=evaluate(s,observation,480000);expect(exhausted.reasonCode).toBe('escalation_exhausted');expect(exhausted.exhausted).toBe(true);
  expect(observation.oversight[decision.incidentFingerprint].failureCount).toBe(3);
});

test('an oversight worker exceeding its recorded deadline can escalate even if its audit never completed',()=>{
  const s=state();let observation=observe(s,null,300000);const first=evaluate(s,observation,300000);
  observation=recordSupervisorOversight(observation,first,{at:start+300000,deadlineAt:start+420000});expect(evaluate(s,observation,400000).reasonCode).toBe('oversight_in_progress');
  expect(evaluate(s,observation,420000).decision).toBe('escalate');
});

test('fresh product work retires repeated-audit history for the previous product generation',()=>{
  const s=state();let observation=observe(s,null,0);
  for(let index=1;index<=3;index++)observation=recordGuardianAudit(observation,{identity:`audit-${index}`,incidentId:'same-incident',cause:'same-cause',at:stamp(index*1000)},start+index*1000);
  expect(evaluate(s,observation,3000).reasonCode).toBe('repeated_guardian_cause');
  s.tasks['15-03'].implementation={responseIdentity:{sha256:'new-work'}};observation=observe(s,observation,3000);
  expect(evaluate(s,observation,3000).reasonCode).toBe('product_progress_recent');
});

test('deadline incident identity is stable despite further tool timestamps and detects operating deadlines too',()=>{
  const s=state();s.activeTurns['guardian-repair']={threadId:'repair',turnId:'one-turn',startedAt:stamp(0),deadlineAt:stamp(1000),lastToolActivityAt:stamp(500)};
  let observation=observe(s,null,1000);const first=evaluate(s,observation,1000);expect(first.reasonCode).toBe('deadline_exceeded');
  s.activeTurns['guardian-repair'].lastToolActivityAt=stamp(2000);observation=observe(s,observation,2000);
  expect(evaluate(s,observation,2000).incidentFingerprint).toBe(first.incidentFingerprint);
});

test('all policy calls leave frozen inputs untouched and need no wall-clock or filesystem behavior',()=>{
  const s=freeze(state()),observation=freeze(observe(s,null,300000)),config=freeze({turnTimeoutMs:3600000});
  const decision=freeze(evaluate(s,observation,300000,config));expect(()=>recordSupervisorOversight(observation,decision,{at:start+300000})).not.toThrow();
  expect(()=>recordGuardianAudit(observation,{identity:'audit',incidentId:'incident',cause:'cause'},start+300000)).not.toThrow();expect(()=>observe(s,observation,301000)).not.toThrow();
  expect(observation.oversight).toEqual({});expect(observation.guardianAudits.seen).toEqual([]);
});

test('an explicit resume resets only the audit budget and never fabricates product progress',()=>{
 const s=state();let observation=observe(s,null,300000),decision=evaluate(s,observation,300000);
 observation=recordSupervisorOversight(observation,decision,{at:start+300000,deadlineAt:start+301000});
 const productTime=observation.lastProductProgressAt;
 s.explicitResume={receiptIdentity:{sha256:'validated-user-retry'},requestedAt:stamp(310000)};
 observation=observe(s,observation,310000);
 expect(observation.oversight).toEqual({});expect(observation.lastProductProgressAt).toBe(productTime);expect(observation.productProgressed).toBe(false);
 const again=evaluate(s,observation,310000);expect(again.decision).toBe('audit');expect(again.level).toBe(1);
 observation=recordSupervisorOversight(observation,again,{at:start+310000,deadlineAt:start+400000});
 expect(observe(s,observation,311000).oversight).toEqual(observation.oversight);
});

for(const generation of ['resume','maintenance'])test(`historic operating failure receipts cannot consume a fresh ${generation} budget`,()=>{
  const s=state();
  if(generation==='resume')s.explicitResume={receiptIdentity:{sha256:'old-generation'}};
  else s.operatingMaintenance={acceptedReceiptSha:'old-generation'};
  let observation=observe(s,null,300000),decision=evaluate(s,observation,300000);
  observation=recordSupervisorOversight(observation,decision,{at:start+300000,deadlineAt:start+330000});
  s.supervisorOversight={operatingFailures:[{incidentFingerprint:decision.incidentFingerprint,identity:{sha256:'actual-historical-failure'},resumeIdentity:generation==='resume'?'old-generation':null,maintenanceIdentity:generation==='maintenance'?'old-generation':null}]};
  observation=observe(s,observation,310000);expect(observation.oversight[decision.incidentFingerprint].failureCount).toBe(1);
  if(generation==='resume')s.explicitResume.receiptIdentity.sha256='new-generation';else s.operatingMaintenance.acceptedReceiptSha='new-generation';
  observation=observe(s,observation,340000);decision=evaluate(s,observation,340000);
  observation=recordSupervisorOversight(observation,decision,{at:start+340000,deadlineAt:start+400000});
  observation=observe(s,observation,350000);expect(observation.oversight[decision.incidentFingerprint].failureCount).toBe(0);
});
