import {BOUND_IMPLEMENTATION_SCHEMA, BOUND_VERIFICATION_SCHEMA} from './protocol.mjs';
import path from 'node:path';

const str = {type:'string'}, strings={type:'array',items:str};
const object=properties=>({type:'object',properties,required:Object.keys(properties),additionalProperties:false});
export const TASK_ASSIGNMENT_SCHEMA=object({taskId:str,review:str,candidateRoot:str,inputContextPath:str,action:{type:'string',enum:['implement','blocked']},instructions:str,writablePaths:strings,summary:str});
export const TASK_IMPLEMENTATION_SCHEMA=object({...BOUND_IMPLEMENTATION_SCHEMA.properties,taskId:str});
export const CONTROLLER_TASK_IMPLEMENTATION_SCHEMA=object({...TASK_IMPLEMENTATION_SCHEMA.properties,testPlanPath:str});
export const TEST_PREPARATION_SCHEMA=object({taskId:str,candidateRoot:str,status:{type:'string',enum:['completed','blocked']},testPlanPath:str,summary:str});
export const TASK_ASSESSMENT_SCHEMA=object({...BOUND_VERIFICATION_SCHEMA.properties,taskId:str});
export const TASK_RELAY_SCHEMA=object({taskId:str,review:str,verificationPrompt:str});
export const REVIEW_DECISION_SCHEMA=object({review:str,action:{type:'string',enum:['advance','repair','blocked']},repairTaskIds:strings,summary:str,instructions:str});

const forbidden=['src','data','public','scripts','e2e','validation','docs','prompts','automation','tools'];
export function validateAssignment(task,review,assignment,expected={}){
  if(assignment.taskId!==task.id||assignment.review!==review||!['implement','blocked'].includes(assignment.action)||!assignment.instructions?.trim()||!Array.isArray(assignment.writablePaths))throw Error('Task assignment identity/scope mismatch');
  for(const key of ['candidateRoot','inputContextPath'])if(expected[key]&&path.resolve(assignment[key]??'')!==path.resolve(expected[key]))throw Error(`Target binding: assignment ${key} mismatch`);
  for(const name of assignment.writablePaths){
    if(typeof name!=='string'||!name||name.includes('\\')||name.startsWith('/')||name.includes(':')||name.split('/').some(part=>['','..','.'].includes(part)))throw Error('Invalid task writable path');
    if(forbidden.includes(name)||/^(?:\.git|\.codex|\.agents|automation\/prompt15|scripts\/prompt15-orchestrator|docs\/automation|prompts)(?:\/|$)/.test(name))throw Error(`Task cannot own protected/broad control path: ${name}`);
    if(/^(?:data\/(?:raw|source-locks)|reports\/prompt14|node_modules)(?:\/|$)/.test(name))throw Error(`Task cannot own immutable input: ${name}`);
  }
  return assignment;
}
export function pathsOverlap(a,b){return a===b||a.startsWith(`${b}/`)||b.startsWith(`${a}/`);}
export function disjointAssignments(a,b){return !a.writablePaths.some(x=>b.writablePaths.some(y=>pathsOverlap(x,y)));}
export function readyTasks(plan,state,review){
  const prior=plan.checkpoints.find(c=>c.review===review)?.requiresReviews??[];
  if(prior.some(id=>!state.certificates[id]))return [];
  return plan.tasks.filter(task=>plan.checkpoints.find(c=>c.id===task.checkpoint).review===review&&['pending','repair'].includes(state.tasks[task.id].status)&&task.dependsOn.every(id=>state.tasks[id].status==='pass'));
}
export function invalidateDescendants(plan,state,seeds){
  const invalid=new Set(seeds);
  for(const task of plan.tasks)if(task.dependsOn.some(id=>invalid.has(id)))invalid.add(task.id);
  for(const id of invalid){const row=state.tasks[id];if(row.status==='pass')row.previousPass=row.verification;row.status=seeds.includes(id)?'repair':'pending';delete row.acceptedTarget;}
  return [...invalid];
}
