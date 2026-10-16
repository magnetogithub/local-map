import fs from 'node:fs';
import path from 'node:path';
import {atomicJSON,fileIdentity,resolveInside,validateIdentities,inside} from './protocol.mjs';
import {validateProductTarget,digest} from './product-target.mjs';
import {identity} from './verification-stages.mjs';

const read=file=>JSON.parse(fs.readFileSync(file,'utf8'));

// The controller can attest a native environment-error file even when the
// blocked verifier could not start a shell to measure that file itself.
// This preserves BLOCKED and the original native response verbatim.
export function captureEnvironmentEvidence(root,report,result){
  if(result.verdict!=='blocked'||result.nonPassKind!=='environment')return result;
  const value=structuredClone(result),source=fileIdentity(root,path.join(report,'response.json')),missing=[];
  const referenced=[...value.checks.flatMap(check=>check.evidencePaths),...value.commands.map(command=>command.evidencePath)];
  const pins=new Map(value.evidence.map(pin=>[resolveInside(root,pin.path),pin]));
  for(const name of referenced){
    const file=resolveInside(root,name);if(!inside(report,file))throw Error('Environment error evidence must stay in the verifier report');
    if(fs.existsSync(file)&&fs.statSync(file).isFile())pins.set(file,fileIdentity(root,file));else missing.push(name);
  }
  const record=path.join(report,'controller-environment-evidence.json'),body={version:1,kind:'controller-environment-evidence',sourceResponse:source,unavailableEvidencePaths:missing,productVerdictIssued:false};
  if(fs.existsSync(record)){if(digest(read(record))!==digest(body))throw Error('Environment evidence changed');}else atomicJSON(record,body);
  const pin=fileIdentity(root,record);pins.set(record,pin);value.evidence=[...pins.values()];
  value.checks=value.checks.map(check=>({...check,evidencePaths:[...check.evidencePaths.filter(name=>!missing.includes(name)),pin.path]}));
  value.commands=value.commands.map(command=>({...command,evidencePath:missing.includes(command.evidencePath)?pin.path:command.evidencePath}));
  return value;
}

export async function readVerifierRecovery(root,directory,state){
  const pointerFile=path.join(directory,'control/verifier-recovery-current.json');let readyFile=path.join(directory,'control/environment-recovery-ready.json');
  if(fs.existsSync(pointerFile)){const pointer=read(pointerFile);validateIdentities(root,[pointer.receipt]);readyFile=resolveInside(root,pointer.receipt.path);if(!inside(path.join(directory,'control'),readyFile))throw Error('Verifier recovery pointer must stay in this run');}
  if(!fs.existsSync(readyFile))return null;
  const ready=read(readyFile);validateIdentities(root,[ready.evidence]);
  const proof=read(resolveInside(root,ready.evidence.path)),row=state.tasks[proof.taskId];
  if(row?.environmentRecoveryHistory?.some(item=>item.evidence.sha256===ready.evidence.sha256))return null;
  validateIdentities(root,[...ready.inputs,...ready.checks]);
  if(!row||proof.kind!=='windows-verifier-environment-recovery'||!proof.pass||proof.runId!==state.runId||proof.attempt!==row.attempt||proof.targetId!==row.target?.targetId||proof.productRoot!==row.target.productRoot||!['verifying','blocked'].includes(row.status)||Object.keys(state.activeTurns??{}).length)throw Error('Environment recovery does not bind to an idle exact task');
  if((row.environmentRecoveryHistory?.length??0)>=2)throw Error('Environment recovery limit reached');
  const previous=row.verificationRevision??'vitest-001',number=Number(previous.match(/^vitest-(\d{3})$/)?.[1]),revision=`vitest-${String(number+1).padStart(3,'0')}`;
  const report=path.join(row.attemptDirectory,`verification-${revision}`),oldReport=path.join(row.attemptDirectory,`verification-${previous}`);
  if(proof.oldRevision!==previous||proof.newRevision!==revision||resolveInside(root,proof.oldResponse.path)!==path.join(oldReport,'response.json')||fs.existsSync(path.join(report,'dispatch.json'))||fs.existsSync(path.join(report,'response.json')))throw Error('Environment recovery cannot replace an existing dispatch');
  validateIdentities(root,[proof.oldResponse,proof.newContext,proof.test,proof.vitestResult,proof.testInputs]);
  const blocked=read(resolveInside(root,proof.oldResponse.path));
  if(blocked.result?.verdict!=='blocked'||blocked.result.nonPassKind!=='environment'||blocked.result.taskId!==proof.taskId||blocked.result.targetId!==row.target.targetId||blocked.cwd!==row.target.productRoot)throw Error('Only a confirmed environment BLOCKED response can recover');
  const expected={type:'workspaceWrite',writableRoots:[report],networkAccess:true,excludeTmpdirEnvVar:true,excludeSlashTmp:true};
  if(proof.policyUnchanged!==true||digest(proof.policy)!==digest(expected)||proof.execution?.exitCode!==0)throw Error('Environment recovery must execute under the same sandbox restrictions');
  const context=read(resolveInside(root,proof.newContext.path)),vitest=read(resolveInside(root,proof.vitestResult.path));
  if(resolveInside(root,context.reportDirectory)!==report||context.productTarget?.targetId!==row.target.targetId||context.productRoot!==row.target.productRoot||context.verificationFramework!=='vitest'||vitest.kind!=='vitest-bound-target'||!vitest.pass||!vitest.inputsUnchanged||!vitest.allFilesExecuted||vitest.targetId!==row.target.targetId||vitest.productRoot!==row.target.productRoot||!vitest.tests?.complete||!vitest.tests.counts?.passed||vitest.tests.counts.failed||vitest.tests.counts.skipped||vitest.tests.counts.errors||!inside(report,vitest.temporaryDirectory??''))throw Error('Actual candidate-bound Vitest proof is required for environment recovery');
  const tested=read(resolveInside(root,proof.testInputs.path));for(const pin of tested.inputs){const actual=await identity(pin.path);if(actual.sha256!==pin.sha256||actual.byteLength!==pin.byteLength)throw Error('Environment recovery test input changed');}
  if(!ready.checks.length)throw Error('Environment recovery requires actual Vitest control checks');
  for(const pin of ready.checks){const result=read(resolveInside(root,pin.path));if(result.kind!=='vitest'||!result.pass||!result.inputsUnchanged||!result.allFilesExecuted||!result.tests?.complete||!result.tests.counts?.passed||result.tests.counts.failed||result.tests.counts.errors||result.tests.counts.skipped)throw Error('Environment recovery requires actual Vitest control checks');}
  validateProductTarget(root,row.target);
  return{taskId:proof.taskId,row,report,revision,ready:fileIdentity(root,readyFile),evidence:ready.evidence,sourceResponse:proof.oldResponse};
}
