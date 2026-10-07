import fs from 'node:fs';
import {spawn} from 'node:child_process';
import {readJSON,fileIdentity} from './prompt15-cell-core.mjs';
import {jsonBytes} from './prompt14-catalog-core.mjs';
const output=process.argv[2],countries=readJSON(`${output}/input-summary.json`).countries.map(c=>c.countryId);
while(!countries.every(c=>fs.existsSync(`${output}/refined-mesh/${c}/summary.json`))||!fs.existsSync(`${output}/geometry-correspondence.json`))await new Promise(resolve=>setTimeout(resolve,1000));
const executions=[];
for(const args of [ ['--max-old-space-size=16384','scripts/prompt15-r3-world-final.mjs',output],['--expose-gc','--max-old-space-size=4096','scripts/prompt15-r3-audit.mjs',output],['--expose-gc','scripts/prompt15-r3-resources.mjs',output]]){
 const start=performance.now(),generator=fileIdentity(args.find(a=>a.endsWith('.mjs'))),result=await new Promise(resolve=>{let stdout='',stderr='';const child=spawn(process.execPath,args,{stdio:['ignore','pipe','pipe']});child.stdout.on('data',d=>{stdout+=d;process.stdout.write(d);});child.stderr.on('data',d=>{stderr+=d;process.stderr.write(d);});child.on('close',exitCode=>resolve({exitCode,stdout,stderr,elapsedMs:performance.now()-start,command:`node ${args.join(' ')}`,generator}));});executions.push(result);fs.writeFileSync(`${output}/world-executions.json`,jsonBytes(executions));
 if(!fs.existsSync(`${output}/world-summary.json`)){fs.writeFileSync(`${output}/world-failure.json`,jsonBytes({status:'fail',executions}));throw Error('World generation failed before complete actual artifacts');}
}
