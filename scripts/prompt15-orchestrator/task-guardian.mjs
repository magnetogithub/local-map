import fs from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {productSnapshot} from './product-target.mjs';

export const GUARDIAN_RULE_FILES=Object.freeze([
  'automation/prompt15/guardian.txt',
  'docs/automation/prompt15-guardian.md',
  'docs/automation/prompt15-orchestration.md',
]);
const recoverySchema={type:'object',additionalProperties:false,required:['action','taskId','evidencePaths','reason'],properties:{
  action:{type:'string',enum:['none','reassign_task','hold_external','repair_controller']},taskId:{type:'string',maxLength:32},
  evidencePaths:{type:'array',items:{type:'string',maxLength:4000},maxItems:64},reason:{type:'string',maxLength:16000},
}};
export const GUARDIAN_SCHEMA={type:'object',additionalProperties:false,required:['decision','summary','ruleChanges','reason','recovery'],properties:{
  decision:{type:'string',enum:['continue','hold','reload']},summary:{type:'string',maxLength:16000},ruleChanges:{type:'array',items:{type:'string'},maxItems:3},reason:{type:'string',maxLength:16000},
  recovery:recoverySchema,
}};
const allowedSnapshotKeys=new Set(['runId','taskId','review','phase','status','taskStatus','candidateRoot','productRoot','targetId','candidateRevision','revision',
  'assignmentIdentity','confirmedResponseIdentity','inputManifestIdentity','stateIdentity','lastTurnActivityAt','lastToolActivityAt','heartbeatAt',
  'runningCommands','eventCursor','dependencies','tasks','reviewApprovals','failedAttempt','failureKind','controllerWriteOwnership','nextAction',
  'activeTaskIds','batchTaskIds','currentTasks','activeTurns','controllerPid','baselineCertificate','commandEvidence','joinStatus','repairAttempt','executionFailure','guardian','approvedReviews','blockedTask','operatingRepair','reason']);
const decisionPolicy=Object.freeze({
  displayOnly:'권위 task status/phase, 확정 turn, 후보·증거 identity와 권한이 정확하고 nextAction/설명 문구만 stale이면 severity=low advisory를 summary/reason에 남기고 continue/none으로 다음 미완료 인계를 진행할 수 있다. 문구만으로 구현 재실행·제품 전체 정지·PASS 무효화를 요구하지 않는다.',
  mandatoryHold:'후보·증거·소유권·권한·의존성·판정이 불확실하거나 실제 turn 상태가 모순되거나 heartbeat를 실제 실행/완료 근거로 삼은 경우는 계속 hold한다. 표시 오류라는 표현으로 우회하지 않는다.',
  controllerRepair:'repair_controller는 기존 감시 thread를 보존하고 같은 운영 감시가 담당하는 전용 수리 worker 세션의 명시 allowlist repair mirror로 인계한다. 사건별 새 thread/start에서 수리 권한을 처음부터 설정하며 기존 감시 계약을 덮어쓰지 않는다. 실제 코드 수정→고정 회귀 검사→보호 identity/diff 검사→통과 시 병합 및 fresh controller 자동 재시작한다. 사용자 재허가 대기로 끝내지 않으며 승인 정책과 권한 경계는 유지한다. 일반 inspect는 여전히 세 룰 mirror만 쓴다.',
});
const deniedKey=/secret|token|webhook|password|authorization|cookie|api.?key|environment|^env$|prompt|instruction|reasoning|transcript|raw.?event|source.?code/i;
const now=()=>new Date().toISOString();
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const MAX_RULE_BYTES=1024*1024,MAX_CONTEXT_BYTES=256*1024;
const noRecovery=()=>({action:'none',taskId:'',evidencePaths:[],reason:''});
const held=(summary,reason)=>({decision:'hold',summary,ruleChanges:[],reason:scrub(reason),recovery:noRecovery()});
function contained(root,file){const relative=path.relative(root,file);return relative===''||(!relative.startsWith('..'+path.sep)&&relative!=='..'&&!path.isAbsolute(relative));}
function safeFile(root,relative){const file=path.resolve(root,relative);if(!contained(root,file))throw Error('Guardian path is outside its root');return file;}
function pin(file){const bytes=fs.readFileSync(file);return{path:path.resolve(file),sha256:hash(bytes),byteLength:bytes.length};}
function writeJSON(file,value){fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,JSON.stringify(value,null,2)+'\n',{flag:'wx'});return pin(file);}
function scrub(value,depth=0){
  if(depth>8)return '[depth-limited]';
  if(value===null||typeof value==='number'||typeof value==='boolean')return value;
  if(typeof value==='string')return value.replace(/https:\/\/(?:\w+\.)?discord(?:app)?\.com\/api\/webhooks\/[^\s"']+/gi,'[webhook-redacted]').replace(/Bearer\s+\S+/gi,'Bearer [redacted]').slice(0,4000);
  if(Array.isArray(value))return value.slice(0,64).map(item=>scrub(item,depth+1));
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).filter(([key])=>!deniedKey.test(key)).slice(0,64).map(([key,item])=>[key,scrub(item,depth+1)]));
  return null;
}
export function guardianSnapshot(snapshot){
  if(snapshot?.blockedTask)blockedEvidence(snapshot.blockedTask);
  return Object.fromEntries(Object.entries(snapshot??{}).filter(([key])=>allowedSnapshotKeys.has(key)&&!deniedKey.test(key)).map(([key,value])=>[key,scrub(value)]));
}
function blockedEvidence(value,seen=new Map(),depth=0){
  if(depth>8||!value||typeof value!=='object')return [...seen.values()];
  if(typeof value.path==='string'&&typeof value.sha256==='string'&&Number.isSafeInteger(value.byteLength)){
    if(!/^[a-f\d]{64}$/i.test(value.sha256)||value.byteLength<0)throw Error('Guardian blocker evidence has an invalid identity');
    const previous=seen.get(value.path);if(previous&&(previous.sha256!==value.sha256||previous.byteLength!==value.byteLength))throw Error('Guardian blocker evidence identities conflict');
    seen.set(value.path,{path:value.path,sha256:value.sha256,byteLength:value.byteLength});
    if(seen.size>64)throw Error('Guardian blocker evidence exceeds 64 identities');
  }else for(const[key,item]of Object.entries(value))if(!deniedKey.test(key))blockedEvidence(item,seen,depth+1);
  return [...seen.values()];
}
function checkedEvidence(root,expected){
  const file=safeFile(root,expected.path),relative=path.relative(root,file).replaceAll('\\','/');
  if(/(?:^|\/)(?:\.env(?:\.[^/]*)?|\.aws|\.codex|\.git|\.agents)(?:\/|$)|(?:^|\/)(?:secrets|credentials|auth)\.json$|^\.tmp\/discord-progress\/|\.jsonl$/i.test(relative))throw Error('Guardian blocker evidence selected a protected secret/raw-event path');
  if(!contained(root,fs.realpathSync(file))||!fs.statSync(file).isFile())throw Error('Guardian blocker evidence must be a regular workspace file');
  const bytes=fs.statSync(file).size;
  if(bytes>16*1024*1024||/\.log$/i.test(file)&&bytes>256*1024)throw Error('Guardian blocker evidence exceeds its byte budget');
  const actual=pin(file);if(actual.sha256!==expected.sha256.toLowerCase()||actual.byteLength!==expected.byteLength)throw Error('Guardian blocker evidence changed');
  return actual;
}
function externalBlocker(blocked,confirmed){
  if(blocked.requiresUserInput===true||blocked.external===true||confirmed.requiresUserInput===true||confirmed.external===true)return true;
  const categorical=[blocked.blockerKind,blocked.failureKind,confirmed.nonPassKind,confirmed.blockerKind,confirmed.failureKind].filter(Boolean).join(' ');
  const details=[...(blocked.remainingIssues??[]),...(confirmed.remainingIssues??[]),...(confirmed.failures??[]),blocked.reason,confirmed.summary].filter(Boolean).join(' ');
  return /external_permission|platform_rejection|missing_external_input|external_input|user_decision|manual_gate|authorization|authentication/i.test(categorical)||
    /permission denied|\bEACCES\b|\bEPERM\b|unauthorized|not authenticated|authentication required|(?:approval|auto.review|platform).{0,32}(?:reject|denied|refus)|(?:api.?key|credential).{0,24}(?:missing|required)|requires? user (?:decision|permission)|권한.{0,12}(?:거절|거부|부족|필요)|승인.{0,12}(?:거절|거부)|플랫폼.{0,12}(?:차단|반려)|필수 외부 입력/i.test(details);
}
function mirrorFiles(root){
  const result=new Map();
  if(fs.realpathSync(root)!==root)throw Error('Guardian mirror root must not be a symlink');
  function visit(directory){
    for(const entry of fs.readdirSync(directory,{withFileTypes:true})){
      const file=path.join(directory,entry.name),relative=path.relative(root,file).replaceAll('\\','/');
      if(entry.isSymbolicLink())throw Error('Guardian mirror contains a symlink');
      if(entry.isDirectory())visit(file);
      else if(entry.isFile()){if(fs.statSync(file).size>MAX_RULE_BYTES)throw Error('Guardian rule exceeds its byte budget');result.set(relative,pin(file));}
      else throw Error('Guardian mirror contains a nonregular entry');
    }
  }
  visit(root);return result;
}
function requireOriginal(file){if(fs.realpathSync(file)!==file||!fs.lstatSync(file).isFile())throw Error('Guardian rule origin must not be a symlink');if(fs.statSync(file).size>MAX_RULE_BYTES)throw Error('Guardian rule exceeds its byte budget');}
function replaceFile(file,bytes){const temporary=file+`.guardian-${randomUUID()}.tmp`;try{fs.writeFileSync(temporary,bytes,{flag:'wx'});fs.renameSync(temporary,file);}finally{if(fs.existsSync(temporary))fs.unlinkSync(temporary);}}
function validateResult(result){
  if(!result||!['continue','hold','reload'].includes(result.decision)||typeof result.summary!=='string'||typeof result.reason!=='string'||!Array.isArray(result.ruleChanges)||result.ruleChanges.some(name=>typeof name!=='string')||Object.keys(result).some(key=>!['decision','summary','ruleChanges','reason','recovery'].includes(key)))throw Error('Guardian structured result is invalid');
  if(result.summary.length>16000||result.reason.length>16000||result.ruleChanges.length>GUARDIAN_RULE_FILES.length||new Set(result.ruleChanges).size!==result.ruleChanges.length||result.ruleChanges.some(name=>!GUARDIAN_RULE_FILES.includes(name)))throw Error('Guardian result proposes an unauthorized rule path');
  const recovery=result.recovery??noRecovery();
  if(!recovery||!['none','reassign_task','hold_external','repair_controller'].includes(recovery.action)||typeof recovery.taskId!=='string'||recovery.taskId.length>32||!Array.isArray(recovery.evidencePaths)||recovery.evidencePaths.length>64||new Set(recovery.evidencePaths).size!==recovery.evidencePaths.length||recovery.evidencePaths.some(name=>typeof name!=='string'||!name||name.length>4000)||typeof recovery.reason!=='string'||recovery.reason.length>16000||Object.keys(recovery).some(key=>!['action','taskId','evidencePaths','reason'].includes(key)))throw Error('Guardian recovery result is invalid');
  if(recovery.action!=='none'&&!recovery.reason.trim())throw Error('Guardian recovery needs an evidence-backed reason');
  return{...result,recovery:{...recovery,evidencePaths:[...recovery.evidencePaths]}};
}

function validateRecovery(root,result,blocked,checkedPins,changes,mirror){
  const recovery=result.recovery;
  if(recovery.action==='none'){
    if(blocked?.status==='blocked'&&result.decision==='continue')throw Error('Guardian cannot continue with an unresolved blocked task');
    return{action:'none',evidence:[]};
  }
  if(blocked?.taskId&&recovery.taskId!==blocked.taskId)throw Error('Guardian recovery targets a different blocked task');
  if(['hold_external','repair_controller'].includes(recovery.action)&&result.decision!=='hold')throw Error('Guardian external/controller recovery must hold execution');
  const checked=new Map(checkedPins.map(identity=>[identity.path.toLowerCase(),identity]));
  const evidence=recovery.evidencePaths.map(name=>{
    const file=safeFile(root,name),rule=changes.find(relative=>safeFile(root,relative).toLowerCase()===file.toLowerCase()||safeFile(mirror,relative).toLowerCase()===file.toLowerCase());
    if(rule)return{kind:'rule-patch',rule,...pin(safeFile(mirror,rule))};
    const actual=checked.get(file.toLowerCase());if(!actual)throw Error('Guardian recovery evidence was not supplied by the blocked handoff');
    return{kind:'blocked-handoff',...checkedEvidence(root,actual)};
  });
  if(recovery.action!=='reassign_task')return{action:recovery.action,evidence};
  if(result.decision!=='reload'||!changes.length)throw Error('Guardian task reassignment requires a real rule repair and reload');
  if(!blocked||blocked.status!=='blocked'||!/^15-\d{2}$/.test(blocked.taskId))throw Error('Guardian task reassignment requires the actual blocked task');
  const confirmedPin=blocked.confirmedResponseIdentity;
  if(!confirmedPin)throw Error('Guardian task reassignment requires the confirmed blocked response');
  const confirmedFile=safeFile(root,confirmedPin.path),record=JSON.parse(fs.readFileSync(confirmedFile,'utf8')),confirmed=record.result;
  if(!record.turnId||!confirmed||!(confirmed.status==='blocked'||confirmed.verdict==='blocked'||confirmed.action==='blocked')||confirmed.taskId!==blocked.taskId)throw Error('Guardian task reassignment requires an exact confirmed blocked turn');
  if(blocked.nonPassKind==='implementation'||confirmed.nonPassKind==='implementation')throw Error('Guardian cannot reclassify a product failure as an operating repair');
  if(externalBlocker(blocked,confirmed))throw Error('Guardian cannot automatically reassign an external/permission/platform blocker');
  const contains=expected=>evidence.some(identity=>identity.path.toLowerCase()===safeFile(root,expected.path).toLowerCase()&&identity.sha256===expected.sha256.toLowerCase());
  if(!contains(confirmedPin))throw Error('Guardian recovery must cite the actual blocked response');
  const repairPins=blocked.repairEvidenceIdentities??[];
  if(!Array.isArray(repairPins)||!repairPins.length||!repairPins.every(contains))throw Error('Guardian recovery must cite all supplied operating repair evidence');
  if(changes.some(rule=>!evidence.some(identity=>identity.kind==='rule-patch'&&identity.rule===rule)))throw Error('Guardian recovery must cite every actual rule repair');
  return{action:'reassign_task',taskId:blocked.taskId,evidence};
}

/** Independent operating audit; all model writes occur in a disposable rule mirror. */
export class TaskGuardian{
  constructor({root,directory,config,server,log=()=>{},state,save=()=>{}}){
    this.root=fs.realpathSync(root);this.directory=path.resolve(directory);this.config=config;this.server=server;this.log=log;this.state=state;this.save=save;
    if(!contained(this.root,this.directory))throw Error('Guardian run directory must stay inside control root');
    this.state.guardian??={};this.ready=false;
  }
  async thread(){
    if(this.ready)return this.state.guardian.threadId;
    const settings=this.config.roles?.guardian??this.config.roles?.supervisor??{};
    const cwd=path.join(this.directory,'guardian','session');fs.mkdirSync(cwd,{recursive:true});
    const instructions=fs.readFileSync(safeFile(this.root,'automation/prompt15/guardian.txt'),'utf8')+
      '\n\n이번 연결은 일반 운영 감사 inspect다. 제품 기능 프롬프트나 다른 역할의 대화를 받지 않는다. 이 turn은 3개 운영 규칙의 격리 mirror만 수정 가능하다. 실제 controlRoot·제품·state·controller 코드는 이 inspect에서 쓰기 금지다. controller 코드 문제는 hold/recovery.action=repair_controller와 재현 근거를 반환하면 기존 감시 thread를 보존하고 전용 수리 worker 세션으로 자동 인계된다. 수리 worker는 사건별 thread/start로 수리 allowlist를 초기 설정하며 기존 감시 세션의 계약을 덮어쓰지 않는다. 실제 코드 수정과 고정 검사 후 controller가 병합·자동 재시작하고 기존 감시는 결과를 재감사한다. 승인 정책은 그대로 유지하며 사용자 재허가 대기로 끝내지 않는다. audit-result.json은 controller가 기록하므로 mirror에 생성하지 말고 최종 JSON으로만 반환한다. 운영 규칙을 실제 수정한 경우 decision=reload와 정확한 ruleChanges를 반환한다. blockedTask가 있으면 실제 원본 배정·확정 BLOCKED 응답·입력/산출물·수리 증거 identity를 읽고 원인을 판정한다. 실제 룰 수정과 모든 수리 증거가 있고 외부 차단이 아닐 때만 recovery.action=reassign_task를 제안한다. 권한·플랫폼 반려·필수 외부 입력은 hold_external이며 같은 요청 자동 재시도나 우회는 금지다. 다른 역할을 호출하거나 메시지 보내지 않는다.\n감사 판단 정책:\n'+JSON.stringify(decisionPolicy);
    const prior=this.state.guardian.threadId;
    const params={cwd,sandbox:'workspace-write',approvalPolicy:this.config.approvalPolicy,approvalsReviewer:this.config.approvalsReviewer,developerInstructions:instructions,
      ...(settings.model?{model:settings.model}:{}),...(settings.effort?{config:{model_reasoning_effort:settings.effort}}:{})};
    const response=await this.server.request(prior?'thread/resume':'thread/start',prior?{...params,threadId:prior}:params);
    if(!response?.thread?.id||prior&&response.thread.id!==prior)throw Error('Guardian thread identity was not preserved');
    this.state.guardian.threadId=response.thread.id;this.state.guardian.connectedAt=now();this.save();this.ready=true;
    try{await this.server.request('thread/name/set',{threadId:response.thread.id,name:'[Prompt15] 운영 감사'});}catch{this.log({kind:'guardian_name_pending',threadId:response.thread.id});}
    this.log({kind:prior?'guardian_resumed':'guardian_created',threadId:response.thread.id});return response.thread.id;
  }
  protectedSnapshot(snapshot){
    const protectedPaths=['automation/prompt15/config.json','automation/prompt15/task-plan.json',this.config.promptPath,'scripts/prompt15-orchestrator/protocol.mjs'].filter(Boolean);
    const files=Object.fromEntries(protectedPaths.filter(name=>fs.existsSync(safeFile(this.root,name))).map(name=>[name,pin(safeFile(this.root,name))]));
    const candidate=snapshot.candidateRoot??snapshot.productRoot??this.state.productRoot;
    let product=null;
    if(candidate){const resolved=path.resolve(this.root,candidate);if(!contained(this.root,resolved)||!contained(this.root,fs.realpathSync(resolved)))throw Error('Guardian product reference is outside control root');product={root:resolved,source:productSnapshot(resolved)};}
    return{files,product};
  }
  async inspect(snapshot={},{phase}={}){
    if(this.inspecting)return held('운영 감사 중복 배정을 차단했습니다.','Guardian already has an active inspection');
    this.inspecting=true;
    const auditId=`${String((this.state.guardian.sequence??0)+1).padStart(5,'0')}-${randomUUID().slice(0,8)}`;
    const directory=path.join(this.directory,'guardian','audits',auditId),mirror=path.join(directory,'mirror');
    let requestIdentity=null,responseIdentity=null,normalizedResponseIdentity=null,recoveryEvidenceIdentity=null,threadId=null,result,changes=[],before=null;
    this.state.guardian.sequence=(this.state.guardian.sequence??0)+1;this.state.guardian.activeAuditId=auditId;
    this.state.guardian.activeAuditStartedAt=now();this.state.guardian.activeAuditDeadlineAt=new Date(Date.now()+(this.config.supervisorOversight?.auditTimeoutMs??180000)).toISOString();
    try{
      this.save();
      fs.mkdirSync(mirror,{recursive:true});
      before=new Map();
      for(const name of GUARDIAN_RULE_FILES){const origin=safeFile(this.root,name);requireOriginal(origin);const original=pin(origin);before.set(name,original);const target=safeFile(mirror,name);fs.mkdirSync(path.dirname(target),{recursive:true});fs.copyFileSync(origin,target,fs.constants.COPYFILE_EXCL);}
      const protectedBefore=this.protectedSnapshot(snapshot);
      const summary=guardianSnapshot(snapshot),blockedPins=blockedEvidence(summary.blockedTask).map(expected=>checkedEvidence(this.root,expected));
      const context={version:1,auditId,runId:this.state.runId??path.basename(this.directory),runDirectory:this.directory,controlRoot:this.root,runStatePath:path.join(this.directory,'state.json'),
        agentsPath:path.join(this.root,'AGENTS.md'),guardianThreadId:this.state.guardian.threadId??null,phase:phase??snapshot.phase??null,observedAt:now(),snapshot:summary,blockedEvidenceIdentities:blockedPins,ruleMirror:mirror,
        writableRulePaths:GUARDIAN_RULE_FILES,decisionPolicy,originalRules:[...before.values()],protectedInputDigest:hash(JSON.stringify(protectedBefore))};
      if(Buffer.byteLength(JSON.stringify(context))>MAX_CONTEXT_BYTES)throw Error('Guardian snapshot exceeds its byte budget');
      const contextIdentity=writeJSON(path.join(directory,'audit-context.json'),context);
      threadId=await this.thread();
      const request=`운영 감사 배정 ${auditId}. audit-context: ${contextIdentity.path}\n${JSON.stringify(context)}\n실제 제품의 기능이나 REVIEW를 판정하지 말고 배정·후보 전달·의존성·실행 정체·실패 집계만 검사한다. blockedTask가 있으면 요약만으로 정상 진행을 추정하지 말고 명시된 차단 응답과 수리 증거를 확인한다. 필요시 ruleMirror 아래 허용된 세 파일만 수정한다. 추가 파일 생성 금지. 실제 controlRoot와 제품은 읽기 전용이다. 코드 수리가 필요하면 hold/recovery.action=repair_controller로 원인·재현·안전 중지 요청을 반환한다. 권한·플랫폼 반려·외부 입력은 hold/hold_external이며 자동 재시도하지 않는다. reassign_task는 같은 taskId의 확정 BLOCKED 응답과 모든 repairEvidenceIdentities 및 실제 수정한 룰 파일을 recovery.evidencePaths로 인용하고 decision=reload일 때만 가능하다. 정상/복구 불필요면 recovery={action:'none',taskId:'',evidencePaths:[],reason:''}를 쓴다. 최종 응답은 decision,summary,ruleChanges,reason,recovery JSON이다.`;
      const requestFile=path.join(directory,'guardian-request.txt');fs.writeFileSync(requestFile,request+'\n',{flag:'wx'});requestIdentity=pin(requestFile);
      const settings=this.config.roles?.guardian??this.config.roles?.supervisor??{};
      const response=await this.server.runTurn(threadId,request,GUARDIAN_SCHEMA,{cwd:mirror,sandboxPolicy:{type:'workspaceWrite',networkAccess:false,writableRoots:[mirror]},
        ...(settings.model?{model:settings.model}:{}),...(settings.effort?{effort:settings.effort}:{})},{executionIdleTimeoutMs:this.config.guardianExecutionIdleTimeoutMs??120000,turnTimeoutMs:this.config.supervisorOversight?.auditTimeoutMs??180000});
      if(!response?.turnId)throw Error('Guardian output has no confirmed completed turn');
      result=response.value;
      const originalResponse={threadId,turnId:response.turnId,requestIdentity,result,...(typeof response.text==='string'?{nativeFinalText:response.text}:{})};
      if(Buffer.byteLength(JSON.stringify(originalResponse))>256*1024)throw Error('Guardian response exceeds its byte budget');
      responseIdentity=writeJSON(path.join(directory,'guardian-response.json'),originalResponse);
      result=validateResult(result);
      const after=mirrorFiles(mirror);
      if([...after.keys()].some(name=>!GUARDIAN_RULE_FILES.includes(name))||after.size!==GUARDIAN_RULE_FILES.length)throw Error('Guardian wrote outside the allowed rule files');
      changes=GUARDIAN_RULE_FILES.filter(name=>before.get(name).sha256!==after.get(name).sha256);
      if(JSON.stringify([...changes].sort())!==JSON.stringify([...result.ruleChanges].sort()))throw Error('Guardian declared ruleChanges do not match actual mirror edits');
      if(hash(JSON.stringify(protectedBefore))!==hash(JSON.stringify(this.protectedSnapshot(snapshot))))throw Error('Guardian protected input changed during operating audit');
      for(const[name,original]of before){const origin=safeFile(this.root,name);requireOriginal(origin);if(pin(origin).sha256!==original.sha256)throw Error('Guardian rule origin changed concurrently; refusing merge');}
      if(changes.length&&result.decision!=='reload')throw Error('Guardian rule edits require an explicit reload decision');
      for(const expected of blockedPins)checkedEvidence(this.root,expected);
      const recovery=validateRecovery(this.root,result,summary.blockedTask,blockedPins,changes,mirror);
      const patches=[];
      for(const name of changes){const origin=safeFile(this.root,name),backup=safeFile(path.join(directory,'before'),name);fs.mkdirSync(path.dirname(backup),{recursive:true});fs.copyFileSync(origin,backup,fs.constants.COPYFILE_EXCL);patches.push({path:name,before:before.get(name),after:after.get(name),backup:pin(backup)});}
      // All files and protected inputs are checked before any allowed merge.
      const applied=[];
      try{
        for(const name of changes){replaceFile(safeFile(this.root,name),fs.readFileSync(safeFile(mirror,name)));applied.push(name);}
        if(changes.length)writeJSON(path.join(directory,'rule-patches.json'),{version:1,auditId,patches});
      }catch(error){
        for(const name of applied.reverse()){const origin=safeFile(this.root,name);requireOriginal(origin);if(pin(origin).sha256===after.get(name).sha256)replaceFile(origin,fs.readFileSync(safeFile(path.join(directory,'before'),name)));}
        throw error;
      }
      if(changes.length)this.ready=false;
      if(recovery.action!=='none')recoveryEvidenceIdentity=writeJSON(path.join(directory,'recovery-evidence.json'),{version:1,auditId,requestIdentity,responseIdentity,...recovery,patches});
      result={decision:result.decision,summary:scrub(result.summary),ruleChanges:changes,reason:scrub(result.reason),recovery:scrub(result.recovery)};
      normalizedResponseIdentity=writeJSON(path.join(directory,'normalized-response.json'),{version:1,auditId,responseIdentity,recoveryEvidenceIdentity,result});
    }catch(error){
      result=held('오케스트레이션 감사가 안전한 진행을 확인하지 못했습니다.',error.message);
    }finally{
      this.inspecting=false;delete this.state.guardian.activeAuditId;delete this.state.guardian.activeAuditStartedAt;delete this.state.guardian.activeAuditDeadlineAt;
      this.state.guardian.lastCheckedAt=now();this.state.guardian.lastDecision=result?.decision??'hold';this.state.guardian.lastSummary=result?.summary;
      const receipt={version:1,auditId,runId:this.state.runId??path.basename(this.directory),guardianThreadId:threadId??this.state.guardian.threadId??null,phase:phase??snapshot.phase??null,
        checkedAt:this.state.guardian.lastCheckedAt,requestIdentity,responseIdentity,normalizedResponseIdentity,recoveryEvidenceIdentity,result};
      try{const receiptIdentity=writeJSON(path.join(directory,'audit-result.json'),receipt);this.state.guardian.lastAuditIdentity=receiptIdentity;if(result.decision!=='continue')this.state.guardian.incidentPath=receiptIdentity.path;}
      catch(error){result=held('운영 감사 결과 저장이 실패했습니다.',error.message);this.state.guardian.lastDecision='hold';}
      try{this.save();this.log({kind:'guardian_inspected',auditId,threadId:this.state.guardian.threadId??null,decision:result.decision,ruleChanges:result.ruleChanges});}
      catch(error){result=held('운영 감사 상태 저장이 실패했습니다.',error.message);this.state.guardian.lastDecision='hold';}
    }
    return result;
  }
}
