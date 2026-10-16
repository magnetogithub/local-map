import fs from 'node:fs';
import path from 'node:path';
import {atomicJSON,resolveInside,inside,fileIdentity,validateIdentities,validateVerification,REPAIR_REVIEWS,GATES,TASK_GATES} from './protocol.mjs';
import {readTaskPlan} from './task-plan.mjs';
import {assertLaunchAllowed} from './launch-policy.mjs';
import {captureProductTarget,validateProductTarget as validateBoundProductTarget,attestProductTarget,productSnapshot,digest} from './product-target.mjs';
import {prepareWorkspace,planWorkspaceMerge,applyWorkspaceMerge} from './workspaces.mjs';
import {createVerificationStages} from './verification-stages-compact.mjs';
import {TASK_ASSIGNMENT_SCHEMA,TASK_IMPLEMENTATION_SCHEMA,CONTROLLER_TASK_IMPLEMENTATION_SCHEMA,TEST_PREPARATION_SCHEMA,TASK_ASSESSMENT_SCHEMA,TASK_RELAY_SCHEMA,REVIEW_DECISION_SCHEMA,validateAssignment,disjointAssignments,readyTasks,invalidateDescendants} from './task-protocol.mjs';
import {TaskGuardian} from './task-guardian.mjs';
import {prepareTaskInputs,prepareControllerImplementationInputs,normalizeImplementationInputs,validateImplementationInputRoles} from './task-inputs.mjs';
import {GuardianControllerRepair,REPAIR_ENGINE_VERSION} from './guardian-repair.mjs';
import {taskNextAction} from './task-progress.mjs';
import {attestVitest,applyVitestResult,validateAttestedVitestInputs} from './vitest-acceptance.mjs';
import {reconcileLegacyVitestTurn} from './vitest-transition.mjs';
import {captureEnvironmentEvidence,readVerifierRecovery} from './verifier-recovery.mjs';
import {persistTaskContract,deterministicAssignment,validateContractIdentity,taskContract} from './task-contracts.mjs';
import {freezeAcceptanceSuite,frozenAcceptanceSuite,verifyControllerTask,selectedHarnessRevisionFile} from './controller-task-verification.mjs';
import {harnessRecoveryInstructions} from './harness-recovery.mjs';
import {markProgress,beginRecovery,completeRecovery,oversightExhausted,needsExternalInput,productBlockNeedsResolution} from './operating-recovery.mjs';
import {resolveInternalProductBlock,internalBlockInstructions} from './product-block-resolution.mjs';
import {reconcileImplementationTurn} from './turn-reconciliation.mjs';
import {selectTaskBatch,concurrencyLimit,implementationSessionKey} from './task-scheduler.mjs';
import {SupervisorOversight,validateSupervisorRepairAuthority,guardianRepairReplayAllowed} from './supervisor-oversight.mjs';
import {beginOperation,endOperation} from './execution-lifecycle.mjs';
import {confirmedReviewRepair,taskAttemptMismatch} from './review-repair.mjs';

const read=file=>JSON.parse(fs.readFileSync(file,'utf8'));
const stamp=()=>new Date().toISOString();
// A routing decision is not a product verdict or a whole REVIEW approval.
const BLOCKED_PRODUCT_DECISION_SCHEMA={type:'object',additionalProperties:false,required:['taskId','review','candidateRoot','action','repairTaskIds','summary','instructions'],properties:{taskId:{type:'string'},review:{type:'string'},candidateRoot:{type:'string'},action:{type:'string',enum:['verify','repair','blocked']},repairTaskIds:{type:'array',items:{type:'string'}},summary:{type:'string'},instructions:{type:'string'}}};

// A BLOCKED packet has no product target yet. Authenticate the same nested
// execution-tool receipt on routing/reuse as on later verification handoffs.
function validateBlockedProductInputRoles(root,packet,implementation){
  validateImplementationInputRoles(root,{productRoot:packet.candidateRoot,requestIdentity:packet.requestIdentity,responseIdentity:packet.confirmedResponseIdentity,turnId:implementation.turnId},{extraInputs:packet.inputs});
}

// Adapt delivery paths only. Ownership and actual workspace deltas are still
// checked by planWorkspaceMerge, including undeclared writes and conflicts.
export function normalizeImplementationChanges(candidateRoot,changedFiles){
  const root=path.resolve(candidateRoot);
  if(!Array.isArray(changedFiles)||fs.lstatSync(root).isSymbolicLink()||!fs.statSync(root).isDirectory())throw Error('Invalid implementation candidate/changedFiles');
  return changedFiles.map(name=>{
    if(typeof name!=='string'||!name.trim()||name.includes('\0'))throw Error('Invalid implementation change path');
    const portable=name.replaceAll('\\','/');
    if(portable.split('/').includes('..'))throw Error(`Implementation path traversal: ${name}`);
    // Reject foreign absolute paths and drive-relative/alternate-stream paths.
    if(!path.isAbsolute(name)&&(path.win32.isAbsolute(name)||portable.includes(':')))throw Error(`Invalid implementation change path: ${name}`);
    const file=path.resolve(root,portable);
    if(!inside(root,file)||file===root)throw Error(`Implementation change escapes candidate: ${name}`);
    const relative=path.relative(root,file).replaceAll('\\','/');
    if(relative.includes(':'))throw Error(`Invalid implementation change path: ${name}`);
    // Inspect every existing ancestor, including for deletions whose leaf no
    // longer exists. Never turn a path through a link into an owned file name.
    let current=root;
    for(const part of relative.split('/')){
      current=path.join(current,part);
      try{if(fs.lstatSync(current).isSymbolicLink())throw Error(`Implementation change uses a link: ${name}`);}
      catch(error){if(error.code==='ENOENT')break;throw error;}
    }
    return relative;
  });
}

// REVIEW source is the integrated workspace. Frozen task candidates and their
// inputs are historical evidence, authenticated separately on every handoff.
// The bound projection and original closure are both immutable target inputs;
// a pin on the closure alone is never sufficient to authenticate its leaves.
function validateProductTarget(root,target){
  const manifest=validateBoundProductTarget(root,target);
  validateImplementationInputRoles(root,target,manifest);
  for(const pin of manifest.extraInputs.filter(pin=>path.basename(pin.path)==='review-product-inputs.json')){
    const projection=read(resolveInside(root,pin.path)),history=projection.historicalEvidence;
    if(projection.kind!=='review-product-inputs'||projection.version!==1||projection.productRoot!==target.productRoot||projection.review!==target.review||!history||!Array.isArray(projection.inputs))throw Error('Target binding: invalid REVIEW input roles');
    const closureFile=resolveInside(root,history.path);
    if(closureFile!==path.join(path.dirname(resolveInside(root,pin.path)),'task-input-closure.json')||!projection.inputs.some(input=>digest(input)===digest(history))||!manifest.extraInputs.some(input=>digest(input)===digest(history)))throw Error('Target binding: REVIEW historical closure is not bound');
    validateIdentities(root,projection.inputs);
    for(const input of projection.inputs)if(digest(input)!==digest(history)&&!inside(target.productRoot,resolveInside(root,input.path)))throw Error('Target binding: REVIEW selected non-current product input');
    const closure=read(closureFile);
    if(closure.version!==1||!Array.isArray(closure.inputs))throw Error('Target binding: invalid REVIEW historical closure');
    validateIdentities(root,closure.inputs);
  }
  return manifest;
}

// Delivery adaptation only: never infer an identity from an unpinned file or
// change the verifier's verdict. Protocol validation still runs on the result.
export function normalizeVerificationDelivery(root,report,result,originalEvidence=result.evidence,normalization=[]){
  root=path.resolve(root);report=resolveInside(root,report);
  const realReport=fs.realpathSync(report),value=structuredClone(result);
  const resolve=(name,evidence)=>{
    if(typeof name!=='string'||!name.trim())throw Error('Empty evidence path');
    const portable=name.replaceAll('\\','/');
    if(portable.split('/').includes('..'))throw Error(`Evidence path traversal: ${name}`);
    const candidates=path.isAbsolute(name)?[name]:[path.resolve(root,name),path.resolve(report,name)];
    // Some responses include the current report's basename exactly once.
    // Do not search siblings, historical reports, or match arbitrary suffixes.
    if(!path.isAbsolute(name)&&portable.startsWith(path.basename(report)+'/'))candidates.push(path.resolve(report,portable.slice(path.basename(report).length+1)));
    const files=new Map();
    for(const candidate of new Set(candidates)){
      const file=resolveInside(root,candidate);
      if(!fs.existsSync(file))continue;
      const real=fs.realpathSync(file);
      if(evidence&&(!inside(report,file)||!inside(realReport,real)))throw Error(`Evidence escapes current report: ${name}`);
      if(!fs.statSync(file).isFile())throw Error(`Evidence is not a file: ${name}`);
      files.set(process.platform==='win32'?real.toLowerCase():real,real);
    }
    if(files.size!==1)throw Error(`${files.size?'Ambiguous evidence path':'Evidence file not found within project'}: ${name}`);
    return path.relative(root,[...files.values()][0]).replaceAll('\\','/');
  };
  value.evidence=value.evidence.map(pin=>({...pin,path:resolve(pin.path,true)}));
  value.inputs=value.inputs.map(pin=>({...pin,path:resolve(pin.path,false)}));
  // Authenticate the original pins before reading any manifest contents.
  validateIdentities(root,value.evidence);validateIdentities(root,value.inputs);
  value.checks=value.checks.map(check=>({...check,evidencePaths:check.evidencePaths.map(name=>resolve(name,true))}));
  value.commands=value.commands.map(command=>({...command,evidencePath:resolve(command.evidencePath,true)}));
  const pins=new Map(value.evidence.map(pin=>[pin.path,pin]));
  const missing=[...new Set([...value.checks.flatMap(check=>check.evidencePaths),...value.commands.map(command=>command.evidencePath)])].filter(name=>!pins.has(name));
  if(missing.length){
    const sources=[];
    for(const filename of ['final-evidence.json','independent-verdict.json']){
      const manifestName=path.relative(root,path.join(report,filename)).replaceAll('\\','/');
      const manifestPin=pins.get(manifestName);
      // Controller-added evidence cannot authenticate another document. Only
      // these exact, current-report documents pinned by the native response can.
      if(!manifestPin||!originalEvidence.some(pin=>pin.sha256===manifestPin.sha256&&pin.byteLength===manifestPin.byteLength&&resolve(pin.path,true)===manifestName))continue;
      validateIdentities(root,[manifestPin]);
      const manifest=read(resolveInside(root,manifestPin.path)),independent=filename==='independent-verdict.json';
      if(independent){
        for(const key of ['taskId','review','candidateRoot','targetId','verdict','nonPassKind'])if(typeof value[key]!=='string'||!value[key]||manifest[key]!==value[key])throw Error(`Pinned independent verdict binding mismatch: ${key}`);
      }
      const declared=independent?manifest.evidence:manifest.outputs;
      if(!Array.isArray(declared))throw Error(`Pinned ${filename} needs explicit ${independent?'evidence':'outputs'}`);
      sources.push({manifestPin,independent,outputs:declared.map(pin=>({...pin,path:resolve(pin.path,true)}))});
    }
    if(!sources.length)throw Error(`Gate evidence is not attested: ${missing[0]}`);
    for(const name of missing){
      const matches=[];
      for(const source of sources){
        const declarations=source.outputs.filter(pin=>pin.path===name);
        if(source.independent&&declarations.length>1)throw Error(`Independent verdict needs a unique gate pin: ${name}`);
        for(const pin of declarations)matches.push({source,pin});
      }
      if(!matches.length)throw Error(`Gate evidence is not attested by pinned outputs/evidence: ${name}`);
      // Validate every declaration, so a conflicting source cannot be hidden
      // by a good pin in another authenticated document.
      validateIdentities(root,matches.map(match=>match.pin));pins.set(name,matches[0].pin);
      for(const {source,pin} of matches)if(source.independent)normalization.push({source:source.manifestPin,evidence:pin});
    }
    validateIdentities(root,sources.map(source=>source.manifestPin));
  }
  value.evidence=[...pins.values()];
  return value;
}

// Task state and exact turn receipts are durable. A missing confirmed response
// always holds; the controller never guesses that a previously dispatched turn
// did no work, and never counts an environmental hold as a product failure.
export class TaskWorkflow {
  constructor({root,directory,config,configFile=null,server,log=()=>{},resume=false,vitestAttestor=attestVitest}){
    this.root=path.resolve(root);this.directory=path.resolve(directory);this.config=config;this.configFile=configFile;this.server=server;this.log=log;this.plan=readTaskPlan();this.stopped=false;
    this.stateFile=path.join(directory,'state.json');
    this.state=resume?read(this.stateFile):{version:2,implementationUnit:'task',runtimeVersion:13,runId:path.basename(directory),projectRoot:this.root,status:'initializing',review:'A',entryReview:'A',phase:'prepare',round:0,repairAttempts:0,threads:{},threadNames:{},certificates:{},tasks:Object.fromEntries(this.plan.tasks.map(t=>[t.id,{status:'pending',attempt:0}])),createdAt:stamp(),nextAction:'Start 15-01 after guardian intake'};
    if(this.state.projectRoot!==this.root||this.state.implementationUnit!=='task')throw Error('Task runtime cannot resume another root or legacy REVIEW run');
    this.loadedThreads=new Set();
    if(resume&&(this.state.activeOperation||Object.keys(this.state.activeOperations??{}).length)){
      this.state.interruptedOperations={operations:this.state.activeOperations??{},operation:this.state.activeOperation??null,observedAt:stamp()};
      delete this.state.activeOperation;delete this.state.activeOperations;
    }
    this.state.taskVerificationMode=this.config.taskVerificationMode??'independent-agent';
    this.vitestAttestor=vitestAttestor;
    this.guardian=new TaskGuardian({root:this.root,directory:this.directory,config:this.config,server:this.server,log:this.log,state:this.state,save:()=>this.save()});
    this.controllerRepair=new GuardianControllerRepair({root:this.root,directory:this.directory,config:this.config,server:this.server,state:this.state,save:()=>this.save(),log:this.log,waitForAudit:()=>this.oversight.waitForIdle()});
    this.oversight=new SupervisorOversight(this);
    this.onNotification=({method,params})=>{
      const key=Object.keys(this.state.threads).find(k=>this.state.threads[k]===params.threadId);
      if(!key)return;
      const active=this.state.activeTurns?.[key];
      if(!active)return;
      active.lastActivityAt=stamp();
      if(['commandExecution','mcpToolCall','fileChange','webSearch'].includes(params.item?.type)){
        active.lastToolActivityAt=stamp();this.state.lastToolActivityAt=active.lastToolActivityAt;
        active.runningCommands??={};
        if(method==='item/started')active.runningCommands[params.item.id]={type:params.item.type,startedAt:stamp()};
        if(method==='item/completed')delete active.runningCommands[params.item.id];
      }
      if(method==='turn/started'){
        active.turnId=params.turn?.id;
        if(active.dispatchFile){const dispatch=read(active.dispatchFile);atomicJSON(active.dispatchFile,{...dispatch,turnId:active.turnId});}
      }
      // Streaming activity stays in memory; ownership changes flush immediately.
      if(method==='turn/started')this.save();
      else if(!this.notificationSaveTimer)this.notificationSaveTimer=setTimeout(()=>{this.notificationSaveTimer=null;this.save();},1000);
    };
    this.server.on?.('notification',this.onNotification);
    this.notificationsAttached=true;
  }
  relative(file){return path.relative(this.root,file).replaceAll('\\','/');}
  async withProductOperation(key,action){
    const operation=beginOperation(this.state,key,'product-handoff','controller-work',600000);this.save();
    try{return await action();}finally{endOperation(this.state,key,operation.id);this.save();}
  }
  productOperationKey(context){return context.operatingAuditId?null:context.taskId?`product-task-${context.taskId}`:context.review?`product-review-${context.review}`:null;}
  updateProductPhase(context,phase,timeoutMs=600000){
    const key=this.productOperationKey(context),operation=key&&this.state.activeOperations?.[key];
    if(operation)Object.assign(operation,{phase,deadlineAt:new Date(Date.now()+timeoutMs).toISOString()});
  }
  recordProductResponse(key,response,identity){
    if(!response.turnId||!response.completedAt)throw Error('Product progress needs a confirmed response');
    validateIdentities(this.root,[identity,response.requestIdentity]);
    this.state.productResponses??={};this.state.productResponses[key]={identity,completedAt:response.completedAt,turnId:response.turnId};
  }
  recoverReviewResponseProgress(){
    const attempt=this.state.activeReviewAttempt;if(!attempt)return;
    const suffix=attempt.verificationRevision?`-recovery-${attempt.verificationRevision}`:'',directory=path.join(this.directory,'reviews',`${attempt.review}-${attempt.number}`,`verification${suffix}`);
    const file=path.join(directory,'response.json');if(!fs.existsSync(file))return;
    const response=read(file),request=read(path.join(directory,'request.json')),dispatch=read(path.join(directory,'dispatch.json'));
    const target=read(path.join(path.dirname(directory),'target/target.json'));
    validateIdentities(this.root,[response.requestIdentity,dispatch.requestIdentity]);
    if(request.role!=='verifier'||request.review!==attempt.review||request.schemaDigest!==digest(TASK_ASSESSMENT_SCHEMA)||response.schemaDigest!==request.schemaDigest||digest(response.requestIdentity)!==digest(fileIdentity(this.root,path.join(directory,'request.json')))||digest(dispatch.requestIdentity)!==digest(response.requestIdentity)||dispatch.turnId!==response.turnId||response.cwd!==request.cwd||target.productRoot!==request.cwd||response.result.targetId!==target.targetId||response.result.candidateRoot!==target.productRoot||response.productSourceDigest!==digest(productSnapshot(target.productRoot)))throw Error('Recovered REVIEW progress does not match its confirmed target and native request');
    validateProductTarget(this.root,target);this.recordProductResponse(request.key,response,fileIdentity(this.root,file));this.save();
  }
  normalizeConfirmedVerification(report,response){
    const source=response.responseIdentity;
    validateIdentities(this.root,[source]);
    if(resolveInside(this.root,source.path)!==path.join(report,'response.json'))throw Error('Verification normalization needs the current confirmed response');
    const original=read(resolveInside(this.root,source.path));
    if(digest(original.result)!==digest(response.result))throw Error('Verification normalization response binding mismatch');
    const evidenceLinks=[];
    const result=normalizeVerificationDelivery(this.root,report,captureEnvironmentEvidence(this.root,report,response.result),response.result.evidence,evidenceLinks);
    const file=path.join(report,'normalized-response.json'),record={version:1,kind:'verification-delivery',sourceResponse:source,result};
    if(evidenceLinks.length)record.evidenceLinks=evidenceLinks;
    validateIdentities(this.root,[source]);
    if(fs.existsSync(file)){if(digest(read(file))!==digest(record))throw Error('Normalized verification response changed');}else atomicJSON(file,record);
    return result;
  }
  confirmedImplementationChanges(task,response){
    const row=this.state.tasks[task.id],source=response.responseIdentity;
    const report=path.join(row.attemptDirectory,row.implementationRevision??'implementation');
    validateIdentities(this.root,[source,response.requestIdentity]);
    if(resolveInside(this.root,source.path)!==path.join(report,'response.json'))throw Error('Implementation normalization needs the current confirmed response');
    const original=read(resolveInside(this.root,source.path)),candidateRoot=path.resolve(row.workspace.directory);
    if(!response.turnId||original.turnId!==response.turnId||digest(original.requestIdentity)!==digest(response.requestIdentity)||digest(original.result)!==digest(response.result)||original.cwd!==candidateRoot||original.result.taskId!==task.id||path.resolve(original.result.candidateRoot)!==candidateRoot)throw Error('Implementation normalization response binding mismatch');
    const requestFile=path.join(report,'request.json'),request=read(requestFile);
    if(digest(fileIdentity(this.root,requestFile))!==digest(response.requestIdentity)||request.role!=='implementer'||request.taskId!==task.id||request.review!==this.taskReview(task)||request.cwd!==candidateRoot||request.schemaDigest!==original.schemaDigest)throw Error('Target binding: implementation request belongs to another attempt');
    const changedFiles=normalizeImplementationChanges(candidateRoot,original.result.changedFiles);
    const file=path.join(report,'normalized-implementation-changes.json');
    const record={version:1,kind:'implementation-change-paths',sourceResponse:source,requestIdentity:response.requestIdentity,turnId:response.turnId,taskId:task.id,candidateRoot,changes:original.result.changedFiles.map((reported,index)=>({reported,relative:changedFiles[index]}))};
    validateIdentities(this.root,[source,response.requestIdentity]);
    if(fs.existsSync(file)){if(digest(read(file))!==digest(record))throw Error('Normalized implementation changes changed');}else atomicJSON(file,record);
    row.implementationNormalization=fileIdentity(this.root,file);
    return changedFiles;
  }
  get controllerVitest(){return this.config?.taskVerificationMode==='controller-vitest';}
  save(){
    markProgress(this.state);this.state.nextAction=taskNextAction(this.state);this.state.updatedAt=stamp();
    atomicJSON(this.stateFile,this.state);
    const previousDisplayError=this.state.progressDisplayError;
    this.writeProgress();
    if(previousDisplayError!==this.state.progressDisplayError){
      // The handoff is already durable. Persist display diagnostics (including
      // recovery) without making their publication a new handoff prerequisite.
      try{atomicJSON(this.stateFile,this.state);}catch{/* Retry diagnostic persistence on the next save. */}
    }
  }
  writeProgress(){
    this.state.nextAction=taskNextAction(this.state);
    const s=this.state,active=Object.entries(s.activeTurns??{});
    const guardianStatus=s.guardian?.activeAuditId?'audit-running':this.controllerVitest?'event-driven':s.guardian?.lastDecision??'ready';
    const lines=['PROMPT 15 — 48개 독립 태스크 오케스트레이션',`상태: ${s.status} | REVIEW ${s.review} | 단계: ${s.phase}`,`검증 PASS: ${Object.values(s.tasks).filter(t=>t.status==='pass').length}/48`,`현재 태스크: ${(s.currentTasks??[]).join(', ')||'-'}`,`다음 동작: ${s.nextAction??'-'}`,...(s.error?[`현재 오류: ${s.error.slice(0,800)}`]:[]),`제품 기준 후보: ${s.approvedProductTarget?.productRoot??'-'}`,`운영 감시: ${guardianStatus} | 세션 ${s.guardian?.threadId??'-'} | 마지막 점검 ${s.guardian?.lastCheckedAt??'-'}`,`REVIEW: ${REPAIR_REVIEWS.map(r=>`${r} ${s.certificates[r]?'PASS':'대기'}`).join(' → ')}`,...active.map(([key,v])=>`${key}: ${v.taskId??v.review} | 마지막 도구 실행 ${v.lastToolActivityAt??'아직 없음'} | 실행 중 ${Object.keys(v.runningCommands??{}).length}`),'','태스크 상태',...this.plan.tasks.map(t=>`${t.id} [${s.tasks[t.id].status}] ${t.title}`),'',`heartbeat: ${s.heartbeatAt??'-'} (프로세스 생존 표시; 작업 진척 증거와 별도)`,`마지막 도구 실행: ${s.lastToolActivityAt??'-'}`,`갱신: ${s.updatedAt}`];
    // A separate observer owns bounded role-message collection. Preserve its
    // display block in controller refreshes; it never affects task decisions.
    try{
      const cache=read(path.join(this.directory,'session-progress.json'));
      if(cache.version===1&&Array.isArray(cache.lines)&&cache.lines.length<=600&&Buffer.byteLength(JSON.stringify(cache.lines))<=512*1024&&cache.lines.every(line=>typeof line==='string'&&line.length<=1000)){
        const position=lines.indexOf('태스크 상태');lines.splice(position,0,...cache.lines,'');
      }
    }catch{/* Optional status display must never interrupt product work. */}
    const file=path.join(this.directory,'progress.txt'),temporary=path.join(this.directory,`.progress-${process.pid}.tmp`);
    let attempts=0;
    try{
      fs.writeFileSync(temporary,lines.join('\n')+'\n');
      const pause=new Int32Array(new SharedArrayBuffer(4));
      for(;;){
        attempts++;
        try{fs.renameSync(temporary,file);break;}
        catch(error){
          if(!['EPERM','EACCES','EBUSY'].includes(error.code)||attempts>=4)throw error;
          Atomics.wait(pause,0,0,15*attempts);
        }
      }
      delete this.state.progressDisplayError;
    }
    catch(error){
      // Display is never an authority or a prerequisite for native completion.
      // Windows editors/observers may briefly deny replacement of an open file.
      this.state.progressDisplayError={code:error.code??'UNKNOWN',at:stamp(),message:String(error.message).slice(0,400),attempts};
      if(['EPERM','EACCES','EBUSY'].includes(error.code)){
        try{fs.writeFileSync(file,lines.join('\n')+'\n');delete this.state.progressDisplayError;}catch{/* Keep the prior display; product state is already durable. */}
      }
      try{if(fs.existsSync(temporary))fs.unlinkSync(temporary);}catch{/* Retry display on the next heartbeat. */}
    }
  }
  event(kind,detail={}){
    if(['task_pass','review_pass'].includes(kind)&&this.state.supervisorOversight?.status==='repair_applied_awaiting_product'){
      this.state.supervisorOversight.status='resolved';this.state.supervisorOversight.resolvedAt=stamp();this.state.supervisorOversight.lastSummary='운영 수리 이후 실제 제품 검증 PASS를 확인했습니다.';
    }
    this.log({kind,review:this.state.review,...detail});
    if(['task_pass','review_pass','task_verification_completed'].includes(kind)){
      const at=stamp(),subject=detail.taskId??`REVIEW ${this.state.review}`,outcome=kind==='task_verification_completed'?detail.verdict:'pass';
      const notification={id:`${this.state.runId}:${kind}:${subject}:${detail.targetId??detail.verification}`,at,recordedAt:at,title:`Prompt15 · ${subject} ${outcome.toUpperCase()}`,body:`${kind==='review_pass'?'전체 REVIEW 승인':kind==='task_pass'?'독립 태스크 검증 PASS 및 병합 완료':'독립 태스크 판정'} · ${detail.verification??''}`,review:this.state.review,role:'오케스트레이션',outcome};
      fs.appendFileSync(path.join(this.directory,'notifications.jsonl'),JSON.stringify(notification)+'\n');
      fs.appendFileSync(path.join(this.directory,'notifications.txt'),`[${at}] ${notification.title}\n${notification.body}\n\n`);
    }
  }
  ensureRunning(){if(this.stopped||fs.existsSync(path.join(this.directory,'stop.json')))throw Error('Task controller stopped');if(this.oversightReloadRequested){const error=Error('Supervisor operating audit requested controller reconciliation');error.code='SUPERVISOR_RECONCILE';error.guardianHandled=true;throw error;}if(this.configFile&&read(this.configFile).executionMode!=='orchestrated')throw Error('Manual baseline gate: execution disabled');}
  async audit(phase,extra={}){
    await this.oversight.poll();await this.oversight.applyPendingRepair();
    if(oversightExhausted(this.state)){const error=Error('Supervisor operating recovery exhausted for the same incident without product progress; evidence retained for explicit intervention');error.guardianHandled=true;throw error;}
    this.ensureRunning();this.state.phase=phase;this.save();
    if(this.controllerVitest&&['startup','task_assignment','implementation_handoff','verification_handoff'].includes(phase)){
      // Healthy transitions are machine checks, not serial model approvals.
      this.state.operatingMonitor={mode:'event-driven',checkedAt:stamp(),phase,status:'healthy'};this.save();
      return {decision:'continue',summary:'Deterministic operating transition',ruleChanges:[]};
    }
    const activeTask=this.state.currentTasks?.length===1?this.state.tasks[this.state.currentTasks[0]]:null;
    const target=['implementation_handoff','verification_handoff','environment_recovery'].includes(phase)?activeTask?.target:null;
    const transitionFile=path.join(this.directory,'control/vitest-transition-ready.json');
    if(fs.existsSync(transitionFile)){
      try{validateIdentities(this.root,read(transitionFile).inputs);extra={...extra,vitestMigration:fileIdentity(this.root,transitionFile)};}
      catch{extra={...extra,historicalVitestMigration:fileIdentity(this.root,transitionFile)};}
    }
    const result=await this.guardian.inspect({runId:this.state.runId,status:this.state.status,phase,review:this.state.review,currentTasks:this.state.currentTasks??[],taskId:this.state.currentTasks?.[0]??null,productRoot:target?.productRoot??this.state.reviewWorkspace?.directory??this.state.approvedProductTarget?.productRoot,targetId:target?.targetId??null,tasks:Object.fromEntries(Object.entries(this.state.tasks).map(([id,t])=>[id,{status:t.status,attempt:t.attempt,verification:t.verification??null,verificationTransition:t.verificationTransition??null}])),reviewApprovals:Object.keys(this.state.certificates),lastToolActivityAt:this.state.lastToolActivityAt??null,activeTurns:this.state.activeTurns??{},baselineCertificate:this.state.baselineCertificate,controllerPid:this.state.controllerPid,operatingRepair:this.state.guardian?.lastControllerRepair??null,...extra},{phase});
    if(result.decision==='hold'&&result.recovery?.action==='repair_controller')await this.repairController(phase);
    if(result.decision==='hold'){const error=Error(`Orchestration guardian hold: ${result.summary}; ${result.reason??''}`);error.guardianHandled=true;throw error;}
    if(result.decision==='reload'){this.event('guardian_rules_reloaded',{summary:result.summary,paths:result.ruleChanges});this.operatingRules=fs.readFileSync(resolveInside(this.root,this.config.rulesPath),'utf8');this.loadedThreads.clear();}
    return result;
  }
  async repairController(phase){
    const targets=[this.state.approvedProductTarget,...(this.state.currentTasks??[]).map(id=>this.state.tasks[id]?.target)].filter(Boolean);
    // A REVIEW handing control to its repairer has finished its product work.
    // Release that scope before acquiring a distinct bounded repair lease.
    const scope=`product-review-${this.state.review}`,operation=this.state.activeOperations?.[scope];
    if(operation&&!Object.keys(this.state.activeTurns??{}).length){endOperation(this.state,scope,operation.id);this.save();}
    const result=await this.controllerRepair.repair({auditIdentity:this.state.guardian.lastAuditIdentity,phase,targets});
    if(result.status==='applied'){
      this.state.status='reloading_orchestration';this.state.error=null;this.state.nextAction='운영 수리 검사 통과·제어기 재시작 후 미완료 단계 재개';this.save();
      const error=Error('Operating repair applied; reload controller with preserved task receipts');error.code='OPERATING_REPAIR_APPLIED';error.guardianHandled=true;throw error;
    }
    const error=Error(`Orchestration guardian hold: operating repair blocked; ${result.summary}`);error.guardianHandled=true;throw error;
  }

  restoreBlockedResponse(task){
    const row=this.state.tasks[task.id];if(row.implementation)return;
    const file=path.join(row.attemptDirectory??'','implementation/response.json');if(!fs.existsSync(file))return;
    const response=read(file);validateIdentities(this.root,[response.requestIdentity]);
    if(!response.turnId||response.cwd!==row.workspace?.directory||response.result.taskId!==task.id||response.result.status!=='blocked'||response.productSourceDigest!==digest(productSnapshot(response.cwd)))throw Error('Target binding: blocked implementation cannot be recovered');
    row.implementation={result:response.result,turnId:response.turnId,requestIdentity:response.requestIdentity,responseIdentity:fileIdentity(this.root,file)};row.artifacts=response.result.artifactPaths;this.save();
  }
  recoveryEvidence(block,{taskId}={}){
    const explicit=this.state.explicitResume;
    if(explicit?.receiptIdentity&&Date.parse(explicit.requestedAt)>Date.parse(block.at)&&(!taskId||explicit.taskIds?.includes(taskId))){
      validateIdentities(this.root,[explicit.receiptIdentity]);return explicit.receiptIdentity;
    }
    if(block.external)return null;
    const repair=this.state.guardian?.lastControllerRepair;
    if(repair?.status==='applied'&&repair.receiptIdentity){
      validateIdentities(this.root,[repair.receiptIdentity]);
      if(Date.parse(read(resolveInside(this.root,repair.receiptIdentity.path)).finishedAt)>Date.parse(block.at))return repair.receiptIdentity;
    }
    return null;
  }
  resumeParkedTasks(){
    if(!this.controllerVitest)return;
    for(const task of this.plan.tasks){
      const row=this.state.tasks[task.id];if(!row.parked||!row.externalBlock)continue;
      const evidence=this.recoveryEvidence({...row.externalBlock,external:true},{taskId:task.id});if(!evidence)continue;
      row.externalBlockHistory??=[];row.externalBlockHistory.push({...row.externalBlock,resumedWith:evidence});
      if(row.implementation?.result.status==='blocked'){
        row.blockedImplementationHistory??=[];row.blockedImplementationHistory.push(row.implementation.responseIdentity);
        row.implementationRevision=`external-resume-${row.externalBlockHistory.length}`;
        const input=prepareTaskInputs(this.root,{state:this.state,taskId:task.id,candidateRoot:row.workspace.directory,outputFile:path.join(row.attemptDirectory,`${row.implementationRevision}-context.json`),previousResponse:row.implementation.responseIdentity});
        row.inputContext=input.identity;row.status='assigned';row.resumeEvidence=evidence;
      }else{row.controllerRecoveryRevision=(row.controllerRecoveryRevision??0)+1;row.status='implemented';}
      delete row.parked;delete row.externalBlock;delete row.blocker;
      this.event('task_external_resume',{taskId:task.id,evidence});this.save();
    }
  }
  assertCurrentTaskTarget(task){
    const row=this.state.tasks[task.id],implementation=row.implementation;
    const authorizedBlocked=this.blockedVerificationAuthorized(task);
    if(implementation?.result.status==='blocked'&&!authorizedBlocked){
      row.status='blocked';row.blocker=implementation.result.summary;this.save();
      throw Error(`Operating handoff: ${task.id} current implementation is blocked; no verification target is authorized`);
    }
    if(!row.target||!(implementation?.result.status==='completed'||authorizedBlocked)||!row.attemptDirectory||!implementation.responseIdentity||!inside(resolveInside(this.root,row.attemptDirectory),resolveInside(this.root,implementation.responseIdentity.path)))throw Error(`Operating handoff: ${task.id} has no completed current-attempt implementation target`);
    const candidate=path.join(row.attemptDirectory,'candidate'),report=path.join(row.attemptDirectory,row.implementationRevision??'implementation');
    validateIdentities(this.root,[implementation.requestIdentity,implementation.responseIdentity]);
    const request=read(resolveInside(this.root,implementation.requestIdentity.path)),response=read(resolveInside(this.root,implementation.responseIdentity.path));
    if(resolveInside(this.root,implementation.requestIdentity.path)!==path.join(report,'request.json')||resolveInside(this.root,implementation.responseIdentity.path)!==path.join(report,'response.json')||request.taskId!==task.id||request.cwd!==candidate||response.cwd!==candidate||response.turnId!==implementation.turnId||digest(response.requestIdentity)!==digest(implementation.requestIdentity)||digest(response.result)!==digest(implementation.result))throw Error(`Target binding: ${task.id} request/response belongs to another attempt`);
    if(row.inputContext){
      validateIdentities(this.root,[row.inputContext]);const context=read(resolveInside(this.root,row.inputContext.path));
      if(context.taskId!==task.id||context.candidateRoot!==candidate||!inside(row.attemptDirectory,resolveInside(this.root,row.inputContext.path)))throw Error(`Target binding: ${task.id} input context belongs to another candidate`);
    }
    validateProductTarget(this.root,row.target);
    if(path.resolve(row.target.productRoot)!==path.resolve(row.workspace?.directory??'')||path.resolve(implementation.result.candidateRoot)!==path.resolve(row.target.productRoot)||digest(row.target.requestIdentity)!==digest(implementation.requestIdentity)||digest(row.target.responseIdentity)!==digest(implementation.responseIdentity))throw Error(`Target binding: ${task.id} target belongs to another implementation`);
    return row.target;
  }
  currentControllerVerdict(task){
    const row=this.state.tasks[task.id];
    // Prior attempts remain useful repair history, never current execution state.
    if(!row.verification||!row.attemptDirectory||!row.target||!(row.implementation?.result.status==='completed'||this.blockedVerificationAuthorized(task))||!inside(resolveInside(this.root,row.attemptDirectory),resolveInside(this.root,row.verification)))return null;
    this.assertCurrentTaskTarget(task);
    const verdict=read(resolveInside(this.root,row.verification));
    if(verdict.acceptanceMode!=='controller-vitest'||verdict.taskId!==task.id||verdict.review!==this.taskReview(task)||verdict.targetId!==row.target.targetId||path.resolve(verdict.candidateRoot??'')!==path.resolve(row.target.productRoot))return null;
    return verdict;
  }
  blockedRepairAddresses(task,repair){
    const response=this.state.tasks[task.id].implementation?.responseIdentity;
    if(!response||!repair.sourceAudit||!repair.receiptIdentity)return false;
    validateIdentities(this.root,[response,repair.sourceAudit,repair.receiptIdentity]);
    const receipt=read(resolveInside(this.root,repair.receiptIdentity.path)),audit=read(resolveInside(this.root,repair.sourceAudit.path)),recovery=audit.result?.recovery;
    const supervisor=audit.kind==='supervisor-operating-audit'&&audit.runId===this.state.runId&&audit.addressedImplementations?.some(item=>item.taskId===task.id&&digest(item.responseIdentity)===digest(response));
    if(supervisor)validateSupervisorRepairAuthority(this.root,this.state,audit);
    return receipt.status==='applied'&&digest(receipt.sourceAudit)===digest(repair.sourceAudit)&&(audit.phase==='task_blocked'||supervisor)&&audit.result?.decision==='hold'&&recovery?.action==='repair_controller'&&(recovery.taskId===task.id||supervisor)&&recovery.evidencePaths?.some(name=>resolveInside(this.root,name)===resolveInside(this.root,response.path));
  }
  parkExternalBlock(task,report){
    const row=this.state.tasks[task.id];
    report??=row.implementation?.result.status==='blocked'?row.implementation.result:this.currentControllerVerdict(task)??row.implementation?.result;
    const reason=[row.blocker,report?.summary,...(report?.remainingIssues??[]),...(report?.failures??[])].filter(Boolean).join('\n');
    if(!/Human input required|requestApproval|approval (?:rejected|required)|automatic approval.*reject|not authenticated|unauthorized|authentication required|missing external (?:input|credential)/i.test(reason))return false;
    row.parked=true;row.externalBlock={reason,at:stamp(),response:row.implementation?.responseIdentity??null};
    this.event('task_parked_external',{taskId:task.id,reason:reason.slice(0,1000)});this.save();return true;
  }
  needsBlockedProductReview(task){
    const row=this.state.tasks[task.id];
    // The implementation schema has no product-failure classification. A ready
    // acceptance plan supplies evidence for supervisor review, never a FAIL.
    return this.controllerVitest&&row.implementation?.result.status==='blocked'&&Boolean(row.contractIdentity&&row.assignmentReceipt&&row.implementation.result.testPlanPath&&this.config.roles?.supervisor);
  }
  blockedVerificationAuthorized(task){
    const row=this.state.tasks[task.id],authorization=row.blockedVerificationAuthorization;
    if(!authorization||row.implementation?.result.status!=='blocked')return false;
    validateIdentities(this.root,[authorization.handoff,authorization.decision]);
    const handoff=read(resolveInside(this.root,authorization.handoff.path)),decision=read(resolveInside(this.root,authorization.decision.path));
    validateIdentities(this.root,[...handoff.inputs,decision.requestIdentity]);
    validateBlockedProductInputRoles(this.root,handoff,row.implementation);
    const request=read(resolveInside(this.root,decision.requestIdentity.path));
    const report=path.join(path.dirname(resolveInside(this.root,authorization.handoff.path)),'decision'),dispatch=read(path.join(report,'dispatch.json'));
    validateIdentities(this.root,[dispatch.requestIdentity]);
    if(resolveInside(this.root,authorization.decision.path)!==path.join(report,'response.json')||resolveInside(this.root,decision.requestIdentity.path)!==path.join(report,'request.json')||digest(dispatch.requestIdentity)!==digest(decision.requestIdentity)||!dispatch.threadId||dispatch.turnId!==decision.turnId||dispatch.cwd!==handoff.candidateRoot)throw Error('Target binding: blocked-product decision is not confirmed');
    if(handoff.kind!=='blocked-product-handoff'||handoff.taskId!==task.id||handoff.review!==this.state.review||handoff.attempt!==row.attempt||handoff.candidateRoot!==row.workspace?.directory||digest(handoff.confirmedResponseIdentity)!==digest(row.implementation.responseIdentity)||handoff.productSourceDigest!==digest(productSnapshot(handoff.candidateRoot))||!decision.turnId||decision.schemaDigest!==digest(BLOCKED_PRODUCT_DECISION_SCHEMA)||request.role!=='supervisor'||request.key!=='supervisor'||request.taskId!==task.id||request.review!==this.state.review||request.cwd!==handoff.candidateRoot||request.schemaDigest!==decision.schemaDigest||digest(request.blockedProductHandoff)!==digest(authorization.handoff)||decision.cwd!==handoff.candidateRoot||decision.result.action!=='verify'||decision.result.taskId!==task.id||decision.result.review!==this.state.review||decision.result.candidateRoot!==handoff.candidateRoot||decision.result.repairTaskIds.length||authorization.targetId!==row.target?.targetId)throw Error('Target binding: invalid blocked-product verification authority');
    return true;
  }
  async recoverAppliedBlockedHandoff(){
    const repair=this.state.guardian?.lastControllerRepair;
    if(!this.controllerVitest||repair?.status!=='applied'||needsExternalInput(this.state)||oversightExhausted(this.state)||['manual_hold','stopped','waiting_input'].includes(this.state.status)||this.state.activeOperation||Object.keys(this.state.activeTurns??{}).length||Object.keys(this.state.activeOperations??{}).length)return false;
    this.ensureRunning();
    validateIdentities(this.root,[repair.receiptIdentity,repair.sourceAudit]);
    const receipt=read(resolveInside(this.root,repair.receiptIdentity.path)),audit=read(resolveInside(this.root,repair.sourceAudit.path));
    if(audit.kind!=='supervisor-operating-audit'||receipt.status!=='applied'||digest(receipt.sourceAudit)!==digest(repair.sourceAudit))return false;
    validateSupervisorRepairAuthority(this.root,this.state,audit);
    const snapshot=read(resolveInside(this.root,audit.snapshotIdentity.path)),held=snapshot.guardian?.lastAuditIdentity,incident=snapshot.pendingExecutionIncident;
    const samePin=(left,right)=>Boolean(left&&right&&resolveInside(this.root,left.path)===resolveInside(this.root,right.path)&&left.sha256===right.sha256&&left.byteLength===right.byteLength);
    if(!held||!incident||!samePin(held,this.state.guardian.lastAuditIdentity)||![held,incident].every(expected=>audit.evidence.some(pin=>samePin(pin,expected))))return false;
    if(this.state.pendingExecutionIncident?!samePin(this.state.pendingExecutionIncident,incident):!this.state.supervisorOversight?.addressedExecutionIncidents?.some(row=>samePin(row.incidentIdentity,incident)&&samePin(row.supervisorAuditIdentity,repair.sourceAudit)&&samePin(row.repairReceiptIdentity,repair.receiptIdentity)))return false;
    validateIdentities(this.root,[held,incident,...(receipt.changes??[]).map(change=>change.after)]);
    if(read(resolveInside(this.root,held.path)).result?.decision!=='hold')return false;
    const task=this.plan.tasks.find(task=>this.taskReview(task)===this.state.review&&this.state.tasks[task.id].status==='blocked'&&!this.state.tasks[task.id].parked&&this.needsBlockedProductReview(task)&&this.blockedRepairAddresses(task,repair));
    if(!task||this.parkExternalBlock(task,this.state.tasks[task.id].implementation.result))return false;
    // Admit the authenticated, unconsumed continuation before replaying a
    // cached routing decision. Keep the guardian hold and incident intact.
    if(await this.recoverBlocked(task,{continuationOnly:true}))return true;
    // A consumed receipt can only drain routing, never grant another resume.
    const row=this.state.tasks[task.id],binding={repair:repair.receiptIdentity,response:row.implementation.responseIdentity,incident};
    if(row.operatingHandoff&&digest(row.operatingHandoff.binding)!==digest(binding))throw Error('Operating handoff binding changed');
    row.operatingHandoff??={binding,startedAt:stamp(),deadlineAt:new Date(Date.now()+180000).toISOString(),status:'pending'};
    this.save();
    await this.recoverBlocked(task,{routingOnly:true,deadlineAt:row.operatingHandoff.deadlineAt});
    const error=Error('Orchestration guardian hold: operating handoff completed; product execution remains blocked');error.guardianHandled=true;throw error;
  }
  retainCompletedProductBlock(task){
    const row=this.state.tasks[task.id],held=row.blockedProductHandoff;
    if(row.status!=='blocked'||!held?.handoff||!row.implementation||row.implementation.result.status!=='blocked')return false;
    validateIdentities(this.root,[held.handoff,row.implementation.responseIdentity,row.implementation.requestIdentity,row.contractIdentity]);
    const packet=read(resolveInside(this.root,held.handoff.path)),candidate=row.workspace?.directory;
    const implementation=row.implementation,implementationReport=path.join(row.attemptDirectory,row.implementationRevision??'implementation');
    const original=read(path.join(implementationReport,'response.json')),originalRequest=read(path.join(implementationReport,'request.json')),originalDispatch=read(path.join(implementationReport,'dispatch.json')),contract=validateContractIdentity(this.root,row.contractIdentity);
    validateIdentities(this.root,[original.requestIdentity,originalDispatch.requestIdentity]);
    if(digest(fileIdentity(this.root,path.join(implementationReport,'response.json')))!==digest(implementation.responseIdentity)||digest(fileIdentity(this.root,path.join(implementationReport,'request.json')))!==digest(implementation.requestIdentity)||digest(original.requestIdentity)!==digest(implementation.requestIdentity)||digest(originalDispatch.requestIdentity)!==digest(implementation.requestIdentity)||!originalDispatch.threadId||!original.turnId||!original.completedAt||original.turnId!==implementation.turnId||originalDispatch.turnId!==original.turnId||originalRequest.role!=='implementer'||originalRequest.taskId!==task.id||originalRequest.review!==this.state.review||originalRequest.schemaDigest!==digest(CONTROLLER_TASK_IMPLEMENTATION_SCHEMA)||original.schemaDigest!==originalRequest.schemaDigest||[originalRequest.cwd,original.cwd,originalDispatch.cwd,original.result.candidateRoot].some(cwd=>cwd!==candidate)||original.result.status!=='blocked'||original.result.taskId!==task.id||digest(original.result)!==digest(implementation.result)||original.productSourceDigest!==packet.productSourceDigest||contract.taskId!==task.id||contract.review!==this.state.review)throw Error('Target binding: completed product block lost its confirmed implementation');
    validateBlockedProductInputRoles(this.root,packet,implementation);
    const report=path.join(path.dirname(resolveInside(this.root,held.handoff.path)),'decision'),responseFile=path.join(report,'response.json');
    if(!fs.existsSync(responseFile))return false;
    const decision=read(responseFile),requestFile=path.join(report,'request.json'),request=read(requestFile),dispatch=read(path.join(report,'dispatch.json'));
    validateIdentities(this.root,[...packet.inputs,decision.requestIdentity,dispatch.requestIdentity,...(held.decision?[held.decision]:[])]);
    const decisionIdentity=fileIdentity(this.root,responseFile),requestIdentity=fileIdentity(this.root,requestFile),schemaDigest=digest(BLOCKED_PRODUCT_DECISION_SCHEMA);
    if(packet.kind!=='blocked-product-handoff'||packet.taskId!==task.id||packet.review!==this.state.review||packet.attempt!==row.attempt||packet.candidateRoot!==candidate||packet.productSourceDigest!==digest(productSnapshot(candidate))||digest(packet.confirmedResponseIdentity)!==digest(row.implementation.responseIdentity)||digest(packet.requestIdentity)!==digest(row.implementation.requestIdentity)||digest(packet.contractIdentity)!==digest(row.contractIdentity)||digest(decision.requestIdentity)!==digest(requestIdentity)||digest(dispatch.requestIdentity)!==digest(requestIdentity)||!dispatch.threadId||!decision.turnId||dispatch.turnId!==decision.turnId||[request.cwd,decision.cwd,dispatch.cwd].some(cwd=>cwd!==candidate)||request.role!=='supervisor'||request.key!=='supervisor'||request.taskId!==task.id||request.review!==this.state.review||request.schemaDigest!==schemaDigest||decision.schemaDigest!==schemaDigest||digest(request.blockedProductHandoff)!==digest(held.handoff)||held.decision&&digest(held.decision)!==digest(decisionIdentity))throw Error('Target binding: completed blocked-product handoff changed');
    const action=decision.result;
    if(action.taskId!==task.id||action.review!==this.state.review||action.candidateRoot!==candidate||!['verify','repair','blocked'].includes(action.action)||!Array.isArray(action.repairTaskIds)||action.repairTaskIds.some(id=>!this.plan.tasks.some(task=>task.id===id))||(action.action==='repair'&&(!action.repairTaskIds.length||!action.instructions?.trim())))throw Error('Invalid completed blocked-product supervisor routing');
    if(action.action==='verify')return false;
    // An explicit harness revision may authorize a different routing packet.
    // Ordinary code repair/retry receipts never supersede a product decision.
    const revisionFile=selectedHarnessRevisionFile(this.root,path.join(this.directory,'tasks',task.id));
    if(revisionFile){
      const selected=frozenAcceptanceSuite(this.root,path.dirname(path.dirname(revisionFile)));
      if(digest(packet.acceptanceRevision?.suite??null)!==digest(fileIdentity(this.root,selected.receiptFile)))return false;
      validateIdentities(this.root,[packet.acceptanceRevision.revision,packet.acceptanceRevision.authorization]);
    }
    row.blockedProductHandoff={...held,status:action.action,decision:decisionIdentity,summary:action.summary};
    if(row.operatingHandoff&&digest(row.operatingHandoff.binding.response)===digest(implementation.responseIdentity)){
      row.operatingHandoff.status='completed';row.operatingHandoff.decision=decisionIdentity;row.operatingHandoff.completedAt??=stamp();
    }
    this.state.productBlockedHandoff={taskId:task.id,candidateRoot:candidate,response:row.implementation.responseIdentity,handoff:held.handoff,decision:decisionIdentity,executionIncident:this.state.pendingExecutionIncident??null};
    this.state.status='blocked';this.state.phase='blocked_product_handoff';this.state.currentTasks=[task.id];
    this.state.error=`${task.id} product BLOCKED; supervisor ${action.action}: ${action.summary}; ${action.instructions}`;
    this.state.nextAction='제품 BLOCKED 인계 완료 · 원본 응답·누락 산출물 근거 보존';this.save();
    if(productBlockNeedsResolution(this.state))return true;
    const error=Error(this.state.error);error.code='PRODUCT_BLOCKED';error.guardianHandled=true;throw error;
  }
  async resolveInternalProductBlock(task){
    return this.withProductOperation('product-block-resolution',()=>resolveInternalProductBlock(this,task));
  }
  async handoffBlockedProduct(task,blockedTask,incidentId,{routingOnly=false,deadlineAt}={}){
    this.retainCompletedProductBlock(task);
    const row=this.state.tasks[task.id],implementation=row.implementation,candidate=row.workspace.directory;
    const report=path.join(row.attemptDirectory,row.implementationRevision??'implementation'),responseFile=path.join(report,'response.json'),requestFile=path.join(report,'request.json'),dispatchFile=path.join(report,'dispatch.json');
    validateIdentities(this.root,[implementation.responseIdentity,implementation.requestIdentity,row.contractIdentity]);
    const response=read(responseFile),request=read(requestFile),dispatch=read(dispatchFile),contract=validateContractIdentity(this.root,row.contractIdentity);
    validateIdentities(this.root,[response.requestIdentity,dispatch.requestIdentity]);
    const schemaDigest=digest(CONTROLLER_TASK_IMPLEMENTATION_SCHEMA),sourceDigest=digest(productSnapshot(candidate));
    if(digest(fileIdentity(this.root,responseFile))!==digest(implementation.responseIdentity)||digest(fileIdentity(this.root,requestFile))!==digest(implementation.requestIdentity)||digest(response.requestIdentity)!==digest(implementation.requestIdentity)||digest(dispatch.requestIdentity)!==digest(implementation.requestIdentity)||!response.turnId||!response.completedAt||response.turnId!==implementation.turnId||dispatch.turnId!==response.turnId||!dispatch.threadId||request.role!=='implementer'||request.taskId!==task.id||request.review!==this.state.review||request.schemaDigest!==schemaDigest||response.schemaDigest!==schemaDigest||[request.cwd,response.cwd,dispatch.cwd,response.result.candidateRoot].some(cwd=>cwd!==candidate)||response.result.taskId!==task.id||response.result.status!=='blocked'||digest(response.result)!==digest(implementation.result)||response.productSourceDigest!==sourceDigest||contract.taskId!==task.id||contract.review!==this.state.review)throw Error('Target binding: blocked-product handoff needs the exact confirmed implementation');
    const inputs=[implementation.responseIdentity,implementation.requestIdentity,fileIdentity(this.root,dispatchFile),row.contractIdentity,...(row.assignmentReceipt?[row.assignmentReceipt]:[])];
    validateIdentities(this.root,[row.assignmentReceipt]);
    const assignment=read(resolveInside(this.root,row.assignmentReceipt.path));
    if(digest(assignment.contract)!==digest(row.contractIdentity)||assignment.assignment?.taskId!==task.id||assignment.assignment.review!==this.state.review||assignment.assignment.candidateRoot!==candidate||digest(assignment.assignment)!==digest(row.assignment))throw Error('Target binding: blocked-product assignment mismatch');
    const result=response.result;
    for(const name of [result.inputManifestPath,result.testPlanPath,...result.artifactPaths]){
      const file=resolveInside(this.root,name);
      if(!inside(candidate,file)||!fs.lstatSync(file).isFile()||fs.realpathSync(file).toLowerCase()!==file.toLowerCase())throw Error('Target binding: blocked-product evidence must stay in the candidate');
      inputs.push(fileIdentity(this.root,file));
    }
    const manifest=read(resolveInside(this.root,result.inputManifestPath));
    if(manifest.version!==1||!Array.isArray(manifest.inputs))throw Error('Invalid blocked-product input manifest');
    const roles=normalizeImplementationInputs(this.root,manifest.inputs);
    if(roles.executionTools.length){
      const bound=prepareControllerImplementationInputs(this.root,{candidateRoot:candidate,attemptDirectory:row.attemptDirectory,response:implementation});
      inputs.push(...read(bound.artifactManifest).inputs,fileIdentity(this.root,bound.artifactManifest));
    }else inputs.push(...roles.productInputs);
    validateIdentities(this.root,inputs);
    // An explicitly authorized harness correction needs a fresh routing decision.
    // Keep the original BLOCKED response and decision under their original paths.
    const revisionFile=selectedHarnessRevisionFile(this.root,path.join(this.directory,'tasks',task.id));
    let acceptanceRevision=null;
    if(revisionFile){
      const selected=frozenAcceptanceSuite(this.root,path.dirname(path.dirname(revisionFile))),revision=read(revisionFile);
      acceptanceRevision={revision:fileIdentity(this.root,revisionFile),suite:fileIdentity(this.root,selected.receiptFile),authorization:revision.authorization};
      inputs.push(acceptanceRevision.revision,acceptanceRevision.suite,acceptanceRevision.authorization,...selected.inputs);
      validateIdentities(this.root,inputs);
    }
    const packet={version:1,kind:'blocked-product-handoff',taskId:task.id,review:this.state.review,attempt:row.attempt,candidateRoot:candidate,productSourceDigest:sourceDigest,contractIdentity:row.contractIdentity,confirmedResponseIdentity:implementation.responseIdentity,requestIdentity:implementation.requestIdentity,inputs,remainingIssues:result.remainingIssues,summary:result.summary,...(acceptanceRevision?{acceptanceRevision}:{})};
    const directory=path.join(row.attemptDirectory,`blocked-product-${implementation.responseIdentity.sha256.slice(0,16)}${acceptanceRevision?`-harness-${acceptanceRevision.suite.sha256.slice(0,16)}`:''}${routingOnly?`-operating-${row.operatingHandoff.binding.repair.sha256.slice(0,16)}`:''}`),file=path.join(directory,'inputs.json');
    if(fs.existsSync(file)){if(digest(read(file))!==digest(packet))throw Error('Blocked-product handoff inputs changed');}else atomicJSON(file,packet);
    const handoff=fileIdentity(this.root,file);row.blockedProductHandoff={handoff,incidentId,status:'decision_pending'};this.state.phase='blocked_product_decision';this.save();
    const prompt=`Decide the next product handoff for blocked task ${task.id}, REVIEW ${this.state.review}. Read exact evidence packet ${JSON.stringify(handoff)}, original request, confirmed BLOCKED response, fixed contract and candidate artifacts. Candidate ${candidate} is read-only. This is not a product verdict: never infer FAIL from wording, grant PASS, relax criteria, invalidate historical PASS, or rerun the implementer. Return verify to submit this same candidate to controller Vitest under its original contract and unchanged frozen suite, with repairTaskIds empty. Return repair only as an evidence-backed product repair request with responsible existing task IDs and instructions; the request is retained for independent verification, not automatically applied. Return blocked for unresolved/external evidence. Preserve all original receipts. ${JSON.stringify(blockedTask)}`;
    const scopePrompt=roles.executionTools.length?'\nCheck missing-module evidence and scope claims against the pinned original assignment and its directory write scopes. Wording in the BLOCKED response alone does not establish a product failure or a need for wider permissions.':'';
    const revisionPrompt=acceptanceRevision?`\nThe controller validated this explicit user-authorized harness correction: ${JSON.stringify(acceptanceRevision)}. Read its authorization and selected suite. The original frozen suite and earlier BLOCKED decision remain historical evidence. The selected revision preserves the original contract and requirements; assess whether this exact unchanged candidate can now enter official controller Vitest using that revision. Do not require the corrected harness defect to persist or rerun implementation.`:'';
    const decision=await this.turn('supervisor','supervisor',candidate,path.join(directory,'decision'),prompt+scopePrompt+revisionPrompt,BLOCKED_PRODUCT_DECISION_SCHEMA,{taskId:task.id,review:this.state.review,blockedProductHandoff:handoff},routingOnly?{deadlineAt,singleContinuation:true}:{});
    validateIdentities(this.root,[handoff,...inputs,decision.responseIdentity]);
    validateBlockedProductInputRoles(this.root,packet,implementation);
    if(sourceDigest!==digest(productSnapshot(candidate)))throw Error('Blocked-product candidate changed during supervisor decision');
    const action=decision.result;
    if(!decision.turnId||action.taskId!==task.id||action.review!==this.state.review||action.candidateRoot!==candidate||!['verify','repair','blocked'].includes(action.action)||!Array.isArray(action.repairTaskIds)||action.repairTaskIds.some(id=>!this.plan.tasks.some(task=>task.id===id))||(action.action==='verify'&&action.repairTaskIds.length)||(action.action==='repair'&&(!action.repairTaskIds.length||!action.instructions?.trim())))throw Error('Invalid blocked-product supervisor routing');
    row.blockedProductHandoff={handoff,incidentId,status:action.action,decision:decision.responseIdentity,summary:action.summary};this.save();
    if(action.action!=='verify'){
      this.retainCompletedProductBlock(task);
      if(productBlockNeedsResolution(this.state))return this.resolveInternalProductBlock(task);
    }
    if(routingOnly){
      row.operatingHandoff.status='completed';row.operatingHandoff.decision=decision.responseIdentity;row.operatingHandoff.completedAt=stamp();this.save();
      const error=Error(`Orchestration guardian hold: ${task.id} supervisor handoff ${action.action}; product execution remains blocked`);error.guardianHandled=true;throw error;
    }
    if(action.action!=='verify'){
      // A repair request alone is not fresh verification and cannot invalidate
      // accepted prerequisites or count as another implementation failure.
      const error=Error(`Orchestration guardian hold: ${task.id} blocked; supervisor ${action.action}: ${action.summary}; ${action.instructions}`);error.guardianHandled=true;throw error;
    }
    const boundFile=path.join(directory,'verification-inputs.json'),bound={version:1,inputs:[...roles.productInputs,...inputs,handoff,decision.responseIdentity]};
    if(fs.existsSync(boundFile)){if(digest(read(boundFile))!==digest(bound))throw Error('Blocked-product verification inputs changed');}else atomicJSON(boundFile,bound);
    const targetFile=path.join(directory,'target/target.json');
    const target=fs.existsSync(targetFile)?read(targetFile):captureProductTarget(this.root,candidate,path.join(directory,'target'),{requestIdentity:implementation.requestIdentity,responseIdentity:implementation.responseIdentity,turnId:implementation.turnId,artifactManifest:boundFile,review:this.state.review});
    const targetManifest=validateProductTarget(this.root,target),artifactPins=result.artifactPaths.map(name=>fileIdentity(this.root,name));
    const extra=new Set(targetManifest.extraInputs.map(pin=>resolveInside(this.root,pin.path).toLowerCase()));
    for(const name of normalizeImplementationChanges(candidate,result.changedFiles).filter(name=>/^(data|public)\//.test(name))){const file=path.join(candidate,name);if(fs.existsSync(file)&&!extra.has(file.toLowerCase()))throw Error(`Target binding: generated product bytes missing from manifest ${name}`);}
    const localPin=pin=>({...pin,path:inside(candidate,resolveInside(this.root,pin.path))?path.relative(candidate,resolveInside(this.root,pin.path)).replaceAll('\\','/'):path.resolve(this.root,pin.path)});
    row.target=target;
    // Use the same product-only revision as completed implementations. Routing
    // receipts must not make an unchanged failed candidate look like new work.
    row.contentRevision=digest({source:targetManifest.source,inputs:[...roles.productInputs,...artifactPins].filter(pin=>resolveInside(this.root,pin.path)!==resolveInside(this.root,result.inputManifestPath)).map(localPin),artifacts:artifactPins.map(localPin)});
    row.blockedVerificationAuthorization={handoff,decision:decision.responseIdentity,targetId:target.targetId};
    this.assertCurrentTaskTarget(task);row.status='implemented';this.state.error=null;
    this.event('blocked_product_verification_handoff',{taskId:task.id,incidentId,handoff,decision:decision.responseIdentity,targetId:target.targetId});this.save();return true;
  }
  async recoverBlocked(task,{routingOnly=false,continuationOnly=false,deadlineAt}={}){
    const row=this.state.tasks[task.id];this.restoreBlockedResponse(task);
    this.retainCompletedProductBlock(task);
    if(productBlockNeedsResolution(this.state))return this.resolveInternalProductBlock(task);
    const implementationBlocked=row.implementation?.result.status==='blocked'&&!this.blockedVerificationAuthorized(task);
    const currentVerdict=this.controllerVitest&&!implementationBlocked?this.currentControllerVerdict(task):null;
    if(this.controllerVitest){
      const report=implementationBlocked?row.implementation.result:currentVerdict??row.implementation?.result;
      if(this.parkExternalBlock(task,report))return false;
      const repair=this.state.guardian?.lastControllerRepair;
      // A declared test plan does not prove that assigned outputs are ready.
      // An exact addressed repair gets one continuation before product routing.
      if(!routingOnly&&implementationBlocked&&repair?.status==='applied'&&row.resumedWithRepair!==repair.receiptIdentity?.sha256&&!row.usedOperatingRepairReceipts?.includes(repair.receiptIdentity?.sha256)&&this.blockedRepairAddresses(task,repair)){
        validateIdentities(this.root,[repair.receiptIdentity]);const receipt=read(resolveInside(this.root,repair.receiptIdentity.path));
        const response=read(resolveInside(this.root,row.implementation.responseIdentity.path));
        if(Date.parse(receipt.finishedAt)>Date.parse(response.completedAt)){
          const revision=`operating-resume-${(row.blockedImplementationHistory?.length??0)+1}`;
          const context=prepareTaskInputs(this.root,{state:this.state,taskId:task.id,candidateRoot:row.workspace.directory,outputFile:path.join(row.attemptDirectory,`${revision}-context.json`),previousResponse:row.implementation.responseIdentity});
          row.operatingContinuation={repair:repair.receiptIdentity,sourceAudit:repair.sourceAudit,originalResponse:row.implementation.responseIdentity,originalRequest:row.implementation.requestIdentity,contract:row.contractIdentity??null,attempt:row.attempt,candidateRoot:row.workspace.directory,incident:row.lastIncident??null,revision};
          row.blockedImplementationHistory??=[];row.blockedImplementationHistory.push(row.implementation.responseIdentity);
          row.usedOperatingRepairReceipts=[...new Set([...(row.usedOperatingRepairReceipts??[]),row.resumedWithRepair,repair.receiptIdentity.sha256].filter(Boolean))];
          row.resumedWithRepair=repair.receiptIdentity.sha256;row.implementationRevision=revision;
          row.inputContext=context.identity;row.status='assigned';row.resumeEvidence=repair.receiptIdentity;this.save();return true;
        }
      }
    }
    if(continuationOnly)return false;
    if(this.controllerVitest&&currentVerdict?.verdict==='blocked'){
      const verdict=currentVerdict;
      if(verdict.operatingFailureKind==='test_preparation'&&!frozenAcceptanceSuite(this.root,path.join(this.directory,'tasks',task.id))){await this.repairTestPreparation(task,verdict);return true;}
      // Preserve the failed tool run. Reconnect the operating repair path, then
      // accept cached complete groups and rerun only incomplete/changed tools.
      row.status='implemented';this.save();
      throw Error(`Controller Vitest operating failure for ${task.id}: ${row.blocker}`);
    }
    let response=row.implementation;
    const verificationFile=path.join(row.verificationDirectory??path.join(row.attemptDirectory,'verification'),'response.json'),assignmentFile=path.join(row.attemptDirectory,'assignment/response.json');
    if(!implementationBlocked&&row.verification&&(!this.controllerVitest||currentVerdict)&&fs.existsSync(verificationFile)){
      const value=read(verificationFile);validateIdentities(this.root,[value.requestIdentity]);if(!value.turnId)throw Error('Target binding: blocked verifier response is unconfirmed');response={result:value.result,turnId:value.turnId,requestIdentity:value.requestIdentity,responseIdentity:fileIdentity(this.root,verificationFile)};
    }else if(!response&&row.assignment?.action==='blocked'&&fs.existsSync(assignmentFile)){
      const value=read(assignmentFile);validateIdentities(this.root,[value.requestIdentity]);if(!value.turnId)throw Error('Target binding: blocked assignment is unconfirmed');response={result:value.result,turnId:value.turnId,requestIdentity:value.requestIdentity,responseIdentity:fileIdentity(this.root,assignmentFile)};
    }
    const report=response?.result,issues=report?.remainingIssues??report?.failures??[row.blocker??report?.summary??'Blocked assignment'];
    const external=/Human input required|requestApproval|approval (?:rejected|required)|automatic approval.*reject|not authenticated|unauthorized|authentication required|missing external (?:input|credential)|인증.*(?:실패|필요)|권한.*거부|사용자.*결정/i.test([row.blocker,...issues].join('\n'));
    const evidence=[];
    for(const name of row.artifacts??[])if(evidence.length<32&&fs.existsSync(resolveInside(this.root,name))&&fs.statSync(resolveInside(this.root,name)).isFile())evidence.push(fileIdentity(this.root,name));
    const repairEvidence=[];
    if(response&&this.state.reviewWorkspace){
      // A continuation can confirm another BLOCKED response in the same attempt.
      // Keep each response's context immutable, including the legacy flat file.
      const contextFile=path.join(row.attemptDirectory,'repair-input-contexts',digest(response.responseIdentity),'repair-input-context.json');
      const context=prepareTaskInputs(this.root,{state:this.state,taskId:task.id,candidateRoot:row.workspace?.directory??path.join(row.attemptDirectory,'candidate'),outputFile:contextFile,previousResponse:response.responseIdentity});repairEvidence.push(context.identity);
    }
    const repairReady=path.join(this.directory,'control/repair-ready.json');if(fs.existsSync(repairReady)){
      try{
      const receipt=read(repairReady);
      if(receipt.kind!=='operating-controller-repair'||receipt.pass!==true||!receipt.inputs?.length||!receipt.checks?.length)throw Error('Operating repair lacks completed controller checks');
      validateIdentities(this.root,receipt.inputs);
      for(const check of receipt.checks){
        validateIdentities(this.root,[check]);const result=read(resolveInside(this.root,check.path));
        if(!receipt.inputs.some(pin=>pin.path===check.path&&pin.sha256===check.sha256)||!/[\\/]vitest[\\/]vitest\.mjs$/.test(result.command?.[1]??'')||result.pass!==true||result.inputsUnchanged!==true||result.tests?.pass!==true||!result.tests.counts?.passed||result.tests.counts.failed||result.tests.counts.skipped||result.tests.counts.todo)throw Error('Operating repair checks are not a fresh complete Vitest PASS');
      }
      repairEvidence.push(fileIdentity(this.root,repairReady));
      }catch(error){this.event('historical_operating_receipt_not_reused',{receipt:fileIdentity(this.root,repairReady),reason:error.message});}
    }
    const productReview=implementationBlocked&&this.needsBlockedProductReview(task);
    const blockedTask={taskId:task.id,status:'blocked',nonPassKind:report?.nonPassKind??'unclassified',blockerKind:external?'external_permission':productReview?'product_review':report?.nonPassKind==='environment'?'operating_handoff':'unclassified',remainingIssues:issues,
      assignmentIdentity:row.assignmentReceipt??null,requestIdentity:response?.requestIdentity??null,confirmedResponseIdentity:response?.responseIdentity??null,inputManifestIdentity:report?.inputManifestPath&&fs.existsSync(report.inputManifestPath)?fileIdentity(this.root,report.inputManifestPath):null,artifactIdentities:evidence,repairEvidenceIdentities:repairEvidence};
    const incidentId=digest({taskId:task.id,attempt:row.attempt,response:blockedTask.confirmedResponseIdentity,blocker:row.blocker});
    const incidentFile=path.join(this.directory,'incidents',task.id,`${incidentId}.json`);
    if(!fs.existsSync(incidentFile))atomicJSON(incidentFile,{version:1,incidentId,blockedTask,createdAt:stamp()});
    row.lastIncident=fileIdentity(this.root,incidentFile);this.state.currentTasks=[task.id];this.state.nextAction=`${task.id} 운영 차단 원인 감사 및 복구 판단`;this.save();
    if(!external&&productReview){
      if(routingOnly){
        if(!(Date.parse(deadlineAt)>Date.now())){const error=Error('Orchestration guardian hold: operating handoff exceeded its original three-minute deadline');error.guardianHandled=true;throw error;}
        const key=`product-task-${task.id}`,operation=beginOperation(this.state,key,'product-handoff','blocked-product-decision',Date.parse(deadlineAt)-Date.now());this.save();
        try{return await this.handoffBlockedProduct(task,blockedTask,incidentId,{routingOnly,deadlineAt});}finally{endOperation(this.state,key,operation.id);this.save();}
      }
      return this.withProductOperation(`product-task-${task.id}`,()=>this.handoffBlockedProduct(task,blockedTask,incidentId));
    }
    if(routingOnly){const error=Error('Orchestration guardian hold: blocked response is not eligible for operating handoff');error.guardianHandled=true;throw error;}
    const before=digest([this.config.rulesPath,'automation/prompt15/guardian.txt','docs/automation/prompt15-guardian.md'].filter(name=>fs.existsSync(path.join(this.root,name))).map(name=>fileIdentity(this.root,name)));
    const result=await this.audit('task_blocked',{blockedTask,reason:row.blocker,confirmedResponseIdentity:response?.responseIdentity??null});
    row.lastGuardianIncident={incidentId,audit:this.state.guardian?.lastAuditIdentity??null,result};this.save();
    const recovery=result.recovery;
    const after=digest([this.config.rulesPath,'automation/prompt15/guardian.txt','docs/automation/prompt15-guardian.md'].filter(name=>fs.existsSync(path.join(this.root,name))).map(name=>fileIdentity(this.root,name)));
    if(!external&&response&&report.nonPassKind!=='implementation'&&report.verdict!=='fail'&&recovery?.action==='reassign_task'&&recovery.taskId===task.id&&result.decision==='reload'&&result.ruleChanges?.length&&before!==after&&repairEvidence.length&&(row.operationalRecoveryAttempts??0)<2){
      this.retainTaskAttempt(row);
      row.retainedAttempts??=[];row.retainedAttempts.push({attempt:row.attempt,directory:row.attemptDirectory,candidateRoot:row.workspace?.directory,response:response.responseIdentity,incident:row.lastIncident,guardianAudit:this.state.guardian?.lastAuditIdentity??null});
      row.previousBlockedResponse=response.responseIdentity;row.operationalRecoveryAttempts=(row.operationalRecoveryAttempts??0)+1;
      for(const key of ['attemptDirectory','workspace','target','implementation','assignment','assignmentReceipt','blocker','verification','inputContext','contentRevision'])delete row[key];
      row.status='pending';this.state.error=null;this.state.nextAction=`운영 룰 보완 후 ${task.id} 재배정`;this.event('operational_task_reassigned',{taskId:task.id,incidentId,recoveryAttempt:row.operationalRecoveryAttempts});this.save();return true;
    }
    const error=Error(`Orchestration guardian hold: ${task.id} blocked; ${result.summary}; ${recovery?.reason??result.reason??'No proven operating repair'}`);error.guardianHandled=true;throw error;
  }
  async thread(role,key,cwd){
    if(this.loadedThreads.has(key))return this.state.threads[key];
    const settings=this.config.roles[role];
    const instructions=fs.readFileSync(resolveInside(this.root,settings.promptPath),'utf8')+`\n\nActual product cwd is supplied in each assignment, never substitute ${this.root}.\nOperating rules:\n${fs.readFileSync(resolveInside(this.root,this.config.rulesPath),'utf8')}\nFunctional specification:\n${fs.readFileSync(resolveInside(this.root,this.config.promptPath),'utf8')}`;
    const params={cwd,approvalPolicy:this.config.approvalPolicy,approvalsReviewer:this.config.approvalsReviewer,sandbox:role==='supervisor'?'read-only':'workspace-write',developerInstructions:instructions,model:settings.model,config:{model_reasoning_effort:settings.effort}};
    const prior=this.state.threads[key];
    const response=await this.server.request(prior?'thread/resume':'thread/start',prior?{...params,threadId:prior}:params);
    this.state.threads[key]=response.thread.id;this.state.threadNames[key]=key;this.loadedThreads.add(key);
    await this.server.request('thread/name/set',{threadId:response.thread.id,name:`Prompt15 ${key}`});this.save();return response.thread.id;
  }
  async restoreVerifierEnvironment(){
    const recovery=await readVerifierRecovery(this.root,this.directory,this.state);if(!recovery)return false;
    await this.audit('environment_recovery',{commandEvidence:{recoveryReceipt:recovery.ready}});
    const row=recovery.row;row.environmentRecoveryHistory??=[];row.environmentRecoveryHistory.push({evidence:recovery.evidence,sourceResponse:recovery.sourceResponse,revision:recovery.revision,restoredAt:stamp()});
    row.verificationRevision=recovery.revision;row.verificationDirectory=recovery.report;row.status='verifying';delete row.blocker;delete row.verification;
    if(this.state.pendingExecutionIncident){this.state.resolvedExecutionIncidents??=[];this.state.resolvedExecutionIncidents.push({incident:this.state.pendingExecutionIncident,evidence:recovery.evidence});delete this.state.pendingExecutionIncident;}
    this.state.error=null;this.event('verifier_environment_restored',{taskId:recovery.taskId,revision:recovery.revision,evidence:recovery.evidence});this.save();return true;
  }
  async holdUnconfirmedDispatch(dispatchFile,key){
    const dispatch=read(dispatchFile),dispatchIdentity=fileIdentity(this.root,dispatchFile);
    let completed=false,inspectionError=null;
    // Inspect the exact recorded turn, even after role/tool/path migrations.
    // A completed server turn alone cannot reconstruct its response or source.
    try{
      const history=await this.server.request('thread/read',{threadId:dispatch.threadId,includeTurns:true});
      completed=history.thread?.id===dispatch.threadId&&Boolean(history.thread?.turns?.some(turn=>turn.id===dispatch.turnId&&turn.status==='completed'));
    }catch(error){inspectionError=String(error.message).slice(0,800);}
    this.event('orphan_turn_inspected',{threadId:dispatch.threadId,turnId:dispatch.turnId??null,completed,dispatchIdentity,inspectionError});
    throw Error(`Orchestration guardian hold: dispatched ${key} has no certified response; recorded turn ${dispatch.turnId??'unknown'} ${completed?'completed but needs output/source reconciliation':'is unconfirmed'}; dispatch ${JSON.stringify(dispatchIdentity)}${inspectionError?`; thread/read failed: ${inspectionError}`:''}`);
  }
  async reconcileVerificationDispatches(task,report){
    const row=this.state.tasks[task.id],attempt=resolveInside(this.root,row.attemptDirectory);
    const reports=new Set([path.join(attempt,'verification'),resolveInside(this.root,report)]);
    if(row.verificationDirectory)reports.add(resolveInside(this.root,row.verificationDirectory));
    if(row.verification)reports.add(path.dirname(resolveInside(this.root,row.verification)));
    // Do not rely on the current revision or verifier session name. State may
    // already name the new path while an older on-disk dispatch is unresolved.
    for(const entry of fs.readdirSync(attempt,{withFileTypes:true}))if(entry.name.startsWith('verification')&&(entry.isDirectory()||entry.isSymbolicLink()))reports.add(path.join(attempt,entry.name));
    for(const [key,active]of Object.entries(this.state.activeTurns??{}))if(key.includes('verifier')&&active.taskId===task.id&&active.dispatchFile)reports.add(path.dirname(resolveInside(this.root,active.dispatchFile)));
    for(const directory of reports){
      const dispatchFile=resolveInside(this.root,path.join(directory,'dispatch.json'));
      if(!fs.existsSync(dispatchFile))continue;
      let confirmed=false;
      try{
        const dispatch=read(dispatchFile),requestFile=path.join(directory,'request.json'),response=read(path.join(directory,'response.json'));
        const request=read(requestFile),requestIdentity=fileIdentity(this.root,requestFile);
        validateIdentities(this.root,[dispatch.requestIdentity,response.requestIdentity]);
        const matches=pin=>resolveInside(this.root,pin.path)===requestFile&&pin.sha256===requestIdentity.sha256&&pin.byteLength===requestIdentity.byteLength;
        confirmed=Boolean(dispatch.threadId)&&matches(dispatch.requestIdentity)&&matches(response.requestIdentity)&&Boolean(response.turnId)&&(!dispatch.turnId||dispatch.turnId===response.turnId)&&
          request.role==='verifier'&&request.taskId===task.id&&request.review===this.state.review&&
          request.cwd===row.target.productRoot&&dispatch.cwd===request.cwd&&response.cwd===request.cwd&&Boolean(request.schemaDigest)&&response.schemaDigest===request.schemaDigest&&
          Boolean(response.productSourceDigest)&&response.productSourceDigest===digest(productSnapshot(request.cwd));
      }catch{/* Missing, changed or incomplete receipts require read-only reconciliation. */}
      if(!confirmed&&this.config.verificationFramework==='vitest'&&await reconcileLegacyVitestTurn({root:this.root,directory,report,taskId:task.id,review:this.state.review,target:row.target,server:this.server})){
        row.verificationTransition=fileIdentity(this.root,path.join(report,'legacy-turn-transition.json'));this.save();continue;
      }
      if(!confirmed)await this.holdUnconfirmedDispatch(dispatchFile,`verification for ${task.id}`);
    }
  }
  async turn(role,key,cwd,report,prompt,schema,context={},execution={}){
    if(role!=='supervisor')return this.turnOwned(role,key,cwd,report,prompt,schema,context,execution);
    // The fixed supervisor owns one native thread, shared serially by product
    // decisions and operating audits. A timer audit cannot collide with REVIEW.
    const prior=this.supervisorQueue??Promise.resolve();let release;
    this.supervisorQueue=new Promise(resolve=>{release=resolve;});await prior;
    try{return await this.turnOwned(role,key,cwd,report,prompt,schema,context,execution);}finally{release();}
  }
  async turnOwned(role,key,cwd,report,prompt,schema,context={},execution={}){
    this.ensureRunning();fs.mkdirSync(report,{recursive:true});
    const policyFiles=[this.config.promptPath,'automation/prompt15/task-plan.json','scripts/prompt15-orchestrator/protocol.mjs',this.config.rulesPath].filter(file=>fs.existsSync(path.join(this.root,file)));
    const policyPins=policyFiles.map(file=>fileIdentity(this.root,file));
    const requestFile=path.join(report,'request.json'),responseFile=path.join(report,'response.json'),dispatchFile=path.join(report,'dispatch.json');
    const evidenceRoot=role==='verifier'?resolveInside(this.root,execution.evidenceRoot??report):null;
    const request={role,key,cwd,prompt,schemaDigest:digest(schema),...context,...(evidenceRoot?{evidenceRoot}:{})};
    if(fs.existsSync(requestFile)){if(digest(read(requestFile))!==digest(request))throw Error('Target binding: persisted assignment changed');}else atomicJSON(requestFile,request);
    const requestIdentity=fileIdentity(this.root,requestFile);
    if(fs.existsSync(responseFile)){
      const response=read(responseFile);validateIdentities(this.root,[response.requestIdentity]);
      if(!response.turnId||digest(response.requestIdentity)!==digest(requestIdentity)||response.schemaDigest!==digest(schema)||response.cwd!==cwd)throw Error('Target binding: unconfirmed turn response');
      if(response.productSourceDigest&&response.productSourceDigest!==digest(productSnapshot(cwd)))throw Error('Target binding: candidate changed after confirmed turn');
      if(role!=='supervisor'||!context.operatingAuditId)this.recordProductResponse(key,response,fileIdentity(this.root,responseFile));
      if(this.state.activeTurns?.[key]?.dispatchFile===dispatchFile){delete this.state.activeTurns[key];this.save();}
      return {result:response.result,turnId:response.turnId,requestIdentity,responseIdentity:fileIdentity(this.root,responseFile)};
    }
    if(fs.existsSync(dispatchFile)){
      if(execution.expectedThreadId&&read(dispatchFile).threadId!==execution.expectedThreadId)throw Error('Operating continuation dispatch belongs to a different thread');
      if(this.controllerVitest&&['implementer','verifier','testPreparer','supervisor'].includes(role)){
        const recovered=await reconcileImplementationTurn({root:this.root,dispatchFile,request,schema,server:this.server,
          continueTurn:({directory,originalDispatch,nativeStatus})=>{
            if(execution.singleContinuation)throw Error('Operating continuation already dispatched; preserve its interrupted/failed receipt without another resume');
            return this.turnOwned(role,key,cwd,directory,`${prompt}\n\nContinue the same assignment and current candidate after a confirmed ${nativeStatus} turn. Original dispatch ${JSON.stringify(originalDispatch)}. Inspect existing artifacts and authenticated stage results first; preserve completed work and do not restart completed expensive generation or certified checks. Finish the original request and return its exact schema.`,schema,context,{evidenceRoot,...(execution.turnTimeoutMs?{turnTimeoutMs:execution.turnTimeoutMs}:{})});
          }});
        if(this.state.activeTurns?.[key]?.dispatchFile===dispatchFile){delete this.state.activeTurns[key];this.save();}
        return recovered;
      }
      await this.holdUnconfirmedDispatch(dispatchFile,key);
    }
    if(execution.deadlineAt&&!(Date.parse(execution.deadlineAt)>Date.now()))throw Error('Operating continuation exceeded its original ten-minute deadline');
    if(execution.expectedThreadId&&this.state.threads[key]!==execution.expectedThreadId)throw Error('Operating continuation lost original thread ownership');
    const threadId=await this.thread(role,key,cwd);
    if(execution.expectedThreadId&&threadId!==execution.expectedThreadId)throw Error('Operating continuation resumed a different thread');
    const turnTimeoutMs=execution.deadlineAt?Date.parse(execution.deadlineAt)-Date.now():execution.turnTimeoutMs;
    if(execution.deadlineAt&&!(turnTimeoutMs>0))throw Error('Operating continuation exceeded its original ten-minute deadline');
    const startedAt=stamp(),deadlineAt=execution.deadlineAt??new Date(Date.now()+(turnTimeoutMs??this.config.turnTimeoutMs??3600000)).toISOString();
    atomicJSON(dispatchFile,{threadId,requestIdentity,startedAt,cwd,...(execution.deadlineAt?{deadlineAt}:{})});
    this.state.activeTurns??={};this.state.activeTurns[key]={threadId,...context,dispatchFile,startedAt,deadlineAt,lastActivityAt:stamp(),runningCommands:{}};this.state.activeRole=role;this.save();
    this.event('dispatch',{role,threadId,sessionName:key,...context,cwd,requestIdentity});
    try{
      this.updateProductPhase(context,'native-execution',(turnTimeoutMs??this.config.turnTimeoutMs??3600000)+(execution.deadlineAt?0:30000));this.save();
      const sandboxPolicy=role==='supervisor'?{type:'readOnly',networkAccess:false}:{type:'workspaceWrite',writableRoots:role==='implementer'?[cwd]:[...new Set([report,...(evidenceRoot?[evidenceRoot]:[])])],networkAccess:true,excludeTmpdirEnvVar:true,excludeSlashTmp:true};
      const result=await this.server.runTurn(threadId,prompt,schema,{cwd,sandboxPolicy,model:this.config.roles[role].model,effort:this.config.roles[role].effort},{executionIdleTimeoutMs:this.config.verifierExecutionIdleTimeoutMs??900000,...(turnTimeoutMs?{turnTimeoutMs}:{}),onStarted:({turnId})=>{
        const dispatch=read(dispatchFile);
        if(dispatch.turnId&&dispatch.turnId!==turnId)throw Error('Turn start acknowledgement differs from its notification');
        atomicJSON(dispatchFile,{...dispatch,turnId});
        const active=this.state.activeTurns?.[key];if(active?.dispatchFile===dispatchFile){active.turnId=turnId;this.save();}
      }});
      validateIdentities(this.root,policyPins);
      atomicJSON(responseFile,{turnId:result.turnId,requestIdentity,schemaDigest:digest(schema),cwd,result:result.value,completedAt:stamp(),...(role!=='supervisor'?{productSourceDigest:digest(productSnapshot(cwd))}:{})});
      if(role!=='supervisor'||!context.operatingAuditId)this.recordProductResponse(key,read(responseFile),fileIdentity(this.root,responseFile));
      return {result:result.value,turnId:result.turnId,requestIdentity,responseIdentity:fileIdentity(this.root,responseFile)};
    }finally{this.updateProductPhase(context,'result-validation');delete this.state.activeTurns[key];this.state.activeRole=null;this.save();}
  }
  taskReview(task){return this.plan.checkpoints.find(c=>c.id===task.checkpoint).review;}
  recoverReviewRepairHandoff(){
    const repair=confirmedReviewRepair(this.root,this.directory,this.state,this.plan,validateProductTarget);
    if(!repair)return false;
    const mixed=repair.seeds.filter(id=>this.state.tasks[id].status!=='pass'&&taskAttemptMismatch(this.state.tasks[id]));
    if(mixed.length&&Object.values(this.state.activeTurns??{}).some(turn=>turn.taskId&&repair.invalid.includes(turn.taskId)))throw Error('REVIEW repair recovery requires a quiescent product handoff');
    const recovered=[];
    for(const id of repair.invalid){
      const row=this.state.tasks[id];
      if(this.taskReview(this.plan.tasks.find(task=>task.id===id))!==repair.review){
        if(row.reviewRepair?.review===repair.review)delete row.reviewRepair;
        continue;
      }
      if(repair.seeds.includes(id)&&row.status!=='pass'&&taskAttemptMismatch(row)){
        this.retainTaskAttempt(row);row.status='repair';recovered.push(id);
      }
      row.reviewRepair=repair;
    }
    this.state.repairRouting={...this.state.repairRouting,decision:repair.decision,verification:repair.verification};
    if(recovered.length)this.event('review_repair_handoff_recovered',{review:repair.review,taskIds:recovered,decision:repair.decision});
    this.save();return true;
  }
  retainTaskAttempt(row){
    if(!row.attemptDirectory)return;
    row.attemptHistory??=[];
    if(row.attemptHistory.some(item=>item.attemptDirectory===row.attemptDirectory))return;
    const {attemptHistory,retainedAttempts,...attempt}=row;
    row.attemptHistory.push(structuredClone(attempt));
  }
  reviewRepairInstructions(task){
    const repair=this.state.tasks[task.id].reviewRepair;if(!repair)return '';
    validateIdentities(this.root,[repair.decision,repair.verification,repair.target.manifest]);
    const response=read(resolveInside(this.root,repair.decision.path)),request=read(resolveInside(this.root,response.requestIdentity.path));
    validateIdentities(this.root,[response.requestIdentity,repair.target.requestIdentity,repair.target.responseIdentity].filter(Boolean));
    const action=response.result,dispatch=read(path.join(path.dirname(resolveInside(this.root,repair.decision.path)),'dispatch.json'));
    if(!response.turnId||dispatch.turnId!==response.turnId||digest(dispatch.requestIdentity)!==digest(response.requestIdentity)||request.role!=='supervisor'||request.review!==repair.review||request.cwd!==repair.target.productRoot||response.cwd!==request.cwd||response.schemaDigest!==digest(REVIEW_DECISION_SCHEMA)||request.schemaDigest!==response.schemaDigest||action.review!==repair.review||action.action!=='repair'||!repair.invalid.includes(task.id)||!action.repairTaskIds.every(id=>repair.invalid.includes(id))||!action.instructions?.trim())throw Error('Target binding: unconfirmed REVIEW repair instructions');
    return `Confirmed REVIEW ${repair.review} repair decision ${JSON.stringify(repair.decision)}, failed target ${repair.target.targetId}, verdict ${JSON.stringify(repair.verification)}. Repair only assigned scope while preserving original requirements and frozen assertions. ${action.summary}\n${action.instructions}`;
  }
  validatePrerequisites(task){
    validateProductTarget(this.root,this.state.approvedProductTarget);
    for(const id of task.dependsOn){const row=this.state.tasks[id];if(row.status!=='pass'||!row.acceptedTarget||!row.verification)throw Error('Target binding: prerequisite has no independent PASS');validateProductTarget(this.root,row.acceptedTarget);const report=read(resolveInside(this.root,row.verification));validateIdentities(this.root,[...report.inputs,...report.evidence]);}
  }
  async assign(task){
    this.validatePrerequisites(task);
    const row=this.state.tasks[task.id];
    if(row.parked||row.externalBlock)throw Error(`Orchestration guardian hold: ${task.id} external input is unresolved`);
    if(row.attemptDirectory&&row.status==='running')return row;
    const previous=row.verification?read(resolveInside(this.root,row.verification)):row.attemptHistory?.at(-1)?.verification?read(resolveInside(this.root,row.attemptHistory.at(-1).verification)):null;
    const reviewRepair=this.reviewRepairInstructions(task),harnessRecovery=harnessRecoveryInstructions(this.root,this.directory,this.state,task),internalRecovery=internalBlockInstructions(this.root,this.state,task);
    if(row.status!=='planning'){
      this.retainTaskAttempt(row);
      for(const key of ['workspace','target','acceptedTarget','implementation','implementationNormalization','implementationRevision','assignment','assignmentReceipt','inputContext','verification','verificationDirectory','verificationRevision','verificationTransition','testPreparation','testPreparationSequence','preparationRepairRevision','preparationRepairAttempts','controllerRecoveryRevision','environmentRecoveryHistory','blockedVerificationAuthorization','blockedProductHandoff','blockedImplementationHistory','operatingContinuation','operatingHandoff','resumeEvidence','resumedWithRepair','artifacts','artifactIdentities','contentRevision','blocker','passedAt'])delete row[key];
      row.attempt++;row.attemptDirectory=path.join(this.directory,'tasks',task.id,`attempt-${String(row.attempt).padStart(3,'0')}`);fs.mkdirSync(row.attemptDirectory,{recursive:true});row.status='planning';this.save();
    }
    const candidateRoot=path.join(row.attemptDirectory,'candidate'),input=prepareTaskInputs(this.root,{state:this.state,taskId:task.id,candidateRoot,outputFile:path.join(row.attemptDirectory,'task-input-context.json'),previousResponse:row.previousBlockedResponse??null});
    row.inputContext=input.identity;this.save();
    if(this.controllerVitest){
      const contract=persistTaskContract(this.root,path.join(this.directory,'tasks',task.id),task,this.state.review);
      row.contractIdentity=contract.identity;
      const assignment=deterministicAssignment(task,this.state.review,candidateRoot,input.path,contract.value);
      if(previous)assignment.instructions+=`\nHistorical same-task verdict (not authorization to skip the confirmed REVIEW repair): ${JSON.stringify(previous)}. Preserve the controller-selected acceptance suite and repair only this task's product behavior.`;
      if(harnessRecovery)assignment.instructions+=`\n${harnessRecovery}`;
      if(reviewRepair)assignment.instructions+=`\n${reviewRepair}`;
      if(internalRecovery)assignment.instructions+=`\n${internalRecovery}`;
      const selectedSuite=frozenAcceptanceSuite(this.root,path.join(this.directory,'tasks',task.id));
      if(selectedSuite)assignment.instructions+=`\nController-selected acceptance suite ${JSON.stringify(fileIdentity(this.root,selectedSuite.receiptFile))}. Read its pinned tests before repairing; historical suites and candidate-local copies do not override this controller-selected revision.`;
      row.assignment=validateAssignment(task,this.state.review,assignment,{candidateRoot,inputContextPath:input.path});
      const file=path.join(row.attemptDirectory,'assignment/controller-assignment.json');atomicJSON(file,{version:1,contract:contract.identity,assignment});
      row.assignmentReceipt=fileIdentity(this.root,file);row.status='assigned';this.save();return row;
    }
    const request=[`Assign exactly ${task.id}, REVIEW ${this.taskReview(task)}. Do not bundle later tasks.`,JSON.stringify(task),`Read-only source baseline (supervisor inspection cwd only): ${this.state.reviewWorkspace.directory}. Exact future implementation candidateRoot: ${candidateRoot}. Do not instruct implementation in the source baseline. Return candidateRoot exactly.`,
      `Operational inputContextPath: ${input.path}; identity ${JSON.stringify(input.identity)}. Return inputContextPath exactly. This supplies the complete product-relative change inventory authority, dependency realpaths, original requirement reference, and final manual-PASS evidence. Do not replace final approved evidence with an older report's initial hash or require control-root git enumeration.`,
      `Verified prerequisites: ${JSON.stringify(task.dependsOn.map(id=>({id,verification:this.state.tasks[id].verification,targetId:this.state.tasks[id].acceptedTarget?.targetId,artifactPaths:this.state.tasks[id].artifacts})))}`,
      `Previous same-task verdict (if any): ${JSON.stringify(previous)}. Previous operating block: ${JSON.stringify(row.previousBlockedResponse??null)}. ${reviewRepair}`,
      `Quote every assigned acceptance/preservation condition and declare narrow writablePaths. .reports is reserved for artifacts. Product criteria, source locks, functional prompt and thresholds remain immutable. Supervisor relay and guardian implementation/verification handoff are controller work after the implementation response, never prerequisites to returning that response. Missing evidence must be reported for controller/guardian handling rather than requesting a future audit from inside implementation.`,
      `Task ${task.id} has independent acceptance. Whole REVIEW gates are checked after all tasks in this REVIEW pass. Reuse unchanged prior input-hash evidence only after rechecking eligibility; never infer PASS from the old blocked report.`].join('\n\n');
    const response=await this.turn('supervisor','supervisor',this.state.reviewWorkspace.directory,path.join(row.attemptDirectory,'assignment'),request,TASK_ASSIGNMENT_SCHEMA,{taskId:task.id,review:this.state.review});
    row.assignment=validateAssignment(task,this.state.review,response.result,{candidateRoot,inputContextPath:input.path});row.assignmentReceipt=response.responseIdentity;row.status=row.assignment.action==='blocked'?'blocked':'assigned';this.save();return row;
  }
  async implement(task,lane){
    const row=this.state.tasks[task.id];
    const continuation=row.operatingContinuation?.revision===row.implementationRevision?row.operatingContinuation:null;
    let continuationRequest,execution={};
    if(continuation){
      // Authenticate the original assignment before reusing its native thread.
      // Persist one absolute budget; reload/reconciliation cannot renew it.
      validateIdentities(this.root,[continuation.repair,continuation.sourceAudit,continuation.originalRequest,continuation.originalResponse,continuation.contract]);
      const request=read(resolveInside(this.root,continuation.originalRequest.path)),response=read(resolveInside(this.root,continuation.originalResponse.path));
      const dispatchFile=path.join(path.dirname(resolveInside(this.root,continuation.originalRequest.path)),'dispatch.json'),dispatch=read(dispatchFile);
      const contract=validateContractIdentity(this.root,continuation.contract),candidate=path.join(row.attemptDirectory,'candidate');
      validateIdentities(this.root,[dispatch.requestIdentity,response.requestIdentity]);
      if(!inside(row.attemptDirectory,dispatchFile)||resolveInside(this.root,continuation.originalResponse.path)!==path.join(path.dirname(dispatchFile),'response.json')||continuation.attempt!==row.attempt||continuation.candidateRoot!==candidate||row.workspace?.directory!==candidate||row.implementationRevision!==continuation.revision||digest(row.contractIdentity)!==digest(continuation.contract)||contract.taskId!==task.id||contract.review!==this.state.review||request.role!=='implementer'||!request.key||request.taskId!==task.id||request.review!==this.state.review||typeof request.prompt!=='string'||request.schemaDigest!==digest(CONTROLLER_TASK_IMPLEMENTATION_SCHEMA)||response.schemaDigest!==request.schemaDigest||response.result.status!=='blocked'||response.result.taskId!==task.id||response.result.candidateRoot!==candidate||[request.cwd,response.cwd,dispatch.cwd].some(cwd=>cwd!==candidate)||!dispatch.threadId||!response.turnId||dispatch.turnId!==response.turnId||digest(dispatch.requestIdentity)!==digest(continuation.originalRequest)||digest(response.requestIdentity)!==digest(continuation.originalRequest))throw Error('Target binding: operating continuation differs from its original blocked assignment');
      if(!continuation.startedAt&&response.productSourceDigest!==digest(productSnapshot(candidate)))throw Error('Target binding: blocked candidate changed before continuation');
      if(this.state.threads[request.key]&&this.state.threads[request.key]!==dispatch.threadId)throw Error('Operating continuation cannot replace the original implementation thread');
      this.state.threads[request.key]=dispatch.threadId;row.implementationKey=request.key;
      if(!continuation.startedAt){continuation.startedAt=stamp();continuation.deadlineAt=new Date(Date.parse(continuation.startedAt)+600000).toISOString();}
      if(Date.parse(continuation.deadlineAt)!==Date.parse(continuation.startedAt)+600000)throw Error('Operating continuation deadline changed');
      execution={deadlineAt:continuation.deadlineAt,expectedThreadId:dispatch.threadId,singleContinuation:true};continuationRequest=request.prompt;this.save();
    }
    const candidateRoot=path.join(row.attemptDirectory,'candidate');
    validateAssignment(task,this.state.review,row.assignment,{candidateRoot});
    validateIdentities(this.root,[row.inputContext]);
    const input=read(resolveInside(this.root,row.inputContext.path));
    if(input.taskId!==task.id||path.resolve(input.candidateRoot)!==candidateRoot||!inside(row.attemptDirectory,resolveInside(this.root,row.inputContext.path))||row.workspace&&path.resolve(row.workspace.directory)!==candidateRoot)throw Error('Target binding: implementation candidate/context belongs to another attempt');
    // A remaining sibling can occupy a different batch position after resume.
    // Its native session identity belongs to the attempt, not that position.
    row.implementationKey=implementationSessionKey(task.id,row.implementationKey);
    if(!row.workspace){row.workspace=prepareWorkspace(this.state.reviewWorkspace.directory,path.join(row.attemptDirectory,'candidate'),row.assignment,{controlRoot:this.root,sourceOnly:true});this.save();}
    const cwd=row.workspace.directory;row.status='running';this.state.phase='implement';this.state.nextAction=`태스크 ${task.id} 구현 중`;this.save();
    const prompt=[`Implement exactly taskId=${task.id}, review=${this.state.review}.`,JSON.stringify(task),row.assignment.instructions,`Actual product cwd/candidateRoot: ${cwd}. All product imports, tests and generated inputs must bind to this root; never use original ${this.root} as product fallback.`,`Operational input context ${resolveInside(this.root,row.inputContext.path)} identity ${JSON.stringify(row.inputContext)}. Use its product-relative complete inventory, exact shared dependency pins, final approved evidence and historical reference paths. The controller performs guardian handoff after your response; a future audit is not a completion prerequisite. Include this context identity as a relevant input.`,`Allowed product writes only: ${JSON.stringify(row.assignment.writablePaths)}. Put scratch/artifacts in ${cwd}/.reports. Do not put .reports artifacts in changedFiles. Read required local Next docs before application code edits.`,`Dependencies' immutable reports: ${JSON.stringify(task.dependsOn.map(id=>({id,verification:this.state.tasks[id].verification,artifacts:this.state.tasks[id].artifacts})))}`,`Finish by writing version1 input manifest {version:1,inputs:[{path,sha256,byteLength}]} under .reports with actual relevant shared input pins. Return its absolute path as inputManifestPath, exact candidateRoot, taskId, changedFiles and actual artifactPaths. Completion is not a PASS. If impossible return blocked with evidence; controller routes it to guardian. Do not run full-world/build/browser checks unless assigned by this task. Use actual Vitest test/expect suites with candidate-bound compact results; Node CLI, node:test, and raw logs cannot replace verification.`].join('\n\n');
    const fastInstructions=this.controllerVitest?'\n\nThis run uses controller-vitest acceptance. The fixed contract instructions above take precedence for execution ownership: prepare testPlanPath and real tests, then return. The controller runs the official suite; there is no supervisor relay, per-task verifier model, or per-task stage journal. Do not wait for a future audit.':'';
    const resumeInstructions=row.resumeEvidence?`\n\nContinue this exact candidate after proven operating repair ${JSON.stringify(row.resumeEvidence)}. Original blocked responses ${JSON.stringify(row.blockedImplementationHistory)} are preserved. Inspect completed artifacts and resume only unfinished work; do not repeat completed generation.`:'';
    const continuationInstructions=continuation?`\n\nOne controller-owned continuation of the original BLOCKED response ${JSON.stringify(continuation.originalResponse)}, repair receipt ${JSON.stringify(continuation.repair)}, incident ${JSON.stringify(continuation.incident)}. Started ${continuation.startedAt}; absolute deadline ${continuation.deadlineAt}. Preserve the original task, contract ${JSON.stringify(continuation.contract)}, attempt and candidate. Complete only missing assigned artifacts or return concrete current blocking evidence. Inspect and preserve finished work; report cumulative changedFiles for this attempt. Current operational input context ${JSON.stringify(row.inputContext)} supersedes historical operational context only. Never edit prior responses, rebind another candidate's artifacts, weaken frozen tests/criteria, select an ineligible policy, approve REVIEW, or start later tasks. User stop and real external holds remain binding.`:'';
    const response=await this.turn('implementer',row.implementationKey,cwd,path.join(row.attemptDirectory,row.implementationRevision??'implementation'),continuation?continuationRequest+continuationInstructions:prompt+fastInstructions+resumeInstructions,this.controllerVitest?CONTROLLER_TASK_IMPLEMENTATION_SCHEMA:TASK_IMPLEMENTATION_SCHEMA,{taskId:task.id,review:this.state.review},execution);
    const result=response.result;
    if(result.taskId!==task.id||path.resolve(result.candidateRoot)!==cwd)throw Error('Target binding: implementer returned a different task/root');
    row.implementation=response;row.artifacts=result.artifactPaths;
    const changedFiles=this.confirmedImplementationChanges(task,response);
    planWorkspaceMerge(this.state.reviewWorkspace.directory,row.workspace,row.assignment,changedFiles);
    if(result.status!=='completed'){row.status='blocked';row.blocker=result.summary;this.save();return;}
    let boundManifest=result.inputManifestPath;
    if(this.controllerVitest){
      const bound=prepareControllerImplementationInputs(this.root,{candidateRoot:cwd,attemptDirectory:row.attemptDirectory,response});
      boundManifest=bound.artifactManifest;row.artifactIdentities=bound.artifacts;
    }
    row.target??=captureProductTarget(this.root,cwd,path.join(row.attemptDirectory,'target'),{requestIdentity:response.requestIdentity,responseIdentity:response.responseIdentity,turnId:response.turnId,artifactManifest:boundManifest,review:this.state.review});
    this.assertCurrentTaskTarget(task);
    const manifest=validateProductTarget(this.root,row.target),extra=new Map(manifest.extraInputs.map(pin=>[path.resolve(this.root,pin.path).toLowerCase(),pin]));
    for(const name of changedFiles.filter(name=>/^(data|public)\//.test(name))){const file=path.join(cwd,name);if(fs.existsSync(file)&&!extra.has(file.toLowerCase()))throw Error(`Target binding: generated product bytes missing from manifest ${name}`);}
    const localPin=pin=>({...pin,path:inside(cwd,resolveInside(this.root,pin.path))?path.relative(cwd,resolveInside(this.root,pin.path)).replaceAll('\\','/'):path.resolve(this.root,pin.path)});
    row.contentRevision=digest({source:manifest.source,inputs:manifest.extraInputs.filter(pin=>path.resolve(this.root,pin.path)!==path.resolve(result.inputManifestPath)).map(localPin),artifacts:result.artifactPaths.map(name=>localPin(fileIdentity(this.root,name)))});
    if(row.failedRevision===row.contentRevision)throw Error('Candidate unchanged after repair; no duplicate verifier dispatch');
    row.status='implemented';this.save();
  }
  stageInstructions(contextFile,report){
    return `Vitest is mandatory, including identity/input freeze tasks. Write real test/expect cases against the candidate's bytes and behavior; no custom audit CLI, node:test, log matching, old counts, or exit-code-only wrappers may replace assertions. Execute exact test files through node ${this.root}/scripts/prompt15-orchestrator/run-target-checks.mjs ${contextFile} <fresh output under ${report}> <exact tests>. Include the actual kind=vitest-bound-target result.json in evidence. The controller reruns those pinned Vitest tests before accepting any verdict. Product is read-only. Keep stdout/stderr <=256KiB each, compact reporter only. Preserve independent stage journals: use ${this.root}/scripts/prompt15-orchestrator/verification-stages-compact.mjs register|run|check with the exact context gates; stage commands must execute this Vitest runner, pin executable/runner/tests, and assert the actual Vitest result. Read the stage API before registering. A final PASS must attest stages/progress.json, target manifest and original implementation request. Existing identity-audit.test.ts in this report is a prepared Vitest suite: inspect its actual coverage and use it without weakening assertions. Run this assignment's scope only.`;
  }
  async verify(task,lane){
    if(this.controllerVitest)return this.verifyAutomatically(task);
    const row=this.state.tasks[task.id],revision=row.verificationRevision??'vitest-001',report=path.join(row.attemptDirectory,`verification-${revision}`);
    await this.reconcileVerificationDispatches(task,report);
    fs.mkdirSync(report,{recursive:true});
    row.verificationDirectory=report;
    validateProductTarget(this.root,row.target);
    const relay=await this.turn('supervisor','supervisor',this.state.reviewWorkspace.directory,path.join(row.attemptDirectory,`relay-${revision}`),`Relay only task ${task.id} to independent verifier. User explicitly requires Vitest test/expect and actual candidate-bound execution; custom Node audit CLIs and log-based verdicts cannot substitute. Preserve original task requirements and implementation request ${row.implementation.requestIdentity.path}; receipt ${row.implementation.responseIdentity.path}. Target ${JSON.stringify(row.target)}. Do not issue PASS. Return taskId, review, verificationPrompt.`,TASK_RELAY_SCHEMA,{taskId:task.id,review:this.state.review});
    if(relay.result.taskId!==task.id||relay.result.review!==this.state.review)throw Error('Target binding: relay lost task identity');
    const context={version:1,jobId:`${this.state.runId}-${task.id}-${row.attempt}-${revision}`,taskId:task.id,review:this.state.review,root:this.root,reportDirectory:this.relative(report),requiredGates:TASK_GATES,productRoot:row.target.productRoot,productTarget:row.target,verificationFramework:'vitest'};
    const contextFile=path.join(report,'job-context.json');if(!fs.existsSync(contextFile))atomicJSON(contextFile,context);else if(digest(read(contextFile))!==digest(context))throw Error('Target binding: verification context changed');
    row.status='verifying';this.state.phase='task_verify';this.state.currentProductTarget=row.target;this.save();
    const prompt=[`Independently verify only task ${task.id}, REVIEW ${this.state.review}.`,JSON.stringify(task),relay.result.verificationPrompt,`Original implementation request: ${resolveInside(this.root,row.implementation.requestIdentity.path)}; receipt ${resolveInside(this.root,row.implementation.responseIdentity.path)}. Check every assigned instruction against actual bytes/behavior, scope preservation, and executed evidence. Required check ids ${TASK_GATES.join(', ')}.`,`Exact candidateRoot ${row.target.productRoot}, targetId ${row.target.targetId}. Read-only candidate; writable evidence directory ${report}. Do not substitute original root. Return exact taskId/review/candidateRoot/targetId.`,this.stageInstructions(contextFile,report),`Inputs must include ${JSON.stringify(row.target.manifest)} and ${JSON.stringify(row.implementation.requestIdentity)}. Return pass only with all scoped requirements supported by fresh actual evidence. Do not demand future task implementation or issue whole REVIEW PASS. Real product failure=>fail/implementation; executable/permission/provider environment failure=>blocked/environment; include actual error, never retry unchanged input. Do not relax functional spec, gates, thresholds, or edit product/control files.`].join('\n\n');
    const recovery=row.environmentRecoveryHistory?.at(-1);
    const recoveryInstructions=recovery?`\n\nEnvironment recovery evidence ${JSON.stringify(recovery.evidence)}. The original BLOCKED response is retained at ${JSON.stringify(recovery.sourceResponse)}. Same candidate and attempt; the new report directory is controller-owned and the Vitest runner uses temp files inside its output. The exact sandbox restrictions already executed the prepared suite successfully. Inspect the recovery receipt and run this independent assignment in the new report; do not treat the old directory failure as a current result.`:'';
    const response=await this.turn('verifier',`vitest-verifier-${lane}`,row.target.productRoot,report,prompt+recoveryInstructions,TASK_ASSESSMENT_SCHEMA,{taskId:task.id,review:this.state.review});
    let result=this.normalizeConfirmedVerification(report,response);
    if(result.taskId!==task.id)throw Error('Target binding: wrong task verdict');
    validateVerification(this.root,report,this.state.review,result,TASK_GATES);attestProductTarget(this.root,row.target,result);
    if(!result.inputs.some(pin=>pin.path===row.implementation.requestIdentity.path&&pin.sha256===row.implementation.requestIdentity.sha256))throw Error('Target binding: task verdict omits original instructions');
    if(result.verdict==='pass'){const stages=createVerificationStages(contextFile);await stages.validateComplete();if(!result.evidence.some(pin=>path.resolve(this.root,pin.path)===stages.summaryFile))throw Error('Task PASS must attest completed stage journal');}
    result=applyVitestResult(result,await this.vitestAttestor(this.root,contextFile,result));
    atomicJSON(path.join(report,'verdict.json'),result);row.verification=this.relative(path.join(report,'verdict.json'));this.state.latestTaskVerification=row.verification;
    row.status=result.verdict==='pass'?'verified':result.nonPassKind==='environment'||result.verdict==='blocked'?'blocked':'repair';
    if(row.status==='repair'){row.failedRevision=row.contentRevision;row.failures=(row.failures??0)+1;this.state.repairAttempts++;}
    this.event('task_verification_completed',{taskId:task.id,verdict:result.verdict,nonPassKind:result.nonPassKind,verification:row.verification});this.save();
  }
  async verifyAutomatically(task){
    this.assertCurrentTaskTarget(task);
    const row=this.state.tasks[task.id],contract=validateContractIdentity(this.root,row.contractIdentity),report=path.join(row.attemptDirectory,`verification-controller${row.testPreparation?`-preparation-${row.testPreparation.revision}`:''}${row.controllerRecoveryRevision?`-recovery-${row.controllerRecoveryRevision}`:''}`);
    let suite;
    try{suite=freezeAcceptanceSuite(this.root,path.join(this.directory,'tasks',task.id),row.target.productRoot,row.testPreparation?.planFile??row.implementation.result.testPlanPath,contract,row.testPreparation?{planRoot:row.testPreparation.planRoot}:{});}
    catch(error){
      // Malformed, unaccepted preparation is repairable. A modified accepted
      // suite still stops for operating diagnosis and is never replaced here.
      if(fs.existsSync(path.join(this.directory,'tasks',task.id,'acceptance-suite/frozen.json')))throw error;
      await this.repairTestPreparation(task,{operatingFailureKind:'test_preparation',summary:error.message,failures:[error.message]});return this.verifyAutomatically(task);
    }
    row.status='verifying';row.verificationDirectory=report;this.state.phase='task_test';this.state.currentProductTarget=row.target;
    this.state.activeOperations??={};
    this.state.activeOperations[task.id]={kind:'vitest',taskId:task.id,startedAt:stamp(),deadlineAt:new Date(Date.now()+(contract.review==='C'?3600000:600000)).toISOString()};
    this.state.activeOperation=Object.values(this.state.activeOperations)[0];this.save();
    let result;
    this.updateProductPhase({taskId:task.id},'controller-vitest',contract.review==='C'?3600000:600000);
    try{result=await verifyControllerTask({root:this.root,report,task,row,contract,suite,onExecution:({pid,timeoutMs})=>{this.state.activeOperations[task.id]={...this.state.activeOperations[task.id],pid,deadlineAt:new Date(Date.now()+timeoutMs).toISOString()};this.updateProductPhase({taskId:task.id},'controller-vitest',timeoutMs+30000);this.state.activeOperation=Object.values(this.state.activeOperations)[0];this.save();}});}
    finally{delete this.state.activeOperations[task.id];this.state.activeOperation=Object.values(this.state.activeOperations)[0];if(!this.state.activeOperation)delete this.state.activeOperation;this.updateProductPhase({taskId:task.id},'result-validation');this.save();}
    validateVerification(this.root,report,this.state.review,result,TASK_GATES);attestProductTarget(this.root,row.target,result);
    const file=path.join(report,'verdict.json');atomicJSON(file,result);row.verification=this.relative(file);this.state.latestTaskVerification=row.verification;
    row.status=result.verdict==='pass'?'verified':result.verdict==='fail'?'repair':'blocked';
    if(row.status==='repair'){row.failedRevision=row.contentRevision;row.failures=(row.failures??0)+1;this.state.repairAttempts++;}
    if(row.status==='blocked')row.blocker=result.summary;
    this.event('task_verification_completed',{taskId:task.id,verdict:result.verdict,nonPassKind:result.nonPassKind,verification:row.verification});this.save();
  }
  async repairTestPreparation(task,verdict){
    const row=this.state.tasks[task.id],contract=validateContractIdentity(this.root,row.contractIdentity),repair=this.state.guardian?.lastControllerRepair;
    const operatingRevision=repair?.status==='applied'?repair.receiptIdentity.sha256:'initial';
    if(row.preparationRepairRevision!==operatingRevision){row.preparationRepairRevision=operatingRevision;row.preparationRepairAttempts=0;}
    if((row.preparationRepairAttempts??0)>=2)throw Error(`Test preparation repeatedly failed for ${task.id}; operating test adapter or preparation instructions need repair`);
    row.preparationRepairAttempts=(row.preparationRepairAttempts??0)+1;row.testPreparationSequence=(row.testPreparationSequence??0)+1;
    const revision=row.testPreparationSequence,report=path.join(row.attemptDirectory,`test-preparation-${revision}`);
    this.state.phase='test_preparation';this.save();
    const prompt=`Repair only test preparation for taskId=${task.id}. Product candidateRoot=${row.target.productRoot} is read-only; write new test-plan.json, tests and declared support files only inside ${report}. Original requirements and fixed contract ${JSON.stringify(contract)}. Original implementation receipt ${JSON.stringify(row.implementation.responseIdentity)}. Previous failed preparation verdict ${row.verification}: ${JSON.stringify(verdict)}. Read the previous test sources in its evidence. Correct imports, syntax, helpers, runner inputs, or missing actual criterion coverage. Preserve real assertions and original expected behavior; do not hide product assertion failures, weaken expectations or replace tests with metadata/log counts. No suite has been accepted/frozen yet. Include actual tests named ${task.id}:acceptance and ${task.id}:preservation covering the full original check and a meaningful negative or preservation behavior. Use @ alias and process.env.PROMPT15_CANDIDATE_ROOT. Plan format {version:1,taskId,contractDigest,groups:[{environment:'node'|'jsdom',files:['acceptance.test.ts']}],supportFiles:[]}; paths relative to plan. Do not run the official suite: controller executes it. Return exact taskId/candidateRoot, status, testPlanPath and summary. Actual external input missing => blocked with evidence.`;
    const response=await this.turn('testPreparer',`test-preparer-${task.id}`,row.target.productRoot,report,prompt,TEST_PREPARATION_SCHEMA,{taskId:task.id,review:this.state.review});
    validateProductTarget(this.root,row.target);
    if(response.result.taskId!==task.id||path.resolve(response.result.candidateRoot)!==row.target.productRoot)throw Error('Test preparation returned another candidate');
    if(response.result.status!=='completed')throw Error(`Test preparation blocked: ${response.result.summary}`);
    row.testPreparation={revision,planFile:response.result.testPlanPath,planRoot:report,requestIdentity:response.requestIdentity,responseIdentity:response.responseIdentity};
    row.status='implemented';this.save();
  }
  merge(task){
    this.ensureRunning();
    const row=this.state.tasks[task.id];validateProductTarget(this.root,row.target);
    const changedFiles=this.confirmedImplementationChanges(task,row.implementation);
    const journalFile=path.join(row.attemptDirectory,'merge-plan.json');
    if(!fs.existsSync(journalFile)){
      const changes=planWorkspaceMerge(this.state.reviewWorkspace.directory,row.workspace,row.assignment,changedFiles);
      atomicJSON(journalFile,{destination:this.state.reviewWorkspace.directory,changes:changes.map(change=>({...change,before:row.workspace.baseline[change.name]??null,after:change.remove?null:fileIdentity(this.root,change.source).sha256}))});
    }
    const journal=read(journalFile);if(journal.destination!==this.state.reviewWorkspace.directory)throw Error('Target binding: merge destination changed');
    for(const change of journal.changes){
      const current=fs.existsSync(change.target)?fileIdentity(this.root,change.target).sha256:null;
      if(current===change.after)continue;
      if(current!==change.before)throw Error('Target binding: concurrent write during task merge');
      if(!change.remove&&fileIdentity(this.root,change.source).sha256!==change.after)throw Error('Target binding: changed merge source');
      applyWorkspaceMerge([change]);
    }
    // Artifacts remain in each frozen task candidate; dependents receive explicit
    // immutable paths, avoiding silent replacement of .reports files at joins.
    row.status='pass';row.acceptedTarget=row.target;row.passedAt=stamp();this.event('task_pass',{taskId:task.id,targetId:row.target.targetId,verification:row.verification});this.save();
  }
  async review(){return this.withProductOperation(`product-review-${this.state.review}`,()=>this.reviewOwned());}
  async reviewOwned(){
    const review=this.state.review,rows=this.plan.tasks.filter(t=>this.taskReview(t)===review);
    if(rows.some(t=>this.state.tasks[t.id].status!=='pass'))throw Error('Whole REVIEW cannot run before every assigned task passes');
    const number=this.state.activeReviewAttempt?.review===review?this.state.activeReviewAttempt.number:(this.state.reviewAttempt?.[review]??0)+1;this.state.reviewAttempt??={};this.state.reviewAttempt[review]=number;
    if(this.state.activeReviewAttempt?.review!==review)this.state.activeReviewAttempt={review,number};
    const attempt=this.state.activeReviewAttempt;
    if(attempt.block){
      const evidence=this.recoveryEvidence(attempt.block);
      if(!evidence)throw Error(`Orchestration guardian hold: REVIEW ${review} ${attempt.block.summary}`);
      validateIdentities(this.root,[attempt.block.verification]);
      attempt.recoveryHistory??=[];attempt.recoveryHistory.push({...attempt.block,resumedWith:evidence});
      attempt.verificationRevision=(attempt.verificationRevision??0)+1;delete attempt.block;
    }
    this.save();
    const report=path.join(this.directory,'reviews',`${review}-${number}`);fs.mkdirSync(report,{recursive:true});
    const suffix=attempt.verificationRevision?`-recovery-${attempt.verificationRevision}`:'',verificationReport=path.join(report,`verification${suffix}`),decisionReport=path.join(report,`decision${suffix}`);
    const targetFile=path.join(report,'target/target.json'),closureFile=path.join(report,'task-input-closure.json');
    // Rebuild the expected inventory in memory even on resume. Never replace a
    // persisted closure or silently accept missing/conflicting historical pins.
    {
      const closure=new Map();
      for(const task of rows){const row=this.state.tasks[task.id],manifest=validateProductTarget(this.root,row.acceptedTarget);const verdictFile=resolveInside(this.root,row.verification);const verdict=read(verdictFile);validateIdentities(this.root,[...verdict.inputs,...verdict.evidence]);
        for(const pin of [row.acceptedTarget.manifest,...manifest.extraInputs,...verdict.inputs,...verdict.evidence,fileIdentity(this.root,verdictFile)])closure.set(path.resolve(this.root,pin.path).toLowerCase(),pin);
        for(const name of row.artifacts??[]){const file=resolveInside(this.root,name);if(!fs.statSync(file).isFile())throw Error('Target binding: declare artifact files rather than unpinned directories');closure.set(file.toLowerCase(),fileIdentity(this.root,file));}
      }
      if(!fs.existsSync(closureFile))atomicJSON(closureFile,{version:1,inputs:[...closure.values()]});
      const historical=read(closureFile);
      if(historical.version!==1||!Array.isArray(historical.inputs))throw Error('Target binding: invalid REVIEW historical closure');
      validateIdentities(this.root,historical.inputs);
      const retained=new Map(historical.inputs.map(pin=>[resolveInside(this.root,pin.path).toLowerCase(),pin]));
      for(const [name,pin]of closure){const prior=retained.get(name);if(!prior||prior.sha256!==pin.sha256||prior.byteLength!==pin.byteLength)throw Error('Target binding: REVIEW historical closure changed');}
    }
    const productRoot=this.state.reviewWorkspace.directory,productInputsFile=path.join(report,'review-product-inputs.json');
    const historicalEvidence=fileIdentity(this.root,closureFile);
    const productInputs={version:1,kind:'review-product-inputs',review,productRoot,inputs:[...Object.keys(productSnapshot(productRoot)).map(name=>fileIdentity(this.root,path.join(productRoot,name))),historicalEvidence],historicalEvidence};
    if(!fs.existsSync(productInputsFile))atomicJSON(productInputsFile,productInputs);
    else if(digest(read(productInputsFile))!==digest(productInputs))throw Error('Target binding: REVIEW product inputs changed');
    const target=fs.existsSync(targetFile)?read(targetFile):captureProductTarget(this.root,productRoot,path.join(report,'target'),{review,artifactManifest:productInputsFile});
    const bound=validateProductTarget(this.root,target);
    if(target.productRoot!==productRoot||!bound.extraInputs.some(pin=>digest(pin)===digest(fileIdentity(this.root,productInputsFile))))throw Error('Target binding: REVIEW input roles are not bound to target');
    this.state.currentTasks=[];this.state.currentProductTarget=target;this.state.phase='verify';this.state.nextAction=`전체 REVIEW ${review} 독립 검증`;this.save();
    const context={version:1,jobId:`${this.state.runId}-review-${review}-${number}${suffix}`,review,root:this.root,reportDirectory:this.relative(verificationReport),requiredGates:GATES[review],productRoot:target.productRoot,productTarget:target,verificationFramework:'vitest'};
    fs.mkdirSync(verificationReport,{recursive:true});const contextFile=path.join(verificationReport,'job-context.json');atomicJSON(contextFile,context);
    const existingReviewRequest=path.join(verificationReport,'request.json');
    const reviewKey=fs.existsSync(existingReviewRequest)?read(existingReviewRequest).key:('vitest-review-verifier-'+review);
    const response=await this.turn('verifier',reviewKey,target.productRoot,verificationReport,[`Independently verify whole REVIEW ${review} of Prompt15; all assigned tasks passed separately, now check integration and every REVIEW gate ${GATES[review].join(', ')}.`,`Exact target ${JSON.stringify(target)}. Task verdicts/artifacts: ${JSON.stringify(rows.map(t=>({taskId:t.id,verification:this.state.tasks[t.id].verification,artifacts:this.state.tasks[t.id].artifacts})))}`,this.stageInstructions(contextFile,verificationReport),`This is whole REVIEW verification: run all actual checks required for REVIEW ${review}, including D joined branches and F final tests. No future review requirements, no cutover/deploy. inputs must include target manifest. Return taskId='REVIEW-${review}', exact targetId/candidateRoot. Environment problems are blocked/environment, never product strikes.`].join('\n\n'),TASK_ASSESSMENT_SCHEMA,{review});
    validateProductTarget(this.root,target);
    let verdict=this.normalizeConfirmedVerification(verificationReport,response);validateVerification(this.root,verificationReport,review,verdict,GATES[review]);attestProductTarget(this.root,target,verdict);
    if(verdict.verdict==='pass')await createVerificationStages(contextFile).validateComplete();
    const attestationFile=path.join(verificationReport,'controller-attested.json');
    if(fs.existsSync(attestationFile)){
      const cached=read(attestationFile);validateIdentities(this.root,[cached.response,cached.context,...cached.verdict.inputs,...cached.verdict.evidence]);
      if(digest(cached.response)!==digest(response.responseIdentity)||cached.sourceDigest!==digest(verdict)||cached.targetId!==target.targetId||digest(cached.context)!==digest(fileIdentity(this.root,contextFile)))throw Error('Whole REVIEW attestation input changed');
      await validateAttestedVitestInputs(this.root,cached.verdict);
      verdict=cached.verdict;
    }else{
      const sourceDigest=digest(verdict);this.updateProductPhase({review},'controller-vitest',this.config.turnTimeoutMs??3600000);this.save();
      try{verdict=applyVitestResult(verdict,await this.vitestAttestor(this.root,contextFile,verdict));}
      finally{this.updateProductPhase({review},'result-validation');this.save();}
      atomicJSON(attestationFile,{version:1,response:response.responseIdentity,context:fileIdentity(this.root,contextFile),sourceDigest,targetId:target.targetId,verdict});
    }
    validateProductTarget(this.root,target);
    const file=path.join(report,`verdict${suffix}.json`);if(fs.existsSync(file)){if(digest(read(file))!==digest(verdict))throw Error('Whole REVIEW verdict changed after attestation');}else atomicJSON(file,verdict);this.state.latestVerification=this.relative(file);this.save();
    await this.audit('review_decision');
    validateProductTarget(this.root,target);
    const decision=await this.turn('supervisor','supervisor',target.productRoot,decisionReport,`Whole REVIEW ${review} independent verdict ${file}. ${JSON.stringify(verdict)}. On PASS advance with repairTaskIds empty. On actual product failure repair the smallest responsible existing task IDs within REVIEW ${review}; descendants will invalidate and workspace is rebuilt from previous approved REVIEW. Never edit acceptance requirements. On environmental BLOCKED return blocked, no retries.`,REVIEW_DECISION_SCHEMA,{review});
    validateProductTarget(this.root,target);
    const action=decision.result;
    if(action.review!==review)throw Error('Invalid REVIEW decision identity');
    if(verdict.verdict==='pass'&&action.action==='advance'&&!action.repairTaskIds.length){this.state.certificates[review]={verification:fileIdentity(this.root,file),target};this.state.approvedProductTarget=target;this.state.reviewWorkspace.frozen=true;this.state.activeReviewAttempt=null;this.event('review_pass',{review,verification:this.relative(file)});return true;}
    if(verdict.nonPassKind==='environment'||action.action==='blocked'){
      const summary=[verdict.summary,action.summary,...verdict.failures].join('\n');
      attempt.block={at:stamp(),verification:fileIdentity(this.root,file),summary,external:/Human input required|requestApproval|approval (?:rejected|required)|not authenticated|unauthorized|authentication required|missing external (?:input|credential)/i.test(summary)};
      this.save();throw Error(`Orchestration guardian hold: REVIEW ${review} ${summary}`);
    }
    if(action.action!=='repair'||!action.repairTaskIds.length||action.repairTaskIds.some(id=>!rows.some(t=>t.id===id)))throw Error('Invalid REVIEW repair routing');
    if(!action.instructions?.trim())throw Error('REVIEW repair routing omits repair instructions');
    const invalid=invalidateDescendants(this.plan,this.state,action.repairTaskIds);this.state.repairRouting={review,invalid,reason:action.summary,instructions:action.instructions};
    const reviewRepair={review,invalid,seeds:action.repairTaskIds,decision:decision.responseIdentity,verification:fileIdentity(this.root,file),target};
    Object.assign(this.state.repairRouting,{decision:reviewRepair.decision,verification:reviewRepair.verification});
    for(const id of invalid)if(this.taskReview(this.plan.tasks.find(task=>task.id===id))===review)this.state.tasks[id].reviewRepair=reviewRepair;
    // Rebuild from prior approved review; unchanged valid task deltas are applied
    // only if their baseline still matches. Conflicts invalidate that task too.
    this.state.reviewWorkspace=null;this.ensureReviewWorkspace();
    for(const task of rows){const row=this.state.tasks[task.id];if(row.status==='pass'){try{const changes=planWorkspaceMerge(this.state.reviewWorkspace.directory,row.workspace,row.assignment,this.confirmedImplementationChanges(task,row.implementation));applyWorkspaceMerge(changes);}catch{invalidateDescendants(this.plan,this.state,[task.id]);}}}
    this.state.activeReviewAttempt=null;this.save();return false;
  }
  ensureReviewWorkspace(){
    if(this.state.reviewWorkspace?.review===this.state.review&&!this.state.reviewWorkspace.frozen)return;
    validateProductTarget(this.root,this.state.approvedProductTarget);
    this.state.workspaceSequence=(this.state.workspaceSequence??0)+1;
    const workspace=prepareWorkspace(this.state.approvedProductTarget.productRoot,path.join(this.directory,'work',`review-${this.state.review}-${this.state.workspaceSequence}`),{writablePaths:[]},{controlRoot:this.root,sourceOnly:true});
    this.state.reviewWorkspace={...workspace,review:this.state.review};this.state.productRoot=workspace.directory;this.save();
  }
  async runControllerTasks(){
    const active=new Map(),errors=[];let didWork=false;
    const limit=concurrencyLimit(this.config,this.plan);
    try{
      while(true){
        this.ensureRunning();
        if(!errors.length&&!this.state.supervisorOversight?.pendingRepairIdentity){
          const batch=selectTaskBatch(this.plan,this.state,this.state.review,{limit,activeTaskIds:[...active.keys()],assignmentFor:task=>taskContract(task,this.state.review)});
          const additions=batch.filter(task=>!active.has(task.id));
          if(additions.length){
            this.state.currentTasks=[...active.keys(),...additions.map(task=>task.id)];
            const needsAssignment=additions.some(task=>['pending','repair','planning'].includes(this.state.tasks[task.id].status));
            if(needsAssignment)await this.audit('task_assignment');
            for(const task of additions){
              const row=this.state.tasks[task.id];
              if(this.state.supervisorOversight?.pendingRepairIdentity)break;
              if(['pending','repair','planning'].includes(row.status))await this.withProductOperation(`product-assignment-${task.id}`,()=>this.assign(task));
              if(this.state.supervisorOversight?.pendingRepairIdentity)break;
              if([...active.keys()].some(id=>!disjointAssignments(row.assignment,this.state.tasks[id].assignment))){
                this.event('parallel_deferred',{taskId:task.id,reason:'Declared writes overlap an active task'});continue;
              }
              const promise=Promise.resolve().then(()=>this.withProductOperation(`product-task-${task.id}`,async()=>{
                if(['assigned','running'].includes(row.status))await this.implement(task,0);
                if(['implemented','verifying'].includes(row.status))await this.verify(task,0);
                if(row.status==='blocked')this.parkExternalBlock(task);
                if(row.status==='verified')this.merge(task);
                return task;
              })).then(()=>({task}),error=>({task,error}));
              active.set(task.id,promise);didWork=true;
            }
            this.state.currentTasks=[...active.keys()];this.save();
          }
        }
        if(!active.size)break;
        // A completed branch releases both its dependency edges and its slot.
        // The next admission does not wait for slower siblings in this pool.
        const finished=await Promise.race(active.values());active.delete(finished.task.id);
        if(finished.error)errors.push(finished.error);
        this.state.currentTasks=[...active.keys()];this.state.round++;completeRecovery(this.state);this.save();
      }
      if(errors.length)throw errors[0];
      if(didWork){await this.audit('implementation_handoff');await this.audit('verification_handoff');}
      return didWork;
    }finally{
      // Never close a native transport underneath another admitted branch.
      await Promise.allSettled(active.values());
    }
  }
  async run(){
    if(this.state.status==='standby')return this.state;
    // ensureRunning protects the actual stop file/owner. A permitted resume
    // can enter with status=stopped and must restore internal ownership first.
    const heldAtEntry=needsExternalInput(this.state)||['manual_hold','waiting_input'].includes(this.state.status);
    this.ensureRunning();this.state.status='running';this.state.error=null;this.save();
    const baseline=await this.withProductOperation('product-startup-validation',async()=>assertLaunchAllowed(this.root,this.config,this.state));
    if(!this.state.approvedProductTarget){this.state.approvedProductTarget=baseline.target;this.state.baselineCertificate={verification:baseline.verification,target:baseline.target,mode:'manual-independent'};}
    try{
      // Restore certified product holds before any operating audit or continuation.
      const newExecutionIncident=this.state.productBlockedHandoff&&this.state.pendingExecutionIncident&&digest(this.state.productBlockedHandoff.executionIncident??null)!==digest(this.state.pendingExecutionIncident);
      if(!heldAtEntry&&!newExecutionIncident)for(const task of this.plan.tasks.filter(task=>this.taskReview(task)===this.state.review))this.retainCompletedProductBlock(task);
      await this.server.initialize();
      if(newExecutionIncident){
        const identity=this.state.pendingExecutionIncident;validateIdentities(this.root,[identity]);const incident=read(resolveInside(this.root,identity.path));
        await this.audit('execution_failure',{executionFailure:{reason:incident.reason,evidenceIdentity:identity,reconnected:true}});
        this.state.lastExecutionIncident=identity;delete this.state.pendingExecutionIncident;this.save();
        if(!heldAtEntry)for(const task of this.plan.tasks.filter(task=>this.taskReview(task)===this.state.review))this.retainCompletedProductBlock(task);
      }
      if(!heldAtEntry&&productBlockNeedsResolution(this.state))await this.resolveInternalProductBlock(this.plan.tasks.find(task=>task.id===this.state.productBlockedHandoff.taskId));
      await this.withProductOperation('product-startup-validation',async()=>this.recoverReviewRepairHandoff());
      await this.withProductOperation('product-startup-validation',async()=>this.recoverReviewResponseProgress());
      await this.oversight.reconcilePendingAudit();
      await this.controllerRepair.reconcilePending?.();
      await this.oversight.reconcileProgress();
      await this.oversight.applyPendingRepair();
      this.state.status='running';this.state.error=null;this.save();
      // A queued audit must be admitted before a cached blocked routing decision
      // can return us to the recovery wait again.
      await this.oversight.poll();await this.oversight.applyPendingRepair();
      if(!heldAtEntry)await this.recoverAppliedBlockedHandoff();
      this.resumeParkedTasks();
      const environmentRestored=await this.restoreVerifierEnvironment();
      if(this.config.verificationFramework==='vitest')for(const task of this.plan.tasks){
        const row=this.state.tasks[task.id];
        if(row.status==='verifying'&&row.target&&row.attemptDirectory)await this.reconcileVerificationDispatches(task,path.join(row.attemptDirectory,`verification-${row.verificationRevision??'vitest-001'}`));
      }
      const lastAudit=this.state.guardian?.lastAuditIdentity;
      const priorRepair=this.state.guardian.lastControllerRepair;
      if(guardianRepairReplayAllowed(this.state)&&!this.state.supervisorOversight?.pendingRepairIdentity&&lastAudit&&(priorRepair?.sourceAudit.sha256!==lastAudit.sha256||(priorRepair.status==='blocked'&&priorRepair.engineVersion!==REPAIR_ENGINE_VERSION))){
        validateIdentities(this.root,[lastAudit]);const audit=read(resolveInside(this.root,lastAudit.path));
        if(audit.result?.decision==='hold'&&audit.result.recovery?.action==='repair_controller')await this.repairController(audit.phase);
      }
      if(this.state.pendingExecutionIncident){
        validateIdentities(this.root,[this.state.pendingExecutionIncident]);const incident=read(resolveInside(this.root,this.state.pendingExecutionIncident.path));
        await this.audit('execution_failure',{executionFailure:{reason:incident.reason,evidenceIdentity:this.state.pendingExecutionIncident,reconnected:true}});
        this.state.lastExecutionIncident=this.state.pendingExecutionIncident;delete this.state.pendingExecutionIncident;this.save();
      }
      const blockedAtResume=this.plan.tasks.find(task=>this.taskReview(task)===this.state.review&&this.state.tasks[task.id].status==='blocked'&&!this.state.tasks[task.id].parked);
      if(blockedAtResume&&!selectTaskBatch(this.plan,this.state,this.state.review,{limit:concurrencyLimit(this.config,this.plan),assignmentFor:task=>taskContract(task,this.state.review)}).length)await this.recoverBlocked(blockedAtResume);else if(!environmentRestored)await this.audit('startup');
      while(!this.stopped){
        await this.oversight.applyPendingRepair();
        this.ensureRunning();this.ensureReviewWorkspace();
        const tasks=this.plan.tasks.filter(t=>this.taskReview(t)===this.state.review);
        if(tasks.every(t=>this.state.tasks[t.id].status==='pass')){
          const approved=await this.review();completeRecovery(this.state);this.save();
          if(!approved)continue;
          const next=REPAIR_REVIEWS[REPAIR_REVIEWS.indexOf(this.state.review)+1];
          if(!next){this.state.status='standby';this.state.phase='standby';this.state.currentTasks=[];this.state.nextAction='REVIEW F PASS. Await user instructions; no deployment/cutover/Prompt16.';this.save();return this.state;}
          this.state.review=next;this.state.reviewWorkspace=null;this.save();continue;
        }
        const blocked=tasks.find(t=>this.state.tasks[t.id].status==='blocked'&&!this.state.tasks[t.id].parked);
        if(this.controllerVitest&&await this.runControllerTasks())continue;
        if(blocked){await this.recoverBlocked(blocked);continue;}
        let batch=selectTaskBatch(this.plan,this.state,this.state.review,{limit:concurrencyLimit(this.config,this.plan),assignmentFor:task=>taskContract(task,this.state.review)});
        if(!batch.length){
          const external=tasks.filter(t=>this.state.tasks[t.id].parked);
          if(this.controllerVitest&&external.length){this.state.status='waiting_input';this.state.requiredUserInput={kind:'missing_external_input',taskIds:external.map(t=>t.id),reason:'All independent available work completed; these tasks need their recorded external input'};this.save();return this.state;}
          throw Error('Orchestration guardian hold: no eligible task; dependency/state reconciliation required');
        }
        this.state.currentTasks=batch.map(t=>t.id);
        const needsAssignment=batch.some(t=>['pending','repair','planning'].includes(this.state.tasks[t.id].status));
        if(needsAssignment){this.state.nextAction=`Assign ${this.state.currentTasks.join(', ')}`;await this.audit('task_assignment');}
        if(needsAssignment){
          for(const task of batch)if(['pending','repair','planning'].includes(this.state.tasks[task.id].status))await this.assign(task);
          if(batch.some((task,index)=>batch.slice(index+1).some(other=>!disjointAssignments(this.state.tasks[task.id].assignment,this.state.tasks[other.id].assignment)))){
            batch=batch.slice(0,1);this.event('parallel_deferred',{reason:'Overlapping declared writes; retain the second assignment for serial execution'});
          }
        }
        this.state.currentTasks=batch.map(t=>t.id);this.save();
        const results=await Promise.allSettled(batch.map(async(task,lane)=>{
          const row=this.state.tasks[task.id];if(['assigned','running'].includes(row.status))await this.implement(task,lane);
          // Accept each completed branch immediately, without an implementation
          // barrier behind a slower sibling. Actual Vitest remains mandatory.
          if(this.controllerVitest){if(['implemented','verifying'].includes(row.status))await this.verify(task,lane);if(row.status==='verified')this.merge(task);}
          return task;
        }));
        const branchErrors=results.filter(result=>result.status==='rejected').map(result=>result.reason);
        if(!this.controllerVitest&&branchErrors.length)throw branchErrors[0];
        const blockedImplementation=batch.find(t=>this.state.tasks[t.id].status==='blocked');if(!this.controllerVitest&&blockedImplementation){await this.recoverBlocked(blockedImplementation);continue;}
        await this.audit('implementation_handoff');
        // Supervisor relay is sequential; independent verifier sessions may run
        // concurrently once their relay is durably recorded.
        if(!this.controllerVitest)for(let lane=0;lane<batch.length;lane++){const task=batch[lane],row=this.state.tasks[task.id];if(['implemented','verifying'].includes(row.status))await this.verify(task,lane);}
        const blockedVerification=batch.find(t=>this.state.tasks[t.id].status==='blocked');if(!this.controllerVitest&&blockedVerification){await this.recoverBlocked(blockedVerification);continue;}
        await this.audit('verification_handoff');
        for(const task of batch){const row=this.state.tasks[task.id];if(row.status==='verified')this.merge(task);}
        this.state.round++;this.save();
        completeRecovery(this.state);this.save();
        if(branchErrors.length)throw branchErrors[0];
        if(this.controllerVitest&&blockedVerification)await this.recoverBlocked(blockedVerification);
      }
      return this.state;
    }catch(error){
      if(error.code==='PRODUCT_BLOCKED')return this.state;
      if(error.code==='OPERATING_REPAIR_APPLIED'||error.code==='SUPERVISOR_RECONCILE')throw error;
      if(this.state.supervisorOversight?.pendingRepairIdentity){const reconcile=Error('Supervisor operating repair supersedes guardian retry loop');reconcile.code='SUPERVISOR_RECONCILE';reconcile.guardianHandled=true;throw reconcile;}
      if(!error.guardianHandled&&!this.stopped&&!/Task controller stopped/.test(error.message)){
        const file=path.join(this.directory,'incidents',`runtime-${Date.now()}.json`);
        atomicJSON(file,{version:1,review:this.state.review,taskIds:this.state.currentTasks??[],reason:error.message,at:stamp(),activeTurns:this.state.activeTurns??{}});
        this.state.pendingExecutionIncident=fileIdentity(this.root,file);this.save();
        if(this.controllerVitest)beginRecovery(this.state,this.state.pendingExecutionIncident,error.message);
        if(!this.server.failure){try{await this.audit('execution_failure',{executionFailure:{reason:error.message,evidenceIdentity:this.state.pendingExecutionIncident}});}catch(auditError){if(auditError.code==='OPERATING_REPAIR_APPLIED')throw auditError;this.state.guardianFailure=auditError.message;}}
      }
      this.state.status='waiting_execution';this.state.error=error.message;this.state.nextAction='운영 감시 기록과 미완료 배정을 확인한 뒤 명시적으로 재개';this.save();throw error;
    }
    finally{clearTimeout(this.notificationSaveTimer);this.notificationSaveTimer=null;this.server.off?.('notification',this.onNotification);this.notificationsAttached=false;}
  }
}
