import fs from 'node:fs';
import {spawn} from 'node:child_process';
import {readJSON,fileIdentity} from './prompt15-cell-core.mjs';
import {jsonBytes} from './prompt14-catalog-core.mjs';
const output=process.argv[2],run=output.replaceAll('\\','/').split('/').at(-1),reserved=new Set(readJSON('reports/prompt15/review-c-r3/history/peak-instrumentation-checkpoint.json').countries[run]),queue=readJSON(`${output}/input-summary.json`).countries.map(c=>c.countryId).filter(c=>!reserved.has(c)&&!fs.existsSync(`${output}/mesh/${c}/summary.json`)),results=[];
await Promise.all([0,1].map(async()=>{while(queue.length){const country=queue.shift(),args=['--expose-gc','--max-old-space-size=4096','scripts/prompt15-r3-mesh.mjs',output,country],start=performance.now(),generator=fileIdentity('scripts/prompt15-r3-mesh.mjs');
 const result=await new Promise(resolve=>{let stdout='',stderr='';const child=spawn(process.execPath,args,{stdio:['ignore','pipe','pipe']});child.stdout.on('data',d=>stdout+=d);child.stderr.on('data',d=>stderr+=d);child.on('close',exitCode=>resolve({country,exitCode,stdout,stderr,elapsedMs:performance.now()-start,command:`node ${args.join(' ')}`,generator}));});
 fs.writeFileSync(`${output}/mesh/${country}/execution.json`,jsonBytes(result));results.push(result);console.log(`${country}: exit ${result.exitCode}`);
}}));fs.writeFileSync(`${output}/remaining-executions.json`,jsonBytes({results:results.map(r=>({country:r.country,exitCode:r.exitCode,execution:fileIdentity(`${output}/mesh/${r.country}/execution.json`)}))}));
