import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';

const root='reports/prompt14/14-17-country-color/review-f-remediation';
fs.mkdirSync(root,{recursive:true});
const stage=process.argv[2];
const commands={
  tests:['node_modules/vitest/vitest.mjs','run',
    'src/lib/world/country-map-color.test.ts','src/lib/commands/country-change-map-color.test.ts',
    'src/lib/simulation/country-color-runtime.test.ts','src/lib/simulation/catalog-runtime.test.ts',
    'src/lib/simulation/catalog-occupation-lifecycle.test.ts','src/lib/simulation/catalog-occupation-browser-contract.test.ts',
    'src/lib/simulation/simulation-contract.test.ts','src/lib/simulation/simulation-state-v2.test.ts',
    'src/lib/simulation/client/turn-request.test.ts','src/lib/simulation/client/gameplay-behavior.test.ts',
    'src/lib/world/world-state-v3.test.ts','src/lib/world/territory-control-invariant.test.ts',
    '--reporter=json',`--outputFile=${root}/related-tests.json`],
  map:['node_modules/vitest/vitest.mjs','run','src/lib/map/catalog-consumer.test.ts','-t','catalog projection','--reporter=json',`--outputFile=${root}/map-tests.json`],
  typecheck:['node_modules/typescript/bin/tsc','--noEmit'],
  lint:['node_modules/eslint/bin/eslint.js',
    'src/lib/simulation/presentation-grant-validation.ts','src/lib/simulation/country-color-intent.ts',
    'src/lib/simulation/country-color-authority.ts','src/lib/simulation/country-color-runtime.test.ts',
    'src/lib/simulation/simulation-context.ts','src/lib/simulation/world-effect.ts',
    'src/lib/simulation/semantic-validator.ts','src/lib/simulation/server/context-resolution-validator.ts',
    'src/lib/simulation/server/simulation-instruction.ts','src/lib/simulation/world-effect-compiler.ts',
    'scripts/smoke-prompt14-country-colors.mjs','scripts/verify-prompt14-review-f.mjs','scripts/report-prompt14-review-f.mjs'],
  build:['node_modules/next/dist/bin/next','build'],
  smoke:['scripts/smoke-prompt14-country-colors.mjs','--review-f'],
  browserContract:['node_modules/vitest/vitest.mjs','run','src/lib/simulation/country-color-runtime.test.ts',
    '-t','captured production browser','--reporter=json',`--outputFile=${root}/browser-contract-tests.json`],
};
if(!commands[stage])throw new Error(`Unknown stage ${stage}`);
const startedAt=new Date().toISOString(),start=Date.now(),args=commands[stage];
const evidence=path.join(root,'browser/evidence.json');
const useEvidence=stage==='browserContract'||(stage==='tests'&&fs.existsSync(evidence));
const env=useEvidence?{...process.env,PROMPT14_COLOR_EVIDENCE:evidence}:process.env;
const result=spawnSync(process.execPath,args,{env,windowsHide:true,encoding:'utf8',maxBuffer:32*1024*1024});
const log=`${root}/${stage}.log`;fs.writeFileSync(log,(result.stdout??'')+(result.stderr??'')+(result.error?.stack??''));
const receipt={stage,command:`node ${args.join(' ')}`,environment:useEvidence?{PROMPT14_COLOR_EVIDENCE:evidence}:{},startedAt,finishedAt:new Date().toISOString(),durationMs:Date.now()-start,exitCode:result.status,signal:result.signal,log};
fs.appendFileSync(path.join(root,'commands.jsonl'),JSON.stringify(receipt)+'\n');console.log(JSON.stringify(receipt));
if(result.status!==0){console.log(fs.readFileSync(log,'utf8').slice(-8000));process.exitCode=result.status??1;}
