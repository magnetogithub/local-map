import fs from 'node:fs';
import {CHECKPOINTS,GATES,REPAIR_REVIEWS} from './protocol.mjs';

const defaultFile=new URL('../../automation/prompt15/task-plan.json',import.meta.url);
const nonempty=value=>typeof value==='string'&&value.trim().length>0;

// The target plan contains 48 first-class tasks. Parsing this design does not
// activate task scheduling in the legacy review-level controller.
export function validateTaskPlan(plan){
  if(plan?.version!==2||plan.executionUnit!=='task'||plan.taskAcceptance!=='independent-pass'||plan.approvalUnit!=='review'||plan.executionOrder!=='verified-dependency-dag'||!['planned-task-scheduler-required','task-scheduler-enabled'].includes(plan.runtimeStatus))throw Error('Invalid Prompt15 task plan contract');
  if(!Array.isArray(plan.checkpoints)||!Array.isArray(plan.tasks)||plan.tasks.length!==48)throw Error('Missing task plan checkpoints/tasks');
  if(![1,2,3,4].includes(plan.parallelPolicy?.maxConcurrentTasks)||JSON.stringify(plan.parallelPolicy.exclusiveTaskIds)!==JSON.stringify(['15-06','15-47'])||plan.verificationPolicy?.scope!=='assigned-task')throw Error('Invalid task verification/parallel contract');
  const expected=Object.entries(CHECKPOINTS).flatMap(([review,ids])=>ids.map(id=>({id,review})));
  if(plan.checkpoints.length!==expected.length)throw Error('Task plan must preserve all eight checkpoints');
  const checkpoints=new Map();
  for(const [index,checkpoint]of plan.checkpoints.entries()){
    const required=checkpoint.review==='A'?[]:[REPAIR_REVIEWS[REPAIR_REVIEWS.indexOf(checkpoint.review)-1]];
    if(checkpoint.id!==expected[index].id||checkpoint.review!==expected[index].review||JSON.stringify(checkpoint.requiresReviews)!==JSON.stringify(required))throw Error('Task plan must preserve checkpoint order and prior REVIEW approvals');
    checkpoints.set(checkpoint.id,checkpoint);
  }
  const tasks=new Map(),coverage=Object.fromEntries(REPAIR_REVIEWS.map(review=>[review,new Set()]));
  const checkpointCounts=new Map();
  for(const [index,task]of plan.tasks.entries()){
    const checkpoint=checkpoints.get(task.checkpoint),number=(checkpointCounts.get(task.checkpoint)??0)+1;
    if(!checkpoint||task.id!==`15-${String(index+1).padStart(2,'0')}`||task.legacyId!==`${task.checkpoint}-${String(number).padStart(2,'0')}`||tasks.has(task.id))throw Error('Invalid, duplicate or nonsequential task identity');
    checkpointCounts.set(task.checkpoint,number);
    if(!['title','output','check'].every(key=>nonempty(task[key]))||!Array.isArray(task.sections)||!task.sections.length||task.sections.some(section=>!/^\d+(?:\.\d+)?$/.test(section))||!Array.isArray(task.tools)||!task.tools.length||task.tools.some(tool=>!nonempty(tool)))throw Error(`Incomplete task acceptance contract: ${task.id}`);
    if(!Array.isArray(task.dependsOn)||new Set(task.dependsOn).size!==task.dependsOn.length)throw Error(`Invalid dependencies: ${task.id}`);
    for(const dependency of task.dependsOn){
      const previous=tasks.get(dependency);
      if(!previous)throw Error(`Unknown/forward/cyclic task dependency: ${task.id} -> ${dependency}`);
      if(['15-5','15-6'].includes(task.checkpoint)&&['15-5','15-6'].includes(previous.checkpoint)&&previous.checkpoint!==task.checkpoint)throw Error('D branches must remain independently preparable before integration');
    }
    if(!Array.isArray(task.gates)||!task.gates.length||new Set(task.gates).size!==task.gates.length||task.gates.some(gate=>!GATES[checkpoint.review].includes(gate)))throw Error(`Task changes the REVIEW gate contract: ${task.id}`);
    task.gates.forEach(gate=>coverage[checkpoint.review].add(gate));
    tasks.set(task.id,task);
  }
  for(const checkpoint of plan.checkpoints)if(!checkpointCounts.has(checkpoint.id))throw Error(`Empty checkpoint: ${checkpoint.id}`);
  for(const review of REPAIR_REVIEWS)if(GATES[review].some(gate=>!coverage[review].has(gate)))throw Error(`Missing task coverage for REVIEW ${review}`);
  const integration=plan.integration;
  if(integration?.review!=='D'||!nonempty(integration.beforeBranching)||!nonempty(integration.check)||JSON.stringify(integration.requiresTasks)!==JSON.stringify(['15-5','15-6'].map(id=>plan.tasks.filter(task=>task.checkpoint===id).at(-1).id)))throw Error('D integration must await both complete branches');
  return plan;
}

export function readTaskPlan(){return validateTaskPlan(JSON.parse(fs.readFileSync(defaultFile,'utf8')));}

export function taskPlanInstructions(review,{checkpoint=null}={}){
  const plan=readTaskPlan();
  if(!REPAIR_REVIEWS.includes(review)||checkpoint&&!CHECKPOINTS[review].includes(checkpoint))throw Error('Invalid task-plan review/checkpoint');
  const selected=plan.tasks.filter(task=>CHECKPOINTS[review].includes(task.checkpoint)&&(!checkpoint||task.checkpoint===checkpoint));
  const lines=[`Prompt 15 독립 태스크 목표 계획: REVIEW ${review}${checkpoint?` / 작업 구간 ${checkpoint}`:''}, ${selected.length}개 태스크. 각 태스크의 독립 검증 PASS 후 의존 작업을 해제한다. 원문 요구사항과 REVIEW gate는 유지한다. 현재 컨트롤러의 REVIEW 일괄 배정은 호환 모드이며 48개 태스크 스케줄러 전환 완료를 뜻하지 않는다.`];
  if(review==='D')lines.push(`분기 전 공통 계약: ${plan.integration.beforeBranching}`);
  for(const task of selected){
    const prior=plan.checkpoints.find(item=>item.id===task.checkpoint).requiresReviews;
    lines.push(`${task.id} ${task.title}\n선행: ${[...task.dependsOn.map(id=>`${id} 검증 PASS`),...prior.map(id=>`REVIEW ${id} PASS`)].join(', ')||'수동 Prompt14 승인 후보 접수'}\n산출물: ${task.output}\n태스크 검증 기준: ${task.check}\n검증 분기: PASS=의존 작업 해제, FAIL=같은 태스크 보완, BLOCKED=태스크와 의존 작업 대기\n도구: ${task.tools.join(', ')}; 원문: ${task.sections.join(', ')}절; 연결 gate: ${task.gates.join(', ')}`);
  }
  if(review==='D'&&!checkpoint)lines.push(`D 통합: ${plan.integration.check}`);
  return lines.join('\n\n');
}
