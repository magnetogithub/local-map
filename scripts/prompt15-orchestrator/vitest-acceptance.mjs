import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {fileIdentity,resolveInside,validateIdentities} from './protocol.mjs';
import {identity} from './verification-stages.mjs';

const read=file=>JSON.parse(fs.readFileSync(file,'utf8'));
export async function validateAttestedVitestInputs(root,assessment){
  validateIdentities(root,[...assessment.inputs,...assessment.evidence]);
  for(const pin of assessment.evidence){
    if(!pin.path.replaceAll('\\','/').endsWith('/test-inputs.json'))continue;
    const manifest=read(resolveInside(root,pin.path));
    if(!Array.isArray(manifest.inputs))throw Error('Cached Vitest attestation lacks executed inputs');
    for(const input of manifest.inputs){
      const actual=await identity(input.path);
      if(actual.sha256!==input.sha256||actual.byteLength!==input.byteLength)throw Error('Cached Vitest attestation input changed');
    }
  }
}
// The controller executes Vitest itself. A model-written summary or a custom
// audit CLI's exit code cannot issue a product PASS or a product failure strike.
export async function attestVitest(root,contextFile,assessment,{run}={}){
  if(assessment.verdict==='blocked')return null;
  const context=read(contextFile),report=resolveInside(root,context.reportDirectory),receipts=[];
  for(const pin of assessment.evidence??[]){
    const file=resolveInside(root,pin.path);if(!file.endsWith('.json'))continue;
    let value;try{value=read(file);}catch{continue;}
    if(value.kind!=='vitest-bound-target')continue;
    validateIdentities(root,[pin]);
    if(!/[\\/]vitest[\\/]vitest\.mjs$/.test(value.command?.[1]??'')||value.command?.[2]!=='run')throw Error('Vitest evidence must identify the real Vitest invocation');
    if(value.targetId!==context.productTarget.targetId||path.resolve(value.productRoot)!==path.resolve(context.productRoot)||!value.tests?.complete||!value.tests.files?.length||value.inputsUnchanged!==true||value.allFilesExecuted!==true)throw Error('Vitest evidence does not bind to the exact completed target run');
    const manifest=read(path.join(path.dirname(file),'test-inputs.json'));
    for(const selected of value.tests.files){
      const source=resolveInside(root,selected),expected=manifest.inputs?.find(input=>path.resolve(input.path).toLowerCase()===fs.realpathSync(source).toLowerCase());
      if(!expected)throw Error('Vitest test source is missing its executed input identity');
      const actual=await identity(fs.realpathSync(source));if(actual.sha256!==expected.sha256||actual.byteLength!==expected.byteLength)throw Error('Vitest test source changed after execution');
      const text=fs.readFileSync(source,'utf8');
      if(!/from\s*['"]vitest['"]|import\s*\(\s*['"]vitest['"]\s*\)/.test(text)||/from\s*['"]node:test['"]/.test(text))throw Error('Vitest acceptance requires actual Vitest test sources');
    }
    const environment=value.environment??'node';
    if(!['node','jsdom'].includes(environment))throw Error('Unsupported Vitest execution environment');
    if(manifest.environment&&manifest.environment!==environment)throw Error('Vitest execution environment differs from its input manifest');
    receipts.push({...value,environment});
  }
  if(!receipts.length)throw Error('Vitest is mandatory: custom CLI/log summaries cannot certify this verification');
  const selected=[...new Set(receipts.flatMap(receipt=>receipt.tests.files))],results=[],evidence=[];
  if(!run)({runTargetChecks:run}=await import('./run-target-checks.mjs'));
  for(const environment of new Set(receipts.map(receipt=>receipt.environment))){
    const files=[...new Set(receipts.filter(receipt=>receipt.environment===environment).flatMap(receipt=>receipt.tests.files))];
    const output=path.join(report,`controller-vitest-${randomUUID().slice(0,8)}`);
    results.push(await run(contextFile,output,files,{environment}));
    evidence.push(fileIdentity(root,path.join(output,'result.json')),fileIdentity(root,path.join(output,'test-inputs.json')));
  }
  const result=results.length===1?results[0]:{
    pass:results.every(value=>value.pass===true),
    tests:{complete:results.every(value=>value.tests?.complete===true),
      counts:Object.fromEntries(['passed','failed','skipped','pending','total','errors'].map(key=>[key,results.reduce((sum,value)=>sum+(value.tests?.counts?.[key]??0),0)])),
      failures:results.flatMap(value=>value.tests?.failures??[])},
  };
  return{result,evidence,selected};
}
export function applyVitestResult(assessment,attestation){
  if(!attestation)return assessment;
  const value=structuredClone(assessment),actual=attestation.result;
  value.verificationFramework='vitest';value.evidence.push(...attestation.evidence);
  if(actual.pass===true&&value.verdict==='pass')return value;
  const reproduced=actual.pass===false&&actual.tests?.complete===true&&actual.tests.counts?.failed>0&&!actual.tests.counts.errors;
  value.verdict=reproduced?'fail':'blocked';value.nonPassKind=reproduced?'implementation':'environment';
  const reason=reproduced?'Controller Vitest execution failed actual assertions':'Vitest did not certify the requested verdict; tool completion or reproduced failing tests are required';
  value.summary=reason;value.failures=[reason,...(actual.tests?.failures??[]).map(f=>`${f.name}: ${f.message}`)];
  value.checks=value.checks.map(check=>({...check,status:value.verdict,evidencePaths:[...check.evidencePaths,...attestation.evidence.map(pin=>pin.path)],detail:reason}));
  return value;
}
