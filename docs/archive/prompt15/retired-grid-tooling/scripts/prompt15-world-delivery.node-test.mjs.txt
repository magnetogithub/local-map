import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {gzipSync} from 'node:zlib';
import geojsonVt from 'geojson-vt';
import {fromGeojsonVt} from '@maplibre/vt-pbf';
import {VectorTile} from '@mapbox/vector-tile';
import {PbfReader} from 'pbf';
import {jsonBytes} from './prompt14-catalog-core.mjs';
import {POLICY,identity,verifyTree,writeArtifact,readGzipJSON,edgeFeature,checkTransportFeature,tileCoordinates,safeRelative,nondegenerateTileFeature,edgeTileBucket,encodeEdgeIncidence,decodeTilePayload} from './prompt15-world-delivery-core.mjs';

const withTemporary=fn=>{const dir=fs.mkdtempSync(path.join(os.tmpdir(),'prompt15-delivery-'));try{return fn(dir);}finally{fs.rmSync(dir,{recursive:true,force:true});}};
const edge=(properties={})=>({id:'canonical-edge',ordinal:1,left:1,right:2,boundaryClass:'operational',flags:{administrative:false},geometry:{type:'LineString',coordinates:[[0,0],[1,1]]},...properties});

test('15-21 exact detail retains holes and subpixel geometry independently of coarse LOD',()=>withTemporary(dir=>{
  const geometry={type:'Polygon',coordinates:[[[0,0],[1,0],[1,1],[0,1],[0,0]],[[.1,.1],[.1,.2],[.2,.2],[.2,.1],[.1,.1]]]},tiny={type:'Polygon',coordinates:[[[20,20],[20.000000000001,20],[20.000000000001,20.000000000001],[20,20.000000000001],[20,20]]]},features=[geometry,tiny].map((geometry,index)=>({type:'Feature',id:index+1,properties:{},geometry}));
  writeArtifact(dir,'detail.geojson.gz',{type:'FeatureCollection',features},{compressed:true});assert.deepEqual(readGzipJSON(path.join(dir,'detail.geojson.gz')).features,features);
  const index=geojsonVt({type:'FeatureCollection',features},POLICY.tileOptions),tile=index.getTile(0,0,0);assert.ok(!tile.features.some(feature=>feature.id===2),'tiny face should exercise actual coarse-LOD culling');
}));

test('15-21 tile IDs survive PBF and front incidence is independent of boundary class',()=>{
  const features=[edgeFeature(edge()),edgeFeature(edge({ordinal:2,boundaryClass:'administrative',flags:{administrative:true}}))],index=geojsonVt({type:'FeatureCollection',features},POLICY.tileOptions),bytes=fromGeojsonVt({edges:index.getTile(0,0,0)},{version:2,extent:4096}),tile=new VectorTile(new PbfReader(bytes));
  assert.equal(tile.layers.edges.length,2);
  for(let i=0;i<2;i++){const feature=tile.layers.edges.feature(i);checkTransportFeature('edges',feature,2,2,0);assert.equal(feature.id,i+1);assert.equal(feature.properties.c,[3,2][i]);assert.equal(feature.properties.a,i);assert.equal(feature.properties.l,undefined);assert.equal(feature.properties.r,undefined);}
  assert.throws(()=>checkTransportFeature('administrative',tile.layers.edges.feature(1),2,2,3),/visibility/);
  assert.doesNotThrow(()=>checkTransportFeature('administrative',tile.layers.edges.feature(1),2,2,4));
  assert.throws(()=>checkTransportFeature('administrative',tile.layers.edges.feature(0),2,2,4),/visibility/);
  assert.throws(()=>checkTransportFeature('frontiers',tile.layers.edges.feature(0),2,2,4),/layer/);
  assert.throws(()=>edgeFeature(edge({boundaryClass:'frontier'})),/Invalid/);
  assert.throws(()=>edgeFeature(edge({right:1})),/Invalid/);
});

test('15-21 artifact verifier rejects tamper, missing/extra files and traversal',()=>withTemporary(dir=>{
  const a=writeArtifact(dir,'tile.pbf',Buffer.from([1,2,3]),{raw:true}),index={artifacts:[a],totalByteLength:a.byteLength};fs.writeFileSync(path.join(dir,'artifact-index.json'),jsonBytes(index));
  assert.equal(verifyTree(dir).index.totalByteLength,3);const pin=identity(path.join(dir,'artifact-index.json'));assert.doesNotThrow(()=>verifyTree(dir,pin));
  fs.appendFileSync(path.join(dir,'tile.pbf'),'x');assert.throws(()=>verifyTree(dir),/bytes/);fs.writeFileSync(path.join(dir,'tile.pbf'),Buffer.from([1,2,3]));
  fs.writeFileSync(path.join(dir,'extra'),'x');assert.throws(()=>verifyTree(dir),/disk set/);fs.unlinkSync(path.join(dir,'extra'));
  fs.unlinkSync(path.join(dir,'tile.pbf'));assert.throws(()=>verifyTree(dir),/disk set/);
  for(const name of ['../x','C:/x','/x','a\\x','a//x','a/./x'])assert.equal(safeRelative(name),false);
  fs.writeFileSync(path.join(dir,'artifact-index.json'),jsonBytes({artifacts:[{...a,path:'../x'}],totalByteLength:3}));assert.throws(()=>verifyTree(dir),/Unsafe/);assert.throws(()=>verifyTree(dir,pin),/Pinned/);
}));

test('15-21 deterministic compressed details and complete fixed overview pyramid',()=>withTemporary(dir=>{
  const data={id:1,geometry:{type:'LineString',coordinates:[[180,70],[180,71]]}};
  const first=writeArtifact(dir,'first.gz',data,{compressed:true}),second=writeArtifact(dir,'second.gz',data,{compressed:true});assert.equal(first.sha256,second.sha256);
  const coordinates=[...tileCoordinates()];assert.equal(coordinates.length,5461);assert.equal(new Set(coordinates.map(tile=>tile.path)).size,5461);assert.deepEqual(coordinates[0],{z:0,x:0,y:0,path:'tiles/0/0/0.pbf.gz'});
}));

test('15-21 does not count collapsed max-zoom polygons or zero-length lines as visible',()=>{
  const collapsed={id:1,type:3,tags:{},geometry:[[[1,1],[1,1],[1,1],[1,1]]]},line={id:1,type:2,tags:{l:1,r:2,c:3,a:0},geometry:[[[1,1],[1,1]]]};
  assert.equal(nondegenerateTileFeature(collapsed),null);assert.equal(nondegenerateTileFeature(line),null);
  const positive={...collapsed,geometry:[[[0,0],[2,0],[2,2],[0,2],[0,0]],collapsed.geometry[0]]};assert.equal(nondegenerateTileFeature(positive).geometry.length,1);
  const bytes=fromGeojsonVt({territories:{features:[collapsed]}},{version:2,extent:4096}),decoded=new VectorTile(new PbfReader(bytes));
  assert.throws(()=>checkTransportFeature('territories',decoded.layers.territories.feature(0),1,1,6),/Degenerate/);
});

test('15-21 gzip PBF and complete binary incidence preserve coast and shared-cell references',()=>{
  const incidence=encodeEdgeIncidence(new Uint32Array([0,1,2]),new Uint32Array([0,0,1]));
  assert.equal(incidence.length,16);assert.equal(incidence.readUInt32LE(0),1);assert.equal(incidence.readUInt32LE(4),0);assert.equal(incidence.readUInt32LE(8),2);assert.equal(incidence.readUInt32LE(12),1);
  assert.throws(()=>encodeEdgeIncidence([0,1],[0,1]),/Invalid incidence/);assert.throws(()=>encodeEdgeIncidence([0,1],[0]),/Invalid incidence/);
  const feature=edgeFeature(edge()),index=geojsonVt({type:'FeatureCollection',features:[feature]},POLICY.tileOptions),raw=Buffer.from(fromGeojsonVt({edges:index.getTile(0,0,0)},{version:2,extent:4096})),compressed=gzipSync(raw,{level:9,mtime:0});
  assert.deepEqual(decodeTilePayload(compressed),raw);const decoded=new VectorTile(new PbfReader(decodeTilePayload(compressed)));assert.equal(decoded.layers.edges.feature(0).id,1);assert.throws(()=>decodeTilePayload(Buffer.from([1,2,3])));
});

test('15-21 spatial edge work preserves clipped coordinates, IDs and admin incidence',()=>{
  const features=[[-180,-179,70],[179,180,70],[-91,-89,0],[89,91,-60],[0,1,90]].map(([a,b,y],i)=>edgeFeature(edge({ordinal:i+1,flags:{administrative:i%2===0},geometry:{type:'LineString',coordinates:[[a,y],[b,y]]}})));
  const buckets=new Map();for(const feature of features){const bucket=edgeTileBucket(feature);assert.ok(bucket>=0&&bucket<16);const group=buckets.get(bucket)??[];group.push(feature);buckets.set(bucket,group);}
  const options={...POLICY.tileOptions,maxZoom:2,indexMaxZoom:2},whole=geojsonVt({type:'FeatureCollection',features},options),parts=[...buckets.values()].map(features=>geojsonVt({type:'FeatureCollection',features},options));
  const normalize=features=>features.map(nondegenerateTileFeature).filter(Boolean).sort((a,b)=>a.id-b.id||JSON.stringify(a.geometry).localeCompare(JSON.stringify(b.geometry)));
  for(let z=0;z<=2;z++)for(let x=0;x<2**z;x++)for(let y=0;y<2**z;y++){
    const expected=normalize(whole.getTile(z,x,y)?.features??[]),actual=normalize(parts.flatMap(index=>index.getTile(z,x,y)?.features??[]));assert.deepEqual(actual,expected);
    assert.deepEqual(actual.filter(feature=>feature.tags.a===1),expected.filter(feature=>feature.tags.a===1));
  }
});
