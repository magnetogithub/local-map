import assert from 'node:assert/strict';
import test from 'node:test';
import {boundaryIndex,boundaryMatch,boundaryMatches,classifyCells,edgeFlags,geometrySegmentRecords,planarArea,recordBoundaryCoverage,segmentKey,uncoveredBoundaryCount,validateMembershipIndexes} from './prompt15-world-indices-core.mjs';

const polygon=coordinates=>({type:'Feature',properties:{},geometry:{type:'Polygon',coordinates:[coordinates]}});
const sharedPairs=features=>{const groups=new Map();features.forEach((feature,index)=>{for(const [a,b,ordinal,side] of geometrySegmentRecords(feature,index+1)){const key=segmentKey(a,b),group=groups.get(key)??[[],[]];group[side].push(ordinal);groups.set(key,group);}});return [...groups.values()].flatMap(([left,right])=>left.length===1&&right.length===1&&left[0]!==right[0]?[[left[0],right[0]].sort((a,b)=>a-b)]:[]);};

test('15-20 topology admits only exact positive shared segments, not point, sea gap, bbox or remote components',()=>{
 const adjacent=polygon([[0,0],[1,0],[1,1],[0,1],[0,0]]),neighbor=polygon([[1,0],[2,0],[2,1],[1,1],[1,0]]),pointOnly=polygon([[2,1],[3,1],[3,2],[2,2],[2,1]]),seaGap=polygon([[1.01,0],[2.01,0],[2.01,1],[1.01,1],[1.01,0]]),remote=polygon([[20,20],[21,20],[21,21],[20,21],[20,20]]);
 assert.deepEqual(sharedPairs([adjacent,neighbor,pointOnly,seaGap,remote]),[[1,2]]);
});

test('15-20 boundary classes and overlapping flags preserve country, admin, residual and previous meanings',()=>{
 const base={id:'a',sourceCountryId:'AAA',parentKey:'AAA:one',adminId:'one',oldTerritoryId:'old-1'};
 assert.equal(classifyCells(base,null),'coast');
 assert.equal(classifyCells(base,{...base,id:'b',sourceCountryId:'BBB',parentKey:'BBB:two',adminId:'two',oldTerritoryId:'old-2'}),'country');
 assert.equal(classifyCells(base,{...base,id:'b',parentKey:'AAA:two',adminId:'two'}),'administrative');
 assert.equal(classifyCells(base,{...base,id:'b',parentKey:'AAA:residual',adminId:null}),'residual');
 assert.equal(classifyCells(base,{...base,id:'b'}),'operational');
 assert.deepEqual(edgeFlags(base,{...base,id:'b',parentKey:'AAA:two',adminId:'two',oldTerritoryId:'old-2'},'administrative'),{positiveAdjacency:true,country:false,administrative:true,residual:false,previous:true});
});

const fixture=()=>{
 const cells=[{sourceCountryId:'AAA',parentKey:'AAA:one',adminId:'one',oldTerritoryId:'old-1'},{sourceCountryId:'AAA',parentKey:'AAA:one',adminId:'one',oldTerritoryId:'old-1'},{sourceCountryId:'AAA',parentKey:'AAA:residual',adminId:null,oldTerritoryId:'old-2'}];
 const administrative={cellCount:3,parents:[{parentKey:'AAA:one',sourceCountryId:'AAA',adminId:'one',start:0,count:2},{parentKey:'AAA:residual',sourceCountryId:'AAA',adminId:null,start:2,count:1}],cellOrdinals:[1,2,3]};
 const previous={cellCount:3,parents:[{oldTerritoryId:'old-1',sourceCountryId:'AAA',start:0,count:2},{oldTerritoryId:'old-2',sourceCountryId:'AAA',start:2,count:1}],cellOrdinals:[1,2,3],oldParentOrdinalByCell:[1,1,2]};return {cells,administrative,previous};
};

test('15-20 memberships are complete, disjoint and reject truncation, sharing or substituted previous parents',()=>{
 const valid=fixture();assert.equal(validateMembershipIndexes(valid.cells,valid.administrative,valid.previous).pass,true);
 const shared=structuredClone(valid);shared.administrative.cellOrdinals[2]=2;assert.equal(validateMembershipIndexes(shared.cells,shared.administrative,shared.previous).pass,false);
 const missing=structuredClone(valid);missing.administrative.parents[0].count=1;assert.equal(validateMembershipIndexes(missing.cells,missing.administrative,missing.previous).pass,false);
 const substituted=structuredClone(valid);substituted.previous.oldParentOrdinalByCell[2]=1;assert.equal(validateMembershipIndexes(substituted.cells,substituted.administrative,substituted.previous).pass,false);
 const largeCells=Array.from({length:513},()=>({sourceCountryId:'AAA',parentKey:'AAA:one',adminId:'one',oldTerritoryId:'old-1'})),largeAdministrative={cellCount:513,parents:[{parentKey:'AAA:one',sourceCountryId:'AAA',adminId:'one',start:0,count:513}],cellOrdinals:Array.from({length:513},(_,index)=>index+1)},largePrevious={cellCount:513,parents:[{oldTerritoryId:'old-1',sourceCountryId:'AAA',start:0,count:513}],cellOrdinals:Array.from({length:513},(_,index)=>index+1),oldParentOrdinalByCell:Array(513).fill(1)};
 assert.equal(validateMembershipIndexes(largeCells,largeAdministrative,largePrevious).pass,true);largeAdministrative.cellOrdinals.length=512;assert.equal(validateMembershipIndexes(largeCells,largeAdministrative,largePrevious).pass,false);
 const invalidCsr=fixture();invalidCsr.administrative.parents[1].start=1;assert.equal(validateMembershipIndexes(invalidCsr.cells,invalidCsr.administrative,invalidCsr.previous).pass,false);
});

test('15-20 boundary coverage is identity-specific and stable-offset area survives large coordinates',()=>{
 const ring=[[10,70],[11,70],[11,71],[10,71],[10,70]],collection={type:'FeatureCollection',features:[{...polygon(ring),properties:{id:'A'}},{...polygon(ring),properties:{id:'B'}}]},index=boundaryIndex(collection,feature=>feature.properties.id);
 for(let position=1;position<ring.length;position++){const match=boundaryMatch(ring[position-1],ring[position],'A',index);assert.equal(match.pass,true);recordBoundaryCoverage(match);}
 const halfCoverage=uncoveredBoundaryCount(index);assert.equal(halfCoverage.count,4);assert.equal(halfCoverage.ordinary.count,4);assert.equal(halfCoverage.ordinary.segments,8);assert.equal(halfCoverage.periodic.count,0);
 for(let position=1;position<ring.length;position++)recordBoundaryCoverage(boundaryMatch(ring[position-1],ring[position],'B',index));
 const fullCoverage=uncoveredBoundaryCount(index);assert.equal(fullCoverage.count,0);assert.equal(fullCoverage.ordinary.count,0);assert.equal(fullCoverage.periodic.count,0);
 assert.ok(Math.abs(planarArea({type:'Polygon',coordinates:[[[100,80],[100.000001,80],[100.000001,80.000001],[100,80.000001],[100,80]]]} )-1e-12)<1e-18);
});

test('15-20 global boundary matching returns and credits near-coincident identities independently',()=>{
 const offset=5e-13,first=[[0,0],[1,0],[1,1],[0,1],[0,0]],second=first.map(([x,y])=>[x,y+offset]),collection={type:'FeatureCollection',features:[{...polygon(first),properties:{id:'A'}},{...polygon(second),properties:{id:'B'}}]},index=boundaryIndex(collection,feature=>feature.properties.id),matches=boundaryMatches([0,0],[1,0],index);
 assert.deepEqual(matches.map(({identity,pass,neighbors,sourceSides,mapCuts})=>({identity,pass,neighbors,sourceSides,mapCuts})),[{identity:'A',pass:true,neighbors:[],sourceSides:[0],mapCuts:[]},{identity:'B',pass:true,neighbors:[],sourceSides:[0],mapCuts:[]}]);
 assert.deepEqual(boundaryMatches([0,0],[1,0],index,{distanceTolerance:1e-13}).map(match=>match.identity),['A']);
 assert.equal(uncoveredBoundaryCount(index).ordinary.count,8);assert.equal(recordBoundaryCoverage(matches[0]),1);assert.equal(uncoveredBoundaryCount(index).ordinary.count,7);assert.equal(recordBoundaryCoverage(matches[1]),1);assert.equal(uncoveredBoundaryCount(index).ordinary.count,6);
});

test('15-20 global boundary coverage composes partial topology intervals without admitting distant lines',()=>{
 const ring=[[0,0],[1,0],[1,1],[0,1],[0,0]],index=boundaryIndex({type:'FeatureCollection',features:[{...polygon(ring),properties:{id:'A'}}]},feature=>feature.properties.id),left=boundaryMatches([-.5,0],[.5,0],index)[0],right=boundaryMatches([.5,0],[1.5,0],index)[0];
 assert.equal(left.pass,false);assert.equal(right.pass,false);assert.equal(recordBoundaryCoverage(left),1);assert.equal(uncoveredBoundaryCount(index).ordinary.count,4);assert.equal(recordBoundaryCoverage(right),1);assert.equal(uncoveredBoundaryCount(index).ordinary.count,3);
 assert.deepEqual(boundaryMatches([0,2e-12],[1,2e-12],index),[]);
});

test('15-20 audits ordinary and marker-specific map-cut coverage without longitude cross-credit',()=>{
 const feature=polygon([[-180,-90],[180,-90],[180,-80],[-180,-80],[-180,-90]]),records=geometrySegmentRecords(feature,1),markers=records.map(record=>record[4]).filter(Boolean).sort();
 assert.deepEqual(markers,['-180','180','pole:-90']);
 const index=boundaryIndex({type:'FeatureCollection',features:[{...feature,properties:{id:'A'}}]},item=>item.properties.id),match=boundaryMatch([-180,-90],[-180,-80],'A',index);
 assert.equal(match.pass,true);assert.deepEqual(match.mapCuts,['-180','180']);assert.deepEqual(match.sourceSides,[0,1]);
 let coverage=uncoveredBoundaryCount(index);assert.equal(coverage.count,4);assert.equal(coverage.ordinary.count,1);assert.equal(coverage.periodic.count,3);assert.equal(coverage.mapCutSegments,3);
 assert.equal(recordBoundaryCoverage(match),0);assert.equal(uncoveredBoundaryCount(index).periodic.count,3);
 assert.equal(recordBoundaryCoverage(match,'-180'),1);coverage=uncoveredBoundaryCount(index);assert.equal(coverage.periodic.count,2);assert.equal(coverage.periodic.markers.find(item=>item.mapCut==='-180').count,0);assert.equal(coverage.periodic.markers.find(item=>item.mapCut==='180').count,1);
 assert.equal(recordBoundaryCoverage(match,'180'),1);coverage=uncoveredBoundaryCount(index);assert.equal(coverage.periodic.count,1);assert.equal(coverage.periodic.markers.find(item=>item.mapCut==='180').count,0);
 const pole=boundaryMatch([-180,-90],[180,-90],'A',index);assert.equal(recordBoundaryCoverage(pole,'pole:-90'),1);coverage=uncoveredBoundaryCount(index);assert.equal(coverage.periodic.count,0);assert.equal(coverage.ordinary.count,1);
 const ordinary=boundaryMatch([-180,-80],[180,-80],'A',index);assert.equal(recordBoundaryCoverage(ordinary),1);coverage=uncoveredBoundaryCount(index);assert.equal(coverage.count,0);assert.equal(coverage.maximumGapDegrees,0);
});
