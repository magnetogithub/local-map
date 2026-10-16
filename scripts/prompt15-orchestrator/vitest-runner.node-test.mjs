import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import {runVitestChecks} from './run-vitest-checks.mjs';
import {MAX_LOG_BYTES} from './bounded-output.mjs';
test('real Vitest + fast-check run reports exact coverage; failures and skipped cases never PASS',async()=>{
  const root=process.cwd(),dir=fs.mkdtempSync(path.join(root,'.tmp/prompt15-vitest-'));
  // Preserve the small runner self-test evidence. It is not a product REVIEW.
  const prefix="import {test,expect} from 'vitest';\n";
  fs.writeFileSync(path.join(dir,'pass.test.ts'),prefix+[
    "import fc from 'fast-check';",
    "import {validateDecision} from '../../scripts/prompt15-orchestrator/protocol.mjs';",
    "test('failed review cannot advance for any proposed next review',()=>{fc.assert(fc.property(fc.constantFrom('A','B','C','D','E','F'),review=>{expect(()=>validateDecision(review,{verdict:'fail'},{review,action:'advance',repairReview:review,repairPrompt:''})).toThrow();}),{seed:1514,numRuns:100});});",
  ].join('\n'));
  const pass=await runVitestChecks(root,path.join(dir,'pass'),[path.join(dir,'pass.test.ts')]);
  assert.equal(pass.pass,true,JSON.stringify(pass.tests)); assert.equal(pass.allFilesExecuted,true);
  assert.equal(pass.tests.counts.passed,1); assert.equal(pass.independentReviewIssued,false);
  assert.ok(pass.execution.stdout.byteLength<=MAX_LOG_BYTES); assert.ok(pass.execution.stderr.byteLength<=MAX_LOG_BYTES);
  fs.writeFileSync(path.join(dir,'fail.test.ts'),prefix+"test('failure',()=>{expect(1).toBe(2)});\n");
  const fail=await runVitestChecks(root,path.join(dir,'fail'),[path.join(dir,'fail.test.ts')]);
  assert.equal(fail.pass,false); assert.equal(fail.tests.counts.failed,1); assert.match(fail.tests.failures[0].message,/expected/);
  fs.writeFileSync(path.join(dir,'skip.test.ts'),prefix+"test.skip('required case',()=>{}); test('other case',()=>{});\n");
  const skip=await runVitestChecks(root,path.join(dir,'skip'),[path.join(dir,'skip.test.ts')]);
  assert.equal(skip.execution.exitCode,0); assert.equal(skip.pass,false); assert.equal(skip.tests.counts.skipped,1);
  await assert.rejects(runVitestChecks(root,path.join(dir,'missing'),[path.join(dir,'missing.test.ts')]),/ENOENT/);
});
