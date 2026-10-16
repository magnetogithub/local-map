// Canonical Vitest suite; test bodies and assertions retained from the prior control suite.
import {test as vitestTest,vi} from 'vitest';
const test=(name,body)=>vitestTest(name,context=>body({after:fn=>context.onTestFinished(fn)}),600000);
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {TaskWorkflow} from './task-workflow.mjs';
import {taskNextAction} from './task-progress.mjs';
import {collectSessionActivity,sessionStatusLines,sessionLabel} from '../../tools/prompt15-session-progress-core.mjs';

function fixture(t,phase='implement',status='implemented'){
  const base=path.resolve('.tmp/task-progress-regression');fs.mkdirSync(base,{recursive:true});const root=fs.mkdtempSync(path.join(base,'case-')),directory=path.join(root,'run');fs.mkdirSync(directory);
  const w=new TaskWorkflow({root,directory,config:{},server:{}});w.state.status='running';w.state.phase=phase;w.state.currentTasks=['15-01'];w.state.tasks['15-01'].status=status;w.state.activeTurns={};w.state.nextAction='태스크 15-01 구현 중';
  t.after(()=>{assert.ok(root.startsWith(base+path.sep));fs.rmSync(root,{recursive:true,force:true});});return w;
}

test('Windows progress replacement contention never aborts a durable product handoff',t=>{
  const w=fixture(t),original=fs.renameSync,originalWrite=fs.writeFileSync,progress=path.join(w.directory,'progress.txt');
  const failure=Object.assign(Error('fixture Windows sharing violation'),{code:'EPERM'});
  const spy=vi.spyOn(fs,'renameSync').mockImplementation((from,to)=>{if(to===progress)throw failure;return original(from,to);});
  const writer=vi.spyOn(fs,'writeFileSync').mockImplementation((file,...args)=>{if(file===progress)throw failure;return originalWrite(file,...args);});
  try{
    assert.doesNotThrow(()=>w.save());assert.equal(w.state.status,'running');assert.equal(w.state.progressDisplayError.code,'EPERM');
    assert.equal(JSON.parse(fs.readFileSync(w.stateFile,'utf8')).tasks['15-01'].status,'implemented');
    assert.equal(fs.existsSync(path.join(w.directory,`.progress-${process.pid}.tmp`)),false);
  }finally{spy.mockRestore();writer.mockRestore();}
  w.save();assert.ok(fs.readFileSync(progress,'utf8').includes('15-01'));assert.equal(w.state.progressDisplayError,undefined);
});

test('Windows rename denial falls back to updating the display without losing product state',t=>{
  const w=fixture(t),original=fs.renameSync,progress=path.join(w.directory,'progress.txt');
  const spy=vi.spyOn(fs,'renameSync').mockImplementation((from,to)=>{if(to===progress)throw Object.assign(Error('fixture reader denies replace'),{code:'EPERM'});return original(from,to);});
  try{assert.doesNotThrow(()=>w.save());assert.ok(fs.readFileSync(progress,'utf8').includes('15-01'));assert.equal(w.state.progressDisplayError,undefined);assert.equal(w.state.status,'running');}
  finally{spy.mockRestore();}
});
test('completed implementation with no active turn never retains an implementation-running next action',t=>{
  const w=fixture(t),before=structuredClone(w.state.tasks);w.save();const saved=JSON.parse(fs.readFileSync(w.stateFile,'utf8'));
  assert.doesNotMatch(saved.nextAction,/구현 중/);assert.match(saved.nextAction,/구현.*완료/);assert.match(saved.nextAction,/검증|인계/);assert.deepEqual(saved.tasks,before);
  const progress=fs.readFileSync(path.join(w.directory,'progress.txt'),'utf8');assert.doesNotMatch(progress.split('\n').find(line=>line.startsWith('다음 동작:')),/구현 중/);
});
test('implementation handoff is truthful before the guardian reads state and progress',async t=>{
  const w=fixture(t);let checked=false;w.guardian={async inspect(){const saved=JSON.parse(fs.readFileSync(w.stateFile,'utf8'));assert.equal(saved.phase,'implementation_handoff');assert.doesNotMatch(saved.nextAction,/구현 중/);assert.match(saved.nextAction,/인계|운영.*점검/);checked=true;return{decision:'continue',summary:'handoff',ruleChanges:[]};}};
  await w.audit('implementation_handoff');assert.equal(checked,true);
});
test('active verifier and completed verifier cannot display stale implementation activity',t=>{
  const w=fixture(t,'task_verify','verifying');w.state.activeTurns={'verifier-0':{taskId:'15-01',runningCommands:{}}};w.save();assert.match(w.state.nextAction,/검증/);assert.doesNotMatch(w.state.nextAction,/구현 중/);
  w.state.activeTurns={};w.state.tasks['15-01'].status='verified';w.save();assert.match(w.state.nextAction,/검증.*완료/);assert.doesNotMatch(w.state.nextAction,/검증 중|구현 중/);
});
test('held state and heartbeat cannot revive an implementation-running next action',t=>{
  const w=fixture(t);w.state.status='waiting_execution';w.state.heartbeatAt=new Date().toISOString();w.save();assert.doesNotMatch(w.state.nextAction,/구현 중|검증 중/);assert.match(w.state.nextAction,/정지|대기|보류|확인/);
});
test('parallel next action identifies the actual active task without reviving a completed sibling',t=>{
  const w=fixture(t);w.state.currentTasks=['15-01','15-02'];w.state.tasks['15-02'].status='running';w.state.activeTurns={'implementer-1':{taskId:'15-02',runningCommands:{}}};w.save();assert.match(w.state.nextAction,/15-02/);assert.doesNotMatch(w.state.nextAction,/15-01 구현 중/);
});
test('operating repair and reload retain their actual control activity with no product turn',t=>{
  const w=fixture(t,'operating_repair');w.state.guardian.activeAuditId='repair';w.state.nextAction='운영 감시가 제어 코드 수리·회귀 검사를 진행 중';w.save();assert.match(w.state.nextAction,/수리|운영.*점검/);assert.doesNotMatch(w.state.nextAction,/구현 중/);
  delete w.state.guardian.activeAuditId;w.state.status='reloading_orchestration';w.state.nextAction='운영 수리 검사 통과·제어기 재시작 후 미완료 단계 재개';w.save();assert.match(w.state.nextAction,/재시작|재개/);assert.doesNotMatch(w.state.nextAction,/구현 중/);
});

test('supervisor audit and incomplete repair states remain explicit when product work is idle',()=>{
  const labels={auditing:/총괄.*독립 감사 중/,repair_pending:/운영 수리 인계 대기/,repair_applied_awaiting_product:/새 태스크 검증.*사건 유지/,failed:/감사 실패/,escalation_exhausted:/복구 한도 도달/};
  for(const[status,pattern]of Object.entries(labels)){
    const state={status:'recovering',phase:'implement',currentTasks:['15-03'],tasks:{'15-03':{status:'blocked'}},activeTurns:{},supervisorOversight:{status}};
    const before=JSON.stringify(state);assert.match(taskNextAction(state),pattern);assert.equal(JSON.stringify(state),before);
    state.status='waiting_execution';assert.match(taskNextAction(state),pattern);
  }
});

test('actual product work takes precedence over supervisor audit text while a user stop remains binding',()=>{
  const state={status:'recovering',phase:'implement',review:'B',currentTasks:['15-11'],tasks:{'15-11':{status:'running'}},activeTurns:{'implementer-15-11':{taskId:'15-11'}},supervisorOversight:{status:'repair_pending'}};
  assert.match(taskNextAction(state),/15-11 구현 중/);assert.doesNotMatch(taskNextAction(state),/인계 대기/);
  state.activeTurns={};state.tasks['15-11'].status='verifying';state.activeOperations={'15-11':{kind:'vitest',taskId:'15-11'}};
  assert.match(taskNextAction(state),/15-11 태스크 검증 중.*Vitest/);
  state.activeOperations={};state.activeTurns={'vitest-review-verifier-B':{review:'B'}};
  assert.match(taskNextAction(state),/REVIEW B 리뷰 검증 중/);
  state.status='stopped';assert.match(taskNextAction(state),/사용자 정지/);assert.doesNotMatch(taskNextAction(state),/검증 중|감사 중/);
});

test('supervisor failure and applied-but-unconfirmed repair are not displayed as healthy or active work',()=>{
  const labels={repair_applied_awaiting_product:/운영 수리 적용.*제품 진척 확인 대기/,failed:/운영 감사 실패.*복구 필요/,escalation_exhausted:/복구 한도 도달/};
  for(const[status,pattern]of Object.entries(labels)){
    const state={status:'waiting_execution',threads:{supervisor:'supervisor-fixed'},guardian:{},activeTurns:{},supervisorOversight:{status}};
    let line=sessionStatusLines(state,collectSessionActivity(state,[])).find(value=>value.includes('총괄:'));
    assert.match(line,pattern);assert.match(line,/^○/);assert.doesNotMatch(line,/healthy|정상|감사 중/);
    state.status='stopped';line=sessionStatusLines(state,collectSessionActivity(state,[])).find(value=>value.includes('총괄:'));assert.match(line,/운영 정지/);
  }
  assert.equal(sessionLabel('vitest-review-verifier-A'),'리뷰 검증 A');assert.equal(sessionLabel('vitest-review-verifier-F'),'리뷰 검증 F');
  assert.equal(sessionLabel('vitest-review-verifier'),'리뷰 검증');assert.equal(sessionLabel('review-verifier'),'리뷰 검증');
});
