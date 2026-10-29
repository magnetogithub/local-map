import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {computeSliverDistributions,evaluateCellSlivers} from './prompt15-sliver-core.mjs';
import {mergeSliverPair} from './prompt15-sliver-merge.mjs';
import {makeFreshSliverCells,freshSliverTopology,repairSliverCells} from './prompt15-sliver-local.mjs';
import {geometryHash,intersection} from './prompt15-preservation-audit-core.mjs';
import {physicalMetrics} from './prompt15-cell-physical.mjs';
import {polygons,jsonBytes,digest} from './prompt14-catalog-core.mjs';
const box=(w,s,e,n)=>({type:'Polygon',coordinates:[[[w,s],[e,s],[e,n],[w,n],[w,s]]]}),parent=(geometry,id='p')=>({parentKey:`TST:${id}`,properties:{sourceFeatureId:id},geometry}),cell=(p,geometry,id='c')=>({id,sourceCountryId:'TST',countryId:'TST',adminId:p.properties.sourceFeatureId,parentKey:p.parentKey,parentSourceFeatureId:p.properties.sourceFeatureId,oldTerritoryId:'old',componentIndex:0,sourceComponentHash:geometryHash(p.geometry),sourceTiny:physicalMetrics(p.geometry).areaKm2<=1&&physicalMetrics(p.geometry).diameterKm<=8,refined:true,geometry});
test('sourceTiny needs independent original component geometry and hash, not small cell size or a true flag',()=>{
 const tiny=parent(box(0,0,.005,.005)),c=cell(tiny,tiny.geometry),r=evaluateCellSlivers([c],[tiny]);assert.equal(r.errors.length,0);assert.equal(r.eligibleV2.pass,true);assert.equal(r.legacy.pass,false);assert.equal(r.eligibleV2.reason,'ALL_SOURCE_COMPONENTS_TINY');assert.equal(r.eligibleV2.area.denominator,0);
 const large=parent(box(0,0,.03,.03)),forged={...cell(large,box(0,0,.005,.005)),sourceTiny:true};assert.ok(evaluateCellSlivers([forged],[large]).errors.length);assert.ok(evaluateCellSlivers([{...c,sourceComponentHash:'forged'}],[tiny]).errors.length);
});
test('mixed intrinsic tiny sources use consistent eligible count and area populations',()=>{
 const tiny=parent(box(0,0,.005,.005),'tiny'),big=parent(box(.1,0,.13,.03),'big'),r=evaluateCellSlivers([cell(tiny,tiny.geometry),cell(big,big.geometry)],[tiny,big]);assert.equal(r.nonSourceTiny.cells,1);assert.equal(r.eligibleV2.area.numerator,0);assert.equal(r.eligibleV2.area.denominator,physicalMetrics(big.geometry).areaKm2);assert.equal(r.legacy.pass,false);assert.equal(r.eligibleV2.pass,true);
});
const m=(areaKm2,aspectRatio=1,sourceTiny=false)=>({areaKm2,aspectRatio,sourceTiny});
test('count-only, area-only, both-over-budget and truly bad non-sourceTiny cells remain failures',()=>{
 const count=computeSliverDistributions([...Array.from({length:4},()=>m(.001)),...Array.from({length:6},()=>m(100))]);assert.ok(count.legacy.count.ratio>.35);assert.ok(count.legacy.area.ratio<.01);assert.equal(count.eligibleV2.pass,false);
 const area=computeSliverDistributions([m(.9),...Array.from({length:9},()=>m(1))]);assert.ok(area.legacy.count.ratio<.35);assert.ok(area.legacy.area.ratio>.01);assert.equal(area.eligibleV2.pass,false);
 const both=computeSliverDistributions([m(.9),m(.9),m(1)]);assert.equal(both.legacy.pass,false);assert.equal(both.eligibleV2.pass,false);assert.equal(computeSliverDistributions([]).eligibleV2.pass,false);
});
test('fixed fraction and shape boundaries are inclusive; exceeding either limit is rejected',()=>{
 const rows=[...Array.from({length:35},()=>m(.001)),...Array.from({length:65},()=>m(100))];assert.equal(computeSliverDistributions(rows).eligibleV2.count.ratio,.35);assert.equal(computeSliverDistributions(rows).eligibleV2.pass,true);rows[35]=m(.001);assert.equal(computeSliverDistributions(rows).eligibleV2.pass,false);
 const exact=computeSliverDistributions([m(1,65),m(33),m(33),m(33)]);assert.equal(exact.eligibleV2.area.ratio,.01);assert.equal(exact.eligibleV2.pass,true);assert.equal(computeSliverDistributions([m(1+Number.EPSILON,65),m(33),m(33),m(33)]).eligibleV2.pass,false);assert.equal(computeSliverDistributions([m(1,64)]).raw.slivers,0);
});
test('allowed shared-edge union keeps exact external boundary and both positive inputs',()=>{
 const p=parent(box(0,0,.02,.01)),a=cell(p,box(0,0,.01,.01),'a'),b=cell(p,box(.01,0,.02,.01),'b'),result=mergeSliverPair(a,b);assert.equal(result.proof.exactAreaEquality,true);assert.equal(result.proof.allOutputPositionsFromOriginalInput,true);assert.equal(polygons(result.cell.geometry).length,1);assert.ok(result.proof.sharedSegments.length>0);
});
test('wrong identity, remote, point contact and physical cap violations cannot merge',()=>{
 const p=parent(box(0,0,.02,.02)),a=cell(p,box(0,0,.01,.01),'a'),b=cell(p,box(.01,0,.02,.01),'b');for(const key of ['sourceCountryId','parentKey','adminId','oldTerritoryId','componentIndex','sourceComponentHash'])assert.throws(()=>mergeSliverPair(a,{...b,[key]:'other'}),/ownership mismatch/);
 assert.throws(()=>mergeSliverPair(a,cell(p,box(.01,.01,.02,.02))),/shared boundary/);assert.throws(()=>mergeSliverPair(a,cell(p,box(.03,0,.04,.01))),/shared boundary/);
 const big=parent(box(0,0,.2,.1));assert.throws(()=>mergeSliverPair(cell(big,box(0,0,.1,.1),'a'),cell(big,box(.1,0,.2,.1),'b')),/physical/);
 const long=parent(box(0,0,.32,.002));assert.throws(()=>mergeSliverPair(cell(long,box(0,0,.16,.002),'a'),cell(long,box(.16,0,.32,.002),'b')),/physical/);
});
test('a hole is preserved when its two incident same-owner cells merge',()=>{
 const outer=box(0,0,.02,.02),hole=box(.005,.005,.015,.015),p=parent({type:'Polygon',coordinates:[outer.coordinates[0],hole.coordinates[0].slice().reverse()]}),a=cell(p,intersection(p.geometry,box(-1,-1,.01,1)),'a'),b=cell(p,intersection(p.geometry,box(.01,-1,1,1)),'b'),r=mergeSliverPair(a,b);assert.equal(r.cell.geometry.coordinates.length,2);
});
test('fresh identities follow actual atom source membership rather than sorted array positions',()=>{
 const p=parent(box(0,0,.02,.02),'a'),q=parent(box(.03,0,.05,.02),'b'),cells=[cell(q,q.geometry,'q'),cell(p,p.geometry,'p')],fresh=makeFreshSliverCells(cells,[p,q],'TST');for(const c of fresh.cells)assert.equal(c.parentKey,geometryHash(c.geometry)===geometryHash(p.geometry)?p.parentKey:q.parentKey);assert.ok(fresh.cells.every(c=>c.id!==cells[0].id&&c.id!==cells[1].id&&c.originalOrdinal===undefined));
 const reordered=makeFreshSliverCells(cells.slice().reverse(),[p,q],'TST');assert.deepEqual(reordered.cells.map(c=>c.id),fresh.cells.map(c=>c.id));
});
test('point-only contacts do not create fresh adjacency',()=>{
 const a=box(0,0,.01,.01),b=box(.01,.01,.02,.02),cells=[{id:'a',ordinal:1,sourceCountryId:'TST',parentKey:'p',adminId:'p',oldTerritoryId:'old',geometry:a},{id:'b',ordinal:2,sourceCountryId:'TST',parentKey:'q',adminId:'q',oldTerritoryId:'old',geometry:b}],topology=freshSliverTopology(cells,{type:'MultiPolygon',coordinates:[a.coordinates,b.coordinates]},'TST');assert.deepEqual(topology.adjacency,{a:[],b:[]});assert.ok(topology.edges.every(e=>e.right===0));assert.doesNotThrow(()=>jsonBytes(topology));
});
test('frozen policy and separately versioned rule remain distinct and byte-pinned',()=>{
 const policy=fs.readFileSync('scripts/prompt15-cell-policy.mjs');assert.equal(digest(policy),'e887c5ba5e49905d7f05491f4860076a578f8516c4aeb97ad3cdd9d18cfb1a04');const r=computeSliverDistributions([m(.5,1,true)]);assert.notEqual(r.legacy.rule,r.eligibleV2.rule);assert.equal(r.legacy.pass,false);assert.equal(r.eligibleV2.pass,true);
});
test('actual ABW repair is deterministic and improves the frozen sliver gate without boundary motion',()=>{
 const f=JSON.parse(fs.readFileSync('reports/prompt15/15-22-sliver-repair/20261028-sliver-ea5d422387/fixtures/ABW.json')),a=repairSliverCells(f.cells,f.parents),b=repairSliverCells(f.cells,f.parents);assert.equal(a.evaluation.legacy.pass,true);assert.equal(a.merges.length,1);assert.equal(a.exactOriginalCellSetBoundaryPreserved,true);assert.equal(digest(jsonBytes(a)),digest(jsonBytes(b)));
 const fresh=makeFreshSliverCells(a.cells,f.parents,'ABW'),topology=freshSliverTopology(fresh.cells,f.envelope,'ABW');assert.doesNotThrow(()=>jsonBytes(topology));
});
test('shared physical metrics preserve every frozen pre-change measurement in the 23-country intake',()=>{
 const root='reports/prompt15/15-22-sliver-repair/20261028-sliver-ea5d422387',countries=JSON.parse(fs.readFileSync(root+'/intake.json')).countries;for(const c of countries){const f=JSON.parse(fs.readFileSync(root+'/fixtures/'+c+'.json')),byId=new Map(f.measurements.map(m=>[m.id,m]));for(const cell of f.cells){const old=byId.get(cell.id),actual=physicalMetrics(cell.geometry);for(const key of ['areaKm2','diameterKm','aspectRatio','vertices'])assert.equal(actual[key],old[key],`${c}:${cell.id}:${key}`);}}
});
