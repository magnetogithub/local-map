import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {jsonBytes} from './prompt14-catalog-core.mjs';
import {fileIdentity,readJSON} from './prompt15-cell-core.mjs';
const output=process.argv[2]??'reports/prompt15/review-c-r3',checks=[];
const inputs=fs.readdirSync('src',{recursive:true}).filter(n=>fs.statSync(path.join('src',n)).isFile()).map(n=>fileIdentity(path.join('src',n))).concat(['package.json','package-lock.json','tsconfig.json','next.config.ts',...fs.readdirSync('scripts').filter(n=>n.includes('r3')).map(n=>`scripts/${n}`)].map(fileIdentity));
for(const args of [ ['--test','scripts/prompt15-r3.node-test.mjs','scripts/prompt15-cells.node-test.mjs'],['node_modules/vitest/vitest.mjs','run'],['node_modules/typescript/bin/tsc','--noEmit'],['node_modules/eslint/bin/eslint.js','.']]){
 console.log(`Checking node ${args.join(' ')}`);const start=performance.now(),r=spawnSync(process.execPath,args,{encoding:'utf8',maxBuffer:64*1024**2});checks.push({command:`node ${args.join(' ')}`,exitCode:r.status,status:r.status===0?'pass':'fail',elapsedMs:performance.now()-start,stdout:r.stdout,stderr:r.stderr,error:r.error?.message??null});
 fs.writeFileSync(`${output}/validation-progress.json`,jsonBytes({checks}));
}
const scratch=path.resolve('.tmp/prompt15-r3-build'),links=['node_modules','data','public','scripts','reports'];
if(!scratch.startsWith(path.resolve('.tmp')+path.sep)||fs.existsSync(scratch))throw Error('Unsafe or occupied isolated build path');
fs.mkdirSync(scratch,{recursive:true});
try{
 fs.cpSync('src',path.join(scratch,'src'),{recursive:true});
 for(const name of ['package.json','package-lock.json','tsconfig.json','next-env.d.ts','next.config.ts','postcss.config.mjs','vitest.config.ts','vitest.setup.ts'])if(fs.existsSync(name))fs.copyFileSync(name,path.join(scratch,name));
 for(const name of links)fs.symlinkSync(path.resolve(name),path.join(scratch,name),'junction');
 const args=['node_modules/next/dist/bin/next','build',scratch,'--webpack'];console.log('Checking fresh isolated Next build');const start=performance.now(),r=spawnSync(process.execPath,args,{encoding:'utf8',maxBuffer:64*1024**2});checks.push({command:`node ${args.join(' ')}`,exitCode:r.status,status:r.status===0?'pass':'fail',elapsedMs:performance.now()-start,stdout:r.stdout,stderr:r.stderr,error:r.error?.message??null});
}finally{
 for(const name of links){const p=path.join(scratch,name);if(fs.existsSync(p)){if(!fs.lstatSync(p).isSymbolicLink())throw Error(`Unexpected non-link: ${p}`);fs.rmdirSync(p);}}
 if(path.resolve(scratch)!==path.resolve('.tmp/prompt15-r3-build'))throw Error('Unsafe build cleanup target');fs.rmSync(scratch,{recursive:true});
}
const unchanged=inputs.every(a=>fileIdentity(a.path).sha256===a.sha256),result={status:checks.every(c=>c.status==='pass')&&unchanged?'pass':'fail',checks,inputs,unchanged,tools:{node:process.version,next:readJSON('node_modules/next/package.json').version},scope:'Offline revised REVIEW C validators and complete application regression; fresh isolated build. No production catalog cutover.'};
fs.writeFileSync(`${output}/validation.json`,jsonBytes(result));console.log(JSON.stringify({status:result.status,checks:checks.map(c=>({command:c.command,status:c.status}))}));if(result.status!=='pass')process.exitCode=1;
