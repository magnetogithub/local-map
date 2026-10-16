import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {inside,resolveInside,atomicJSON,validateIdentities} from './protocol.mjs';
import {validateProductTarget} from './product-target.mjs';
import {identity} from './verification-stages.mjs';
import {runBoundedCommand} from './bounded-output.mjs';
import {validateImplementationInputRoles} from './task-inputs.mjs';

const toolsRoot=fileURLToPath(new URL('../../',import.meta.url));
const require=createRequire(import.meta.url),dependencyRoot=path.dirname(path.dirname(require.resolve('vitest/package.json')));
export function taskInputEnvironment(root,context){
  if(!context.taskInputContext)return {PROMPT15_TASK_INPUT_CONTEXT:undefined,PROMPT15_TASK_INPUT_CONTEXT_PATH:undefined,PROMPT15_TASK_INPUT_CONTEXT_IDENTITY:undefined};
  validateIdentities(root,[context.taskInputContext]);
  const file=resolveInside(root,context.taskInputContext.path),pin=JSON.stringify({...context.taskInputContext,path:file});
  // Preserve existing consumers, including the frozen path-based 15-06/07
  // suites. New consumers have separate, explicit path and identity channels.
  return {PROMPT15_TASK_INPUT_CONTEXT:['15-06','15-07'].includes(context.taskId)?file:pin,PROMPT15_TASK_INPUT_CONTEXT_PATH:file,PROMPT15_TASK_INPUT_CONTEXT_IDENTITY:pin};
}
export async function runTargetChecks(contextFile,outputDirectory,files,{environment='node',onStart}={}){
  contextFile=path.resolve(contextFile);const context=JSON.parse(fs.readFileSync(contextFile,'utf8'));
  const root=fs.realpathSync(context.root),target=context.productTarget;
  validateImplementationInputRoles(root,target,validateProductTarget(root,target));
  if(context.productRoot!==target.productRoot)throw Error('Target binding: test context product root mismatch');
  const report=resolveInside(root,context.reportDirectory);outputDirectory=resolveInside(root,outputDirectory);
  if(!inside(report,outputDirectory)||outputDirectory===report||!inside(report,contextFile))throw Error('Use a fresh output directory inside this verification job');
  if(!['node','jsdom'].includes(environment))throw Error('Use node or jsdom test environment');
  if(!Array.isArray(files)||!files.length)throw Error('Specify exact target test files');
  const selected=files.map(file=>resolveInside(root,file));
  if(new Set(selected.map(file=>file.toLowerCase())).size!==selected.length||selected.some(file=>!(/\.(?:[cm]?[jt]s|tsx)$/.test(file))||/[*?{}\[\]!]/.test(file)||!inside(target.productRoot,file)&&!inside(report,file)))throw Error('Tests must be exact candidate or fresh verifier files');
  if(fs.existsSync(outputDirectory))throw Error('Preserve existing target test evidence');
  fs.mkdirSync(outputDirectory,{recursive:true});
  const temporaryDirectory=path.join(outputDirectory,'temp');fs.mkdirSync(temporaryDirectory);
  const cli=path.join(dependencyRoot,'vitest/vitest.mjs'),reporter=path.join(toolsRoot,'scripts/prompt15-orchestrator/compact-vitest-reporter.mjs');
  const candidateFastCheck=path.join(target.productRoot,'validation/node_modules/fast-check');
  const fastCheck=fs.existsSync(candidateFastCheck)?candidateFastCheck:path.join(dependencyRoot,'fast-check');
  const setup=environment==='jsdom'&&fs.existsSync(path.join(target.productRoot,'vitest.setup.ts'))?[path.join(target.productRoot,'vitest.setup.ts')]:[];
  const executionRoot=context.executionCwd==='candidate'?target.productRoot:root;
  let testDirectory=path.dirname(selected[0]);
  for(const file of selected)while(!inside(testDirectory,file))testDirectory=path.dirname(testDirectory);
  const config={root:executionRoot,resolve:{alias:{'@':path.join(target.productRoot,'src'),'server-only':path.join(dependencyRoot,'next/dist/compiled/server-only/empty.js'),'fast-check':fastCheck}},
    cacheDir:path.join(outputDirectory,'cache'),test:{environment,dir:testDirectory,include:selected.map(file=>path.relative(testDirectory,file).replaceAll('\\','/')),exclude:[],setupFiles:setup,
      reporters:[reporter],silent:true,maxWorkers:2,fileParallelism:false,passWithNoTests:false,testTimeout:30000,hookTimeout:30000}};
  const configFile=path.join(outputDirectory,'vitest-target.config.mjs');fs.writeFileSync(configFile,'export default '+JSON.stringify(config)+';\n',{flag:'wx'});
  const inputFiles=[process.execPath,cli,reporter,fileURLToPath(import.meta.url),contextFile,resolveInside(root,target.manifest.path),configFile,path.join(fastCheck,'package.json'),...setup,...selected];
  for(const pin of context.supportInputs??[]){const file=resolveInside(root,pin.path);if(!inside(report,file))throw Error('Test support must stay in the controller report');validateIdentities(root,[pin]);inputFiles.push(file);}
  if(context.taskInputContext){validateIdentities(root,[context.taskInputContext]);inputFiles.push(resolveInside(root,context.taskInputContext.path));}
  const taskEnvironment=taskInputEnvironment(root,context);
  const inputs=await Promise.all([...new Set(inputFiles.map(file=>fs.realpathSync(file)))].map(identity));
  atomicJSON(path.join(outputDirectory,'test-inputs.json'),{version:1,targetId:target.targetId,productRoot:target.productRoot,environment,inputs});
  const command=[process.execPath,cli,'run','--config',configFile,'--configLoader','native'];
  const execution=await runBoundedCommand({command,cwd:executionRoot,logPrefix:path.join(outputDirectory,'tests'),timeoutMs:context.timeoutMs??600000,onStart,env:{NODE_TEST_CONTEXT:undefined,PROMPT15_CANDIDATE_ROOT:target.productRoot,...taskEnvironment,TMPDIR:temporaryDirectory,TMP:temporaryDirectory,TEMP:temporaryDirectory}});
  let tests=null;try{tests=JSON.parse(fs.readFileSync(execution.stdout.path,'utf8'));}catch{/* no complete result cannot pass */}
  const after=await Promise.all(inputs.map(pin=>identity(pin.path))),inputsUnchanged=JSON.stringify(inputs)===JSON.stringify(after);
  validateImplementationInputRoles(root,target,validateProductTarget(root,target));
  const actual=tests?.files?.map(file=>path.resolve(file).toLowerCase()).sort();
  const allFilesExecuted=JSON.stringify(actual)===JSON.stringify(selected.map(file=>file.toLowerCase()).sort());
  const result={version:1,kind:'vitest-bound-target',pass:execution.exitCode===0&&!execution.signal&&tests?.complete===true&&tests?.pass===true&&inputsUnchanged&&allFilesExecuted,
    targetId:target.targetId,productRoot:target.productRoot,environment,temporaryDirectory,validationFastCheckRoot:fastCheck,command,execution,tests,inputsUnchanged,allFilesExecuted,
    scope:'Exact test files only; independent whole REVIEW and complete stage journal remain required',independentReviewIssued:false};
  atomicJSON(path.join(outputDirectory,'result.json'),result);return result;
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const args=process.argv.slice(2),index=args.indexOf('--environment');let environment='node';
  if(index>=0){environment=args[index+1];args.splice(index,2);}
  const [context,output,...files]=args;
  if(!context||!output||!files.length)throw Error('Use run-target-checks.mjs <job-context.json> <fresh-output> <exact-tests...> [--environment node|jsdom]');
  const result=await runTargetChecks(context,output,files,{environment});
  console.log(JSON.stringify({pass:result.pass,targetId:result.targetId,counts:result.tests?.counts,result:path.resolve(output,'result.json')}));process.exitCode=result.pass?0:1;
}
