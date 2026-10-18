import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createHash, randomUUID} from 'node:crypto';
import {createGunzip} from 'node:zlib';
import {execFileSync, spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {TransferInventory, hashFile, safeRelative, isPrivatePath, secretKinds, transferredState, sha256} from './prompt15-transfer-core.mjs';

const read = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const write = (file, value) => {fs.mkdirSync(path.dirname(file), {recursive:true}); fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', {flag:'wx'});};
const git = (root, args, options={}) => execFileSync('git', args, {cwd:root, encoding:'utf8', maxBuffer:32*1024*1024, ...options}).trim();
const cliRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
async function concurrentMap(items,operation,limit=8){
  const result=new Array(items.length);let cursor=0;
  await Promise.all(Array.from({length:Math.min(limit,items.length)},async()=>{for(;;){const index=cursor++;if(index>=items.length)return;result[index]=await operation(items[index],index);}}));
  return result;
}
export async function scanFile(file) {
  const result = new Set();
  if (!/\.(?:[cm]?[jt]sx?|json|jsonl|log|md|txt|ps1|ya?ml|html|css|csv|geojson|gz)$/i.test(file)) return [];
  let stream = fs.createReadStream(file);
  if (file.endsWith('.gz')) stream = stream.pipe(createGunzip());
  let tail = '';
  for await (const bytes of stream) {
    const text = tail + bytes.toString('utf8');
    for (const kind of secretKinds(text)) result.add(kind);
    tail = text.slice(-4096);
  }
  return [...result];
}
export async function inventory(root, progress=()=>{}) {
  const config = read(path.join(root, 'automation/prompt15/config.json'));
  const run = read(path.join(root, 'reports/prompt15/orchestration/latest.json')).directory;
  const state = read(path.join(run, 'state.json'));
  transferredState(state, {path:'transfer-placeholder.json',sha256:'0'.repeat(64),byteLength:0});
  const collector = new TransferInventory(root, {progress});
  for (const folder of ['src','scripts','tools','automation','docs','prompts','e2e']) collector.addSourceRoot(path.join(root,folder));
  const seeds = [path.join(run,'state.json'),path.join(run,'stop.json'),'reports/prompt15/orchestration/latest.json',config.manualBaselineReceipt,
    'package.json','package-lock.json','tsconfig.json','vitest.config.ts','vitest.prompt15.config.ts','next.config.ts','playwright.config.ts','vitest.setup.ts'];
  return {root,run,state,config,...await collector.discover(seeds)};
}
export async function build(root, output, {inventoryFile=null}={}) {
  if (fs.existsSync(output)) throw Error('Preserve existing transfer bundle');
  fs.mkdirSync(path.join(output,'objects'),{recursive:true});
  const found = inventoryFile?read(inventoryFile):await inventory(root, progress=>console.log(JSON.stringify({phase:'discover',...progress})));
  if(path.resolve(found.root)!==path.resolve(root)||JSON.stringify(found.state)!==JSON.stringify(read(path.join(found.run,'state.json'))))throw Error('Inventory root or stopped state changed');
  transferredState(found.state,{path:'transfer-placeholder.json',sha256:'0'.repeat(64),byteLength:0});
  const current=new TransferInventory(root);
  for(const folder of ['src','scripts','tools','automation','docs','prompts','e2e'])current.addSourceRoot(path.join(root,folder));
  for(const name of fs.readdirSync(root))if(/^(?:tsconfig.*\.json|.*\.config\.[cm]?[jt]s|vitest\.setup\.[jt]s|package(?:-lock)?\.json|\.gitattributes|\.gitignore|\.env\.example|AGENTS\.md)$/.test(name))current.addFile(path.join(root,name));
  found.files=[...new Map([...found.files,...current.files.values()].map(file=>[file.path,file])).values()];
  const objects = new Map(), pendingObjects=new Map(), failures=[];let completed=0;
  const files=await concurrentMap(found.files,async source=>{
    const digest = await hashFile(source.source);
    if(!pendingObjects.has(digest))pendingObjects.set(digest,(async()=>{
      const kinds=await scanFile(source.source);if(kinds.length)failures.push({path:source.path,kinds});
      await fs.promises.copyFile(source.source,path.join(output,'objects',digest));objects.set(digest,{sha256:digest,byteLength:source.byteLength});
    })());
    await pendingObjects.get(digest);completed++;
    if(completed%1000===0)console.log(JSON.stringify({phase:'hash-and-scan',completed,total:found.files.length,unique:objects.size}));
    return {path:source.path,sha256:digest,byteLength:source.byteLength};
  });
  write(path.join(output,'publication-scan.json'),{version:1,files:files.length,uniqueObjects:objects.size,credentialMatches:failures,
    excluded:['native Codex databases','account authentication','private environment files','unreferenced runtime/event logs'],
    note:'Protocol requests/results and paths needed to authenticate prior decisions are retained verbatim. No raw native conversation store is included.'});
  if(failures.length)throw Error('Credential-pattern matches must be resolved before publication; see publication-scan.json');
  const requirements=(await concurrentMap(found.dependencies,async item=>{const file=path.resolve(root,item.path);if(!fs.existsSync(file))return null;return {...item,sha256:await hashFile(file),byteLength:fs.statSync(file).size};})).filter(Boolean);
  const selected=read(path.join(root,'.tmp/prompt15-block-liveness-20261016/release-004/test-inputs.json')).selected;
  const npmInstallRoots=[...new Map(requirements.filter(item=>item.kind==='npm').map(item=>{
    const prefix=item.path.slice(0,item.path.indexOf('node_modules/')).replace(/\/$/,'')||'.';return [prefix.toLowerCase(),prefix];
  })).values()];
  for(const directory of npmInstallRoots)for(const name of ['package.json','package-lock.json']){
    const relative=(directory==='.'?'':directory+'/')+name;if(!files.some(item=>item.path.toLowerCase()===relative.toLowerCase()))throw Error('Missing npm environment input: '+relative);
  }
  const manifest={version:1,kind:'prompt15-stopped-run-transfer',id:randomUUID(),createdAt:new Date().toISOString(),
    sourceRoot:root,sourceCommit:git(root,['rev-parse','HEAD']),runRelative:path.relative(root,found.run).replaceAll('\\','/'),
    node:{version:process.version,platform:process.platform,arch:process.arch,path:process.execPath,sha256:await hashFile(process.execPath)},
    state:{review:found.state.review,certificates:Object.keys(found.state.certificates),task13:found.state.tasks['15-13'].status},
    manualBaselineReceipt:found.config.manualBaselineReceipt,regressionFiles:selected,files:files.sort((a,b)=>a.path.localeCompare(b.path)),
    links:found.links.sort((a,b)=>a.path.localeCompare(b.path)),requirements,npmInstallRoots,objects:[...objects.values()],parts:[],
    unavailableHistoricalReferenceCount:found.missingReferences.length,
    recovery:'Preserve product evidence; archive obsolete host ownership; start fresh native sessions only after explicit resume. No approval or product failure counter changes.'};
  let batch=[],size=0,index=0;
  const archive=async()=>{
    if(!batch.length)return;
    const name=`prompt15-transfer-objects-${String(++index).padStart(3,'0')}.tar.gz`;
    const list=path.join(output,`part-${index}.txt`);fs.writeFileSync(list,batch.map(o=>'objects/'+o.sha256).join('\n')+'\n');
    execFileSync('tar',['-czf',path.join(output,name),'-C',output,'-T',list],{stdio:'inherit',windowsHide:true});
    const bytes=fs.statSync(path.join(output,name)).size;if(bytes>=2*1024**3)throw Error('Release part exceeds GitHub asset limit');
    manifest.parts.push({name,byteLength:bytes,sha256:await hashFile(path.join(output,name))});
    console.log(JSON.stringify({phase:'archive',part:name,bytes}));batch=[];size=0;
  };
  for(const object of objects.values()){if(size+object.byteLength>1000*1024**2&&batch.length)await archive();batch.push(object);size+=object.byteLength;}
  await archive();
  const stateFile=files.find(f=>f.path===manifest.runRelative+'/state.json');
  if(stateFile.sha256!==sha256(fs.readFileSync(path.join(found.run,'state.json'))))throw Error('Original stopped state changed during export');
  write(path.join(output,'manifest.json'),manifest);
  write(path.join(output,'summary.json'),{files:files.length,uniqueObjects:objects.size,logicalBytes:files.reduce((n,x)=>n+x.byteLength,0),
    uniqueBytes:[...objects.values()].reduce((n,x)=>n+x.byteLength,0),archiveBytes:manifest.parts.reduce((n,x)=>n+x.byteLength,0),parts:manifest.parts.length,
    publicationCredentialMatches:0,state:manifest.state,sourceCommit:manifest.sourceCommit});
  console.log(fs.readFileSync(path.join(output,'summary.json'),'utf8'));
  return manifest;
}
export function validateManifest(manifest) {
  if(manifest.version!==1||manifest.kind!=='prompt15-stopped-run-transfer'||!Array.isArray(manifest.files)||manifest.files.length>200000)throw Error('Invalid transfer manifest');
  const names=new Set(), objects=new Map(manifest.objects.map(o=>[o.sha256,o.byteLength]));
  for(const entry of manifest.files){safeRelative(entry.path);if(isPrivatePath(entry.path)||entry.path.split('/').includes('node_modules'))throw Error('Forbidden transfer file');
    if(names.has(entry.path.toLowerCase())||!/^[a-f0-9]{64}$/.test(entry.sha256)||objects.get(entry.sha256)!==entry.byteLength)throw Error('Invalid/duplicate object binding');names.add(entry.path.toLowerCase());}
  for(const link of manifest.links){safeRelative(link.path);safeRelative(link.target);if(isPrivatePath(link.path)||isPrivatePath(link.target)||names.has(link.path.toLowerCase()))throw Error('Invalid workspace link');}
  for(const part of manifest.parts){if(!/^prompt15-transfer-objects-\d{3}\.tar\.gz$/.test(part.name)||!/^[a-f0-9]{64}$/.test(part.sha256))throw Error('Invalid archive part');}
  return manifest;
}
export async function restore(bundle, root, {shadow=false}={}) {
  const manifest=validateManifest(read(path.join(bundle,'manifest.json')));
  if(!shadow&&(path.resolve(root)!==manifest.sourceRoot||process.platform!==manifest.node.platform||process.arch!==manifest.node.arch))throw Error('Use the original Windows x64 project path D:\\gen');
  if(!shadow&&(process.version!==manifest.node.version||process.execPath!==manifest.node.path||await hashFile(process.execPath)!==manifest.node.sha256))throw Error('Install the exact Node.js runtime recorded in manifest.json first');
  const live=path.join(root,manifest.runRelative,'state.json');
  if(fs.existsSync(live))throw Error('Run state already exists. Do not overwrite a local run or restore onto the source PC.');
  const objects=path.join(bundle,'objects');
  if(!fs.existsSync(objects)){
    for(const part of manifest.parts){const file=path.join(bundle,part.name);if(fs.statSync(file).size!==part.byteLength||await hashFile(file)!==part.sha256)throw Error('Archive integrity mismatch: '+part.name);
      const list=execFileSync('tar',['-tzf',file],{encoding:'utf8',maxBuffer:32*1024*1024}).trim().split(/\r?\n/).filter(Boolean);
      if(list.some(name=>!/^objects\/[a-f0-9]{64}$/.test(name)))throw Error('Unsafe archive member');
      const detailed=execFileSync('tar',['-tvzf',file],{encoding:'utf8',maxBuffer:32*1024*1024}).trim().split(/\r?\n/).filter(Boolean);
      if(detailed.length!==list.length||detailed.some(line=>!line.startsWith('-')))throw Error('Archive contains a link or nonregular member');
      execFileSync('tar',['-xzf',file,'-C',bundle],{stdio:'inherit',windowsHide:true});}
  }
  const checked=new Set();
  for(const file of manifest.files){if(!checked.has(file.sha256)){const object=path.join(objects,file.sha256);if(!fs.lstatSync(object).isFile()||fs.statSync(object).size!==file.byteLength||await hashFile(object)!==file.sha256)throw Error('Object integrity mismatch');checked.add(file.sha256);}}
  const directories=new Set([path.resolve(root)]);
  const ensureDirectory=directory=>{
    if(directories.has(directory))return;
    const parent=path.dirname(directory);if(parent===directory)throw Error('Destination escapes restore root');ensureDirectory(parent);
    const stat=fs.lstatSync(directory,{throwIfNoEntry:false});
    if(stat?.isSymbolicLink()||stat&&!stat.isDirectory())throw Error('Destination has an unexpected link or non-directory');
    if(!stat)fs.mkdirSync(directory);directories.add(directory);
  };
  fs.mkdirSync(root,{recursive:true});
  for(let index=0;index<manifest.files.length;index++){
    const entry=manifest.files[index],target=path.resolve(root,entry.path);ensureDirectory(path.dirname(target));
    const existing=fs.lstatSync(target,{throwIfNoEntry:false});if(existing?.isSymbolicLink()||existing?.isDirectory())throw Error('Destination has an unexpected link or directory');
    fs.copyFileSync(path.join(objects,entry.sha256),target);
    if(index%5000===0)console.log(JSON.stringify({phase:'restore-files',completed:index,total:manifest.files.length}));
  }
  const physical=relative=>path.resolve(root,relative);
  for(const link of manifest.links){const target=physical(link.path),destination=physical(link.target);fs.mkdirSync(path.dirname(target),{recursive:true});
    if(fs.existsSync(target)){if(fs.lstatSync(target).isSymbolicLink()&&fs.realpathSync(target).toLowerCase()===fs.realpathSync(destination).toLowerCase())continue;throw Error('Workspace link destination already exists: '+link.path);}
    fs.symlinkSync(destination,target,'junction');}
  console.log(JSON.stringify({phase:'restored',files:manifest.files.length,links:manifest.links.length,root,shadow}));
  return manifest;
}
export async function verify(root, manifest, {checkDependencies=true}={}) {
  const failures=[];
  let verified=0;
  await concurrentMap(manifest.files,async item=>{const file=path.join(root,item.path);
    if(!fs.existsSync(file)||fs.statSync(file).size!==item.byteLength||await hashFile(file)!==item.sha256)failures.push(item.path);
    verified++;if(verified%5000===0)console.log(JSON.stringify({phase:'verify-bytes',completed:verified,total:manifest.files.length}));
  });
  if(checkDependencies)await concurrentMap(manifest.requirements,async item=>{const file=path.resolve(root,item.path);if(!fs.existsSync(file)||fs.statSync(file).size!==item.byteLength||await hashFile(file)!==item.sha256)failures.push('dependency:'+item.path);});
  if(failures.length)throw Error('Transfer verification failed: '+JSON.stringify(failures.slice(0,12)));
  const {validateManualBaseline}=await import('../scripts/prompt15-orchestrator/launch-policy.mjs');
  const {validateProductTarget}=await import('../scripts/prompt15-orchestrator/product-target.mjs');
  const state=read(path.join(root,manifest.runRelative,'state.json'));
  // All validation here is synchronous and read-only. Resolve shared directory
  // junctions once rather than repeating deep NTFS walks for each source file.
  const realpath=fs.realpathSync,parents=new Map();
  fs.realpathSync=function(file,...args){
    if(typeof file!=='string'||args.length)return realpath(file,...args);
    if(fs.lstatSync(file).isSymbolicLink())return realpath(file);
    const parent=path.dirname(file);if(!parents.has(parent))parents.set(parent,realpath(parent));
    return path.join(parents.get(parent),path.basename(file));
  };
  try{
    validateManualBaseline(root,manifest.manualBaselineReceipt);
    validateProductTarget(root,state.approvedProductTarget);validateProductTarget(root,state.currentProductTarget);
    for(const task of Object.values(state.tasks))if(task.status==='pass'&&task.target)validateProductTarget(root,task.target);
  }finally{fs.realpathSync=realpath;}
  return {pass:true,files:manifest.files.length,approvals:Object.keys(state.certificates),review:state.review,task13:state.tasks['15-13'].status};
}
export async function prepare(root,bundle,{regressions=true}={}) {
  const manifest=validateManifest(read(path.join(bundle,'manifest.json')));
  if(path.resolve(root)!==manifest.sourceRoot)throw Error('Restore at the exact original project path');
  await verify(root,manifest);
  const run=path.join(root,manifest.runRelative),stateFile=path.join(run,'state.json'),original=read(stateFile);
  const receiptFile=path.join(run,'transfer/receipt.json');
  const receipt={version:1,kind:'explicit-host-transfer',preparedAt:new Date().toISOString(),sourceCommit:manifest.sourceCommit,
    manifest:{sha256:await hashFile(path.join(bundle,'manifest.json')),byteLength:fs.statSync(path.join(bundle,'manifest.json')).size},
    sourceState:{sha256:sha256(fs.readFileSync(stateFile)),byteLength:fs.statSync(stateFile).size},
    permission:'User explicitly requested transfer through the public GitHub Release. Import preserves approvals, candidates, failures and raw evidence. New native sessions receive preserved task context.',
    implementationTestsReexecuted:false,reviewApprovalsIssued:false};
  const receiptBytes=Buffer.from(JSON.stringify(receipt,null,2)+'\n');
  const identity={path:path.relative(root,receiptFile).replaceAll('\\','/'),sha256:sha256(receiptBytes),byteLength:receiptBytes.length};
  const state=transferredState(original,identity);
  if(fs.existsSync(receiptFile))throw Error('A transfer receipt already exists');
  if(!regressions)throw Error('A fresh actual operating regression run is required before preparing a live transfer');
  const {runVitestChecks}=await import('../scripts/prompt15-orchestrator/run-vitest-checks.mjs');
  const out=path.join(run,`transfer/operating-checks-${Date.now()}`);const tests=await runVitestChecks(root,out,manifest.regressionFiles);
  if(!tests.pass)throw Error('Operating regressions failed; original state is retained and stop marker remains');
  fs.mkdirSync(path.dirname(receiptFile),{recursive:true});fs.writeFileSync(receiptFile,receiptBytes,{flag:'wx'});
  fs.copyFileSync(stateFile,path.join(run,'transfer/source-state.json'),fs.constants.COPYFILE_EXCL);
  // Mutable host mailboxes are archived. Immutable decisions and repair receipts stay intact.
  for(const name of ['controller.lock','retry.json','control/supervisor-audit-request.json','control/supervisor-observation.json','control/supervisor-watchdog-retries.json','control/supervisor-attention.json']){
    const file=path.join(run,name);if(!fs.existsSync(file))continue;
    const archive=path.join(run,'transfer/host-control',name);fs.mkdirSync(path.dirname(archive),{recursive:true});fs.renameSync(file,archive);}
  const {fileIdentity}=await import('../scripts/prompt15-orchestrator/protocol.mjs');
  const sourceInputs=fs.readdirSync(path.join(root,'scripts/prompt15-orchestrator')).filter(n=>n.endsWith('.mjs')).map(n=>fileIdentity(root,'scripts/prompt15-orchestrator/'+n));
  for(const name of ['tools/prompt15-transfer.mjs','tools/prompt15-transfer-core.mjs','tools/prompt15-runtime.mjs','automation/prompt15/config.json'])sourceInputs.push(fileIdentity(root,name));
  const maintenanceFile=path.join(run,'control/operating-maintenance/host-transfer.json');
  write(maintenanceFile,{kind:'verified-operating-maintenance',runId:state.runId,reason:'Explicit host transfer; no product approval changed',verifiedAt:new Date().toISOString(),sourceInputs,testResult:fileIdentity(root,path.join(out,'result.json'))});
  state.operatingMaintenance={receiptIdentity:fileIdentity(root,maintenanceFile)};
  fs.writeFileSync(stateFile,JSON.stringify(state,null,2)+'\n');
  console.log(JSON.stringify({prepared:true,status:'stopped',review:state.review,approvals:Object.keys(state.certificates),task13:state.tasks['15-13'].status,
    resumeCommand:'node tools/prompt15-runtime.mjs resume --run '+manifest.runRelative}));
  return state;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const [command,folder]=process.argv.slice(2);
  if(command==='build')await build(cliRoot,path.resolve(folder),{inventoryFile:process.argv[4]?path.resolve(process.argv[4]):null});
  else if(command==='restore')await restore(path.resolve(folder),cliRoot);
  else if(command==='verify')console.log(JSON.stringify(await verify(cliRoot,validateManifest(read(path.join(folder,'manifest.json'))))));
  else if(command==='prepare')await prepare(cliRoot,path.resolve(folder));
  else throw Error('Use build <fresh-output>, restore <bundle>, verify <bundle>, or prepare <bundle>');
}
