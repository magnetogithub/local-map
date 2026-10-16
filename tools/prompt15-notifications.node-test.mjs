import test from 'node:test';
import assert from 'node:assert/strict';
import {taskNotification, workflowNotification, consumeEvent} from './prompt15-notification-core.mjs';

test('tool and commentary completion do not send task notifications', () => {
  assert.equal(taskNotification({kind: 'event', method: 'item/completed', itemType: 'commandExecution'}), null);
  assert.equal(taskNotification({kind: 'agent_message', phase: 'commentary'}), null);
});
test('a verifier FAIL is clearly labeled even when the model turn completed successfully', () => {
  const message = taskNotification({kind: 'event', method: 'turn/completed', status: 'completed', turnId: 'test', at: 'now'}, {role: 'verifier', review: 'C'}, JSON.stringify({verdict: 'fail', summary: 'Actual geometry failed'}));
  assert.match(message.title, /검증 FAIL/);
  assert.match(message.body, /REVIEW C/);
});
test('a prompt-task PASS is explicitly distinguished from a full REVIEW PASS', () => {
  const message = taskNotification({kind: 'event', method: 'turn/completed', status: 'completed', turnId: 'task-pass', at: 'now'}, {role: 'verifier', review: 'B', key: 'task-verifier-1'}, '{"verdict":"pass","readyForReview":false}');
  assert.match(message.title, /프롬프트 수행 PASS/);
  assert.match(message.body, /전체 REVIEW 판정과 별도/);
});
test('B prerequisite is recognized from its report folder even while the main review is C', () => {
  const message = taskNotification({kind: 'event', method: 'turn/completed', status: 'completed', turnId: 'b'}, {role: 'verifier', review: 'C', reportDirectory: 'reports/prompt15/orchestration/run/rounds/0003-B/verification'}, '{"verdict":"pass"}');
  assert.equal(message.review, 'B');
});
test('completion events are deduplicated and associated with their own thread result', () => {
  const state = {};
  consumeEvent({kind: 'dispatch', threadId: 'one', role: 'implementer', key: 'branch-15-5', review: 'D'}, state);
  consumeEvent({kind: 'agent_message', threadId: 'one', phase: 'final_answer', text: '{"status":"blocked","summary":"Report constraints to supervisor"}'}, state);
  const completion = {kind: 'event', threadId: 'one', method: 'turn/completed', status: 'completed', turnId: 'one-turn'};
  assert.match(consumeEvent(completion, state).title, /\[15-5\] 구현 진행 제약 보고/);
  assert.equal(consumeEvent(completion, state), null);
});

test('a new task in the same session never inherits the previous task result', () => {
  const state = {};
  consumeEvent({kind: 'dispatch', threadId: 'same', role: 'implementer'}, state);
  consumeEvent({kind: 'agent_message', threadId: 'same', phase: 'final_answer', text: '{"status":"completed","summary":"Old candidate passed"}'}, state);
  consumeEvent({kind: 'event', threadId: 'same', method: 'turn/completed', status: 'completed', turnId: 'old'}, state);
  consumeEvent({kind: 'dispatch', threadId: 'same', role: 'implementer'}, state);
  const interrupted = consumeEvent({kind: 'event', threadId: 'same', method: 'turn/completed', status: 'interrupted', turnId: 'new'}, state);
  assert.match(interrupted.title, /중단됨/);
  assert.doesNotMatch(interrupted.body, /Old candidate passed/);
});

test('implementation timeout interruption explains continuation instead of a stopped workflow', () => {
  const state = {};
  consumeEvent({kind:'dispatch',threadId:'implementation',role:'implementer',sessionName:'[15-3] 구현',review:'B'},state);
  consumeEvent({kind:'workflow_waiting',status:'recovering',at:'2026-10-13T08:24:48Z',reason:'Turn timeout for implementation; no completion was certified'},state);
  const notification = consumeEvent({kind:'event',method:'turn/completed',threadId:'implementation',turnId:'timeout-turn',status:'interrupted',at:'2026-10-13T08:24:49Z'},state);
  assert.match(notification.title,/시간 제한 · 이어가기/);
  assert.match(notification.body,/이어 구현/);
  assert.doesNotMatch(notification.title,/중단됨/);
});

test('an authorized operating-policy transition is labeled separately from unexpected interruption', () => {
  const state = {};
  consumeEvent({kind:'dispatch',threadId:'implementation',role:'implementer',review:'B'},state);
  const change = {type:'runtime_update',status:'pausing_at_task_boundary',requestedAt:'2026-10-13T08:00:00Z',stopRequestedAt:'2026-10-13T08:00:01Z',model:'gpt-6.1-sol',effort:'high',checkpointCorrection:{turnId:'controlled'}};
  const notification = consumeEvent({kind:'event',method:'turn/completed',threadId:'implementation',turnId:'controlled',status:'interrupted',at:'2026-10-13T08:00:02Z'},state,change);
  assert.match(notification.title,/운영 규칙 적용/);
  assert.doesNotMatch(notification.title,/중단됨/);
});
test('F standby and real workflow stops produce explicit status notifications', () => {
  assert.match(workflowNotification({kind: 'standby_after_review_f', at: 'now'}).body, /게시 없이/);
  assert.match(workflowNotification({kind: 'workflow_stopped', status: 'blocked', at: 'now', reason: 'Needs a decision'}).body, /Needs a decision/);
});

const modelChange = {model: 'gpt-6.1-sol', effort: 'high', status: 'resuming_with_high', requestedAt: '2026-10-13T00:21:40Z', updatedAt: '2026-10-13T00:24:02Z'};
const plannedStop = {kind: 'workflow_stopped', status: 'stopped', at: '2026-10-13T00:24:01Z', reason: 'Workflow stop requested', review: 'C'};

test('a planned model restart reports configuration and still deduplicates the stop event', () => {
  const state = {};
  const message = consumeEvent(plannedStop, state, modelChange);
  assert.match(message.title, /모델 설정 적용 중/);
  assert.match(message.body, /gpt-6\.1-sol \/ high/);
  assert.equal(consumeEvent(plannedStop, state, modelChange), null);
});

test('model change metadata never hides failures or stops after the restart', () => {
  assert.match(workflowNotification({...plannedStop, status: 'blocked', reason: 'Evidence changed'}, modelChange).title, /진행 차단/);
  assert.match(workflowNotification({...plannedStop, at: '2026-10-13T00:25:01Z'}, modelChange).title, /운영 중단/);
  assert.match(workflowNotification(plannedStop, {...modelChange, status: 'restart_failed'}).title, /운영 중단/);
});

test('an unfinished planned transition has a bounded window and no marker means a normal stop', () => {
  const pausing = {...modelChange, status: 'pausing_at_task_boundary', stopRequestedAt: '2026-10-13T00:24:00Z'};
  assert.match(workflowNotification(plannedStop, pausing).title, /모델 설정 적용 중/);
  assert.match(workflowNotification({...plannedStop, at: '2026-10-13T00:30:00Z'}, pausing).title, /운영 중단/);
  assert.match(workflowNotification(plannedStop).title, /운영 중단/);
});

test('checkpoint correction recognizes only its interrupted turn within the transition window', () => {
  const change = {...modelChange, type: 'runtime_update', status: 'resuming_runtime', resumedAt: modelChange.updatedAt, checkpointCorrection: {turnId: 'owned'}};
  const interrupted = {...plannedStop, reason: 'Turn interrupted: owned'};
  const notification = workflowNotification(interrupted, change);
  assert.match(notification.title, /운영 규칙 일괄 적용 중/);
  assert.match(notification.body, /미완료 산출물/);
  assert.doesNotMatch(notification.body, /완료 보고/);
  assert.match(workflowNotification({...interrupted, reason: 'Turn interrupted: another'}, change).title, /운영 중단/);
  assert.match(workflowNotification({...interrupted, at: '2026-10-13T00:25:01Z'}, change).title, /운영 중단/);
  assert.match(workflowNotification({...interrupted, reason: 'Actual source failure'}, change).title, /운영 중단/);
});

test('applied checkpoint correction sends a distinct status notification once', () => {
  const state = {};
  const event = {kind: 'checkpoint_correction_applied', origin: 'orchestration-control', at: 'now'};
  assert.match(consumeEvent(event, state).title, /B 배정 정정 완료/);
  assert.equal(consumeEvent(event, state), null);
  assert.equal(workflowNotification({...event, origin: 'unknown'}), null);
});

test('input waiting and runtime recovery notifications explicitly keep the operation active', () => {
  assert.match(workflowNotification({kind: 'workflow_waiting', at: 'now', status: 'waiting_input', reason: 'Missing input'}).title, /운영 유지/);
  assert.match(workflowNotification({kind: 'workflow_waiting', at: 'now', status: 'recovering', reason: 'Server exited'}).title, /복구 중/);
  assert.match(workflowNotification(plannedStop, {...modelChange, type: 'runtime_update'}).title, /운영 규칙 일괄 적용 중/);
  assert.match(taskNotification({kind: 'event', method: 'turn/completed', status: 'completed', turnId: 'named'}, {role: 'implementer', sessionName: '[15-4] 구현'}, '{"status":"completed"}').title, /\[15-4\] 구현/);
});

test('a pending revision explains only operator-code invalidation and leaves functional changes visible', () => {
  const change = {...modelChange, type: 'runtime_update', status: 'waiting_for_task_report', operatorVerificationChanges: ['scripts/prompt15-orchestrator/workflow.mjs']};
  const event = {...plannedStop, status: 'blocked', reason: 'Source changed during independent verification; certification withheld'};
  assert.match(workflowNotification(event, change).title, /운영 규칙 일괄 적용 중/);
  assert.match(workflowNotification(event, {...change, operatorVerificationChanges: ['src/geometry.ts']}).title, /진행 차단/);
  assert.match(workflowNotification({...event, at: '2026-10-13T00:26:00Z'}, {...change, resumedAt: '2026-10-13T00:25:00Z'}).title, /진행 차단/);
});
