import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {atomicJSON,fileIdentity,validateIdentities,resolveInside} from './protocol.mjs';
import {validateProductTarget,digest} from './product-target.mjs';
import {runBoundedCommand} from './bounded-output.mjs';
import {validateSupervisorRepairAuthority} from './supervisor-oversight.mjs';
import {beginOperation,endOperation,productActive} from './execution-lifecycle.mjs';

// The repairer works on copies. Authority, acceptance, transport, the repair
// engine itself, existing tests, product inputs and old receipts are not writable.
export const REPAIR_FILES=Object.freeze([
  'scripts/prompt15-orchestrator/task-workflow.mjs',
  'scripts/prompt15-orchestrator/review-repair.mjs',
  'scripts/prompt15-orchestrator/execution-lifecycle.mjs',
  'scripts/prompt15-orchestrator/task-inputs.mjs',
  'scripts/prompt15-orchestrator/task-progress.mjs',
  'scripts/prompt15-orchestrator/task-contracts.mjs',
  'scripts/prompt15-orchestrator/controller-task-verification.mjs',
  'scripts/prompt15-orchestrator/operating-recovery.mjs',
  'scripts/prompt15-orchestrator/task-scheduler.mjs',
  'scripts/prompt15-orchestrator/supervisor-oversight.mjs',
  'scripts/prompt15-orchestrator/supervisor-oversight-policy.mjs',
  'scripts/prompt15-orchestrator/turn-reconciliation.mjs',
  'scripts/prompt15-orchestrator/run-target-checks.mjs',
  'scripts/prompt15-orchestrator/bounded-output.mjs',
  'scripts/prompt15-orchestrator/run.mjs',
  'tools/prompt15-runtime.mjs',
  'tools/prompt15-session-progress-core.mjs',
  'tools/prompt15-progress-core.mjs',
  'automation/prompt15/guardian.txt',
  'automation/prompt15/test-preparer.txt',
  'docs/automation/prompt15-guardian.md',
  'docs/automation/prompt15-orchestration.md',
]);
export const REPAIR_TESTS=Object.freeze([
  'scripts/prompt15-orchestrator/task-progress.test.mjs',
  'scripts/prompt15-orchestrator/task-workflow.test.mjs',
  'scripts/prompt15-orchestrator/vitest-acceptance.test.mjs',
  'scripts/prompt15-orchestrator/vitest-transition.test.mjs',
  'scripts/prompt15-orchestrator/verifier-recovery.test.mjs',
  'scripts/prompt15-orchestrator/compact-vitest-reporter.test.mjs',
  'scripts/prompt15-orchestrator/controller-task-verification.test.mjs',
  'scripts/prompt15-orchestrator/operating-recovery.test.mjs',
  'scripts/prompt15-orchestrator/controller-workflow.test.mjs',
  'scripts/prompt15-orchestrator/task-scheduler.test.mjs',
  'scripts/prompt15-orchestrator/supervisor-oversight-policy.test.mjs',
  'scripts/prompt15-orchestrator/supervisor-oversight.test.mjs',
  'scripts/prompt15-orchestrator/operating-maintenance.test.mjs',
  'scripts/prompt15-orchestrator/parallel-workflow.test.mjs',
  'scripts/prompt15-orchestrator/input-delivery.test.mjs',
  'scripts/prompt15-orchestrator/execution-lifecycle.test.mjs',
  'scripts/prompt15-orchestrator/review-repair.test.mjs',
  'scripts/prompt15-orchestrator/blocked-harness-recovery.test.mjs',
  'scripts/prompt15-orchestrator/task17-handoff.test.mjs',
  'scripts/prompt15-orchestrator/product-block-resolution.test.mjs',
]);
export const REPAIR_ENGINE_VERSION=9;
export const REPAIR_SCHEMA={type:'object',additionalProperties:false,required:['status','summary','changedFiles','reason'],properties:{status:{type:'string',enum:['repaired','blocked']},summary:{type:'string'},changedFiles:{type:'array',items:{type:'string'},maxItems:8},reason:{type:'string'}}};
const read=file=>JSON.parse(fs.readFileSync(file,'utf8'));
const toolsRoot=fileURLToPath(new URL('../../',import.meta.url));
const now=()=>new Date().toISOString();
const ignored=new Set(['.tmp','reports']);
function files(directory,prefix=''){
  const result=[];
  for(const entry of fs.readdirSync(path.join(directory,prefix),{withFileTypes:true})){
    if(!prefix&&ignored.has(entry.name))continue;
    const name=prefix?`${prefix}/${entry.name}`:entry.name,file=path.join(directory,name);
    if(entry.isSymbolicLink()||fs.realpathSync(file).toLowerCase()!==path.resolve(file).toLowerCase())throw Error('Operating repair mirror contains a link');
    if(entry.isDirectory())result.push(...files(directory,name));else if(entry.isFile()){if(fs.statSync(file).size>2*1024*1024)throw Error('Operating repair file exceeds byte budget');result.push(name);}else throw Error('Operating repair mirror contains a nonregular file');
  }
  return result.sort();
}
function snapshot(root){return new Map(files(root).map(name=>[name,fileIdentity(root,name)]));}
function copy(root,destination,name){const source=resolveInside(root,name);if(fs.realpathSync(source).toLowerCase()!==source.toLowerCase()||!fs.lstatSync(source).isFile())throw Error('Operating repair origin must be a regular file');const target=path.join(destination,name);fs.mkdirSync(path.dirname(target),{recursive:true});fs.copyFileSync(source,target,fs.constants.COPYFILE_EXCL);}
function replacements(root,mirror,before,declared){
  if(!Array.isArray(declared)||new Set(declared).size!==declared.length)throw Error('Invalid operating repair change declaration');
  const after=snapshot(mirror),names=[...new Set([...before.keys(),...after.keys()])];
  const changed=names.filter(name=>before.get(name)?.sha256!==after.get(name)?.sha256);
  if(!changed.length||JSON.stringify([...changed].sort())!==JSON.stringify([...declared].sort()))throw Error('Operating repair diff does not match its declaration');
  for(const name of changed)if(!REPAIR_FILES.includes(name)||!after.has(name))throw Error('Operating repair attempted a protected change or deletion');
  for(const[name,pin]of before){if(fs.existsSync(path.join(root,name)))validateIdentities(root,[pin]);else throw Error('Operating repair origin changed concurrently');}
  for(const name of changed)if(!before.has(name)&&fs.existsSync(path.join(root,name)))throw Error('Operating repair new file appeared concurrently');
  return changed.map(name=>({path:name,before:before.get(name)??null,after:after.get(name)}));
}
export class GuardianControllerRepair{
  constructor({root,directory,state,config,server,save=()=>{},log=()=>{},waitForAudit=async()=>{}}){Object.assign(this,{root:path.resolve(root),directory:path.resolve(directory),state,config,server,save,log,waitForAudit});this.busy=false;}
  async reconcilePending(){
    let active=this.state.activeTurns?.['guardian-repair'];
    const id=this.state.guardian?.activeRepairId;
    if(!active&&!id)return null;
    if(!active){
      if(!/^repair-[A-Za-z0-9-]+$/.test(id))throw Error('Pending repair has an invalid owner');
      const directory=resolveInside(this.root,path.join(this.directory,'guardian/repairs',id));
      const drafts=fs.readdirSync(directory).filter(name=>/^dispatch-\d+\.json$/.test(name)).sort((a,b)=>Number(a.match(/\d+/)[0])-Number(b.match(/\d+/)[0]));
      if(drafts.length){const dispatchFile=path.join(directory,drafts.at(-1)),dispatch=read(dispatchFile);active={threadId:dispatch.threadId,turnId:dispatch.turnId,dispatchFile};}
      else{
        if(fs.readdirSync(directory).some(name=>/^request-\d+\.json$/.test(name)))throw Error('Pending repair request has no durable dispatch');
        const threadId=this.state.guardian.repairThreadId;
        if(threadId){const history=await this.server.request('thread/read',{threadId,includeTurns:true});if(history.thread?.id!==threadId||!Array.isArray(history.thread.turns)||history.thread.turns.length)throw Error('Undispatched repair thread has unconfirmed native work');}
        const file=path.join(directory,'native-reconciliation.json');if(!fs.existsSync(file))atomicJSON(file,{version:1,kind:'operating-repair-native-reconciliation',repairId:id,threadId:threadId??null,turnId:null,status:'no-dispatched-request',applied:false,observedAt:now()});
        const receipt=read(file);if(receipt.repairId!==id||receipt.threadId!==(threadId??null)||receipt.status!=='no-dispatched-request'||receipt.applied!==false)throw Error('Undispatched repair reconciliation changed');
        delete this.state.guardian.activeRepairId;if(this.state.guardian.activeAuditId===id)delete this.state.guardian.activeAuditId;this.save();return fileIdentity(this.root,file);
      }
    }
    if(!id||!/^repair-[A-Za-z0-9-]+$/.test(id)||!active.threadId)throw Error('Pending operating repair needs its exact original identity');
    const directory=resolveInside(this.root,path.join(this.directory,'guardian/repairs',id));
    const requests=fs.readdirSync(directory).filter(name=>/^request-\d+\.json$/.test(name)).sort((a,b)=>Number(a.match(/\d+/)[0])-Number(b.match(/\d+/)[0]));
    const requestFile=path.join(directory,requests.at(-1)??'missing-request'),request=read(requestFile);
    if(request.threadId!==active.threadId||path.resolve(request.mirror)!==path.join(directory,'mirror'))throw Error('Pending repair does not match its original request');
    validateIdentities(this.root,[request.sourceAudit]);
    if(request.schemaDigest&&request.schemaDigest!==digest(REPAIR_SCHEMA))throw Error('Pending repair original schema changed');
    let dispatchedTurnId=active.turnId,dispatchIdentity=null;
    if(active.dispatchFile){
      const dispatchFile=resolveInside(this.root,active.dispatchFile),expected=path.join(directory,`dispatch-${Number(requestFile.match(/request-(\d+)\.json$/)[1])}.json`);
      if(dispatchFile!==expected)throw Error('Pending repair dispatch is outside its exact original request');
      const dispatch=read(dispatchFile);validateIdentities(this.root,[dispatch.requestIdentity]);
      if(dispatch.threadId!==active.threadId||dispatch.cwd!==request.mirror||dispatch.requestIdentity.sha256!==fileIdentity(this.root,requestFile).sha256||active.turnId&&dispatch.turnId&&active.turnId!==dispatch.turnId)throw Error('Pending repair dispatch identity mismatch');
      dispatchedTurnId??=dispatch.turnId;dispatchIdentity=fileIdentity(this.root,dispatchFile);
    }
    if(!dispatchedTurnId&&(!dispatchIdentity||!request.prompt))throw Error('Pending operating repair needs its exact original identity');
    await this.server.request('thread/resume',{threadId:active.threadId,cwd:request.mirror});
    let history=await this.server.request('thread/read',{threadId:active.threadId,includeTurns:true});
    if(history.thread?.id!==active.threadId)throw Error('Pending repair returned another native thread');
    if(!Array.isArray(history.thread.turns))throw Error('Pending repair native history is unconfirmed');
    let turn=history.thread.turns.find(turn=>turn.id===dispatchedTurnId);
    if(!dispatchedTurnId){
      const matches=history.thread.turns.filter(turn=>turn.items?.some(item=>item.type==='userMessage'&&item.content?.filter(part=>part.type==='text').map(part=>part.text).join('\n')===request.prompt));
      if(matches.length>1)throw Error('Pending repair native request match is ambiguous');
      turn=matches[0];
    }
    if(dispatchedTurnId&&!turn)throw Error('Pending repair exact turn is absent from native history');
    if(history.thread.turns.some(other=>other.status==='inProgress'&&other.id!==turn?.id))throw Error('Pending repair has unrelated active native work');
    const nativeTurnId=turn?.id;
    if(turn?.status==='inProgress'){
      await this.server.request('turn/interrupt',{threadId:active.threadId,turnId:nativeTurnId});
      for(let n=0;n<20;n++){
        history=await this.server.request('thread/read',{threadId:active.threadId,includeTurns:true});turn=history.thread?.id===active.threadId?history.thread.turns?.find(turn=>turn.id===nativeTurnId):null;
        if(turn&&turn.status!=='inProgress')break;
        await new Promise(resolve=>setTimeout(resolve,100));
      }
    }
    if((dispatchedTurnId||nativeTurnId)&&!turn||turn&&!['completed','interrupted','failed'].includes(turn.status))throw Error('Pending operating repair has not confirmed termination');
    const file=path.join(directory,'native-reconciliation.json');
    const record={version:1,kind:'operating-repair-native-reconciliation',repairId:id,threadId:active.threadId,turnId:nativeTurnId??null,status:turn?.status??'no-active-native-turn',requestIdentity:fileIdentity(this.root,requestFile),dispatchIdentity,sourceAudit:request.sourceAudit,observedAt:now(),applied:false,
      ...(turn?.status==='completed'?{finalMessage:turn.items?.filter(item=>item.type==='agentMessage'&&item.phase!=='commentary').at(-1)?.text??null}:{}),
      resolution:'Original mirror and request preserved. No product result or unchecked repair is accepted; continue from a fresh current-code operating handoff.'};
    if(!fs.existsSync(file))atomicJSON(file,record);
    else{const prior=read(file);if(prior.threadId!==active.threadId||prior.turnId!==(nativeTurnId??null)||prior.status!==record.status)throw Error('Pending repair reconciliation changed');}
    const identity=fileIdentity(this.root,file);
    this.state.guardian.interruptedRepairHistory??=[];
    if(!this.state.guardian.interruptedRepairHistory.some(item=>item.reconciliation.sha256===identity.sha256))this.state.guardian.interruptedRepairHistory.push({repairId:id,reconciliation:identity,activeTurn:active});
    delete this.state.activeTurns['guardian-repair'];delete this.state.guardian.activeRepairId;
    if(this.state.guardian.activeAuditId===id)delete this.state.guardian.activeAuditId;
    this.save();this.log({kind:'guardian_repair_reconciled',repairId:id,status:record.status,reconciliation:identity});return identity;
  }
  checkSafe(targets){
    if(fs.existsSync(path.join(this.directory,'stop.json'))||Object.keys(this.state.activeTurns??{}).length||productActive(this.state))throw Error('Operating repair needs a stopped product handoff');
    const lease=this.state.activeOperations?.['operating-repair'];if(lease)Object.assign(lease,{phase:'input-validation',deadlineAt:new Date(Date.now()+600000).toISOString()});
    const key='guardian-input-validation';this.state.activeOperations??={};
    this.state.activeOperations[key]={kind:'operating-input-validation',startedAt:now(),deadlineAt:new Date(Date.now()+600000).toISOString()};this.save();
    try{for(const target of targets)validateProductTarget(this.root,target);}
    finally{delete this.state.activeOperations[key];this.save();}
  }
  async repair(args){
    if(this.busy)throw Error('Operating repair already has an active handoff');
    // Reserve admission before awaiting an existing audit. The monitor cannot
    // start another audit between the drain and the repair's safety checks.
    this.busy=true;
    const operation=beginOperation(this.state,'operating-repair','operating-repair','audit-drain',600000);this.save();
    try{await this.waitForAudit();return await this.repairWithLease(args);}
    finally{endOperation(this.state,'operating-repair',operation.id);this.busy=false;this.save();}
  }
  async repairWithLease({auditIdentity,phase,targets=[]}){
    const assertAuthorityOwner=()=>{
      const pending=this.state.supervisorOversight?.pendingRepairIdentity;
      if(pending&&pending.sha256!==auditIdentity.sha256){const error=Error('Supervisor audit superseded the guardian repair authorization');error.code='SUPERVISOR_RECONCILE';error.guardianHandled=true;throw error;}
    };
    assertAuthorityOwner();
    // One code writer for either authority. A dead owner's record is archived
    // after native reconciliation; a live owner's lease is never stolen.
    await this.reconcilePending();
    assertAuthorityOwner();
    const leaseFile=path.join(this.directory,'control/operating-repair-owner.json');fs.mkdirSync(path.dirname(leaseFile),{recursive:true});
    if(fs.existsSync(leaseFile)){
      const owner=read(leaseFile);let alive=true;try{process.kill(owner.pid,0);}catch(error){if(error.code==='ESRCH')alive=false;}
      if(alive)throw Error('Operating repair already has a live owner');
      fs.renameSync(leaseFile,path.join(path.dirname(leaseFile),`operating-repair-owner-${randomUUID()}.json`));
    }
    fs.writeFileSync(leaseFile,JSON.stringify({pid:process.pid,auditIdentity,startedAt:now()}),{flag:'wx'});
    try{return await this.repairOwned({auditIdentity,phase,targets});}
    finally{if(fs.existsSync(leaseFile)&&read(leaseFile).pid===process.pid)fs.unlinkSync(leaseFile);}
  }
  async repairOwned({auditIdentity,phase,targets=[]}){
    validateIdentities(this.root,[auditIdentity]);const audit=read(resolveInside(this.root,auditIdentity.path));
    if(audit.kind==='supervisor-operating-audit')validateSupervisorRepairAuthority(this.root,this.state,audit);
    else if(audit.guardianThreadId!==this.state.guardian?.threadId)throw Error('Operating repair requires its confirmed guardian incident');
    if(audit.result?.decision!=='hold'||audit.result.recovery?.action!=='repair_controller')throw Error('Operating repair requires its confirmed operating incident');
    const previous=this.state.guardian.lastControllerRepair;
    if(previous?.sourceAudit.sha256===auditIdentity.sha256&&(previous.status==='applied'||previous.engineVersion===REPAIR_ENGINE_VERSION)){validateIdentities(this.root,[previous.receiptIdentity]);return previous;}
    await this.reconcilePending();this.checkSafe(targets);
    const id=`repair-${audit.auditId}-${randomUUID().slice(0,8)}`,directory=path.join(this.directory,'guardian/repairs',id),mirror=path.join(directory,'mirror');fs.mkdirSync(mirror,{recursive:true});
    const support=new Set(REPAIR_FILES.filter(name=>fs.existsSync(path.join(this.root,name))));
    for(const name of fs.readdirSync(path.join(this.root,'scripts/prompt15-orchestrator')))if(name.endsWith('.mjs'))support.add(`scripts/prompt15-orchestrator/${name}`);
    for(const name of ['automation/prompt15/task-plan.json',this.config.promptPath,'AGENTS.md'])if(name&&fs.existsSync(path.join(this.root,name)))support.add(name);
    for(const name of support)copy(this.root,mirror,name);
    for(const name of REPAIR_TESTS)if(!fs.existsSync(path.join(mirror,name)))throw Error('Operating repair mandatory regression test is absent');
    const before=snapshot(mirror),authority=['automation/prompt15/config.json','automation/prompt15/task-plan.json',this.config.promptPath].filter(name=>name&&fs.existsSync(path.join(this.root,name))).map(name=>fileIdentity(this.root,name));
    const record={version:1,engineVersion:REPAIR_ENGINE_VERSION,id,authority:audit.authority??'operating-guardian',sourceAudit:auditIdentity,phase,targets:targets.map(target=>({targetId:target.targetId,manifest:target.manifest})),startedAt:now(),status:'blocked',attempts:[],scope:'Operating code only. Product results, approvals and completed implementation remain unchanged.'};
    this.state.guardian.activeAuditId=id;this.state.guardian.activeRepairId=id;this.state.phase='operating_repair';this.state.nextAction='운영 감시가 제어 코드 수리·회귀 검사를 진행 중';this.save();
    try{
      const role=this.config.roles?.guardian??{};
      const instructions=`운영 감시의 실제 코드 수리 단계다. 사용자가 운영 코드 오류를 발견하면 직접 고치도록 승인했다. 이번 단계의 실제 쓰기 범위는 repair mirror ${mirror} 하나다. 원본 제품·controlRoot·state·과거 증거·프로토콜·gate·권한·config·기존 테스트는 수정 금지다. 허용 코드 ${JSON.stringify(REPAIR_FILES)}만 수정한다. 새 프로세스로 reload하기 전까지 제품 작업은 보류되어 있다. 관련 기존 테스트 ${JSON.stringify(REPAIR_TESTS)}는 controller가 직접 실행하며 수정할 수 없다. 계획이나 중지 요청으로 끝내지 말고 재현된 결함을 실제 수정한다. 수정 파일의 정확한 상대 경로를 반환한다. 추가 파일은 허용 목록에 있는 task-progress.mjs만 가능하다. 검사 산출물은 .tmp 아래만 만들고 로그를 제한한다. 제품 PASS를 발급하거나 완료된 구현을 다시 실행하지 않는다.`;
      // A repair worker starts with its actual write contract. Resuming the
      // audit-only thread can retain its initial prohibition on control edits.
      const budgetInstructions='고정 전체 회귀는 응답 뒤 controller가 별도 시간 예산으로 한 번 실행한다. worker는 전체 REPAIR_TESTS를 실행하거나 기다리지 않는다. 필요하면 최소 결함 재현만 실행하고 변경·근거를 저장한 뒤 패치를 반환한다. 미완료 검사를 PASS로 보고하지 않는다.';
      const created=await this.server.request('thread/start',{cwd:mirror,sandbox:'workspace-write',approvalPolicy:this.config.approvalPolicy,approvalsReviewer:this.config.approvalsReviewer,developerInstructions:instructions+'\n'+budgetInstructions,...(role.model?{model:role.model}:{}),...(role.effort?{config:{model_reasoning_effort:role.effort}}:{})});
      const threadId=created.thread?.id;if(!threadId||threadId===this.state.guardian.threadId)throw Error('Operating repair needs its dedicated authorized worker');
      record.guardianThreadId=this.state.guardian.threadId;record.repairThreadId=threadId;this.state.guardian.repairThreadId=threadId;this.state.threads??={};this.state.threads['guardian-repair']=threadId;this.save();
      try{await this.server.request('thread/name/set',{threadId,name:'[Prompt15] 운영 코드 수리'});}catch{/* A display name is not a repair prerequisite. */}
      let failure='';
      for(let attempt=1;attempt<=2;attempt++){
        this.checkSafe(targets);validateIdentities(this.root,authority);
        const prompt=`운영 수리 ${id}, 시도 ${attempt}. 원본 감사 ${resolveInside(this.root,auditIdentity.path)} identity ${JSON.stringify(auditIdentity)}. 원래 원인: ${audit.result.reason}\n수리 요청: ${audit.result.recovery.reason}\n감사 당시 코드 hash는 과거 관찰값이다. 현재 mirror는 자동 수리 연결을 추가한 현재 운영 코드의 복사본이다. 원래 감사나 이미 완료된 구현은 바꾸지 말고 고정 회귀 검사로 현재 결함을 확인한다. 허용 파일과 고정 회귀 검사는 developer instructions를 따른다. 실제 mirror 코드에 결함 수정을 적용하고 status=repaired, summary, changedFiles, reason을 반환한다. 다음 검사가 실패했으면 실제 원인을 고친다: ${failure.slice(0,6000)}`;
        const requestFile=path.join(directory,`request-${attempt}.json`);atomicJSON(requestFile,{threadId,mirror,prompt,sourceAudit:auditIdentity,schemaDigest:digest(REPAIR_SCHEMA)});
        const dispatchFile=path.join(directory,`dispatch-${attempt}.json`);atomicJSON(dispatchFile,{threadId,requestIdentity:fileIdentity(this.root,requestFile),cwd:mirror,startedAt:now()});
        this.state.activeTurns??={};this.state.activeTurns['guardian-repair']={threadId,taskId:audit.result.recovery.taskId??this.state.currentTasks?.[0],dispatchFile,startedAt:now(),lastActivityAt:now(),deadlineAt:new Date(Date.now()+(this.config.operatingRepairTurnTimeoutMs??600000)).toISOString(),runningCommands:{}};this.save();
        Object.assign(this.state.activeOperations['operating-repair'],{phase:'native-repair',deadlineAt:new Date(Date.now()+(this.config.operatingRepairTurnTimeoutMs??600000)+30000).toISOString()});this.save();
        let answer;try{answer=await this.server.runTurn(threadId,prompt,REPAIR_SCHEMA,{cwd:mirror,sandboxPolicy:{type:'workspaceWrite',networkAccess:false,writableRoots:[mirror]},...(role.model?{model:role.model}:{}),...(role.effort?{effort:role.effort}:{})},{executionIdleTimeoutMs:this.config.verifierExecutionIdleTimeoutMs??900000,turnTimeoutMs:this.config.operatingRepairTurnTimeoutMs??600000,onStarted:({turnId})=>{
          const dispatch=read(dispatchFile);if(dispatch.turnId&&dispatch.turnId!==turnId)throw Error('Repair start acknowledgement differs from its notification');
          atomicJSON(dispatchFile,{...dispatch,turnId});const active=this.state.activeTurns?.['guardian-repair'];if(active?.dispatchFile===dispatchFile){active.turnId=turnId;this.save();}
        }});if(answer.turnId)atomicJSON(path.join(directory,`response-${attempt}.json`),{turnId:answer.turnId,requestIdentity:fileIdentity(this.root,requestFile),result:answer.value});}
        finally{if(answer?.turnId)delete this.state.activeTurns['guardian-repair'];this.save();}
        if(!answer.turnId)throw Error('Operating repair has no confirmed response');atomicJSON(path.join(directory,`response-${attempt}.json`),{turnId:answer.turnId,requestIdentity:fileIdentity(this.root,requestFile),result:answer.value});
        if(answer.value.status!=='repaired')throw Error(`Operating repair remains blocked: ${answer.value.summary}`);
        const changes=replacements(this.root,mirror,before,answer.value.changedFiles);this.checkSafe(targets);validateIdentities(this.root,authority);
        this.state.nextAction=`운영 감시의 코드 수리 ${attempt}차 회귀 검사 중`;this.save();
        Object.assign(this.state.activeOperations['operating-repair'],{phase:'repair-regressions',deadlineAt:new Date(Date.now()+600000).toISOString()});this.save();
        const configFile=path.join(directory,`vitest-${attempt}.config.mjs`),reporter=path.join(mirror,'scripts/prompt15-orchestrator/compact-vitest-reporter.mjs');
        fs.writeFileSync(configFile,'export default '+JSON.stringify({root:mirror,cacheDir:path.join(directory,'vitest-cache'),test:{dir:path.join(mirror,'scripts/prompt15-orchestrator'),include:REPAIR_TESTS.map(file=>path.basename(file)),exclude:[],environment:'node',reporters:[reporter],silent:true,fileParallelism:false,maxWorkers:1,passWithNoTests:false,testTimeout:600000,hookTimeout:600000}})+';\n',{flag:'wx'});
        const tested=snapshot(mirror);
        const execution=await runBoundedCommand({command:[process.execPath,path.join(toolsRoot,'node_modules/vitest/vitest.mjs'),'run','--config',configFile,'--configLoader','native'],cwd:mirror,logPrefix:path.join(directory,`checks-${attempt}`),timeoutMs:600000,env:{NODE_TEST_CONTEXT:undefined}});
        let tests=null;try{tests=read(execution.stdout.path);}catch{/* No parsed result can authorize merging. */}
        const unchanged=JSON.stringify([...tested])===JSON.stringify([...snapshot(mirror)]);
        const passed=execution.exitCode===0&&!execution.signal&&tests?.complete===true&&tests.pass===true&&tests.counts?.passed>0&&!tests.counts.failed&&!tests.counts.skipped&&!tests.counts.pending&&!tests.counts.errors&&unchanged;
        record.attempts.push({attempt,responseIdentity:fileIdentity(this.root,path.join(directory,`response-${attempt}.json`)),execution,tests,inputsUnchanged:unchanged,passed});
        atomicJSON(path.join(directory,`checks-${attempt}.json`),record.attempts.at(-1));
        if(!passed){failure=JSON.stringify({exitCode:execution.exitCode,failures:tests?.failures,counts:tests?.counts,unchanged,report:path.join(directory,`checks-${attempt}.json`),stdout:execution.stdout.path,stderr:execution.stderr.path});continue;}
        this.checkSafe(targets);validateIdentities(this.root,authority);replacements(this.root,mirror,before,answer.value.changedFiles);
        const applied=[];
        try{
          for(const change of changes){const origin=path.join(this.root,change.path),backup=path.join(directory,'before',change.path);if(change.before){fs.mkdirSync(path.dirname(backup),{recursive:true});fs.copyFileSync(origin,backup,fs.constants.COPYFILE_EXCL);}fs.mkdirSync(path.dirname(origin),{recursive:true});const temporary=origin+`.repair-${randomUUID()}.tmp`;fs.copyFileSync(path.join(mirror,change.path),temporary,fs.constants.COPYFILE_EXCL);fs.renameSync(temporary,origin);applied.push(change);}
          this.checkSafe(targets);validateIdentities(this.root,authority);
        }catch(error){for(const change of applied.reverse()){const origin=path.join(this.root,change.path);if(fileIdentity(this.root,origin).sha256!==change.after.sha256)continue;if(change.before)fs.copyFileSync(path.join(directory,'before',change.path),origin);else fs.unlinkSync(origin);}throw error;}
        record.status='applied';record.changes=changes;record.summary=answer.value.summary;break;
      }
      if(record.status!=='applied')record.reason='Operating repair regressions did not pass within two attempts';
    }catch(error){record.reason=error.message;}
    finally{
      if(!this.state.activeTurns?.['guardian-repair']){delete this.state.guardian.activeAuditId;delete this.state.guardian.activeRepairId;}record.finishedAt=now();
      const file=path.join(directory,'repair-result.json');atomicJSON(file,record);const result={status:record.status,engineVersion:REPAIR_ENGINE_VERSION,sourceAudit:auditIdentity,receiptIdentity:fileIdentity(this.root,file),summary:record.summary??record.reason};
      if(previous){this.state.guardian.controllerRepairHistory??=[];this.state.guardian.controllerRepairHistory.push(previous);}
      this.state.guardian.lastControllerRepair=result;this.save();this.log({kind:'guardian_controller_repair',...result});
    }
    return this.state.guardian.lastControllerRepair;
  }
}
