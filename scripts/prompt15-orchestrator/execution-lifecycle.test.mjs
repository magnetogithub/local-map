import {test,expect} from 'vitest';
import {beginOperation,endOperation,productActive,protectedActivity,repairProtected,auditRequestState,auditWatchdogTimeout} from './execution-lifecycle.mjs';
import {stalledController} from './operating-recovery.mjs';
import {observeProductProgress,evaluateSupervisorOversight} from './supervisor-oversight-policy.mjs';

const at=Date.parse('2026-10-15T12:00:00Z');
const config={taskVerificationMode:'controller-vitest',automaticRecovery:true,controllerProgressTimeoutMs:300000};
const state=()=>({status:'running',tasks:{},activeTurns:{},activeOperations:{},guardian:{},heartbeatAt:new Date(at-600000).toISOString(),progressAt:new Date(at-600000).toISOString()});
const request={id:'oversight-old',deadlineAt:new Date(at-60000).toISOString(),decision:{reasonCode:'product_execution_gap',evidence:{lastProductProgressAt:new Date(at-900000).toISOString()}}};

test('the recorded incident can end while final response hashing remains protected through a real bounded handoff',()=>{
  const s=state(),operation=beginOperation(s,'review-A','product-handoff','response-validation',600000,at);
  s.supervisorOversight={activeAuditId:request.id,deadlineAt:request.deadlineAt};
  expect(productActive(s)).toBe(true);expect(protectedActivity(s,at)).toBe(true);
  expect(auditWatchdogTimeout(s,{},request,at)).toBeNull();expect(stalledController(s,config,at)).toBeNull();
  expect(auditWatchdogTimeout(s,{},request,at+631000)).toMatch(/exceeded/);
  s.activeOperation=operation;endOperation(s,'review-A',operation.id);expect(productActive(s)).toBe(false);expect(s.activeOperation).toBeUndefined();
});

test('renewed product work supersedes a queued no-progress audit without claiming its model decision',()=>{
  const s=state(),observation={lastProductProgressAt:new Date(at-1000).toISOString()};
  s.supervisorOversight={activeAuditId:request.id,deadlineAt:request.deadlineAt};
  expect(auditRequestState(s,observation,request)).toBe('superseded');expect(auditWatchdogTimeout(s,observation,request,at)).toBeNull();
  expect(auditRequestState(s,observation,{...request,decision:{reasonCode:'deadline_exceeded'}})).toBe('pending');
  expect(auditWatchdogTimeout(s,observation,{...request,decision:{reasonCode:'deadline_exceeded'}},at)).toMatch(/exceeded/);
});

test('guardian-owned repairs are protected without a supervisor pendingRepairIdentity, and protection expires',()=>{
  const s=state();beginOperation(s,'repair','operating-repair','regressions',600000,at);
  expect(repairProtected(s,at)).toBe(true);expect(auditWatchdogTimeout(s,{},request,at)).toBeNull();
  const observation=observeProductProgress(s,null,at);
  expect(evaluateSupervisorOversight(s,config,observation,at).reasonCode).toBe('operating_repair_within_deadline');
  expect(repairProtected(s,at+631000)).toBe(false);
});

test('controller phase changes protect work without inventing product progress',()=>{
  const s=state();let observation=observeProductProgress(s,null,at);const before=observation.lastProductProgressAt;
  beginOperation(s,'handoff','product-handoff','input-hashing',600000,at+1000);
  observation=observeProductProgress(s,observation,at+1000);
  expect(observation.productProgressed).toBe(false);expect(observation.lastProductProgressAt).toBe(before);
  s.productResponses={review:{identity:{sha256:'confirmed-response'},completedAt:new Date(at+2000).toISOString()}};
  observation=observeProductProgress(s,observation,at+2000);
  expect(observation.productProgressed).toBe(true);expect(observation.lastProductProgressAt).toBe(new Date(at+2000).toISOString());
});

test('finishing an older operation cannot release a newer owner',()=>{
  const s=state(),old=beginOperation(s,'handoff','product-handoff','old',1000,at),current=beginOperation(s,'handoff','product-handoff','new',1000,at);
  endOperation(s,'handoff',old.id);expect(s.activeOperations.handoff.id).toBe(current.id);
});

test('a never dispatched audit does not consume native watchdog replacements; admission starts its own deadline',()=>{
  const s=state();s.status='waiting_execution';
  expect(auditWatchdogTimeout(s,{},request,at)).toBeNull();
  s.supervisorOversight={activeAuditId:'another-audit',deadlineAt:request.deadlineAt};
  expect(auditWatchdogTimeout(s,{},request,at)).toBeNull();
  s.supervisorOversight={activeAuditId:request.id,deadlineAt:new Date(at+180000).toISOString()};
  expect(auditWatchdogTimeout(s,{},request,at)).toBeNull();
  expect(auditWatchdogTimeout(s,{},request,at+211000)).toMatch(/exceeded/);
});
