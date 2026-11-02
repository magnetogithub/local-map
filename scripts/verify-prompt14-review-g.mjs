import fs from 'node:fs';
import {spawn} from 'node:child_process';
const root='reports/prompt14/review-g',stage=process.argv[2];fs.mkdirSync(root,{recursive:true});
const args={
 typecheck:['node_modules/typescript/bin/tsc','--noEmit'],
 lint:['node_modules/eslint/bin/eslint.js','.','--format=json','--output-file',`${root}/lint.json`],
 build:['node_modules/next/dist/bin/next','build'],
 tests:['node_modules/vitest/vitest.mjs','run','--maxWorkers=2','--reporter=json',`--outputFile=${root}/tests.json`],
 targeted:['node_modules/vitest/vitest.mjs','run','src/lib/simulation/catalog-region.test.ts','src/lib/simulation/catalog-runtime.test.ts','src/lib/map/catalog-consumer.test.ts','--maxWorkers=2'],
 regressions:['node_modules/vitest/vitest.mjs','run','src/lib/simulation/catalog-region-integration.test.ts','src/lib/map/catalog-label-renderer.test.ts','src/lib/map/catalog-labels.server.test.ts','src/components/layout/CatalogGameSetupShell.test.tsx','src/lib/map/country-label-border-changes.test.ts','src/lib/simulation/catalog-occupation-lifecycle.test.ts','src/lib/simulation/simulation-context-production.test.ts','src/lib/simulation/simulation-contract.test.ts','src/lib/simulation/server/provider-route.test.ts','--maxWorkers=2','--reporter=json',`--outputFile=${root}/regressions.json`],
 focused:['node_modules/vitest/vitest.mjs','run','src/lib/simulation/catalog-region.test.ts','src/lib/simulation/catalog-region-integration.test.ts','src/lib/map/catalog-label-renderer.test.ts','src/lib/map/catalog-labels.server.test.ts','--maxWorkers=2','--reporter=json',`--outputFile=${root}/focused.json`],
 common:['scripts/run-playwright-e2e.mjs','e2e/prompt11-10.spec.ts','e2e/prompt12-simulation.spec.ts','e2e/prompt13-integration.spec.ts','e2e/prompt13-shell.spec.ts','e2e/game-setup.spec.ts','--reporter=line,json'],
 review:['scripts/run-playwright-e2e.mjs','e2e/prompt14-review-g.spec.ts','--reporter=line,json'],
 e2e:['scripts/run-playwright-e2e.mjs','--reporter=line,json'],
 benchmark:['scripts/run-playwright-e2e.mjs','e2e/prompt14-benchmark.spec.ts','--reporter=line,json'],
 audit:['scripts/verify-prompt14-catalog-consumer.mjs',`${root}/catalog-audit`],
 sourceTests:['--test','scripts/prompt14-source-gate.test.mjs','scripts/prompt14-catalog-core.node-test.mjs','scripts/prompt14-catalog-topology.node-test.mjs','scripts/prompt14-boundary-arrangement.node-test.mjs','scripts/prompt14-checkpoint.node-test.mjs'],
 sourceAudit:['scripts/audit-prompt14-review-g.mjs'],
 productionSmoke:['scripts/smoke-prompt14-country-colors.mjs','--review-f','--output',`${root}/production-color-smoke`],
}[stage];if(!args)throw Error(stage);
const start=new Date().toISOString(),time=Date.now();
const log=`${root}/${stage}.log`;fs.writeFileSync(log,'');
const child=spawn(process.execPath,args,{windowsHide:true,env:{...process.env,PAX_REVIEW_G_E2E:'1',PLAYWRIGHT_CHROMIUM_CHANNEL:'chrome',PLAYWRIGHT_JSON_OUTPUT_NAME:`${root}/${stage}.json`,PAX_E2E_SCREENSHOT_DIR:`${root}/screenshots`,PROMPT14_PERFORMANCE_OUTPUT:`${root}/performance`,PROMPT14_COLOR_EVIDENCE:'reports/prompt14/14-17-country-color/review-f-remediation/browser/evidence.json',PROMPT14_REVIEW_E_EVIDENCE:'reports/prompt14/14-14-runtime-smoke/review-e-remediation/browser-second/review-e-smoke-evidence.json',PROMPT14_OCCUPATION_EVIDENCE:'reports/prompt14/14-14-runtime-smoke/browser-complete/occupation-smoke-evidence.json'}});
for(const stream of [child.stdout,child.stderr])stream.on('data',bytes=>fs.appendFileSync(log,bytes));
const exitCode=await new Promise(resolve=>{child.on('error',e=>{fs.appendFileSync(log,e.stack);resolve(1);});child.on('close',code=>resolve(code));});
const receipt={command:`node ${args.join(' ')}`,stage,startedAt:start,finishedAt:new Date().toISOString(),durationMs:Date.now()-time,exitCode,log};
fs.appendFileSync(`${root}/commands.jsonl`,JSON.stringify(receipt)+'\n');console.log(JSON.stringify(receipt));if(exitCode!==0){console.log(fs.readFileSync(log,'utf8').slice(-9000));process.exitCode=exitCode??1;}
