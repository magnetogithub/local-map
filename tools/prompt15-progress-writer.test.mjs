import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {test,expect,onTestFinished} from 'vitest';
import {controllerOwnsProgress,taskProgressView} from './prompt15-monitor.mjs';

function fixture(){
  const base=path.resolve('reports/prompt15/orchestration');fs.mkdirSync(base,{recursive:true});
  const directory=fs.mkdtempSync(path.join(base,'progress-writer-test-'));
  onTestFinished(()=>{expect(directory.startsWith(base+path.sep)).toBe(true);fs.rmSync(directory,{recursive:true,force:true});});
  const state={implementationUnit:'task',taskVerificationMode:'controller-vitest',status:'running',phase:'implement',controllerPid:12345,heartbeatAt:'2000-01-01T00:00:00.000Z',threads:{supervisor:'s','implementer-15-08':'i'},guardian:{},activeTurns:{'implementer-15-08':{taskId:'15-08'}}};
  const stateFile=path.join(directory,'state.json'),progress=path.join(directory,'progress.txt'),events=path.join(directory,'events.jsonl');
  fs.writeFileSync(stateFile,JSON.stringify(state));fs.writeFileSync(progress,'Controller-owned header\n태스크 상태\n15-08 [running]\n');
  fs.writeFileSync(events,Array.from({length:6},(_,n)=>JSON.stringify({kind:'agent_message',phase:'commentary',threadId:'i',text:`bounded-message-${n}`,at:new Date(Date.UTC(2026,9,15,12,0,n)).toISOString()})).join('\n')+'\n');
  return{directory,state,stateFile,progress,events};
}

test('a live task controller owns progress through recovery and a stale heartbeat never transfers ownership',()=>{
  const base={implementationUnit:'task',controllerPid:12345,heartbeatAt:'2000-01-01T00:00:00.000Z'};
  for(const status of ['running','initializing','waiting_execution','waiting_recovery','waiting_input','recovering','blocked','reloading_orchestration'])expect(controllerOwnsProgress({...base,status},true)).toBe(true);
  for(const status of ['stopped','standby','manual_hold','completed'])expect(controllerOwnsProgress({...base,status},true)).toBe(false);
  expect(controllerOwnsProgress({...base,status:'running'},false)).toBe(false);
  expect(controllerOwnsProgress({...base,status:'running',controllerPid:undefined},true)).toBe(false);
  expect(controllerOwnsProgress({...base,status:'running',controllerPid:-1},true)).toBe(false);
});

test('observer updates only the message cache while a live controller writes progress',()=>{
  const f=fixture(),stateBefore=fs.readFileSync(f.stateFile,'utf8');
  for(let n=0;n<5;n++){
    const header=`Controller revision ${n}\n태스크 상태\n15-08 [running]\n`;fs.writeFileSync(f.progress,header);
    const view=taskProgressView(f.directory,{write:true,isAlive:pid=>{expect(pid).toBe(12345);return true;}});
    expect(view.controllerOwner).toBe(true);expect(view.progressWritten).toBe(false);expect(fs.readFileSync(f.progress,'utf8')).toBe(header);
    expect(view.text).toContain('bounded-message-5');
    const cache=JSON.parse(fs.readFileSync(view.cacheFile,'utf8'));
    expect(cache.sessions['implementer-15-08'].messages).toHaveLength(5);expect(cache.recentMessages).toHaveLength(5);
  }
  expect(fs.readFileSync(f.stateFile,'utf8')).toBe(stateBefore);
});

test('dead controller and stopped run allow bounded fallback rendering without state mutation',()=>{
  const f=fixture(),before=fs.readFileSync(f.stateFile,'utf8');
  let view=taskProgressView(f.directory,{write:true,isAlive:()=>false});
  expect(view.controllerOwner).toBe(false);expect(view.progressWritten).toBe(true);expect(fs.readFileSync(f.progress,'utf8')).toContain('bounded-message-5');expect(fs.readFileSync(f.stateFile,'utf8')).toBe(before);
  f.state.status='stopped';fs.writeFileSync(f.stateFile,JSON.stringify(f.state));fs.writeFileSync(f.progress,'Stopped controller header\n');const stoppedState=fs.readFileSync(f.stateFile,'utf8');
  view=taskProgressView(f.directory,{write:true,isAlive:()=>true});
  expect(view.controllerOwner).toBe(false);expect(view.progressWritten).toBe(true);expect(fs.readFileSync(f.progress,'utf8')).toContain('bounded-message-5');expect(fs.readFileSync(f.stateFile,'utf8')).toBe(stoppedState);
});

test('read-only observer does not publish cache or progress even when no controller exists',()=>{
  const f=fixture(),before=fs.readFileSync(f.progress,'utf8');
  const view=taskProgressView(f.directory,{write:false,isAlive:()=>false});
  expect(view.cacheWritten).toBe(false);expect(view.progressWritten).toBe(false);expect(fs.existsSync(view.cacheFile)).toBe(false);expect(fs.readFileSync(f.progress,'utf8')).toBe(before);
});

test('--once --write still renders a stopped run and exits without starting product controls',()=>{
  const f=fixture();f.state.status='stopped';delete f.state.controllerPid;fs.writeFileSync(f.stateFile,JSON.stringify(f.state));const before=fs.readFileSync(f.stateFile,'utf8');
  const result=spawnSync(process.execPath,['tools/prompt15-monitor.mjs','--run',f.directory,'--once','--write','--quiet'],{cwd:process.cwd(),windowsHide:true,encoding:'utf8',timeout:5000});
  expect(result.status,result.stderr).toBe(0);expect(fs.readFileSync(f.progress,'utf8')).toContain('bounded-message-5');expect(fs.readFileSync(f.stateFile,'utf8')).toBe(before);expect(fs.existsSync(path.join(f.directory,'controller.lock'))).toBe(false);
});
