import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {atomicJSON, fileIdentity, validateIdentities} from './prompt15-orchestrator/protocol.mjs';

const RUN='reports/prompt15/orchestration/20261015T115644-KST-eae9ad74';
const REPORT='reports/prompt15/15-18-v18-independent-fail-2919b8dd8c58e7a4540a.json';
const VERIFIER='scripts/verify-prompt15-administrative-input.mjs';
const REPORT_SHA='a5e5e388aed2360504eee2cb2b50558a51cd0839bf6e14d45bd0d02b78ebcc15';
const VERIFIER_SHA='2919b8dd8c58e7a4540a87bdc7100c5af93829adb1b8e59bca7d01686f35b2b6';
const read=file=>JSON.parse(fs.readFileSync(file,'utf8'));

function progressText(state,plan){
 const passed=Object.values(state.tasks).filter(row=>row.status==='pass').length;
 return ['PROMPT 15 — 48개 독립 태스크 오케스트레이션',`상태: ${state.status} | REVIEW ${state.review} | 단계: ${state.phase}`,`검증 PASS: ${passed}/48`,'현재 태스크: 15-18 [blocked]',`다음 동작: ${state.nextAction}`,`제품 기준 후보: ${state.approvedProductTarget.productRoot}`,'REVIEW: A PASS → B PASS → C 미판정 → D 대기 → E 대기 → F 대기','','태스크 상태',...plan.tasks.map(task=>`${task.id} [${state.tasks[task.id].status}] ${task.title}`),'',`갱신: ${state.updatedAt}`].join('\n')+'\n';
}

export function recordV18(root){
 const run=path.join(root,RUN),stateFile=path.join(run,'state.json'),state=read(stateFile),reportPin=fileIdentity(root,REPORT),verifierPin=fileIdentity(root,VERIFIER),report=read(path.join(root,REPORT));
 if(reportPin.sha256!==REPORT_SHA||verifierPin.sha256!==VERIFIER_SHA)throw Error('V18 report/verifier bytes changed');
 if(state.status!=='stopped'||state.review!=='C'||!state.certificates?.B||state.tasks?.['15-18']?.status!=='pending'||state.tasks['15-18'].attempt!==0)throw Error('Controller is not at reconciled B PASS / untouched 15-18');
 if(report.status!=='fail'||report.verification!=='V18'||report.counts?.errorCount!==4||report.svn?.source!==193||report.svn?.traced!==193||report.svn?.restored!==193||report.svn?.missing!==0||report.svn?.duplicate!==0||report.svn?.unresolved!==1)throw Error('V18 FAIL contract/counts changed');
 if(report.errors?.preservedRestorationBlocker?.length!==1||report.errors?.provenance?.length!==3)throw Error('V18 failure closure changed');
 for(const id of Object.keys(state.tasks).filter(id=>Number(id.slice(3))>=19))if(state.tasks[id].status!=='pending'||state.tasks[id].attempt!==0)throw Error(`${id} has already started`);
 const directory=path.join(run,'control',`v18-result-${REPORT_SHA.slice(0,16)}`);if(fs.existsSync(directory))throw Error('Preserve existing V18 controller result');fs.mkdirSync(directory,{recursive:true});
 fs.copyFileSync(stateFile,path.join(directory,'before-state.json'));const beforeState=fileIdentity(root,path.join(directory,'before-state.json'));
 Object.assign(state.tasks['15-18'],{status:'blocked',verdict:'fail',verification:reportPin,v18Verifier:verifierPin,blocker:'Preserved 15-09 SVN positive gap/outside-P0/raw-boundary blockers are unresolved and omitted from the 15-18 provenance; V18 rejected the candidate.',blockedAt:new Date().toISOString()});
 state.status='stopped';state.phase='stopped';state.currentTasks=[];state.error=null;state.nextAction='15-18 repair and rerun V18; 15-19 is forbidden';state.updatedAt=new Date().toISOString();
 state.v18Result={taskId:'15-18',verdict:'fail',report:reportPin,verifier:verifierPin,next:'15-18 repair and rerun V18'};
 atomicJSON(stateFile,state);fs.writeFileSync(path.join(run,'progress.txt'),progressText(state,read(path.join(root,'automation/prompt15/task-plan.json'))),'utf8');
 const afterState=fileIdentity(root,stateFile),receiptFile=path.join(directory,'receipt.json');atomicJSON(receiptFile,{version:1,kind:'prompt15-v18-controller-result',taskId:'15-18',verdict:'fail',report:reportPin,verifier:verifierPin,beforeState,afterState,reviewBPreserved:true,reviewCDecisionMade:false,laterTasksStarted:false,next:'15-18 repair and rerun V18',createdAt:state.updatedAt});
 validateIdentities(root,[reportPin,verifierPin,beforeState,afterState]);return{status:'fail',receipt:fileIdentity(root,receiptFile),state:afterState,next:state.nextAction};
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))console.log(JSON.stringify(recordV18(process.cwd()),null,2));
