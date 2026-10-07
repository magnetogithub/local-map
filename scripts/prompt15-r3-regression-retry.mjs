import fs from 'node:fs';
import {spawnSync} from 'node:child_process';
import {jsonBytes} from './prompt14-catalog-core.mjs';
import {fileIdentity} from './prompt15-cell-core.mjs';
const files=['src/lib/map/catalog-consumer.test.ts','src/lib/map/catalog-label-renderer.test.ts','src/lib/map/catalog-labels.server.test.ts','src/lib/simulation/catalog-region-integration.test.ts','src/lib/simulation/catalog-runtime.test.ts','src/lib/simulation/production-subdivision-catalog.test.ts','src/lib/simulation/simulation-context-production.test.ts'];
const args=['node_modules/vitest/vitest.mjs','run',...files,'--maxWorkers=1','--fileParallelism=false'],start=performance.now();
console.log(`Retrying timed-out suites with one test worker and unchanged timeouts: node ${args.join(' ')}`);
const r=spawnSync(process.execPath,args,{encoding:'utf8',maxBuffer:32*1024**2});
fs.writeFileSync('reports/prompt15/review-c-r3/regression-retry.json',jsonBytes({status:r.status===0?'pass':'fail',exitCode:r.status,elapsedMs:performance.now()-start,command:`node ${args.join(' ')}`,stdout:r.stdout,stderr:r.stderr,inputs:files.map(fileIdentity),reason:'Initial all-suite parallel run timed out in eight checks while world generation and other large data suites ran concurrently. Retest the complete affected suites with one worker; no test assertions/timeouts or REVIEW B budgets changed.'}));console.log(r.stdout);console.log(r.stderr);if(r.status!==0)process.exitCode=1;
