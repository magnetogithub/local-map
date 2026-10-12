import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import {nodeUnpairedBuckets} from './prompt15-r3-edge-noding.mjs';
test('world common edge refinement pairs T junctions without changing linework or inventing a missing neighbor',()=>{
 const root=path.resolve('.tmp/prompt15-r3-edge-test');if(!root.startsWith(path.resolve('.tmp')+path.sep)||fs.existsSync(root))throw Error('Unsafe or occupied test scratch');fs.mkdirSync(`${root}/input`,{recursive:true});
 try{for(let i=0;i<256;i++)fs.writeFileSync(`${root}/input/${i}.ndjson`,'');fs.writeFileSync(`${root}/input/0.ndjson`,[
  [[0,0],[2,0],1,0],[[0,0],[1,0],2,1],[[1,0],[2,0],3,1],[[3,0],[4,0],4,0],
 ].map(r=>JSON.stringify(r)+'\n').join(''));
 const evidence=nodeUnpairedBuckets(`${root}/input`,`${root}/output`),records=fs.readdirSync(`${root}/output`).flatMap(f=>fs.readFileSync(`${root}/output/${f}`,'utf8').split('\n').filter(Boolean).map(l=>JSON.parse(l))),groups=new Map();
 for(const r of records){const k=JSON.stringify(r.slice(0,2)),list=groups.get(k)??[];list.push(r.slice(2));groups.set(k,list);}
 assert.equal(evidence.pass,true);assert.equal(evidence.maximumDisplacement,0);assert.equal(records.length,5);
 assert.deepEqual(groups.get('[[0,0],[1,0]]').sort(),[[1,0],[2,1]]);assert.deepEqual(groups.get('[[1,0],[2,0]]').sort(),[[1,0],[3,1]]);assert.deepEqual(groups.get('[[3,0],[4,0]]'),[[4,0]]);
 }finally{if(path.resolve(root)!==path.resolve('.tmp/prompt15-r3-edge-test'))throw Error('Unsafe cleanup');fs.rmSync(root,{recursive:true});}
});
