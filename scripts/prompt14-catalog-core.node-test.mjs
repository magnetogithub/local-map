import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {assertBuildOutput, canonical, generateAtoms, hashCanonical, normalizeGeometry, normalizeRing, writeArtifact} from './prompt14-catalog-core.mjs';

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
