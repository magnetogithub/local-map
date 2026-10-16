import fs from 'node:fs';
import path from 'node:path';
import {atomicJSON,fileIdentity,resolveInside,validateIdentities} from './protocol.mjs';
import {validateProductTarget} from './product-target.mjs';

// A tool migration may replace a deliberately interrupted legacy verifier.
// It never reconstructs its response, verdict, or failure count. Live turn
// status and immutable inputs are required before a new Vitest dispatch.
export async function reconcileLegacyVitestTurn({root,directory,report,taskId,review,target,server,validateTarget=validateProductTarget}){
  directory=resolveInside(root,directory);report=resolveInside(root,report);
  if(path.basename(directory)!=='verification'||path.dirname(directory)!==path.dirname(report)||!path.basename(report).startsWith('verification-vitest-'))return false;
  if(fs.existsSync(path.join(directory,'response.json')))return false;
  const dispatchFile=path.join(directory,'dispatch.json'),requestFile=path.join(directory,'request.json');
  const dispatch=JSON.parse(fs.readFileSync(dispatchFile,'utf8')),request=JSON.parse(fs.readFileSync(requestFile,'utf8'));
  validateIdentities(root,[dispatch.requestIdentity]);
  const requestIdentity=fileIdentity(root,requestFile),dispatchIdentity=fileIdentity(root,dispatchFile);
  if(resolveInside(root,dispatch.requestIdentity.path)!==requestFile||dispatch.requestIdentity.sha256!==requestIdentity.sha256||dispatch.requestIdentity.byteLength!==requestIdentity.byteLength||request.role!=='verifier'||!/^verifier-\d+$/.test(request.key??'')||request.taskId!==taskId||request.review!==review||request.cwd!==target.productRoot||dispatch.cwd!==request.cwd||!dispatch.turnId)return false;
  validateTarget(root,target);
  const history=await server.request('thread/read',{threadId:dispatch.threadId,includeTurns:true});
  const turn=history.thread?.id===dispatch.threadId?history.thread.turns?.find(value=>value.id===dispatch.turnId):null;
  if(turn?.status!=='interrupted')return false;
  validateTarget(root,target);validateIdentities(root,[requestIdentity,dispatchIdentity]);
  const evidence={version:1,kind:'vitest-legacy-turn-transition',taskId,review,targetId:target.targetId,productRoot:target.productRoot,threadId:dispatch.threadId,turnId:dispatch.turnId,status:'interrupted',requestIdentity,dispatchIdentity,targetManifest:target.manifest,newFramework:'vitest',productVerdictIssued:false};
  fs.mkdirSync(report,{recursive:true});const receipt=path.join(report,'legacy-turn-transition.json');
  if(fs.existsSync(receipt)){
    const previous=JSON.parse(fs.readFileSync(receipt,'utf8'));if(JSON.stringify(previous)!==JSON.stringify(evidence))throw Error('Legacy Vitest transition evidence changed');
  }else atomicJSON(receipt,evidence);
  return true;
}
