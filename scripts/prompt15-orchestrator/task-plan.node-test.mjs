import fs from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {GATES} from './protocol.mjs';
import {readTaskPlan,validateTaskPlan,taskPlanInstructions} from './task-plan.mjs';
import {reviewUnitInstructions} from './units.mjs';

test('all 48 bounded tasks preserve checkpoint/review coverage and match the functional prompt table',()=>{
  const plan=readTaskPlan(),prompt=fs.readFileSync(new URL('../../prompts/PROMPT_15_OPERATIONAL_MICRO_TERRITORIES_AND_PARTIAL_FRONTS.txt',import.meta.url),'utf8');
  assert.equal(plan.tasks.length,48);
  assert.equal(plan.executionUnit,'task');assert.equal(plan.taskAcceptance,'independent-pass');
  assert.equal(plan.runtimeStatus,'task-scheduler-enabled');
  assert.deepEqual(plan.checkpoints.map(checkpoint=>plan.tasks.filter(task=>task.checkpoint===checkpoint.id).length),[6,4,7,7,6,5,7,6]);
  const rows=[...prompt.matchAll(/^\| (15-\d{2}) \| (.*)$/gm)];
  assert.deepEqual(rows.map(row=>row[1]),plan.tasks.map(task=>task.id));
  for(const task of plan.tasks){const row=rows.find(row=>row[1]===task.id)[2];assert.ok(row.includes(task.title)&&row.includes(task.output)&&row.includes(task.check),task.id);}
  for(const [review,gates]of Object.entries(GATES)){
    const instructions=reviewUnitInstructions(review);for(const gate of gates)assert.ok(instructions.includes(gate));
    assert.match(instructions,/검증 분기: PASS=의존 작업 해제, FAIL=같은 태스크 보완, BLOCKED=태스크와 의존 작업 대기/);
  }
  assert.match(prompt,/implementationUnit=task/);
});

test('unknown/cyclic dependencies and skipped prior REVIEW approvals are rejected',()=>{
  const cyclic=readTaskPlan();cyclic.tasks[0].dependsOn=['15-17'];assert.throws(()=>validateTaskPlan(cyclic),/dependency/);
  const skip=readTaskPlan();skip.checkpoints.find(checkpoint=>checkpoint.id==='15-7').requiresReviews=[];assert.throws(()=>validateTaskPlan(skip),/prior REVIEW/);
  const noAcceptance=readTaskPlan();noAcceptance.tasks[0].check='';assert.throws(()=>validateTaskPlan(noAcceptance),/acceptance contract/);
});

test('splitting work cannot silently remove or replace a whole REVIEW gate',()=>{
  const removed=readTaskPlan();
  for(const task of removed.tasks.filter(task=>task.checkpoint==='15-3'))task.gates=task.gates.filter(gate=>gate!=='physical_resolution');
  assert.throws(()=>validateTaskPlan(removed),/gate contract|Missing task coverage/);
  const replaced=readTaskPlan();replaced.tasks[0].gates=['pretend_gate'];assert.throws(()=>validateTaskPlan(replaced),/gate contract/);
});

test('D branches remain independently preparable, receive their own task lists, and integrate only after both',()=>{
  const linked=readTaskPlan();linked.tasks.find(task=>task.id==='15-31').dependsOn.push('15-30');assert.throws(()=>validateTaskPlan(linked),/independently preparable/);
  const half=readTaskPlan();half.integration.requiresTasks.pop();assert.throws(()=>validateTaskPlan(half),/both complete branches/);
  const lookup=taskPlanInstructions('D',{checkpoint:'15-5'}),migration=taskPlanInstructions('D',{checkpoint:'15-6'});
  assert.match(lookup,/\n\n15-25 /);assert.doesNotMatch(lookup,/\n\n15-31 /);
  assert.match(migration,/\n\n15-31 /);assert.doesNotMatch(migration,/\n\n15-25 /);
  assert.match(lookup,/분기 전 공통 계약/);assert.match(migration,/분기 전 공통 계약/);
  assert.match(taskPlanInstructions('D'),/D 통합:/);
  assert.throws(()=>taskPlanInstructions('B',{checkpoint:'15-7'}),/Invalid task-plan/);
});

test('protected geometry preparation precedes state migration without making B/C depend on D/E tasks',()=>{
  const plan=readTaskPlan();
  assert.match(plan.tasks.find(task=>task.id==='15-11').output,/protected overlay/);
  assert.match(plan.tasks.find(task=>task.id==='15-20').output,/이전 geometry 부모/);
  const byId=new Map(plan.tasks.map(task=>[task.id,task]));
  for(const checkpoint of ['15-3','15-4'])for(const task of plan.tasks.filter(task=>task.checkpoint===checkpoint)){
    assert.ok(task.dependsOn.every(id=>Number(byId.get(id).checkpoint.split('-')[1])<=Number(checkpoint.split('-')[1])));
  }
});
