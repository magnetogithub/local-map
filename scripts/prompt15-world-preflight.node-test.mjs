import fs from 'node:fs';
import assert from 'node:assert/strict';
import test from 'node:test';
import {identitySetAudit,sourceComponentsAgainstEnvelope,overlay} from './prompt15-world-preflight.mjs';
import {validatePartitionCoverage} from './prompt14-source-gate.mjs';
const square=(w,s,e,n)=>({type:'Polygon',coordinates:[[[w,s],[e,s],[e,n],[w,n],[w,s]]]});
test('country coverage and a count of 193 cannot hide one lost source identity',()=>{
 const raw=Array.from({length:193},(_,i)=>({properties:{ne_id:String(i)}}));
 const candidate=raw.map(f=>({properties:{sourceFeatureId:f.properties.ne_id,inputRole:'P1'}}));
 candidate[192]=candidate[191];
 const audit=identitySetAudit(raw,candidate);
 assert.equal(audit.pass,false);assert.deepEqual(audit.missing,['192']);assert.deepEqual(audit.duplicates,['191']);
 assert.equal(validatePartitionCoverage(square(0,0,1,1),[square(0,0,1,1)]).pass,true);
});
test('physically tiny source islands outside the fixed envelope cannot be dropped as mesh exceptions',()=>{
 const source={type:'MultiPolygon',coordinates:[square(0,0,0.001,0.001).coordinates,square(1,1,1.001,1.001).coordinates]};
 const parts=sourceComponentsAgainstEnvelope(source,square(-0.01,-0.01,0.01,0.01));
 assert.equal(parts[0].completelyOutside,false);assert.equal(parts[1].completelyOutside,true);assert.equal(parts[1].sourceTiny,true);
 assert.ok(parts[1].outsideAreaDegreesSquared>0);assert.equal(parts[1].insideAreaDegreesSquared,0);assert.ok(parts[1].implication);
});
test('holes and disjoint positive pieces survive diagnostic intersection and difference',()=>{
 const source={type:'Polygon',coordinates:[square(0,0,3,3).coordinates[0],square(1,1,2,2).coordinates[0].slice().reverse()]};
 const inside=overlay('intersection',source,square(0,0,2.5,3)).geometry;
 const outside=overlay('difference',source,square(0,0,2.5,3)).geometry;
 assert.equal(inside.coordinates[0].length,2);
 assert.equal(validatePartitionCoverage(source,[inside,outside]).pass,true);
});
test('real CSI pinned source has positive components excluded from unchanged P0',()=>{
 const raw=JSON.parse(fs.readFileSync('data/derived/prompt14/shared-admin1-input.geojson'));
 const p0=JSON.parse(fs.readFileSync('data/derived/prompt14/shared-game-p0.geojson'));
 const source=raw.features.find(f=>String(f.properties.ne_id)==='1159315797');
 const envelope=p0.features.find(f=>f.properties.countryId==='CSI');
 const parts=sourceComponentsAgainstEnvelope(source.geometry,envelope.geometry);
 assert.equal(parts.length,21);assert.equal(parts.filter(x=>x.completelyOutside).length,20);
 assert.ok(parts.filter(x=>x.completelyOutside).every(x=>x.outsideAreaDegreesSquared>0));
});
