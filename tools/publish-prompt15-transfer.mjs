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
if(scan.credentialMatches.length)throw Error('Publication scan did not pass');
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
      res.on('end',()=>{if(res.statusCode<200||res.statusCode>=300)return reject(Error('GitHub request failed: '+res.statusCode));try{resolve(JSON.parse(value||'{}'));}catch{reject(Error('Invalid GitHub response'));}});
    });req.on('error',reject);if(file)fs.createReadStream(file).on('error',reject).pipe(req);else req.end(data??undefined);
  });
}
const repo=await request('api.github.com','/repos/'+repository);
if(repo.owner?.login!=='magnetogithub'||!repo.permissions?.push)throw Error('Repository ownership/write access is not established');
const files=['manifest.json','publication-scan.json','summary.json',...manifest.parts.map(part=>part.name)];
const checksums=[];for(const name of files)checksums.push((await hashFile(path.join(bundle,name)))+'  '+name);
fs.writeFileSync(path.join(bundle,'SHA256SUMS.txt'),checksums.join('\n')+'\n',{flag:'wx'});files.push('SHA256SUMS.txt');
const release=await request('api.github.com','/repos/'+repository+'/releases',{method:'POST',body:{tag_name:tag,target_commitish:manifest.sourceCommit,
  name:'Prompt15 stopped-run transfer — 2026-10-16',draft:true,prerelease:true,
  body:'Windows x64 transfer at D:\\gen. Node.js 24.18.0. Preserves Prompt14/A approval evidence and task 15-13 BLOCKED; REVIEW B is not approved. No account credentials or native Codex database. Restore verifies exact file bytes and approvals, then runs operating regressions. It stays stopped until an explicit resume.\n\nInstructions: docs/automation/prompt15-transfer.md at the tagged commit.\n\nManifest SHA256: `'+await hashFile(path.join(bundle,'manifest.json'))+'`'}});
fs.writeFileSync(path.join(bundle,'release-draft.json'),JSON.stringify({id:release.id,tag,url:release.html_url},null,2)+'\n',{flag:'wx'});
for(const name of files){
  console.log(JSON.stringify({phase:'upload',asset:name,bytes:fs.statSync(path.join(bundle,name)).size}));
  const uploaded=await request('uploads.github.com',`/repos/${repository}/releases/${release.id}/assets?name=${encodeURIComponent(name)}`,{method:'POST',file:path.join(bundle,name)});
  const digest=await hashFile(path.join(bundle,name));
  if(uploaded.size!==fs.statSync(path.join(bundle,name)).size||(uploaded.digest&&uploaded.digest!=='sha256:'+digest))throw Error('Uploaded asset integrity mismatch');
}
const published=await request('api.github.com',`/repos/${repository}/releases/${release.id}`,{method:'PATCH',body:{draft:false}});
const assets=await request('api.github.com',`/repos/${repository}/releases/${release.id}/assets?per_page=100`);
if(assets.length!==files.length||published.draft)throw Error('Release publication is incomplete');
fs.writeFileSync(path.join(bundle,'published-release.json'),JSON.stringify({url:published.html_url,tag,commit:manifest.sourceCommit,assets:assets.map(asset=>({name:asset.name,size:asset.size,digest:asset.digest,url:asset.browser_download_url}))},null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({published:true,url:published.html_url,tag,assetCount:assets.length}));
