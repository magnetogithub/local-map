import fs from 'node:fs';
import {spawnSync} from 'node:child_process';
const root='reports/prompt14/final-validation',stage=process.argv[2];fs.mkdirSync(root,{recursive:true});
const args={
  e2e:['scripts/run-playwright-e2e.mjs','--reporter=line,json'],
  integration:['scripts/run-playwright-e2e.mjs','e2e/prompt14-catalog.spec.ts','--reporter=line,json'],
  benchmark:['scripts/run-playwright-e2e.mjs','e2e/prompt14-benchmark.spec.ts','--reporter=line,json'],
  runtimeBenchmark:['node_modules/vitest/vitest.mjs','run','src/lib/simulation/prompt14-performance.test.ts','--reporter=json',`--outputFile=${root}/performance/tests.json`],
  tests:['node_modules/vitest/vitest.mjs','run','--maxWorkers=2','--reporter=json',`--outputFile=${root}/all-tests.json`],
  typecheck:['node_modules/typescript/bin/tsc','--noEmit'],lint:['node_modules/eslint/bin/eslint.js','.','--format=json','--output-file',`${root}/lint-results.json`],build:['node_modules/next/dist/bin/next','build'],
  audit:['scripts/verify-prompt14-catalog-consumer.mjs',`${root}/catalog-audit`],
  sourceAudit:['scripts/audit-prompt14-final.mjs'],
  sourceTests:['--test','scripts/prompt14-source-gate.test.mjs','scripts/prompt14-catalog-core.node-test.mjs','scripts/prompt14-catalog-topology.node-test.mjs','scripts/prompt14-boundary-arrangement.node-test.mjs','scripts/prompt14-checkpoint.node-test.mjs'],
  productionSmoke:['scripts/smoke-prompt14-country-colors.mjs','--review-f','--output',`${root}/production-color-smoke`],
  e2eDiscovery:['node_modules/@playwright/test/cli.js','test','--list','--reporter=json'],
}[stage];if(!args)throw Error(`Unknown stage ${stage}`);
const env={...process.env,PLAYWRIGHT_CHROMIUM_CHANNEL:'chrome',PLAYWRIGHT_JSON_OUTPUT_NAME:`${root}/${stage}.json`,PAX_E2E_SCREENSHOT_DIR:`${root}/historical-screenshots`,
  PROMPT14_COLOR_EVIDENCE:'reports/prompt14/14-17-country-color/review-f-remediation/browser/evidence.json',
  PROMPT14_REVIEW_E_EVIDENCE:'reports/prompt14/14-14-runtime-smoke/review-e-remediation/browser-second/review-e-smoke-evidence.json',
  PROMPT14_OCCUPATION_EVIDENCE:'reports/prompt14/14-14-runtime-smoke/browser-complete/occupation-smoke-evidence.json'};
// Only pass occupation evidence when available; skipped cases remain explicit in results.
if(!fs.existsSync(env.PROMPT14_OCCUPATION_EVIDENCE))delete env.PROMPT14_OCCUPATION_EVIDENCE;
if(stage==='runtimeBenchmark')env.PROMPT14_PERFORMANCE_OUTPUT=`${root}/performance`;
const startedAt=new Date().toISOString(),started=Date.now(),r=spawnSync(process.execPath,args,{encoding:'utf8',env,windowsHide:true,maxBuffer:64*1024*1024});
const log=`${root}/${stage}.log`;fs.writeFileSync(log,(r.stdout??'')+(r.stderr??'')+(r.error?.stack??''));
const receipt={stage,command:`node ${args.join(' ')}`,environment:{PLAYWRIGHT_CHROMIUM_CHANNEL:env.PLAYWRIGHT_CHROMIUM_CHANNEL,PLAYWRIGHT_JSON_OUTPUT_NAME:env.PLAYWRIGHT_JSON_OUTPUT_NAME,PAX_E2E_SCREENSHOT_DIR:env.PAX_E2E_SCREENSHOT_DIR,PROMPT14_COLOR_EVIDENCE:env.PROMPT14_COLOR_EVIDENCE,PROMPT14_REVIEW_E_EVIDENCE:env.PROMPT14_REVIEW_E_EVIDENCE,PROMPT14_OCCUPATION_EVIDENCE:env.PROMPT14_OCCUPATION_EVIDENCE,PROMPT14_PERFORMANCE_OUTPUT:env.PROMPT14_PERFORMANCE_OUTPUT},startedAt,finishedAt:new Date().toISOString(),durationMs:Date.now()-started,exitCode:r.status,log};
fs.appendFileSync(`${root}/commands.jsonl`,JSON.stringify(receipt)+'\n');console.log(JSON.stringify(receipt));if(r.status!==0){console.log(fs.readFileSync(log,'utf8').slice(-10000));process.exitCode=r.status??1;}
