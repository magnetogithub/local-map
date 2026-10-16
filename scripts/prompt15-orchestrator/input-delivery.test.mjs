import fs from 'node:fs';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {test,expect} from 'vitest';
import {AppServer} from './app-server.mjs';
import {taskInputEnvironment,runTargetChecks} from './run-target-checks.mjs';
import {captureProductTarget} from './product-target.mjs';
import {atomicJSON,fileIdentity} from './protocol.mjs';

test('frozen 15-06 and 15-07 consumers receive real context paths while JSON consumers retain their contract',async context=>{
  const base=path.resolve('.tmp/input-delivery-tests');fs.mkdirSync(base,{recursive:true});
  const root=fs.mkdtempSync(path.join(base,'case-'));context.onTestFinished(()=>{if(!root.startsWith(base+path.sep))throw Error('Unsafe fixture cleanup');fs.rmSync(root,{recursive:true,force:true});});
  const candidate=path.join(root,'reports/candidate'),report=path.join(root,'reports/verification');fs.mkdirSync(candidate,{recursive:true});fs.mkdirSync(report,{recursive:true});atomicJSON(path.join(candidate,'package.json'),{});
  const input=path.join(root,'reports/task-input-context.json');atomicJSON(input,{version:1,value:193});const pin=fileIdentity(root,input);
  const target=captureProductTarget(root,candidate,path.join(root,'reports/target'),{review:'A'});
  for(const taskId of ['15-06','15-07','15-03']){
    const job={root,taskId,taskInputContext:pin,productRoot:candidate,productTarget:target,reportDirectory:'reports/verification'};
    const env=taskInputEnvironment(root,job);expect(env.PROMPT15_TASK_INPUT_CONTEXT_PATH).toBe(input);expect(JSON.parse(env.PROMPT15_TASK_INPUT_CONTEXT_IDENTITY).sha256).toBe(pin.sha256);
    const file=path.join(report,`${taskId}.test.ts`),contextFile=path.join(report,`${taskId}-context.json`);atomicJSON(contextFile,job);
    fs.writeFileSync(file,`import fs from 'node:fs';import {test,expect} from 'vitest';test('actual frozen consumer',()=>{const raw=process.env.PROMPT15_TASK_INPUT_CONTEXT;const file=${taskId==='15-03'?'JSON.parse(raw).path':'raw'};expect(JSON.parse(fs.readFileSync(file,'utf8')).value).toBe(193);expect(file).toBe(process.env.PROMPT15_TASK_INPUT_CONTEXT_PATH);});`);
    const actual=await runTargetChecks(contextFile,path.join(report,`${taskId}-run`),[file]);expect(actual.pass,JSON.stringify(actual.tests)).toBe(true);
  }
  fs.appendFileSync(input,' ');expect(()=>taskInputEnvironment(root,{taskId:'15-07',taskInputContext:pin})).toThrow(/changed/);
},60000);

test('native start acknowledgement persists identity even without a turn-start notification',async()=>{
  const server=new EventEmitter();Object.setPrototypeOf(server,AppServer.prototype);Object.assign(server,{active:new Map(),log(){},turnTimeoutMs:5000});
  let persisted;
  server.request=async method=>{
    expect(method).toBe('turn/start');
    setTimeout(()=>server.receive({method:'turn/completed',params:{threadId:'owned-thread',turn:{id:'exact-native-turn',status:'completed',items:[{type:'agentMessage',text:'{"ok":true}'}]}}}),10);
    return {turn:{id:'exact-native-turn'}};
  };
  const result=await server.runTurn('owned-thread','original request',{type:'object'},{},{onStarted:value=>{persisted=value;}});
  expect(persisted).toEqual({threadId:'owned-thread',turnId:'exact-native-turn'});expect(result.value).toEqual({ok:true});expect(server.active.size).toBe(0);
});

test('a fast completion cannot hide a failure to persist the native start identity',async()=>{
  const server=new EventEmitter();Object.setPrototypeOf(server,AppServer.prototype);Object.assign(server,{active:new Map(),log(){},turnTimeoutMs:5000});
  server.request=async method=>{
    if(method==='turn/interrupt')return{};
    server.receive({method:'turn/completed',params:{threadId:'owned-thread',turn:{id:'exact-native-turn',status:'completed',items:[{type:'agentMessage',text:'{"ok":true}'}]}}});
    return {turn:{id:'exact-native-turn'}};
  };
  await expect(server.runTurn('owned-thread','original request',{type:'object'},{},{onStarted(){throw Error('Start identity persistence failed');}})).rejects.toThrow('Start identity persistence failed');
  expect(server.active.size).toBe(0);
});
