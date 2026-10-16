import {describe, expect, test, onTestFinished} from 'vitest';
import {concurrencyLimit, implementationSessionKey, selectTaskBatch} from './task-scheduler.mjs';
import fs from 'node:fs';
import path from 'node:path';
import {taskContract,deterministicAssignment} from './task-contracts.mjs';
import {validateAssignment} from './task-protocol.mjs';
import {prepareWorkspace,planWorkspaceMerge,applyWorkspaceMerge} from './workspaces.mjs';

function fixture(ids = ['15-01', '15-02', '15-03', '15-04', '15-05']) {
  const tasks = ids.map(id => ({id, checkpoint: 'first', dependsOn: id === '15-01' ? [] : ['15-01']}));
  const plan = {tasks, checkpoints: [{id: 'first', review: 'A', requiresReviews: []}], parallelPolicy: {maxConcurrentTasks: 4}};
  const state = {certificates: {}, tasks: Object.fromEntries(ids.map(id => [id, {status: id === '15-01' ? 'pass' : 'pending'}]))};
  return {plan, state};
}

const uniqueScope = task => ({writablePaths: [`src/features/${task.id}`]});
const selectedIds = (fixture, options) => selectTaskBatch(fixture.plan, fixture.state, 'A', options).map(task => task.id);

describe('safe four-slot admission', () => {
  test('admits four independent ready tasks and keeps the caller state unchanged', () => {
    const f = fixture();
    const before = JSON.stringify(f);
    expect(selectedIds(f, {assignmentFor: uniqueScope})).toEqual(['15-02', '15-03', '15-04', '15-05']);
    expect(JSON.stringify(f)).toBe(before);
    expect(selectedIds(f, {limit: 3, assignmentFor: uniqueScope})).toEqual(['15-02', '15-03', '15-04']);
  });

  test('checks the third and fourth assignments against each other, including prefix overlap', () => {
    const f = fixture(['15-01', '15-02', '15-03', '15-04', '15-05', '15-07']);
    const assignmentFor = task => ({writablePaths: ({
      '15-02': ['src/alpha'], '15-03': ['src/beta'], '15-04': ['src/shared'],
      '15-05': ['src/shared/nested/file.ts'], '15-07': ['src/shared-other'],
    })[task.id]});
    expect(selectedIds(f, {assignmentFor})).toEqual(['15-02', '15-03', '15-04', '15-07']);
  });

  test('completed verification and in-flight assignments take priority without changing scope', () => {
    const f = fixture(['15-01', '15-02', '15-03', '15-04', '15-05', '15-07']);
    f.state.tasks['15-05'] = {status: 'verified', assignment: {writablePaths: ['src/features/15-02']}};
    f.state.tasks['15-07'] = {status: 'running', assignment: {writablePaths: ['src/legacy-scope']}};
    expect(selectedIds(f, {assignmentFor: uniqueScope})).toEqual(['15-05', '15-07', '15-03', '15-04']);
  });

  test('does not release dependencies or previous review gates for ready or unfinished work', () => {
    const f = fixture();
    f.state.tasks['15-01'].status = 'verifying';
    expect(selectedIds(f, {assignmentFor: uniqueScope})).toEqual(['15-01']);
    f.state.tasks['15-01'].status = 'pass';
    f.plan.checkpoints[0].requiresReviews = ['previous'];
    f.state.tasks['15-04'].status = 'running';
    expect(selectedIds(f, {assignmentFor: uniqueScope})).toEqual([]);
    f.state.certificates.previous = {verification: 'actual certificate'};
    expect(selectedIds(f, {assignmentFor: uniqueScope})).toEqual(['15-04', '15-02', '15-03', '15-05']);
  });

  test.each(['15-06', '15-47'])('exclusive %s runs alone and is not starved by later work', exclusiveId => {
    const f = fixture(['15-01', '15-02', exclusiveId, '15-07', '15-08']);
    expect(selectedIds(f, {assignmentFor: uniqueScope})).toEqual(['15-02']);
    f.state.tasks['15-02'].status = 'pass';
    expect(selectedIds(f, {assignmentFor: uniqueScope})).toEqual([exclusiveId]);
    f.state.tasks[exclusiveId].status = 'running';
    expect(selectedIds(f, {assignmentFor: uniqueScope})).toEqual([exclusiveId]);
  });

  test('read-only scopes may share slots; unknown scopes are never assumed read-only', () => {
    const f = fixture();
    expect(selectedIds(f, {assignmentFor: () => ({writablePaths: []})})).toHaveLength(4);
    expect(selectedIds(f)).toEqual(['15-02']);
    expect(selectedIds(f, {assignmentFor: task => task.id === '15-03' ? undefined : uniqueScope(task)}))
      .toEqual(['15-02', '15-04', '15-05']);
  });
});

test('concurrency honors valid configuration and never exceeds four slots', () => {
  expect(concurrencyLimit({maxConcurrentTasks: 3}, {parallelPolicy: {maxConcurrentTasks: 2}})).toBe(3);
  expect(concurrencyLimit({}, {parallelPolicy: {maxConcurrentTasks: 2}})).toBe(2);
  expect(concurrencyLimit({maxConcurrentTasks: 50})).toBe(4);
  for (const invalid of [0, -1, 1.5, NaN, Infinity, '4', null]) {
    expect(concurrencyLimit({maxConcurrentTasks: invalid}, {parallelPolicy: {maxConcurrentTasks: 3}})).toBe(3);
  }
  expect(concurrencyLimit()).toBe(4);
});

test('new task sessions are distinct, repairs reuse the task identity, and active legacy keys survive', () => {
  expect(implementationSessionKey('15-08')).toBe('implementer-15-08');
  expect(implementationSessionKey('15-09')).not.toBe(implementationSessionKey('15-08'));
  expect(implementationSessionKey('15-08', implementationSessionKey('15-08'))).toBe('implementer-15-08');
  expect(implementationSessionKey('15-06', 'implementer-0')).toBe('implementer-0');
  expect(() => implementationSessionKey('../foreign')).toThrow(/identity/);
});

test('active branches retain slots and write scopes while a newly ready child is admitted',()=>{
  const f=fixture(['15-01','15-02','15-03','15-04','15-05','15-07']);
  f.state.tasks['15-02'].status='running';f.state.tasks['15-03'].status='running';
  f.state.tasks['15-04'].status='pass';f.state.tasks['15-05'].status='pass';
  f.plan.tasks.find(t=>t.id==='15-07').dependsOn=['15-04'];
  expect(selectedIds(f,{limit:3,activeTaskIds:['15-02','15-03'],assignmentFor:uniqueScope})).toEqual(['15-02','15-03','15-07']);
  expect(selectedIds(f,{limit:2,activeTaskIds:['15-02','15-03'],assignmentFor:uniqueScope})).toEqual(['15-02','15-03']);
});

test('an exclusive performance task waits for active branches and prevents new admission until they drain',()=>{
  const f=fixture(['15-01','15-06','15-07','15-08']);f.state.tasks['15-07'].status='running';
  expect(selectedIds(f,{activeTaskIds:['15-07'],assignmentFor:uniqueScope})).toEqual(['15-07']);
  f.state.tasks['15-07'].status='pass';expect(selectedIds(f,{assignmentFor:uniqueScope})).toEqual(['15-06']);
});

const originalPlan=JSON.parse(fs.readFileSync(new URL('../../automation/prompt15/task-plan.json',import.meta.url),'utf8'));
function originalScopeFixture(ids){
  const state={certificates:Object.fromEntries(['A','B','C','D','E'].map(id=>[id,{kind:'scheduling fixture'}])),tasks:Object.fromEntries(originalPlan.tasks.map(task=>[task.id,{status:ids.includes(task.id)?'pending':'pass'}]))};
  const review=originalPlan.checkpoints.find(c=>c.id===originalPlan.tasks.find(t=>t.id===ids[0]).checkpoint).review;
  return {state,review,select:(options={})=>selectTaskBatch(originalPlan,state,review,{assignmentFor:task=>taskContract(task,review),...options}).map(task=>task.id)};
}

test.each([['15-14','15-15'],['15-39','15-41']])('original plan admits both %s and %s without broad directory locks',(left,right)=>{
  const f=originalScopeFixture([left,right]);
  expect(f.select()).toEqual([left,right]);
  f.state.tasks[left].status='running';
  expect(f.select({activeTaskIds:[left]})).toEqual([left,right]);
  for(const id of [left,right]){
    const task=originalPlan.tasks.find(t=>t.id===id),contract=taskContract(task,f.review);
    const assignment=deterministicAssignment(task,f.review,'candidate','input.json',contract);
    expect(validateAssignment(task,f.review,assignment)).toBe(assignment);
    expect(contract.task).toEqual(task);
    expect(contract.requirements[0].text).toBe(task.check);
    expect(assignment.instructions).toContain(contract.executionInstructions);
  }
});

test('Korea lifecycle fills its released slot while Slovenia continues, with original dependency and review gates',()=>{
  const f=originalScopeFixture(['15-39','15-40','15-41']);
  expect(f.select()).toEqual(['15-39','15-41']);
  f.state.tasks['15-39'].status='pass';f.state.tasks['15-41'].status='running';
  expect(f.select({activeTaskIds:['15-41']})).toEqual(['15-41','15-40']);
  delete f.state.certificates.D;
  expect(f.select()).toEqual([]);
});

test('persisted broad assignments retain authority instead of being silently narrowed',()=>{
  const f=originalScopeFixture(['15-14','15-15']);
  f.state.tasks['15-14']={status:'running',assignment:{writablePaths:['src/lib/operational-cells','scripts/operational-cells']}};
  expect(f.select({activeTaskIds:['15-14']})).toEqual(['15-14']);
});

test.each([['15-14','15-15'],['15-39','15-41'],['15-40','15-41']])('actual isolated %s/%s writes merge in reverse completion order and reject shared runtime changes',(left,right)=>{
  const base=path.resolve('.tmp/parallel-scope-tests');fs.mkdirSync(base,{recursive:true});
  const root=fs.mkdtempSync(path.join(base,'case-'));
  onTestFinished(()=>{if(!root.startsWith(base+path.sep))throw Error('Unsafe fixture cleanup');fs.rmSync(root,{recursive:true,force:true});});
  const source=path.join(root,'source');fs.mkdirSync(path.join(source,'src/lib'),{recursive:true});
  fs.writeFileSync(path.join(source,'src/lib/shared-runtime.txt'),'unchanged prerequisite');
  const contracts=[left,right].map(id=>taskContract(originalPlan.tasks.find(t=>t.id===id),'fixture'));
  const workspaces=contracts.map((contract,index)=>prepareWorkspace(source,path.join(root,'reports',String(index)),contract,{controlRoot:root}));
  const changes=contracts.map((contract,index)=>{
    const name=contract.writablePaths[0]+'/branch.txt',file=path.join(workspaces[index].directory,name);
    fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,contract.taskId);
    return {name,index};
  });
  for(const change of changes.toReversed())applyWorkspaceMerge(planWorkspaceMerge(source,workspaces[change.index],contracts[change.index],[change.name]));
  for(const change of changes)expect(fs.readFileSync(path.join(source,change.name),'utf8')).toBe(contracts[change.index].taskId);
  fs.unlinkSync(path.join(workspaces[0].directory,changes[0].name));
  fs.writeFileSync(path.join(workspaces[0].directory,'src/lib/shared-runtime.txt'),'forbidden shared change');
  expect(()=>planWorkspaceMerge(source,workspaces[0],contracts[0],[])).toThrow(/outside assigned ownership/);
  expect(fs.readFileSync(path.join(source,'src/lib/shared-runtime.txt'),'utf8')).toBe('unchanged prerequisite');
});
