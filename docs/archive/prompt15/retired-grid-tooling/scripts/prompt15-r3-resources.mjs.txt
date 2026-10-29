import fs from 'node:fs';
import {performance} from 'node:perf_hooks';
import {CELL_EXPERIMENT_POLICY as P} from './prompt15-cell-policy.mjs';
import {jsonBytes} from './prompt14-catalog-core.mjs';
import {fileIdentity,readJSON} from './prompt15-cell-core.mjs';
const output=process.argv[2];
if(fs.existsSync(`${output}/resource-measurement.json`)){
 const previous=readJSON(`${output}/resource-measurement.json`);
 if(!previous.inputs.every(i=>{const actual=fileIdentity(i.path);return actual.sha256===i.sha256&&actual.byteLength===i.byteLength;}))throw Error('Preserve initial measurement: a pinned byte changed');
 console.log(`Reusing completed actual full-world measurement with unchanged inputs: ${previous.status}`);process.exit(previous.status==='pass'?0:1);
}
global.gc();const before=process.memoryUsage(),start=performance.now();
const metadata=JSON.parse(fs.readFileSync(`${output}/world/metadata.json`,'utf8')),state=JSON.parse(fs.readFileSync(`${output}/world/inheritance-state-fixture.json`,'utf8'));
const count=metadata.territories.length,ordinals=new Map(metadata.territories.map((c,i)=>[c.id,i+1]));
if(count!==state.territoryOrder.length||state.territoryOrder.some((id,i)=>ordinals.get(id)!==i+1)||Object.keys(state.territoriesById).length!==count)throw Error('Initial state ordinal or count mismatch');
globalThis.initialRetention={metadata,state,ordinals};global.gc();const after=process.memoryUsage(),elapsedMs=performance.now()-start,retainedHeapBytes=after.heapUsed-before.heapUsed;
const result={status:retainedHeapBytes*2<=P.budgets.clientInitialHeapBytes&&retainedHeapBytes*3<=P.budgets.serverInitialHeapBytes&&elapsedMs<=P.budgets.initialConstructionMs?'pass':'fail',recordCount:count,retainedHeapBytes,actualRssBytes:after.rss,elapsedMs,before,after,reviewBReserveComparison:{client:retainedHeapBytes*2,server:retainedHeapBytes*3,clientBudget:P.budgets.clientInitialHeapBytes,serverBudget:P.budgets.serverInitialHeapBytes},checks:{client:retainedHeapBytes*2<=P.budgets.clientInitialHeapBytes,server:retainedHeapBytes*3<=P.budgets.serverInitialHeapBytes,constructionTime:elapsedMs<=P.budgets.initialConstructionMs},method:'Fresh Node process parses and retains the FULL actual world V3 metadata and inherited state bytes plus bijective ID ordinal map across GC. Direct whole-world measurement, no country scaling. REVIEW B 2x client / 3x server reserves retained. Offline initial data construction; browser runtime and future tool-layer initialization remain outside REVIEW C.',command:`node --expose-gc scripts/prompt15-r3-resources.mjs ${output}`};
result.inputs=['scripts/prompt15-r3-resources.mjs','scripts/prompt15-cell-policy.mjs',`${output}/world/metadata.json`,`${output}/world/inheritance-state-fixture.json`].map(fileIdentity);
fs.writeFileSync(`${output}/resource-measurement.json`,jsonBytes(result));console.log(JSON.stringify(result));if(result.status!=='pass')process.exitCode=1;
