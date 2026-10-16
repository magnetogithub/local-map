import fs from 'node:fs';
import path from 'node:path';
import {fileIdentity,validateIdentities,resolveInside,inside} from './protocol.mjs';
import {digest} from './product-target.mjs';
import {REVIEW_DECISION_SCHEMA} from './task-protocol.mjs';
const read=file=>JSON.parse(fs.readFileSync(file,'utf8'));

export function confirmedReviewRepair(root,directory,state,plan,validateTarget){
  const routing=state.repairRouting,review=state.review;
  if(!routing||routing.review!==review)return null;
  const number=state.reviewAttempt?.[review];
  if(!Number.isInteger(number)||number<1)throw Error('REVIEW repair has no original attempt');
  const base=path.join(directory,'reviews',`${review}-${number}`);
  if(routing.decision||routing.verification)validateIdentities(root,[routing.decision,routing.verification]);
  const verdictFile=routing.verification?resolveInside(root,routing.verification.path):path.join(base,'verdict.json');
  const decisionFile=routing.decision?resolveInside(root,routing.decision.path):path.join(base,'decision/response.json');
  const originalBase=path.dirname(verdictFile);
  if(!inside(path.join(directory,'reviews'),originalBase)||!new RegExp(`^${review}-[1-9][0-9]*$`).test(path.basename(originalBase))||decisionFile!==path.join(originalBase,'decision/response.json'))throw Error('REVIEW repair receipt escapes its original attempt');
  const verdict=read(verdictFile),response=read(decisionFile),dispatch=read(path.join(originalBase,'decision/dispatch.json'));
  validateIdentities(root,[response.requestIdentity]);
  const request=read(resolveInside(root,response.requestIdentity.path)),action=response.result,target=verdict.productTarget;
  if(verdict.review!==review||verdict.verdict!=='fail'||verdict.nonPassKind!=='implementation'||!target||
    !response.turnId||dispatch.turnId!==response.turnId||digest(dispatch.requestIdentity)!==digest(response.requestIdentity)||
    response.schemaDigest!==digest(REVIEW_DECISION_SCHEMA)||request.schemaDigest!==response.schemaDigest||
    request.role!=='supervisor'||request.review!==review||request.cwd!==target.productRoot||response.cwd!==request.cwd||
    !request.prompt?.includes(JSON.stringify(verdict))||action.review!==review||action.action!=='repair'||
    !Array.isArray(action.repairTaskIds)||!action.repairTaskIds.length||!action.instructions?.trim())throw Error('Unconfirmed REVIEW repair decision');
  validateTarget(root,target);validateIdentities(root,[...(verdict.inputs??[]),...(verdict.evidence??[])]);
  const rows=plan.tasks.filter(task=>plan.checkpoints.find(c=>c.id===task.checkpoint)?.review===review);
  if(action.repairTaskIds.some(id=>!rows.some(task=>task.id===id)))throw Error('REVIEW repair escapes its original scope');
  const invalid=new Set(action.repairTaskIds);
  for(let changed=true;changed;){changed=false;for(const task of plan.tasks)if(!invalid.has(task.id)&&task.dependsOn.some(id=>invalid.has(id))){invalid.add(task.id);changed=true;}}
  if(!Array.isArray(routing.invalid)||digest([...invalid].sort())!==digest([...routing.invalid].sort())||routing.reason!==action.summary||routing.instructions!==action.instructions)throw Error('REVIEW repair state differs from original decision');
  return {review,invalid:[...invalid],seeds:action.repairTaskIds,decision:fileIdentity(root,decisionFile),verification:fileIdentity(root,verdictFile),target};
}

export function taskAttemptMismatch(row){
  if(!row.attemptDirectory)return false;
  const expected=path.resolve(row.attemptDirectory,'candidate');
  return [row.workspace?.directory,row.target?.productRoot,row.implementation?.result?.candidateRoot,row.assignment?.candidateRoot]
    .filter(Boolean).some(root=>path.resolve(root)!==expected);
}
