import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {gzipSync} from 'node:zlib';
import {CANDIDATES,generatePartition} from './partition-prototype.mjs';
import {loadSourceSamples} from './source-samples.mjs';

// No startup/runtime hook. Explicit offline invocation, bounded real samples.
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const [outputPath]=process.argv.slice(2);
if(!outputPath) throw new Error('Usage: node scripts/operational-cells/prototype-cli.mjs .reports/15-13/experiment.json.gz');
const reports=path.join(root,'.reports'),output=path.resolve(root,outputPath);
const rel=path.relative(reports,output);
if(!rel||rel.startsWith('..')||path.isAbsolute(rel)) throw new Error('REPORT_PATH_REQUIRED');
fs.mkdirSync(path.dirname(output),{recursive:true});
const physical=path.relative(fs.realpathSync(reports),fs.realpathSync(path.dirname(output)));
if(physical.startsWith('..')||path.isAbsolute(physical)||fs.existsSync(output)) throw new Error('NEW_REPORT_FILE_REQUIRED');
const loaded=loadSourceSamples(root),experiments=[];
for(const sample of loaded.samples) for(const candidate of CANDIDATES) {
  const start=performance.now();
  const result=generatePartition(sample.parents,{candidate});
  experiments.push({sample:sample.name,projection:sample.projection,result,elapsedMs:performance.now()-start});
}
fs.writeFileSync(output,gzipSync(JSON.stringify({version:1,taskId:'15-13',sourceInputs:loaded.sourceInputs,
  experiments,verification:'preparation only; official Vitest assertions run by controller',
  limitations:['Not a world generation or representative-policy approval','No production stable IDs or migration evidence']})),{flag:'wx'});
process.stdout.write(JSON.stringify({taskId:'15-13',experiments:experiments.map(e=>({sample:e.sample,candidate:e.result.candidate,
  cells:e.result.cells.length,edges:e.result.edges.length,slivers:e.result.slivers,elapsedMs:e.elapsedMs})),output})+'\n');
