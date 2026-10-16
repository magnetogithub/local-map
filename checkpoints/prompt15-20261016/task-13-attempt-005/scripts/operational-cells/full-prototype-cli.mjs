import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {gzipSync,gunzipSync} from 'node:zlib';
import {shapeMetrics,polygons} from './partition-prototype.mjs';
import {loadSamples,reportTarget,measuredGeneration} from './prototype-cli.mjs';
import {probeNear} from './prototype-frontier.mjs';

// A synthetic current-controller state for offline graph experiments only.
// Its seed is inside the largest actual positive-edge component; no country,
// coast, or remote island is hard coded, and no unmeshed area is counted.
function simulatedState(result) {
  const adj=new Map(result.cells.map(c=>[c.ordinal,[]]));
  for(const e of result.edges)if(e.sides.length===2){const[a,b]=e.sides.map(s=>s.ordinal);adj.get(a).push(b);adj.get(b).push(a);}
  const seen=new Set(),components=[];
  for(const c of result.cells)if(!seen.has(c.ordinal)){const queue=[c.ordinal];seen.add(c.ordinal);for(let i=0;i<queue.length;i++)for(const n of adj.get(queue[i]))if(!seen.has(n)){seen.add(n);queue.push(n);}components.push(queue);}
  const byId=new Map(result.cells.map(c=>[c.ordinal,c]));
  const metrics=new Map(result.cells.map(c=>[c.ordinal,shapeMetrics(c.geometry)]));
  components.sort((a,b)=>b.reduce((s,i)=>s+metrics.get(i).areaKm2,0)-a.reduce((s,i)=>s+metrics.get(i).areaKm2,0));
  const component=components[0],points=component.flatMap(i=>polygons(byId.get(i).geometry).flat(2));
  const centre=[(Math.min(...points.map(p=>p[0]))+Math.max(...points.map(p=>p[0])))/2,(Math.min(...points.map(p=>p[1]))+Math.max(...points.map(p=>p[1])))/2];
  const position=i=>{const p=polygons(byId.get(i).geometry).flat(2);return [p.reduce((s,v)=>s+v[0],0)/p.length,p.reduce((s,v)=>s+v[1],0)/p.length];};
  const distance=i=>{const p=position(i);return Math.hypot(p[0]-centre[0],p[1]-centre[1]);};
  const ordered=component.map(i=>[i,distance(i)]).sort((a,b)=>a[1]-b[1]||a[0]-b[0]);
  const occupied=new Set(),front=[ordered[0][0]],area=component.reduce((s,i)=>s+metrics.get(i).areaKm2,0);let selectedArea=0;
  while(front.length&&selectedArea<area*.05){front.sort((a,b)=>distance(a)-distance(b)||a-b);const id=front.shift();if(occupied.has(id))continue;
    occupied.add(id);selectedArea+=metrics.get(id).areaKm2;for(const n of adj.get(id))if(!occupied.has(n)&&!front.includes(n))front.push(n);}
  return occupied;
}
function summarize(sample,run) {
  const metrics=run.result.cells.map(c=>shapeMetrics(c.geometry)),p=sample.projection;
  return {elapsedMs:run.elapsedMs,stages:run.stages,sourceCode:run.sourceCode,cells:run.result.cells.length,edges:run.result.edges.length,
    maxDiameterKm:Math.max(...metrics.map(m=>m.diameterKm/p.scaleMin)),maxAreaKm2:Math.max(...metrics.map(m=>m.areaKm2/p.scaleMin**2)),
    maxAspectRatio:Math.max(...metrics.map(m=>m.aspectRatio*p.scaleMax/p.scaleMin)),slivers:run.result.slivers,
    audit:run.result.audit,reconstructions:run.result.mergeTrace?.filter(t=>t.treatment).length??0};
}
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..'),[argument,...names]=process.argv.slice(2);
const proposed=path.resolve(root,argument??''),incomplete=fs.existsSync(proposed)&&!fs.existsSync(path.join(proposed,'index.json'));
const output=incomplete?proposed:reportTarget(root,argument,{directory:true}),loaded=loadSamples(root,{full:true}),rows=[];
const rel=path.relative(path.join(root,'.reports'),fs.realpathSync(output));
if(!rel||rel.startsWith('..')||path.isAbsolute(rel))throw new Error('REPORT_PATH_ESCAPE');
for(const name of names)if(!loaded.samples.some(s=>s.name===name))throw new Error('UNKNOWN_SOURCE_WITNESS');
for(const sample of loaded.samples.filter(s=>!names.length||names.includes(s.name))) {
  const row={name:sample.name,projection:sample.projection,completeParentCoverage:true};
  for(const [label,implementation]of [['before','reference-v2'],['after','indexed-reconstruction']]) {
    const artifact=path.join(output,`${sample.name}-${label}.json.gz`);
    if(fs.existsSync(artifact)) {
      const saved=JSON.parse(gunzipSync(fs.readFileSync(artifact)));
      if(JSON.stringify(saved.sample)!==JSON.stringify(sample))throw new Error('CHECKPOINT_INPUT_CHANGED');
      row[label]={...saved.measurement,artifact,reusedCompletedMeasurement:true};continue;
    }
    const run=measuredGeneration(sample,'partition',implementation);
    process.stdout.write(JSON.stringify({name:sample.name,label,generationComplete:true,elapsedMs:run.elapsedMs,stages:run.stages})+'\n');
    const graphStart=performance.now(),occupied=simulatedState(run.result),initial=probeNear(run.result,sample.parents,sample.projection,occupied);
    const subsequent=initial.status==='eligible'?probeNear(run.result,sample.parents,sample.projection,new Set([...occupied,...initial.selected])):null;
    const graph={initial,subsequent,initialOccupied:[...occupied].sort((a,b)=>a-b),elapsedMs:performance.now()-graphStart,
      scenario:'connected central land-component seed occupying 5 percent of component area; not production state'};
    row[label]={...summarize(sample,run),graph};
    fs.writeFileSync(artifact,gzipSync(JSON.stringify({sample,result:run.result,measurement:row[label]})),{flag:'wx'});row[label].artifact=artifact;
    process.stdout.write(JSON.stringify({name:sample.name,label,elapsedMs:run.elapsedMs,stages:run.stages,maxAspectRatio:row[label].maxAspectRatio,
      reconstructions:row[label].reconstructions,initial:initial.status,subsequent:subsequent?.status})+'\n');
  }
  rows.push(row);
}
fs.writeFileSync(path.join(output,'index.json'),JSON.stringify({version:1,taskId:'15-13',sourceInputs:loaded.sourceInputs,rows,
  baseline:'reference-v2 lattice/polygonizer/merge with the same current independent auditor',approval:'none; actual geometry measurements, not policy selection or REVIEW B approval'},null,2)+'\n');
