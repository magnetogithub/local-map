import STRtree from 'jsts/org/locationtech/jts/index/strtree/STRtree.js';
import Envelope from 'jsts/org/locationtech/jts/geom/Envelope.js';
import {compareText,hashCanonical,polygons} from './prompt14-catalog-core.mjs';
import {distanceKm} from './prompt15-cell-core.mjs';

export const TASK_15_20_VERSION='prompt15-task-15-20-world-indices-v1';
export const TOPOLOGY_BUCKETS=256;
export const BOUNDARY_DISTANCE_TOLERANCE_DEGREES=1e-12;
export const FIXED_GRID_COVERAGE_TOLERANCE_DEGREES=Math.SQRT2*1e-12+1e-15;

export const comparePoint=(a,b)=>a[0]-b[0]||a[1]-b[1];
export const segmentKey=(a,b)=>`${a[0]},${a[1]};${b[0]},${b[1]}`;
export const segmentBucket=value=>{let hash=2166136261;for(let index=0;index<value.length;index++)hash=Math.imul(hash^value.charCodeAt(index),16777619);return hash&(TOPOLOGY_BUCKETS-1);};

export function canonicalSegment(a,b){
 if(a[0]===180&&b[0]===180){a=[-180,a[1]];b=[-180,b[1]];}
 if(comparePoint(a,b)===0)return null;
 const side=comparePoint(a,b)<0?0:1;if(side)[a,b]=[b,a];
 return {a,b,side,key:segmentKey(a,b)};
}

export function geometrySegmentRecords(feature,ordinal){
 const records=[];for(const polygon of polygons(feature.geometry))for(const ring of polygon)for(let index=1;index<ring.length;index++){
  const sourceA=ring[index-1],sourceB=ring[index],segment=canonicalSegment(sourceA,sourceB);if(!segment)continue;
  const mapCut=sourceA[0]===sourceB[0]&&(sourceA[0]===-180||sourceA[0]===180)?String(sourceA[0]):sourceA[1]===sourceB[1]&&(sourceA[1]===-90||sourceA[1]===90)?`pole:${sourceA[1]}`:null;
  records.push(mapCut?[segment.a,segment.b,ordinal,segment.side,mapCut]:[segment.a,segment.b,ordinal,segment.side]);
 }
 return records;
}

export function planarArea(geometry){
 let total=0;for(const polygon of polygons(geometry))for(const [ringIndex,ring] of polygon.entries()){let twiceArea=0;const [originX,originY]=ring[0];for(let index=1;index<ring.length;index++)twiceArea+=(ring[index-1][0]-originX)*(ring[index][1]-originY)-(ring[index][0]-originX)*(ring[index-1][1]-originY);total+=(ringIndex===0?1:-1)*Math.abs(twiceArea)/2;}return Math.max(0,total);
}

export function boundaryIndex(collection,idForFeature=feature=>feature.properties.countryId){
 const byIdentity=new Map(),segments=new Map(),globalTree=new STRtree();
 for(const feature of collection.features){const identity=idForFeature(feature);if(typeof identity!=='string'||!identity)throw Error('Boundary feature is missing an immutable identity');const tree=byIdentity.get(identity)??new STRtree();byIdentity.set(identity,tree);
  for(const polygon of polygons(feature.geometry))for(const ring of polygon)for(let index=1;index<ring.length;index++){
   const sourceA=ring[index-1],sourceB=ring[index],canonical=canonicalSegment(sourceA,sourceB);if(!canonical)continue;const {a,b,key,side}=canonical,segment=segments.get(key)??{a,b,identities:[],intervalsByIdentity:new Map(),periodicIntervalsByIdentity:new Map(),ordinaryIdentities:new Set(),sidesByIdentity:new Map(),mapCutsByIdentity:new Map()},mapCut=sourceA[0]===sourceB[0]&&(sourceA[0]===-180||sourceA[0]===180)?String(sourceA[0]):sourceA[1]===sourceB[1]&&(sourceA[1]===-90||sourceA[1]===90)?`pole:${sourceA[1]}`:null;
   if(!segment.identities.includes(identity)){segment.identities.push(identity);segment.intervalsByIdentity.set(identity,[]);segment.periodicIntervalsByIdentity.set(identity,new Map());segment.sidesByIdentity.set(identity,new Set());segment.mapCutsByIdentity.set(identity,new Set());segments.set(key,segment);const item={identity,segment},envelope=new Envelope(a[0],b[0],Math.min(a[1],b[1]),Math.max(a[1],b[1]));tree.insert(envelope,item);globalTree.insert(envelope,item);}
   segment.sidesByIdentity.get(identity).add(side);if(mapCut){segment.mapCutsByIdentity.get(identity).add(mapCut);const periodic=segment.periodicIntervalsByIdentity.get(identity);if(!periodic.has(mapCut))periodic.set(mapCut,[]);}else segment.ordinaryIdentities.add(identity);
  }
 }
 return {byIdentity,segments,globalTree};
}

export function boundaryMatch(a,b,identity,index,{distanceTolerance=BOUNDARY_DISTANCE_TOLERANCE_DEGREES,gapTolerance=FIXED_GRID_COVERAGE_TOLERANCE_DEGREES}={}){
 const tree=index.byIdentity.get(identity);if(!tree)return {pass:false,matches:[],maximumDistance:Infinity,gapDegrees:Math.hypot(b[0]-a[0],b[1]-a[1]),neighbors:[],sourceSides:[],mapCuts:[]};
 const box=new Envelope(Math.min(a[0],b[0]),Math.max(a[0],b[0]),Math.min(a[1],b[1]),Math.max(a[1],b[1]));box.expandBy(distanceTolerance);
 const intervals=[],matches=[],dx=b[0]-a[0],dy=b[1]-a[1],denominator=dx*dx+dy*dy,length=Math.sqrt(denominator);let maximumDistance=0;
 for(const iterator=tree.query(box).iterator();iterator.hasNext();){const indexed=iterator.next(),segment=indexed.segment,sx=segment.b[0]-segment.a[0],sy=segment.b[1]-segment.a[1],sourceDenominator=sx*sx+sy*sy;
  const distance=point=>Math.abs((point[0]-segment.a[0])*sy-(point[1]-segment.a[1])*sx)/Math.sqrt(sourceDenominator),candidateDistance=Math.max(distance(a),distance(b));if(candidateDistance>distanceTolerance)continue;
  const t=point=>((point[0]-a[0])*dx+(point[1]-a[1])*dy)/denominator,low=Math.max(0,Math.min(t(segment.a),t(segment.b))),high=Math.min(1,Math.max(t(segment.a),t(segment.b)));if(high<=low)continue;
  const u=point=>((point[0]-segment.a[0])*sx+(point[1]-segment.a[1])*sy)/sourceDenominator;matches.push({identity:indexed.identity,segment,low:Math.max(0,Math.min(u(a),u(b))),high:Math.min(1,Math.max(u(a),u(b)))});intervals.push([low,high]);maximumDistance=Math.max(maximumDistance,candidateDistance);
 }
 intervals.sort((first,second)=>first[0]-second[0]);let end=0,gap=0;for(const [low,high]of intervals){gap+=Math.max(0,low-end);end=Math.max(end,high);}gap+=Math.max(0,1-end);
 return {pass:gap*length<=gapTolerance&&matches.length>0,matches,maximumDistance,gapDegrees:gap*length,neighbors:[...new Set(matches.flatMap(match=>match.segment.identities).filter(candidate=>candidate!==identity))].sort(compareText),sourceSides:[...new Set(matches.flatMap(match=>[...(match.segment.sidesByIdentity.get(identity)??[])]))].sort((first,second)=>first-second),mapCuts:[...new Set(matches.flatMap(match=>[...(match.segment.mapCutsByIdentity.get(identity)??[])]))].sort(compareText)};
}

export function boundaryMatches(a,b,index,options={}){
 const {distanceTolerance=BOUNDARY_DISTANCE_TOLERANCE_DEGREES}=options,box=new Envelope(Math.min(a[0],b[0]),Math.max(a[0],b[0]),Math.min(a[1],b[1]),Math.max(a[1],b[1]));box.expandBy(distanceTolerance);
 const identities=new Set();for(const iterator=index.globalTree.query(box).iterator();iterator.hasNext();)identities.add(iterator.next().identity);
 return [...identities].sort(compareText).map(identity=>({identity,...boundaryMatch(a,b,identity,index,options)})).filter(match=>match.matches.length>0);
}

export function recordBoundaryCoverage(match,mapCut){
 let recorded=0;for(const item of match.matches){const {segment,identity}=item;if(mapCut===undefined||mapCut===null){if(!segment.ordinaryIdentities.has(identity))continue;segment.intervalsByIdentity.get(identity).push([item.low,item.high]);}else{if(typeof mapCut!=='string'||!mapCut)throw Error('Boundary coverage map-cut marker must be a non-empty string');const intervals=segment.periodicIntervalsByIdentity.get(identity)?.get(mapCut);if(!intervals)continue;intervals.push([item.low,item.high]);}recorded++;}return recorded;
}

const intervalGapDegrees=(segment,intervals)=>{const ordered=intervals.slice().sort((first,second)=>first[0]-second[0]||first[1]-second[1]);let end=0,gap=0;for(const [low,high]of ordered){gap+=Math.max(0,low-end);end=Math.max(end,high);}gap+=Math.max(0,1-end);return gap*Math.hypot(segment.b[0]-segment.a[0],segment.b[1]-segment.a[1]);};
const emptyCoverage=()=>({count:0,maximumGapDegrees:0,segments:0,degrees:0,gaps:[]});
const recordGap=(coverage,gapDegrees,length,detail)=>{coverage.segments++;coverage.degrees+=length;coverage.maximumGapDegrees=Math.max(coverage.maximumGapDegrees,gapDegrees);if(gapDegrees>FIXED_GRID_COVERAGE_TOLERANCE_DEGREES){coverage.count++;if(coverage.gaps.length<100)coverage.gaps.push({...detail,gapDegrees,length});}};

export function uncoveredBoundaryCount(index){
 const ordinary=emptyCoverage(),periodic=emptyCoverage(),byMarker=new Map();for(const segment of index.segments.values()){const length=Math.hypot(segment.b[0]-segment.a[0],segment.b[1]-segment.a[1]);for(const identity of segment.identities){
  if(segment.ordinaryIdentities.has(identity))recordGap(ordinary,intervalGapDegrees(segment,segment.intervalsByIdentity.get(identity)),length,{identity,segment:[segment.a,segment.b]});
  for(const [mapCut,intervals]of segment.periodicIntervalsByIdentity.get(identity)){const gapDegrees=intervalGapDegrees(segment,intervals),detail={identity,mapCut,segment:[segment.a,segment.b]},coverage=byMarker.get(mapCut)??emptyCoverage();recordGap(coverage,gapDegrees,length,detail);byMarker.set(mapCut,coverage);recordGap(periodic,gapDegrees,length,detail);}
 }}
 const markers=[...byMarker].sort(([first],[second])=>compareText(first,second)).map(([mapCut,coverage])=>({mapCut,...coverage})),count=ordinary.count+periodic.count,maximumGapDegrees=Math.max(ordinary.maximumGapDegrees,periodic.maximumGapDegrees);
 return {count,maximumGapDegrees,ordinary,periodic:{...periodic,markers},mapCutSegments:periodic.segments,mapCutDegrees:periodic.degrees};
}

export function classifyCells(left,right){
 if(!right)return 'coast';
 if(left.sourceCountryId!==right.sourceCountryId)return 'country';
 if(left.parentKey!==right.parentKey)return left.adminId===null||right.adminId===null?'residual':'administrative';
 return 'operational';
}

export function edgeFlags(left,right,boundaryClass){
 return {positiveAdjacency:Boolean(right),country:boundaryClass==='country',administrative:Boolean(right)&&left.parentKey!==right.parentKey&&left.adminId!==null&&right.adminId!==null,residual:Boolean(right)&&left.parentKey!==right.parentKey&&(left.adminId===null||right.adminId===null),previous:!right||left.oldTerritoryId!==right.oldTerritoryId};
}

export function makeEdge(cells,leftOrdinal,rightOrdinal,a,b,ordinal){
 if(!Number.isInteger(leftOrdinal)||leftOrdinal<1||leftOrdinal>cells.length)throw Error('Invalid left cell ordinal');
 if(rightOrdinal!==0&&(!Number.isInteger(rightOrdinal)||rightOrdinal<1||rightOrdinal>cells.length||rightOrdinal===leftOrdinal))throw Error('Invalid right cell ordinal');
 const left=cells[leftOrdinal-1],right=rightOrdinal?cells[rightOrdinal-1]:null,boundaryClass=classifyCells(left,right),flags=edgeFlags(left,right,boundaryClass),geometry={type:'LineString',coordinates:[a,b]},lengthKm=distanceKm(a,b);if(!(lengthKm>0))throw Error('Topology edge is not a positive-length shared segment');
 const identity={leftCellId:left.id,rightCellId:right?.id??null,boundaryClass,flags,geometry},id=`edge:operational:${hashCanonical('prompt15-task-15-20-edge.v1',identity)}`;
 return {id,ordinal,left:leftOrdinal,right:rightOrdinal,boundaryClass,flags,geometry,lengthKm};
}

export function validateMembershipIndexes(cells,administrative,previous){
 const errors=[],adminSeen=new Uint8Array(cells.length+1),oldSeen=new Uint8Array(cells.length+1),parentKeys=new Set(),oldIds=new Set();
 if(administrative.cellCount!==cells.length||previous.cellCount!==cells.length)errors.push('cell-count');
 if(!Array.isArray(administrative.parents)||!Array.isArray(administrative.cellOrdinals)||!Array.isArray(previous.parents)||!Array.isArray(previous.cellOrdinals))errors.push('csr-shape');
 let adminCursor=0;for(const parent of administrative.parents??[]){if(parentKeys.has(parent.parentKey)||!Number.isInteger(parent.start)||parent.start!==adminCursor||!Number.isInteger(parent.count)||parent.count<=0)errors.push('administrative-parent-contract');parentKeys.add(parent.parentKey);for(let index=parent.start;index<parent.start+parent.count;index++){const ordinal=administrative.cellOrdinals[index],cell=Number.isInteger(ordinal)&&ordinal>=1&&ordinal<=cells.length?cells[ordinal-1]:null;if(!cell||adminSeen[ordinal]||cell.parentKey!==parent.parentKey||cell.sourceCountryId!==parent.sourceCountryId||cell.adminId!==parent.adminId)errors.push('administrative-membership');if(cell)adminSeen[ordinal]=1;}adminCursor+=parent.count;}
 if(adminCursor!==administrative.cellOrdinals?.length||administrative.cellOrdinals?.length!==cells.length)errors.push('administrative-csr-length');
 for(let ordinal=1;ordinal<=cells.length;ordinal++)if(adminSeen[ordinal]!==1)errors.push('administrative-omission');
 let oldCursor=0;for(const parent of previous.parents??[]){if(oldIds.has(parent.oldTerritoryId)||!Number.isInteger(parent.start)||parent.start!==oldCursor||!Number.isInteger(parent.count)||parent.count<=0)errors.push('previous-parent-contract');oldIds.add(parent.oldTerritoryId);for(let index=parent.start;index<parent.start+parent.count;index++){const ordinal=previous.cellOrdinals[index],cell=Number.isInteger(ordinal)&&ordinal>=1&&ordinal<=cells.length?cells[ordinal-1]:null;if(!cell||oldSeen[ordinal]||cell.oldTerritoryId!==parent.oldTerritoryId||cell.sourceCountryId!==parent.sourceCountryId)errors.push('previous-parent-membership');if(cell)oldSeen[ordinal]=1;}oldCursor+=parent.count;}
 if(oldCursor!==previous.cellOrdinals?.length||previous.cellOrdinals?.length!==cells.length)errors.push('previous-csr-length');
 if((previous.oldParentOrdinalByCell??[]).length!==cells.length)errors.push('previous-forward-count');else for(let ordinal=1;ordinal<=cells.length;ordinal++){const parentOrdinal=previous.oldParentOrdinalByCell[ordinal-1],parent=Number.isInteger(parentOrdinal)&&parentOrdinal>=1?previous.parents[parentOrdinal-1]:null;if(!parent||parent.oldTerritoryId!==cells[ordinal-1].oldTerritoryId)errors.push('previous-forward-mapping');}
 for(let ordinal=1;ordinal<=cells.length;ordinal++)if(oldSeen[ordinal]!==1)errors.push('previous-parent-omission');
 return {pass:errors.length===0,errors:[...new Set(errors)].sort(compareText),counts:{cells:cells.length,administrativeParents:parentKeys.size,previousParents:oldIds.size,administrativeMemberships:adminSeen.reduce((sum,value)=>sum+value,0),previousMemberships:oldSeen.reduce((sum,value)=>sum+value,0)}};
}
