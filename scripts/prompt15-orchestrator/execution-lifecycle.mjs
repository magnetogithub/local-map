import {randomUUID} from 'node:crypto';

const productKinds=new Set(['vitest','product-handoff','product-input-validation']);
const controlKinds=new Set(['operating-repair','operating-input-validation']);
const terminal=new Set(['completed','failed','interrupted','cancelled','canceled']);
const live=value=>value&&value.active!==false&&!terminal.has(value.status);
const operations=state=>[...Object.values(state.activeOperations??{}),...(state.activeOperation?[state.activeOperation]:[])];
export const productTurn=(key,value)=>live(value)&&(/^(implementer-|verifier-|vitest-review-verifier|test-preparer-)/.test(key)||(key==='supervisor'&&!value.operatingAuditId));
export const productOperation=value=>live(value)&&productKinds.has(value.kind);
export function productActive(state){
  return Object.entries(state.activeTurns??{}).some(([key,value])=>productTurn(key,value))||operations(state).some(productOperation);
}
export function beginOperation(state,key,kind,phase,timeoutMs,now=Date.now()){
  if(!Number.isFinite(timeoutMs)||timeoutMs<=0)throw Error('Execution operation needs a finite deadline');
  const value={id:randomUUID(),kind,phase,pid:process.pid,startedAt:new Date(now).toISOString(),deadlineAt:new Date(now+timeoutMs).toISOString()};
  state.activeOperations??={};state.activeOperations[key]=value;return value;
}
export function endOperation(state,key,id){
  if(state.activeOperations?.[key]?.id===id)delete state.activeOperations[key];
  if(state.activeOperation?.id===id){state.activeOperation=Object.values(state.activeOperations??{})[0];if(!state.activeOperation)delete state.activeOperation;}
}
export function protectedActivity(state,now=Date.now()){
  const bounded=value=>live(value)&&Number.isFinite(Date.parse(value.deadlineAt))&&now<=Date.parse(value.deadlineAt)+30000;
  return operations(state).some(value=>(productKinds.has(value.kind)||controlKinds.has(value.kind))&&bounded(value))
    ||Object.entries(state.activeTurns??{}).some(([key,value])=>(productTurn(key,value)||key==='guardian-repair')&&value.turnId&&bounded(value));
}
export function repairProtected(state,now=Date.now()){
  return Boolean(operations(state).some(value=>controlKinds.has(value.kind)&&live(value)&&now<Date.parse(value.deadlineAt))
    ||live(state.activeTurns?.['guardian-repair'])&&now<Date.parse(state.activeTurns['guardian-repair'].deadlineAt));
}
export function auditRequestState(state,observation,request){
  if(!request)return 'absent';
  if(state.supervisorOversight?.handledRequestId===request.id||state.supervisorOversight?.retiredRequests?.some(row=>row.id===request.id))return 'handled';
  if(['product_execution_gap','repeated_guardian_cause'].includes(request.decision?.reasonCode)
    &&Date.parse(observation?.lastProductProgressAt)>Date.parse(request.decision?.evidence?.lastProductProgressAt))return 'superseded';
  return 'pending';
}
export function auditWatchdogTimeout(state,observation,request,now=Date.now()){
  if(auditRequestState(state,observation,request)!=='pending'||protectedActivity(state,now))return null;
  // Mailbox age is not native execution. A queued request is admitted by the
  // controller recovery loop; only an actually started audit owns this deadline.
  if(state.supervisorOversight?.activeAuditId!==request.id)return null;
  const deadline=state.supervisorOversight.deadlineAt;
  return Number.isFinite(Date.parse(deadline))&&now>Date.parse(deadline)+30000
    ?'Supervisor operating audit exceeded its deadline; reconcile its exact native receipt in a fresh controller':null;
}
