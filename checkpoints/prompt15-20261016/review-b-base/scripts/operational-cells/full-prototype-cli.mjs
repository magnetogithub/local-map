import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {gzipSync} from 'node:zlib';
import {generatePartition,shapeMetrics} from './partition-prototype.mjs';
import {loadFullSourceSamples} from './full-source-samples.mjs';
import {packPartition} from './compact-partition.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const [outputArgument,...names]=process.argv.slice(2),output=path.resolve(root,outputArgument??'');
if(!outputArgument||!path.relative(path.join(root,'.reports'),output)||path.relative(path.join(root,'.reports'),output).startsWith('..'))throw new Error('NEW_REPORT_DIRECTORY_REQUIRED');
if(fs.existsSync(output))throw new Error('PRESERVE_PREVIOUS_OUTPUT');
fs.mkdirSync(output,{recursive:true});
const physicalRelative=path.relative(fs.realpathSync(path.join(root,'.reports')),fs.realpathSync(output));
if(physicalRelative.startsWith('..')||path.isAbsolute(physicalRelative))throw new Error('REPORT_PATH_ESCAPE');
const loaded=loadFullSourceSamples(root),rows=[];
for(const sample of loaded.samples.filter(s=>!names.length||names.includes(s.name))) {
  const start=performance.now();
  try {
    const result=generatePartition(sample.parents,{candidate:'partition'}),packed=packPartition(result);
    const metrics=result.cells.map(c=>shapeMetrics(c.geometry));
    const row={name:sample.name,candidate:result.candidate,completeParentCoverage:true,cells:result.cells.length,
      sourceComponentCorrespondence:sample.correspondence.map(c=>({...c,fragments:c.fragments.map(f=>({index:f.index,areaM2:f.areaM2}))})),
      projection:sample.projection,audit:result.audit,slivers:result.slivers,
      maxDiameterKm:Math.max(...metrics.map(m=>m.diameterKm/sample.projection.scaleMin)),
      maxAspectRatio:Math.max(...metrics.map(m=>m.aspectRatio*sample.projection.scaleMax/sample.projection.scaleMin)),
      maxAreaKm2:Math.max(...metrics.map(m=>m.areaKm2/sample.projection.scaleMin**2)),
      packed:{byteLength:packed.byteLength,decodedTypedArrayBytes:packed.decodedTypedArrayBytes,layout:packed.layout,
        provenanceDictionaryEntries:packed.provenanceDictionaryEntries,membershipEntries:packed.membershipEntries},
      elapsedMs:performance.now()-start};
    const file=path.join(output,`${sample.name}.json.gz`);
    fs.writeFileSync(file,gzipSync(JSON.stringify({sample,result,measurement:row})),{flag:'wx'});
    rows.push({...row,artifact:file});process.stdout.write(JSON.stringify({name:row.name,cells:row.cells,maxDiameterKm:row.maxDiameterKm,maxAspectRatio:row.maxAspectRatio,slivers:row.slivers.countFraction,bytes:packed.byteLength,elapsedMs:row.elapsedMs})+'\n');
  } catch(error) {
    rows.push({name:sample.name,status:'generation-error',error:error.message,elapsedMs:performance.now()-start});
    process.stdout.write(JSON.stringify(rows.at(-1))+'\n');process.exitCode=1;
  }
}
fs.writeFileSync(path.join(output,'index.json'),JSON.stringify({version:1,taskId:'15-13',inputs:loaded.inputs,rows,
  verification:'geometry preparation only; controller owns Vitest',approval:'none; dependent 15-14/16/17 and REVIEW B must be regenerated'},null,2)+'\n');
