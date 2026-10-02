import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import test from 'node:test';
import {spawnSync} from 'node:child_process';
test('checkpoint derives blocked/fail from supplied results and cannot freeze missing actual catalog/migration bytes',()=>{
  fs.mkdirSync('.tmp/prompt14-review-c',{recursive:true});
  const directory=fs.mkdtempSync(path.resolve('.tmp/prompt14-review-c/checkpoint-test-')),output=path.join(directory,'checkpoint.json'),freeze=path.join(directory,'frozen.json'),missing=path.join(directory,'missing');
  const args=['scripts/write-prompt14-catalog-checkpoint.mjs','--first',missing,'--second',missing,'--source-first',missing,'--source-second',missing,'--output',output,'--freeze','--freeze-output',freeze];
  const blocked=spawnSync(process.execPath,args,{encoding:'utf8'});
  assert.equal(blocked.status,2);assert.equal(JSON.parse(fs.readFileSync(output)).status,'blocked');assert.equal(fs.existsSync(freeze),false);
  fs.mkdirSync(missing);fs.writeFileSync(path.join(missing,'generation-failure.json'),JSON.stringify({status:'fail',message:'Full input boundary gate failure',evidence:{unpairedInteriorBoundaries:1}}));
  const failed=spawnSync(process.execPath,args,{encoding:'utf8'});
  assert.equal(failed.status,1);const report=JSON.parse(fs.readFileSync(output));assert.equal(report.status,'fail');assert.equal(report.reviewPassed,false);assert.equal(fs.existsSync(freeze),false);
  assert.equal(report.failure.artifacts.length,2);assert.equal(report.failure.artifacts[0].result.message,'Full input boundary gate failure');
});
