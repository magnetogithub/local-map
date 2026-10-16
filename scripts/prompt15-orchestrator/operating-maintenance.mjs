import fs from 'node:fs';
import {resolveInside,validateIdentities} from './protocol.mjs';

export function operatingMaintenanceEvidence(root,state){
  const maintenance=state.operatingMaintenance;
  if(!maintenance?.acceptedReceiptSha)return null;
  if(maintenance.receiptIdentity?.sha256!==maintenance.acceptedReceiptSha)throw Error('Operating maintenance authority mismatch');
  validateIdentities(root,[maintenance.receiptIdentity]);
  const receipt=JSON.parse(fs.readFileSync(resolveInside(root,maintenance.receiptIdentity.path),'utf8'));
  if(receipt.kind!=='verified-operating-maintenance'||receipt.runId!==state.runId||!receipt.sourceInputs?.length)throw Error('Invalid operating maintenance provenance');
  validateIdentities(root,[receipt.testResult,...receipt.sourceInputs]);
  const result=JSON.parse(fs.readFileSync(resolveInside(root,receipt.testResult.path),'utf8')),counts=result.tests?.counts;
  if(!result.pass||!result.inputsUnchanged||!result.allFilesExecuted||!result.tests?.complete||!counts?.passed||counts.total!==counts.passed||counts.failed||counts.errors||counts.skipped||counts.pending)throw Error('Incomplete operating maintenance verification');
  return {receiptIdentity:maintenance.receiptIdentity,testResult:receipt.testResult,sourceInputs:receipt.sourceInputs,verifiedAt:receipt.verifiedAt,reason:receipt.reason};
}

// Operator maintenance is a verified code handoff, not a fabricated user retry
// or approval receipt. Product workers cannot write this control-state link.
export function acceptOperatingMaintenance(root,state){
  const maintenance=state.operatingMaintenance;
  if(!maintenance?.receiptIdentity)return false;
  validateIdentities(root,[maintenance.receiptIdentity]);
  if(maintenance.acceptedReceiptSha===maintenance.receiptIdentity.sha256)return false;
  const receipt=JSON.parse(fs.readFileSync(resolveInside(root,maintenance.receiptIdentity.path),'utf8'));
  if(receipt.kind!=='verified-operating-maintenance'||receipt.runId!==state.runId||!receipt.reason?.trim()||!Number.isFinite(Date.parse(receipt.verifiedAt))||!receipt.sourceInputs?.length)throw Error('Invalid operating maintenance handoff');
  validateIdentities(root,[receipt.testResult,...receipt.sourceInputs]);
  const result=JSON.parse(fs.readFileSync(resolveInside(root,receipt.testResult.path),'utf8')),counts=result.tests?.counts;
  if(result.kind!=='vitest'||!result.pass||!result.inputsUnchanged||!result.allFilesExecuted||!result.tests?.complete||!counts?.passed||counts.total!==counts.passed||counts.failed||counts.errors||counts.skipped||counts.pending)throw Error('Operating maintenance requires actual complete passing Vitest evidence');
  maintenance.acceptedReceiptSha=maintenance.receiptIdentity.sha256;maintenance.acceptedAt=new Date().toISOString();
  if(state.supervisorOversight?.status==='escalation_exhausted')state.supervisorOversight.status='maintenance_repaired';
  // Keep old incident/notice/native ownership and the product clock intact.
  return true;
}
