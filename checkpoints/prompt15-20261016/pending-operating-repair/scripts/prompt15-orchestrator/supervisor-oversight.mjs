import fs from 'node:fs';
import {operatingMaintenanceEvidence as originalMaintenanceEvidence} from './operating-maintenance.mjs';
import path from 'node:path';
import {atomicJSON,fileIdentity,validateIdentities,resolveInside,inside} from './protocol.mjs';
import {needsExternalInput,oversightExhausted,completedProductBlock,productBlockNeedsResolution} from './operating-recovery.mjs';
import {digest} from './product-target.mjs';
import {productActive,auditRequestState} from './execution-lifecycle.mjs';
import {observeProductProgress} from './supervisor-oversight-policy.mjs';

export const OVERSIGHT_SCHEMA={type:'object',additionalProperties:false,required:['action','summary','reason','evidencePaths'],properties:{action:{type:'string',enum:['continue','repair_controller']},summary:{type:'string'},reason:{type:'string'},evidencePaths:{type:'array',items:{type:'string'},maxItems:12}}};
const read=file=>JSON.parse(fs.readFileSync(file,'utf8'));
const stamp=()=>new Date().toISOString();
const samePin=(left,right)=>Boolean(left&&right&&left.path===right.path&&left.sha256===right.sha256&&left.byteLength===right.byteLength);

const completeChecks=value=>{
  const counts=value?.counts;
  return value?.complete===true&&value.pass===true&&Number.isInteger(counts?.passed)&&counts.passed>0&&counts.total===counts.passed&&counts.failed===0&&counts.errors===0&&counts.skipped===0&&counts.pending===0;
};

// Maintenance pins describe the accepted generation. A subsequent repair must
// explain every transition; neither the receipt nor its original pins change.
export function operatingMaintenanceAuditEvidence(root,state){
  const maintenance=state.operatingMaintenance;
  if(!maintenance?.acceptedReceiptSha)return null;
  if(maintenance.receiptIdentity?.sha256!==maintenance.acceptedReceiptSha)throw Error('Operating maintenance authority mismatch');
  validateIdentities(root,[maintenance.receiptIdentity]);
  const receipt=read(resolveInside(root,maintenance.receiptIdentity.path));
  if(receipt.kind!=='verified-operating-maintenance'||receipt.runId!==state.runId||!receipt.sourceInputs?.length)throw Error('Invalid operating maintenance provenance');
  validateIdentities(root,[receipt.testResult]);
  const result=read(resolveInside(root,receipt.testResult.path));
  if(result.kind!=='vitest'||result.inputsUnchanged!==true||result.allFilesExecuted!==true||result.pass!==true||!completeChecks({...result.tests,pass:true}))throw Error('Incomplete operating maintenance verification');
  const same=(a,b)=>Boolean(a&&b&&resolveInside(root,a.path)===resolveInside(root,b.path)&&a.sha256===b.sha256&&a.byteLength===b.byteLength);
  const current=new Map(receipt.sourceInputs.map(pin=>[resolveInside(root,pin.path),pin])),chain=[],seen=new Set();
  if(current.size!==receipt.sourceInputs.length)throw Error('Duplicate operating maintenance source');
  let generation=Date.parse(receipt.verifiedAt);
  const repairs=[...(state.guardian?.controllerRepairHistory??[]),state.guardian?.lastControllerRepair].filter(row=>row?.status==='applied');
  const records=repairs.map(link=>{validateIdentities(root,[link.receiptIdentity]);return {link,file:resolveInside(root,link.receiptIdentity.path),repair:read(resolveInside(root,link.receiptIdentity.path))};});
  // Native audit contracts may themselves cite the source generation they
  // authorized replacing. Authenticate those citations against an exact backup,
  // but only when they match the already established generation in this chain.
  const preserved=new Map(),pinKey=pin=>digest([resolveInside(root,pin.path),pin.sha256,pin.byteLength]);
  for(const {file,repair} of records)if(Date.parse(repair.finishedAt)>generation)for(const change of repair.changes??[])if(change.before){
    const backup={...change.before,path:resolveInside(root,path.join(path.dirname(file),'before',change.path))};
    preserved.set(pinKey(change.before),backup);
  }
  const validateAuditInputs=pins=>{
    for(const pin of pins){
      const source=current.get(resolveInside(root,pin.path));
      if(source){
        if(!same(source,pin))throw Error('Operating maintenance audit cites another source generation');
        validateIdentities(root,[preserved.get(pinKey(pin))??pin]);
      }else validateIdentities(root,[pin]);
    }
  };
  for(const {link,file,repair} of records){
    if(repair.status!=='applied'||!same(repair.sourceAudit,link.sourceAudit))throw Error('Operating maintenance repair link mismatch');
    if(Date.parse(repair.finishedAt)<=Date.parse(receipt.verifiedAt))continue;
    if(seen.has(file))throw Error('Duplicate operating maintenance repair link');
    seen.add(file);
    const directory=path.dirname(file),started=Date.parse(repair.startedAt),finished=Date.parse(repair.finishedAt);
    if(!Number.isFinite(generation)||!Number.isFinite(started)||!Number.isFinite(finished)||started<generation||finished<started||path.basename(file)!=='repair-result.json'||path.basename(directory)!==repair.id||!Array.isArray(repair.changes)||!repair.changes.length)throw Error('Invalid operating maintenance repair generation');
    validateIdentities(root,[repair.sourceAudit]);
    const audit=read(resolveInside(root,repair.sourceAudit.path));
    if(audit.runId!==state.runId||audit.result?.decision!=='hold'||audit.result.recovery?.action!=='repair_controller')throw Error('Operating maintenance repair lacks authorization');
    if(audit.kind==='supervisor-operating-audit'){
      if(repair.authority!=='supervisor-oversight')throw Error('Operating maintenance repair supervisor authority mismatch');
      validateSupervisorAuthority(root,state,audit,validateAuditInputs);
    }
    else{
      validateIdentities(root,[audit.requestIdentity,audit.responseIdentity]);
      const response=read(resolveInside(root,audit.responseIdentity.path));
      if(repair.authority!=='operating-guardian'||audit.guardianThreadId!==state.guardian?.threadId||repair.guardianThreadId!==audit.guardianThreadId||response.threadId!==audit.guardianThreadId||!response.turnId||!same(response.requestIdentity,audit.requestIdentity)||digest(response.result)!==digest(audit.result))throw Error('Operating maintenance repair guardian authority mismatch');
    }
    // Only the final actual execution can authorize application. Read the
    // pinned compact output as well as the controller's durable check record.
    const attempt=repair.attempts?.at(-1),execution=attempt?.execution;
    if(!attempt||attempt.passed!==true||attempt.inputsUnchanged!==true||execution?.exitCode!==0||execution.signal||execution.timedOut!==false||!completeChecks(attempt.tests)||Date.parse(execution.startedAt)<started||Date.parse(execution.finishedAt)>finished||!Number.isFinite(Date.parse(execution.startedAt))||!Number.isFinite(Date.parse(execution.finishedAt))||Date.parse(execution.finishedAt)<Date.parse(execution.startedAt))throw Error('Operating maintenance repair has no complete latest checks');
    const attemptNumber=attempt.attempt;
    if(!Number.isInteger(attemptNumber)||attemptNumber<1)throw Error('Invalid operating maintenance repair attempt');
    validateIdentities(root,[attempt.responseIdentity,execution.stdout,execution.stderr]);
    if(resolveInside(root,attempt.responseIdentity.path)!==path.join(directory,`response-${attemptNumber}.json`)||resolveInside(root,execution.stdout.path)!==path.join(directory,`checks-${attemptNumber}.stdout.log`)||resolveInside(root,execution.stderr.path)!==path.join(directory,`checks-${attemptNumber}.stderr.log`)||execution.stdout.truncated||execution.stderr.truncated||digest(read(resolveInside(root,execution.stdout.path)))!==digest(attempt.tests)||digest(read(path.join(directory,`checks-${attemptNumber}.json`)))!==digest(attempt))throw Error('Operating maintenance repair checks differ from actual execution');
    const response=read(resolveInside(root,attempt.responseIdentity.path));
    validateIdentities(root,[response.requestIdentity]);
    const request=read(resolveInside(root,response.requestIdentity.path)),dispatch=read(path.join(directory,`dispatch-${attemptNumber}.json`));
    if(resolveInside(root,response.requestIdentity.path)!==path.join(directory,`request-${attemptNumber}.json`)||!same(request.sourceAudit,repair.sourceAudit)||!same(dispatch.requestIdentity,response.requestIdentity)||request.threadId!==repair.repairThreadId||dispatch.threadId!==request.threadId||!response.turnId||dispatch.turnId!==response.turnId||path.resolve(request.mirror??'')!==path.join(directory,'mirror')||dispatch.cwd!==request.mirror||response.result?.status!=='repaired'||!Array.isArray(response.result.changedFiles)||digest([...response.result.changedFiles].sort())!==digest(repair.changes.map(change=>change.path).sort()))throw Error('Operating maintenance repair differs from its confirmed worker');
    const changes=[],names=new Set();
    for(const change of repair.changes){
      const name=change.path;
      if(typeof name!=='string'||path.isAbsolute(name)||name.includes('\\')||name.split('/').some(part=>!part||part==='.'||part==='..')||names.has(name)||change.after?.path!==name||change.before&&change.before.path!==name)throw Error('Invalid operating maintenance repair source path');
      names.add(name);
      const source=resolveInside(root,name),previous=current.get(source),beforeFile=path.join(directory,'before',name),afterFile=path.join(directory,'mirror',name);
      if(previous&&!same(previous,change.before))throw Error('Operating maintenance repair does not extend the accepted source');
      const before=change.before?{...change.before,path:beforeFile}:null,after={...change.after,path:afterFile};
      validateIdentities(root,[...(before?[before]:[]),after]);
      changes.push({path:name,before:before?fileIdentity(root,beforeFile):null,after:fileIdentity(root,afterFile)});
      current.set(source,change.after);
    }
    chain.push({receiptIdentity:link.receiptIdentity,sourceAudit:repair.sourceAudit,responseIdentity:attempt.responseIdentity,testResult:execution.stdout,changes});
    generation=finished;
  }
  if(!chain.length)return originalMaintenanceEvidence(root,state);
  const currentSourceInputs=[...current.values()];validateIdentities(root,currentSourceInputs);
  return {receiptIdentity:maintenance.receiptIdentity,testResult:receipt.testResult,sourceInputs:receipt.sourceInputs,verifiedAt:receipt.verifiedAt,reason:receipt.reason,currentSourceInputs,repairChain:chain};
}

function boundSchemaPaths(schema){
  const base=structuredClone(schema),allowed=base.properties?.evidencePaths?.items?.enum;
  if(base.properties?.evidencePaths?.items)delete base.properties.evidencePaths.items.enum;
  if(digest(base)!==digest(OVERSIGHT_SCHEMA)||!Array.isArray(allowed)||!allowed.length||allowed.length>64||new Set(allowed).size!==allowed.length||allowed.some(name=>typeof name!=='string'||path.isAbsolute(name)||name.includes('\\')||name.split('/').some(part=>!part||part==='.'||part==='..')||path.basename(name)==='state.json'))throw Error('Supervisor stored evidence schema changes its original authority');
  return allowed;
}

function ownedAuditSchema(root,report,schemaDigest){
  // Old native requests keep their original schema even after bound evidence
  // becomes mandatory for newly created reports.
  if(schemaDigest===digest(OVERSIGHT_SCHEMA))return OVERSIGHT_SCHEMA;
  const file=path.join(report,'audit-schema.json');
  if(!fs.existsSync(file))throw Error('Supervisor audit has no authenticated stored schema');
  const schema=read(resolveInside(root,file));boundSchemaPaths(schema);
  if(schemaDigest&&digest(schema)!==schemaDigest)throw Error('Supervisor stored schema differs from its original request');
  return schema;
}

export function guardianRepairReplayAllowed(state){
  const current=state.guardian?.lastAuditIdentity;
  return !current||!(state.supervisorOversight?.supersededGuardianAudits??[]).some(row=>samePin(row.guardianAuditIdentity,current)&&row.supervisorAuditIdentity&&['applied','blocked'].includes(row.repairStatus));
}

// The external lifecycle owner requests audits. Only the controller writes its
// own state; the immutable request/response pair records the supervisor's actual
// native decision independently of the guardian being inspected.
export class SupervisorOversight {
  constructor(workflow){this.workflow=workflow;this.busy=false;}
  async waitForIdle(){
    // A normal controller retry must not close the transport beneath an audit
    // started by its monitor timer. Native audit deadlines remain in force;
    // explicit user stops still interrupt immediately.
    while(this.busy&&!this.workflow.stopped)await new Promise(resolve=>setTimeout(resolve,25));
  }
  recordOperatingFailure(incidentFingerprint,identity){
    if(!incidentFingerprint||!identity)return;
    const w=this.workflow;validateIdentities(w.root,[identity]);
    w.state.supervisorOversight??={};const failures=w.state.supervisorOversight.operatingFailures??=[];
    if(!failures.some(row=>samePin(row.identity,identity)))failures.push({incidentFingerprint,identity,at:stamp(),resumeIdentity:w.state.explicitResume?.receiptIdentity?.sha256??null,maintenanceIdentity:w.state.operatingMaintenance?.acceptedReceiptSha??null});
  }
  async reconcileProgress(){
    if(this.progressReconciliation)return this.progressReconciliation;
    this.progressReconciliation=this.reconcileProgressOwned();
    try{return await this.progressReconciliation;}finally{this.progressReconciliation=null;}
  }
  async reconcileProgressOwned(){
    const w=this.workflow,file=path.join(w.directory,'control/supervisor-audit-request.json');
    if(this.busy||!fs.existsSync(file)||w.state.supervisorOversight?.pendingRepairIdentity)return false;
    const requestIdentity=fileIdentity(w.root,file),request=read(file);if(request.runId!==w.state.runId||!/^oversight-[a-zA-Z0-9-]+$/.test(request.id))throw Error('Supervisor audit mailbox identity mismatch');
    validateIdentities(w.root,Object.values(w.state.productResponses??{}).map(row=>row.identity));
    const observationFile=path.join(w.directory,'control/supervisor-observation.json');
    const observation=observeProductProgress(w.state,fs.existsSync(observationFile)?read(observationFile):null,Date.now());
    const disposition=auditRequestState(w.state,observation,request);
    const attentionFile=path.join(w.directory,'control/supervisor-attention.json');
    const attention=fs.existsSync(attentionFile)?read(attentionFile):null;
    const oversight=w.state.supervisorOversight??{};
    const staleExhaustion=oversight.status==='escalation_exhausted'&&attention?.decision?.incidentFingerprint===oversight.exhaustedIncident
      &&['product_execution_gap','repeated_guardian_cause'].includes(attention.decision?.evidence?.reasonCode??request.decision?.reasonCode)
      &&Date.parse(observation.lastProductProgressAt)>Date.parse(attention.decision?.evidence?.lastProductProgressAt);
    if(disposition!=='superseded'&&!staleExhaustion)return false;
    let nativeReconciliation=null;
    if(disposition==='superseded'){
      await this.reconcilePendingAudit();
      if(w.state.activeTurns?.supervisor?.operatingAuditId===request.id)return false;
      const dispatch=path.join(w.directory,'supervisor-audits',request.id,'audit/dispatch.json');
      if(fs.existsSync(dispatch)){
        w.state.supervisorOversight??={};w.state.supervisorOversight.interruptedAuditDispatchIdentity=fileIdentity(w.root,dispatch);w.save();
        await this.reconcileInterruptedAudit();nativeReconciliation=w.state.supervisorOversight.lastNativeReconciliation;
      }
    }
    const report=path.join(w.directory,'control/audit-retirements',request.id+'.json');
    const record={version:1,kind:'superseded-operating-audit',requestIdentity,incidentFingerprint:request.decision.incidentFingerprint,lastProductProgressAt:observation.lastProductProgressAt,productFingerprint:observation.productFingerprint,productResponses:Object.values(w.state.productResponses??{}).map(row=>row.identity),nativeReconciliation,at:stamp(),productAcceptanceIssued:false};
    validateIdentities(w.root,[requestIdentity,...record.productResponses]);
    if(!fs.existsSync(report))atomicJSON(report,record);
    const identity=fileIdentity(w.root,report);w.state.supervisorOversight??={};
    w.state.supervisorOversight.retiredRequests??=[];
    if(disposition==='superseded'&&!w.state.supervisorOversight.retiredRequests.some(row=>row.id===request.id))w.state.supervisorOversight.retiredRequests.push({id:request.id,identity});
    if(staleExhaustion){
      w.state.supervisorOversight.exhaustionResolutions??=[];w.state.supervisorOversight.exhaustionResolutions.push({incidentFingerprint:oversight.exhaustedIncident,exhaustedAt:oversight.exhaustedAt,identity});
      w.state.supervisorOversight.status='progress_resumed';
    }
    w.save();w.event('supervisor_audit_retired',{auditId:request.id,identity});return true;
  }
  async poll(){
    const w=this.workflow,file=path.join(w.directory,'control/supervisor-audit-request.json');
    if(completedProductBlock(w.state)&&!productBlockNeedsResolution(w.state)&&!w.state.activeOperation&&!Object.keys(w.state.activeOperations??{}).length&&!Object.keys(w.state.activeTurns??{}).length)return;
    if(this.closing||this.busy||w.controllerRepair?.busy||w.state.guardian?.activeRepairId||w.stopped||['stopped','standby'].includes(w.state.status)||needsExternalInput(w.state)||w.config.supervisorOversight?.enabled===false||!fs.existsSync(file)||fs.existsSync(path.join(w.directory,'stop.json')))return;
    if(await this.reconcileProgress())return;
    if(oversightExhausted(w.state))return;
    await this.reconcilePendingAudit();
    if(this.closing||this.busy||w.controllerRepair?.busy||w.state.guardian?.activeRepairId||w.state.activeTurns?.supervisor||w.state.supervisorOversight?.pendingRepairIdentity)return;
    const attentionFile=path.join(w.directory,'control/supervisor-attention.json');
    if(fs.existsSync(attentionFile)&&!productActive(w.state)){
      const attention=read(attentionFile),observationFile=path.join(w.directory,'control/supervisor-observation.json');
      const observation=fs.existsSync(observationFile)?read(observationFile):null;
      const resumeIdentity=w.state.explicitResume?.receiptIdentity??null;
      const exhaustionKey=digest({incidentFingerprint:attention.decision?.incidentFingerprint,resumeIdentity:resumeIdentity?.sha256??null,maintenanceIdentity:w.state.operatingMaintenance?.acceptedReceiptSha??null});
      const currentGeneration=(observation?.explicitRetryIdentity??null)===(resumeIdentity?.sha256??null)&&(observation?.maintenanceIdentity??null)===(w.state.operatingMaintenance?.acceptedReceiptSha??null);
      if(currentGeneration&&attention.decision?.exhausted&&(observation?.oversight?.[attention.decision.incidentFingerprint]?.failureCount??0)>=(w.config.supervisorOversight?.maxAuditsPerIncident??3)&&observation?.lastProductProgressAt===attention.decision.evidence?.lastProductProgressAt&&w.state.supervisorOversight?.exhaustionKey!==exhaustionKey){
        const notice={exhaustionKey,incidentFingerprint:attention.decision.incidentFingerprint,resumeIdentity,exhaustedAt:stamp()};
        const history=[...(w.state.supervisorOversight?.exhaustionNotices??[])];
        if(!history.length&&w.state.supervisorOversight?.exhaustedIncident)history.push({incidentFingerprint:w.state.supervisorOversight.exhaustedIncident,exhaustedAt:w.state.supervisorOversight.exhaustedAt,resumeIdentity:w.state.supervisorOversight.exhaustedResumeIdentity??null,legacy:true});
        history.push(notice);
        w.state.supervisorOversight={...w.state.supervisorOversight,status:'escalation_exhausted',exhaustedIncident:attention.decision.incidentFingerprint,exhaustionKey,exhaustedResumeIdentity:resumeIdentity,exhaustionNotices:history,exhaustedAt:notice.exhaustedAt,lastCheckedAt:stamp(),lastSummary:'총괄 운영 감사의 자동 복구 시도가 소진됐습니다. 제품 진척이 확인되지 않아 복구 완료로 처리하지 않았습니다.'};w.save();w.event('supervisor_oversight_exhausted',{incidentFingerprint:attention.decision.incidentFingerprint});await this.interruptOperatingTurns();return;
      }
    }
    const request=read(file);
    if(request.runId!==w.state.runId||!/^oversight-[a-zA-Z0-9-]+$/.test(request.id))throw Error('Supervisor audit mailbox identity mismatch');
    if(auditRequestState(w.state,null,request)==='handled')return;
    this.busy=true;
    const attachNotifications=!w.notificationsAttached;
    if(attachNotifications){w.server.on?.('notification',w.onNotification);w.notificationsAttached=true;}
    const report=path.join(w.directory,'supervisor-audits',request.id);
    fs.mkdirSync(report,{recursive:true});
    const requestFile=path.join(report,'trigger.json');
    if(!fs.existsSync(requestFile))atomicJSON(requestFile,request);
    w.state.supervisorOversight={...w.state.supervisorOversight,status:'auditing',activeAuditId:request.id,deadlineAt:new Date(Date.now()+(w.config.supervisorOversight?.auditTimeoutMs??180000)).toISOString()};w.save();
    try{
      await this.reconcileInterruptedAudit();
      // This role has a read-only sandbox. It cannot change product verdicts,
      // tests, permission settings, or its own operating rules during an audit.
      const snapshot={runId:w.state.runId,review:w.state.review,status:w.state.status,tasks:Object.fromEntries(Object.entries(w.state.tasks).map(([id,row])=>[id,{status:row.status,attempt:row.attempt,implementationStatus:row.implementation?.result?.status,confirmedResponseIdentity:row.implementation?.responseIdentity??null,blocker:String(row.blocker??'').slice(0,1500)}])),guardian:w.state.guardian,activeTurns:w.state.activeTurns,activeOperations:w.state.activeOperations,pendingExecutionIncident:w.state.pendingExecutionIncident,supervisorLastFailureIdentity:w.state.supervisorOversight?.lastFailureIdentity??null,operatingMaintenance:operatingMaintenanceAuditEvidence(w.root,w.state)};
      const snapshotFile=path.join(report,'snapshot.json');if(!fs.existsSync(snapshotFile))atomicJSON(snapshotFile,snapshot);
      const contract=this.auditEvidenceContract(report,requestFile,snapshotFile);
      const maintenancePrompt=snapshot.operatingMaintenance?` Operator maintenance ${JSON.stringify(snapshot.operatingMaintenance.receiptIdentity)} preserves its accepted source pins and tests. Any repairChain verifies subsequent authorized transitions using preserved before bytes, confirmed repair receipts, actual checks and current after bytes. Inspect currentSourceInputs when present; sourceInputs remain historical. Check this provenance before comparing current code with an older guardian repair's after hashes. An internal BLOCKED handoff has a dedicated next-owner resolution; inspect that actual execution instead of requiring the previous hold to remain permanent.`:'';
      const prompt=`Audit orchestration operations as the fixed supervisor, independently of the operating guardian. Trigger ${requestFile}; pinned observation ${snapshotFile}. Inspect actual incident receipts and exact native ownership. Decide continue only with a concrete bounded operation/deadline or actual resolved incident. For a local orchestration deadlock or defect choose repair_controller with evidence and the smallest safe operating repair. If addressing a blocked implementation, inspect and explicitly cite its exact confirmedResponseIdentity.path in evidencePaths so the resulting operating repair can authorize one continuation of that same task. No guardian approval is required for your operating audit. Never issue product PASS, change tests/requirements/permissions, invent external approval, or edit any file. Existing user stop and true external holds remain binding. Return only the requested schema.`+(contract.inputs?`\nAllowed immutable evidence pins: ${JSON.stringify(contract.inputs)}. Select evidencePaths only from these exact canonical relative paths. Never cite mutable state.json, use an absolute alias, append characters, or invent a path.`:'');
      const response=await w.turn('supervisor','supervisor',w.root,path.join(report,'audit'),prompt+maintenancePrompt,contract.schema,{review:w.state.review,operatingAuditId:request.id},{turnTimeoutMs:w.config.supervisorOversight?.auditTimeoutMs??180000});
      validateIdentities(w.root,[response.requestIdentity,response.responseIdentity]);
      const value=response.result;if(!['continue','repair_controller'].includes(value.action)||!value.summary?.trim()||!value.reason?.trim())throw Error('Supervisor audit has an invalid operating decision');
      if(contract.inputs)validateIdentities(w.root,contract.inputs);
      if(!Array.isArray(value.evidencePaths)||contract.inputs&&value.evidencePaths.some(name=>!contract.schema.properties.evidencePaths.items.enum.includes(name)))throw Error('Supervisor audit cited evidence outside its immutable allowed paths');
      const evidence=value.evidencePaths.map(name=>contract.inputs?contract.inputs.find(pin=>pin.path===name):fileIdentity(w.root,resolveInside(w.root,name)));
      const addressedImplementations=Object.entries(w.state.tasks).filter(([,row])=>row.implementation?.result?.status==='blocked'&&row.implementation.responseIdentity&&evidence.some(pin=>resolveInside(w.root,pin.path)===resolveInside(w.root,row.implementation.responseIdentity.path)&&pin.sha256===row.implementation.responseIdentity.sha256)).map(([taskId,row])=>({taskId,responseIdentity:row.implementation.responseIdentity}));
      const receipt={version:1,kind:'supervisor-operating-audit',authority:'supervisor-oversight',phase:'supervisor_oversight',runId:w.state.runId,addressedImplementations,auditId:request.id,supervisorThreadId:w.state.threads.supervisor,requestIdentity:response.requestIdentity,responseIdentity:response.responseIdentity,triggerIdentity:fileIdentity(w.root,requestFile),snapshotIdentity:fileIdentity(w.root,snapshotFile),...(contract.inputs?{schemaIdentity:contract.schemaIdentity,evidenceManifestIdentity:contract.evidenceManifestIdentity}:{}),evidence,checkedAt:stamp(),result:{decision:value.action==='repair_controller'?'hold':'continue',summary:value.summary,reason:value.reason,ruleChanges:[],recovery:{action:value.action==='repair_controller'?'repair_controller':'none',taskId:addressedImplementations.length===1?addressedImplementations[0].taskId:'',evidencePaths:value.evidencePaths,reason:value.reason}}};
      const receiptFile=path.join(report,'audit-result.json');atomicJSON(receiptFile,receipt);
      const identity=fileIdentity(w.root,receiptFile);
      w.state.supervisorOversight={...w.state.supervisorOversight,status:value.action==='repair_controller'?'repair_pending':'continue',handledRequestId:request.id,lastCheckedAt:stamp(),lastSummary:value.summary,lastAuditIdentity:identity};
      if(value.action==='repair_controller'){
        w.state.supervisorOversight.pendingRepairIdentity=identity;
        w.state.supervisorOversight.pendingRepairIncident=request.decision?.incidentFingerprint;
        await this.interruptExpiredProductTurns(request);
        // Product work drains normally. An operating-only native turn can be
        // interrupted by its exact identity; startup reconciles its receipts.
        await this.interruptOperatingTurns();
        w.oversightReloadRequested=!productActive(w.state);
      }
      w.save();w.event('supervisor_operating_audit',{auditId:request.id,action:value.action,receipt:identity});
    }catch(error){
      const failureFile=path.join(report,`failure-${Date.now()}.json`);atomicJSON(failureFile,{version:1,requestId:request.id,reason:error.message,at:stamp()});
      const dispatchFile=path.join(report,'audit/dispatch.json');
      w.state.supervisorOversight={...w.state.supervisorOversight,status:'failed',handledRequestId:request.id,lastCheckedAt:stamp(),lastSummary:error.message,lastFailureIdentity:fileIdentity(w.root,failureFile),...(fs.existsSync(dispatchFile)?{interruptedAuditDispatchIdentity:fileIdentity(w.root,dispatchFile)}:{})};
      if(fs.existsSync(dispatchFile)&&read(dispatchFile).turnId)this.recordOperatingFailure(request.decision?.incidentFingerprint,w.state.supervisorOversight.lastFailureIdentity);
      throw error;
    }finally{delete w.state.supervisorOversight.activeAuditId;this.busy=false;if(attachNotifications){w.server.off?.('notification',w.onNotification);w.notificationsAttached=false;}w.save();}
  }
  auditEvidenceContract(report,triggerFile,snapshotFile){
    const w=this.workflow,requestFile=path.join(report,'audit/request.json'),schemaFile=path.join(report,'audit-schema.json'),manifestFile=path.join(report,'audit-evidence.json');
    const prior=fs.existsSync(requestFile)?read(requestFile):null;
    if(prior?.schemaDigest===digest(OVERSIGHT_SCHEMA))return {schema:OVERSIGHT_SCHEMA};
    if(prior&&!fs.existsSync(schemaFile))throw Error('Supervisor original request has no preserved evidence schema');
    if(!fs.existsSync(schemaFile)&&!w.config.supervisorOversight?.boundEvidence)return {schema:OVERSIGHT_SCHEMA};
    if(!fs.existsSync(schemaFile)){
      const snapshot=read(snapshotFile),pins=new Map(),add=expected=>{
        if(!expected)return;
        validateIdentities(w.root,[expected]);const pin=fileIdentity(w.root,resolveInside(w.root,expected.path));
        if(path.basename(pin.path)==='state.json')throw Error('Mutable state.json cannot be supervisor audit evidence');
        pins.set(pin.path,pin);
      };
      add(fileIdentity(w.root,triggerFile));add(fileIdentity(w.root,snapshotFile));add(snapshot.guardian?.lastAuditIdentity);add(snapshot.guardian?.lastControllerRepair?.receiptIdentity);add(snapshot.pendingExecutionIncident);add(snapshot.supervisorLastFailureIdentity);
      if(snapshot.operatingMaintenance){
        const proof=snapshot.operatingMaintenance;add(proof.receiptIdentity);add(proof.testResult);
        // The receipt pins and validates the complete source inventory. Keep
        // direct citations bounded to the control paths relevant to this audit.
        const inventory=proof.currentSourceInputs??proof.sourceInputs;
        const sources=inventory.length<=16?inventory:inventory.filter(pin=>/(?:task-workflow|operating-recovery|run|supervisor-oversight-policy|task-progress|product-block-resolution|operating-maintenance|supervisor-oversight)\.mjs$/.test(pin.path));
        for(const pin of sources)add(pin);
        // The snapshot retains the whole validated chain. Bound direct native
        // citations to the latest receipt/check pairs and preserved transitions.
        for(const link of (proof.repairChain??[]).slice(-3)){
          add(link.receiptIdentity);add(link.testResult);
          for(const change of link.changes)if(pins.size<52){add(change.before);add(change.after);}
        }
      }
      for(const row of Object.values(snapshot.tasks??{}))if(row.implementationStatus==='blocked')add(row.confirmedResponseIdentity);
      const inputs=[...pins.values()].sort((a,b)=>a.path.localeCompare(b.path)),schema=structuredClone(OVERSIGHT_SCHEMA);schema.properties.evidencePaths.items.enum=inputs.map(pin=>pin.path);boundSchemaPaths(schema);
      // Persist inputs first: a crash cannot leave a reusable schema without
      // the original immutable bytes it permits the model to cite.
      if(fs.existsSync(manifestFile)&&digest(read(manifestFile))!==digest({version:1,inputs}))throw Error('Supervisor prepared evidence manifest changed');
      if(!fs.existsSync(manifestFile))atomicJSON(manifestFile,{version:1,inputs});atomicJSON(schemaFile,schema);
    }
    const schema=ownedAuditSchema(w.root,report,prior?.schemaDigest),manifest=read(manifestFile),allowed=boundSchemaPaths(schema);
    if(manifest.version!==1||!Array.isArray(manifest.inputs)||digest(manifest.inputs.map(pin=>pin.path))!==digest(allowed))throw Error('Supervisor evidence manifest does not match its stored schema');
    validateIdentities(w.root,manifest.inputs);
    return {schema,inputs:manifest.inputs,schemaIdentity:fileIdentity(w.root,schemaFile),evidenceManifestIdentity:fileIdentity(w.root,manifestFile)};
  }
  async reconcilePendingAudit(){
    const w=this.workflow,active=w.state.activeTurns?.supervisor;
    if(this.busy||!active?.operatingAuditId||w.server.active?.has(active.threadId))return false;
    if(this.reconciling)return this.reconciling;
    this.reconciling=this.reconcileOwnedAudit({...active});
    try{return await this.reconciling;}finally{this.reconciling=null;}
  }
  async reconcileOwnedAudit(active){
    const w=this.workflow,id=active.operatingAuditId;
    if(!/^oversight-[a-zA-Z0-9-]+$/.test(id)||active.threadId!==w.state.threads.supervisor)throw Error('Supervisor stale audit has no exact operating ownership');
    const ownedReport=path.join(w.directory,'supervisor-audits',id,'audit');
    if(!active.dispatchFile)throw Error('Supervisor stale audit dispatch is outside its owned report');
    const expected=resolveInside(w.root,active.dispatchFile),relative=path.relative(ownedReport,expected);
    if(!inside(ownedReport,expected)||path.basename(expected)!=='dispatch.json'||relative.split(path.sep).slice(0,-1).some(part=>part!=='continuation'))throw Error('Supervisor stale audit dispatch is outside its owned report');
    const identity=fileIdentity(w.root,expected),dispatch=read(expected),requestFile=path.join(path.dirname(expected),'request.json');
    validateIdentities(w.root,[dispatch.requestIdentity]);const request=read(requestFile);
    const schema=ownedAuditSchema(w.root,path.dirname(ownedReport),request.schemaDigest);
    if(!samePin(dispatch.requestIdentity,fileIdentity(w.root,requestFile))||request.role!=='supervisor'||request.key!=='supervisor'||request.operatingAuditId!==id||request.schemaDigest!==digest(schema)||path.resolve(request.cwd??'')!==path.resolve(w.root)||dispatch.cwd!==request.cwd||dispatch.threadId!==active.threadId||!dispatch.turnId||active.turnId&&active.turnId!==dispatch.turnId)throw Error('Supervisor stale audit request or native identity does not match its owned dispatch');
    let history;
    try{history=await w.server.request('thread/read',{threadId:dispatch.threadId,includeTurns:true});}
    catch{
      const resumed=await w.server.request('thread/resume',{threadId:dispatch.threadId,cwd:w.root,sandbox:'read-only'});
      if(resumed.thread?.id!==dispatch.threadId)throw Error('Supervisor stale audit resumed a different native thread');
      history=await w.server.request('thread/read',{threadId:dispatch.threadId,includeTurns:true});
    }
    let turn=history.thread?.id===dispatch.threadId?history.thread.turns?.find(turn=>turn.id===dispatch.turnId):null;
    if(turn?.status==='inProgress'){
      await w.server.request('turn/interrupt',{threadId:dispatch.threadId,turnId:dispatch.turnId});
      for(let count=0;count<20;count++){
        history=await w.server.request('thread/read',{threadId:dispatch.threadId,includeTurns:true});turn=history.thread?.id===dispatch.threadId?history.thread.turns?.find(turn=>turn.id===dispatch.turnId):null;
        if(turn?.status!=='inProgress')break;await new Promise(resolve=>setTimeout(resolve,100));
      }
    }
    if(!turn||!['completed','failed','interrupted'].includes(turn.status))throw Error('Supervisor stale audit has not confirmed exact native termination');
    const file=path.join(path.dirname(expected),'native-audit-reconciliation.json');
    if(!fs.existsSync(file))atomicJSON(file,{version:1,dispatchIdentity:identity,requestIdentity:dispatch.requestIdentity,threadId:dispatch.threadId,turnId:dispatch.turnId,status:turn.status,at:stamp(),accepted:false});
    const receipt=read(file);if(!samePin(receipt.dispatchIdentity,identity)||receipt.threadId!==dispatch.threadId||receipt.turnId!==dispatch.turnId||receipt.accepted!==false)throw Error('Supervisor native reconciliation receipt changed');
    validateIdentities(w.root,[identity,dispatch.requestIdentity]);
    const current=w.state.activeTurns?.supervisor;
    if(current?.operatingAuditId!==id||current.threadId!==active.threadId||current.dispatchFile!==active.dispatchFile||current.turnId&&current.turnId!==dispatch.turnId)throw Error('Supervisor stale audit ownership changed during reconciliation');
    const reconciliationIdentity=fileIdentity(w.root,file);
    w.state.supervisorOversight??={};w.state.supervisorOversight.nativeAuditReconciliations??=[];
    if(!w.state.supervisorOversight.nativeAuditReconciliations.some(row=>samePin(row.reconciliationIdentity,reconciliationIdentity)))w.state.supervisorOversight.nativeAuditReconciliations.push({operatingAuditId:id,dispatchIdentity:identity,reconciliationIdentity});
    w.state.supervisorOversight.lastNativeReconciliation=reconciliationIdentity;
    if(samePin(w.state.supervisorOversight.interruptedAuditDispatchIdentity,identity))delete w.state.supervisorOversight.interruptedAuditDispatchIdentity;
    if(w.state.supervisorOversight.activeAuditId===id)delete w.state.supervisorOversight.activeAuditId;
    delete w.state.activeTurns.supervisor;w.save();return {identity:reconciliationIdentity,status:turn.status,accepted:false};
  }
  async interruptExpiredProductTurns(request){
    if(request.decision?.reasonCode!=='deadline_exceeded')return;
    const w=this.workflow;
    for(const [key,active]of Object.entries(w.state.activeTurns??{})){
      if(!/implementer|verifier|test-preparer/.test(key)||!active.turnId)continue;
      const deadline=Date.parse(active.deadlineAt??new Date(Date.parse(active.startedAt)+(w.config.turnTimeoutMs??3600000)).toISOString());
      if(!Number.isFinite(deadline)||Date.now()<deadline)continue;
      const history=await w.server.request('thread/read',{threadId:active.threadId,includeTurns:true});
      let turn=history.thread?.id===active.threadId?history.thread.turns?.find(t=>t.id===active.turnId):null;
      if(turn?.status==='inProgress'){
        await w.server.request('turn/interrupt',{threadId:active.threadId,turnId:active.turnId});
        for(let count=0;count<20;count++){
          const confirmed=await w.server.request('thread/read',{threadId:active.threadId,includeTurns:true});
          turn=confirmed.thread?.id===active.threadId?confirmed.thread.turns?.find(t=>t.id===active.turnId):null;
          if(turn?.status!=='inProgress')break;await new Promise(resolve=>setTimeout(resolve,100));
        }
      }
      if(!turn||!['completed','failed','interrupted'].includes(turn.status))throw Error('Expired product turn has not confirmed native termination');
      // Preserve its dispatch/candidate. Only a stale in-memory ownership row
      // is cleared; normal task turn reconciliation decides how to continue.
      const current=w.state.activeTurns?.[key];
      if(current?.threadId===active.threadId&&current.turnId===active.turnId)delete w.state.activeTurns[key];
      w.state.supervisorOversight.expiredProductTurn={threadId:active.threadId,turnId:active.turnId,status:turn.status,confirmedAt:stamp()};w.save();
    }
  }
  async reconcileInterruptedAudit(){
    const w=this.workflow,identity=w.state.supervisorOversight?.interruptedAuditDispatchIdentity;
    if(!identity)return;
    validateIdentities(w.root,[identity]);const dispatch=read(resolveInside(w.root,identity.path));validateIdentities(w.root,[dispatch.requestIdentity]);
    if(dispatch.threadId!==w.state.threads.supervisor)throw Error('Supervisor pending audit needs its exact native identity');
    let history;
    try{history=await w.server.request('thread/read',{threadId:dispatch.threadId,includeTurns:true});}
    catch{await w.server.request('thread/resume',{threadId:dispatch.threadId,cwd:w.root,sandbox:'read-only'});history=await w.server.request('thread/read',{threadId:dispatch.threadId,includeTurns:true});}
    if(history.thread?.id!==dispatch.threadId||!Array.isArray(history.thread.turns))throw Error('Supervisor audit native history is unconfirmed');
    let turn=history.thread.turns.find(t=>t.id===dispatch.turnId);
    if(!dispatch.turnId){
      const request=read(resolveInside(w.root,dispatch.requestIdentity.path)),directory=path.dirname(resolveInside(w.root,identity.path));
      const schema=ownedAuditSchema(w.root,path.dirname(directory),request.schemaDigest);
      if(request.role!=='supervisor'||request.key!=='supervisor'||!/^oversight-[a-zA-Z0-9-]+$/.test(request.operatingAuditId??'')||request.schemaDigest!==digest(schema)||request.cwd!==w.root||dispatch.cwd!==request.cwd||!request.prompt||path.basename(path.dirname(directory))!==request.operatingAuditId||!samePin(dispatch.requestIdentity,fileIdentity(w.root,path.join(directory,'request.json'))))throw Error('Unconfirmed supervisor audit is outside its original read-only request');
      const matches=history.thread.turns.filter(t=>t.items?.some(item=>item.type==='userMessage'&&item.content?.filter(part=>part.type==='text').map(part=>part.text).join('\n')===request.prompt));
      if(matches.length>1)throw Error('Supervisor audit native request match is ambiguous');
      turn=matches[0];
      // A lost start acknowledgement never authorizes a fabricated decision.
      // Preserve this read-only request as unaccepted; a fresh audit may proceed
      // only after the actual owning thread is confirmed to have no active turn.
      if(!turn&&history.thread.turns.some(t=>t.status==='inProgress'))throw Error('Unconfirmed supervisor audit still has active native work');
    }
    const nativeTurnId=turn?.id;
    if(turn?.status==='inProgress'){
      await w.server.request('turn/interrupt',{threadId:dispatch.threadId,turnId:nativeTurnId});
      for(let count=0;count<20;count++){
        history=await w.server.request('thread/read',{threadId:dispatch.threadId,includeTurns:true});turn=history.thread?.id===dispatch.threadId?history.thread.turns?.find(t=>t.id===nativeTurnId):null;
        if(turn?.status!=='inProgress')break;await new Promise(resolve=>setTimeout(resolve,100));
      }
    }
    if(((dispatch.turnId||nativeTurnId)&&!turn)||turn&&!['completed','failed','interrupted'].includes(turn.status))throw Error('Supervisor pending audit has not confirmed termination');
    const file=path.join(path.dirname(resolveInside(w.root,identity.path)),'native-audit-reconciliation.json');
    if(!fs.existsSync(file))atomicJSON(file,{version:1,dispatchIdentity:identity,threadId:dispatch.threadId,turnId:turn?.id??null,status:turn?.status??'no-active-native-turn',at:stamp(),accepted:false,...(!dispatch.turnId?{unconfirmedRequest:true,requestIdentity:dispatch.requestIdentity}:{})});
    w.state.supervisorOversight.lastNativeReconciliation=fileIdentity(w.root,file);delete w.state.supervisorOversight.interruptedAuditDispatchIdentity;w.save();
  }
  async interruptOperatingTurns(){
    const w=this.workflow;
    if(productActive(w.state))return;
    const turns=Object.entries(w.state.activeTurns??{}).filter(([key])=>key==='guardian'||key==='guardian-repair');
    // Guardian audit uses its own durable ownership marker rather than activeTurns.
    const guardian=w.state.guardian;
    if(guardian?.activeAuditId&&guardian.threadId&&!turns.some(([,a])=>a.threadId===guardian.threadId)){
      const history=await w.server.request('thread/read',{threadId:guardian.threadId,includeTurns:true});
      if(history.thread?.id!==guardian.threadId)throw Error('Supervisor cannot interrupt another operating thread');
      const active=history.thread.turns?.filter(t=>t.status==='inProgress');
      if(active?.length===1)turns.push(['guardian',{threadId:guardian.threadId,turnId:active[0].id}]);
    }
    // A confirmed hold can lose its active marker before repair admission.
    // Recheck the exact cited native turn before the repair engine takes its
    // single-owner lease; absence of an active marker is not termination proof.
    const pending=w.state.supervisorOversight?.pendingRepairIdentity;
    if(pending){
      validateIdentities(w.root,[pending]);const audit=read(resolveInside(w.root,pending.path));
      validateSupervisorRepairAuthority(w.root,w.state,audit);
      const snapshot=read(resolveInside(w.root,audit.snapshotIdentity.path)),held=snapshot.guardian?.lastAuditIdentity;
      if(snapshot.pendingExecutionIncident&&held&&audit.evidence.some(pin=>resolveInside(w.root,pin.path)===resolveInside(w.root,held.path)&&pin.sha256===held.sha256&&pin.byteLength===held.byteLength)){
        validateIdentities(w.root,[held]);const receipt=read(resolveInside(w.root,held.path));
        if(receipt.result?.decision==='hold'&&receipt.result.recovery?.action==='none'){
          validateIdentities(w.root,[receipt.requestIdentity,receipt.responseIdentity]);const response=read(resolveInside(w.root,receipt.responseIdentity.path));
          if(receipt.runId!==w.state.runId||receipt.guardianThreadId!==guardian?.threadId||response.threadId!==receipt.guardianThreadId||!response.turnId||!samePin(response.requestIdentity,receipt.requestIdentity))throw Error('Supervisor repair lost the exact held guardian turn');
          if(!turns.some(([,turn])=>turn.threadId===response.threadId&&turn.turnId===response.turnId))turns.push(['guardian',{threadId:response.threadId,turnId:response.turnId}]);
        }
      }
    }
    for(const [,active]of turns){
      if(!active.turnId)continue;
      const history=await w.server.request('thread/read',{threadId:active.threadId,includeTurns:true});
      if(history.thread?.id!==active.threadId)throw Error('Supervisor operating turn ownership mismatch');
      let turn=history.thread.turns?.find(t=>t.id===active.turnId);
      if(turn?.status==='inProgress'){
        await w.server.request('turn/interrupt',{threadId:active.threadId,turnId:active.turnId});
        for(let count=0;count<20;count++){
          const confirmed=await w.server.request('thread/read',{threadId:active.threadId,includeTurns:true});
          turn=confirmed.thread?.id===active.threadId?confirmed.thread.turns?.find(t=>t.id===active.turnId):null;
          if(turn?.status!=='inProgress')break;await new Promise(resolve=>setTimeout(resolve,100));
        }
      }
      if(!turn||!['completed','failed','interrupted'].includes(turn.status))throw Error('Supervisor operating interruption has not confirmed native termination');
      // Do not erase ownership: guardian-repair's original request and mirror
      // must still be reconciled by its engine before a new worker can start.
      w.state.supervisorOversight??={};w.state.supervisorOversight.confirmedOperatingTurns??=[];
      if(!w.state.supervisorOversight.confirmedOperatingTurns.some(t=>t.threadId===active.threadId&&t.turnId===active.turnId))w.state.supervisorOversight.confirmedOperatingTurns.push({threadId:active.threadId,turnId:active.turnId,status:turn.status,confirmedAt:stamp()});
      w.state.supervisorOversight.confirmedOperatingTurns=w.state.supervisorOversight.confirmedOperatingTurns.slice(-16);w.save();
    }
  }
  async applyPendingRepair(){
    const w=this.workflow,identity=w.state.supervisorOversight?.pendingRepairIdentity;
    if(!identity||this.busy||w.controllerRepair?.busy)return false;
    if(w.stopped||needsExternalInput(w.state)||fs.existsSync(path.join(w.directory,'stop.json')))return false;
    if(productActive(w.state))return false;
    await this.interruptOperatingTurns();
    await w.controllerRepair.reconcilePending?.();
    if(Object.keys(w.state.activeTurns??{}).length||w.guardian.inspecting)return false;
    // The repair engine validates this distinct supervisor authority and uses
    // one synchronous owner lease for both guardian and supervisor requests.
    const targets=[w.state.approvedProductTarget,...(w.state.currentTasks??[]).map(id=>w.state.tasks[id]?.target)].filter(Boolean);
    const result=await w.controllerRepair.repair({auditIdentity:identity,phase:'supervisor_oversight',targets});
    this.recordRepairHandoff(identity,result);
    if(result.status!=='applied'){
      this.recordOperatingFailure(w.state.supervisorOversight.pendingRepairIncident,result.receiptIdentity);
      // A cached failed repair must not cause an endless immediate reload of
      // the same authorization. Preserve it and let the external clock request
      // the next bounded independent audit instead.
      w.state.supervisorOversight.failedRepairs??=[];w.state.supervisorOversight.failedRepairs.push({sourceAudit:identity,receiptIdentity:result.receiptIdentity??null,at:stamp(),summary:result.summary});
      delete w.state.supervisorOversight.pendingRepairIdentity;delete w.state.supervisorOversight.pendingRepairIncident;w.state.supervisorOversight.status='failed';w.state.supervisorOversight.lastSummary=result.summary;w.oversightReloadRequested=false;w.save();
      const error=Error(`Supervisor operating repair blocked: ${result.summary}`);error.guardianHandled=true;throw error;
    }
    w.state.supervisorOversight.status='repair_applied_awaiting_product';delete w.state.supervisorOversight.pendingRepairIdentity;delete w.state.supervisorOversight.pendingRepairIncident;
    w.oversightReloadRequested=false;w.state.status='reloading_orchestration';w.save();
    const error=Error('Supervisor operating repair passed checks; reload with product receipts preserved');error.code='OPERATING_REPAIR_APPLIED';error.guardianHandled=true;throw error;
  }
  recordRepairHandoff(identity,result){
    const w=this.workflow;validateIdentities(w.root,[identity]);const audit=read(resolveInside(w.root,identity.path));
    validateSupervisorRepairAuthority(w.root,w.state,audit);
    const snapshot=read(resolveInside(w.root,audit.snapshotIdentity.path)),original=snapshot.guardian?.lastAuditIdentity,current=w.state.guardian?.lastAuditIdentity;
    const candidates=original?[{identity:original,source:'snapshot'}]:[];
    // At this quiescent, fenced handoff the old guardian authorization refers
    // to pre-handoff code. Preserve it without claiming its cause was resolved.
    if(current&&!samePin(current,original))candidates.push({identity:current,source:'handoff-fenced'});
    w.state.supervisorOversight.supersededGuardianAudits??=[];
    for(const candidate of candidates){
      validateIdentities(w.root,[candidate.identity]);
      if(!w.state.supervisorOversight.supersededGuardianAudits.some(row=>samePin(row.guardianAuditIdentity,candidate.identity)&&samePin(row.supervisorAuditIdentity,identity)))w.state.supervisorOversight.supersededGuardianAudits.push({guardianAuditIdentity:candidate.identity,supervisorAuditIdentity:identity,repairReceiptIdentity:result.receiptIdentity??null,repairStatus:result.status==='applied'?'applied':'blocked',source:candidate.source,at:stamp()});
    }
    if(result.status==='applied'&&samePin(snapshot.pendingExecutionIncident,w.state.pendingExecutionIncident)){
      const incident=w.state.pendingExecutionIncident;validateIdentities(w.root,[incident]);
      w.state.supervisorOversight.addressedExecutionIncidents??=[];
      w.state.supervisorOversight.addressedExecutionIncidents.push({incidentIdentity:incident,supervisorAuditIdentity:identity,repairReceiptIdentity:result.receiptIdentity??null,at:stamp()});
      delete w.state.pendingExecutionIncident;
    }
  }
}

export async function drainSupervisorAudit(workflow){
  if(!workflow?.oversight)return;
  // Seal admission before draining. A timer tick after the final audit cannot
  // dispatch another request onto a transport that is about to close.
  workflow.oversight.closing=true;
  if(workflow.oversight.reconciling)await workflow.oversight.reconciling;
  await workflow.oversight.waitForIdle();
  if(workflow.stopped||workflow.state.status==='standby'||completedProductBlock(workflow.state)&&!productBlockNeedsResolution(workflow.state))return;
  if(workflow.state.supervisorOversight?.pendingRepairIdentity){
    workflow.state.status='reloading_orchestration';workflow.state.error=null;workflow.save();
  }
}

export function validateSupervisorRepairAuthority(root,state,audit){
  let provenance;
  return validateSupervisorAuthority(root,state,audit,pins=>{
    for(const pin of pins){
      try{validateIdentities(root,[pin]);}
      catch(error){
        // Applied repairs may replace source cited by their own authorization.
        // Only the fully verified maintenance chain can authenticate old bytes.
        provenance??=operatingMaintenanceAuditEvidence(root,state);
        const link=provenance?.repairChain?.find(row=>digest(read(resolveInside(root,row.sourceAudit.path)))===digest(audit));
        const before=link?.changes.find(change=>change.before&&resolveInside(root,change.path)===resolveInside(root,pin.path)&&change.before.sha256===pin.sha256&&change.before.byteLength===pin.byteLength)?.before;
        if(!before)throw error;
        validateIdentities(root,[before]);
      }
    }
  });
}

function validateSupervisorAuthority(root,state,audit,validate){
  if(audit.kind!=='supervisor-operating-audit'||audit.authority!=='supervisor-oversight'||audit.supervisorThreadId!==state.threads?.supervisor)throw Error('Operating repair requires confirmed supervisor authority');
  validate([audit.requestIdentity,audit.responseIdentity,audit.triggerIdentity,audit.snapshotIdentity,...audit.evidence]);
  const response=read(resolveInside(root,audit.responseIdentity.path));
  if(!response.turnId||response.result?.action!=='repair_controller'||response.result.reason!==audit.result?.recovery?.reason||response.requestIdentity.sha256!==audit.requestIdentity.sha256||JSON.stringify(response.result.evidencePaths)!==JSON.stringify(audit.result?.recovery?.evidencePaths))throw Error('Supervisor repair decision does not match its confirmed native response');
  if(audit.evidence.length!==response.result.evidencePaths.length||!audit.evidence.every((pin,index)=>resolveInside(root,pin.path)===resolveInside(root,response.result.evidencePaths[index])))throw Error('Supervisor repair evidence differs from its confirmed native citations');
  if(audit.schemaIdentity||audit.evidenceManifestIdentity){
    validate([audit.schemaIdentity,audit.evidenceManifestIdentity]);
    const schema=read(resolveInside(root,audit.schemaIdentity.path)),allowed=boundSchemaPaths(schema),manifest=read(resolveInside(root,audit.evidenceManifestIdentity.path)),request=read(resolveInside(root,audit.requestIdentity.path));
    if(request.schemaDigest!==digest(schema)||manifest.version!==1||!Array.isArray(manifest.inputs)||digest(manifest.inputs.map(pin=>pin.path))!==digest(allowed)||response.result.evidencePaths.some(name=>!allowed.includes(name))||!audit.evidence.every(pin=>manifest.inputs.some(expected=>samePin(expected,pin))))throw Error('Supervisor repair is outside its pinned evidence contract');
    validate(manifest.inputs);
  }
}
