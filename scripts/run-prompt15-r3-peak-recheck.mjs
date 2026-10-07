import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {readJSON,fileIdentity} from './prompt15-cell-core.mjs';
import {jsonBytes} from './prompt14-catalog-core.mjs';
const revision='reports/prompt15/review-c-r3',run=process.argv[2],output=`${revision}/${run}`,checkpoint=readJSON(`${revision}/history/peak-instrumentation-checkpoint.json`),queue=checkpoint.countries[run].slice(),results=[];
while(queue.length){let index=queue.findIndex(c=>fs.existsSync(`${output}/mesh/${c}/execution.json`));if(index<0){await new Promise(resolve=>setTimeout(resolve,1000));continue;}
 const country=queue.splice(index,1)[0],source=path.resolve(output,'mesh',country),dest=path.resolve(output,'history','mesh-before-peak',country);
 if(!source.startsWith(path.resolve(output,'mesh')+path.sep)||!dest.startsWith(path.resolve(output,'history')+path.sep)||fs.existsSync(dest))throw Error('Unsafe or occupied history move');
 fs.mkdirSync(path.dirname(dest),{recursive:true});fs.renameSync(source,dest);
 const refined=path.resolve(output,'refined-mesh',country);if(fs.existsSync(refined)){const refinedDest=path.resolve(output,'history','refined-before-peak',country);if(!refined.startsWith(path.resolve(output,'refined-mesh')+path.sep)||fs.existsSync(refinedDest))throw Error('Unsafe refinement move');fs.mkdirSync(path.dirname(refinedDest),{recursive:true});fs.renameSync(refined,refinedDest);}
 const args=['--expose-gc','--max-old-space-size=4096','scripts/prompt15-r3-mesh.mjs',output,country],start=performance.now(),result=await new Promise(resolve=>{let stdout='',stderr='';const child=spawn(process.execPath,args,{stdio:['ignore','pipe','pipe']});child.stdout.on('data',d=>stdout+=d);child.stderr.on('data',d=>stderr+=d);child.on('close',exitCode=>resolve({country,exitCode,stdout,stderr,elapsedMs:performance.now()-start,command:`node ${args.join(' ')}`,generator:fileIdentity('scripts/prompt15-r3-mesh.mjs')}));});
 const before=readJSON(path.join(dest,'summary.json')),after=readJSON(`${output}/mesh/${country}/summary.json`),sameBytes=before.chunks.length===after.chunks.length&&before.chunks.every((c,i)=>c.sha256===after.chunks[i].sha256&&c.byteLength===after.chunks[i].byteLength);
 fs.writeFileSync(`${output}/mesh/${country}/execution.json`,jsonBytes(result));results.push({...result,stdout:undefined,stderr:undefined,sameBytes,originalSummary:fileIdentity(path.join(dest,'summary.json')),newSummary:fileIdentity(`${output}/mesh/${country}/summary.json`)});console.log(`${country}: recheck exit ${result.exitCode}, exact original mesh bytes ${sameBytes}`);
}
fs.writeFileSync(`${output}/peak-memory-recheck.json`,jsonBytes({status:results.every(r=>r.sameBytes)?'pass':'fail',results,scope:'Fresh generation with process.resourceUsage maximum RSS and the same JSTS ray-crossing predicate using its interval index. Earlier generated geometry bytes remain archived and are compared exactly.'}));
