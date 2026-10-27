import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {AppServer} from './prompt15-orchestrator/app-server.mjs';
import {atomicJSON,fileIdentity,validateIdentities} from './prompt15-orchestrator/protocol.mjs';

const RUN='reports/prompt15/orchestration/20261015T115644-KST-eae9ad74';
const DISPATCH='reports/prompt15/orchestration/20261015T115644-KST-eae9ad74/tasks/15-19/attempt-002/implementation/dispatch.json';
const read=file=>JSON.parse(fs.readFileSync(file,'utf8'));
const alive=pid=>{if(!Number.isInteger(pid)||pid<=0)return false;try{process.kill(pid,0);return true;}catch{return false;}};
const userText=turn=>turn.items?.filter(item=>item.type==='userMessage').flatMap(item=>item.content??[]).filter(part=>part.type==='text').map(part=>part.text).join('\n')??'';

export async function reconcileStoppedDispatch(root,{binary='codex'}={}){
  const run=path.join(root,RUN),stateFile=path.join(run,'state.json'),state=read(stateFile);
  if(alive(state.controllerPid)||alive(state.runtimeSupervisorPid))throw Error('Prompt 15 runtime is still alive');
  if(state.tasks?.['15-18']?.status!=='repair'||state.tasks?.['15-19']?.status!=='pending')throw Error('Task states are not held at 15-18 repair / 15-19 pending');
  const dispatchFile=path.join(root,DISPATCH),dispatch=read(dispatchFile),requestFile=path.join(path.dirname(dispatchFile),'request.json'),request=read(requestFile);
  validateIdentities(root,[dispatch.requestIdentity]);
  const requestIdentity=fileIdentity(root,requestFile);
  if(dispatch.requestIdentity.sha256!==requestIdentity.sha256||dispatch.requestIdentity.byteLength!==requestIdentity.byteLength||request.taskId!=='15-19'||request.role!=='implementer'||request.cwd!==dispatch.cwd)throw Error('Stopped dispatch identity changed');

  const server=new AppServer({binary,cwd:root});
  let turn,status;
  try{
    await server.initialize();
    await server.request('thread/resume',{threadId:dispatch.threadId,cwd:request.cwd});
    let history=await server.request('thread/read',{threadId:dispatch.threadId,includeTurns:true});
    if(history.thread?.id!==dispatch.threadId||!Array.isArray(history.thread.turns))throw Error('Native history is unavailable');
    const matches=history.thread.turns.filter(item=>userText(item)===request.prompt);
    if(matches.length>1)throw Error('Stopped dispatch matches multiple native turns');
    turn=matches[0]??null;
    if(!turn&&history.thread.turns.some(item=>item.status==='inProgress'))throw Error('Dedicated task thread has unmatched active native work');
    if(turn?.status==='inProgress'){
      await server.request('turn/interrupt',{threadId:dispatch.threadId,turnId:turn.id});
      for(let count=0;count<30;count++){
        await new Promise(resolve=>setTimeout(resolve,100));
        history=await server.request('thread/read',{threadId:dispatch.threadId,includeTurns:true});
        turn=history.thread?.turns?.find(item=>item.id===turn.id)??null;
        if(turn?.status!=='inProgress')break;
      }
    }
    if(turn&&!['completed','failed','interrupted'].includes(turn.status))throw Error('Stopped dispatch native turn has not terminated');
    status=turn?.status??'no-dispatched-native-turn';
  }finally{await server.close();}

  const directory=path.join(run,'control',`native-stop-15-19-${Date.now()}`);fs.mkdirSync(directory,{recursive:false});
  fs.copyFileSync(stateFile,path.join(directory,'before-state.json'));const beforeState=fileIdentity(root,path.join(directory,'before-state.json'));
  const receiptFile=path.join(directory,'receipt.json');
  atomicJSON(receiptFile,{version:1,kind:'prompt15-stopped-dispatch-reconciliation',taskId:'15-19',authorization:'User explicitly stopped 15-19 and requested restart at 15-18.',dispatch:fileIdentity(root,dispatchFile),request:requestIdentity,threadId:dispatch.threadId,turnId:turn?.id??null,nativeStatus:status,acceptedAsProductResult:false,candidateMergeAuthorized:false,observedAt:new Date().toISOString()});
  const receipt=fileIdentity(root,receiptFile);state.stoppedDispatchReconciliations??={};state.stoppedDispatchReconciliations['15-19']=receipt;
  state.status='stopped';state.phase='prepare';state.currentTasks=[];state.error=null;state.nextAction='15-19 native stop confirmed; restart 15-18 only';
  delete state.controllerPid;delete state.runtimeSupervisorPid;delete state.activeRole;delete state.activeTurns;delete state.pendingExecutionIncident;delete state.operatingRecovery;
  if(state.guardian){delete state.guardian.activeAuditId;delete state.guardian.activeAuditStartedAt;delete state.guardian.activeAuditDeadlineAt;}
  state.updatedAt=new Date().toISOString();atomicJSON(stateFile,state);const afterState=fileIdentity(root,stateFile);
  atomicJSON(path.join(directory,'state-update.json'),{version:1,receipt,beforeState,afterState,createdAt:state.updatedAt});
  validateIdentities(root,[receipt,beforeState,afterState]);return{status,nativeTurnId:turn?.id??null,receipt,state:afterState};
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))console.log(JSON.stringify(await reconcileStoppedDispatch(process.cwd()),null,2));
