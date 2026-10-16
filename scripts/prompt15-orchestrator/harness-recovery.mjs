import fs from 'node:fs';import path from 'node:path';
import {validateIdentities,resolveInside,fileIdentity} from './protocol.mjs';
import {digest} from './product-target.mjs';
import {frozenAcceptanceSuite} from './controller-task-verification.mjs';
const read=file=>JSON.parse(fs.readFileSync(file,'utf8'));

// Explicit operator correction is a scoped assignment handoff, never product
// acceptance. The original failed result remains immutable and inspectable.
export function harnessRecoveryInstructions(root,directory,state,task){
  const row=state.tasks[task.id],pin=row.harnessRecovery;if(!pin)return '';
  validateIdentities(root,[pin]);const receipt=read(resolveInside(root,pin.path));
  validateIdentities(root,[receipt.originalVerdict,receipt.selectedSuite,receipt.sameCandidateVerification,receipt.authorization,receipt.contract]);
  const prior=read(resolveInside(root,receipt.originalVerdict.path)),checked=read(resolveInside(root,receipt.sameCandidateVerification.path)),auth=read(resolveInside(root,receipt.authorization.path));
  const selected=frozenAcceptanceSuite(root,path.join(directory,'tasks',task.id));
  if(receipt.kind!=='verified-task-harness-recovery'||receipt.runId!==state.runId||receipt.taskId!==task.id||receipt.allowedAction!=='fresh-task-assignment'||receipt.productApprovalIssued!==false||digest(receipt.contract)!==digest(row.contractIdentity)||!selected||digest(fileIdentity(root,selected.receiptFile))!==digest(receipt.selectedSuite)||auth.kind!=='explicit-user-harness-repair'||auth.taskId!==task.id||!auth.reason?.trim()||prior.taskId!==task.id||prior.verdict!=='fail'||checked.taskId!==task.id||checked.verdict!=='pass'||checked.acceptanceMode!=='controller-vitest'||checked.targetId!==prior.targetId||checked.candidateRoot!==prior.candidateRoot)throw Error('Unconfirmed task harness recovery');
  validateIdentities(root,[...prior.evidence,...checked.inputs,...checked.evidence]);
  validateIdentities(root,receipt.historicalProductReferences??[]);
  const results=checked.evidence.filter(p=>p.path.endsWith('/result.json')).map(p=>read(resolveInside(root,p.path)));
  if(!results.length||results.some(r=>r.kind!=='vitest-bound-target'||r.targetId!==prior.targetId||r.productRoot!==prior.candidateRoot||!r.pass||!r.inputsUnchanged||!r.allFilesExecuted||!r.tests?.complete||!r.tests.counts?.passed||r.tests.counts.total!==r.tests.counts.passed||r.tests.counts.failed||r.tests.counts.errors||r.tests.counts.skipped||r.tests.counts.pending))throw Error('Harness recovery lacks complete same-candidate Vitest evidence');
  return `Explicit user-authorized harness recovery ${JSON.stringify(pin)}. The original failed verdict ${JSON.stringify(receipt.originalVerdict)} is retained; this exact historical candidate passed the corrected controller suite with unchanged product bytes. That resolved harness failure is not an instruction to invent exceptions or repair unchanged product merely to reproduce old benchmark constants. Implement this fresh assignment and all required diagnostic/failure-return artifacts using its current pinned inputs. Read-only same-task source references ${JSON.stringify(receipt.historicalProductReferences??[])} may guide restoring the summary module/CLI; regenerate candidate paths and relevant input/output pins rather than adopting an old response or target. Reuse byte-identical pinned prerequisite reports; task 17 does not rerun prerequisite geometry generation or cost benchmarks. Earlier BLOCKED attempts and receipts remain historical evidence, not the required output. No task PASS, policy acceptance or whole REVIEW approval is granted by this receipt.`;
}

export function applyHarnessFailureResolution(root,directory,state,task){
  harnessRecoveryInstructions(root,directory,state,task);
  const row=state.tasks[task.id],pin=row.harnessRecovery,receipt=read(resolveInside(root,pin.path));
  state.harnessFailureResolutions??=[];
  if(state.harnessFailureResolutions.some(r=>digest(r.originalVerdict)===digest(receipt.originalVerdict)))return false;
  if(!receipt.resolvedFailureRevision||row.failedRevision!==receipt.resolvedFailureRevision||!Number.isInteger(row.failures)||row.failures<1||!Number.isInteger(state.repairAttempts)||state.repairAttempts<1)throw Error('Harness failure resolution does not match the counted revision');
  const historical=[row,...(row.attemptHistory??[])].find(r=>r.verification&&digest(fileIdentity(root,resolveInside(root,r.verification)))===digest(receipt.originalVerdict));
  if(!historical||historical.failedRevision!==receipt.resolvedFailureRevision)throw Error('Harness failure has no counted original task receipt');
  const before={taskFailures:row.failures,repairAttempts:state.repairAttempts};row.failures--;state.repairAttempts--;delete row.failedRevision;
  state.harnessFailureResolutions.push({taskId:task.id,originalVerdict:receipt.originalVerdict,resolution:pin,before,after:{taskFailures:row.failures,repairAttempts:state.repairAttempts},at:new Date().toISOString(),productApprovalIssued:false});return true;
}
