import test from 'node:test';
import assert from 'node:assert/strict';
import {reviewActivity, executionProgress,operationView} from './prompt15-progress-core.mjs';

test('waiting verification never appears to be running despite its phase/heartbeat', () => {
  const state = {status: 'waiting_execution', phase: 'verify', heartbeatAt: new Date().toISOString(), activeVerification: {review: 'B', attempt: 2}};
  assert.match(reviewActivity(state, {verify: '전체 검증 중'}), /검증 정지/);
  const text = executionProgress(state, {completed: 6, total: 57, stages: [{id: 'role-check', status: 'pending'}]}).join('\n');
  assert.match(text, /6\/57/); assert.match(text, /role-check/); assert.match(text, /생존 표시/);
  assert.equal(reviewActivity({...state, status: 'running'}, {verify: '전체 검증 중'}), '전체 검증 중');
});
test('manual verification mode never displays stale automatic activity and preserves the original run state',()=>{
  const original={status:'running',phase:'baseline_verify',activeRole:'verifier',heartbeatAt:'old',error:'previous permission hold',repairAttempts:0};
  const before=JSON.stringify(original),view=operationView(original,{executionMode:'manual-prompt14'});
  assert.equal(view.status,'manual_hold');assert.equal(view.activeRole,null);assert.equal(view.error,null);assert.equal(JSON.stringify(original),before);
  assert.match(reviewActivity(view,{baseline_verify:'running'}),/정지/);assert.equal(operationView(original,{executionMode:'orchestrated'}),original);
});
