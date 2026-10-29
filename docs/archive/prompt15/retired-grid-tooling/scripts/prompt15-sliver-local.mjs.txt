import {mergeSliverPair,externalCellBoundary} from './prompt15-sliver-merge.mjs';
import {evaluateCellSlivers} from './prompt15-sliver-core.mjs';
import {normalizeGeometry,polygons,jsonBytes,digest,generateAtoms} from './prompt14-catalog-core.mjs';
import {stableCellId,physicalMetrics as generationMetrics} from './prompt15-cell-core.mjs';
import {physicalMetrics} from './prompt15-cell-physical.mjs';
import {geometryHash} from './prompt15-preservation-audit-core.mjs';
import {canonicalSegment,boundaryIndex,boundaryMatch,makeEdge} from './prompt15-world-indices-core.mjs';
import {territoryIdForAtom} from './prompt14-catalog-topology.mjs';
import {CELL_EXPERIMENT_POLICY as POLICY} from './prompt15-cell-policy.mjs';
const bad=c=>{const m=physicalMetrics(c.geometry);return !c.sourceTiny&&(m.areaKm2<POLICY.sliver.areaKm2||m.aspectRatio>POLICY.sliver.aspectRatio);};
export function repairSliverCells(original,parents){
 const cells=structuredClone(original),merges=[],rejections={};
 while(!evaluateCellSlivers(cells,parents).eligibleV2.pass){
  const candidates=[];
  for(let i=0;i<cells.length;i++)for(let j=0;j<i;j++){
   const a=cells[i],b=cells[j];if(!bad(a)&&!bad(b))continue;
   if(['sourceCountryId','parentKey','adminId','oldTerritoryId','componentIndex','sourceComponentHash'].some(k=>a[k]!==b[k]))continue;
   try{const result=mergeSliverPair(a,b),areaBefore=[a,b].filter(bad).reduce((n,c)=>n+physicalMetrics(c.geometry).areaKm2,0),areaAfter=bad(result.cell)?physicalMetrics(result.cell.geometry).areaKm2:0,countGain=Number(bad(a))+Number(bad(b))-Number(bad(result.cell));if(countGain<=0&&areaBefore<=areaAfter)continue;candidates.push({i,j,result,areaGain:areaBefore-areaAfter,countGain,key:digest(jsonBytes(result.cell.geometry))});}catch(e){rejections[e.message]=(rejections[e.message]??0)+1;}
  }
  candidates.sort((a,b)=>b.areaGain-a.areaGain||b.countGain-a.countGain||(a.key<b.key?-1:a.key>b.key?1:0));
  if(!candidates.length)break;
  const {i,j,result}=candidates[0];merges.push({...result.proof,mergedFrom:result.cell.mergedFrom,afterGeometryHash:geometryHash(result.cell.geometry)});cells.splice(i,1);cells.splice(j,1,result.cell);
 }
 const oldBoundary=externalCellBoundary(original),newBoundary=externalCellBoundary(cells);if(oldBoundary.size!==newBoundary.size||[...oldBoundary].some(([k,v])=>newBoundary.get(k)?.direction!==v.direction))throw Error('Country cell-set external boundary changed');
 return {cells,merges,rejections,exactOriginalCellSetBoundaryPreserved:true,evaluation:evaluateCellSlivers(cells,parents)};
}
export function makeFreshSliverCells(cells,parents,countryId){
 const parentMap=new Map(parents.map(p=>[p.parentKey,p])),sourceVersion=parents[0]?.descriptor?.sourceVersion??'sliver-local-test';
 const features=cells.map(c=>{const p=parentMap.get(c.parentKey),geometry=normalizeGeometry(c.geometry),parentHash=geometryHash(p.geometry),sourceFeatureId=stableCellId({candidateId:'adaptive-12-24-v6',parentKey:c.parentKey,parentHash,geometry});return {type:'Feature',properties:{countryId,sourceCountryId:countryId,sourceFeatureId,inputRole:'P1',parentKey:c.parentKey,parentHash,parentSourceFeatureId:p.properties?.sourceFeatureId??p.descriptor?.sourceFeatureId??c.parentSourceFeatureId,oldTerritoryId:c.oldTerritoryId,adminId:c.adminId,componentIndex:c.componentIndex,sourceComponentHash:c.sourceComponentHash,sourceTiny:c.sourceTiny,refined:c.refined},geometry};}).sort((a,b)=>a.properties.sourceFeatureId<b.properties.sourceFeatureId?-1:1);
 const atoms=generateAtoms({selected:{type:'FeatureCollection',features},lock:{sourceVersion}}),fresh=atoms.map((a,i)=>{if(a.members.length!==1)throw Error('Fresh cell must retain one source-feature membership');const feature=features[a.members[0].featureIndex];return {id:territoryIdForAtom(a.canonicalAtomKey),...feature.properties,...generationMetrics(a.geometry),geometry:a.geometry,ordinal:i+1};});
 if(new Set(fresh.map(c=>c.id)).size!==fresh.length)throw Error('Duplicate fresh cell identity');return {cells:fresh,sourceVersion};
}
export function freshSliverTopology(cells,envelope,countryId){
 const groups=new Map(),source=boundaryIndex({type:'FeatureCollection',features:[{type:'Feature',properties:{countryId},geometry:envelope}]}),edges=[],adjacency=Object.fromEntries(cells.map(c=>[c.id,[]])),coastCertificates=[];let mapCutClosures=0;
 for(const cell of cells)for(const p of polygons(cell.geometry))for(const r of p)for(let i=1;i<r.length;i++){const a=r[i-1],b=r[i],s=canonicalSegment(a,b);if(!s)continue;const list=groups.get(s.key)??[];list.push({...s,owner:cell,originalA:a,originalB:b});groups.set(s.key,list);}
 for(const [key,sides] of [...groups].sort(([a],[b])=>a<b?-1:a>b?1:0)){
  if(sides.length>2)throw Error(`More than two fresh topology sides ${key}`);
  if(sides.length===2&&sides[0].side===sides[1].side)throw Error(`Wrong oriented shared topology edge ${key}`);
  if(sides.length===2&&sides[0].owner.id===sides[1].owner.id){if(!(sides[0].a[0]===sides[0].b[0]&&Math.abs(sides[0].a[0])===180||sides[0].a[1]===sides[0].b[1]&&Math.abs(sides[0].a[1])===90))throw Error('Same cell appears on both sides of an ordinary boundary');mapCutClosures++;continue;}
  let left=sides.find(s=>s.side===0),right=sides.find(s=>s.side===1),a=sides[0].a,b=sides[0].b;
  if(sides.length===1){const certificate=boundaryMatch(a,b,countryId,source),receipt={a,b,pass:certificate.pass,maximumDistance:certificate.maximumDistance,gapDegrees:certificate.gapDegrees,matches:certificate.matches.map(m=>({identity:m.identity,a:m.segment.a,b:m.segment.b,low:m.low,high:m.high}))};if(!certificate.pass)throw Object.assign(Error('Fresh coast has no fixed original boundary certificate'),{evidence:receipt});coastCertificates.push(receipt);if(a[0]===b[0]&&Math.abs(a[0])===180||a[1]===b[1]&&Math.abs(a[1])===90){mapCutClosures++;continue;}if(!left){left=right;right=null;[a,b]=[b,a];}}
  const e=makeEdge(cells,left.owner.ordinal,right?.owner.ordinal??0,a,b,edges.length+1);edges.push({...e,leftTerritoryId:left.owner.id,rightTerritoryId:right?.owner.id??null});if(right){adjacency[left.owner.id].push(right.owner.id);adjacency[right.owner.id].push(left.owner.id);}
 }
 for(const key of Object.keys(adjacency))adjacency[key]=[...new Set(adjacency[key])].sort();return {edges,adjacency,evidence:{coastCertificates,mapCutClosures,nodingPerformed:false,pointOnlyContactCreatesAdjacency:false,freshOrdinals:true,freshEdgeIds:true}};
}
