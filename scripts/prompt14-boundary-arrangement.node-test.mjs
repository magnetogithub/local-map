import test from 'node:test';
import assert from 'node:assert/strict';
import {commonNodeRings,arrangeSourcePartitions} from './prompt14-boundary-arrangement.mjs';
import {segmentCorrespondence} from './prompt14-boundary-diagnostics.mjs';
import {generateAtoms,normalizeGeometry} from './prompt14-catalog-core.mjs';
import {buildCatalogTopology} from './prompt14-catalog-topology.mjs';
const geometry=(x0,x1)=>normalizeGeometry({type:'Polygon',coordinates:[[[x0,0],[x1,0],[x1,1],[x0,1],[x0,0]]]});
const collection=features=>({type:'FeatureCollection',features});
const feature=(id,g)=>({type:'Feature',properties:{countryId:'AAA',sourceCountryId:'AAA',sourceFeatureId:id,inputRole:'P1'},geometry:g});
test('full collinear projection correspondence accepts representation roundoff but rejects an actual wider gap',()=>{
  assert.ok(segmentCorrespondence([0,0],[1,1],[0,1e-14],[1,1+1e-14]));
  assert.equal(segmentCorrespondence([0,0],[1,1],[0,1e-10],[1,1+1e-10]),null);
  assert.equal(segmentCorrespondence([0,0],[1,0],[1,0],[2,0]),null);
});
test('common source noding certifies every node against its original segment within the existing policy',()=>{
  // Both boundaries derive from the SAME endpoints. An extra interpolated node
  // exposes IEEE collinearity roundoff, rather than inventing a parallel gap.
  const a=[1,0],b=[1.1,1],t=1/3,middle=[a[0]+(b[0]-a[0])*t,a[1]+(b[1]-a[1])*t];
  const left=normalizeGeometry({type:'Polygon',coordinates:[[[0,0],a,middle,b,[0,1],[0,0]]]}),right=normalizeGeometry({type:'Polygon',coordinates:[[a,[2,0],[2,1],b,a]]});
  const p0=collection([feature('P0',geometry(0,2))]),selected=collection([feature('a',left),feature('b',right)]);
  const common=commonNodeRings(p0,selected);
  assert.ok(common.evidence.maximumNodedSegmentDisplacement<=1e-12);
  assert.equal(common.evidence.numericalTraceFailures.length,0);
  const inputs={lock:{sourceVersion:'test'},p0:common.p0,selected:common.selected};
  assert.equal(buildCatalogTopology(generateAtoms(inputs),inputs.p0).evidence.completeBoundaryCoverage,true);
});
test('an actual gap remains after numerical noding and cannot silently become coastline or a tolerance success',()=>{
  const p0=collection([feature('P0',geometry(0,2))]),selected=collection([feature('a',geometry(0,1)),feature('b',geometry(1+1e-10,2))]);
  const common=commonNodeRings(p0,selected),inputs={lock:{sourceVersion:'test'},p0:common.p0,selected:common.selected};
  assert.throws(()=>buildCatalogTopology(generateAtoms(inputs),inputs.p0),/boundary certification failed/);
  // No pinned shared source terminal exists; ambiguous residual contact cannot be allocated by nearest feature.
  assert.throws(()=>arrangeSourcePartitions(p0,selected,collection([])),/Unresolved source arrangement/);
});
