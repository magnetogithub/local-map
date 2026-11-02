// Independent immutable-delivery audit. Reads explicit predecessor/candidate
// pointers and actual PBF bytes; never changes the active catalog or game.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {gunzipSync} from 'node:zlib';
import {performance} from 'node:perf_hooks';
import {VectorTile} from '@mapbox/vector-tile';
import {PbfReader} from 'pbf';
import geojsonvt from 'geojson-vt';
import {canonical,digest,geometryMetadata,polygons,jsonBytes} from '../prompt14-catalog-core.mjs';
import {ringsFromSegments} from '../prompt14-boundary-arrangement.mjs';
import {certifySubdivision} from './mesh-subdivision.mjs';
import {exactRingMoments} from '../prompt14-exact-ring.mjs';

const option=name=>{const i=process.argv.indexOf(name);if(i<0)return null;const value=process.argv[i+1];if(!value||value.startsWith('--'))throw Error(`MISSING_ARGUMENT:${name}`);return value;};
const pointerFile=option('--pointer')??process.env.CHN_CATALOG_POINTER;
const baselineFile=option('--baseline-pointer')??process.env.CHN_BASELINE_POINTER;
if(!pointerFile||!baselineFile)throw Error('USAGE: --pointer <candidate-pointer> --baseline-pointer <saved-predecessor-pointer>');
const outputReport=option('--output-report')??'reports/chn-2020/delivery-verification.json';
const read=file=>JSON.parse(fs.readFileSync(file));
const pinned=file=>{const bytes=fs.readFileSync(file);return {path:file,sha256:digest(bytes),byteLength:bytes.length};};
const started=performance.now(),targetCountries=['CHN','KOR','PRK'],extent=4096,step=8,scanCount=extent/step;
let auditStage='package-integrity';
process.on('uncaughtException',error=>{
  const failure={schemaVersion:'chn-2020-delivery-verification-v1',pass:false,pointerFile,baselineFile,stage:auditStage,error:error instanceof Error?error.message:String(error),elapsedMs:performance.now()-started,peakRssBytes:process.resourceUsage().maxRSS*1024};
  fs.mkdirSync(path.dirname(outputReport),{recursive:true});fs.writeFileSync(outputReport,jsonBytes(failure));console.error(error);process.exit(1);
});
const cmp=(a,b)=>a[0]-b[0]||a[1]-b[1],pk=p=>`${p[0]},${p[1]}`;
const segmentKey=(a,b)=>cmp(a,b)<0?`${pk(a)};${pk(b)}`:`${pk(b)};${pk(a)}`;
const sameGeometry=(a,b)=>canonical(a)===canonical(b);
const semanticParent=parent=>Object.fromEntries(Object.entries(parent).filter(([key])=>!['start','count'].includes(key)));

function load(pointerPath,verifyAll){
  const pointer=read(pointerPath),root=pointer.root,indexBytes=fs.readFileSync(`${root}/artifact-index.json`);
  assert.equal(digest(indexBytes),pointer.index.sha256,`${root} index hash`);assert.equal(indexBytes.length,pointer.index.byteLength);
  const index=JSON.parse(indexBytes),artifacts=new Map(index.artifacts.map(a=>[a.path,a]));let checkedBytes=0;
  const checked=file=>{const pin=artifacts.get(file);assert.ok(pin,`unindexed ${file}`);const bytes=fs.readFileSync(`${root}/${file}`);assert.equal(digest(bytes),pin.sha256,file);assert.equal(bytes.length,pin.byteLength,file);return bytes;};
  if(verifyAll)for(const a of index.artifacts){checkedBytes+=checked(a.path).length;}
  const gz=file=>JSON.parse(gunzipSync(checked(file)));
  const descriptor=JSON.parse(checked('catalog.json')),detail=JSON.parse(checked('detail-index.json')),parents=gz('metadata/parents.json.gz');
  assert.equal(descriptor.catalogRef.catalogVersion,pointer.catalogVersion);assert.equal(detail.ref.catalogVersion,pointer.catalogVersion);
  const rows=detail.countries.flatMap(c=>gz(c.metadata.path).rows.map(row=>({row,countryId:c.countryId})));
  const byOrdinal=new Map(rows.map(r=>[r.row[0],r])),byId=new Map(rows.map(r=>[r.row[1],r]));
  assert.equal(rows.length,descriptor.counts.cells);assert.equal(byId.size,rows.length);assert.equal(byOrdinal.size,rows.length);
  const features=countryId=>{const c=detail.countries.find(c=>c.countryId===countryId);assert.ok(c,`missing ${countryId}`);return gz(c.detail.path).features;};
  const featureMap=countryId=>new Map(features(countryId).map(f=>[byOrdinal.get(f.id).row[1],f]));
  return {pointer,root,index,artifacts,checkedBytes,checked,gz,descriptor,detail,parents,rows,byOrdinal,byId,features,featureMap};
}
const current=load(pointerFile,true),baseline=load(baselineFile,false);
assert.deepEqual(current.descriptor.countryOrder,baseline.descriptor.countryOrder);
const candidateProvenance=JSON.parse(current.checked('provenance.json'));
const baselineProvenance=JSON.parse(baseline.checked('provenance.json'));
const baselineBundlePin=baselineProvenance.inputs.find(a=>a.sha256===baselineProvenance.inputRoot);assert.ok(baselineBundlePin);
const bundleBytes=fs.readFileSync(baselineBundlePin.path);assert.equal(digest(bundleBytes),baselineBundlePin.sha256);assert.equal(bundleBytes.length,baselineBundlePin.byteLength);
const predecessorBundle=JSON.parse(bundleBytes);
auditStage='cell-detail-shards';
const shardRows=current.detail.cellDetails??[],shardsByCountry=new Map(),allShardOrdinals=new Set(),allShardPaths=new Set(),cellDetailShardReports=[];
for(const shard of shardRows){
  assert.ok(current.detail.countries.some(c=>c.countryId===shard.countryId),'unknown shard country');
  const existing=shardsByCountry.get(shard.countryId)??[];
  assert.equal(shard.artifact.path,`detail/cells/${shard.countryId}/${String(existing.length).padStart(4,'0')}.geojson.gz`);
  assert.ok(!allShardPaths.has(shard.artifact.path));allShardPaths.add(shard.artifact.path);
  assert.ok(shard.cellOrdinals.length>0&&shard.cellOrdinals.length<=64);
  for(const [i,n]of shard.cellOrdinals.entries()){assert.ok(Number.isSafeInteger(n)&&n>0);assert.equal(current.byOrdinal.get(n)?.countryId,shard.countryId);assert.ok(i===0||shard.cellOrdinals[i-1]<n);assert.ok(!allShardOrdinals.has(n),'duplicate shard ordinal');allShardOrdinals.add(n);}
  existing.push(shard);shardsByCountry.set(shard.countryId,existing);
}
for(const [countryId,shards]of shardsByCountry){
  const full=new Map(current.features(countryId).map(f=>[f.id,f])),covered=shards.flatMap(s=>s.cellOrdinals).sort((a,b)=>a-b);
  assert.deepEqual(covered,[...full.keys()].sort((a,b)=>a-b),`complete shard country coverage ${countryId}`);
  let maximumDecodedBytes=0,totalDecodedBytes=0,totalCompressedBytes=0;const oversizeSingleCellOrdinals=[];
  for(const shard of shards){
    const compressed=current.checked(shard.artifact.path),bytes=gunzipSync(compressed),value=JSON.parse(bytes);assert.equal(value.type,'FeatureCollection');
    assert.deepEqual(value.features.map(f=>f.id),shard.cellOrdinals,`full shard ID membership ${shard.artifact.path}`);
    for(const feature of value.features)assert.deepEqual(feature,full.get(feature.id),`shard preserves full exact geometry ${countryId}/${feature.id}`);
    if(shard.bbox){const bbox=value.features.reduce((box,f)=>{const b=geometryMetadata(f.geometry).bbox;return [Math.min(box[0],b[0]),Math.min(box[1],b[1]),Math.max(box[2],b[2]),Math.max(box[3],b[3])];},[180,90,-180,-90]);assert.deepEqual(shard.bbox,bbox);}
    if(bytes.length>2*1024*1024){assert.equal(value.features.length,1,'multi-cell shard exceeds 2 MiB decoded cap');oversizeSingleCellOrdinals.push(value.features[0].id);}
    maximumDecodedBytes=Math.max(maximumDecodedBytes,bytes.length);totalDecodedBytes+=bytes.length;totalCompressedBytes+=compressed.length;
  }
  cellDetailShardReports.push({countryId,cells:covered.length,shards:shards.length,maximumDecodedBytes,totalDecodedBytes,totalCompressedBytes,oversizeSingleCellOrdinals,exactFullCountryGeometryMatches:true});
}
auditStage='package-topology';
const edges=current.detail.edgeDetails.flatMap(shard=>current.gz(shard.artifact.path).edges),edgeByOrdinal=new Map(edges.map(e=>[e.ordinal,e]));
assert.equal(edges.length,current.descriptor.counts.edges);assert.equal(new Set(edges.map(e=>e.id)).size,edges.length);
const adjacency=current.gz('adjacency.json.gz'),expectedAdjacency=Array.from({length:current.rows.length},()=>new Set());
const administrativeCounts=new Map(),previousCounts=new Map();
for(const {row}of current.rows){administrativeCounts.set(row[2],(administrativeCounts.get(row[2])??0)+1);previousCounts.set(row[3],(previousCounts.get(row[3])??0)+1);}
for(const [i,p]of current.parents.administrative.entries())assert.equal(administrativeCounts.get(i+1),p.count,`admin count ${p.parentKey}`);
for(const [i,p]of current.parents.previous.entries())assert.equal(previousCounts.get(i+1),p.count,`previous count ${p.oldTerritoryId}`);
for(const edge of edges){
  assert.ok(edge.lengthKm>0);assert.ok(current.byOrdinal.has(edge.left));assert.notEqual(edge.left,edge.right);
  if(edge.right){assert.ok(current.byOrdinal.has(edge.right));expectedAdjacency[edge.left-1].add(edge.right);expectedAdjacency[edge.right-1].add(edge.left);}
  const country=!!edge.right&&current.byOrdinal.get(edge.left).countryId!==current.byOrdinal.get(edge.right).countryId;
  assert.equal(edge.flags.country,country);assert.equal(edge.flags.positiveAdjacency,edge.right>0);assert.equal(edge.boundaryClass==='coast',!edge.right);
}
assert.equal(adjacency.cellCount,current.rows.length);assert.equal(adjacency.offsets.length,current.rows.length+1);
for(const {row}of current.rows)assert.deepEqual(adjacency.neighbors.slice(adjacency.offsets[row[0]-1],adjacency.offsets[row[0]]),[...expectedAdjacency[row[0]-1]].sort((a,b)=>a-b),`adjacency ${row[1]}`);

// Certify original finite segments directly. Source-coordinate subtraction
// roundoff is larger than a determinant-only multiplication error estimate;
// each inserted point still obeys the pre-existing 1e-12 representation policy.
const subdivisionChanges=[];
auditStage='non-target-preservation';
let unchangedCountries=0,unchangedCells=0,byteExactGeometryCells=0,subdivisionEquivalentGeometryCells=0;
const retainedFeatures=new Map(),targetOrdinals=new Set(current.rows.filter(r=>targetCountries.includes(r.countryId)).map(r=>r.row[0]));
const incidentOrdinals=new Set();for(const edge of edges)if(targetOrdinals.has(edge.left)||targetOrdinals.has(edge.right)){incidentOrdinals.add(edge.left);if(edge.right)incidentOrdinals.add(edge.right);}
for(const c of baseline.detail.countries){
  const countryId=c.countryId,a=baseline.featureMap(countryId),b=current.featureMap(countryId);
  if(countryId!=='CHN'){
    assert.deepEqual([...b.keys()].sort(),[...a.keys()].sort(),`retained IDs ${countryId}`);
    for(const [id,oldFeature]of a){
      const feature=b.get(id),oldRow=baseline.byId.get(id).row,row=current.byId.get(id).row;
      if(sameGeometry(oldFeature.geometry,feature.geometry))byteExactGeometryCells++;
      else{try{subdivisionChanges.push({identity:id,...certifySubdivision(oldFeature.geometry,feature.geometry)});}catch(error){throw Error(`${id}:${error.message}`);}subdivisionEquivalentGeometryCells++;}
      assert.deepEqual(semanticParent(current.parents.administrative[row[2]-1]),semanticParent(baseline.parents.administrative[oldRow[2]-1]),`retained admin ${id}`);
      assert.deepEqual(semanticParent(current.parents.previous[row[3]-1]),semanticParent(baseline.parents.previous[oldRow[3]-1]),`retained seed lineage ${id}`);unchangedCells++;
    }unchangedCountries++;
  }
  for(const feature of b.values())if(incidentOrdinals.has(feature.id))retainedFeatures.set(feature.id,feature);
}

// Independent cancellation of exact mesh segments gives the whole country
// outline, including all island components and genuine water holes.
function countryUnion(features){
  const boundary=new Map();
  for(const f of features)for(const poly of polygons(f.geometry))for(const ring of poly)for(let i=1;i<ring.length;i++){const a=ring[i-1],b=ring[i],key=segmentKey(a,b);if(boundary.has(key))boundary.delete(key);else boundary.set(key,[a,b]);}
  return ringsFromSegments([...boundary.values()]);
}
const unionReports=[],referenceFeatures=[];
auditStage='country-union';
for(const countryId of targetCountries){
  const beforeFeatures=predecessorBundle.features.filter(f=>f.properties.countryId===countryId),afterFeatures=current.features(countryId);
  const oldUnion=countryUnion(beforeFeatures),newUnion=countryUnion(afterFeatures),before=geometryMetadata(oldUnion),after=geometryMetadata(newUnion);
  assert.equal(after.components,before.components,`${countryId} components`);assert.equal(after.holes,before.holes,`${countryId} holes`);assert.deepEqual(after.bbox,before.bbox,`${countryId} bbox`);
  const boundaryCertificate=certifySubdivision(oldUnion,newUnion);
  const exactArea=g=>polygons(g).reduce((n,p)=>n+p.reduce((a,r)=>a+exactRingMoments(r).area,0),0);
  const exactBefore=exactArea(oldUnion),exactAfter=exactArea(newUnion);
  referenceFeatures.push({type:'Feature',id:countryId,properties:{countryId},geometry:oldUnion});
  unionReports.push({countryId,cellsBefore:beforeFeatures.length,cellsAfter:afterFeatures.length,components:after.components,holes:after.holes,areaBefore:before.area,areaAfter:after.area,areaDifference:after.area-before.area,exactRingAreaBefore:exactBefore,exactRingAreaAfter:exactAfter,exactRingAreaDifference:exactAfter-exactBefore,boundaryCertificate,areaPolicy:'Area summations are diagnostic. Complete original ring, hole and finite-segment coverage is certified per coordinate at the unchanged repository representation policy; no aggregate area tolerance is widened.'});
}

// Every source edge segment must be present in both incident exact cell rings.
const exactSegments=new Map();
auditStage='exact-cell-edge-mesh';
for(const [ordinal,feature]of retainedFeatures){const set=new Set();for(const poly of polygons(feature.geometry))for(const ring of poly)for(let i=1;i<ring.length;i++)set.add(segmentKey(ring[i-1],ring[i]));exactSegments.set(ordinal,set);}
let checkedMeshEdges=0,checkedMeshSegments=0;
for(const edge of edges)if(targetOrdinals.has(edge.left)||targetOrdinals.has(edge.right)){
  checkedMeshEdges++;const coordinates=edge.geometry.coordinates;
  for(let i=1;i<coordinates.length;i++){const key=segmentKey(coordinates[i-1],coordinates[i]);for(const ordinal of [edge.left,edge.right].filter(Boolean))assert.ok(exactSegments.get(ordinal)?.has(key),`exact cell/edge mismatch edge ${edge.ordinal} side ${ordinal} segment ${i}`);checkedMeshSegments++;}
}

function scan(rings){
  const cross=Array.from({length:scanCount},()=>[]);
  for(const ring of rings)for(let i=0;i<ring.length;i++){const a=ring[i],b=ring[(i+1)%ring.length];if(a[1]===b[1])continue;
    const start=Math.max(0,Math.ceil((Math.min(a[1],b[1])-step/2)/step)),end=Math.min(scanCount,Math.ceil((Math.max(a[1],b[1])-step/2)/step));
    for(let row=start;row<end;row++){const y=row*step+step/2;cross[row].push(a[0]+(y-a[1])/(b[1]-a[1])*(b[0]-a[0]));}
  }
  return cross.map(xs=>{xs.sort((a,b)=>a-b);const out=[];for(let i=0;i+1<xs.length;i+=2){const a=Math.max(0,xs[i]),b=Math.min(extent,xs[i+1]);if(b>a+1e-8){const last=out.at(-1);if(last&&a<=last[1]+1e-8)last[1]=Math.max(last[1],b);else out.push([a,b]);}}return out;});
}
function difference(a,b){const out=[];for(const[l,r]of a){let p=l;for(const[x,y]of b){if(y<=p||x>=r)continue;if(x>p)out.push([p,Math.min(x,r)]);p=Math.max(p,y);if(p>=r)break;}if(p<r)out.push([p,r]);}return out;}
function distanceToRings(p,rings){let minimum=Infinity;for(const ring of rings)for(let i=1;i<ring.length;i++){const a=ring[i-1],b=ring[i],dx=b[0]-a[0],dy=b[1]-a[1],den=dx*dx+dy*dy,t=den?Math.max(0,Math.min(1,((p[0]-a[0])*dx+(p[1]-a[1])*dy)/den)):0;minimum=Math.min(minimum,Math.hypot(p[0]-a[0]-t*dx,p[1]-a[1]-t*dy));}return minimum;}
const inCore=p=>p[0]>0&&p[0]<extent&&p[1]>0&&p[1]<extent;
const projectedPoint=(p,z,x,y)=>{const sin=Math.sin(p[1]*Math.PI/180),scale=extent*2**z;return [Math.round((p[0]/360+0.5)*scale-x*extent),Math.round((0.5-Math.log((1+sin)/(1-sin))/(4*Math.PI))*scale-y*extent)];};
function quantizedArea(geometry,z,x,y){return polygons(geometry).reduce((sum,poly)=>sum+poly.reduce((area,ring)=>{const ps=ring.map(p=>projectedPoint(p,z,x,y));return area+ps.slice(1).reduce((n,b,i)=>n+ps[i][0]*b[1]-b[0]*ps[i][1],0)/2;},0),0);}
const reference=geojsonvt({type:'FeatureCollection',features:referenceFeatures},{maxZoom:6,indexMaxZoom:4,indexMaxPoints:100000,tolerance:0,extent,buffer:64});
const renderedArea=[],tileEdgeReports=[],subpixelExceptions=[];
auditStage='decoded-tile-fill-and-edges';
let negativeControlDetected=false;
for(let z=0;z<=6;z++){
  const totals=Object.fromEntries(targetCountries.map(countryId=>[countryId,{countryId,referenceArea:0,actualArea:0,missingArea:0,extraArea:0,interiorMissingSamples:0,interiorExtraSamples:0,checkedTiles:0}]));
  let decodedTiles=0,edgeSamples=0,maxEdgeDeviationUnits=0;
  for(let x=0;x<2**z;x++)for(let y=0;y<2**z;y++){
    const ref=reference.getTile(z,x,y);if(!ref?.features.length)continue;decodedTiles++;
    const tile=new VectorTile(new PbfReader(gunzipSync(current.checked(`tiles/${z}/${x}/${y}.pbf.gz`)))),layer=tile.layers.territories,fillByOrdinal=new Map(),countryRings=new Map(targetCountries.map(c=>[c,[]]));
    if(layer)for(let i=0;i<layer.length;i++){const feature=layer.feature(i),row=current.byOrdinal.get(feature.id);assert.ok(row,`unknown tile cell ${feature.id}`);const rings=feature.loadGeometry().map(r=>r.map(p=>[p.x,p.y]));fillByOrdinal.set(feature.id,rings);if(countryRings.has(row.countryId))countryRings.get(row.countryId).push(...rings);}
    for(const countryId of targetCountries){
      const rings=ref.features.filter(f=>f.tags.countryId===countryId).flatMap(f=>f.geometry);if(!rings.length)continue;
      const expectedRows=scan(rings),actualRows=scan(countryRings.get(countryId)),total=totals[countryId];total.checkedTiles++;
      for(let row=0;row<scanCount;row++){
        total.referenceArea+=expectedRows[row].reduce((n,[a,b])=>n+(b-a)*step,0);total.actualArea+=actualRows[row].reduce((n,[a,b])=>n+(b-a)*step,0);
        const missing=difference(expectedRows[row],actualRows[row]),extra=difference(actualRows[row],expectedRows[row]);
        total.missingArea+=missing.reduce((n,[a,b])=>n+(b-a)*step,0);total.extraArea+=extra.reduce((n,[a,b])=>n+(b-a)*step,0);
        for(const[a,b]of missing)if(distanceToRings([(a+b)/2,row*step+step/2],rings)>1.5)total.interiorMissingSamples++;
        for(const[a,b]of extra)if(distanceToRings([(a+b)/2,row*step+step/2],rings)>1.5)total.interiorExtraSamples++;
        // Empty delivered fill must fail this exact same detector on a real
        // interior CHN interval, proving that IDs alone cannot pass coverage.
        if(!negativeControlDetected&&countryId==='CHN')for(const[a,b]of expectedRows[row])if(distanceToRings([(a+b)/2,row*step+step/2],rings)>1.5)negativeControlDetected=true;
      }
    }
    const lineLayer=tile.layers.edges;if(lineLayer)for(let i=0;i<lineLayer.length;i++){
      const feature=lineLayer.feature(i),edge=edgeByOrdinal.get(feature.id);assert.ok(edge,`unknown tile edge ${feature.id}`);
      if(!targetOrdinals.has(edge.left)&&!targetOrdinals.has(edge.right))continue;
      for(const line of feature.loadGeometry())for(let k=1;k<line.length;k++){
        const a=[line[k-1].x,line[k-1].y],b=[line[k].x,line[k].y];if(a[0]===b[0]&&a[1]===b[1])continue;
        for(const p of [a,[(a[0]+b[0])/2,(a[1]+b[1])/2],b].filter(inCore))for(const side of [edge.left,edge.right].filter(Boolean)){
          edgeSamples++;const fill=fillByOrdinal.get(side),distance=fill?distanceToRings(p,fill):Infinity;
          if(distance<=1.5){maxEdgeDeviationUnits=Math.max(maxEdgeDeviationUnits,distance);continue;}
          const source=retainedFeatures.get(side);assert.ok(source,`missing exact side ${side}`);
          const area=quantizedArea(source.geometry,z,x,y),length=Math.hypot(b[0]-a[0],b[1]-a[1]);
          if(area===0||length<=1.5){subpixelExceptions.push({tile:[z,x,y],edgeOrdinal:edge.ordinal,cellOrdinal:side,coordinate:p,quantizedWholeCellArea:area,decodedSegmentLengthUnits:length,reason:area===0?'whole-cell-integer-area-collapse':'segment-within-original-quantization-bound'});continue;}
          assert.fail(`delivered fill/edge mismatch z${z}/${x}/${y} edge ${edge.ordinal} cell ${side} at ${p}: ${distance} units`);
        }
      }
    }
  }
  const zoom={zoom:z,decodedTiles,countries:Object.values(totals),quantizationCoastToleranceUnits:1.5,samplingStepUnits:step};renderedArea.push(zoom);
  tileEdgeReports.push({zoom:z,decodedTiles,edgeSamples,maxEdgeDeviationUnits,quantizationToleranceUnits:1.5});
  console.log(JSON.stringify({zoom:z,decodedTiles,missing:Object.values(totals).reduce((n,t)=>n+t.interiorMissingSamples,0),extra:Object.values(totals).reduce((n,t)=>n+t.interiorExtraSamples,0),edgeSamples}));
  for(const total of Object.values(totals)){assert.equal(total.interiorMissingSamples,0,`${total.countryId} interior missing z${z}`);assert.equal(total.interiorExtraSamples,0,`${total.countryId} interior extra z${z}`);}
}
assert.ok(negativeControlDetected,'empty CHN tile negative control failed to detect missing interior fill');
const borderReport=(a,b)=>{const selected=edges.filter(e=>e.right&&new Set([current.byOrdinal.get(e.left).countryId,current.byOrdinal.get(e.right).countryId]).size===2&&[current.byOrdinal.get(e.left).countryId,current.byOrdinal.get(e.right).countryId].every(c=>[a,b].includes(c)));return {countries:[a,b],edges:selected.length,lengthKm:selected.reduce((n,e)=>n+e.lengthKm,0)};};
const report={schemaVersion:'chn-2020-delivery-verification-v1',pass:true,pointer:pinned(pointerFile),baselinePointer:pinned(baselineFile),catalogVersion:current.pointer.catalogVersion,baselineCatalogVersion:baseline.pointer.catalogVersion,counts:current.descriptor.counts,artifactsVerified:current.index.artifacts.length,checkedBytes:current.checkedBytes,cellDetailShards:{pass:true,optionalBackwardCompatible:true,countries:cellDetailShardReports,totalShards:shardRows.length,allIndexedCountryOrdinalsCoveredExactly:true},nonTargetPreservation:{pass:true,countries:unchangedCountries,cells:unchangedCells,byteExactGeometryCells,subdivisionEquivalentGeometryCells,subdivisionChanges,administrativeMembershipPreserved:true,seedLineagePreserved:true},unionReports,adjacency:{pass:true,symmetric:true,phantomNeighbors:0},mesh:{pass:true,checkedEdges:checkedMeshEdges,checkedSegments:checkedMeshSegments,exactBothIncidentCellRings:true},borders:[borderReport('CHN','PRK'),borderReport('KOR','PRK')],renderedArea,tileEdgeReports,subpixelExceptions,negativeControl:{emptyChnFillRejected:negativeControlDetected},provenance:{stage:candidateProvenance.stage,incrementalVerification:candidateProvenance.incrementalVerification??null},elapsedMs:performance.now()-started,peakRssBytes:process.resourceUsage().maxRSS*1024,method:'Actual hashed candidate PBF decoding at zooms 0–6. Separate CHN/KOR/PRK scanline fill coverage against the immutable predecessor union, 8-unit row sampling and unchanged 1.5-unit quantization coast bound. Edge vertices and segment midpoints checked against both incident decoded fill boundaries; per-coordinate subpixel exceptions recorded. Exact detail mesh segments, symmetric adjacency, ID-mapped non-target geometry and administrative/seed parent semantics independently checked.'};
fs.mkdirSync(path.dirname(outputReport),{recursive:true});fs.writeFileSync(outputReport,jsonBytes(report));console.log(JSON.stringify({pass:true,outputReport,counts:report.counts,elapsedMs:report.elapsedMs,subpixelExceptions:subpixelExceptions.length}));
