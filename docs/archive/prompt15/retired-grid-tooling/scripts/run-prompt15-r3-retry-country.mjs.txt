import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {jsonBytes} from './prompt14-catalog-core.mjs';
import {readJSON,fileIdentity} from './prompt15-cell-core.mjs';
const output=process.argv[2],country=process.argv[3],attempt=process.argv[4];
if(!/^[A-Z0-9]{3}$/.test(country)||!/^[a-z0-9-]+$/.test(attempt))throw Error('Invalid scoped retry identifiers');
const source=path.resolve(output,'mesh',country),dest=path.resolve(output,'history',attempt,country);
if(!source.startsWith(path.resolve(output,'mesh')+path.sep)||!dest.startsWith(path.resolve(output,'history')+path.sep)||fs.existsSync(dest)||!fs.existsSync(`${source}/process-resources.json`))throw Error('Unsafe or unfinished retry source');
fs.mkdirSync(path.dirname(dest),{recursive:true});fs.renameSync(source,dest);const refined=path.resolve(output,'refined-mesh',country);if(fs.existsSync(refined)){const rd=path.resolve(output,'history',attempt,`refined-${country}`);if(!refined.startsWith(path.resolve(output,'refined-mesh')+path.sep)||fs.existsSync(rd))throw Error('Unsafe refinement history');fs.renameSync(refined,rd);}
const args=['--expose-gc','--max-old-space-size=4096','scripts/prompt15-r3-mesh.mjs',output,country],start=performance.now(),generator=fileIdentity('scripts/prompt15-r3-cell-engine.mjs'),result=await new Promise(resolve=>{let stdout='',stderr='';const child=spawn(process.execPath,args,{stdio:['ignore','pipe','pipe']});child.stdout.on('data',d=>{stdout+=d;process.stdout.write(d);});child.stderr.on('data',d=>{stderr+=d;process.stderr.write(d);});child.on('close',exitCode=>resolve({country,exitCode,stdout,stderr,elapsedMs:performance.now()-start,command:`node ${args.join(' ')}`,generator}));});
fs.writeFileSync(`${output}/mesh/${country}/execution.json`,jsonBytes({...result,priorResources:fileIdentity(`${dest}/process-resources.json`),priorStatus:fs.existsSync(`${dest}/summary.json`)?readJSON(`${dest}/summary.json`).status:'failed-before-complete-country'}));if(result.exitCode!==0)process.exitCode=1;
