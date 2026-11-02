import assert from 'node:assert/strict';
import {test} from 'node:test';
import {certifySubdivision} from './mesh-subdivision.mjs';

const polygon=ring=>({type:'Polygon',coordinates:[ring]});
const square=[[0,0],[1,0],[1,1],[0,1],[0,0]];
test('retains exact ordered subdivisions and original holes',()=>{
  const old={type:'Polygon',coordinates:[square,[[.2,.2],[.2,.4],[.4,.4],[.4,.2],[.2,.2]]]};
  const next={type:'Polygon',coordinates:[[[0,0],[.5,0],[1,0],[1,1],[0,1],[0,0]],old.coordinates[1]]};
  assert.equal(certifySubdivision(old,next).pass,true);
  assert.throws(()=>certifySubdivision(old,polygon(square)),/HOLE_COUNT/);
});
test('rejects a finite point exactly beyond 1e-12 despite absolute-coordinate rounding',()=>{
  const a=[113.18391811102629,35.55235620820895],b=[113.19018688272507,35.452552889118905],c=[113.28372143011633,35.558624979907734];
  const p=[113.18929987424087,35.46667469720794];
  assert.throws(()=>certifySubdivision(polygon([a,b,c,a]),polygon([a,p,b,c,a])),/OUTSIDE_ORIGINAL_FINITE_SEGMENT/);
});
test('rejects cumulative reverse travel beyond the bound',()=>{
  const ring=[[0,0],[.5,0],[.5-.75e-12,0],[.5-1.5e-12,0],[.6,0],[1,0],[1,1],[0,1],[0,0]];
  assert.throws(()=>certifySubdivision(polygon(square),polygon(ring)),/OUTSIDE_ORIGINAL_FINITE_SEGMENT/);
});
test('rejects an added off-segment loop and an omitted real corner',()=>{
  assert.throws(()=>certifySubdivision(polygon(square),polygon([[0,0],[.5,0],[.5,.01],[.6,0],[1,0],[1,1],[0,1],[0,0]])),/OUTSIDE_ORIGINAL_FINITE_SEGMENT/);
  assert.throws(()=>certifySubdivision(polygon(square),polygon([[0,0],[1,0],[0,1],[0,0]])));
});
