import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {describe, it, expect} from 'vitest';
import {installLocation, physicalPath} from './prompt15-location.mjs';
import {captureProductTarget, validateProductTarget} from '../scripts/prompt15-orchestrator/product-target.mjs';
import {resolveInside, fileIdentity, validateIdentities} from '../scripts/prompt15-orchestrator/protocol.mjs';
import {workspaceSnapshot, planWorkspaceMerge} from '../scripts/prompt15-orchestrator/workspaces.mjs';
import {AppServer} from '../scripts/prompt15-orchestrator/app-server.mjs';

const fixture = () => fs.mkdtempSync(path.join(process.env.TEMP ?? process.cwd(), 'prompt15-location-'));
describe('workspace relocation preserves original authority', () => {
  it('sends the real cwd and writable roots to native sessions without changing approval policy', async () => {
    const sourceRoot=fixture(),destinationRoot=fixture(),routing=installLocation({sourceRoot,destinationRoot}),sent=[];
    const client={nextId:1,pending:new Map(),requestTimeoutMs:1000,send(message){sent.push(message);queueMicrotask(()=>{const pending=this.pending.get(message.id);clearTimeout(pending.timer);this.pending.delete(message.id);pending.resolve({});});}};
    const input={cwd:sourceRoot,approvalPolicy:'on-request',approvalsReviewer:'auto_review',sandboxPolicy:{type:'workspaceWrite',writableRoots:[sourceRoot]},input:[{type:'text',text:'preserved assignment'}]};
    try {
      await AppServer.prototype.request.call(client,'turn/start',input);
      expect(sent[0].params.cwd).toBe(destinationRoot);expect(sent[0].params.sandboxPolicy.writableRoots).toEqual([destinationRoot]);expect(sent[0].params.approvalPolicy).toBe('on-request');expect(sent[0].params.approvalsReviewer).toBe('auto_review');expect(input.cwd).toBe(sourceRoot);expect(input.input).toHaveLength(1);expect(sent[0].params.input.at(-1).text).toContain('do not rewrite historical receipts');
    } finally {routing.restore();}
  });
  it('maps a different drive letter without creating a drive alias', () => {
    const destinationRoot=fixture(),routing=installLocation({sourceRoot:'Z:\\legacy',destinationRoot});
    try { expect(path.resolve('Z:\\legacy\\reports\\input')).toBe(path.join(destinationRoot,'reports/input')); expect(path.relative(destinationRoot,'Z:\\legacy\\reports')).toBe('reports'); expect(physicalPath('Z:\\legacy-sibling\\file')).toBe('Z:\\legacy-sibling\\file'); }
    finally { routing.restore(); }
  });
  it('reads restored bytes through sync, callback and promise APIs without source fallback', async () => {
    const sourceRoot=fixture(),destinationRoot=fixture();
    fs.writeFileSync(path.join(sourceRoot,'input'),'original');fs.writeFileSync(path.join(sourceRoot,'missing'),'source-only');fs.writeFileSync(path.join(destinationRoot,'input'),'restored');
    const routing=installLocation({sourceRoot,destinationRoot});
    try {
      expect(fs.readFileSync(path.join(sourceRoot,'input'),'utf8')).toBe('restored');
      expect(await fs.promises.readFile(sourceRoot+path.sep+'input','utf8')).toBe('restored');
      expect(await new Promise((resolve,reject)=>fs.readFile(sourceRoot+path.sep+'input','utf8',(error,value)=>error?reject(error):resolve(value)))).toBe('restored');
      expect(fs.existsSync(sourceRoot+path.sep+'missing')).toBe(false);
      expect(path.relative(destinationRoot,sourceRoot+path.sep+'input')).toBe('input');
      expect(physicalPath(sourceRoot+'-sibling'+path.sep+'input')).toBe(sourceRoot+'-sibling'+path.sep+'input');
      expect(()=>resolveInside(destinationRoot,sourceRoot+path.sep+'..'+path.sep+'outside')).toThrow('escapes');
    } finally { routing.restore(); }
    expect(fs.readFileSync(path.join(sourceRoot,'input'),'utf8')).toBe('original');
  });
  it('validates the unchanged original product manifest and rejects byte tampering', () => {
    const sourceRoot=fixture(),destinationRoot=fixture(),candidate=path.join(sourceRoot,'reports/candidate');
    fs.mkdirSync(path.join(candidate,'src'),{recursive:true});fs.writeFileSync(path.join(candidate,'src/code.ts'),'export const x=1;');fs.writeFileSync(path.join(candidate,'package.json'),'{}');
    const target=captureProductTarget(sourceRoot,candidate,path.join(sourceRoot,'reports/target'));
    const manifestBytes=fs.readFileSync(path.join(sourceRoot,target.manifest.path)),originalTarget=JSON.stringify(target),pin=fileIdentity(sourceRoot,path.join(candidate,'src/code.ts'));
    fs.cpSync(sourceRoot,destinationRoot,{recursive:true});
    const routing=installLocation({sourceRoot,destinationRoot});
    try {
      expect(()=>validateProductTarget(destinationRoot,target)).not.toThrow();expect(()=>validateIdentities(destinationRoot,[pin])).not.toThrow();
      expect(fs.readFileSync(path.join(destinationRoot,target.manifest.path))).toEqual(manifestBytes);expect(JSON.stringify(target)).toBe(originalTarget);
      fs.writeFileSync(path.join(destinationRoot,'reports/candidate/src/code.ts'),'tampered');
      expect(()=>validateProductTarget(destinationRoot,target)).toThrow('source changed');expect(()=>validateIdentities(destinationRoot,[pin])).toThrow('bytes changed');
      expect(()=>validateProductTarget(destinationRoot,{...target,productRoot:path.join(destinationRoot,'reports/candidate')})).toThrow('identity changed');
    } finally { routing.restore(); }
  });
  it('accepts only the relocated original junction baseline and detects changed inputs', () => {
    const sourceRoot=fixture(),destinationRoot=fixture(),oldWorkspace=path.join(sourceRoot,'reports/task');
    fs.mkdirSync(oldWorkspace,{recursive:true});fs.mkdirSync(path.join(sourceRoot,'data'));fs.symlinkSync(path.join(sourceRoot,'data'),path.join(oldWorkspace,'data'),'junction');
    const baseline=workspaceSnapshot(oldWorkspace),workspace=path.join(destinationRoot,'reports/task');
    fs.mkdirSync(workspace,{recursive:true});fs.mkdirSync(path.join(destinationRoot,'data'));fs.mkdirSync(path.join(destinationRoot,'other'));fs.symlinkSync(path.join(destinationRoot,'data'),path.join(workspace,'data'),'junction');
    const routing=installLocation({sourceRoot,destinationRoot});
    try {
      expect(planWorkspaceMerge(destinationRoot,{directory:oldWorkspace,baseline},{writablePaths:['src']},[])).toEqual([]);
      fs.unlinkSync(path.join(workspace,'data'));fs.symlinkSync(path.join(destinationRoot,'other'),path.join(workspace,'data'),'junction');
      expect(()=>planWorkspaceMerge(destinationRoot,{directory:oldWorkspace,baseline},{writablePaths:['src']},[])).toThrow('outside assigned ownership');
    } finally { routing.restore(); }
  });
  it('inherits location in a fresh Node child and executes in the physical cwd', () => {
    const sourceRoot=fixture(),destinationRoot=fixture();fs.mkdirSync(path.join(destinationRoot,'tools'));fs.mkdirSync(path.join(destinationRoot,'.tmp'));
    fs.copyFileSync(fileURLToPath(new URL('./prompt15-location.mjs',import.meta.url)),path.join(destinationRoot,'tools/prompt15-location.mjs'));
    // The production bootstrap accepts only the original D:\gen identity.
    fs.writeFileSync(path.join(destinationRoot,'.tmp/prompt15-location.json'),JSON.stringify({version:1,sourceRoot:'D:\\gen',destinationRoot,manifestSha256:'a'.repeat(64)}));
    fs.writeFileSync(path.join(destinationRoot,'input'),'restored');fs.writeFileSync(path.join(destinationRoot,'module.mjs'),'export default "restored-module";');
    const routing=installLocation({sourceRoot:'D:\\gen',destinationRoot},{inherit:true});
    try {
      const child=spawnSync(process.execPath,['--input-type=module','-e',`import fs from 'node:fs'; const module=await import('file:///D:/gen/module.mjs'); console.log(JSON.stringify({cwd:process.cwd(),value:fs.readFileSync('D:/gen/input','utf8'),module:module.default}));`],{cwd:'D:\\gen',encoding:'utf8'});
      expect(child.status,child.stderr).toBe(0);expect(JSON.parse(child.stdout)).toEqual({cwd:destinationRoot,value:'restored',module:'restored-module'});
    } finally { routing.restore(); }
  });
});
