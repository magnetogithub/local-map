// Canonical Vitest suite; test bodies and assertions retained from the prior control suite.
import fs from 'node:fs';
import path from 'node:path';
import {test as vitestTest} from 'vitest';
const test=(name,body)=>vitestTest(name,context=>body({after:fn=>context.onTestFinished(fn)}),600000);
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';

for(const taskVerificationMode of [undefined,'controller-vitest'])test(`tested operating repair exits the old module graph and wrapper resumes same task with a fresh controller automatically (${taskVerificationMode??'legacy'})`,async t=>{
  const base=path.resolve('.tmp/guardian-reload-tests');fs.mkdirSync(base,{recursive:true});const root=fs.mkdtempSync(path.join(base,'case-')),scripts=path.join(root,'scripts/prompt15-orchestrator'),run=path.join(root,'reports/prompt15/orchestration/original-run');fs.mkdirSync(scripts,{recursive:true});fs.mkdirSync(run,{recursive:true});fs.mkdirSync(path.join(root,'tools'));
  for(const name of fs.readdirSync(new URL('.',import.meta.url)))if(name.endsWith('.mjs'))fs.copyFileSync(new URL(name,import.meta.url),path.join(scripts,name));
  fs.copyFileSync(path.resolve('tools/prompt15-runtime.mjs'),path.join(root,'tools/prompt15-runtime.mjs'));fs.mkdirSync(path.join(root,'automation/prompt15'),{recursive:true});fs.writeFileSync(path.join(root,'automation/prompt15/config.json'),JSON.stringify({implementationUnit:'task',executionMode:'orchestrated',boundProductTargets:false,taskVerificationMode}));
  fs.writeFileSync(path.join(root,'control-version.txt'),'1');fs.writeFileSync(path.join(run,'state.json'),JSON.stringify({status:'stopped',review:'A',projectRoot:root,tasks:{'15-01':{status:'implemented',attempt:2}},threads:{guardian:'retained-guardian'}}));
  fs.writeFileSync(path.join(scripts,'app-server.mjs'),'export class AppServer {async close(){}}\n');
  fs.writeFileSync(path.join(scripts,'task-workflow.mjs'),`import fs from 'node:fs';import path from 'node:path';import {atomicJSON} from './protocol.mjs';const loadedVersion=fs.readFileSync('control-version.txt','utf8');export class TaskWorkflow {constructor({directory}){this.directory=directory;this.state=JSON.parse(fs.readFileSync(path.join(directory,'state.json'),'utf8'));}save(){atomicJSON(path.join(this.directory,'state.json'),this.state);}async run(){fs.appendFileSync('loaded-versions.jsonl',JSON.stringify({version:loadedVersion,pid:process.pid})+'\\n');if(loadedVersion==='1'){fs.writeFileSync('control-version.txt','2');const error=Error('Tested repair applied');error.code='OPERATING_REPAIR_APPLIED';throw error;}this.state.status='standby';this.save();return this.state;}}`);
  const child=spawn(process.execPath,['tools/prompt15-runtime.mjs','resume','--run',run],{cwd:root,windowsHide:true,stdio:['ignore','ignore','pipe']});let errors='';child.stderr.on('data',value=>{errors+=value;});
  t.after(async()=>{if(child.exitCode===null){const closed=new Promise(resolve=>child.once('close',resolve));child.kill();await closed;}assert.ok(root.startsWith(base+path.sep));fs.rmSync(root,{recursive:true,force:true});});
  const exit=await Promise.race([new Promise(resolve=>child.once('close',resolve)),new Promise(resolve=>{const timer=setTimeout(()=>resolve('timeout'),15000);timer.unref();})]);assert.equal(exit,0,errors);
  const launches=fs.readFileSync(path.join(root,'loaded-versions.jsonl'),'utf8').trim().split('\n').map(line=>JSON.parse(line));assert.deepEqual(launches.map(item=>item.version),['1','2']);assert.notEqual(launches[0].pid,launches[1].pid);
  const state=JSON.parse(fs.readFileSync(path.join(run,'state.json'),'utf8'));assert.equal(state.status,'standby');assert.deepEqual(state.tasks,{'15-01':{status:'implemented',attempt:2}});assert.equal(state.threads.guardian,'retained-guardian');assert.equal(fs.existsSync(path.join(run,'retry.json')),false);
});
