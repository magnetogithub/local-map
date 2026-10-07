import fs from 'node:fs';
import {spawn} from 'node:child_process';
import {readJSON,fileIdentity} from './prompt15-cell-core.mjs';
import {jsonBytes} from './prompt14-catalog-core.mjs';
const output=process.argv[2],countries=readJSON(`${output}/input-summary.json`).countries.map(c=>c.countryId),results=[];
for(const country of countries){
 // Old peak-measurement attempts must be replaced before final refinement.
 while(!fs.existsSync(`${output}/mesh/${country}/process-resources.json`)||!fs.existsSync(`${output}/mesh/${country}/execution.json`))await new Promise(resolve=>setTimeout(resolve,1000));
 if(fs.existsSync(`${output}/refined-mesh/${country}/summary.json`))continue;
 const args=['--expose-gc','--max-old-space-size=4096','scripts/prompt15-r3-refine.mjs',output,country],start=performance.now(),result=await new Promise(resolve=>{let stdout='',stderr='';const child=spawn(process.execPath,args,{stdio:['ignore','pipe','pipe']});child.stdout.on('data',d=>stdout+=d);child.stderr.on('data',d=>stderr+=d);child.on('close',exitCode=>resolve({country,exitCode,stdout,stderr,elapsedMs:performance.now()-start,command:`node ${args.join(' ')}`}));});
 if(!fs.existsSync(`${output}/refined-mesh/${country}`))fs.mkdirSync(`${output}/refined-mesh/${country}`,{recursive:true});fs.writeFileSync(`${output}/refined-mesh/${country}/execution.json`,jsonBytes(result));results.push(result);console.log(`${country}: refinement exit ${result.exitCode}`);
 if(!fs.existsSync(`${output}/refined-mesh/${country}/summary.json`))throw Error(`Refinement did not produce a complete country: ${country}`);
}
fs.writeFileSync(`${output}/refinement-executions.json`,jsonBytes({results:results.map(r=>({country:r.country,exitCode:r.exitCode,execution:fileIdentity(`${output}/refined-mesh/${r.country}/execution.json`)}))}));
