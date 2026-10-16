import fs from 'node:fs';
import path from 'node:path';
import {atomicJSON,fileIdentity,validateIdentities,resolveInside,inside} from './protocol.mjs';
import {digest,productSnapshot} from './product-target.mjs';
import {invalidateDescendants} from './task-protocol.mjs';
import {productBlockNeedsResolution} from './operating-recovery.mjs';

const read=file=>JSON.parse(fs.readFileSync(file,'utf8'));
const str={type:'string'};
export const PRODUCT_BLOCK_RESOLUTION_SCHEMA={type:'object',additionalProperties:false,required:['taskId','review','candidateRoot','action','classification','summary','instructions','question','inputKind'],properties:{taskId:str,review:str,candidateRoot:str,action:{type:'string',enum:['complete_task','request_input']},classification:{type:'string',enum:['missing_artifacts','implementation_blocker','scope_conflict','external_dependency']},summary:str,instructions:str,question:str,inputKind:{type:'string',enum:['none','external_credentials','external_approval','external_data','policy_decision']}}};

function packetFor(control,task){
  const {root,state}=control,held=state.productBlockedHandoff,row=state.tasks[task.id];
  if(!held||held.taskId!==task.id||!row||row.status!=='blocked')throw Error('Internal resolution needs the current blocked task');
  validateIdentities(root,[held.response,held.handoff,held.decision,row.contractIdentity]);
  const packet=read(resolveInside(root,held.handoff.path)),decision=read(resolveInside(root,held.decision.path));
  validateIdentities(root,packet.inputs);
  if(packet.taskId!==task.id||packet.review!==state.review||packet.attempt!==row.attempt||packet.candidateRoot!==row.workspace.directory||packet.productSourceDigest!==digest(productSnapshot(row.workspace.directory))||digest(packet.confirmedResponseIdentity)!==digest(held.response)||digest(row.implementation.responseIdentity)!==digest(held.response)||digest(row.blockedProductHandoff.decision)!==digest(held.decision)||!decision.turnId||decision.result.candidateRoot!==packet.candidateRoot||!['blocked','repair'].includes(decision.result.action))throw Error('Internal resolution block binding changed');
  return {packet,held,row,decision};
}

// Independently inspect the selected, pinned suite's literal artifact reads.
// Absence is an incomplete handoff, never a fabricated product assertion FAIL.
export function inspectBlockedArtifacts(root,packet){
  const candidate=resolveInside(root,packet.candidateRoot),suitePin=packet.acceptanceRevision?.suite;
  const testInputs=[];
  if(suitePin){
    validateIdentities(root,[suitePin]);const suite=read(resolveInside(root,suitePin.path));
    for(const input of suite.inputs??[])if(/\.[cm]?[jt]sx?$/.test(input.path??''))testInputs.push(input);
  }
  // The packet also pins the exact declared test-plan and its current tests.
  if(!suitePin)for(const pin of packet.inputs)if(inside(candidate,resolveInside(root,pin.path))&&/(?:acceptance|scope-bound)\.test\.[cm]?[jt]sx?$/.test(pin.path))testInputs.push(pin);
  const reads=new Set();
  for(const pin of testInputs){
    const file=resolveInside(root,pin.path);validateIdentities(root,[pin]);
    for(const match of fs.readFileSync(file,'utf8').matchAll(/["'`](\.reports\/[A-Za-z0-9_./-]+)["'`]/g)){
      const file=path.resolve(candidate,match[1]);if(!inside(candidate,file)||match[1].split('/').includes('..'))throw Error('Artifact inspection escapes candidate');
      reads.add(match[1]);
    }
  }
  return {testInputs:[...new Map(testInputs.map(pin=>[pin.path,pin])).values()],artifactReads:[...reads].sort().map(name=>({path:name,exists:fs.existsSync(path.join(candidate,name))}))};
}

function confirmedResolution(root,record){
  validateIdentities(root,[record.response,record.evidence,record.block.response,record.block.handoff,record.block.decision]);
  const response=read(resolveInside(root,record.response.path)),report=path.dirname(resolveInside(root,record.response.path)),request=read(path.join(report,'request.json')),dispatch=read(path.join(report,'dispatch.json'));
  validateIdentities(root,[response.requestIdentity,dispatch.requestIdentity]);
  if(!response.turnId||dispatch.turnId!==response.turnId||!dispatch.threadId||request.role!=='supervisor'||request.key!=='supervisor'||request.taskId!==record.taskId||request.review!==record.review||request.cwd!==record.candidateRoot||response.cwd!==request.cwd||dispatch.cwd!==request.cwd||request.schemaDigest!==digest(PRODUCT_BLOCK_RESOLUTION_SCHEMA)||response.schemaDigest!==request.schemaDigest||digest(request.resolutionEvidence)!==digest(record.evidence)||digest(dispatch.requestIdentity)!==digest(response.requestIdentity)||digest(fileIdentity(root,path.join(report,'request.json')))!==digest(response.requestIdentity))throw Error('Unconfirmed internal block resolution');
  return response.result;
}

export function internalBlockInstructions(root,state,task){
  const record=state.tasks[task.id].internalBlockRecovery;if(!record)return '';
  const result=confirmedResolution(root,record);
  if(result.action!=='complete_task'||result.taskId!==task.id||result.review!==state.review||result.candidateRoot!==record.candidateRoot||!result.instructions.trim())throw Error('Invalid internal task recovery instructions');
  return `Confirmed internal BLOCKED resolution ${JSON.stringify(record.response)}; independently inspected evidence ${JSON.stringify(record.evidence)}. Previous read-only candidate ${record.candidateRoot}, response ${JSON.stringify(record.block.response)}. Preserve its history; regenerate every required artifact in this new candidate with current prerequisite pins. This authorizes completing only ${task.id}, not changing criteria, granting policy approval or counting an implementation failure. ${result.instructions}`;
}

export async function resolveInternalProductBlock(control,task){
  const {root,directory,state}=control;
  if(!productBlockNeedsResolution(state))return false;
  control.ensureRunning();
  const {packet,held,row,decision}=packetFor(control,task),inspection=inspectBlockedArtifacts(root,packet);
  const binding=digest({response:held.response,handoff:held.handoff,decision:held.decision});
  const cause=digest({taskId:task.id,review:state.review,source:packet.productSourceDigest,contract:packet.contractIdentity,reviewRepair:row.reviewRepair?.verification??null,missing:inspection.artifactReads.filter(p=>!p.exists).map(p=>p.path)});
  const prior=Object.values(state.productBlockResolutions??{}).filter(r=>r.cause===cause&&r.status==='assigned');
  const report=path.join(directory,'product-block-resolutions',binding),evidenceFile=path.join(report,'evidence.json');
  const evidence={version:1,kind:'internal-block-diagnostic',taskId:task.id,review:state.review,attempt:row.attempt,candidateRoot:packet.candidateRoot,block:held,productSourceDigest:packet.productSourceDigest,contract:row.contractIdentity,selectedSuite:packet.acceptanceRevision?.suite??null,inspection,previousDecision:decision.result,priorSameCauseAssignments:prior.length,productVerdictIssued:false};
  if(fs.existsSync(evidenceFile)){if(digest(read(evidenceFile))!==digest(evidence))throw Error('Internal resolution evidence changed');}else atomicJSON(evidenceFile,evidence);
  const evidencePin=fileIdentity(root,evidenceFile);
  state.productBlockResolution={status:'deciding',taskId:task.id,binding,evidence:evidencePin};state.phase='internal_block_resolution';control.save();
  const prompt=`Resolve this internally blocked handoff; assign its next owner rather than leaving it in an unowned permanent hold. Read the exact controller diagnostic ${JSON.stringify(evidencePin)}, its original request/response, unchanged task contract, selected suite, prerequisite verdicts and whole REVIEW repair decision. Candidate ${packet.candidateRoot} is read-only. The previous blocked decision is preserved historical evidence, not a ban on this new resolution. No product PASS or FAIL is requested. A missing experiment report is incomplete work, not an external dependency. Return complete_task to assign a NEW attempt of THIS SAME blocked task only, with concrete instructions to complete its original outputs under its unchanged suite. Do not invalidate an accepted prerequisite, relax a threshold or treat an infeasible product selection as eligible. Scoped prototype/experiment/report completion is distinct from whole REVIEW approval: truthful failed/infeasible measurements must be included in the complete experiment matrix, not substituted for it; unmet whole REVIEW gates do not forbid producing that matrix. Inherited prerequisite unit PASS does not claim those REVIEW failures are resolved. Only a task explicitly responsible for selecting a policy requires a qualifying policy for its own successful selection. Preserve the fixed original requirements, current input identities and meaningful successful/negative tests. Keep generation-budget and physical failures visible for independent whole REVIEW. Return request_input ONLY for a concrete missing external input or unresolved protected policy decision, specifying the precise question and inputKind; an internal missing artifact alone is not a user decision. ${prior.length>=2?'Two unchanged-source assignments already failed to complete the same handoff: do not loop; request a concrete policy decision with evidence.':'The next implementation must perform the missing work, not return another feasibility-only packet.'} Return taskId=${task.id}, review=${state.review}, candidateRoot=${packet.candidateRoot}.`;
  const response=await control.turn('supervisor','supervisor',packet.candidateRoot,path.join(report,'decision'),prompt,PRODUCT_BLOCK_RESOLUTION_SCHEMA,{taskId:task.id,review:state.review,resolutionEvidence:evidencePin},{deadlineAt:new Date(Date.now()+180000).toISOString(),singleContinuation:true});
  // No model can change the candidate or substitute its own diagnostic packet.
  packetFor(control,task);validateIdentities(root,[evidencePin,response.responseIdentity]);
  const record={version:1,taskId:task.id,review:state.review,candidateRoot:packet.candidateRoot,attempt:row.attempt,binding,cause,block:structuredClone(held),evidence:evidencePin,response:response.responseIdentity};
  const result=confirmedResolution(root,record);
  if(result.taskId!==task.id||result.review!==state.review||result.candidateRoot!==packet.candidateRoot||!result.summary?.trim()||!result.instructions?.trim())throw Error('Invalid internal resolution task scope');
  state.productBlockResolutions??={};
  if(state.productBlockResolutions[binding]?.status==='assigned')return true;
  if(result.action==='request_input'){
    if(!result.question?.trim()||result.inputKind==='none'||result.classification==='missing_artifacts')throw Error('Internal missing work cannot become unspecified external input');
    state.productBlockResolutions[binding]={...record,status:'waiting_input'};
    state.requiredUserInput={kind:result.inputKind,external:result.inputKind!=='policy_decision',taskIds:[task.id],question:result.question,evidence:evidencePin,decision:response.responseIdentity};
    state.productBlockResolution={...record,status:'waiting_input'};state.status='waiting_input';state.phase='internal_block_decision_required';state.error=result.question;control.save();
    const error=Error(result.question);error.code='PRODUCT_BLOCKED';error.guardianHandled=true;throw error;
  }
  if(result.action!=='complete_task'||result.inputKind!=='none'||result.question||prior.length>=2)throw Error('Invalid or repeated internal completion assignment');
  // A blocked implementer has no accepted product to revoke. Descendant PASS
  // revocation still requires its normal independent product-failure protocol.
  const simulated=structuredClone(state),invalid=invalidateDescendants(control.plan,simulated,[task.id]);
  if(invalid.some(id=>state.tasks[id].status==='pass'))throw Error('Internal completion cannot invalidate accepted work');
  control.retainTaskAttempt(row);
  invalidateDescendants(control.plan,state,[task.id]);
  row.internalBlockRecovery=record;
  state.productBlockResolutions[binding]={...record,status:'assigned',assignedAt:new Date().toISOString()};
  state.productBlockedHandoffHistory??=[];state.productBlockedHandoffHistory.push(structuredClone(held));delete state.productBlockedHandoff;
  state.productBlockResolution={...record,status:'assigned'};state.currentTasks=[];state.status='running';state.phase='implement';state.error=null;
  control.event('internal_block_repair_assigned',{taskId:task.id,resolution:response.responseIdentity,invalid});control.save();return true;
}
