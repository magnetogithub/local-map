import test from 'node:test';
import assert from 'node:assert/strict';
import GeoJSONReader from 'jsts/org/locationtech/jts/io/GeoJSONReader.js';
import {mergeCollapsedCells} from './prompt15-r3-collapse.mjs';
import {commonNodeRings} from './prompt14-boundary-arrangement.mjs';
import {normalizeGeometry} from './prompt14-catalog-core.mjs';
const feature=(id,ring,partition='same')=>({type:'Feature',properties:{countryId:'AAA',sourceCountryId:'AAA',sourceFeatureId:id,inputRole:'P1',parentSourceFeatureId:partition,parentKey:`AAA:${partition}`,parentHash:'source',componentIndex:0,refined:false},geometry:{type:'Polygon',coordinates:[ring]}});
test('a positive face collapsing at fixed precision survives an exact same-partition shared-edge union',()=>{
 const bad=feature('bad',[[1,0],[1+2e-13,0],[1,.01],[1,0]]),neighbor=feature('neighbor',[[.99,0],[1,0],[1,.01],[.99,.01],[.99,0]]),reader=new GeoJSONReader(),a=reader.read(bad.geometry).getArea(),b=reader.read(neighbor.geometry).getArea();assert.ok(a>0);
 const result=mergeCollapsedCells([bad,neighbor],new Set(['bad']));assert.equal(result.features.length,1);assert.ok(Math.abs(reader.read(result.features[0].geometry).getArea()-(a+b))<1e-18);assert.equal(result.evidence[0].parentSourceFeatureId,'same');assert.ok(result.evidence[0].sharedLengthDegrees>0);
 const noded=commonNodeRings({features:[]},{features:result.features});assert.doesNotThrow(()=>normalizeGeometry(noded.selected.features[0].geometry));
});
test('representation-collapse handling rejects a neighbor belonging to another administrative/protected partition or component',()=>{
 const bad=feature('bad',[[1,0],[1+2e-13,0],[1,.01],[1,0]]),wrong=feature('wrong',[[.99,0],[1,0],[1,.01],[.99,.01],[.99,0]],'different');assert.throws(()=>mergeCollapsedCells([bad,wrong],new Set(['bad'])),/no unique safe/);
 wrong.properties.parentSourceFeatureId='same';wrong.properties.parentHash='source';wrong.properties.componentIndex=1;assert.throws(()=>mergeCollapsedCells([bad,wrong],new Set(['bad'])),/no unique safe/);
});
