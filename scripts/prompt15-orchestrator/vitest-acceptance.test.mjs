import {test,expect} from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {attestVitest,applyVitestResult} from './vitest-acceptance.mjs';
import {fileIdentity} from './protocol.mjs';
import {identity} from './verification-stages.mjs';

async function fixture(t){
  const base=path.resolve('.tmp/vitest-acceptance-tests');fs.mkdirSync(base,{recursive:true});const root=fs.mkdtempSync(path.join(base,'case-')),report=path.join(root,'report'),productRoot=path.join(root,'candidate');fs.mkdirSync(report);fs.mkdirSync(productRoot);
  t.onTestFinished(()=>{expect(root.startsWith(base+path.sep)).toBe(true);fs.rmSync(root,{recursive:true,force:true});});
  const context={root,reportDirectory:'report',productRoot,productTarget:{targetId:'exact-target'}},contextFile=path.join(report,'context.json');fs.writeFileSync(contextFile,JSON.stringify(context));
  const suite=path.join(report,'real.test.mjs');fs.writeFileSync(suite,"import {test,expect} from 'vitest';test('actual condition',()=>expect(2+2).toBe(4));\n");
  const output=path.join(report,'verifier-run');fs.mkdirSync(output);fs.writeFileSync(path.join(output,'test-inputs.json'),JSON.stringify({inputs:[await identity(suite)]}));
  const result={kind:'vitest-bound-target',targetId:'exact-target',productRoot,command:[process.execPath,path.resolve('node_modules/vitest/vitest.mjs'),'run'],inputsUnchanged:true,allFilesExecuted:true,tests:{complete:true,files:[suite],counts:{total:1,passed:1,failed:0,errors:0},pass:true},pass:true},resultFile=path.join(output,'result.json');fs.writeFileSync(resultFile,JSON.stringify(result));
  const assessment={verdict:'pass',nonPassKind:'none',summary:'verifier assertion',evidence:[fileIdentity(root,resultFile)],checks:[{id:'prompt_instructions',status:'pass',evidencePaths:[],detail:'verified'}],failures:[]};
  const rewrite=value=>{fs.writeFileSync(resultFile,JSON.stringify(value));assessment.evidence=[fileIdentity(root,resultFile)];};
  return{root,contextFile,suite,result,assessment,rewrite,async run(contextPath,destination,selected){expect(contextPath).toBe(contextFile);expect(selected).toEqual([suite]);fs.mkdirSync(destination);fs.writeFileSync(path.join(destination,'result.json'),JSON.stringify(result));fs.writeFileSync(path.join(destination,'test-inputs.json'),'{}');return result;}};
}
test('custom CLI counts or logs cannot certify any product verdict without Vitest',async t=>{
  const f=await fixture(t);f.assessment.evidence=[];await expect(attestVitest(f.root,f.contextFile,f.assessment,{run:f.run})).rejects.toThrow('Vitest is mandatory');
});
test('Vitest result must bind the exact candidate and target',async t=>{
  const f=await fixture(t);f.rewrite({...f.result,targetId:'another-target'});await expect(attestVitest(f.root,f.contextFile,f.assessment,{run:f.run})).rejects.toThrow('exact');
});
test('the exact executed Vitest source must remain unchanged',async t=>{
  const f=await fixture(t);fs.appendFileSync(f.suite,'// changed after execution');await expect(attestVitest(f.root,f.contextFile,f.assessment,{run:f.run})).rejects.toThrow('changed after execution');
});
test('a custom Node invocation cannot be relabelled as a Vitest receipt',async t=>{
  const f=await fixture(t);f.rewrite({...f.result,command:[process.execPath,'audit.mjs']});await expect(attestVitest(f.root,f.contextFile,f.assessment,{run:f.run})).rejects.toThrow('real Vitest invocation');
});
test('controller independently executes pinned Vitest tests before retaining PASS',async t=>{
  const f=await fixture(t),attestation=await attestVitest(f.root,f.contextFile,f.assessment,{run:f.run});expect(attestation.selected).toEqual([f.suite]);expect(attestation.evidence).toHaveLength(2);expect(applyVitestResult(f.assessment,attestation).verdict).toBe('pass');
});

test('controller preserves jsdom instead of rerunning a UI suite in node',async t=>{
  const f=await fixture(t);f.rewrite({...f.result,environment:'jsdom'});const calls=[];
  const value=await attestVitest(f.root,f.contextFile,f.assessment,{run:async(...args)=>{calls.push(args[3]);return f.run(...args);}});
  expect(calls).toEqual([{environment:'jsdom'}]);expect(value.result.pass).toBe(true);
});

test('mixed node and jsdom receipts execute separately and both must pass',async t=>{
  const f=await fixture(t),output=path.join(f.root,'report/verifier-dom');fs.mkdirSync(output);
  fs.writeFileSync(path.join(output,'test-inputs.json'),JSON.stringify({environment:'jsdom',inputs:[await identity(f.suite)]}));
  const resultFile=path.join(output,'result.json');fs.writeFileSync(resultFile,JSON.stringify({...f.result,environment:'jsdom'}));f.assessment.evidence.push(fileIdentity(f.root,resultFile));
  const calls=[];const value=await attestVitest(f.root,f.contextFile,f.assessment,{run:async(...args)=>{calls.push(args[3]);const result=await f.run(...args);return args[3].environment==='jsdom'?{...result,pass:false,tests:{...result.tests,counts:{total:1,passed:0,failed:1,errors:0}}}:result;}});
  expect(calls).toEqual([{environment:'node'},{environment:'jsdom'}]);expect(value.result.pass).toBe(false);expect(value.result.tests.counts).toMatchObject({total:2,passed:1,failed:1});expect(value.evidence).toHaveLength(4);
});

test('unknown execution environments cannot certify PASS',async t=>{
  const f=await fixture(t);f.rewrite({...f.result,environment:'unknown'});await expect(attestVitest(f.root,f.contextFile,f.assessment,{run:f.run})).rejects.toThrow('environment');
});
test('actual Vitest failures override a claimed PASS with a reproduced product failure',()=>{
  const value=applyVitestResult({verdict:'pass',evidence:[],checks:[],failures:[]},{evidence:[],result:{pass:false,tests:{complete:true,counts:{failed:1,errors:0},failures:[{name:'real assertion',message:'actual != expected'}]}}});expect(value.verdict).toBe('fail');expect(value.nonPassKind).toBe('implementation');
});
test('reported FAIL without a failing Vitest cannot add a product strike',()=>{
  const value=applyVitestResult({verdict:'fail',evidence:[],checks:[],failures:[]},{evidence:[],result:{pass:true,tests:{complete:true,counts:{failed:0,errors:0}}}});expect(value.verdict).toBe('blocked');expect(value.nonPassKind).toBe('environment');
});
test('genuine environment BLOCKED cannot be converted to a PASS by absent tests',async t=>{
  const f=await fixture(t);f.assessment.verdict='blocked';expect(await attestVitest(f.root,f.contextFile,f.assessment)).toBeNull();expect(applyVitestResult(f.assessment,null).verdict).toBe('blocked');
});
