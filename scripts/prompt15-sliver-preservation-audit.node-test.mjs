import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {gunzipSync} from 'node:zlib';
import {partitionCountries,decision,validateSupplementFinding,makeCountryPacket,launchCountryWorker,batchProgress} from './prompt15-sliver-preservation-audit.mjs';
import {validateParentTransport} from './prompt15-sliver-preservation-context.mjs';
import {packetGzip,packetGunzip,validateWirePacket,PACKET_VERSION} from './prompt15-sliver-preservation-packet.mjs';
import {geometryHash,physicalMetrics} from './prompt15-preservation-audit-core.mjs';
import {hashCanonical,jsonBytes} from './prompt14-catalog-core.mjs';
function synthetic(){
 const geometry={type:'Polygon',coordinates:[[[0,0],[.02,0],[.02,.02],[0,.02],[0,0]]]},metrics=physicalMetrics(geometry),cell={id:'synthetic',ordinal:1,sourceCountryId:'TST',parentKey:'TST:p',adminId:'p',oldTerritoryId:'old',parentSourceFeatureId:'p',componentIndex:0,sourceComponentHash:geometryHash(geometry),refined:false,sourceTiny:false,areaKm2:metrics.areaKm2,diameterKm:metrics.diameterKm,geometry};
 const edges=geometry.coordinates[0].slice(1).map((b,i)=>{const a=geometry.coordinates[0][i],flags={positiveAdjacency:false,country:false,administrative:false,residual:false,previous:true},line={type:'LineString',coordinates:[a,b]},boundaryClass='coast';return {ordinal:i+1,left:1,right:0,boundaryClass,flags,geometry:line,id:`edge:operational:${hashCanonical('prompt15-task-15-20-edge.v1',{leftCellId:cell.id,rightCellId:null,boundaryClass,flags,geometry:line})}`};});
 const input={countryId:'TST',envelope:geometry,cells:[cell],expectedCells:[{...cell,geometryHash:geometryHash(geometry)}],parents:[{parentKey:cell.parentKey,adminId:'p',geometry}],previousParents:[{oldTerritoryId:'old',geometry}],sourceIdentities:['p'],administrativeMembership:[{parentKey:cell.parentKey,cellOrdinals:[1]}],previousMembership:[{oldTerritoryId:'old',cellOrdinals:[1]}],incidentEdges:edges,adjacency:new Map([[1,[]]]),tinySourceComponents:new Set(),cellMeta:o=>o===1?cell:undefined,assembly:{catalogAndGeometryByteIdenticalToBaseline:true},historicalGeneration:{countryId:'TST',status:'synthetic'},historyRole:'SYNTHETIC_ONLY',historicalCurrentCounts:[]};
 return {input,options:{cellOrdinalCapacity:1,edgeOrdinalCapacity:4}};
}
test('new draft assignment is exactly 50/50/50/50/47 and rejects duplicate or changed directory',()=>{
 const order=Array.from({length:247},(_,i)=>`X${i}`);order[0]='ABW';order[49]='COL';const groups=partitionCountries(order);assert.deepEqual(groups.map(g=>g.length),[50,50,50,50,47]);assert.equal(new Set(groups.flat()).size,247);assert.throws(()=>partitionCountries([...order.slice(1),'ABW']));const copy=order.slice();copy[5]=copy[4];assert.throws(()=>partitionCountries(copy));
});
test('current membership eight is independent of historical count nine; binary truncation/tamper rejected',()=>{
 const p={parentKey:'ABW:p',start:0,count:2,historicalParent:{cellCount:9,parentHash:'hash'}},m={parents:[p],cellOrdinals:[1,2]},t={recordBytes:4,recordCount:2,partial:false},b=Buffer.alloc(8);b.writeUInt32LE(1,0);b.writeUInt32LE(2,4);
 const row={ordinal:1,descriptor:{parentKey:'ABW:p',start:0,count:2},currentMembership:{start:0,count:2,artifact:t},historicalGeneration:{cellCount:9,parentHash:'hash',role:'PAST_EVIDENCE_ONLY; current count is currentMembership.count; no new generation PASS'}};
 validateParentTransport(m,'administrative',[row],b,t);assert.throws(()=>validateParentTransport(m,'administrative',[row],b.subarray(0,4),t));const altered=structuredClone(row);altered.currentMembership.count=9;assert.throws(()=>validateParentTransport(m,'administrative',[altered],b,t));b.writeUInt32LE(1,4);assert.throws(()=>validateParentTransport(m,'administrative',[row],b,t));
});
test('development interpretation retains strict FAIL and never waives unknown errors or failed v2',()=>{
 const strict={status:'FAIL',errors:[{code:'sliver-budget'}]},v2={eligibleV2:{pass:true},errors:[]};assert.equal(decision(strict,v2,[]),'PASS');assert.equal(strict.status,'FAIL');assert.equal(decision({...strict,errors:[{code:'new-gap'}]},v2,[]),'FAIL');assert.equal(decision(strict,{eligibleV2:{pass:false},errors:[]},[]),'FAIL');assert.equal(decision({errors:[{code:'parent-union-error'}]},v2,[]),'AUDITOR_BLOCKED');assert.equal(decision({errors:[{code:'known'}]},v2,[{errorIndex:0}]),'PASS_WITH_DECLARED_DEBT');
});
test('scoped debt requires exact source hash, selected bytes, complete interval result and preserved native failure',()=>{
 const actual={pass:false,sourceToCells:{failures:[{a:[1,2],b:[1,3],gapDegrees:1e-13}]}},f={disposition:'DEFERRED_BY_USER_SUPPLEMENT',notAWholeCountryExemption:true,strictNativeExitCode:1,strictStatus:'FAIL',actualBeforeAfterEqual:true,before:actual,after:actual,sourceComponentHash:'source',scopeBinding:{sourceComponent:'source',selectedCells:'selected'}};
 assert(validateSupplementFinding(f,actual,'source',{sha256:'selected'}));assert(!validateSupplementFinding(f,actual,'wrong',{sha256:'selected'}));assert(!validateSupplementFinding(f,actual,'source',{sha256:'other'}));assert(!validateSupplementFinding(f,{pass:true},'source',{sha256:'selected'}));assert(!validateSupplementFinding({...f,strictNativeExitCode:0},actual,'source',{sha256:'selected'}));
});
test('native synthetic country produces real strict exit zero/one and preserves raw errors without country replay',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'prompt15-packet-v2-worker-'));
 for(const bad of [false,true]){const out=path.join(dir,bad?'bad':'good');fs.mkdirSync(out);const {input,options}=synthetic();if(bad)input.expectedCells[0].areaKm2+=1;
  const packet=makeCountryPacket(input,options),file=path.join(out,'packet.gz');fs.writeFileSync(file,packetGzip(packet));const child=launchCountryWorker(file,out);
  assert.equal(child.nativeExitCode,bad?1:0,fs.readFileSync(path.join(out,'stderr.txt'),'utf8'));
  const result=JSON.parse(fs.readFileSync(path.join(out,'development.json'))),raw=JSON.parse(fs.readFileSync(path.join(out,'raw-strict.json'))),v2=JSON.parse(gunzipSync(fs.readFileSync(path.join(out,'sliver-v2.json.gz'))));
  assert.equal(result.status,bad?'FAIL':'PASS');assert.equal(result.frozenV6Strict,bad?'FAIL':'PASS');assert.equal(v2.eligibleV2.pass,true);
  assert.equal(raw.errors.length>0,bad);assert.equal(child.signal,null);assert.ok(child.pid>0);
 }
});
test('production packet constructor handles function lookup, selection presence, absent/empty/populated metric Maps and gzip round-trip',()=>{
 for(const selection of [undefined,{countryId:'TST',selectedCellInput:{kind:'RETAIN_BASELINE_GEOMETRY_ASSETS'}}])for(const metric of [undefined,new Map(),new Map([['old',{proof:{areas:[1,2],role:'synthetic-only'}}]])]){
  const {input,options}=synthetic();input.previousMetricEvidence=metric;
  const wire=makeCountryPacket(input,{...options,selection}),plain=JSON.parse(gunzipSync(packetGzip(wire))),decoded=packetGunzip(packetGzip(wire));
  assert.equal(wire.schemaVersion,PACKET_VERSION);assert.equal(Object.hasOwn(plain.input,'cellMeta'),false);assert.equal(typeof decoded.input.cellMeta,'function');assert.equal(decoded.input.cellMeta(1).id,'synthetic');
  assert.deepEqual(decoded.selection,selection??null);assert.deepEqual(plain.input.previousMetricEvidence,metric===undefined?null:[...metric]);
  assert.deepEqual(decoded.input.previousMetricEvidence,metric);assert.ok(decoded.input.adjacency instanceof Map);assert.ok(decoded.input.tinySourceComponents instanceof Set);
 }
});
test('counterpart identity/global ordinal and all Map/Set evidence survive transport',()=>{
 const {input,options}=synthetic(),foreign={...input.cells[0],id:'foreign',ordinal:900001,sourceCountryId:'OTH',parentKey:'OTH:q',parentSourceFeatureId:'q',adminId:'q',oldTerritoryId:'other'};
 input.cellMeta=o=>o===1?input.cells[0]:o===900001?foreign:undefined;input.incidentEdges[0].right=900001;input.adjacency.set(1,[900001]);input.tinySourceComponents=new Set(['TST:p:0']);
 const decoded=packetGunzip(packetGzip(makeCountryPacket(input,{...options,cellOrdinalCapacity:923413})));
 assert.deepEqual(decoded.input.cellMeta(900001),foreign);assert.deepEqual([...decoded.input.adjacency],[[1,[900001]]]);assert.deepEqual([...decoded.input.tinySourceComponents],['TST:p:0']);
});
test('membership above 512 is not truncated by the real packet path',()=>{
 const {input,options}=synthetic(),first=input.cells[0],n=600;
 input.cells=Array.from({length:n},(_,i)=>({...first,id:`synthetic:${i+1}`,ordinal:i+1}));input.expectedCells=input.cells.map(c=>({...c,geometryHash:geometryHash(c.geometry)}));
 input.cellMeta=o=>input.cells[o-1];input.incidentEdges=[];input.adjacency=new Map(input.cells.map(c=>[c.ordinal,[]]));
 for(const key of ['administrativeMembership','previousMembership']){input[key][0].cellOrdinals=input.cells.map(c=>c.ordinal);input[key][0].count=n;}
 const decoded=packetGunzip(packetGzip(makeCountryPacket(input,{...options,cellOrdinalCapacity:n})));
 assert.equal(decoded.input.administrativeMembership[0].cellOrdinals.length,n);assert.equal(decoded.input.previousMembership[0].cellOrdinals.at(-1),n);assert.equal(decoded.input.adjacency.size,n);
});
test('missing required fields, malformed ordinals/refs and noncanonical wire values fail with the field path',()=>{
 const {input,options}=synthetic();const wire=JSON.parse(gunzipSync(packetGzip(makeCountryPacket(input,options))));
 for(const [change,path] of [[w=>{delete w.input.cells;},/\$\.input\.cells/],[w=>{w.input.cells[0].ordinal=0;},/\$\.input\.cells\[0\]\.ordinal/],
  [w=>{w.cellContext=[];},/\$\.input\.cells/],[w=>{w.input.envelope.coordinates[0][0][0]=Infinity;},/\$\.input\.envelope/],
  [w=>{w.input.historicalGeneration.extra=undefined;},/\$\.input\.historicalGeneration\.extra/],[w=>{w.input.historicalGeneration.extra=()=>1;},/\$\.input\.historicalGeneration\.extra/],
  [w=>{w.input.historicalGeneration.extra=new Map();},/\$\.input\.historicalGeneration\.extra/],[w=>{w.input.historicalGeneration.extra=new Set();},/\$\.input\.historicalGeneration\.extra/]]){
  const changed=structuredClone(wire);change(changed);assert.throws(()=>validateWirePacket(changed),path);
 }
 const missingLookup=synthetic();missingLookup.input.cellMeta=()=>undefined;assert.throws(()=>makeCountryPacket(missingLookup.input,missingLookup.options),/\$\.cellContext/);
 assert.throws(()=>jsonBytes({x:undefined}),/Noncanonical/);
});
test('infrastructure accounting keeps assigned/started/completed/unexecuted and verdict counts separate',()=>{
 const initial=batchProgress(['A','B','C'],[],[],{message:'packet failed'});assert.equal(initial.assigned,3);assert.equal(initial.workersStarted,0);assert.equal(initial.completed,0);assert.equal(initial.unexecuted,3);assert.equal(initial.infrastructureBlockedBeforeStart,3);assert.deepEqual(Object.values(initial.verdictCounts),[0,0,0,0]);
 const later=batchProgress(['A','B','C'],['A','B'],[{countryId:'A',status:'FAIL'}],{message:'worker infrastructure'});assert.equal(later.completed,1);assert.equal(later.neverStarted,1);assert.equal(later.startedWithoutCompletedReport,1);assert.equal(later.unexecuted,2);assert.equal(later.verdictCounts.FAIL,1);
});
