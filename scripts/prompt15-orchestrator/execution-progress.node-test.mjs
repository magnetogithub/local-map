import test from 'node:test';
import assert from 'node:assert/strict';
import {ExecutionProgress} from './execution-progress.mjs';
import {AppServer} from './app-server.mjs';
import fs from 'node:fs';
import path from 'node:path';
test('reasoning and heartbeat never reset the execution idle deadline',()=>{
  const progress=new ExecutionProgress(0);
  progress.receive('item/completed',{type:'reasoning',id:'thought'},899999);
  progress.receive('turn/started',undefined,899999);
  assert.equal(progress.isIdle(900000,900000),true);
});
test('a running command is not idle; completed commands restart the idle deadline',()=>{
  const progress=new ExecutionProgress(0),item={type:'commandExecution',id:'command'};
  progress.receive('item/started',item,100);
  assert.equal(progress.isIdle(1800000,900000),false);
  progress.receive('item/completed',item,1800000);
  assert.equal(progress.isIdle(2699999,900000),false);
  assert.equal(progress.isIdle(2700000,900000),true);
});

test('a lost tool completion cannot waive the execution watchdog forever',()=>{
  const progress=new ExecutionProgress(0);progress.receive('item/started',{type:'commandExecution',id:'lost-tool'},100);
  assert.equal(progress.isIdle(3599999,900000),false);
  assert.equal(progress.isIdle(3600100,900000),true);
});
test('idle verifier interrupts its exact owned turn despite continuing reasoning events',async()=>{
  const directory=fs.mkdtempSync(path.resolve('.tmp/prompt15-idle-'));
  const script=path.join(directory,'server.mjs');
  fs.writeFileSync(script,[
    "import {createInterface} from 'node:readline';",
    "const send=value=>process.stdout.write(JSON.stringify(value)+'\\n'); let receipt=null, timer;",
    "const lines=createInterface({input:process.stdin}); lines.on('close',()=>clearInterval(timer));",
    "lines.on('line',line=>{const m=JSON.parse(line);",
    "if(m.method==='initialize')send({id:m.id,result:{}});",
    "if(m.method==='turn/start'){send({id:m.id,result:{turn:{id:'owned-turn',status:'inProgress'}}}); timer=setInterval(()=>send({method:'item/completed',params:{threadId:'owned-thread',item:{type:'reasoning',id:'thought'}}}),10);}",
    "if(m.method==='turn/interrupt'){receipt=m.params;clearInterval(timer);send({id:m.id,result:{}});}",
    "if(m.method==='receipt/read')send({id:m.id,result:receipt});});",
  ].join('\n'));
  const client=new AppServer({binary:process.execPath,cwd:directory,serverArgs:[script],requestTimeoutMs:1000,turnTimeoutMs:2000});
  try{
    await client.initialize();
    await assert.rejects(client.runTurn('owned-thread','verify',{}, {},{executionIdleTimeoutMs:100}),/execution idle timeout/);
    assert.deepEqual(await client.request('receipt/read',{}),{threadId:'owned-thread',turnId:'owned-turn'});
    assert.equal(client.active.size,0);
  }finally{await client.close();}
});
