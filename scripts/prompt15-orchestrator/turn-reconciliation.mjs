import fs from 'node:fs';
import path from 'node:path';
import {atomicJSON,fileIdentity,validateIdentities} from './protocol.mjs';
import {digest,productSnapshot} from './product-target.mjs';

function validateShape(value,schema){
  if(schema.enum&&!schema.enum.includes(value))throw Error('Recovered response violates its original enum');
  const types=Array.isArray(schema.type)?schema.type:[schema.type];
  const type=value===null?'null':Array.isArray(value)?'array':Number.isInteger(value)?'integer':typeof value;
  if(schema.type&&!types.includes(type)&&!(type==='integer'&&types.includes('number')))throw Error('Recovered response violates its original schema');
  if(type==='object'){
    for(const key of schema.required??[])if(!Object.hasOwn(value,key))throw Error('Recovered response omits a required field');
    for(const[key,item]of Object.entries(value)){if(!schema.properties?.[key]&&schema.additionalProperties===false)throw Error('Recovered response adds an undeclared field');if(schema.properties?.[key])validateShape(item,schema.properties[key]);}
  }
  if(type==='array'&&schema.items)for(const item of value)validateShape(item,schema.items);
}

// Only the exact persisted turn can be reconciled. Implementation, whole REVIEW
// and test-preparation work resume as recorded continuations, not blind replays.
export async function reconcileImplementationTurn({root,dispatchFile,request,schema,server,continueTurn}){
  const dispatch=JSON.parse(fs.readFileSync(dispatchFile,'utf8'));
  validateIdentities(root,[dispatch.requestIdentity]);
  const requestFile=path.join(path.dirname(dispatchFile),'request.json');
  if(digest(fileIdentity(root,requestFile))!==digest(dispatch.requestIdentity)||digest(JSON.parse(fs.readFileSync(requestFile,'utf8')))!==digest(request))throw Error('Target binding: reconciliation request differs from the exact dispatched assignment');
  if(!dispatch.turnId||dispatch.cwd!==request.cwd||request.schemaDigest!==digest(schema))throw Error('Implementation dispatch has no exact turn identity for automatic reconciliation');
  await server.request('thread/resume',{threadId:dispatch.threadId,cwd:request.cwd});
  let history=await server.request('thread/read',{threadId:dispatch.threadId,includeTurns:true});
  if(history.thread?.id!==dispatch.threadId)throw Error('Reconciliation returned a different thread');
  let turn=history.thread.turns?.find(t=>t.id===dispatch.turnId);
  if(!turn)throw Error('Exact dispatched implementation turn is absent from native history');
  if(turn.status==='inProgress'){
    await server.request('turn/interrupt',{threadId:dispatch.threadId,turnId:dispatch.turnId});
    history=await server.request('thread/read',{threadId:dispatch.threadId,includeTurns:true});turn=history.thread?.turns?.find(t=>t.id===dispatch.turnId);
    if(!turn||turn.status==='inProgress')throw Error('Original implementation turn has not confirmed interruption');
  }
  const directory=path.dirname(dispatchFile),historyFile=path.join(directory,`reconciliation-${Date.now()}.json`);
  atomicJSON(historyFile,{version:1,dispatch:fileIdentity(root,dispatchFile),threadId:dispatch.threadId,turnId:turn.id,status:turn.status,observedAt:new Date().toISOString()});
  let result,turnId,recoveryResponse;
  if(turn.status==='completed'){
    const message=turn.items?.filter(item=>item.type==='agentMessage'&&item.phase!=='commentary').at(-1);
    if(!message?.text)throw Error('Completed implementation lacks its final structured response');
    result=JSON.parse(message.text);validateShape(result,schema);turnId=turn.id;
  }else if(['interrupted','failed'].includes(turn.status)){
    const continuation=await continueTurn({directory:path.join(directory,'continuation'),originalDispatch:fileIdentity(root,dispatchFile),nativeStatus:turn.status});
    result=continuation.result;turnId=continuation.turnId;recoveryResponse=continuation.responseIdentity;validateShape(result,schema);
  }else throw Error('Unsupported unconfirmed implementation state');
  const expectedTaskId=request.taskId??`REVIEW-${request.review}`;
  if(schema.properties?.taskId&&result.taskId!==expectedTaskId||schema.properties?.candidateRoot&&path.resolve(result.candidateRoot)!==path.resolve(request.cwd)||schema.properties?.review&&result.review!==request.review)throw Error('Recovered response refers to another task, review or candidate');
  const response={turnId,requestIdentity:dispatch.requestIdentity,schemaDigest:request.schemaDigest,cwd:request.cwd,result,completedAt:new Date().toISOString(),productSourceDigest:digest(productSnapshot(request.cwd)),reconciliation:fileIdentity(root,historyFile),...(recoveryResponse?{recoveryResponse}:{})};
  const responseFile=path.join(directory,'response.json');if(fs.existsSync(responseFile))throw Error('Reconciliation cannot overwrite a confirmed response');
  atomicJSON(responseFile,response);return {...response,responseIdentity:fileIdentity(root,responseFile)};
}
