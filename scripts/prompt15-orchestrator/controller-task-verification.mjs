import fs from 'node:fs';
import path from 'node:path';
import {atomicJSON,fileIdentity,validateIdentities,resolveInside,inside,TASK_GATES} from './protocol.mjs';
import {digest,validateProductTarget} from './product-target.mjs';
import {runTargetChecks} from './run-target-checks.mjs';
import {identity} from './verification-stages.mjs';
import {validateImplementationInputRoles} from './task-inputs.mjs';

const read=file=>JSON.parse(fs.readFileSync(file,'utf8'));
function regular(root,file){
  const resolved=resolveInside(root,file);
  if(!inside(root,resolved)||!fs.lstatSync(resolved).isFile()||fs.realpathSync(resolved).toLowerCase()!==resolved.toLowerCase())throw Error('Acceptance files must be regular files in their declared directory');
  return resolved;
}
function localFile(base,name){
  if(typeof name!=='string'||path.isAbsolute(name)||/[\\:*?{}\[\]!]/.test(name)||name.split('/').some(p=>!p||p==='.'||p==='..'))throw Error('Invalid exact acceptance file path');
  return regular(base,path.join(base,name));
}

// The first suite is pinned in a controller-owned directory. A repair may change
// product code, but it cannot turn a failing assertion into a passing criterion.
export function selectedHarnessRevisionFile(root,taskDirectory){
  const directory=path.join(taskDirectory,'acceptance-suite'),selection=path.join(directory,'harness-selection.json');
  if(fs.existsSync(selection)){
    const receipt=read(selection);validateIdentities(root,[receipt.revision]);
    const file=resolveInside(root,receipt.revision.path);
    if(receipt.kind!=='controller-harness-selection'||path.dirname(file)!==path.resolve(directory)||!/^harness-revision-[0-9]+\.json$/.test(path.basename(file)))throw Error('Invalid versioned harness selection');
    return file;
  }
  const legacy=path.join(directory,'harness-revision.json');return fs.existsSync(legacy)?legacy:null;
}
export function frozenAcceptanceSuite(root,taskDirectory){
  const file=path.join(taskDirectory,'acceptance-suite/frozen.json');if(!fs.existsSync(file))return null;
  const frozen=read(file);validateIdentities(root,[frozen.suite]);let receipt=read(resolveInside(root,frozen.suite.path));validateIdentities(root,receipt.inputs);
  const revisionFile=selectedHarnessRevisionFile(root,taskDirectory);
  if(revisionFile){
    const revision=read(revisionFile);validateIdentities(root,[revision.originalFrozen,revision.originalSuite,revision.authorization,revision.suite]);
    if(revision.kind!=='controller-authorized-harness-repair'||digest(revision.originalFrozen)!==digest(fileIdentity(root,file))||digest(revision.originalSuite)!==digest(frozen.suite))throw Error('Harness revision must preserve its original frozen suite');
    const authorization=read(resolveInside(root,revision.authorization.path));
    if(authorization.kind!=='explicit-user-harness-repair'||authorization.taskId!==receipt.taskId||!authorization.reason?.trim())throw Error('Harness revision lacks explicit task-bound authorization');
    const selected=read(resolveInside(root,revision.suite.path));
    if(!inside(path.join(taskDirectory,'harness-revisions'),resolveInside(root,revision.suite.path))||selected.taskId!==receipt.taskId||selected.contractDigest!==receipt.contractDigest||digest(selected.requirements)!==digest(receipt.requirements))throw Error('Harness repair cannot change product requirements');
    validateIdentities(root,selected.inputs);receipt=selected;
  }
  return receipt;
}
export function freezeAcceptanceSuite(root,taskDirectory,candidateRoot,planFile,contract,{planRoot=path.join(candidateRoot,'.reports'),prepareOnly=false}={}){
  const frozen=prepareOnly?null:frozenAcceptanceSuite(root,taskDirectory);
  if(frozen){
    if(frozen.contractDigest!==contract.contractDigest)throw Error('Frozen suite belongs to another acceptance contract');
    return frozen;
  }
  planFile=regular(planRoot,planFile);const base=path.dirname(planFile),plan=read(planFile);
  if(plan.version!==1||plan.taskId!==contract.taskId||plan.contractDigest!==contract.contractDigest||!Array.isArray(plan.groups)||!plan.groups.length||plan.groups.length>4||!Array.isArray(plan.supportFiles))throw Error('Implementation must supply a complete task-bound Vitest test plan');
  const names=new Set(plan.supportFiles);
  for(const group of plan.groups){
    if(!['node','jsdom'].includes(group.environment)||!Array.isArray(group.files)||!group.files.length)throw Error('Invalid acceptance test group');
    for(const name of group.files){
      const source=localFile(base,name),text=fs.readFileSync(source,'utf8');
      if(!/\.test\.[cm]?[jt]sx?$/.test(name)||!/from\s*['"]vitest['"]/.test(text)||/from\s*['"]node:test['"]/.test(text))throw Error('Real Vitest test/expect sources required');
      names.add(name);
    }
  }
  if(names.size>80)throw Error('Acceptance suite exceeds explicit file budget');
  let bytes=0;const files=[...names].map(name=>{const source=localFile(base,name);bytes+=fs.statSync(source).size;return{name,source,pin:fileIdentity(root,source)};});
  if(bytes>8*1024*1024)throw Error('Acceptance suite exceeds byte budget');
  for(const {source}of files.filter(file=>/\.[cm]?[jt]sx?$/.test(file.name))){
    const text=fs.readFileSync(source,'utf8');
    if(text.replaceAll('\\','/').includes(path.resolve(root).replaceAll('\\','/')))throw Error('Acceptance tests must use candidate aliases/environment, not a fixed control-root path');
    for(const [,specifier]of text.matchAll(/(?:from\s*|import\s*\(\s*|require\s*\(\s*)['"]([^'"]+)['"]/g)){
      if(path.isAbsolute(specifier)||/^(?:[A-Za-z]:|file:)/.test(specifier))throw Error('Absolute product imports cannot be frozen across repair candidates');
      if(!specifier.startsWith('.'))continue;
      const resolved=path.resolve(path.dirname(source),specifier),candidates=[resolved,...['.ts','.tsx','.js','.mjs','.mts','.json','/index.ts','/index.js'].map(ext=>resolved+ext)];
      if(!candidates.some(file=>files.some(entry=>entry.source===file)))throw Error('Relative test imports must belong to declared supportFiles');
    }
  }
  const revision=digest({plan:fileIdentity(root,planFile),files:files.map(f=>f.pin)}).slice(0,24),directory=path.join(taskDirectory,'acceptance-preparations',revision),receiptFile=path.join(directory,'suite.json');
  if(fs.existsSync(receiptFile)){const receipt=read(receiptFile);validateIdentities(root,receipt.inputs);return receipt;}
  // Validate everything before creating a durable suite, so a malformed plan can
  // be corrected without destroying or overwriting a partially accepted suite.
  fs.mkdirSync(directory,{recursive:true});
  for(const {name,source,pin}of files){const target=path.join(directory,'files',name);fs.mkdirSync(path.dirname(target),{recursive:true});if(!fs.existsSync(target))fs.copyFileSync(source,target,fs.constants.COPYFILE_EXCL);else if(fileIdentity(root,target).sha256!==pin.sha256)throw Error('Interrupted suite copy differs from its original test source');}
  const receipt={version:1,taskId:contract.taskId,contractDigest:contract.contractDigest,groups:plan.groups,requirements:contract.requirements,
    inputs:files.map(({name})=>fileIdentity(root,path.join(directory,'files',name))),files:[...names],directory:path.join(directory,'files'),receiptFile};
  atomicJSON(receiptFile,receipt);return receipt;
}

export function promoteAcceptanceSuite(root,taskDirectory,suite,evidence){
  validateIdentities(root,suite.inputs);const file=path.join(taskDirectory,'acceptance-suite/frozen.json'),record={version:1,contractDigest:suite.contractDigest,suite:fileIdentity(root,suite.receiptFile),evidence};
  if(fs.existsSync(file)){const prior=read(file);if(prior.suite.sha256!==record.suite.sha256){const authorized=frozenAcceptanceSuite(root,taskDirectory);if(digest(authorized)!==digest(suite))throw Error('Cannot replace an accepted suite');}return;}
  atomicJSON(file,record);
}

export async function verifyControllerTask({root,report,task,row,contract,suite,run=runTargetChecks,onExecution=()=>{}}){
  fs.mkdirSync(report,{recursive:true});validateIdentities(root,suite.inputs);validateImplementationInputRoles(root,row.target,validateProductTarget(root,row.target));
  const context={version:1,jobId:`controller-${task.id}-${row.attempt}`,taskId:task.id,review:contract.review,root,reportDirectory:path.relative(root,report).replaceAll('\\','/'),productRoot:row.target.productRoot,productTarget:row.target,requiredGates:TASK_GATES,verificationFramework:'vitest',executionCwd:'candidate',timeoutMs:contract.review==='C'?3600000:600000};
  if(row.inputContext){validateIdentities(root,[row.inputContext]);context.taskInputContext=row.inputContext;}
  const copied=path.join(report,'suite');
  for(const name of suite.files){const target=path.join(copied,name),source=path.join(suite.directory,name);fs.mkdirSync(path.dirname(target),{recursive:true});if(!fs.existsSync(target))fs.copyFileSync(source,target,fs.constants.COPYFILE_EXCL);else if(fileIdentity(root,source).sha256!==fileIdentity(root,target).sha256)throw Error('Frozen acceptance test changed in report');}
  context.supportInputs=suite.files.map(name=>fileIdentity(root,path.join(copied,name)));
  const contextFile=path.join(report,'job-context.json');if(!fs.existsSync(contextFile))atomicJSON(contextFile,context);else if(digest(read(contextFile))!==digest(context))throw Error('Controller test context changed');
  const results=[],evidence=[fileIdentity(root,contextFile),...suite.inputs],commands=[];
  for(const [index,group]of suite.groups.entries()){
    const pointer=path.join(report,`group-${index+1}.json`);let result,receiptFile,resultFile;
    if(fs.existsSync(pointer)){
      const pin=read(pointer).receipt;validateIdentities(root,[pin]);receiptFile=resolveInside(root,pin.path);
      const receipt=read(receiptFile);validateIdentities(root,[receipt.result]);
      if(receipt.contextDigest!==digest(context)||receipt.suiteDigest!==digest(suite))throw Error('Controller execution receipt does not match frozen inputs');
      let unchanged=true;
      for(const input of receipt.inputs){try{const actual=await identity(input.path);if(actual.sha256!==input.sha256||actual.byteLength!==input.byteLength)unchanged=false;}catch{unchanged=false;}}
      const completed=read(resolveInside(root,receipt.result.path));
      if(unchanged&&completed.tests?.complete&&!completed.tests?.counts?.errors&&!completed.execution?.timedOut&&completed.inputsUnchanged&&completed.allFilesExecuted){result=completed;resultFile=resolveInside(root,receipt.result.path);}
    }
    if(!result){
      const output=path.join(report,`group-${index+1}-${Date.now()}`);
      result=await run(contextFile,output,group.files.map(name=>path.join(copied,name)),{environment:group.environment,onStart:pid=>onExecution({pid,timeoutMs:context.timeoutMs})});
      resultFile=path.join(output,'result.json');receiptFile=path.join(output,'controller-receipt.json');
      const inputs=read(path.join(output,'test-inputs.json')).inputs;
      atomicJSON(receiptFile,{version:1,contextDigest:digest(context),suiteDigest:digest(suite),result:fileIdentity(root,resultFile),inputs});
      atomicJSON(pointer,{version:1,receipt:fileIdentity(root,receiptFile)});
    }
    results.push(result);evidence.push(fileIdentity(root,resultFile),fileIdentity(root,receiptFile));
    commands.push({command:result.command.join(' '),exitCode:result.execution.exitCode,evidencePath:fileIdentity(root,resultFile).path});
  }
  validateIdentities(root,suite.inputs);validateImplementationInputRoles(root,row.target,validateProductTarget(root,row.target));
  const cases=results.flatMap(r=>r.tests?.cases??[]),missing=contract.requirements.filter(requirement=>!cases.some(test=>['passed','failed'].includes(test.state)&&test.name.includes(requirement.id)));
  const complete=results.every(r=>r.tests?.complete===true&&r.inputsUnchanged&&r.allFilesExecuted&&!r.execution?.timedOut),actualFailures=results.some(r=>r.tests?.counts?.failed>0)&&results.every(r=>!r.tests?.counts?.errors);
  const contextDeliveryFailure=Boolean(row.inputContext&&results.some(r=>r.tests?.failures?.some(f=>f.message.includes('ENOENT')&&f.message.includes('{"path":')&&f.message.includes(`"sha256":"${row.inputContext.sha256}"`)&&f.message.includes(`"byteLength":${row.inputContext.byteLength}`))));
  const preparationComplete=complete&&!missing.length&&!contextDeliveryFailure&&results.every(r=>!r.tests?.counts?.errors);
  if(preparationComplete)promoteAcceptanceSuite(root,path.dirname(path.dirname(path.dirname(suite.receiptFile))),suite,evidence.filter(pin=>pin.path.endsWith('/result.json')));
  const passed=complete&&results.every(r=>r.pass)&&!missing.length;
  const verdict=passed?'pass':preparationComplete&&actualFailures?'fail':'blocked',nonPassKind=passed?'none':verdict==='fail'?'implementation':'environment';
  const failures=passed?[]:[...results.flatMap(r=>(r.tests?.failures??[]).map(f=>`${f.name}: ${f.message}`)),...missing.map(r=>`Missing executed acceptance criterion: ${r.id}`)];
  if(!passed&&!failures.length)failures.push('Vitest execution incomplete, timed out, or failed to preserve its inputs');
  const summary=passed?`${task.id}: controller Vitest passed ${results.reduce((n,r)=>n+r.tests.counts.passed,0)} assertions; whole REVIEW remains pending.`:failures.join('\n').slice(0,6000);
  return {review:contract.review,taskId:task.id,verdict,nonPassKind,summary,candidateRoot:row.target.productRoot,targetId:row.target.targetId,verificationFramework:'vitest',acceptanceMode:'controller-vitest',
    operatingFailureKind:contextDeliveryFailure?'input_delivery':!preparationComplete&&(missing.length||results.some(r=>r.tests?.counts?.errors))?'test_preparation':'execution',
    checks:TASK_GATES.map(id=>({id,status:verdict,evidencePaths:evidence.map(pin=>pin.path),detail:summary})),inputs:[row.target.manifest,row.implementation.requestIdentity,row.contractIdentity,...(row.testPreparation?[row.testPreparation.requestIdentity,row.testPreparation.responseIdentity]:[])],evidence,commands,failures,suggestedRepairPrompt:passed?'':contextDeliveryFailure?`Repair controller input delivery for ${task.id}; preserve product and frozen assertions. ${summary}`:`Repair only task ${task.id}; preserve the frozen acceptance suite. ${summary}`};
}
