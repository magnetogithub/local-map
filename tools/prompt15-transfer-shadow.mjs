// Independent physical restore validation. Immutable receipt contents retain
// their original D:\gen paths; filesystem calls are redirected to the restored
// test tree, with no fallback to the original workspace.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {syncBuiltinESMExports} from 'node:module';
import {isDeepStrictEqual} from 'node:util';

export function redirectWorkspace(logicalRoot,physicalRoot){
  logicalRoot=path.resolve(logicalRoot);physicalRoot=path.resolve(physicalRoot);
  if(logicalRoot.toLowerCase()===physicalRoot.toLowerCase())throw Error('An independent physical restore is required');
  let redirected=0;
  const within=(root,file)=>file.toLowerCase()===root.toLowerCase()||file.toLowerCase().startsWith(root.toLowerCase()+path.sep);
  const map=value=>{
    const file=value instanceof URL&&value.protocol==='file:'?fileURLToPath(value):value;
    if(typeof file!=='string'||!path.isAbsolute(file))return value;
    const absolute=path.resolve(file);
    if(within(physicalRoot,absolute))return value;
    if(within(logicalRoot,absolute)){redirected++;return path.join(physicalRoot,path.relative(logicalRoot,absolute));}
    return value;
  };
  const unmap=value=>typeof value==='string'&&within(physicalRoot,path.resolve(value))?
    path.join(logicalRoot,path.relative(physicalRoot,value)):value;
  const restores=[];
  const wrap=(object,name,indices=[0])=>{
    const original=object[name];if(typeof original!=='function')return;
    object[name]=function(...args){for(const i of indices)args[i]=map(args[i]);return original.apply(this,args);};
    restores.push(()=>object[name]=original);
  };
  for(const name of ['accessSync','appendFileSync','chmodSync','existsSync','lstatSync','mkdirSync','openSync','opendirSync','readdirSync','readFileSync','rmSync','rmdirSync','statSync','truncateSync','unlinkSync','utimesSync','writeFileSync','createReadStream','createWriteStream'])wrap(fs,name);
  for(const name of ['copyFileSync','cpSync','linkSync','renameSync','symlinkSync'])wrap(fs,name,[0,1]);
  for(const name of ['realpathSync','readlinkSync']){
    const original=fs[name],native=original.native;
    fs[name]=function(...args){args[0]=map(args[0]);return unmap(original.apply(this,args));};
    if(native)fs[name].native=function(...args){args[0]=map(args[0]);return unmap(native.apply(this,args));};
    restores.push(()=>fs[name]=original);
  }
  for(const name of ['access','appendFile','chmod','lstat','mkdir','open','opendir','readdir','readFile','rm','rmdir','stat','truncate','unlink','utimes','writeFile'])wrap(fs.promises,name);
  for(const name of ['copyFile','cp','link','rename','symlink'])wrap(fs.promises,name,[0,1]);
  for(const name of ['realpath','readlink']){const original=fs.promises[name];fs.promises[name]=async function(...args){args[0]=map(args[0]);return unmap(await original.apply(this,args));};restores.push(()=>fs.promises[name]=original);}
  syncBuiltinESMExports();
  return {count:()=>redirected,restore:()=>{for(const undo of restores.reverse())undo();syncBuiltinESMExports();}};
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const [physical,bundle,output]=process.argv.slice(2);
  if(!physical||!bundle||!output)throw Error('Use <independent-restored-root> <bundle> <result.json>');
  const physicalRoot=path.resolve(physical),manifestFile=path.resolve(bundle,'manifest.json'),resultFile=path.resolve(output);
  const manifest=JSON.parse(fs.readFileSync(manifestFile,'utf8'));
  const sourceState=fs.readFileSync(path.join(physicalRoot,manifest.runRelative,'state.json'));
  process.chdir(physicalRoot);
  const redirect=redirectWorkspace(manifest.sourceRoot,physicalRoot);
  let result;
  try{
    const {verify}=await import(pathToFileURL(path.join(physicalRoot,'tools/prompt15-transfer.mjs')));
    const {transferredState}=await import(pathToFileURL(path.join(physicalRoot,'tools/prompt15-transfer-core.mjs')));
    const checked=await verify(manifest.sourceRoot,manifest);
    const original=JSON.parse(sourceState),next=transferredState(original,{path:'transfer/validation-only.json',sha256:'0'.repeat(64),byteLength:0});
    if(!isDeepStrictEqual(original.tasks,next.tasks)||!isDeepStrictEqual(original.certificates,next.certificates)||next.status!=='stopped')throw Error('Transfer changed product authority');
    if(!fs.readFileSync(path.join(manifest.sourceRoot,manifest.runRelative,'state.json')).equals(sourceState))throw Error('Validation mutated stopped state');
    result={version:1,pass:true,...checked,independentPhysicalRoot:physicalRoot,originalWorkspaceFallback:false,redirectedFilesystemCalls:redirect.count(),productTasksAndApprovalsPreserved:true,runRemainsStopped:true,scope:'Actual restored bytes, npm dependency identities and original product/baseline approvals; no model turn started'};
  }finally{redirect.restore();}
  fs.writeFileSync(resultFile,JSON.stringify(result,null,2)+'\n',{flag:'wx'});
  console.log(JSON.stringify(result));
}
