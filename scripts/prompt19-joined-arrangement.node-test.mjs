import test from 'node:test';
import assert from 'node:assert/strict';
import {arrangePrompt19Sources} from './prompt19-source-arrangement.mjs';
import {joinedTopology,globalCellId} from './prompt19-joined-topology.mjs';
import {geometryMetadata,normalizeGeometry} from './prompt14-catalog-core.mjs';
const box=(w,s,e,n)=>({type:'Polygon',coordinates:[[[w,s],[e,s],[e,n],[w,n],[w,s]]]});
const feature=(geometry,properties)=>({type:'Feature',geometry,properties});
const source=(id,g)=>feature(g,{countryId:'KOR',sourceId:'fixture-admin',sourceFeatureId:id,name:id,adminLevel:3});
const dataset=features=>({countryId:'KOR',features,envelope:feature(box(0,0,4,4),{countryId:'KOR'}),coarseParents:[feature(box(0,0,4,4),{countryId:'KOR',coarseTerritoryId:'old-kor',parentKey:'kor-parent'})]});
test('joint faces preserve fixed coverage and expose source-free coast as coarse provenance',()=>{
  const result=arrangePrompt19Sources({datasets:[dataset([source('A',box(0,0,1,3)),source('B',box(3,0,4,3))])],preserveCanonicalResiduals:true});
  assert.equal(result.invalid.length,0);assert.equal(result.unresolved.length,0);
  assert.equal(result.evidence.extensions.length,0);
  assert.ok(Math.abs(result.summary[0].arrangedFaceArea-16)<1e-12);
  const remainder=result.cells.filter(f=>f.properties.unresolvedFineSourceAssignment);
  assert.ok(remainder.length);assert.ok(remainder.every(f=>f.properties.fineSourceIdentity===null&&f.properties.adminLevel===null));
  assert.equal(result.evidence.canonicalResiduals.every(f=>f.memberCount===0),true);
  assert.equal(joinedTopology(result).evidence.completeBoundaryCoverage,true);
});
test('overlapping source membership fails instead of being hidden in coarse fallback',()=>{
  const result=arrangePrompt19Sources({datasets:[dataset([source('A',box(0,0,3,4)),source('B',box(1,0,4,4))])],preserveCanonicalResiduals:true});
  assert.ok(result.unresolved.some(f=>f.memberCount===2));
  assert.equal(result.evidence.canonicalResiduals.length,0);
});
test('without explicit canonical preservation a multi-source coastal remainder stays unresolved',()=>{
  const result=arrangePrompt19Sources({datasets:[dataset([source('A',box(0,0,1,3)),source('B',box(3,0,4,3))])]});
  assert.ok(result.unresolved.length);
});
test('point contacts never become positive-length land adjacency',()=>{
  const result=arrangePrompt19Sources({datasets:[dataset([source('A',box(0,0,2,2)),source('B',box(2,2,4,4))])],preserveCanonicalResiduals:true});
  const topology=joinedTopology(result),cells=result.cells.filter(f=>!f.properties.unresolvedFineSourceAssignment);
  const ids=new Set(cells.map(f=>f.properties.sourceFeatureId));assert.deepEqual(ids,new Set(['A','B']));
  // Neither actual source cell shares a segment with the diagonal source cell.
  const fineIds=new Set(cells.map(globalCellId));
  assert.equal(topology.edges.some(e=>fineIds.has(e.leftTerritoryId)&&fineIds.has(e.rightTerritoryId)),false);
  assert.ok(topology.edges.length);assert.equal(topology.evidence.ambiguousSides,0);
});

const donut=()=>normalizeGeometry({type:'Polygon',coordinates:[box(0,0,4,4).coordinates[0],box(1,1,3,3).coordinates[0]]});

test('strict source membership preserves an administrative source hole as explicit coarse land',()=>{
  const result=arrangePrompt19Sources({datasets:[dataset([source('donut',donut())])],strictSourceMembership:true,continueTerminals:true});
  assert.equal(result.invalid.length,0);assert.equal(result.unresolved.length,0);
  assert.equal(result.evidence.strictSourceMembership,true);
  assert.equal(result.evidence.extensions.length,0);assert.equal(result.evidence.changes.length,0);
  const fine=result.cells.filter(f=>!f.properties.unresolvedFineSourceAssignment),coarse=result.cells.filter(f=>f.properties.unresolvedFineSourceAssignment);
  assert.equal(fine.length,1);assert.equal(coarse.length,1);
  assert.equal(geometryMetadata(fine[0].geometry).area,12);assert.equal(geometryMetadata(fine[0].geometry).holes,1);
  assert.equal(geometryMetadata(coarse[0].geometry).area,4);assert.equal(geometryMetadata(coarse[0].geometry).holes,0);
  assert.equal(coarse[0].properties.fineSourceIdentity,null);assert.equal(coarse[0].properties.adminLevel,null);
  assert.equal(coarse[0].properties.boundaryBasis,'canonical-country-residual');
  assert.deepEqual(coarse[0].properties.decisions,['canonical-country-residual']);
  assert.equal(result.summary[0].arrangedFaceArea,16);assert.equal(result.summary[0].coarseResidualArea,4);
  assert.equal(result.cells.reduce((total,f)=>total+geometryMetadata(f.geometry).area,0),16);
  assert.ok(result.evidence.canonicalResiduals.every(f=>f.memberCount===0));
  const topology=joinedTopology(result),fineId=globalCellId(fine[0]),coarseId=globalCellId(coarse[0]);
  assert.equal(topology.evidence.completeBoundaryCoverage,true);assert.equal(topology.evidence.ambiguousSides,0);assert.equal(topology.evidence.unpairedInteriorBoundaries,0);
  assert.ok(topology.edges.some(e=>[e.leftTerritoryId,e.rightTerritoryId].includes(fineId)&&[e.leftTerritoryId,e.rightTerritoryId].includes(coarseId)));
});

test('strict source membership preserves an actual country hole as sea instead of coarse land',()=>{
  const input=dataset([source('donut',donut())]);
  input.envelope.geometry=donut();input.coarseParents[0].geometry=donut();
  const result=arrangePrompt19Sources({datasets:[input],strictSourceMembership:true});
  assert.equal(result.invalid.length,0);assert.equal(result.unresolved.length,0);assert.equal(result.cells.length,1);
  assert.equal(geometryMetadata(result.cells[0].geometry).area,12);assert.equal(geometryMetadata(result.cells[0].geometry).holes,1);
  assert.equal(result.summary[0].arrangedFaceArea,12);assert.equal(result.summary[0].coarseResidualArea,0);assert.equal(result.evidence.canonicalResiduals.length,0);
  const topology=joinedTopology(result);
  assert.equal(topology.evidence.completeBoundaryCoverage,true);assert.equal(topology.evidence.unpairedInteriorBoundaries,0);
  assert.ok(topology.edges.every(e=>e.boundaryClass==='coast'&&e.rightTerritoryId===null));
});

test('strict source membership still rejects overlapping sources instead of assigning coarse provenance',()=>{
  const result=arrangePrompt19Sources({datasets:[dataset([source('A',box(0,0,3,4)),source('B',box(1,0,4,4))])],strictSourceMembership:true,preserveCanonicalResiduals:true});
  assert.ok(result.unresolved.some(f=>f.memberCount===2));
  assert.equal(result.evidence.canonicalResiduals.length,0);assert.equal(result.evidence.changes.length,0);
  assert.throws(()=>joinedTopology(result),/FACE_CELL_MEMBERSHIP/);
});

test('omitting strict source membership retains the legacy arrangement behavior',()=>{
  const input={datasets:[dataset([source('donut',donut())])],preserveCanonicalResiduals:true};
  const implicit=arrangePrompt19Sources(input),explicit=arrangePrompt19Sources({...input,strictSourceMembership:false});
  assert.deepEqual(implicit.cells,explicit.cells);assert.deepEqual(implicit.evidence,explicit.evidence);
});
