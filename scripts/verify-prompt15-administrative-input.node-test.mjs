import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {DEFAULT_ARTIFACT_ROOT,verifyAdministrativeArtifact} from './verify-prompt15-administrative-input.mjs';

const repoRoot=process.cwd();
const artifactRoot=path.resolve(repoRoot,DEFAULT_ARTIFACT_ROOT);
const runCli=root=>spawnSync(process.execPath,['scripts/verify-prompt15-administrative-input.mjs','--artifact-root',root],{cwd:repoRoot,encoding:'utf8'});
test('V18 accepts the independently reproduced 15-09 SVN restoration and complete 15-18 package',()=>{const report=verifyAdministrativeArtifact({repoRoot,artifactRoot});assert.equal(report.status,'pass');assert.equal(report.errors.restorationEvidence.length,0);assert.equal(report.counts.raw,4596);assert.equal(report.counts.eligible,4591);assert.equal(report.counts.excluded,5);assert.deepEqual(report.svn,{source:193,traced:193,restored:193,missing:0,duplicate:0,unresolved:0});});
test('V18 CLI rejects copied fixture with one missing source identity',()=>{const temp=fs.mkdtempSync(path.join(os.tmpdir(),'prompt15-v18-missing-')),target=path.join(temp,path.basename(artifactRoot));try{fs.cpSync(artifactRoot,target,{recursive:true});const tracePath=path.join(target,'source-identity-trace.json'),traces=JSON.parse(fs.readFileSync(tracePath,'utf8'));traces.splice(traces.findIndex(item=>item.sourceCountryId==='SVN'),1);fs.writeFileSync(tracePath,JSON.stringify(traces));const result=runCli(target);assert.notEqual(result.status,0,result.stdout);const output=JSON.parse(result.stdout.trim());assert.equal(output.status,'fail');}finally{fs.rmSync(temp,{recursive:true,force:true});}});
test('V18 CLI rejects copied fixture with one unresolved prior loss',()=>{const temp=fs.mkdtempSync(path.join(os.tmpdir(),'prompt15-v18-unresolved-')),target=path.join(temp,path.basename(artifactRoot));try{fs.cpSync(artifactRoot,target,{recursive:true});const lossPath=path.join(target,'loss-audit-resolution.json'),loss=JSON.parse(fs.readFileSync(lossPath,'utf8'));loss[0].status='unresolved';loss[0].restorationIdentity=null;fs.writeFileSync(lossPath,JSON.stringify(loss));const result=runCli(target);assert.notEqual(result.status,0,result.stdout);const output=JSON.parse(result.stdout.trim());assert.equal(output.status,'fail');}finally{fs.rmSync(temp,{recursive:true,force:true});}});
