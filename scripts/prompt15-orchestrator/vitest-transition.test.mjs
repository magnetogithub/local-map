import {test,expect,onTestFinished} from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {fileIdentity} from './protocol.mjs';
import {reconcileLegacyVitestTurn} from './vitest-transition.mjs';
import {captureProductTarget} from './product-target.mjs';
import {TaskWorkflow} from './task-workflow.mjs';

function fixture(){
  const base=path.resolve('.tmp/vitest-transition-tests');fs.mkdirSync(base,{recursive:true});const root=fs.mkdtempSync(path.join(base,'case-')),directory=path.join(root,'attempt/verification'),report=path.join(root,'attempt/verification-vitest-001');fs.mkdirSync(directory,{recursive:true});
  onTestFinished(()=>{expect(root.startsWith(base+path.sep)).toBe(true);fs.rmSync(root,{recursive:true,force:true});});
  const productRoot=path.join(root,'candidate');fs.mkdirSync(path.join(productRoot,'src'),{recursive:true});fs.writeFileSync(path.join(productRoot,'package.json'),'{}');fs.writeFileSync(path.join(productRoot,'src/base.txt'),'immutable');
  const target=captureProductTarget(root,productRoot,path.join(root,'reports/target'),{review:'A'});
  const request={role:'verifier',key:'verifier-0',taskId:'15-01',review:'A',cwd:target.productRoot},requestFile=path.join(directory,'request.json');fs.writeFileSync(requestFile,JSON.stringify(request));
  const dispatch={threadId:'legacy-thread',turnId:'exact-turn',cwd:target.productRoot,requestIdentity:fileIdentity(root,requestFile)};fs.writeFileSync(path.join(directory,'dispatch.json'),JSON.stringify(dispatch));
  const calls=[],checks=[],history={thread:{id:'legacy-thread',turns:[{id:'exact-turn',status:'interrupted'}]}};
  const args={root,directory,report,taskId:'15-01',review:'A',target,server:{async request(method,params){calls.push({method,params});return history;}},validateTarget:(...input)=>checks.push(input)};
  return{args,calls,checks,history,request,requestFile,dispatch};
}

test('only a live exact interrupted legacy turn permits the Vitest transition',async t=>{
  const f=fixture(t);expect(await reconcileLegacyVitestTurn(f.args)).toBe(true);expect(f.calls).toEqual([{method:'thread/read',params:{threadId:'legacy-thread',includeTurns:true}}]);expect(f.checks).toHaveLength(2);
  const receipt=JSON.parse(fs.readFileSync(path.join(f.args.report,'legacy-turn-transition.json'),'utf8'));expect(receipt).toMatchObject({status:'interrupted',targetId:f.args.target.targetId,productVerdictIssued:false,newFramework:'vitest'});expect(fs.existsSync(path.join(f.args.directory,'response.json'))).toBe(false);expect(await reconcileLegacyVitestTurn(f.args)).toBe(true);
});

test.each(['inProgress','completed','failed'])('legacy status %s remains held without a confirmed response',async status=>{
  const f=fixture();f.history.thread.turns[0].status=status;expect(await reconcileLegacyVitestTurn(f.args)).toBe(false);expect(fs.existsSync(f.args.report)).toBe(false);
});

test('a different interrupted turn cannot certify the recorded dispatch',async t=>{
  const f=fixture(t);f.history.thread.turns[0].id='another-turn';expect(await reconcileLegacyVitestTurn(f.args)).toBe(false);
});

test('changed original instructions cannot be reconciled by a terminal status',async t=>{
  const f=fixture(t);fs.appendFileSync(f.requestFile,' ');await expect(reconcileLegacyVitestTurn(f.args)).rejects.toThrow();expect(f.calls).toHaveLength(0);
});

test('an existing response is retained for normal response attestation',async t=>{
  const f=fixture(t);fs.writeFileSync(path.join(f.args.directory,'response.json'),'{}');expect(await reconcileLegacyVitestTurn(f.args)).toBe(false);expect(f.calls).toHaveLength(0);
});

test('Vitest dispatches cannot use the legacy migration to replay an interrupted run',async t=>{
  const f=fixture(t);f.args.directory=path.join(path.dirname(f.args.directory),'verification-vitest-000');expect(await reconcileLegacyVitestTurn(f.args)).toBe(false);expect(f.calls).toHaveLength(0);
});

function workflow(f){
  const row={attemptDirectory:path.dirname(f.args.directory),target:f.args.target};
  return Object.assign(Object.create(TaskWorkflow.prototype),{root:f.args.root,config:{verificationFramework:'vitest'},state:{review:'A',tasks:{'15-01':row}},server:f.args.server,save(){},event(){}});
}

test('actual controller records the interrupted legacy transition before dispatch',async t=>{
  const f=fixture(t),control=workflow(f);await control.reconcileVerificationDispatches({id:'15-01'},f.args.report);
  expect(control.state.tasks['15-01'].verificationTransition.sha256).toHaveLength(64);expect(f.calls).toHaveLength(1);expect(fs.existsSync(path.join(f.args.directory,'response.json'))).toBe(false);
});

test('actual controller holds a still running legacy verifier during Vitest migration',async t=>{
  const f=fixture(t);f.history.thread.turns[0].status='inProgress';await expect(workflow(f).reconcileVerificationDispatches({id:'15-01'},f.args.report)).rejects.toThrow('no certified response');expect(fs.existsSync(f.args.report)).toBe(false);
});
