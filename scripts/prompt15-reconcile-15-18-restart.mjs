import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {atomicJSON,fileIdentity,validateIdentities} from './prompt15-orchestrator/protocol.mjs';

const RUN='reports/prompt15/orchestration/20261015T115644-KST-eae9ad74';
const REVIEW_B='reports/prompt15/15-REVIEW-B.json';
const read=file=>JSON.parse(fs.readFileSync(file,'utf8'));
const alive=pid=>{if(!Number.isInteger(pid)||pid<=0)return false;try{process.kill(pid,0);return true;}catch{return false;}};
const samePin=(a,b)=>a?.path===b?.path&&a?.sha256===b?.sha256&&a?.byteLength===b?.byteLength;

export function reconcile1518State(state,{reviewB,at=new Date().toISOString()}={}){
  if(state.status!=='stopped'||state.review!=='C'||state.certificates?.C)throw Error('Run must be stopped before REVIEW C');
  if(!samePin(state.certificates?.B?.verification,reviewB))throw Error('Current REVIEW B PASS bytes do not match the controller certificate');
  const task18=state.tasks?.['15-18'],task19=state.tasks?.['15-19'];
  if(task18?.status!=='pass'||task18?.implementation?.result?.status!=='completed')throw Error('Expected the invalid 15-18 completed/PASS state');
  const remaining=task18.implementation.result.remainingIssues??[];
  if(!remaining.length||!remaining.some(item=>/unresolved|미해결|거부|reject/i.test(item)))throw Error('15-18 invalid PASS does not contain the preserved unresolved evidence');
  if(!['planning','assigned','running','blocked','repair'].includes(task19?.status))throw Error('Expected a started 15-19 state to invalidate');

  task18.invalidPassHistory??=[];
  task18.invalidPassHistory.push({verification:task18.verification,acceptedTarget:task18.acceptedTarget,passedAt:task18.passedAt,implementation:task18.implementation.responseIdentity,reason:'Implementation reported unresolved/rejected build but controller-vitest accepted a permissive suite.',invalidatedAt:at});
  task18.status='repair';
  delete task18.acceptedTarget;delete task18.passedAt;delete task18.verdict;delete task18.parked;delete task18.externalBlock;

  for(let number=19;number<=48;number++){
    const id=`15-${String(number).padStart(2,'0')}`,row=state.tasks[id];
    if(!row)continue;
    if(row.status!=='pending'){
      row.invalidatedBy1518={at,reason:'15-18 PASS was invalid; later work cannot depend on it.',priorStatus:row.status,attempt:row.attempt};
      row.status='pending';delete row.acceptedTarget;delete row.passedAt;delete row.parked;delete row.externalBlock;
    }
  }

  if(state.productBlockedHandoff?.taskId==='15-19'){
    state.productBlockedHandoffHistory??=[];state.productBlockedHandoffHistory.push(state.productBlockedHandoff);delete state.productBlockedHandoff;
  }
  if(state.productBlockResolution?.taskId==='15-19')delete state.productBlockResolution;
  state.status='stopped';state.phase='prepare';state.currentTasks=[];state.taskVerificationMode='independent-agent';state.error=null;state.recoveryAttempts=0;
  state.nextAction='Restart 15-18: supervisor assignment -> implementation -> supervisor relay -> independent V18; 15-19 remains pending';
  state.orchestration1518Repair={version:1,at,reviewB,invalidatedTask19Attempt:task19.attempt,verificationMode:'independent-agent',stopAfterTaskId:'15-18'};
  delete state.activeRole;delete state.activeTurns;delete state.activeOperation;delete state.activeOperations;delete state.pendingExecutionIncident;delete state.operatingRecovery;delete state.controllerPid;delete state.runtimeSupervisorPid;delete state.requiredUserInput;
  state.updatedAt=at;
  return state;
}

export function apply1518Reconciliation(root,{dryRun=false}={}){
  const run=path.join(root,RUN),stateFile=path.join(run,'state.json'),state=read(stateFile);
  if(alive(state.controllerPid)||alive(state.runtimeSupervisorPid))throw Error('Prompt 15 runtime is still alive');
  const reviewB=fileIdentity(root,REVIEW_B);validateIdentities(root,[reviewB,state.certificates.B.verification]);
  const repaired=reconcile1518State(structuredClone(state),{reviewB});
  if(dryRun)return{status:'dry-run',task18:repaired.tasks['15-18'].status,task19:repaired.tasks['15-19'].status,nextAction:repaired.nextAction};
  const directory=path.join(run,'control',`orchestration-15-18-repair-${Date.now()}`);fs.mkdirSync(directory,{recursive:false});
  fs.copyFileSync(stateFile,path.join(directory,'before-state.json'));const beforeState=fileIdentity(root,path.join(directory,'before-state.json'));
  atomicJSON(stateFile,repaired);const afterState=fileIdentity(root,stateFile),config=fileIdentity(root,'automation/prompt15/config.json'),workflow=fileIdentity(root,'scripts/prompt15-orchestrator/task-workflow.mjs');
  const receiptFile=path.join(directory,'receipt.json');atomicJSON(receiptFile,{version:1,kind:'prompt15-orchestration-15-18-repair',taskId:'15-18',authorization:'User explicitly requested stopping 15-19, repairing orchestration, and restarting 15-18.',reviewB,beforeState,afterState,config,workflow,invalidatedLaterTasks:['15-19'],reviewCDecisionMade:false,createdAt:repaired.updatedAt});
  validateIdentities(root,[reviewB,beforeState,afterState,config,workflow]);return{status:'prepared',receipt:fileIdentity(root,receiptFile),state:afterState,nextAction:repaired.nextAction};
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))console.log(JSON.stringify(apply1518Reconciliation(process.cwd(),{dryRun:process.argv.includes('--dry-run')}),null,2));
