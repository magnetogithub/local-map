import fs from 'node:fs';
import path from 'node:path';
import {test,expect,onTestFinished} from 'vitest';
import {SupervisorOversight,OVERSIGHT_SCHEMA,validateSupervisorRepairAuthority,guardianRepairReplayAllowed,drainSupervisorAudit} from './supervisor-oversight.mjs';
import {GuardianControllerRepair} from './guardian-repair.mjs';
import {TaskWorkflow} from './task-workflow.mjs';
import {atomicJSON,fileIdentity} from './protocol.mjs';
import {digest} from './product-target.mjs';

const read=file=>JSON.parse(fs.readFileSync(file,'utf8'));

test('a dedicated repair reserves audit admission before dispatch and throughout its handoff',async()=>{
  const f=fixture();f.w.controllerRepair.busy=true;
  await f.oversight.poll();expect(f.w.turnCalls).toBe(0);
  f.w.controllerRepair.busy=false;f.state.guardian.activeRepairId='repair-owned';
  await f.oversight.poll();expect(f.w.turnCalls).toBe(0);
  delete f.state.guardian.activeRepairId;await f.oversight.poll();expect(f.w.turnCalls).toBe(1);
});

test('the actual audit dispatcher admits an unresolved certified internal BLOCKED handoff',async()=>{
  const f=fixture({action:'continue'}),pin={path:'fixture-binding',sha256:'a'.repeat(64),byteLength:1},row=f.state.tasks['15-03'];
  f.state.status='blocked';row.workspace={directory:'candidate'};row.implementation={responseIdentity:pin};row.blockedProductHandoff={status:'blocked',handoff:pin,decision:pin};
  f.state.productBlockedHandoff={taskId:'15-03',candidateRoot:'candidate',response:pin,handoff:pin,decision:pin,executionIncident:null};
  await f.oversight.poll();expect(f.w.turnCalls).toBe(1);expect(f.state.tasks['15-03'].status).toBe('blocked');
});

test('transport drain seals audit admission even when the monitor was initially idle',async()=>{
  const f=fixture();f.w.oversight=f.oversight;await drainSupervisorAudit(f.w);await f.oversight.poll();
  expect(f.oversight.closing).toBe(true);expect(f.w.turnCalls).toBe(0);
});

test('a lost audit start acknowledgement preserves the request without inventing a completed decision',async()=>{
  const f=fixture({failFirst:true});await expect(f.oversight.poll()).rejects.toThrow('explicit deadline');
  const file=path.resolve(f.root,f.state.supervisorOversight.interruptedAuditDispatchIdentity.path),dispatch=read(file);delete dispatch.turnId;atomicJSON(file,dispatch);
  const pin=fileIdentity(f.root,file);f.state.supervisorOversight.interruptedAuditDispatchIdentity=pin;
  f.native.set('supervisor-fixed',[{id:'old-completed-turn',status:'completed'}]);
  await f.oversight.reconcileInterruptedAudit();
  const receipt=read(path.resolve(f.root,f.state.supervisorOversight.lastNativeReconciliation.path));
  expect(receipt).toMatchObject({dispatchIdentity:pin,turnId:null,status:'no-active-native-turn',accepted:false,unconfirmedRequest:true});
  expect(fileIdentity(f.root,file)).toEqual(pin);expect(f.w.turnCalls).toBe(1);expect(f.state.tasks['15-03'].status).toBe('blocked');
});

test('a lost audit acknowledgement cannot discard an unrelated active native turn',async()=>{
  const f=fixture({failFirst:true});await expect(f.oversight.poll()).rejects.toThrow('explicit deadline');
  const file=path.resolve(f.root,f.state.supervisorOversight.interruptedAuditDispatchIdentity.path),dispatch=read(file);delete dispatch.turnId;atomicJSON(file,dispatch);
  const pin=fileIdentity(f.root,file);f.state.supervisorOversight.interruptedAuditDispatchIdentity=pin;
  f.native.set('supervisor-fixed',[{id:'unrelated-active',status:'inProgress'}]);
  await expect(f.oversight.reconcileInterruptedAudit()).rejects.toThrow('active native work');
  expect(f.state.supervisorOversight.interruptedAuditDispatchIdentity).toEqual(pin);expect(f.nativeCalls.filter(c=>c.method==='turn/interrupt')).toHaveLength(0);
});

test('a lost audit acknowledgement can reconcile only the unique exact original native request',async()=>{
  const f=fixture({failFirst:true});await expect(f.oversight.poll()).rejects.toThrow('explicit deadline');
  const file=path.resolve(f.root,f.state.supervisorOversight.interruptedAuditDispatchIdentity.path),dispatch=read(file);delete dispatch.turnId;atomicJSON(file,dispatch);
  const pin=fileIdentity(f.root,file),request=read(path.resolve(f.root,dispatch.requestIdentity.path));f.state.supervisorOversight.interruptedAuditDispatchIdentity=pin;
  f.native.set('supervisor-fixed',[{id:'owned-but-ack-lost',status:'inProgress',items:[{type:'userMessage',content:[{type:'text',text:request.prompt}]}]}]);
  await f.oversight.reconcileInterruptedAudit();
  expect(f.nativeCalls.filter(c=>c.method==='turn/interrupt')).toEqual([{method:'turn/interrupt',params:{threadId:'supervisor-fixed',turnId:'owned-but-ack-lost'}}]);
  expect(read(path.resolve(f.root,f.state.supervisorOversight.lastNativeReconciliation.path))).toMatchObject({turnId:'owned-but-ack-lost',status:'interrupted',accepted:false});expect(fileIdentity(f.root,file)).toEqual(pin);
});

function fixture(options={}){
  const base=path.resolve('.tmp/supervisor-oversight-tests');fs.mkdirSync(base,{recursive:true});
  const root=fs.mkdtempSync(path.join(base,'case-')),directory=path.join(root,'reports/run');fs.mkdirSync(directory,{recursive:true});
  onTestFinished(()=>{expect(root.startsWith(base+path.sep)).toBe(true);fs.rmSync(root,{recursive:true,force:true});});
  const state={runId:'run-test',status:'running',review:'A',threads:{supervisor:'supervisor-fixed',guardian:'guardian-fixed'},guardian:{threadId:'guardian-fixed',lastDecision:'hold',activeAuditId:'old-guardian-hold'},tasks:{'15-03':{status:'blocked',attempt:2}},currentTasks:['15-03'],activeTurns:{},activeOperations:{}};
  const native=new Map(),nativeCalls=[],events=[];
  let interrupted=false;
  const server={
    on(){},off(){},
    async request(method,params){
      nativeCalls.push({method,params:structuredClone(params)});
      if(method==='thread/resume')return {thread:{id:params.threadId}};
      if(method==='thread/read')return{thread:{id:params.threadId,turns:structuredClone(native.get(params.threadId)??[])}};
      if(method==='turn/interrupt'){
        const turn=native.get(params.threadId)?.find(row=>row.id===params.turnId);if(!turn)throw Error('Unknown exact native turn');
        turn.status='interrupted';interrupted=true;return{};
      }
      throw Error('Unexpected native request: '+method);
    },
  };
  const w={root,directory,state,server,config:{taskVerificationMode:'controller-vitest',supervisorOversight:{enabled:true,auditTimeoutMs:1000,boundEvidence:options.boundEvidence??false}},stopped:false,notificationsAttached:true,onNotification(){},save(){},event(kind,value){events.push({kind,...value});},guardian:{inspecting:false},turnCalls:0,repairCalls:[],reconcileCalls:0};
  const evidenceFile=path.join(directory,'original-incident.json');atomicJSON(evidenceFile,{reason:'old operating hold repeated; product blocked',productPass:false});
  w.controllerRepair={async reconcilePending(){w.reconcileCalls++;return null;},async repair(args){w.repairCalls.push(args);return{status:options.repairBlocked?'blocked':'applied',summary:'operating regression checks complete'};}};
  w.turn=async(role,key,cwd,report,prompt,schema,context,execution)=>{
    w.turnCalls++;expect(role).toBe('supervisor');expect(key).toBe('supervisor');
    if(options.boundEvidence){expect(schema.properties.evidencePaths.items.enum.length).toBeGreaterThan(0);const base=structuredClone(schema);delete base.properties.evidencePaths.items.enum;expect(base).toEqual(OVERSIGHT_SCHEMA);}
    else expect(schema).toBe(OVERSIGHT_SCHEMA);
    expect(context.operatingAuditId).toMatch(/^oversight-/);expect(execution.turnTimeoutMs).toBe(1000);
    expect(prompt).toContain('No guardian approval is required');
    fs.mkdirSync(report,{recursive:true});
    const requestFile=path.join(report,'request.json');atomicJSON(requestFile,{role,key,cwd,prompt,schemaDigest:digest(schema),...context});
    const requestIdentity=fileIdentity(root,requestFile),turnId=`supervisor-audit-turn-${w.turnCalls}`;
    atomicJSON(path.join(report,'dispatch.json'),{threadId:state.threads.supervisor,turnId,requestIdentity,cwd});
    if(options.failFirst&&w.turnCalls===1){native.set(state.threads.supervisor,[{id:turnId,status:'inProgress'}]);throw Error('Audit exceeded its explicit deadline');}
    if(options.gate)await options.gate;
    const result={action:options.action??'repair_controller',summary:'Independent supervisor confirmed an operating incident',reason:'repair the operating ownership deadlock',evidencePaths:options.chooseEvidence?options.chooseEvidence(schema.properties.evidencePaths.items.enum):options.evidencePaths??(schema.properties.evidencePaths.items.enum?[schema.properties.evidencePaths.items.enum[0]]:[evidenceFile])};
    if(options.crashStatus){
      state.activeTurns.supervisor={threadId:state.threads.supervisor,turnId,dispatchFile:path.join(report,'dispatch.json'),operatingAuditId:context.operatingAuditId};
      native.set(state.threads.supervisor,[{id:turnId,status:options.crashStatus,items:[{type:'agentMessage',phase:'final',text:JSON.stringify(result)}]}]);
      options.onCrashWritten?.();await new Promise(()=>{});
    }
    const responseFile=path.join(report,'response.json');atomicJSON(responseFile,{threadId:state.threads.supervisor,turnId,requestIdentity,result});
    return{result,requestIdentity,responseIdentity:fileIdentity(root,responseFile)};
  };
  const oversight=new SupervisorOversight(w),mailbox=path.join(directory,'control/supervisor-audit-request.json');
  function request(id='oversight-test-1'){atomicJSON(mailbox,{version:1,id,runId:state.runId,reason:'same guardian hold three times'});}
  request();
  return{root,directory,w,state,oversight,native,nativeCalls,events,request,evidenceFile,get interrupted(){return interrupted;}};
}

for(const tampered of [false,true])test(`new authenticated product response retires an unstarted stale audit; tampered=${tampered}`,async()=>{
  const f=fixture(),old='2026-10-15T10:00:00.000Z',fingerprint='old-product-gap';
  const mailbox=path.join(f.directory,'control/supervisor-audit-request.json');
  atomicJSON(mailbox,{id:'oversight-old-gap',runId:f.state.runId,decision:{incidentFingerprint:fingerprint,reasonCode:'product_execution_gap',evidence:{lastProductProgressAt:old}}});
  atomicJSON(path.join(f.directory,'control/supervisor-observation.json'),{lastProductProgressAt:old,oversight:{[fingerprint]:{count:3}},guardianAudits:{seen:[],groups:{}}});
  atomicJSON(path.join(f.directory,'control/supervisor-attention.json'),{decision:{incidentFingerprint:fingerprint,exhausted:true,evidence:{lastProductProgressAt:old}}});
  f.state.supervisorOversight={status:'escalation_exhausted',exhaustedIncident:fingerprint,exhaustedAt:old};
  const proof=path.join(f.directory,'confirmed-product-response.json');atomicJSON(proof,{kind:'synthetic control fixture only'});
  f.state.productResponses={review:{identity:fileIdentity(f.root,proof),completedAt:new Date().toISOString()}};
  if(tampered)fs.appendFileSync(proof,'changed');
  if(tampered){await expect(f.oversight.poll()).rejects.toThrow(/changed|mismatch/i);expect(f.state.supervisorOversight.status).toBe('escalation_exhausted');}
  else{await f.oversight.poll();expect(f.state.supervisorOversight.status).toBe('progress_resumed');expect(f.state.supervisorOversight.retiredRequests[0].id).toBe('oversight-old-gap');expect(f.state.supervisorOversight.exhaustionResolutions).toHaveLength(1);}
  expect(f.w.turnCalls).toBe(0);expect(f.state.tasks['15-03'].status).toBe('blocked');
});

test('later timer polls cannot dispatch an audit already retired by another handoff',async()=>{
  const f=fixture();f.state.supervisorOversight={retiredRequests:[{id:'oversight-test-1'}]};
  await f.oversight.poll();await f.oversight.poll();expect(f.w.turnCalls).toBe(0);
});

test('independent supervisor audits an old guardian hold and interrupts only the exact operating turn',async()=>{
  const f=fixture(),tasks=JSON.stringify(f.state.tasks);
  f.state.activeTurns.guardian={threadId:'guardian-fixed',turnId:'guardian-owned-turn',operatingAuditId:'old-guardian-hold'};
  f.native.set('guardian-fixed',[{id:'historical-turn',status:'completed'},{id:'guardian-owned-turn',status:'inProgress'}]);
  f.native.set('another-session',[{id:'unrelated-turn',status:'inProgress'}]);
  await f.oversight.poll();
  expect(f.w.turnCalls).toBe(1);expect(f.state.supervisorOversight.status).toBe('repair_pending');
  expect(f.nativeCalls.filter(call=>call.method==='turn/interrupt')).toEqual([{method:'turn/interrupt',params:{threadId:'guardian-fixed',turnId:'guardian-owned-turn'}}]);
  const interruptIndex=f.nativeCalls.findIndex(call=>call.method==='turn/interrupt');
  expect(f.nativeCalls.slice(interruptIndex+1)).toContainEqual({method:'thread/read',params:{threadId:'guardian-fixed',includeTurns:true}});
  expect(f.native.get('guardian-fixed').find(turn=>turn.id==='guardian-owned-turn').status).toBe('interrupted');
  expect(f.state.activeTurns.guardian).toMatchObject({threadId:'guardian-fixed',turnId:'guardian-owned-turn'});
  expect(f.state.supervisorOversight.confirmedOperatingTurns).toEqual([expect.objectContaining({threadId:'guardian-fixed',turnId:'guardian-owned-turn',status:'interrupted'})]);
  expect(f.native.get('another-session')[0].status).toBe('inProgress');
  const receipt=read(path.resolve(f.root,f.state.supervisorOversight.pendingRepairIdentity.path));
  expect(receipt.authority).toBe('supervisor-oversight');expect(receipt.supervisorThreadId).toBe('supervisor-fixed');
  expect(receipt).not.toHaveProperty('guardianThreadId');expect(JSON.stringify(f.state.tasks)).toBe(tasks);
  expect(()=>validateSupervisorRepairAuthority(f.root,f.state,receipt)).not.toThrow();
});

test('a product turn drains normally and an operating repair waits without interrupting it',async()=>{
  const f=fixture(),tasks=JSON.stringify(f.state.tasks);
  f.state.activeTurns['implementer-15-03']={threadId:'product-thread',turnId:'product-turn',taskId:'15-03'};
  f.state.activeTurns.guardian={threadId:'guardian-fixed',turnId:'guardian-owned-turn'};
  f.native.set('product-thread',[{id:'product-turn',status:'inProgress'}]);f.native.set('guardian-fixed',[{id:'guardian-owned-turn',status:'inProgress'}]);
  await f.oversight.poll();
  expect(f.state.supervisorOversight.pendingRepairIdentity).toBeDefined();
  expect(await f.oversight.applyPendingRepair()).toBe(false);expect(f.w.repairCalls).toHaveLength(0);
  expect(f.nativeCalls.filter(call=>call.method==='turn/interrupt')).toHaveLength(0);
  expect(f.native.get('product-thread')[0].status).toBe('inProgress');expect(JSON.stringify(f.state.tasks)).toBe(tasks);
});

test('controller Vitest operation drains before operating code repair',async()=>{
  const f=fixture();f.state.activeOperations['15-03']={kind:'vitest',deadlineAt:new Date(Date.now()+10000).toISOString()};
  await f.oversight.poll();expect(await f.oversight.applyPendingRepair()).toBe(false);expect(f.w.repairCalls).toHaveLength(0);
  delete f.state.activeOperations['15-03'];
  await expect(f.oversight.applyPendingRepair()).rejects.toMatchObject({code:'OPERATING_REPAIR_APPLIED',guardianHandled:true});
  expect(f.w.repairCalls).toHaveLength(1);expect(f.state.status).toBe('reloading_orchestration');
  expect(f.state.tasks['15-03'].status).toBe('blocked');expect(f.state.supervisorOversight).not.toHaveProperty('pendingRepairIdentity');
});

test('a confirmed audit can interrupt only a product turn whose actual deadline has expired',async()=>{
  const f=fixture();
  const requestFile=path.join(f.directory,'control/supervisor-audit-request.json');
  atomicJSON(requestFile,{...read(requestFile),decision:{reasonCode:'deadline_exceeded'}});
  const dispatch=path.join(f.directory,'original-product-dispatch.json');atomicJSON(dispatch,{threadId:'expired-product',turnId:'expired-exact'});const before=fileIdentity(f.root,dispatch);
  f.state.activeTurns['implementer-15-03']={taskId:'15-03',threadId:'expired-product',turnId:'expired-exact',deadlineAt:new Date(Date.now()-1000).toISOString(),dispatchFile:dispatch};
  f.state.activeTurns['implementer-15-04']={taskId:'15-04',threadId:'healthy-product',turnId:'healthy-exact',deadlineAt:new Date(Date.now()+60000).toISOString()};
  f.native.set('expired-product',[{id:'expired-exact',status:'inProgress'}]);f.native.set('healthy-product',[{id:'healthy-exact',status:'inProgress'}]);
  await f.oversight.poll();
  expect(f.nativeCalls.filter(call=>call.method==='turn/interrupt')).toEqual([{method:'turn/interrupt',params:{threadId:'expired-product',turnId:'expired-exact'}}]);
  expect(f.state.activeTurns['implementer-15-03']).toBeUndefined();expect(f.state.activeTurns['implementer-15-04'].turnId).toBe('healthy-exact');
  expect(f.native.get('healthy-product')[0].status).toBe('inProgress');expect(f.w.oversightReloadRequested).toBe(false);
  expect(fileIdentity(f.root,dispatch)).toEqual(before);expect(await f.oversight.applyPendingRepair()).toBe(false);expect(f.state.tasks['15-03'].status).toBe('blocked');
});

test('a blocked operating repair archives its authority without an infinite cached retry or product PASS',async()=>{
  const f=fixture({repairBlocked:true});await f.oversight.poll();const identity=structuredClone(f.state.supervisorOversight.pendingRepairIdentity),tasks=JSON.stringify(f.state.tasks);
  await expect(f.oversight.applyPendingRepair()).rejects.toThrow('Supervisor operating repair blocked');
  expect(f.state.supervisorOversight.pendingRepairIdentity).toBeUndefined();expect(f.state.supervisorOversight.status).toBe('failed');expect(f.state.supervisorOversight.failedRepairs[0].sourceAudit).toEqual(identity);
  expect(await f.oversight.applyPendingRepair()).toBe(false);expect(f.w.repairCalls).toHaveLength(1);
  expect(f.state.status).toBe('running');expect(JSON.stringify(f.state.tasks)).toBe(tasks);
});

test('a supervisor repair can release only the blocked implementation explicitly cited in its confirmed native audit',async()=>{
  const options={},f=fixture(options),responseFile=path.join(f.directory,'blocked-product-response.json');
  atomicJSON(responseFile,{turnId:'blocked-product-turn',completedAt:new Date(Date.now()-1000).toISOString(),result:{taskId:'15-03',status:'blocked'}});
  const responseIdentity=fileIdentity(f.root,responseFile);f.state.tasks['15-03'].implementation={result:{status:'blocked'},responseIdentity};options.evidencePaths=[responseFile];
  await f.oversight.poll();const sourceAudit=f.state.supervisorOversight.pendingRepairIdentity,audit=read(path.resolve(f.root,sourceAudit.path));
  expect(audit.addressedImplementations).toEqual([{taskId:'15-03',responseIdentity}]);expect(audit.result.recovery.taskId).toBe('15-03');
  const applied=path.join(f.directory,'applied-operating-repair.json');atomicJSON(applied,{status:'applied',sourceAudit,finishedAt:new Date().toISOString()});
  const repair={status:'applied',sourceAudit,receiptIdentity:fileIdentity(f.root,applied)};
  const control={root:f.root,state:f.state};expect(TaskWorkflow.prototype.blockedRepairAddresses.call(control,{id:'15-03'},repair)).toBe(true);
  const other=path.join(f.directory,'other-response.json');atomicJSON(other,{taskId:'15-03',status:'blocked'});f.state.tasks['15-03'].implementation.responseIdentity=fileIdentity(f.root,other);
  expect(TaskWorkflow.prototype.blockedRepairAddresses.call(control,{id:'15-03'},repair)).toBe(false);expect(f.state.tasks['15-03'].status).toBe('blocked');
});

test('duplicate polls have one in-flight native audit and a handled request cannot dispatch it again',async()=>{
  let release;const gate=new Promise(resolve=>{release=resolve;}),f=fixture({gate,action:'continue'});
  const first=f.oversight.poll();await Promise.resolve();await f.oversight.poll();expect(f.w.turnCalls).toBe(1);
  release();await first;await f.oversight.poll();expect(f.w.turnCalls).toBe(1);
  expect(f.state.supervisorOversight.status).toBe('continue');expect(f.state.supervisorOversight).not.toHaveProperty('pendingRepairIdentity');expect(f.w.repairCalls).toHaveLength(0);
});

test('tampering a pinned native response prevents supervisor authority from authorizing repair',async()=>{
  const f=fixture();await f.oversight.poll();const receipt=read(path.resolve(f.root,f.state.supervisorOversight.pendingRepairIdentity.path));
  const responseFile=path.resolve(f.root,receipt.responseIdentity.path);fs.appendFileSync(responseFile,'\n ');
  expect(()=>validateSupervisorRepairAuthority(f.root,f.state,receipt)).toThrow();
  const repairer=new GuardianControllerRepair({root:f.root,directory:f.directory,state:f.state,config:{},server:f.w.server});
  let reachedSafe=false;repairer.checkSafe=()=>{reachedSafe=true;throw Error('authorized-handoff-probe');};
  await expect(repairer.repair({auditIdentity:f.state.supervisorOversight.pendingRepairIdentity,phase:'supervisor_oversight'})).rejects.not.toThrow('authorized-handoff-probe');
  expect(reachedSafe).toBe(false);expect(f.state.tasks['15-03'].status).toBe('blocked');
});

test('a fresh forged receipt cannot substitute a continue native action for repair authority',async()=>{
  const f=fixture({action:'continue'});await f.oversight.poll();
  const audit=read(path.resolve(f.root,f.state.supervisorOversight.lastAuditIdentity.path));
  audit.result={decision:'hold',recovery:{action:'repair_controller',reason:'repair the operating ownership deadlock'}};
  expect(()=>validateSupervisorRepairAuthority(f.root,f.state,audit)).toThrow(/confirmed native response/);
  expect(()=>validateSupervisorRepairAuthority(f.root,{...f.state,threads:{supervisor:'another-supervisor'}},audit)).toThrow(/confirmed supervisor authority/);
});

for(const hold of ['stopped-flag','stop-file','external-input','external-authentication','standby'])test(`a real ${hold} does not dispatch a supervisor audit`,async()=>{
  const f=fixture();
  if(hold==='stopped-flag')f.w.stopped=true;
  if(hold==='stop-file')atomicJSON(path.join(f.directory,'stop.json'),{reason:'explicit user stop'});
  if(hold==='external-input'){f.state.status='waiting_input';f.state.requiredUserInput={taskIds:['15-03'],reason:'approval required'};}
  if(hold==='external-authentication'){f.state.status='waiting_execution';f.state.error='authentication required';}
  if(hold==='standby')f.state.status='standby';
  await f.oversight.poll();expect(f.w.turnCalls).toBe(0);expect(f.w.repairCalls).toHaveLength(0);expect(f.state.supervisorOversight).toBeUndefined();
});

test('an expired audit preserves failure and exact dispatch before native reconciliation and a new audit',async()=>{
  const f=fixture({failFirst:true});
  await expect(f.oversight.poll()).rejects.toThrow('explicit deadline');
  const failureIdentity=f.state.supervisorOversight.lastFailureIdentity,dispatchIdentity=f.state.supervisorOversight.interruptedAuditDispatchIdentity;
  expect(f.state.supervisorOversight.status).toBe('failed');expect(read(path.resolve(f.root,failureIdentity.path)).reason).toContain('explicit deadline');
  const oldDispatch=read(path.resolve(f.root,dispatchIdentity.path));expect(oldDispatch.turnId).toBe('supervisor-audit-turn-1');
  await f.oversight.poll();expect(f.w.turnCalls).toBe(1);
  f.request('oversight-test-2');await f.oversight.poll();
  expect(f.w.turnCalls).toBe(2);
  expect(f.nativeCalls.filter(call=>call.method==='turn/interrupt')).toEqual([{method:'turn/interrupt',params:{threadId:'supervisor-fixed',turnId:'supervisor-audit-turn-1'}}]);
  const reconciliation=read(path.resolve(f.root,f.state.supervisorOversight.lastNativeReconciliation.path));
  expect(reconciliation).toMatchObject({turnId:'supervisor-audit-turn-1',threadId:'supervisor-fixed',status:'interrupted',accepted:false});
  expect(f.state.supervisorOversight).not.toHaveProperty('interruptedAuditDispatchIdentity');
  expect(fileIdentity(f.root,path.resolve(f.root,failureIdentity.path))).toEqual(failureIdentity);
  expect(fileIdentity(f.root,path.resolve(f.root,dispatchIdentity.path))).toEqual(dispatchIdentity);
  expect(f.state.tasks['15-03'].status).toBe('blocked');
});

test('an unknown expired native audit cannot be cleared or replaced by a new audit',async()=>{
  const f=fixture({failFirst:true});await expect(f.oversight.poll()).rejects.toThrow('explicit deadline');
  const oldDispatch=structuredClone(f.state.supervisorOversight.interruptedAuditDispatchIdentity),oldFailure=structuredClone(f.state.supervisorOversight.lastFailureIdentity);
  f.native.set('supervisor-fixed',[{id:'unrelated-supervisor-turn',status:'completed'}]);f.request('oversight-test-2');
  await expect(f.oversight.poll()).rejects.toThrow('has not confirmed termination');
  expect(f.w.turnCalls).toBe(1);expect(f.state.supervisorOversight.interruptedAuditDispatchIdentity).toEqual(oldDispatch);
  expect(fileIdentity(f.root,path.resolve(f.root,oldFailure.path))).toEqual(oldFailure);
  expect(f.nativeCalls.filter(call=>call.method==='turn/interrupt')).toHaveLength(0);expect(f.w.repairCalls).toHaveLength(0);
});

test('the actual repair engine accepts distinct supervisor authority through its single owner lease without guardian approval',async()=>{
  const f=fixture();await f.oversight.poll();const tasks=JSON.stringify(f.state.tasks);
  const repairer=new GuardianControllerRepair({root:f.root,directory:f.directory,state:f.state,config:{},server:f.w.server});
  let authorized=false;
  repairer.checkSafe=()=>{authorized=true;throw Error('authorized-handoff-probe');};
  await expect(repairer.repair({auditIdentity:f.state.supervisorOversight.pendingRepairIdentity,phase:'supervisor_oversight'})).rejects.toThrow('authorized-handoff-probe');
  expect(authorized).toBe(true);expect(fs.existsSync(path.join(f.directory,'control/operating-repair-owner.json'))).toBe(false);
  expect(f.state.guardian.lastDecision).toBe('hold');expect(JSON.stringify(f.state.tasks)).toBe(tasks);
  const lease=path.join(f.directory,'control/operating-repair-owner.json');atomicJSON(lease,{pid:process.pid,startedAt:new Date().toISOString()});
  authorized=false;
  await expect(repairer.repair({auditIdentity:f.state.supervisorOversight.pendingRepairIdentity,phase:'supervisor_oversight'})).rejects.toThrow('live owner');
  expect(authorized).toBe(false);expect(read(lease).pid).toBe(process.pid);
});

async function crashedAudit(status,options={}){
  let entered;const ready=new Promise(resolve=>{entered=resolve;}),f=fixture({...options,crashStatus:status,onCrashWritten:()=>entered(),action:'continue'});
  // A lost host has no JavaScript finally. A new class shares only the durable
  // state and exact native history, while the abandoned promise never resumes.
  f.oversight.poll().catch(()=>{});await ready;
  f.restored=new SupervisorOversight(f.w);return f;
}

test('hard crash: an in-progress operating audit is authenticated and interrupted before its stale owner is cleared',async()=>{
  const f=await crashedAudit('inProgress'),owner=structuredClone(f.state.activeTurns.supervisor),dispatchIdentity=fileIdentity(f.root,owner.dispatchFile),requestIdentity=read(owner.dispatchFile).requestIdentity,tasks=JSON.stringify(f.state.tasks);
  const result=await f.restored.reconcilePendingAudit();expect(result).toMatchObject({status:'interrupted',accepted:false});
  expect(f.state.activeTurns.supervisor).toBeUndefined();expect(f.nativeCalls.filter(call=>call.method==='turn/interrupt')).toEqual([{method:'turn/interrupt',params:{threadId:owner.threadId,turnId:owner.turnId}}]);
  expect(fileIdentity(f.root,owner.dispatchFile)).toEqual(dispatchIdentity);expect(fileIdentity(f.root,path.resolve(f.root,requestIdentity.path))).toEqual(requestIdentity);
  expect(fs.existsSync(path.join(path.dirname(owner.dispatchFile),'response.json'))).toBe(false);expect(f.w.turnCalls).toBe(1);expect(JSON.stringify(f.state.tasks)).toBe(tasks);
  expect(f.state.supervisorOversight.nativeAuditReconciliations).toHaveLength(1);
});

for(const boundEvidence of [false,true])test(`hard crash: a completed native audit is recovered by the actual task turn reconciler with no synthetic decision or new model turn; bound=${boundEvidence}`,async()=>{
  const f=await crashedAudit('completed',{boundEvidence}),owner=structuredClone(f.state.activeTurns.supervisor),originalDispatch=fileIdentity(f.root,owner.dispatchFile);
  f.w.controllerVitest=true;f.w.ensureRunning=()=>{};f.w.config.promptPath='prompt.txt';f.w.config.rulesPath='rules.txt';
  fs.writeFileSync(path.join(f.root,'prompt.txt'),'Immutable product contract');fs.writeFileSync(path.join(f.root,'rules.txt'),'Operating contract');
  f.w.turn=(...args)=>TaskWorkflow.prototype.turnOwned.call(f.w,...args);
  await f.restored.poll();expect(f.state.activeTurns.supervisor).toBeUndefined();expect(f.state.supervisorOversight.status).toBe('continue');
  expect(f.nativeCalls.filter(call=>call.method==='turn/interrupt')).toHaveLength(0);expect(f.w.turnCalls).toBe(1);
  const response=read(path.join(path.dirname(owner.dispatchFile),'response.json'));
  expect(response.turnId).toBe(owner.turnId);expect(response.result.action).toBe('continue');expect(response.reconciliation).toBeDefined();
  expect(fileIdentity(f.root,owner.dispatchFile)).toEqual(originalDispatch);expect(f.state.tasks['15-03'].status).toBe('blocked');
});

test('a crashed nested continuation retains its own dispatch and the original audit receipts',async()=>{
  const f=await crashedAudit('inProgress'),owner=f.state.activeTurns.supervisor,original=owner.dispatchFile,originalPin=fileIdentity(f.root,original),originalRequest=read(path.join(path.dirname(original),'request.json'));
  const continuation=path.join(path.dirname(original),'continuation/continuation'),request=path.join(continuation,'request.json');atomicJSON(request,originalRequest);
  const dispatch=path.join(continuation,'dispatch.json');atomicJSON(dispatch,{...read(original),turnId:'nested-exact-turn',requestIdentity:fileIdentity(f.root,request)});
  Object.assign(owner,{dispatchFile:dispatch,turnId:'nested-exact-turn'});f.native.set(owner.threadId,[{id:owner.turnId,status:'inProgress'}]);const nestedPin=fileIdentity(f.root,dispatch);
  await f.restored.reconcilePendingAudit();expect(f.state.activeTurns.supervisor).toBeUndefined();expect(fileIdentity(f.root,original)).toEqual(originalPin);expect(fileIdentity(f.root,dispatch)).toEqual(nestedPin);
  expect(f.nativeCalls.filter(call=>call.method==='turn/interrupt')[0].params.turnId).toBe('nested-exact-turn');
});

test('the current host never reconciles or interrupts its legitimate in-flight supervisor audit',async()=>{
  const f=await crashedAudit('inProgress');f.w.server.active=new Map([[f.state.threads.supervisor,{turnId:f.state.activeTurns.supervisor.turnId}]]);
  const before=structuredClone(f.state.activeTurns.supervisor);expect(await f.restored.reconcilePendingAudit()).toBe(false);await f.restored.poll();
  expect(f.state.activeTurns.supervisor).toEqual(before);expect(f.nativeCalls).toHaveLength(0);expect(f.w.turnCalls).toBe(1);
  f.w.server.active.clear();delete f.state.activeTurns.supervisor.operatingAuditId;
  expect(await f.restored.reconcilePendingAudit()).toBe(false);expect(f.nativeCalls).toHaveLength(0);
});

for(const changed of ['schema','key','cwd','operating-id','thread','outside-report','native-missing'])test(`a crashed audit with unconfirmed ${changed} ownership cannot be cleared`,async()=>{
  const f=await crashedAudit('inProgress'),owner=f.state.activeTurns.supervisor,dispatch=read(owner.dispatchFile),requestFile=path.join(path.dirname(owner.dispatchFile),'request.json'),request=read(requestFile);
  if(changed==='schema')request.schemaDigest='different-schema';if(changed==='key')request.key='another-role';if(changed==='cwd')request.cwd=path.join(f.root,'another-root');if(changed==='operating-id')request.operatingAuditId='oversight-another';
  if(['schema','key','cwd','operating-id'].includes(changed)){atomicJSON(requestFile,request);atomicJSON(owner.dispatchFile,{...dispatch,requestIdentity:fileIdentity(f.root,requestFile)});}
  if(changed==='thread')owner.threadId='another-thread';
  if(changed==='outside-report')owner.dispatchFile=f.evidenceFile;
  if(changed==='native-missing')f.native.set(owner.threadId,[{id:'unrelated-native-turn',status:'completed'}]);
  const before=structuredClone(owner);await expect(f.restored.reconcilePendingAudit()).rejects.toThrow();expect(f.state.activeTurns.supervisor).toEqual(before);
  expect(f.nativeCalls.filter(call=>call.method==='turn/interrupt')).toHaveLength(0);expect(f.w.turnCalls).toBe(1);
});

test('an unloaded owned native thread is resumed read-only before exact reconciliation',async()=>{
  const f=await crashedAudit('completed'),original=f.w.server.request;let first=true;
  f.w.server.request=async(method,params)=>{if(method==='thread/read'&&first){first=false;throw Error('Thread is not loaded');}return original(method,params);};
  await f.restored.reconcilePendingAudit();expect(f.state.activeTurns.supervisor).toBeUndefined();
  expect(f.nativeCalls).toContainEqual({method:'thread/resume',params:{threadId:'supervisor-fixed',cwd:f.root,sandbox:'read-only'}});
});

for(const repairBlocked of [false,true])test(`fresh startup skips the exact superseded guardian authorization after supervised repair blocked=${repairBlocked}`,async()=>{
  const f=fixture({repairBlocked}),oldFile=path.join(f.directory,'guardian-old-audit.json');atomicJSON(oldFile,{result:{decision:'hold',recovery:{action:'repair_controller'}}});
  const oldIdentity=fileIdentity(f.root,oldFile);f.state.guardian.lastAuditIdentity=oldIdentity;await f.oversight.poll();const supervisorIdentity=f.state.supervisorOversight.pendingRepairIdentity;
  await expect(f.oversight.applyPendingRepair()).rejects.toMatchObject(repairBlocked?{guardianHandled:true}:{code:'OPERATING_REPAIR_APPLIED'});
  const fresh=JSON.parse(JSON.stringify(f.state));expect(guardianRepairReplayAllowed(fresh)).toBe(false);
  expect(fresh.supervisorOversight.supersededGuardianAudits).toContainEqual(expect.objectContaining({guardianAuditIdentity:oldIdentity,supervisorAuditIdentity:supervisorIdentity,repairStatus:repairBlocked?'blocked':'applied',source:'snapshot'}));
  expect(fileIdentity(f.root,oldFile)).toEqual(oldIdentity);expect(fresh.tasks['15-03'].status).toBe('blocked');
  const newer=path.join(f.directory,'guardian-new-cause.json');atomicJSON(newer,{reason:'a truly new post-handoff authorization'});fresh.guardian.lastAuditIdentity=fileIdentity(f.root,newer);expect(guardianRepairReplayAllowed(fresh)).toBe(true);
});

test('a guardian audit completing after the supervisor snapshot is fenced as old authorization without claiming product recovery',async()=>{
  const f=fixture(),first=path.join(f.directory,'guardian-53.json');atomicJSON(first,{cause:'pre-snapshot hold'});const original=fileIdentity(f.root,first);f.state.guardian.lastAuditIdentity=original;
  await f.oversight.poll();const later=path.join(f.directory,'guardian-54.json');atomicJSON(later,{cause:'completed while supervised handoff drained'});const current=fileIdentity(f.root,later);f.state.guardian.lastAuditIdentity=current;
  f.state.operatingRecovery={status:'recovering',reason:'No product progress yet'};await expect(f.oversight.applyPendingRepair()).rejects.toMatchObject({code:'OPERATING_REPAIR_APPLIED'});
  expect(guardianRepairReplayAllowed(f.state)).toBe(false);expect(f.state.supervisorOversight.supersededGuardianAudits).toContainEqual(expect.objectContaining({guardianAuditIdentity:current,source:'handoff-fenced'}));
  expect(fileIdentity(f.root,later)).toEqual(current);expect(fileIdentity(f.root,first)).toEqual(original);expect(f.state.operatingRecovery.status).toBe('recovering');expect(f.state.tasks['15-03'].status).toBe('blocked');
});

for(const repairBlocked of [false,true])test(`only an applied repair addresses the exact snapshot execution incident; blocked=${repairBlocked}`,async()=>{
  const f=fixture({repairBlocked}),incident=fileIdentity(f.root,f.evidenceFile);f.state.pendingExecutionIncident=incident;f.state.operatingRecovery={status:'recovering',incident};
  await f.oversight.poll();await expect(f.oversight.applyPendingRepair()).rejects.toThrow();
  if(repairBlocked){expect(f.state.pendingExecutionIncident).toEqual(incident);expect(f.state.supervisorOversight.addressedExecutionIncidents).toBeUndefined();}
  else{expect(f.state.pendingExecutionIncident).toBeUndefined();expect(f.state.supervisorOversight.addressedExecutionIncidents).toContainEqual(expect.objectContaining({incidentIdentity:incident}));}
  expect(fileIdentity(f.root,f.evidenceFile)).toEqual(incident);expect(f.state.operatingRecovery.status).toBe('recovering');
});

test('an incident arriving after the supervisor snapshot remains pending for its own fresh audit',async()=>{
  const f=fixture();f.state.pendingExecutionIncident=fileIdentity(f.root,f.evidenceFile);await f.oversight.poll();
  const freshFile=path.join(f.directory,'new-runtime-incident.json');atomicJSON(freshFile,{cause:'new cause'});const fresh=fileIdentity(f.root,freshFile);f.state.pendingExecutionIncident=fresh;
  await expect(f.oversight.applyPendingRepair()).rejects.toMatchObject({code:'OPERATING_REPAIR_APPLIED'});expect(f.state.pendingExecutionIncident).toEqual(fresh);expect(f.state.supervisorOversight.addressedExecutionIncidents).toBeUndefined();
});

test('the same incident can exhaust again under a distinct explicit resume receipt while its prior notice remains preserved',async()=>{
  const f=fixture(),fingerprint='same-product-gap',lastProductProgressAt='2026-10-15T10:00:00.000Z';
  atomicJSON(path.join(f.directory,'control/supervisor-attention.json'),{decision:{exhausted:true,incidentFingerprint:fingerprint,evidence:{lastProductProgressAt}}});
  atomicJSON(path.join(f.directory,'control/supervisor-observation.json'),{lastProductProgressAt,oversight:{[fingerprint]:{count:3,failureCount:3}}});
  await f.oversight.poll();expect(f.state.supervisorOversight.status).toBe('escalation_exhausted');const first=structuredClone(f.state.supervisorOversight.exhaustionNotices[0]);
  const resumeFile=path.join(f.directory,'explicit-resume.json');atomicJSON(resumeFile,{requested:true});f.state.explicitResume={receiptIdentity:fileIdentity(f.root,resumeFile),requestedAt:new Date(Date.parse(first.exhaustedAt)+1).toISOString()};
  atomicJSON(path.join(f.directory,'control/supervisor-observation.json'),{lastProductProgressAt,explicitRetryIdentity:f.state.explicitResume.receiptIdentity.sha256,oversight:{[fingerprint]:{count:3,failureCount:3}}});
  f.state.supervisorOversight.status='failed';await f.oversight.poll();
  expect(f.state.supervisorOversight.status).toBe('escalation_exhausted');expect(f.state.supervisorOversight.exhaustionNotices).toHaveLength(2);expect(f.state.supervisorOversight.exhaustionNotices[0]).toEqual(first);
  expect(f.state.supervisorOversight.exhaustionNotices[1].exhaustionKey).not.toBe(first.exhaustionKey);expect(f.state.supervisorOversight.exhaustionNotices[1].resumeIdentity).toEqual(f.state.explicitResume.receiptIdentity);
  expect(f.w.turnCalls).toBe(0);expect(read(path.join(f.directory,'control/supervisor-observation.json')).lastProductProgressAt).toBe(lastProductProgressAt);
});

for(const generation of ['maintenance','explicit-resume'])test(`an old exhaustion notice cannot consume a fresh ${generation} budget before the runtime observes it`,async()=>{
  const f=fixture(),fingerprint='old-gap',lastProductProgressAt='2026-10-15T10:00:00.000Z';
  atomicJSON(path.join(f.directory,'control/supervisor-attention.json'),{decision:{exhausted:true,incidentFingerprint:fingerprint,evidence:{lastProductProgressAt}}});
  atomicJSON(path.join(f.directory,'control/supervisor-observation.json'),{lastProductProgressAt,oversight:{[fingerprint]:{count:3}}});
  f.state.supervisorOversight={status:'maintenance_repaired',handledRequestId:'oversight-test-1'};
  if(generation==='maintenance')f.state.operatingMaintenance={acceptedReceiptSha:'verified-maintenance'};
  else f.state.explicitResume={receiptIdentity:{sha256:'new-user-request'}};
  await f.oversight.poll();expect(f.state.supervisorOversight.status).toBe('maintenance_repaired');expect(f.w.turnCalls).toBe(0);expect(f.state.supervisorOversight.exhaustionNotices).toBeUndefined();
});

test('bound evidence provides only canonical immutable controller pins and remains valid while state.json keeps changing',async()=>{
  const options={boundEvidence:true},f=fixture(options),stateFile=path.join(f.directory,'state.json'),paths={};
  for(const name of ['guardian','repair','failure','blocked']){const file=path.join(f.directory,`${name}-immutable.json`);atomicJSON(file,{kind:name});paths[name]=fileIdentity(f.root,file);}
  f.state.guardian.lastAuditIdentity=paths.guardian;f.state.guardian.lastControllerRepair={receiptIdentity:paths.repair};f.state.pendingExecutionIncident=fileIdentity(f.root,f.evidenceFile);f.state.supervisorOversight={lastFailureIdentity:paths.failure};
  f.state.tasks['15-03'].implementation={result:{status:'blocked'},responseIdentity:paths.blocked};options.evidencePaths=[paths.blocked.path];
  let saves=0;f.w.save=()=>atomicJSON(stateFile,{revision:++saves,mutable:true});
  await f.oversight.poll();const audit=read(path.resolve(f.root,f.state.supervisorOversight.pendingRepairIdentity.path)),schema=read(path.resolve(f.root,audit.schemaIdentity.path)),allowed=schema.properties.evidencePaths.items.enum;
  expect(allowed).toEqual(expect.arrayContaining(Object.values(paths).map(pin=>pin.path)));expect(allowed).toContain(fileIdentity(f.root,f.evidenceFile).path);
  expect(allowed).toContain(audit.triggerIdentity.path);expect(allowed).toContain(audit.snapshotIdentity.path);expect(allowed).not.toContain(fileIdentity(f.root,stateFile).path);expect(allowed.every(name=>!path.isAbsolute(name)&&!name.includes('\\'))).toBe(true);
  expect(audit.addressedImplementations).toEqual([{taskId:'15-03',responseIdentity:paths.blocked}]);
  f.w.save();expect(()=>validateSupervisorRepairAuthority(f.root,f.state,audit)).not.toThrow();expect(f.state.tasks['15-03'].status).toBe('blocked');
});

for(const bad of ['mutable-state','Tamil-suffix','absolute-alias','outside-enum'])test(`bound evidence strictly rejects ${bad} even if a model bypasses its output schema`,async()=>{
  const options={boundEvidence:true},f=fixture(options),stateFile=path.join(f.directory,'state.json');atomicJSON(stateFile,{mutable:true});
  options.chooseEvidence=allowed=>[bad==='mutable-state'?fileIdentity(f.root,stateFile).path:bad==='Tamil-suffix'?allowed[0]+'ாக':bad==='absolute-alias'?path.resolve(f.root,allowed[0]):fileIdentity(f.root,f.evidenceFile).path];
  await expect(f.oversight.poll()).rejects.toThrow('outside its immutable allowed paths');
  expect(f.state.supervisorOversight.status).toBe('failed');expect(f.state.supervisorOversight.pendingRepairIdentity).toBeUndefined();expect(f.w.repairCalls).toHaveLength(0);
});

test('bound input hash drift is rejected rather than silently recapturing fresh hashes from the model citation',async()=>{
  let release;const gate=new Promise(resolve=>{release=resolve;}),f=fixture({boundEvidence:true,gate});f.state.pendingExecutionIncident=fileIdentity(f.root,f.evidenceFile);
  const pending=f.oversight.poll();for(let index=0;index<10&&!f.w.turnCalls;index++)await Promise.resolve();expect(f.w.turnCalls).toBe(1);
  fs.appendFileSync(f.evidenceFile,'\n ');release();await expect(pending).rejects.toThrow(/Evidence bytes changed/);expect(f.state.supervisorOversight.pendingRepairIdentity).toBeUndefined();
});

test('turns created under the legacy schema preserve it when boundEvidence is enabled during restart',async()=>{
  const f=await crashedAudit('completed'),owner=structuredClone(f.state.activeTurns.supervisor),requestFile=path.join(path.dirname(owner.dispatchFile),'request.json'),before=fileIdentity(f.root,requestFile);
  f.w.config.supervisorOversight.boundEvidence=true;f.w.controllerVitest=true;f.w.ensureRunning=()=>{};f.w.config.promptPath='prompt.txt';f.w.config.rulesPath='rules.txt';
  fs.writeFileSync(path.join(f.root,'prompt.txt'),'Immutable product contract');fs.writeFileSync(path.join(f.root,'rules.txt'),'Operating contract');f.w.turn=(...args)=>TaskWorkflow.prototype.turnOwned.call(f.w,...args);
  await f.restored.poll();expect(f.state.supervisorOversight.status).toBe('continue');expect(fileIdentity(f.root,requestFile)).toEqual(before);
  expect(fs.existsSync(path.join(f.directory,'supervisor-audits',owner.operatingAuditId,'audit-schema.json'))).toBe(false);expect(read(path.resolve(f.root,f.state.supervisorOversight.lastAuditIdentity.path)).schemaIdentity).toBeUndefined();
});

for(const weakening of ['action','additionalProperties'])test(`dynamic schema reconciliation cannot weaken original ${weakening} authority`,async()=>{
  const f=await crashedAudit('completed',{boundEvidence:true}),owner=structuredClone(f.state.activeTurns.supervisor),report=path.join(f.directory,'supervisor-audits',owner.operatingAuditId),schemaFile=path.join(report,'audit-schema.json'),schema=read(schemaFile),requestFile=path.join(path.dirname(owner.dispatchFile),'request.json'),request=read(requestFile);
  if(weakening==='action')schema.properties.action.enum.push('approve_product');else schema.additionalProperties=true;
  atomicJSON(schemaFile,schema);atomicJSON(requestFile,{...request,schemaDigest:digest(schema)});atomicJSON(owner.dispatchFile,{...read(owner.dispatchFile),requestIdentity:fileIdentity(f.root,requestFile)});
  await expect(f.restored.reconcilePendingAudit()).rejects.toThrow('changes its original authority');expect(f.state.activeTurns.supervisor).toEqual(owner);expect(f.nativeCalls.filter(call=>call.method==='turn/interrupt')).toHaveLength(0);
});

test('normal recovery drains a monitor-started audit before transport close and preserves its handoff',async()=>{
 let release;const gate=new Promise(resolve=>{release=resolve;}),f=fixture({gate});f.w.oversight=f.oversight;
 const audit=f.oversight.poll();
 while(!f.w.turnCalls)await new Promise(resolve=>setTimeout(resolve,1));
 f.state.status='recovering';f.state.error='fixture guardian hold';let drained=false;
 const draining=drainSupervisorAudit(f.w).then(()=>{drained=true;});
 await new Promise(resolve=>setTimeout(resolve,30));expect(drained).toBe(false);expect(f.state.status).toBe('recovering');
 release();await audit;await draining;
 expect(drained).toBe(true);expect(f.state.status).toBe('reloading_orchestration');expect(f.state.error).toBe(null);
 expect(f.state.supervisorOversight.pendingRepairIdentity).toBeDefined();expect(f.state.tasks['15-03'].status).toBe('blocked');
});
test('explicit user stop does not wait for a background audit to finish',async()=>{
 let release;const gate=new Promise(resolve=>{release=resolve;}),f=fixture({gate,action:'continue'});f.w.oversight=f.oversight;
 const audit=f.oversight.poll();while(!f.w.turnCalls)await new Promise(resolve=>setTimeout(resolve,1));
 f.w.stopped=true;f.state.status='stopped';await drainSupervisorAudit(f.w);
 expect(f.oversight.busy).toBe(true);expect(f.state.status).toBe('stopped');release();await audit;
});
