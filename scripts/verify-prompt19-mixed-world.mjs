// Independent read-only package, topology, envelope and rendered-area checks.
import fs from 'node:fs';
import path from 'node:path';
import {gunzipSync} from 'node:zlib';
import assert from 'node:assert/strict';
import {VectorTile} from '@mapbox/vector-tile';
import {PbfReader} from 'pbf';
import geojsonvt from 'geojson-vt';
import {digest,geometryMetadata,polygons,jsonBytes} from './prompt14-catalog-core.mjs';
import {ringsFromSegments} from './prompt14-boundary-arrangement.mjs';

const outputReportIndex=process.argv.indexOf('--output-report');
if(outputReportIndex>=0&&(!process.argv[outputReportIndex+1]||process.argv[outputReportIndex+1].startsWith('--')))throw Error('MISSING_OUTPUT_REPORT_PATH');
const outputReport=outputReportIndex<0?'reports/maintenance/prompt19-C/mixed-verification.json':process.argv[outputReportIndex+1];
const read=f=>JSON.parse(fs.readFileSync(f)),pointer=read('data/runtime/operational-catalog/current.json'),root=pointer.root;
const gz=f=>JSON.parse(gunzipSync(fs.readFileSync(`${root}/${f}`)));
const idx=fs.readFileSync(`${root}/artifact-index.json`);assert.equal(digest(idx),pointer.index.sha256);assert.equal(idx.length,pointer.index.byteLength);
let checkedBytes=0;for(const a of JSON.parse(idx).artifacts){const bytes=fs.readFileSync(`${root}/${a.path}`);assert.equal(digest(bytes),a.sha256,a.path);assert.equal(bytes.length,a.byteLength);checkedBytes+=bytes.length;}
const descriptor=read(`${root}/catalog.json`),detail=read(`${root}/detail-index.json`),parents=gz('metadata/parents.json.gz');
const rows=detail.countries.flatMap(c=>gz(c.metadata.path).rows.map(r=>({r,countryId:c.countryId})));
const rowByOrdinal=new Map(rows.map(r=>[r.r[0],r]));
const edges=detail.edgeDetails.flatMap(s=>gz(s.artifact.path).edges);
const adjacency=gz('adjacency.json.gz'),baseline=read('data/derived/prompt19/baseline-v1/country-envelopes.geojson');
assert.equal(rows.length,descriptor.counts.cells);assert.equal(new Set(rows.map(r=>r.r[1])).size,rows.length);
assert.equal(edges.length,descriptor.counts.edges);assert.equal(new Set(edges.map(e=>e.id)).size,edges.length);
let koreaBorderEdges=0,koreaBorderLengthKm=0;
for(const e of edges){assert.ok(e.lengthKm>0);assert.ok(rowByOrdinal.has(e.left));assert.notEqual(e.left,e.right);
  if(e.right){assert.ok(rowByOrdinal.has(e.right));for(const[a,b]of[[e.left,e.right],[e.right,e.left]])assert.ok(adjacency.neighbors.slice(adjacency.offsets[a-1],adjacency.offsets[a]).includes(b));
    if(new Set([rowByOrdinal.get(e.left).countryId,rowByOrdinal.get(e.right).countryId]).size===2&&[rowByOrdinal.get(e.left).countryId,rowByOrdinal.get(e.right).countryId].every(c=>['KOR','PRK'].includes(c))){koreaBorderEdges++;koreaBorderLengthKm+=e.lengthKm;}
  }
}
for(const[field,ps]of[[2,parents.administrative],[3,parents.previous]])for(const[i,p]of ps.entries())assert.equal(rows.filter(({r})=>r[field]===i+1).length,p.count);
const unionReports=[],koreaOrdinals=new Set(rows.filter(r=>['KOR','PRK'].includes(r.countryId)).map(r=>r.r[0]));
const cmp=(a,b)=>a[0]-b[0]||a[1]-b[1],pk=p=>`${p[0]},${p[1]}`;
for(const countryId of['KOR','PRK']){
  const fc=gz(`detail/countries/${countryId}.geojson.gz`),boundary=new Map();
  for(const f of fc.features)for(const p of polygons(f.geometry))for(const ring of p)for(let i=1;i<ring.length;i++){const a=ring[i-1],b=ring[i],key=cmp(a,b)<0?`${pk(a)};${pk(b)}`:`${pk(b)};${pk(a)}`;if(boundary.has(key))boundary.delete(key);else boundary.set(key,[a,b]);}
  const union=ringsFromSegments([...boundary.values()]),actual=geometryMetadata(union),expected=geometryMetadata(baseline.features.find(f=>f.properties.countryId===countryId).geometry);
  assert.equal(actual.components,expected.components);assert.equal(actual.holes,expected.holes);assert.deepEqual(actual.bbox,expected.bbox);assert.ok(Math.abs(actual.area-expected.area)<1e-11);
  unionReports.push({countryId,cells:fc.features.length,unionComponents:actual.components,unionHoles:actual.holes,area:actual.area,baselineArea:expected.area,areaDifference:actual.area-expected.area});
}
// All other country exact polygons and IDs must match the coarse predecessor, verbatim.
let unchangedCountries=0;
for(const c of detail.countries.filter(c=>!['KOR','PRK'].includes(c.countryId))){
  const oldRoot='data/derived/prompt19/coarse-world-v1',oldRows=JSON.parse(gunzipSync(fs.readFileSync(`${oldRoot}/${c.metadata.path}`))).rows;
  const old=JSON.parse(gunzipSync(fs.readFileSync(`${oldRoot}/${c.detail.path}`))).features;
  const current=gz(c.detail.path).features,currentRows=gz(c.metadata.path).rows;
  const a=new Map(old.map((f,i)=>[oldRows[i][1],f.geometry])),b=new Map(current.map((f,i)=>[currentRows[i][1],f.geometry]));assert.deepEqual(b,a);unchangedCountries++;
}

// Scanline area integration on actual decoded/quantized vector polygons at EVERY zoom.
// The only allowed disagreement is within 1.5 quantization units of the immutable coast.
// This detects missing interior land even when all feature IDs appear in some other tile.
const extent=4096,step=8,scanCount=extent/step;
function scan(rings){const cross=Array.from({length:scanCount},()=>[]);
  for(const ring of rings)for(let i=0;i<ring.length;i++){const a=ring[i],b=ring[(i+1)%ring.length];if(a[1]===b[1])continue;
    const start=Math.max(0,Math.ceil((Math.min(a[1],b[1])-step/2)/step)),end=Math.min(scanCount,Math.ceil((Math.max(a[1],b[1])-step/2)/step));
    for(let row=start;row<end;row++){const y=row*step+step/2;cross[row].push(a[0]+(y-a[1])/(b[1]-a[1])*(b[0]-a[0]));}
  }
  return cross.map(xs=>{xs.sort((a,b)=>a-b);const out=[];for(let i=0;i+1<xs.length;i+=2){const a=Math.max(0,xs[i]),b=Math.min(extent,xs[i+1]);if(b>a+1e-8){const last=out.at(-1);if(last&&a<=last[1]+1e-8)last[1]=Math.max(last[1],b);else out.push([a,b]);}}return out;});
}
function difference(a,b){const out=[];for(const[l,r]of a){let p=l;for(const[x,y]of b){if(y<=p||x>=r)continue;if(x>p)out.push([p,Math.min(x,r)]);p=Math.max(p,y);if(p>=r)break;}if(p<r)out.push([p,r]);}return out;}
function distanceToRings(p,rings){let minimum=Infinity;for(const ring of rings)for(let i=0;i<ring.length;i++){const a=ring[i],b=ring[(i+1)%ring.length],dx=b[0]-a[0],dy=b[1]-a[1],den=dx*dx+dy*dy,t=den?Math.max(0,Math.min(1,((p[0]-a[0])*dx+(p[1]-a[1])*dy)/den)):0;minimum=Math.min(minimum,Math.hypot(p[0]-a[0]-t*dx,p[1]-a[1]-t*dy));}return minimum;}
const reference=geojsonvt(baseline,{maxZoom:6,indexMaxZoom:4,indexMaxPoints:100000,tolerance:0,extent,buffer:64});
const renderedArea=[];
for(let z=0;z<=6;z++){
  let referenceArea=0,actualArea=0,missingArea=0,extraArea=0,interiorMissingSamples=0,checkedTiles=0;
  for(let x=0;x<2**z;x++)for(let y=0;y<2**z;y++){
    const ref=reference.getTile(z,x,y);if(!ref?.features.length)continue;checkedTiles++;
    const rings=ref.features.flatMap(f=>f.geometry),referenceRows=scan(rings);
    const tile=new VectorTile(new PbfReader(gunzipSync(fs.readFileSync(`${root}/tiles/${z}/${x}/${y}.pbf.gz`)))),layer=tile.layers.territories,actualRings=[];
    if(layer)for(let i=0;i<layer.length;i++){const f=layer.feature(i);if(koreaOrdinals.has(f.id))actualRings.push(...f.loadGeometry().map(r=>r.map(p=>[p.x,p.y])));}
    const actualRows=scan(actualRings);
    for(let row=0;row<scanCount;row++){
      referenceArea+=referenceRows[row].reduce((n,[a,b])=>n+(b-a)*step,0);actualArea+=actualRows[row].reduce((n,[a,b])=>n+(b-a)*step,0);
      const missing=difference(referenceRows[row],actualRows[row]),extra=difference(actualRows[row],referenceRows[row]);
      missingArea+=missing.reduce((n,[a,b])=>n+(b-a)*step,0);extraArea+=extra.reduce((n,[a,b])=>n+(b-a)*step,0);
      for(const[a,b]of missing)if(distanceToRings([(a+b)/2,row*step+step/2],rings)>1.5)interiorMissingSamples++;
    }
  }
  renderedArea.push({zoom:z,checkedTiles,referenceArea,actualArea,missingArea,extraArea,interiorMissingSamples,quantizationCoastToleranceUnits:1.5,samplingStepUnits:step});
  assert.equal(interiorMissingSamples,0,`Interior sea holes at zoom ${z}`);
}
const result={pass:true,catalogVersion:pointer.catalogVersion,counts:descriptor.counts,artifactsVerified:JSON.parse(idx).artifacts.length,checkedBytes,unchangedCountries,unionReports,koreaBorderEdges,koreaBorderLengthKm,renderedArea,
  coverageMethod:'Exact face boundary certificate plus independent cell boundary cancellation, components/holes/area/bbox, per-zoom decoded vector scanline area; fine identity gaps remain separately recorded.'};
fs.mkdirSync(path.dirname(outputReport),{recursive:true});
fs.writeFileSync(outputReport,jsonBytes(result));console.log(JSON.stringify(result));
