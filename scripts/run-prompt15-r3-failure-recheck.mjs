import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {readJSON,fileIdentity} from './prompt15-cell-core.mjs';
import {jsonBytes} from './prompt14-catalog-core.mjs';
const output=process.argv[2],countries=process.argv.slice(3),results=[];
for(const country of countries){const source=path.resolve(output,'mesh',country),dest=path.resolve(output,'history','legacy-topology-failure',country);if(!source.startsWith(path.resolve(output,'mesh')+path.sep)||!dest.startsWith(path.resolve(output,'history')+path.sep)||fs.existsSync(dest)||!fs.existsSync(`${source}/execution.json`))throw Error('Unsafe or unfinished failure attempt');
 const before=readJSON(`${source}/failure.json`);if(!before.message.startsWith('Topology boundary certification failed'))throw Error('Unexpected failure requires separate diagnosis');fs.mkdirSync(path.dirname(dest),{recursive:true});fs.renameSync(source,dest);
 const args=['--expose-gc','--max-old-space-size=4096','scripts/prompt15-r3-mesh.mjs',output,country],start=performance.now(),result=await new Promise(resolve=>{let stdout='',stderr='';const child=spawn(process.execPath,args,{stdio:['ignore','pipe','pipe']});child.stdout.on('data',d=>stdout+=d);child.stderr.on('data',d=>stderr+=d);child.on('close',exitCode=>resolve({country,exitCode,stdout,stderr,elapsedMs:performance.now()-start,command:`node ${args.join(' ')}`}));});fs.writeFileSync(`${output}/mesh/${country}/execution.json`,jsonBytes(result));results.push({...result,priorFailure:fileIdentity(path.join(dest,'failure.json'))});console.log(`${country}: complete candidate generation exit ${result.exitCode}; original topology failure retained`);
}
fs.writeFileSync(`${output}/legacy-topology-recheck.json`,jsonBytes({results,scope:'Produce complete diagnostic geometry even when local topology certification rejects it. The failed local check remains false and REVIEW C cannot pass by this continuation; global topology is independently verified from actual candidate bytes.'}));
