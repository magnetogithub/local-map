import fs from 'node:fs';import path from 'node:path';
import {test,expect,onTestFinished} from 'vitest';
import {atomicJSON,fileIdentity} from './protocol.mjs';
import {acceptOperatingMaintenance,operatingMaintenanceEvidence} from './operating-maintenance.mjs';
import {automaticRecovery} from './operating-recovery.mjs';
import {SupervisorOversight} from './supervisor-oversight.mjs';

function fixture({pass=true,runId='run'}={}){
  const base=path.resolve('.tmp/operating-maintenance-tests');fs.mkdirSync(base,{recursive:true});const root=fs.mkdtempSync(path.join(base,'case-'));
  onTestFinished(()=>{if(!root.startsWith(base+path.sep))throw Error('Unsafe fixture cleanup');fs.rmSync(root,{recursive:true,force:true});});
  const source=path.join(root,'controller.mjs');fs.writeFileSync(source,'export const repaired=true;');
  const result=path.join(root,'tests.json');atomicJSON(result,{kind:'vitest',pass,inputsUnchanged:true,allFilesExecuted:true,tests:{complete:true,counts:{passed:3,total:3,failed:0,errors:0,skipped:0,pending:0}}});
  const receiptFile=path.join(root,'maintenance.json');atomicJSON(receiptFile,{kind:'verified-operating-maintenance',runId,verifiedAt:new Date().toISOString(),reason:'Verified Windows progress display failure repair',sourceInputs:[fileIdentity(root,source)],testResult:fileIdentity(root,result)});
  const state={runId:'run',status:'waiting_execution',tasks:{'15-03':{status:'blocked'}},operatingRecovery:{status:'recovering'},supervisorOversight:{status:'escalation_exhausted',exhaustedAt:new Date().toISOString(),exhaustionNotices:[{incident:'original'}]},operatingMaintenance:{receiptIdentity:fileIdentity(root,receiptFile)}};
  return{root,state,source,result,receiptFile};
}

test('verified operating maintenance restores operating recovery without a fictional user retry or product PASS',()=>{
  const f=fixture(),tasks=JSON.stringify(f.state.tasks),notices=JSON.stringify(f.state.supervisorOversight.exhaustionNotices);
  expect(acceptOperatingMaintenance(f.root,f.state)).toBe(true);expect(f.state.supervisorOversight.status).toBe('maintenance_repaired');
  expect(f.state.explicitResume).toBeUndefined();expect(JSON.stringify(f.state.tasks)).toBe(tasks);expect(JSON.stringify(f.state.supervisorOversight.exhaustionNotices)).toBe(notices);expect(f.state.operatingRecovery.status).toBe('recovering');
  expect(automaticRecovery(f.state,{taskVerificationMode:'controller-vitest'})).toBe(true);
  f.state.supervisorOversight.status='escalation_exhausted';expect(acceptOperatingMaintenance(f.root,f.state)).toBe(false);expect(f.state.supervisorOversight.status).toBe('escalation_exhausted');
});
for(const defect of ['failed-tests','wrong-run','changed-code','changed-tests'])test(`maintenance cannot activate with ${defect}`,()=>{
  const f=fixture({pass:defect!=='failed-tests',runId:defect==='wrong-run'?'another-run':'run'}),before=JSON.stringify(f.state);
  if(defect==='changed-code')fs.appendFileSync(f.source,'\n// changed after checks');
  if(defect==='changed-tests')fs.appendFileSync(f.result,' ');
  expect(()=>acceptOperatingMaintenance(f.root,f.state)).toThrow();expect(JSON.stringify(f.state)).toBe(before);
});
test('verified local maintenance cannot bypass a real external approval hold',()=>{
  const f=fixture();f.state.requiredUserInput={kind:'approval',reason:'actual external approval required'};
  acceptOperatingMaintenance(f.root,f.state);expect(automaticRecovery(f.state,{taskVerificationMode:'controller-vitest'})).toBe(false);expect(f.state.requiredUserInput.kind).toBe('approval');
});

test('a later queued audit receives the accepted current maintenance source and test provenance',()=>{
  const f=fixture();expect(operatingMaintenanceEvidence(f.root,f.state)).toBe(null);acceptOperatingMaintenance(f.root,f.state);
  const proof=operatingMaintenanceEvidence(f.root,f.state);expect(proof.receiptIdentity).toEqual(fileIdentity(f.root,f.receiptFile));expect(proof.sourceInputs).toEqual([fileIdentity(f.root,f.source)]);expect(proof.testResult).toEqual(fileIdentity(f.root,f.result));
  fs.appendFileSync(f.source,'// changed since verification');expect(()=>operatingMaintenanceEvidence(f.root,f.state)).toThrow(/Evidence bytes changed/);
});

test('the bounded audit evidence contract permits the newer maintenance receipt, current sources and actual regression result',()=>{
  const f=fixture();acceptOperatingMaintenance(f.root,f.state);const proof=operatingMaintenanceEvidence(f.root,f.state),report=path.join(f.root,'audit');fs.mkdirSync(report);
  const trigger=path.join(report,'trigger.json'),snapshot=path.join(report,'snapshot.json');atomicJSON(trigger,{id:'queued-before-maintenance'});atomicJSON(snapshot,{tasks:{},operatingMaintenance:proof});
  const oversight=new SupervisorOversight({root:f.root,config:{supervisorOversight:{boundEvidence:true}}}),contract=oversight.auditEvidenceContract(report,trigger,snapshot),paths=contract.inputs.map(p=>p.path);
  for(const file of [f.source,f.result,f.receiptFile])expect(paths).toContain(fileIdentity(f.root,file).path);
  expect(paths.some(p=>path.basename(p)==='state.json')).toBe(false);
});

test('a complete 105-file source inventory stays verified without exceeding the audit citation boundary',()=>{
  const f=fixture(),receipt=JSON.parse(fs.readFileSync(f.receiptFile)),pins=[];
  for(let i=0;i<105;i++){const file=path.join(f.root,i===0?'task-workflow.mjs':`source-${i}.mjs`);fs.writeFileSync(file,'export const value=1;');pins.push(fileIdentity(f.root,file));}
  receipt.sourceInputs=pins;atomicJSON(f.receiptFile,receipt);f.state.operatingMaintenance.receiptIdentity=fileIdentity(f.root,f.receiptFile);acceptOperatingMaintenance(f.root,f.state);
  const proof=operatingMaintenanceEvidence(f.root,f.state);expect(proof.sourceInputs).toHaveLength(105);
  const report=path.join(f.root,'audit-many');fs.mkdirSync(report);const trigger=path.join(report,'trigger.json'),snapshot=path.join(report,'snapshot.json');atomicJSON(trigger,{id:'queued'});atomicJSON(snapshot,{tasks:{},operatingMaintenance:proof});
  const contract=new SupervisorOversight({root:f.root,config:{supervisorOversight:{boundEvidence:true}}}).auditEvidenceContract(report,trigger,snapshot);
  expect(contract.inputs.length).toBeLessThanOrEqual(64);expect(contract.inputs.map(p=>p.path)).toContain(pins[0].path);
  fs.appendFileSync(path.resolve(f.root,pins[104].path),' ');expect(()=>operatingMaintenanceEvidence(f.root,f.state)).toThrow(/Evidence bytes changed/);
});
