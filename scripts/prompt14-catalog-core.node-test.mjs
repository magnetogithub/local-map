import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import {assertBuildOutput, canonical, generateAtoms, hashCanonical, normalizeGeometry, normalizeRing, writeArtifact,signedArea,geometryMetadata,jsonBytes,digest,polygons} from './prompt14-catalog-core.mjs';
import {exactRingNumerator,exactRingSign,signedRingArea,polygonArea,positivePolygonAreaAtMost} from './prompt14-exact-ring.mjs';

const square=[[0,0],[2,0],[2,2],[0,2],[0,0]];
test('atom geometry is invariant to rotation, winding and component enumeration without rounding',()=>{
  const shifted=[[2,2],[2,0],[0,0],[0,2],[2,2]];
  const other=square.map(([x,y])=>[x+10.00000000000001,y]);
  assert.deepEqual(normalizeGeometry({type:'MultiPolygon',coordinates:[[square],[other]]}),normalizeGeometry({type:'MultiPolygon',coordinates:[[other.slice().reverse()],[shifted]]}));
  assert.equal(normalizeGeometry({type:'Polygon',coordinates:[other]}).coordinates[0][0][0],10.00000000000001);
});
test('strict normalization rejects open, nonfinite and degenerate rings',()=>{
  for(const ring of [square.slice(0,-1),[[0,0],[1,0],[2,0],[0,0]],[[0,0],[Infinity,0],[1,1],[0,0]]]) assert.throws(()=>normalizeRing(ring,true));
});
test('source identity is retained before TerritoryId and distinct features never merge',()=>{
  const feature=id=>({properties:{countryId:'AAA',sourceCountryId:'AAA',sourceFeatureId:id,inputRole:'P1'},geometry:{type:'Polygon',coordinates:[square]}});
  const inputs={lock:{sourceVersion:'locked'},selected:{features:[feature('a'),feature('b')]}};
  const atoms=generateAtoms(inputs);
  assert.equal(atoms.length,2); assert.notEqual(atoms[0].canonicalAtomKey,atoms[1].canonicalAtomKey);
  assert.equal(atoms[0].members.length,1); assert.equal('id' in atoms[0],false);
  const reordered=generateAtoms({...inputs,selected:{features:inputs.selected.features.slice().reverse()}});
  assert.deepEqual(atoms.map(a=>a.canonicalAtomKey),reordered.map(a=>a.canonicalAtomKey));
});
test('canonical hashing separates domains and rejects nonfinite numbers',()=>{
  assert.equal(canonical({z:-0,a:1}),'{"a":1,"z":0}');
  assert.notEqual(hashCanonical('geometry',[]),hashCanonical('topology',[])); assert.throws(()=>canonical(NaN));
});
test('build-only world geometry cannot be staged in browser public assets or escape the workspace',()=>{
  const root=process.cwd();
  assert.throws(()=>assertBuildOutput(root,path.join(root,'public','candidate')),/under public/);
  assert.throws(()=>assertBuildOutput(root,path.resolve(root,'..','candidate')),/workspace/);
  assert.throws(()=>writeArtifact(root,'..\\escaped.json',Buffer.from('')),/traversal/);
});

const positiveFaceRoot='reports/prompt15/15-22-component-repair/20261028-positive-face-70656bae65',savedPositiveFace=()=>{const bytes=fs.readFileSync(positiveFaceRoot+'/fixture.json'),input=JSON.parse(bytes);assert.equal(digest(jsonBytes(input.geometry)),'0eca638e383e148c19be5b3ced5488d75f5751515a6cf0e3f590a3290ef85842');return input.geometry;};
test('actual positive FRA ring canonical bytes, winding, area and repeated normalization are cyclically invariant',()=>{
 const geometry=savedPositiveFace(),open=geometry.coordinates[0].slice(0,-1),expected=normalizeGeometry(geometry),areas=new Set(),numerators=new Set();
 for(const reverse of [false,true])for(let i=0;i<3;i++){
  const p=reverse?open.slice().reverse():open,r=[...p.slice(i),...p.slice(0,i)],ring=[...r,r[0]],g={type:'Polygon',coordinates:[ring]},n=normalizeGeometry(g);assert.deepEqual(n,expected);assert.deepEqual(normalizeGeometry(n),n);assert.equal(exactRingSign(n.coordinates[0]),1);assert.equal(Math.sign(signedArea(ring)),reverse?-1:1);areas.add(Math.abs(signedArea(ring)));numerators.add((reverse?-exactRingNumerator(ring):exactRingNumerator(ring)).toString());
 }
 assert.equal(areas.size,1);assert.equal(numerators.size,1);assert.equal([...areas][0],5.877816005970817e-21);
});
test('actual tiny FRA atom metadata retains positive area and the triangle centroid',()=>{
 const geometry=normalizeGeometry(savedPositiveFace()),metadata=geometryMetadata(geometry),vertices=geometry.coordinates[0].slice(0,-1),mean=[0,1].map(i=>vertices.reduce((n,p)=>n+p[i],0)/3),atoms=generateAtoms({lock:{sourceVersion:'local'},selected:{features:[{properties:{countryId:'FRA',sourceCountryId:'FRA',sourceFeatureId:'local-test',inputRole:'P1'},geometry}]}});
 assert.equal(metadata.area,5.877816005970817e-21);assert.equal(atoms[0].area,metadata.area);for(let i=0;i<2;i++)assert.ok(Math.abs(metadata.centroid[i]-mean[i])<=2*Number.EPSILON*Math.abs(mean[i]));
});
test('exact degeneracies remain rejected while nonrepresentable positive areas are never replaced by zero or epsilon',()=>{
 for(const ring of [[[0,0],[1,1],[2,2],[0,0]],[[1,1],[1,1],[1,1],[1,1]],[[0,0],[1,0],[1,0],[2,0],[0,0]]]){assert.equal(exactRingSign(ring),0);assert.equal(signedArea(ring),0);assert.throws(()=>normalizeRing(ring,true));}
 const t=2**-600,ring=[[0,0],[t,0],[0,t],[0,0]];assert.equal(exactRingSign(ring),1);assert.throws(()=>signedRingArea(ring),/not representable/);
});
test('tiny positive shells, holes and multiple components preserve their separate roles',()=>{
 const tiny=savedPositiveFace().coordinates[0],outer=[[-3,47],[-2,47],[-2,48],[-3,48],[-3,47]],hole=normalizeGeometry({type:'Polygon',coordinates:[outer,tiny]}),multi=normalizeGeometry({type:'MultiPolygon',coordinates:[[tiny],[square]]});
 assert.equal(hole.coordinates.length,2);assert.equal(exactRingSign(hole.coordinates[0]),1);assert.equal(exactRingSign(hole.coordinates[1]),-1);assert.equal(polygons(multi).length,2);assert.ok(polygons(multi).every(p=>exactRingSign(p[0])===1));assert.deepEqual(normalizeGeometry(hole),hole);assert.deepEqual(normalizeGeometry(multi),multi);
});
test('pre-change normal canonical bytes and hashes remain exactly unchanged for all seven fixed normal cases',()=>{
 for(const p of JSON.parse(fs.readFileSync(positiveFaceRoot+'/normal-baseline.json'))){const bytes=jsonBytes(normalizeGeometry(p.geometry));assert.ok(bytes.equals(fs.readFileSync(positiveFaceRoot+'/normal-before/'+p.name+'.json')),p.name);assert.equal(digest(bytes),p.sha256);}
});
test('exact polygon upper bounds distinguish equality and the next representable larger width',()=>{
 const maximum=1e-12,width=maximum*1024,height=2**-10,make=w=>[[[0,0],[w,0],[w,height],[0,height],[0,0]]],view=new DataView(new ArrayBuffer(8));view.setFloat64(0,width);view.setBigUint64(0,view.getBigUint64(0)+1n);const larger=view.getFloat64(0);
 assert.equal(positivePolygonAreaAtMost(make(width),maximum),true);assert.equal(positivePolygonAreaAtMost(make(larger),maximum),false);assert.equal(polygonArea(make(width)),maximum);
});
