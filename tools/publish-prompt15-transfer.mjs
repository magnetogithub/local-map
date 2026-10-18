// Explicit operator publishing only. Authentication stays in memory and is sent
// only to the fixed GitHub API/upload hosts for the configured owned repository.
import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import {execFileSync} from 'node:child_process';
import {hashFile} from './prompt15-transfer-core.mjs';

const [folder,tag]=process.argv.slice(2);
if(!folder||!/^prompt15-transfer-[a-zA-Z0-9.-]+$/.test(tag??''))throw Error('Use <bundle> prompt15-transfer-<id>');
const bundle=path.resolve(folder),manifest=JSON.parse(fs.readFileSync(path.join(bundle,'manifest.json')));
const scan=JSON.parse(fs.readFileSync(path.join(bundle,'publication-scan.json')));
const validation=JSON.parse(fs.readFileSync(path.join(bundle,'validation-report.json')));
if(scan.credentialMatches.length||!validation.pass||!validation.independentRestorePass||!validation.operatingRegressionPass||validation.manifestSha256!==await hashFile(path.join(bundle,'manifest.json')))throw Error('Verified independent restore, operating regressions and publication scan are required');
const credential=execFileSync('git',['credential','fill'],{input:'protocol=https\nhost=github.com\nusername=magnetogithub\n\n',encoding:'utf8',stdio:['pipe','pipe','pipe']});
const password=credential.split('\n').find(line=>line.startsWith('password='))?.slice(9);
if(!password)throw Error('Existing GitHub credentials are unavailable');
const repository='magnetogithub/local-map';
async function request(host,route,{method='GET',body=null,file=null}={}){
  if(!['api.github.com','uploads.github.com'].includes(host)||!route.startsWith('/repos/'+repository))throw Error('Unexpected publication destination');
  const data=body===null?null:Buffer.from(JSON.stringify(body));
  const size=file?fs.statSync(file).size:data?.length;
  return await new Promise((resolve,reject)=>{
    const req=https.request({host,path:route,method,headers:{Authorization:'Bearer '+password,'User-Agent':'Prompt15-transfer','Accept':'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28',
      ...(size!==undefined?{'Content-Length':size,'Content-Type':file?'application/octet-stream':'application/json'}:{})}},res=>{
      let value='';res.setEncoding('utf8');res.on('data',chunk=>{value+=chunk;if(value.length>8*1024*1024)req.destroy(Error('Oversized GitHub response'));});
      res.on('end',()=>{if(res.statusCode<200||res.statusCode>=300){const error=Error('GitHub request failed: '+res.statusCode);error.status=res.statusCode;return reject(error);}try{resolve(JSON.parse(value||'{}'));}catch{reject(Error('Invalid GitHub response'));}});
    });req.setTimeout(120000,()=>req.destroy(Error('GitHub request timed out')));req.on('error',()=>reject(Error('GitHub connection failed; rerun the same command to resume')));if(file)fs.createReadStream(file).on('error',()=>req.destroy(Error('Asset read failed'))).pipe(req);else req.end(data??undefined);
  });
}
const repo=await request('api.github.com','/repos/'+repository);
if(repo.owner?.login!=='magnetogithub'||!repo.permissions?.push)throw Error('Repository ownership/write access is not established');
const files=['manifest.json','publication-scan.json','summary.json','validation-report.json',...manifest.parts.map(part=>part.name)];
const checksums=[];for(const name of files)checksums.push((await hashFile(path.join(bundle,name)))+'  '+name);
const sums=path.join(bundle,'SHA256SUMS.txt'),sumText=checksums.join('\n')+'\n';
if(fs.existsSync(sums)&&fs.readFileSync(sums,'utf8')!==sumText)throw Error('Existing checksums belong to a different bundle');
fs.writeFileSync(sums,sumText);files.push('SHA256SUMS.txt');
let release;
const saved=path.join(bundle,'release-draft.json');
if(fs.existsSync(saved)){const draft=JSON.parse(fs.readFileSync(saved));if(draft.tag!==tag)throw Error('Preserve a different transfer release');release=await request('api.github.com',`/repos/${repository}/releases/${draft.id}`);}
else try{release=await request('api.github.com',`/repos/${repository}/releases/tags/${encodeURIComponent(tag)}`);}catch(error){if(error.status!==404)throw error;}
if(!release)release=await request('api.github.com','/repos/'+repository+'/releases',{method:'POST',body:{tag_name:tag,target_commitish:manifest.sourceCommit,
  name:'Prompt15 stopped-run transfer — '+tag,draft:true,prerelease:true,
  body:'Windows x64 transfer; default destination C:\\gen, no D: drive required. Node.js 24.18.0. Original evidence retains its D:\\gen paths and hashes; local filesystem routing resolves the restored location. Preserves Prompt14/A approval evidence and task 15-13 BLOCKED; REVIEW B is not approved. No account credentials or native Codex database. Restore verifies exact file bytes and approvals, then runs operating regressions. It stays stopped until an explicit resume.\n\nInstructions: docs/automation/prompt15-transfer.md at the tagged commit.\n\nManifest SHA256: `'+await hashFile(path.join(bundle,'manifest.json'))+'`'}});
if(release.tag_name!==tag||release.target_commitish!==manifest.sourceCommit)throw Error('Release source commit mismatch');
fs.writeFileSync(path.join(bundle,'release-draft.json'),JSON.stringify({id:release.id,tag,url:release.html_url},null,2)+'\n');
for(const name of files){
  const digest=await hashFile(path.join(bundle,name));
  const existing=(await request('api.github.com',`/repos/${repository}/releases/${release.id}/assets?per_page=100`)).find(asset=>asset.name===name);
  if(existing?.state==='uploaded'&&existing.size===fs.statSync(path.join(bundle,name)).size&&existing.digest==='sha256:'+digest){console.log(JSON.stringify({phase:'asset-verified',asset:name}));continue;}
  if(!release.draft)throw Error('Published release does not match this bundle; it will not be modified');
  if(existing)await request('api.github.com',`/repos/${repository}/releases/assets/${existing.id}`,{method:'DELETE'});
  console.log(JSON.stringify({phase:'upload',asset:name,bytes:fs.statSync(path.join(bundle,name)).size}));
  const uploaded=await request('uploads.github.com',`/repos/${repository}/releases/${release.id}/assets?name=${encodeURIComponent(name)}`,{method:'POST',file:path.join(bundle,name)});
  if(uploaded.state!=='uploaded'||uploaded.size!==fs.statSync(path.join(bundle,name)).size||uploaded.digest!=='sha256:'+digest)throw Error('Uploaded asset integrity mismatch');
}
const published=release.draft?await request('api.github.com',`/repos/${repository}/releases/${release.id}`,{method:'PATCH',body:{draft:false}}):release;
const assets=await request('api.github.com',`/repos/${repository}/releases/${release.id}/assets?per_page=100`);
if(assets.length!==files.length||published.draft)throw Error('Release publication is incomplete');
fs.writeFileSync(path.join(bundle,'published-release.json'),JSON.stringify({url:published.html_url,tag,commit:manifest.sourceCommit,assets:assets.map(asset=>({name:asset.name,size:asset.size,digest:asset.digest,url:asset.browser_download_url}))},null,2)+'\n');
console.log(JSON.stringify({published:true,url:published.html_url,tag,assetCount:assets.length}));
