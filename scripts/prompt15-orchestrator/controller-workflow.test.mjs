import fs from 'node:fs';
import path from 'node:path';
import {test,expect} from 'vitest';
import {TaskWorkflow} from './task-workflow.mjs';
import {CONTROLLER_TASK_IMPLEMENTATION_SCHEMA,TEST_PREPARATION_SCHEMA,TASK_ASSESSMENT_SCHEMA} from './task-protocol.mjs';
import {atomicJSON,fileIdentity,PROMPT14_GATES,GATES} from './protocol.mjs';
import {productSnapshot,captureProductTarget,digest} from './product-target.mjs';
import {prepareManualBaselineReceipt} from './launch-policy.mjs';
import {reconcileImplementationTurn} from './turn-reconciliation.mjs';
import {recordExplicitResume} from './operating-recovery.mjs';

test('a REVIEW gives up its product handoff before entering the independently bounded guardian repair',async()=>{
  const workflow=Object.create(TaskWorkflow.prototype);
  workflow.state={review:'A',guardian:{lastAuditIdentity:{sha256:'synthetic-audit'}},activeOperations:{'product-review-A':{id:'review-owner',kind:'product-handoff'}},activeTurns:{}};
  workflow.save=()=>{};
  workflow.controllerRepair={async repair(){expect(workflow.state.activeOperations['product-review-A']).toBeUndefined();return{status:'applied'};}};
  await expect(workflow.repairController('review_decision')).rejects.toMatchObject({code:'OPERATING_REPAIR_APPLIED'});
});

test('an authorized resume becomes running before bounded startup validation; standby stays idle',async()=>{
  const workflow=Object.create(TaskWorkflow.prototype);workflow.state={status:'stopped',error:'previous controller failure'};
  workflow.ensureRunning=()=>{};workflow.save=()=>{};
  workflow.withProductOperation=async()=>{expect(workflow.state.status).toBe('running');expect(workflow.state.error).toBeNull();throw Error('Controlled startup validation boundary');};
  await expect(workflow.run()).rejects.toThrow('Controlled startup validation boundary');
  workflow.state.status='standby';workflow.withProductOperation=async()=>{throw Error('Standby must not start');};
  expect(await workflow.run()).toBe(workflow.state);
});

for(const mode of ['normal','external','test-preparation','delivery'])test(`normal workflow directly accepts task fixtures; recovery mode=${mode}`,async context=>{
  const externallyBlocked=mode==='external';
  const base=path.resolve('.tmp/controller-workflow-tests');fs.mkdirSync(base,{recursive:true});const root=fs.mkdtempSync(path.join(base,'case-'));
  context.onTestFinished(()=>{if(!root.startsWith(base+path.sep))throw Error('Unsafe fixture cleanup');fs.rmSync(root,{recursive:true,force:true});});
  const candidate=path.join(root,'reports/manual-candidate');fs.mkdirSync(path.join(candidate,'src'),{recursive:true});atomicJSON(path.join(candidate,'package.json'),{type:'module'});fs.writeFileSync(path.join(candidate,'src/base.txt'),'preserved');
  const proofFile=path.join(root,'reports/manual-proof.json');atomicJSON(proofFile,{});const proof=fileIdentity(root,proofFile),verdictFile=path.join(root,'reports/manual-verdict.json');
  atomicJSON(verdictFile,{review:'prompt14',verdict:'pass',nonPassKind:'none',summary:'Control fixture only, not product validation',checks:PROMPT14_GATES.map(id=>({id,status:'pass',evidencePaths:[proof.path],detail:'control fixture'})),inputs:Object.keys(productSnapshot(candidate)).map(file=>fileIdentity(root,path.join(candidate,file))),evidence:[proof],commands:[{command:'fixture',exitCode:0,evidencePath:proof.path}],failures:[],suggestedRepairPrompt:''});
  const receipt=prepareManualBaselineReceipt(root,verdictFile,candidate,path.join(root,'reports/accepted'));
  atomicJSON(path.join(root,'package.json'),{});fs.writeFileSync(path.join(root,'worker.txt'),'Implement only assigned task');fs.writeFileSync(path.join(root,'prompt.txt'),'Fixed original task requirements');fs.writeFileSync(path.join(root,'rules.txt'),'Fixed operating rules');
  const config={manualBaselineReceipt:receipt.path,executionMode:'orchestrated',boundProductTargets:true,implementationUnit:'task',taskVerificationMode:'controller-vitest',verificationFramework:'vitest',maxConcurrentTasks:2,promptPath:'prompt.txt',rulesPath:'rules.txt',roles:{implementer:{promptPath:'worker.txt'},testPreparer:{promptPath:'worker.txt'}}};
  let workflow,calls=0,nextThread=0,preparations=0,deliveredFailure=false,externalResolved=false,notification;const seen=[],nativeTurns=new Map();
  const server={on(event,fn){notification=fn;},off(){notification=null;},async initialize(){},async request(method,params){return {thread:{id:params.threadId??'fixture-implementer-'+(++nextThread),...(method==='thread/read'?{turns:nativeTurns.get(params.threadId)??[]}:{})}};},async runTurn(threadId,prompt,schema,overrides){
    if(schema===TEST_PREPARATION_SCHEMA){
      preparations++;const root=overrides.cwd,id='15-01',directory=overrides.sandboxPolicy.writableRoots[0],contract=JSON.parse(fs.readFileSync(path.join(workflow.directory,'tasks',id,'contract.json')));
      fs.writeFileSync(path.join(directory,'fixed.test.ts'),`import fs from 'node:fs';import path from 'node:path';import {test,expect} from 'vitest';const root=process.env.PROMPT15_CANDIDATE_ROOT;test('${id}:acceptance actual artifact',()=>expect(JSON.parse(fs.readFileSync(path.join(root,'.reports/tests/output.json'),'utf8')).id).toBe('${id}'));test('${id}:preservation original source',()=>expect(fs.readFileSync(path.join(root,'src/base.txt'),'utf8')).toBe('preserved'));`);
      const testPlanPath=path.join(directory,'test-plan.json');atomicJSON(testPlanPath,{version:1,taskId:id,contractDigest:contract.contractDigest,groups:[{environment:'node',files:['fixed.test.ts']}],supportFiles:[]});
      return {turnId:'fixture-preparation',value:{taskId:id,candidateRoot:root,status:'completed',testPlanPath,summary:'Fixed missing real preservation criterion; product and original assertions preserved'}};
    }
    expect(schema).toBe(CONTROLLER_TASK_IMPLEMENTATION_SCHEMA);const id=prompt.match(/taskId=(15-\d+)/)[1];
    if(!(externallyBlocked?['15-01','15-02','15-03','15-04']:['15-01','15-02','15-03']).includes(id))throw Error('Controlled fixture boundary');
    calls++;seen.push(id);const root=overrides.cwd,contract=JSON.parse(fs.readFileSync(path.join(workflow.directory,'tasks',id,'contract.json'))),directory=path.join(root,'.reports/tests');fs.mkdirSync(directory,{recursive:true});
    atomicJSON(path.join(directory,'output.json'),{id});
    fs.writeFileSync(path.join(directory,'acceptance.test.ts'),`import fs from 'node:fs';import path from 'node:path';import {test,expect} from 'vitest';const root=process.env.PROMPT15_CANDIDATE_ROOT;test('${id}:acceptance actual fixture artifact',()=>expect(JSON.parse(fs.readFileSync(path.join(root,'.reports/tests/output.json'),'utf8')).id).toBe('${id}'));test('${id}:preservation original source',()=>expect(fs.readFileSync(path.join(root,'src/base.txt'),'utf8')).toBe('preserved'));`);
    if(mode==='test-preparation'&&id==='15-01')fs.writeFileSync(path.join(directory,'acceptance.test.ts'),"import {test,expect} from 'vitest';test('15-01:acceptance incomplete preparation',()=>expect(2+2).toBe(4));");
    const testPlanPath=path.join(directory,'test-plan.json');atomicJSON(testPlanPath,{version:1,taskId:id,contractDigest:contract.contractDigest,groups:[{environment:'node',files:['acceptance.test.ts']}],supportFiles:[]});
    const inputManifestPath=path.join(directory,'inputs.json');atomicJSON(inputManifestPath,{version:1,inputs:[fileIdentity(workflow.root,path.join(directory,'output.json'))]});
    const turnId='fixture-confirmed-'+id;notification?.({method:'turn/started',params:{threadId,turn:{id:turnId}}});
    const value={taskId:id,candidateRoot:root,status:externallyBlocked&&!externalResolved&&id==='15-02'?'blocked':'completed',summary:externallyBlocked&&!externalResolved&&id==='15-02'?'missing external credential':'Control fixture only',changedFiles:[],artifactPaths:[path.join(directory,'output.json')],commands:[],remainingIssues:[],inputManifestPath,testPlanPath};
    nativeTurns.set(threadId,[{id:turnId,status:'completed',items:[{type:'agentMessage',phase:'final',text:JSON.stringify(value)}]}]);
    if(mode==='delivery'&&id==='15-03'&&!deliveredFailure){deliveredFailure=true;throw Error('Injected native delivery failure');}
    return {turnId,value};
  }};
  const directory=path.join(root,'reports/run');fs.mkdirSync(directory,{recursive:true});workflow=new TaskWorkflow({root,directory,config,server});
  const audits=[];workflow.guardian={async inspect(snapshot){audits.push(snapshot.phase);return{decision:'continue',summary:'fixture error inspection',ruleChanges:[]};}};
  if(mode==='delivery'){
    await expect(workflow.run()).rejects.toThrow('Injected native delivery failure');
    expect(workflow.state.tasks['15-02'].status).toBe('pass');expect(workflow.state.tasks['15-03'].status).toBe('running');
    expect(workflow.state.tasks['15-03'].implementationKey).toBe('implementer-15-03');
    workflow=new TaskWorkflow({root,directory,config,server,resume:true});
    workflow.guardian={async inspect(snapshot){audits.push(snapshot.phase);return{decision:'continue',summary:'fixture recovery inspection',ruleChanges:[]};}};
  }
  await expect(workflow.run()).rejects.toThrow('Controlled fixture boundary');
  expect(calls).toBe(externallyBlocked?4:3);expect(seen).toEqual(externallyBlocked?['15-01','15-02','15-03','15-04']:['15-01','15-02','15-03']);
  for(const id of seen.filter(id=>!(externallyBlocked&&id==='15-02'))){expect(workflow.state.tasks[id].status).toBe('pass');const verdict=JSON.parse(fs.readFileSync(path.resolve(root,workflow.state.tasks[id].verification)));expect(verdict.acceptanceMode).toBe('controller-vitest');}
  if(externallyBlocked)expect(workflow.state.tasks['15-02'].parked).toBe(true);
  expect(preparations).toBe(mode==='test-preparation'?1:0);
  if(mode==='test-preparation'){expect(workflow.state.tasks['15-01'].testPreparation.revision).toBe(1);expect(workflow.state.tasks['15-01'].attempt).toBe(1);}
  expect(audits.every(phase=>phase==='execution_failure')).toBe(true);expect(audits.length).toBeGreaterThanOrEqual(1);expect(workflow.state.tasks['15-06'].status).toBe('pending');expect(workflow.state.repairAttempts).toBe(0);
  if(externallyBlocked){
    const row=workflow.state.tasks['15-02'],originalResponse=row.implementation.responseIdentity;
    recordExplicitResume({root,directory,state:workflow.state,taskIds:['15-02']});
    workflow.resumeParkedTasks();expect(row.status).toBe('assigned');expect(row.parked).toBeUndefined();externalResolved=true;
    const task=workflow.plan.tasks.find(t=>t.id==='15-02');await workflow.implement(task,0);await workflow.verifyAutomatically(task);workflow.merge(task);
    expect(row.status).toBe('pass');expect(row.attempt).toBe(1);expect(row.blockedImplementationHistory).toContainEqual(originalResponse);expect(fs.existsSync(path.resolve(root,originalResponse.path))).toBe(true);
  }
  const first=workflow.state.tasks['15-01'];fs.writeFileSync(first.artifacts[0],'{"id":"tampered-after-PASS"}');
  expect(()=>workflow.merge(workflow.plan.tasks[0])).toThrow(/Evidence bytes changed/);
  expect(()=>workflow.validatePrerequisites(workflow.plan.tasks[1])).toThrow(/Evidence bytes changed/);
  await expect(workflow.verifyAutomatically(workflow.plan.tasks[0])).rejects.toThrow(/Evidence bytes changed/);
},60000);

for(const wholeReview of [false,true])test(`a completed native turn is reconciled without another model turn; whole REVIEW=${wholeReview}`,async context=>{
  const base=path.resolve('.tmp/turn-reconciliation-tests');fs.mkdirSync(base,{recursive:true});const root=fs.mkdtempSync(path.join(base,'case-'));context.onTestFinished(()=>fs.rmSync(root,{recursive:true,force:true}));
  const cwd=path.join(root,'reports/candidate');fs.mkdirSync(cwd,{recursive:true});atomicJSON(path.join(cwd,'package.json'),{});
  const directory=path.join(root,'reports/implementation');fs.mkdirSync(directory,{recursive:true});
  const schema={type:'object',required:['taskId','candidateRoot'],properties:{taskId:{type:'string'},candidateRoot:{type:'string'}},additionalProperties:false};
  const taskId=wholeReview?'REVIEW-A':'15-01';
  const {digest}=await import('./product-target.mjs'),request={...(wholeReview?{review:'A'}:{taskId}),cwd,schemaDigest:digest(schema)};atomicJSON(path.join(directory,'request.json'),request);
  const dispatchFile=path.join(directory,'dispatch.json');atomicJSON(dispatchFile,{turnId:'exact-turn',threadId:'exact-thread',cwd,requestIdentity:fileIdentity(root,path.join(directory,'request.json'))});
  let continued=false;const server={async request(method){return method==='thread/resume'?{}:{thread:{id:'exact-thread',turns:[{id:'exact-turn',status:'completed',items:[{type:'agentMessage',phase:'final',text:JSON.stringify({taskId,candidateRoot:cwd})}]}]}};}};
  const result=await reconcileImplementationTurn({root,dispatchFile,request,schema,server,continueTurn:()=>{continued=true;throw Error('must not continue a completed turn');}});
  expect(continued).toBe(false);expect(result.result.taskId).toBe(taskId);expect(result.turnId).toBe('exact-turn');
});

test('an interrupted whole REVIEW continuation retains only its original evidence root and new receipt directory',async context=>{
  const base=path.resolve('.tmp/review-continuation-tests');fs.mkdirSync(base,{recursive:true});const root=fs.mkdtempSync(path.join(base,'case-'));context.onTestFinished(()=>fs.rmSync(root,{recursive:true,force:true}));
  const cwd=path.join(root,'reports/candidate');fs.mkdirSync(cwd,{recursive:true});atomicJSON(path.join(cwd,'package.json'),{});
  const directory=path.join(root,'reports/run'),report=path.join(directory,'verification');fs.mkdirSync(report,{recursive:true});
  let workflow,attempt=0;const server={async request(method){return method==='thread/resume'?{}:{thread:{id:'thread',turns:[{id:'interrupted',status:'interrupted',items:[]}]}};},async runTurn(threadId,prompt,schema,overrides){
    if(!attempt++){workflow.onNotification({method:'turn/started',params:{threadId,turn:{id:'interrupted'}}});throw Error('Injected disconnect');}
    expect(overrides.sandboxPolicy.writableRoots).toEqual([path.join(report,'continuation'),report]);
    fs.writeFileSync(path.join(report,'journal-resumed.txt'),'continued');return {turnId:'continued',value:{taskId:'REVIEW-A',candidateRoot:cwd}};
  }};
  workflow=new TaskWorkflow({root,directory,config:{taskVerificationMode:'controller-vitest',promptPath:'prompt.txt',rulesPath:'rules.txt',roles:{verifier:{}}},server});
  workflow.thread=async()=>{workflow.state.threads.verifier='thread';return 'thread';};
  const schema={type:'object',required:['taskId','candidateRoot'],properties:{taskId:{type:'string'},candidateRoot:{type:'string'}},additionalProperties:false};
  await expect(workflow.turn('verifier','verifier',cwd,report,'Original journal assignment',schema,{review:'A'})).rejects.toThrow('Injected disconnect');
  const response=await workflow.turn('verifier','verifier',cwd,report,'Original journal assignment',schema,{review:'A'});
  expect(response.result.taskId).toBe('REVIEW-A');expect(fs.readFileSync(path.join(report,'journal-resumed.txt'),'utf8')).toBe('continued');expect(attempt).toBe(2);
});

test('whole REVIEW resumes decision with the same attestation and rechecks BLOCKED only after an actual repair receipt',async context=>{
  const base=path.resolve('.tmp/review-decision-tests');fs.mkdirSync(base,{recursive:true});const root=fs.mkdtempSync(path.join(base,'case-'));context.onTestFinished(()=>fs.rmSync(root,{recursive:true,force:true}));
  const candidate=path.join(root,'reports/candidate');fs.mkdirSync(candidate,{recursive:true});atomicJSON(path.join(candidate,'package.json'),{});
  const directory=path.join(root,'reports/run');fs.mkdirSync(directory,{recursive:true});
  const target=captureProductTarget(root,candidate,path.join(directory,'fixture-target'));
  const initialFile=path.join(directory,'fixture-verdict.json');atomicJSON(initialFile,{inputs:[target.manifest],evidence:[]});
  let workflow,verificationCalls=0,decisionCalls=0,attestations=0;const nativeTurns=new Map();
  const server={async request(method,params){return {thread:{id:params.threadId,turns:nativeTurns.get(params.threadId)??[]}};},async runTurn(threadId,prompt,schema,overrides){
    const isVerifier=schema===TASK_ASSESSMENT_SCHEMA,turnId=`${threadId}-${isVerifier?++verificationCalls:++decisionCalls}`;
    workflow.onNotification({method:'turn/started',params:{threadId,turn:{id:turnId}}});
    let value;
    if(isVerifier){
      const report=overrides.sandboxPolicy.writableRoots[0],job=JSON.parse(fs.readFileSync(path.join(report,'job-context.json'))),proof=path.join(report,'tool-failure.json');atomicJSON(proof,{reason:'fixture operating tool failure'});const pin=fileIdentity(root,proof);
      value={review:'A',taskId:'REVIEW-A',candidateRoot:candidate,targetId:job.productTarget.targetId,verdict:'blocked',nonPassKind:'environment',summary:'fixture tool failure',checks:GATES.A.map(id=>({id,status:'blocked',detail:'fixture tool failure',evidencePaths:[pin.path]})),evidence:[pin],inputs:[job.productTarget.manifest],commands:[],failures:['fixture tool failure'],suggestedRepairPrompt:''};
    }else value={review:'A',action:'blocked',repairTaskIds:[],summary:'fixture tool needs operating repair',instructions:''};
    nativeTurns.set(threadId,[{id:turnId,status:'completed',items:[{type:'agentMessage',phase:'final',text:JSON.stringify(value)}]}]);
    if(!isVerifier&&decisionCalls===1)throw Error('Injected decision delivery failure');
    return {turnId,value};
  }};
  workflow=new TaskWorkflow({root,directory,config:{taskVerificationMode:'controller-vitest',promptPath:'prompt.txt',rulesPath:'rules.txt',roles:{verifier:{},supervisor:{}}},server,vitestAttestor:async()=>{
    const proof=path.join(directory,`attestation-${++attestations}.json`);atomicJSON(proof,{kind:'fixture operating failure',sequence:attestations});return{result:{pass:false,tests:{complete:false,counts:{failed:0,errors:1}}},evidence:[fileIdentity(root,proof)]};
  }});
  workflow.thread=async(role,key)=>{workflow.state.threads[key]=key;return key;};workflow.audit=async()=>({decision:'continue'});
  workflow.plan={...workflow.plan,tasks:[workflow.plan.tasks[0]]};workflow.state.tasks['15-01']={status:'pass',acceptedTarget:target,verification:path.relative(root,initialFile),artifacts:[]};workflow.state.reviewWorkspace={directory:candidate,review:'A'};
  await expect(workflow.review()).rejects.toThrow('Injected decision delivery failure');
  await expect(workflow.review()).rejects.toThrow(/Orchestration guardian hold/);
  expect(attestations).toBe(1);expect(verificationCalls).toBe(1);expect(decisionCalls).toBe(1);
  const blocked=workflow.state.activeReviewAttempt.block;expect(blocked).toBeDefined();const originalBytes=fs.readFileSync(path.resolve(root,blocked.verification.path),'utf8');
  await expect(workflow.review()).rejects.toThrow(/Orchestration guardian hold/);expect(verificationCalls).toBe(1);
  const repair=path.join(directory,'repair.json');atomicJSON(repair,{finishedAt:new Date(Date.parse(blocked.at)+1).toISOString()});workflow.state.guardian.lastControllerRepair={status:'applied',receiptIdentity:fileIdentity(root,repair)};
  await expect(workflow.review()).rejects.toThrow(/Orchestration guardian hold/);
  expect(verificationCalls).toBe(2);expect(decisionCalls).toBe(2);expect(attestations).toBe(2);expect(workflow.state.activeReviewAttempt.verificationRevision).toBe(1);
  expect(fs.readFileSync(path.resolve(root,blocked.verification.path),'utf8')).toBe(originalBytes);
});

function blockedAttemptFixture(context,{status='blocked',summary='Current implementation cannot satisfy the preserved frozen assertions',historicalSummary='Prior attempt actual assertion failure'}={}){
  const base=path.resolve('.tmp/blocked-attempt-handoff-tests');fs.mkdirSync(base,{recursive:true});const root=fs.mkdtempSync(path.join(base,'case-'));
  context.onTestFinished(()=>{if(!root.startsWith(base+path.sep))throw Error('Unsafe fixture cleanup');fs.rmSync(root,{recursive:true,force:true});});
  const directory=path.join(root,'reports/run'),source=path.join(root,'reports/source'),attempt=path.join(directory,'tasks/15-03/attempt-002'),candidate=path.join(attempt,'candidate');
  for(const cwd of [source,candidate]){fs.mkdirSync(path.join(cwd,'src'),{recursive:true});atomicJSON(path.join(cwd,'package.json'),{});fs.writeFileSync(path.join(cwd,'src/value.txt'),'unchanged product');}
  fs.writeFileSync(path.join(root,'rules.txt'),'Operating rules');fs.writeFileSync(path.join(root,'prompt.txt'),'Preserve fixed functional requirements');
  const workflow=new TaskWorkflow({root,directory,config:{taskVerificationMode:'controller-vitest',rulesPath:'rules.txt',promptPath:'prompt.txt'},server:{}}),task=workflow.plan.tasks.find(task=>task.id==='15-03');
  workflow.state.approvedProductTarget=captureProductTarget(root,source,path.join(directory,'source-target'));workflow.state.reviewWorkspace={directory:source,review:'A'};
  const implementationDirectory=path.join(attempt,'implementation'),requestFile=path.join(implementationDirectory,'request.json');atomicJSON(requestFile,{taskId:task.id,cwd:candidate});const requestIdentity=fileIdentity(root,requestFile);
  const inputs=path.join(candidate,'.reports/inputs.json');atomicJSON(inputs,{version:1,inputs:[]});
  const result={taskId:task.id,status,summary,remainingIssues:[summary],candidateRoot:candidate,inputManifestPath:inputs,artifactPaths:[],changedFiles:[]};
  const responseFile=path.join(implementationDirectory,'response.json'),completedAt='2026-10-15T10:00:00.000Z';
  atomicJSON(responseFile,{turnId:'current-attempt-confirmed',requestIdentity,cwd:candidate,result,completedAt,productSourceDigest:digest(productSnapshot(candidate))});
  const responseIdentity=fileIdentity(root,responseFile),previousFile=path.join(directory,'tasks/15-03/attempt-001/verification-controller/verdict.json');
  atomicJSON(previousFile,{taskId:task.id,review:'A',acceptanceMode:'controller-vitest',verdict:'fail',nonPassKind:'implementation',summary:historicalSummary,failures:[historicalSummary],candidateRoot:path.join(directory,'tasks/15-03/attempt-001/candidate'),targetId:'previous-attempt-target'});
  const row=workflow.state.tasks[task.id];Object.assign(row,{status:'blocked',attempt:2,attemptDirectory:attempt,workspace:{directory:candidate},target:null,implementation:{result,turnId:'current-attempt-confirmed',requestIdentity,responseIdentity},verification:path.relative(root,previousFile),verificationDirectory:path.dirname(previousFile),blocker:summary,artifacts:[]});
  const audits=[];workflow.audit=async(phase,extra)=>{audits.push({phase,...extra});return {decision:'continue',summary:'Fixture operating handoff only',ruleChanges:[],recovery:{action:'none'}};};
  let preparationCalls=0;workflow.repairTestPreparation=async()=>{preparationCalls++;throw Error('Historical verdict must not dispatch a test preparer');};
  return {root,directory,workflow,task,row,previousFile,previousBytes:fs.readFileSync(previousFile),audits,get preparationCalls(){return preparationCalls;}};
}

test('a current blocked attempt reaches operating handoff instead of promoting its prior failed verdict',async context=>{
  const f=blockedAttemptFixture(context),repair=path.join(f.directory,'unrelated-repair.json');atomicJSON(repair,{status:'applied',finishedAt:'2026-10-15T10:01:00.000Z'});
  f.workflow.state.guardian.lastControllerRepair={status:'applied',receiptIdentity:fileIdentity(f.root,repair)};
  // Even a stale verifier response must not replace this attempt's blocked implementation.
  atomicJSON(path.join(f.row.verificationDirectory,'response.json'),{requestIdentity:f.row.implementation.requestIdentity,turnId:'old-verifier',result:{verdict:'blocked',failures:['historical verifier only']}});
  await expect(f.workflow.recoverBlocked(f.task)).rejects.toThrow(/guardian hold.*blocked/);
  expect(f.row.status).toBe('blocked');expect(f.row.target).toBe(null);expect(f.row.resumeEvidence).toBeUndefined();expect(f.preparationCalls).toBe(0);
  expect(f.audits).toHaveLength(1);expect(f.audits[0].phase).toBe('task_blocked');expect(f.audits[0].blockedTask.confirmedResponseIdentity).toEqual(f.row.implementation.responseIdentity);
  expect(f.audits[0].blockedTask.remainingIssues).toEqual(f.row.implementation.result.remainingIssues);
  expect(fs.readFileSync(f.previousFile).equals(f.previousBytes)).toBe(true);expect(path.resolve(f.root,f.row.verification)).toBe(f.previousFile);
});

test('external classification uses the current blocked implementation rather than a historical verdict',async context=>{
  const f=blockedAttemptFixture(context,{historicalSummary:'missing external credential in an old attempt'});
  await expect(f.workflow.recoverBlocked(f.task)).rejects.toThrow(/guardian hold.*blocked/);expect(f.row.parked).toBeUndefined();expect(f.audits).toHaveLength(1);
  f.row.implementation.result.summary='missing external credential now';f.row.implementation.result.remainingIssues=['missing external credential now'];
  await expect(f.workflow.recoverBlocked(f.task)).resolves.toBe(false);expect(f.row.parked).toBe(true);expect(f.row.status).toBe('blocked');
});

test('a corrupted implemented state with a blocked response cannot dispatch tests or preparation against target=null',async context=>{
  const f=blockedAttemptFixture(context);f.row.status='implemented';
  await expect(f.workflow.verifyAutomatically(f.task)).rejects.toThrow(/current implementation is blocked/);
  expect(f.row.status).toBe('blocked');expect(f.row.target).toBe(null);expect(f.preparationCalls).toBe(0);expect(f.workflow.state.activeOperations).toBeUndefined();
  expect(fs.readFileSync(f.previousFile).equals(f.previousBytes)).toBe(true);
});

test('a completed response without a bound target cannot reuse its historical failure as a verification handoff',async context=>{
  const f=blockedAttemptFixture(context,{status:'completed'});
  await expect(f.workflow.recoverBlocked(f.task)).rejects.toThrow(/guardian hold.*blocked/);expect(f.row.status).toBe('blocked');
  await expect(f.workflow.verifyAutomatically(f.task)).rejects.toThrow(/no completed current-attempt implementation target/);
  expect(f.preparationCalls).toBe(0);expect(f.row.target).toBe(null);
});

test('only a blocked controller verdict bound to the current completed target can resume tool execution',async context=>{
  const f=blockedAttemptFixture(context,{status:'completed'}),implementation=f.row.implementation;
  f.row.target=captureProductTarget(f.root,f.row.workspace.directory,path.join(f.row.attemptDirectory,'target'),{requestIdentity:implementation.requestIdentity,responseIdentity:implementation.responseIdentity,turnId:implementation.turnId,review:'A'});
  const current=path.join(f.row.attemptDirectory,'verification-controller/verdict.json');
  atomicJSON(current,{taskId:f.task.id,review:'A',acceptanceMode:'controller-vitest',verdict:'blocked',nonPassKind:'environment',summary:'Current incomplete execution',candidateRoot:f.row.workspace.directory,targetId:f.row.target.targetId});
  f.row.verification=path.relative(f.root,current);f.row.verificationDirectory=path.dirname(current);
  await expect(f.workflow.recoverBlocked(f.task)).rejects.toThrow(/Controller Vitest operating failure/);expect(f.row.status).toBe('implemented');expect(f.audits).toHaveLength(0);
  f.row.status='blocked';const mismatched=JSON.parse(fs.readFileSync(current,'utf8'));mismatched.targetId='some-other-target';atomicJSON(current,mismatched);
  await expect(f.workflow.recoverBlocked(f.task)).rejects.toThrow(/guardian hold.*blocked/);expect(f.row.status).toBe('blocked');expect(f.audits).toHaveLength(1);
});

test('a repair must address this blocked response and authorizes only one continuation without erasing failure history',async context=>{
  const f=blockedAttemptFixture(context),auditFile=path.join(f.directory,'specific-audit.json');
  atomicJSON(auditFile,{phase:'task_blocked',result:{decision:'hold',recovery:{action:'repair_controller',taskId:f.task.id,evidencePaths:[f.row.implementation.responseIdentity.path]}}});
  const sourceAudit=fileIdentity(f.root,auditFile),repairFile=path.join(f.directory,'specific-repair.json');atomicJSON(repairFile,{status:'applied',sourceAudit,finishedAt:'2026-10-15T10:01:00.000Z'});
  f.workflow.state.guardian.lastControllerRepair={status:'applied',sourceAudit,receiptIdentity:fileIdentity(f.root,repairFile)};
  await expect(f.workflow.recoverBlocked(f.task)).resolves.toBe(true);expect(f.row.status).toBe('assigned');expect(f.row.target).toBe(null);expect(f.row.attempt).toBe(2);expect(f.row.implementation.result.status).toBe('blocked');
  const used=f.row.resumedWithRepair;f.row.status='blocked';
  await expect(f.workflow.recoverBlocked(f.task)).rejects.toThrow(/guardian hold.*blocked/);expect(f.row.status).toBe('blocked');expect(f.row.resumedWithRepair).toBe(used);expect(f.row.blockedImplementationHistory).toHaveLength(1);
  expect(fs.readFileSync(f.previousFile).equals(f.previousBytes)).toBe(true);expect(f.preparationCalls).toBe(0);
});
