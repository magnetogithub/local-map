import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import {nodeUnpairedBuckets} from './prompt15-r3-edge-noding.mjs';

const prepare=(name,records)=>{const root=path.resolve(`.tmp/${name}`),scratch=path.resolve('.tmp')+path.sep;if(!root.startsWith(scratch)||fs.existsSync(root))throw Error('Unsafe or occupied test scratch');fs.mkdirSync(`${root}/input`,{recursive:true});for(let i=0;i<256;i++)fs.writeFileSync(`${root}/input/${i}.ndjson`,'');fs.writeFileSync(`${root}/input/0.ndjson`,records.map(record=>JSON.stringify(record)+'\n').join(''));return root;};
const readRecords=root=>fs.readdirSync(`${root}/output`).flatMap(file=>fs.readFileSync(`${root}/output/${file}`,'utf8').split('\n').filter(Boolean).map(line=>JSON.parse(line)));
const clean=root=>{if(!root.startsWith(path.resolve('.tmp')+path.sep))throw Error('Unsafe cleanup');fs.rmSync(root,{recursive:true});};
const grouped=records=>{const groups=new Map();for(const record of records){const k=JSON.stringify(record.slice(0,2)),list=groups.get(k)??[];list.push(record.slice(2));groups.set(k,list);}return groups;};

test('world common edge refinement pairs T junctions without inventing a missing neighbor',()=>{
 const root=prepare('prompt15-r3-edge-test',[
  [[0,0],[2,0],1,0],[[0,0],[1,0],2,1],[[1,0],[2,0],3,1],[[3,0],[4,0],4,0],
 ]);
 try{
  const evidence=nodeUnpairedBuckets(`${root}/input`,`${root}/output`),records=readRecords(root),groups=grouped(records);
  assert.equal(evidence.pass,true);assert.equal(evidence.maximumEndpointRoundingDisplacement,0);assert.equal(evidence.maximumInsertedNodePerpendicularDisplacement,0);assert.equal(records.length,5);
  assert.deepEqual(groups.get('[[0,0],[1,0]]').sort(),[[1,0],[2,1]]);assert.deepEqual(groups.get('[[1,0],[2,0]]').sort(),[[1,0],[3,1]]);assert.deepEqual(groups.get('[[3,0],[4,0]]'),[[4,0]]);
 }finally{clean(root);}
});

test('fixed 1e12 snap rounding deterministically commons a sub-grid boundary and preserves metadata',()=>{
 const longMetadata={seamOriginalLongitudes:[180,-180],role:'long'},leftMetadata={seamOriginalLongitudes:[180,180],role:'left'},rightMetadata={seamOriginalLongitudes:[-180,-180],role:'right'};
 const root=prepare('prompt15-r3-edge-snap-test',[
  [[0,4e-13],[2,4e-13],10,0,longMetadata,'long-tail'],
  [[0,-4e-13],[1,-4e-13],11,1,leftMetadata,'left-tail'],
  [[1,-4e-13],[2,-4e-13],12,1,rightMetadata,'right-tail'],
 ]);
 try{
  const evidence=nodeUnpairedBuckets(`${root}/input`,`${root}/output`),records=readRecords(root),groups=grouped(records);
  assert.equal(evidence.pass,true);assert.equal(evidence.evidence.precisionModel.scale,1e12);assert.ok(evidence.maximumEndpointRoundingDisplacement>0);assert.ok(evidence.maximumEndpointRoundingDisplacement<=1e-12);assert.ok(evidence.maximumInsertedNodePerpendicularDisplacement>0);assert.ok(evidence.maximumInsertedNodePerpendicularDisplacement<=1e-12);
  assert.deepEqual(groups.get('[[0,0],[1,0]]').sort((a,b)=>a[0]-b[0]),[[10,0,longMetadata,'long-tail'],[11,1,leftMetadata,'left-tail']]);
  assert.deepEqual(groups.get('[[1,0],[2,0]]').sort((a,b)=>a[0]-b[0]),[[10,0,longMetadata,'long-tail'],[12,1,rightMetadata,'right-tail']]);
 }finally{clean(root);}
});

test('snap rounding does not merge a real gap wider than 1e-12 and exact pairs keep arbitrary record tails',()=>{
 const lowerMetadata={sourceLongitude:0},upperMetadata={sourceLongitude:2e-12},exactA={sourceLongitude:5.0000000000004},exactB={sourceLongitude:5.0000000000004};
 const root=prepare('prompt15-r3-edge-gap-test',[
  [[0,0],[1,0],20,0,lowerMetadata,['lower']],
  [[0,2e-12],[1,2e-12],21,1,upperMetadata,['upper']],
  [[5,4e-13],[6,4e-13],22,0,exactA,'exact-a',true],
  [[5,4e-13],[6,4e-13],23,1,exactB,'exact-b',false],
 ]);
 try{
  const evidence=nodeUnpairedBuckets(`${root}/input`,`${root}/output`),records=readRecords(root),groups=grouped(records);
  assert.equal(evidence.pass,true);assert.equal(evidence.pairedOccurrences,2);assert.equal(records.length,4);assert.deepEqual(groups.get('[[0,0],[1,0]]'),[[20,0,lowerMetadata,['lower']]]);assert.deepEqual(groups.get('[[0,2e-12],[1,2e-12]]'),[[21,1,upperMetadata,['upper']]]);
  assert.deepEqual(groups.get('[[5,4e-13],[6,4e-13]]').sort((a,b)=>a[0]-b[0]),[[22,0,exactA,'exact-a',true],[23,1,exactB,'exact-b',false]]);
 }finally{clean(root);}
});
