import {describe,it,expect} from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {TransferInventory,safeRelative,isPrivatePath,secretKinds,sha256,transferredState} from './prompt15-transfer-core.mjs';
import {validateManifest,restore} from './prompt15-transfer.mjs';
import {redirectWorkspace} from './prompt15-transfer-shadow.mjs';

const sourceState=()=>({version:2,runId:'fixture-run',projectRoot:'D:\\gen',status:'stopped',review:'B',phase:'operating_repair',repairAttempts:4,
  activeTurns:{},activeOperations:{},threads:{supervisor:'old-thread'},threadNames:{supervisor:'old'},guardian:{sequence:81,threadId:'old-guardian'},
  certificates:{A:{verdict:'pass',targetId:'approved-source'}},controllerPid:1234,runtimeSupervisorPid:5678,
  tasks:{'15-01':{status:'pass',attempt:2,failures:1,verification:'old-verdict.json'},'15-13':{status:'blocked',attempt:5,failures:2,blocker:'real geometry failure'},'15-14':{status:'pending',attempt:5}},
  operatingRecovery:{status:'recovering'},supervisorOversight:{status:'failed'}});
const pin={path:'reports/transfer/receipt.json',sha256:'a'.repeat(64),byteLength:123};
const fixture=()=>fs.mkdtempSync(path.join(process.env.TEMP??process.cwd(),'prompt15-transfer-'));
describe('host transfer preserves product authority',()=>{
  it('preserves approvals, task rows and real implementation failures exactly',()=>{
    const original=sourceState(),copy=structuredClone(original),next=transferredState(original,pin,'2026-10-16T00:00:00Z');
    expect(next.tasks).toEqual(copy.tasks);expect(next.certificates).toEqual(copy.certificates);expect(next.repairAttempts).toBe(4);expect(original).toEqual(copy);
  });
  it('archives previous native ownership and creates no new approval or running operation',()=>{
    const next=transferredState(sourceState(),pin);expect(next.status).toBe('stopped');expect(next.controllerPid).toBeNull();expect(next.threads).toEqual({});
    expect(next.transfer.archivedHostState.threads.supervisor).toBe('old-thread');expect(next.guardian).toEqual({sequence:81});expect(next.certificates.B).toBeUndefined();
  });
  for(const mutation of [s=>s.status='running',s=>s.activeTurns.x={turnId:'active'},s=>s.activeOperations.x={id:'active'},s=>s.guardian.activeRepairId='repair',s=>s.supervisorOversight.pendingRepairIdentity=pin])
    it('refuses unsettled work instead of discarding its ownership',()=>{const original=sourceState();mutation(original);expect(()=>transferredState(original,pin)).toThrow();});
  it('refuses a task that would require resuming a missing native turn',()=>{const original=sourceState();original.tasks['15-13'].operatingContinuation={};expect(()=>transferredState(original,pin)).toThrow();});
});
describe('public bundle boundaries',()=>{
  it('does not interpret serialized JSON embedded in protocol text as a file',()=>{
    const inventory=new TransferInventory(fixture());
    inventory.document=path.join(inventory.root,'reports/protocol.json');
    const text='reports/candidate/{"path":"D:/gen/reports/input.json","sha256":"hash"}';
    expect(inventory.resolve(text)).toBeNull();expect(()=>inventory.inspect(text)).not.toThrow();
  });
  it('redirects original absolute paths to independent files without fallback',()=>{
    const original=fixture(),independent=fixture();fs.writeFileSync(path.join(original,'input.txt'),'original');fs.writeFileSync(path.join(original,'missing.txt'),'original-only');fs.writeFileSync(path.join(independent,'input.txt'),'restored');
    const redirect=redirectWorkspace(original,independent);
    try{expect(fs.readFileSync(path.join(original,'input.txt'),'utf8')).toBe('restored');expect(fs.existsSync(path.join(original,'missing.txt'))).toBe(false);expect(fs.realpathSync(path.join(original,'input.txt'))).toBe(path.join(original,'input.txt'));expect(redirect.count()).toBeGreaterThan(0);}finally{redirect.restore();}
    expect(fs.readFileSync(path.join(original,'input.txt'),'utf8')).toBe('original');
  });
  it('invalidates cached paths when a workspace junction is discovered',()=>{
    const root=fixture();fs.mkdirSync(path.join(root,'data'));fs.mkdirSync(path.join(root,'reports'));fs.writeFileSync(path.join(root,'data/input.txt'),'fixture');fs.symlinkSync(path.join(root,'data'),path.join(root,'reports/data'),'junction');
    const inventory=new TransferInventory(root),alias=path.join(root,'reports/data/input.txt');inventory.canonical(alias);inventory.addFile(path.join(root,'data/input.txt'));inventory.addFile(alias);expect([...inventory.files.keys()]).toEqual(['data/input.txt']);expect(inventory.links.size).toBe(1);
  });
  it('ignores the workspace parent without treating it as a transferable path',()=>{
    const root=fixture(),inventory=new TransferInventory(root);
    expect(inventory.relative(path.dirname(root))).toBeNull();
    expect(inventory.resolve(path.dirname(root))).toBeNull();
    expect(()=>inventory.addFile(path.dirname(root))).not.toThrow();
    expect(inventory.files.size).toBe(0);
  });
  for(const unsafe of ['../auth.json','/absolute.json','C:/auth.json','reports/../../auth.json','reports\\auth.json'])
    it('rejects path traversal: '+unsafe,()=>expect(()=>safeRelative(unsafe)).toThrow());
  it('excludes private account and environment stores',()=>{for(const name of ['.codex/auth.json','.git/config','.env.local','.aws/credentials','dir/.ssh/id_rsa'])expect(isPrivatePath(name)).toBe(true);expect(isPrivatePath('.env.example')).toBe(false);});
  it('detects credential patterns without returning the credential',()=>{const secret='sk-'+'a'.repeat(40);expect(secretKinds(secret)).toEqual(['openai-key']);expect(JSON.stringify(secretKinds(secret))).not.toContain(secret);});
  it('discovers exact referenced evidence and source files while deduplicating cycles',async()=>{
    const root=fixture();fs.mkdirSync(path.join(root,'reports/candidate/src'),{recursive:true});fs.writeFileSync(path.join(root,'reports/candidate/src/code.ts'),'export const x=1;');
    fs.writeFileSync(path.join(root,'reports/evidence.json'),JSON.stringify({back:'reports/state.json'}));
    fs.writeFileSync(path.join(root,'reports/state.json'),JSON.stringify({target:{productRoot:path.join(root,'reports/candidate'),source:{'src/code.ts':'hash'}},proof:{path:'reports/evidence.json'}}));
    const inventory=await new TransferInventory(root).discover(['reports/state.json']);
    expect(inventory.files.map(f=>f.path).sort()).toEqual(['reports/candidate/src/code.ts','reports/evidence.json','reports/state.json']);
  });
  it('fails closed if an input references a private environment file',async()=>{const root=fixture();fs.writeFileSync(path.join(root,'.env.local'),'secret');fs.mkdirSync(path.join(root,'reports'));fs.writeFileSync(path.join(root,'reports/state.json'),JSON.stringify({path:path.join(root,'.env.local')}));await expect(new TransferInventory(root).discover(['reports/state.json'])).rejects.toThrow('Private');});
  it('resolves workspace junctions to one canonical file and records the link',async()=>{
    const root=fixture();fs.mkdirSync(path.join(root,'data'));fs.mkdirSync(path.join(root,'reports/candidate'),{recursive:true});fs.writeFileSync(path.join(root,'data/input.txt'),'fixture');
    fs.symlinkSync(path.join(root,'data'),path.join(root,'reports/candidate/data'),'junction');
    const x=new TransferInventory(root);x.addFile(path.join(root,'reports/candidate/data/input.txt'));x.addFile(path.join(root,'data/input.txt'));
    expect([...x.files.keys()]).toEqual(['data/input.txt']);expect([...x.links.values()]).toEqual([{path:'reports/candidate/data',target:'data'}]);
  });
  it('rejects duplicate paths and mismatched content addresses',()=>{
    const hash=sha256('fixture'),file={path:'reports/input.json',sha256:hash,byteLength:7},base={version:1,kind:'prompt15-stopped-run-transfer',files:[file],objects:[{sha256:hash,byteLength:7}],links:[],parts:[]};
    expect(validateManifest(base)).toBe(base);expect(()=>validateManifest({...base,files:[file,file]})).toThrow();expect(()=>validateManifest({...base,files:[{...file,path:'.env.local'}]})).toThrow();
  });
  it('restores exact bytes from deduplicated objects without importing credentials',async()=>{
    const bundle=fixture(),root=fixture(),bytes=Buffer.from('exact\r\nsource\n'),hash=sha256(bytes);fs.mkdirSync(path.join(bundle,'objects'));fs.writeFileSync(path.join(bundle,'objects',hash),bytes);
    const manifest={version:1,kind:'prompt15-stopped-run-transfer',sourceRoot:root,runRelative:'reports/run',node:{},files:[{path:'src/a.ts',sha256:hash,byteLength:bytes.length},{path:'src/b.ts',sha256:hash,byteLength:bytes.length}],objects:[{sha256:hash,byteLength:bytes.length}],links:[],parts:[]};
    fs.writeFileSync(path.join(bundle,'manifest.json'),JSON.stringify(manifest));await restore(bundle,root,{shadow:true});expect(fs.readFileSync(path.join(root,'src/a.ts'))).toEqual(bytes);expect(fs.readFileSync(path.join(root,'src/b.ts'))).toEqual(bytes);expect(fs.existsSync(path.join(root,'.codex'))).toBe(false);
  });
  it('rejects a damaged object before writing any restored source',async()=>{
    const bundle=fixture(),root=fixture(),hash=sha256('correct');fs.mkdirSync(path.join(bundle,'objects'));fs.writeFileSync(path.join(bundle,'objects',hash),'damaged');const manifest={version:1,kind:'prompt15-stopped-run-transfer',sourceRoot:root,runRelative:'reports/run',node:{},files:[{path:'src/a.ts',sha256:hash,byteLength:7}],objects:[{sha256:hash,byteLength:7}],links:[],parts:[]};fs.writeFileSync(path.join(bundle,'manifest.json'),JSON.stringify(manifest));await expect(restore(bundle,root,{shadow:true})).rejects.toThrow('integrity');expect(fs.existsSync(path.join(root,'src/a.ts'))).toBe(false);
  });
  it('refuses an existing destination junction without changing its target',async()=>{
    const bundle=fixture(),root=fixture(),outside=fixture(),bytes=Buffer.from('restore'),hash=sha256(bytes);fs.mkdirSync(path.join(bundle,'objects'));fs.writeFileSync(path.join(bundle,'objects',hash),bytes);fs.writeFileSync(path.join(outside,'a.ts'),'keep');fs.symlinkSync(outside,path.join(root,'src'),'junction');
    fs.writeFileSync(path.join(bundle,'manifest.json'),JSON.stringify({version:1,kind:'prompt15-stopped-run-transfer',sourceRoot:root,runRelative:'reports/run',node:{},files:[{path:'src/a.ts',sha256:hash,byteLength:bytes.length}],objects:[{sha256:hash,byteLength:bytes.length}],links:[],parts:[]}));
    await expect(restore(bundle,root,{shadow:true})).rejects.toThrow('unexpected link');expect(fs.readFileSync(path.join(outside,'a.ts'),'utf8')).toBe('keep');
  });
});
