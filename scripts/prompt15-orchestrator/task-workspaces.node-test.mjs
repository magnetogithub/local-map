import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {prepareWorkspace,workspaceSnapshot,planWorkspaceMerge,applyWorkspaceMerge} from './workspaces.mjs';
import {productSnapshot,captureProductTarget,validateProductTarget} from './product-target.mjs';
import {fileIdentity,inside} from './protocol.mjs';

test('an approved Windows dependency archive junction is reconstructed read-only and remains input-pinned',t=>{
  const base=path.resolve('.tmp/task-workspace-tests');fs.mkdirSync(base,{recursive:true});const root=fs.mkdtempSync(path.join(base,'case-')),source=path.join(root,'reports/source'),store=path.join(root,'archives');fs.mkdirSync(path.join(source,'validation'),{recursive:true});fs.mkdirSync(store);fs.writeFileSync(path.join(source,'package.json'),'{}');fs.writeFileSync(path.join(source,'validation/check.mjs'),'export const valid=true;');fs.writeFileSync(path.join(store,'approved.tgz'),'approved dependency');fs.symlinkSync(store,path.join(source,'validation/archives'),'junction');
  t.after(()=>{assert.ok(inside(base,root)&&root!==base);fs.rmSync(root,{recursive:true,force:true});});
  const workspace=prepareWorkspace(source,path.join(root,'reports/worker'),{writablePaths:['validation/check.mjs']},{controlRoot:root,sourceOnly:true});
  assert.equal(fs.realpathSync(path.join(workspace.directory,'validation/archives')),store);assert.deepEqual(productSnapshot(workspace.directory),productSnapshot(source));assert.ok(workspaceSnapshot(workspace.directory)['validation/archives'].startsWith('link:'));
  const manifest=path.join(workspace.directory,'.reports/inputs.json');fs.writeFileSync(manifest,JSON.stringify({version:1,inputs:[fileIdentity(root,path.join(store,'approved.tgz'))]}));const target=captureProductTarget(root,workspace.directory,path.join(root,'reports/target'),{artifactManifest:manifest});validateProductTarget(root,target);
  fs.writeFileSync(path.join(store,'approved.tgz'),'unexpected dependency change');assert.throws(()=>validateProductTarget(root,target),/bytes changed/);
});

test('task merge detects another writer instead of overwriting a previously approved file',t=>{
  const base=path.resolve('.tmp/task-workspace-tests');fs.mkdirSync(base,{recursive:true});const root=fs.mkdtempSync(path.join(base,'case-'));fs.mkdirSync(path.join(root,'src'));fs.writeFileSync(path.join(root,'src/a.txt'),'base');
  t.after(()=>{assert.ok(inside(base,root)&&root!==base);fs.rmSync(root,{recursive:true,force:true});});
  const plan={writablePaths:['src/a.txt']},workspace=prepareWorkspace(root,path.join(root,'reports/worker'),plan,{controlRoot:root,sourceOnly:true});fs.writeFileSync(path.join(workspace.directory,'src/a.txt'),'worker');fs.writeFileSync(path.join(root,'src/a.txt'),'another writer');assert.throws(()=>planWorkspaceMerge(root,workspace,plan,['src/a.txt']),/changed since/);assert.equal(fs.readFileSync(path.join(root,'src/a.txt'),'utf8'),'another writer');fs.writeFileSync(path.join(root,'src/a.txt'),'base');applyWorkspaceMerge(planWorkspaceMerge(root,workspace,plan,['src/a.txt']));assert.equal(fs.readFileSync(path.join(root,'src/a.txt'),'utf8'),'worker');
});
