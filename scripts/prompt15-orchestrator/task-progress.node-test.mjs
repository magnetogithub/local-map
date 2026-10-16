import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {TaskWorkflow} from './task-workflow.mjs';

function fixture(t,phase='implement',status='implemented'){
  const base=path.resolve('.tmp/task-progress-regression');fs.mkdirSync(base,{recursive:true});const root=fs.mkdtempSync(path.join(base,'case-')),directory=path.join(root,'run');fs.mkdirSync(directory);
  const w=new TaskWorkflow({root,directory,config:{},server:{}});w.state.status='running';w.state.phase=phase;w.state.currentTasks=['15-01'];w.state.tasks['15-01'].status=status;w.state.activeTurns={};w.state.nextAction='태스크 15-01 구현 중';
  t.after(()=>{assert.ok(root.startsWith(base+path.sep));fs.rmSync(root,{recursive:true,force:true});});return w;
}
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
