import fs from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {prepareAdministrativeParent} from './prompt15-parent-preparation.mjs';
import {certifyPreparedIntersection,certifyExactFaceSupport,exactSupportPartition} from './prompt15-exact-support.mjs';
import {normalizeGeometry,jsonBytes,digest,polygons} from './prompt14-catalog-core.mjs';
import {stableCellId} from './prompt15-cell-core.mjs';
const evidence='reports/prompt15/15-22-component-repair/20261028-parent-support-aae81f14ea',bytes=fs.readFileSync(`${evidence}/fixture.json`);assert.equal(digest(bytes),'e05a0f2d4625fa9f5f08a6208ea8f7a038f6d44b25f1146969994f38205f3f2c');const fixture=JSON.parse(bytes),box=(w,s,e,n)=>({type:'Polygon',coordinates:[[[w,s],[e,s],[e,n],[w,n],[w,s]]]}),sources=fixture.raw.map(p=>({id:`FRA:${p.properties.sourceFeatureId}`,geometry:p.geometry})),olds=fixture.old.map(p=>({id:p.properties.territoryId,geometry:p.geometry}));
for(const source of fixture.raw)test(`actual ${source.properties.sourceFeatureId}: production preparation refuses the lossy intersection before normalization`,()=>{
 assert.throws(()=>prepareAdministrativeParent(source.geometry,fixture.country.geometry,source.properties),error=>{assert.equal(error.code,'PREPARED_PARENT_SUPPORT_MISMATCH');assert.equal(error.evidence.stage,'intersection-before-normalization');assert.equal(error.evidence.identity.sourceFeatureId,source.properties.sourceFeatureId);assert.equal(error.evidence.admitted,false);assert.ok(error.evidence.certificate.missing.some(s=>BigInt(s.area.numerator)>0n));assert.ok(error.evidence.certificate.outside.some(s=>BigInt(s.area.numerator)>0n));return true;});
});
test('the real face is split into both positive raw owners, never assigned wholesale from six witnesses',()=>{
 const result=certifyExactFaceSupport(fixture.face,fixture.country.geometry,sources,olds),frozen=JSON.parse(fs.readFileSync(`${evidence}/face-exact-arrangement.json`));assert.equal(result.pass,true);assert.deepEqual([...new Set(result.pieces.map(p=>p.parentId))].sort(),sources.map(s=>s.id).sort());assert.ok(result.pieces.every(p=>p.oldTerritoryId===olds[0].id));
 assert.ok(result.pieces.every(p=>p.componentIndex===(p.parentId==='FRA:1159313259'?1:0)&&p.sourceComponentHash.length===64));
 const a=result.partition.sums.filter(s=>s.mask.includes('face')).map(s=>s.area).sort((a,b)=>a.numerator.localeCompare(b.numerator)),b=frozen.sums.filter(s=>s.mask.includes('face')).map(s=>s.area).sort((a,b)=>a.numerator.localeCompare(b.numerator));assert.deepEqual(a,b);assert.equal(result.partition.coordinatePowerOfTwo,frozen.coordinatePowerOfTwo);
});
test('net area cancellation cannot hide actual missing and unsupported positive support',()=>{
 const source=box(0,0,2,1),country=box(-1,-1,4,2),prepared=box(.5,0,2.5,1),certificate=certifyPreparedIntersection(source,country,prepared);assert.equal(certificate.pass,false);assert.ok(certificate.missing.length>0);assert.ok(certificate.outside.length>0);
});
test('country-exterior source ownership is rejected and a truly disjoint parent remains null',()=>{
 const country=box(0,0,1,1),face=box(.5,.5,1.5,1.5);assert.equal(certifyExactFaceSupport(face,country,[{id:'source',geometry:box(-1,-1,2,2)}],[{id:'old',geometry:box(-1,-1,2,2)}]).pass,false);assert.equal(prepareAdministrativeParent(box(2,2,3,3),country),null);
});
test('wrong parent, wrong old owner, ambiguous source and ambiguous old support remain rejected',()=>{
 const geometry=box(0,0,1,1),wrong=box(2,2,3,3),source={id:'source',geometry},old={id:'old',geometry};
 for(const [parents,olds] of [[[{...source,geometry:wrong}],[old]],[[source],[{...old,geometry:wrong}]],[[source,{id:'other',geometry}],[old]],[[source],[old,{id:'other',geometry}]]])assert.equal(certifyExactFaceSupport(geometry,geometry,parents,olds).pass,false);
 assert.throws(()=>certifyExactFaceSupport(geometry,geometry,[source,source],[old]),/distinct/);
});
test('tiny positive component, hole, and island in a hole are retained; omission and hole fill are rejected',()=>{
 const shell=box(0,0,4,4).coordinates[0],hole=box(1,1,3,3).coordinates[0].slice().reverse(),island=box(2,2,2+1e-12,2+1e-12),source={type:'MultiPolygon',coordinates:[[shell,hole],island.coordinates]},country=box(-1,-1,5,5),prepared=prepareAdministrativeParent(source,country);assert.equal(polygons(prepared).length,2);assert.equal(polygons(prepared).reduce((n,p)=>n+p.length-1,0),1);
 assert.equal(certifyPreparedIntersection(source,country,{type:'Polygon',coordinates:[shell,hole]}).pass,false);assert.equal(certifyPreparedIntersection(source,country,box(0,0,4,4)).pass,false);
});
test('normal intersection preserves canonical bytes, hash and production cell identity',()=>{
 const source=box(0,0,2,2),country=box(1,0,3,2),expected=normalizeGeometry(box(1,0,2,2)),before=Buffer.from(JSON.stringify(source)),actual=prepareAdministrativeParent(source,country),id=geometry=>stableCellId({candidateId:'fixed',parentKey:'TST:source',parentHash:'original',geometry});assert.deepEqual(jsonBytes(actual),jsonBytes(expected));assert.equal(digest(jsonBytes(actual)),digest(jsonBytes(expected)));assert.equal(id(actual),id(expected));assert.deepEqual(Buffer.from(JSON.stringify(source)),before);
});
test('invalid, empty and truly degenerate sources are still rejected',()=>{
 const country=box(0,0,3,3);for(const source of [{type:'Polygon',coordinates:[]},{type:'GeometryCollection',geometries:[]},{type:'Polygon',coordinates:[[[0,0],[1,1],[2,2],[0,0]]]},{type:'Polygon',coordinates:[[[0,0],[2,0],[0,2],[2,2],[1,2],[0,0]]]}])assert.throws(()=>prepareAdministrativeParent(source,country));
});
test('every exact positive decomposition band has complete provenance and nonzero area',()=>{
 const result=exactSupportPartition({a:box(0,0,2,2),b:box(1,1,3,3)},{keepBands:mask=>mask.includes('a')&&mask.includes('b')});assert.ok(result.bands.length);for(const b of result.bands){assert.ok(BigInt(b.area.numerator)>0n);assert.ok(b.lower.name&&b.upper.name);assert.equal(b.corners.length,4);}
});
