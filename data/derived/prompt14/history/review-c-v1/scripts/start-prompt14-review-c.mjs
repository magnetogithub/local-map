import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {digest,jsonBytes} from './prompt14-catalog-core.mjs';
const history='data/derived/prompt14/history/review-c-v1',root=process.cwd();
if(fs.existsSync(`${history}/snapshot.json`))throw new Error('History already exists; never replace the previous evidence');
const status=execFileSync('git',['status','--porcelain=v1','--untracked-files=all'],{encoding:'utf8'});
const files=[...new Set([...execFileSync('git',['diff','--name-only'],{encoding:'utf8'}).trim().split('\n'),...execFileSync('git',['ls-files','--others','--exclude-standard'],{encoding:'utf8'}).trim().split('\n')])].filter(p=>p&&fs.existsSync(p)&&fs.statSync(p).isFile());
const hashes=Object.fromEntries(files.map(p=>{const bytes=fs.readFileSync(p);return [p,{sha256:digest(bytes),byteLength:bytes.length}];}));
const archive=files.filter(p=>p.startsWith('reports/prompt14/')||p.startsWith('data/derived/prompt14/')||p.startsWith('data/source-locks/prompt14')||p.startsWith('scripts/')&&p.includes('prompt14'));
for(const p of archive){const dest=path.join(root,history,p);fs.mkdirSync(path.dirname(dest),{recursive:true});fs.copyFileSync(p,dest);}
const snapshot={startedAt:new Date().toISOString(),startHead:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),status,hashes,history,archivedFiles:archive};
fs.mkdirSync('.tmp/prompt14-review-c',{recursive:true});fs.writeFileSync('.tmp/prompt14-review-c/baseline.json',jsonBytes(snapshot));fs.writeFileSync(`${history}/snapshot.json`,jsonBytes(snapshot));
console.log(JSON.stringify({history,archivedFiles:archive.length,baselineFiles:files.length}));
