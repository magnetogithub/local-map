// Strict supplement to the already completed actual-PBF delivery audit.
// Rechecks hashed package geometry only. Never edits a catalog or game.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {gunzipSync} from 'node:zlib';
import {performance} from 'node:perf_hooks';
import {canonical,digest,jsonBytes,polygons,geometryMetadata} from '../prompt14-catalog-core.mjs';
import {ringsFromSegments} from '../prompt14-boundary-arrangement.mjs';
import {certifySubdivision} from './mesh-subdivision.mjs';

const arg=(name,fallback)=>{const i=process.argv.indexOf(name);return i<0?fallback:process.argv[i+1];};
const pointerPath=arg('--pointer',null),baselinePath=arg('--baseline-pointer',null);
if(!pointerPath||!baselinePath)throw Error('Explicit --pointer and --baseline-pointer are required');
const output=arg('--output','reports/chn-2020/delivery-subdivision-recheck.json');
const fullReportPath=arg('--full-delivery-report','reports/chn-2020/delivery-verification.json');
const oldHelper='reports/chn-2020/archive/mesh-subdivision-631d7290b1f5151f6dc3e2ba985a8d81cdb7c94232c1eb4e0f9a22cdc2b9bc23.mjs';
const oldCode='reports/chn-2020/archive/verify-delivery-a6dae2a9dabaebdc73deff40eb6f9743832aa70534ac8720ba44695bb2946ce2.mjs';
const read=file=>JSON.parse(fs.readFileSync(file)),pin=file=>{const b=fs.readFileSync(file);return{path:file,sha256:digest(b),byteLength:b.length};};
const started=performance.now(),code=['scripts/chn-2020/mesh-subdivision.mjs','scripts/chn-2020/verify-delivery-subdivision.mjs','scripts/chn-2020/mesh-subdivision.node-test.mjs'].map(pin);
const context={pointer:pin(pointerPath),baselinePointer:pin(baselinePath),originalFullDeliveryCode:pin(oldCode),originalLoadedHelper:pin(oldHelper),originalFullTileProof:pin(fullReportPath),code};
function load(file){
  const pointer=read(file),root=pointer.root,indexBytes=fs.readFileSync(`${root}/artifact-index.json`);
  assert.equal(digest(indexBytes),pointer.index.sha256);assert.equal(indexBytes.length,pointer.index.byteLength);
  const index=JSON.parse(indexBytes),artifacts=new Map(index.artifacts.map(a=>[a.path,a]));let verifiedBytes=0,verifiedArtifacts=0;
  const checked=relative=>{const expected=artifacts.get(relative);assert.ok(expected,`unindexed ${relative}`);const bytes=fs.readFileSync(`${root}/${relative}`);assert.equal(digest(bytes),expected.sha256,relative);assert.equal(bytes.length,expected.byteLength,relative);verifiedBytes+=bytes.length;verifiedArtifacts++;return bytes;};
  const gz=relative=>JSON.parse(gunzipSync(checked(relative))),detail=JSON.parse(checked('detail-index.json')),descriptor=JSON.parse(checked('catalog.json')),parents=gz('metadata/parents.json.gz');
  assert.equal(descriptor.catalogRef.catalogVersion,pointer.catalogVersion);assert.equal(detail.ref.catalogVersion,pointer.catalogVersion);
  const rows=detail.countries.flatMap(c=>gz(c.metadata.path).rows.map(row=>({row,countryId:c.countryId}))),byOrdinal=new Map(rows.map(r=>[r.row[0],r])),byId=new Map(rows.map(r=>[r.row[1],r]));
  assert.equal(rows.length,descriptor.counts.cells);assert.equal(byId.size,rows.length);assert.equal(byOrdinal.size,rows.length);
  const features=country=>{const c=detail.countries.find(c=>c.countryId===country);assert.ok(c);return gz(c.detail.path).features;};
  return{pointer,root,checked,parents,detail,byId,byOrdinal,features,stats:()=>({verifiedArtifacts,verifiedBytes})};
}
const semantic=p=>Object.fromEntries(Object.entries(p).filter(([k])=>!['start','count'].includes(k)));
const pointKey=p=>`${p[0]},${p[1]}`,compare=(a,b)=>a[0]-b[0]||a[1]-b[1];
function countryUnion(features){
  const incidence=new Map();
  for(const feature of features)for(const poly of polygons(feature.geometry))for(const ring of poly)for(let i=1;i<ring.length;i++){
    const a=ring[i-1],b=ring[i],forward=compare(a,b)<0,key=forward?`${pointKey(a)};${pointKey(b)}`:`${pointKey(b)};${pointKey(a)}`;
    if(incidence.has(key)){
      const prior=incidence.get(key);assert.ok(prior,`more than two country mesh incidences: ${key}`);
      assert.notEqual(prior.forward,forward,`same-direction duplicate country mesh edge: ${key}`);incidence.set(key,null);
    }else incidence.set(key,{a,b,forward});
  }
  return ringsFromSegments([...incidence.values()].filter(Boolean).map(e=>[e.a,e.b]));
}
function negativeControls(){
  const polygon=r=>({type:'Polygon',coordinates:[r]}),square=[[0,0],[1,0],[1,1],[0,1],[0,0]];
  const a=[113.18391811102629,35.55235620820895],b=[113.19018688272507,35.452552889118905],c=[113.28372143011633,35.558624979907734],p=[113.18929987424087,35.46667469720794];
  assert.throws(()=>certifySubdivision(polygon([a,b,c,a]),polygon([a,p,b,c,a])));
  assert.throws(()=>certifySubdivision(polygon(square),polygon([[0,0],[.5,0],[.5-.75e-12,0],[.5-1.5e-12,0],[.6,0],[1,0],[1,1],[0,1],[0,0]])));
  assert.throws(()=>countryUnion([{geometry:polygon(square)},{geometry:polygon(square)},{geometry:polygon(square)}]));
  return{exactBeyondBoundRejected:true,cumulativeBacktrackingRejected:true,duplicateMeshIncidenceRejected:true};
}
try{
  const controls=negativeControls(),current=load(pointerPath),baseline=load(baselinePath),full=read(fullReportPath);
  assert.equal(full.pass,true);assert.equal(full.pointer.sha256,context.pointer.sha256);assert.equal(full.baselinePointer.sha256,context.baselinePointer.sha256);
  assert.equal(full.catalogVersion,current.pointer.catalogVersion);assert.equal(full.baselineCatalogVersion,baseline.pointer.catalogVersion);
  const provenance=JSON.parse(baseline.checked('provenance.json')),input=provenance.inputs.find(a=>a.sha256===provenance.inputRoot);assert.ok(input);
  const bytes=fs.readFileSync(input.path);assert.equal(digest(bytes),input.sha256);assert.equal(bytes.length,input.byteLength);const predecessor=JSON.parse(bytes);
  let countries=0,cells=0,byteExact=0,subdivided=0;const changes=[];
  assert.deepEqual(current.detail.countries.map(c=>c.countryId),baseline.detail.countries.map(c=>c.countryId));
  for(const c of baseline.detail.countries){
    if(c.countryId==='CHN')continue;
    const before=new Map(baseline.features(c.countryId).map(f=>[baseline.byOrdinal.get(f.id).row[1],f])),after=new Map(current.features(c.countryId).map(f=>[current.byOrdinal.get(f.id).row[1],f]));
    assert.deepEqual([...before.keys()].sort(),[...after.keys()].sort(),`non-target ID set ${c.countryId}`);
    for(const[id,old]of before){
      const feature=after.get(id),oldRow=baseline.byId.get(id).row,row=current.byId.get(id).row;
      if(canonical(old.geometry)===canonical(feature.geometry))byteExact++;
      else{changes.push({identity:id,countryId:c.countryId,...certifySubdivision(old.geometry,feature.geometry)});subdivided++;}
      assert.deepEqual(semantic(current.parents.administrative[row[2]-1]),semantic(baseline.parents.administrative[oldRow[2]-1]));
      assert.deepEqual(semantic(current.parents.previous[row[3]-1]),semantic(baseline.parents.previous[oldRow[3]-1]));cells++;
    }countries++;
  }
  const countryCertificates=[];
  for(const countryId of['CHN','KOR','PRK']){
    const before=countryUnion(predecessor.features.filter(f=>f.properties.countryId===countryId)),after=countryUnion(current.features(countryId));
    const a=geometryMetadata(before),b=geometryMetadata(after);assert.equal(a.components,b.components);assert.equal(a.holes,b.holes);assert.deepEqual(a.bbox,b.bbox);
    countryCertificates.push({countryId,components:b.components,holes:b.holes,bbox:b.bbox,...certifySubdivision(before,after)});
  }
  const report={schemaVersion:'chn-strict-delivery-subdivision-recheck-v1',pass:true,...context,catalogVersion:current.pointer.catalogVersion,baselineCatalogVersion:baseline.pointer.catalogVersion,
    nonTargetPreservation:{pass:true,countries,cells,byteExactGeometryCells:byteExact,subdivisionEquivalentGeometryCells:subdivided,administrativeMembershipPreserved:true,seedLineagePreserved:true,subdivisionChanges:changes},countryCertificates,
    negativeControls:controls,packageReads:{candidate:current.stats(),baseline:baseline.stats()},existingRepresentationPolicyDegrees:1e-12,
    method:'Exact dyadic finite-segment bounds for every added node, original vertices individually bounded, greatest-projection cyclic order, original component/hole identity, and manifold/opposite-direction country mesh incidence. No aggregate area epsilon. Complements the unchanged completed PBF fill/edge proof executed with the archived original helper.',
    elapsedMs:performance.now()-started,peakRssBytes:process.resourceUsage().maxRSS*1024};
  fs.mkdirSync(path.dirname(output),{recursive:true});fs.writeFileSync(output,jsonBytes(report));console.log(JSON.stringify({pass:true,output,nonTargetCells:cells,subdivided,countries:countryCertificates.map(c=>c.countryId),elapsedMs:report.elapsedMs}));
}catch(error){
  fs.mkdirSync(path.dirname(output),{recursive:true});fs.writeFileSync(output,jsonBytes({schemaVersion:'chn-strict-delivery-subdivision-recheck-v1',pass:false,...context,error:error.message,elapsedMs:performance.now()-started}));throw error;
}
