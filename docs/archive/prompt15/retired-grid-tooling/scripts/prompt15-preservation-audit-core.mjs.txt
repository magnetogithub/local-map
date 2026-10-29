// Task 15-22. Audits supplied immutable data; never repairs or generates it.
import polygonClipping from 'polygon-clipping';
import GeoJSONReader from 'jsts/org/locationtech/jts/io/GeoJSONReader.js';
import GeoJSONWriter from 'jsts/org/locationtech/jts/io/GeoJSONWriter.js';
import UnaryUnionOp from 'jsts/org/locationtech/jts/operation/union/UnaryUnionOp.js';
import OverlayOp from 'jsts/org/locationtech/jts/operation/overlay/OverlayOp.js';
import IsValidOp from 'jsts/org/locationtech/jts/operation/valid/IsValidOp.js';
import {boundaryIndex as sourceBoundaryIndex,boundaryMatch as sourceBoundaryMatch,canonicalSegment,planarArea as indexedArea} from './prompt15-world-indices-core.mjs';
import {CELL_EXPERIMENT_POLICY as POLICY} from './prompt15-cell-policy.mjs';
import {normalizeGeometry,polygons,digest,jsonBytes,hashCanonical,compareText} from './prompt14-catalog-core.mjs';
import {signedRingArea,polygonArea} from './prompt14-exact-ring.mjs';
import {physicalMetrics} from './prompt15-cell-physical.mjs';
import {evaluateCellSlivers} from './prompt15-sliver-core.mjs';
export {physicalMetrics} from './prompt15-cell-physical.mjs';

export const AUDIT_VERSION='prompt15-task-15-22-preservation-audit-v1';
export const AUDIT_LIMITS=Object.freeze({coverageAbsolute:1e-9,coverageRelative:1e-9,boundaryDegrees:1e-12,boundaryGapDegrees:Math.SQRT2*1e-12+1e-15,previousCoverageAbsolute:2e-11});
const reader=new GeoJSONReader(),writer=new GeoJSONWriter();
export const geometryHash=geometry=>digest(jsonBytes(normalizeGeometry(geometry)));
export const shape=geometry=>({components:polygons(geometry).length,holes:polygons(geometry).reduce((sum,p)=>sum+p.length-1,0)});
export function ringArea(ring){return signedRingArea(ring);}
export function planarArea(geometry){return polygons(geometry).reduce((sum,p)=>sum+polygonArea(p),0);}
// Only computed overlays may be empty or lower dimensional. Never use this
// adapter to admit a source/cell: partitionCoverage validates those separately.
export function overlayPolygons(geometry){
  if(!geometry||typeof geometry!=='object')throw Error('Invalid overlay geometry');
  if(geometry.type==='GeometryCollection'){
    if(!Array.isArray(geometry.geometries))throw Error('Invalid overlay collection');
    return geometry.geometries.flatMap(overlayPolygons);
  }
  if(['Point','MultiPoint','LineString','MultiLineString'].includes(geometry.type)){
    if(!Array.isArray(geometry.coordinates))throw Error('Invalid overlay coordinates');return [];
  }
  if(!['Polygon','MultiPolygon'].includes(geometry.type)||!Array.isArray(geometry.coordinates))throw Error('Invalid polygonal overlay');
  const components=geometry.type==='Polygon'?[geometry.coordinates]:geometry.coordinates;
  // JSTS GeoJSONWriter serializes an empty Polygon as coordinates:[[]].
  return components.filter(p=>!(Array.isArray(p)&&(p.length===0||p.length===1&&Array.isArray(p[0])&&p[0].length===0)));
}
export const overlayArea=geometry=>overlayPolygons(geometry).reduce((sum,coordinates)=>sum+planarArea({type:'Polygon',coordinates}),0);
const overlayGeometry=geometry=>({type:'MultiPolygon',coordinates:overlayPolygons(geometry)});
function assertSourceGeometry(geometry){
  const components=polygons(geometry);
  if(!Array.isArray(components)||!components.length)throw Error('Empty source geometry');
  for(const p of components){
    if(!Array.isArray(p)||!p.length)throw Error('Empty source polygon');
    for(const ring of p)if(!Array.isArray(ring)||ring.length<4||ring.some(point=>!Array.isArray(point)||point.length!==2||!point.every(Number.isFinite)||Math.abs(point[0])>180||Math.abs(point[1])>90)||ring[0][0]!==ring.at(-1)[0]||ring[0][1]!==ring.at(-1)[1]||ringArea(ring)===0)throw Error('Invalid or degenerate source ring');
    if(!(planarArea({type:'Polygon',coordinates:p})>0))throw Error('Nonpositive source polygon');
  }
  if(!new IsValidOp(reader.read(geometry)).isValid())throw Error('Invalid source geometry');
}
export function difference(a,b){
  const left=overlayGeometry(a),right=overlayGeometry(b);
  try{return {type:'MultiPolygon',coordinates:polygonClipping.difference(left.coordinates,right.coordinates)};}
  catch{return writer.write(OverlayOp.difference(reader.read(left),reader.read(right)));}
}
export function intersection(a,b){
  const left=overlayGeometry(a),right=overlayGeometry(b);
  try{return {type:'MultiPolygon',coordinates:polygonClipping.intersection(left.coordinates,right.coordinates)};}
  catch{return writer.write(OverlayOp.intersection(reader.read(left),reader.read(right)));}
}
export function union(geometries){
  if(!geometries.length)return {type:'MultiPolygon',coordinates:[]};
  return writer.write(UnaryUnionOp.union(reader.read({type:'GeometryCollection',geometries})));
}
export function partitionCoverage(parent,parts,{absolute=AUDIT_LIMITS.coverageAbsolute,relative=AUDIT_LIMITS.coverageRelative,previousEvidence}={}){
  assertSourceGeometry(parent);for(const geometry of parts)assertSourceGeometry(geometry);
  let sumArea=0,correction=0;for(const geometry of parts){const adjusted=planarArea(geometry)-correction,next=sumArea+adjusted;correction=(next-sumArea)-adjusted;sumArea=next;}
  const joined=union(parts),parentArea=planarArea(parent),actualArea=overlayArea(joined),tolerance=Math.max(absolute,parentArea*relative),polygonalJoined=overlayGeometry(joined);
  const gapGeometry=difference(parent,joined),outsideGeometry=difference(joined,parent),gapArea=Math.max(0,overlayArea(gapGeometry)),outsideArea=Math.max(0,overlayArea(outsideGeometry)),overlapArea=Math.max(0,sumArea-actualArea),expectedShape=shape(parent),actualShape=shape(polygonalJoined);
  let supportedComponents=0;for(const coordinates of polygons(parent))if(overlayArea(intersection({type:'Polygon',coordinates},joined))>0)supportedComponents++;
  const filledHoles=[];for(const [componentIndex,p] of polygons(parent).entries())for(let holeIndex=1;holeIndex<p.length;holeIndex++){
    const hole={type:'Polygon',coordinates:[p[holeIndex]]},holeArea=planarArea(hole),excluded=difference(hole,parent),excludedHoleArea=overlayArea(excluded),filledArea=Math.max(0,overlayArea(intersection(excluded,joined)));
    if(filledArea>Math.min(tolerance,excludedHoleArea*AUDIT_LIMITS.coverageRelative))filledHoles.push({componentIndex,holeIndex,holeArea,excludedHoleArea,filledArea});
  }
  const checks={nonempty:parts.length>0,gap:gapArea<=tolerance,outside:outsideArea<=tolerance,overlap:overlapArea<=tolerance,components:supportedComponents===expectedShape.components&&actualShape.components===expectedShape.components,holes:actualShape.holes===expectedShape.holes&&filledHoles.length===0};
  const result={pass:Object.values(checks).every(Boolean),checks,parentArea,actualArea,sumArea,gapArea,outsideArea,overlapArea,tolerance,expectedShape,actualShape,supportedComponents,filledHoles,unionHash:polygonalJoined.coordinates.length?geometryHash(polygonalJoined):null};
  if(previousEvidence&&!result.pass&&checks.nonempty&&checks.overlap&&checks.components&&checks.holes&&(!checks.gap||!checks.outside)){
    const evidence=validatePreviousMetricEvidence(parent,sumArea,previousEvidence);result.previousAreaMetric=evidence;
    // The V20 2e-11 bound applies to the compensated area SUM, not each
    // symmetric-difference face. No area allowance alone can certify geometry.
    if(!checks.gap||!checks.outside){
      const location=certifyPreviousDifferenceLocations(parent,gapGeometry,outsideGeometry,previousEvidence);result.previousBoundaryCertificate=location;
      checks.gap=checks.gap||location.gap.pass;checks.outside=checks.outside||location.outside.pass;
    }
    checks.approvedPreviousArea=evidence.pass;
    result.pass=Object.values(checks).every(Boolean);
  }
  return result;
}

const compensatedSum=values=>{let sum=0,correction=0;for(const value of values){const adjusted=value-correction,next=sum+adjusted;correction=(next-sum)-adjusted;sum=next;}return sum;};
export const previousRepairLedgerRoot=ledger=>hashCanonical('prompt15-15-22-pinned-previous-ledger.v1',ledger);
export function validatePreviousMetricEvidence(parent,sumArea,evidence){
  const {countryId,oldTerritoryId,descriptor,ledger,ledgerRoot,approval,generation}=evidence,fail=message=>{throw Error(`Invalid approved previous-area evidence: ${message}`);};
  if(!descriptor||descriptor.sourceCountryId!==countryId||descriptor.oldTerritoryId!==oldTerritoryId||descriptor.geometryHash!==geometryHash(parent))fail('parent/country/hash correspondence');
  if(approval?.status!=='pass'||!approval.checks||!Object.keys(approval.checks).length||!Object.values(approval.checks).every(value=>value===true)||approval.independent?.status!=='pass'||!approval.independent.checks||!['parentUnions','sourceCorrespondence','sourceComponentLineage','boundaryCorrespondence','repairEvidence','completeByteReplay'].every(key=>approval.independent.checks[key]===true)||generation?.status!=='pass'||!generation.checks||!Object.keys(generation.checks).length||!Object.values(generation.checks).every(value=>value===true)||generation.checks.numericalNoding!==true||!(generation.maximumNodedSegmentDisplacement<=AUDIT_LIMITS.boundaryDegrees))fail('missing approved source/noding checks');
  if(approval.policy?.previousAreaAbsoluteTolerance!==AUDIT_LIMITS.previousCoverageAbsolute||approval.policy.coordinateToleranceDegrees!==AUDIT_LIMITS.boundaryDegrees||approval.policy.fixedGridCoverageToleranceDegrees!==AUDIT_LIMITS.boundaryGapDegrees)fail('metric/coordinate policy identity');
  if(!Array.isArray(ledger)||previousRepairLedgerRoot(ledger)!==ledgerRoot)fail('pinned ledger hash');
  const seen=new Set(),deltas=[],entries=[];
  for(const repair of ledger){
    const key=hashCanonical('previous-repair-identity',{ledger:repair.ledger,kind:repair.kind,geometryHash:repair.geometryHash??repair.lostGeometryHash??null,source:repair.sourceOldTerritoryId??repair.oldTerritoryId,assigned:repair.assignedOldTerritoryId??null});
    if(seen.has(key))fail('duplicate repair');seen.add(key);
    if(repair.countryId!==countryId||![repair.oldTerritoryId,repair.sourceOldTerritoryId,repair.assignedOldTerritoryId].includes(oldTerritoryId))fail('repair parent/country');
    if(repair.ledger!=='protected'||!['collapsed-protected-fragment-union','uncovered-numerical-component-assignment'].includes(repair.kind)||!(repair.area>0&&repair.area<=1e-12)||!Number.isFinite(repair.area)||!/^([a-f0-9]{64})$/.test(repair.geometryHash))fail('unsupported or malformed repair');
    if(repair.kind==='collapsed-protected-fragment-union'&&(!/^([a-f0-9]{64})$/.test(repair.beforeGeometryHash)||!/^([a-f0-9]{64})$/.test(repair.afterGeometryHash)))fail('repair geometry chain');
    if(repair.kind==='uncovered-numerical-component-assignment'&&(repair.sourceOldTerritoryId!=='numerical-unassigned'||!Number.isFinite(repair.distance)||repair.distance>AUDIT_LIMITS.boundaryDegrees))fail('unassigned repair source');
    const delta=(repair.assignedOldTerritoryId===oldTerritoryId?repair.area:0)-(repair.sourceOldTerritoryId===oldTerritoryId?repair.area:0);deltas.push(delta);entries.push({kind:repair.kind,geometryHash:repair.geometryHash,area:repair.area,delta});
  }
  const sourceArea=indexedArea(parent),delta=compensatedSum(deltas),expected=sourceArea+delta,areaDifference=Math.abs(sumArea-expected);
  if(descriptor.sourceGeometryArea!==sourceArea||descriptor.numericalRepairAreaDelta!==delta||descriptor.expectedCellUnionArea!==expected||descriptor.cellUnionArea!==sumArea||descriptor.areaDifference!==areaDifference||descriptor.tolerance!==AUDIT_LIMITS.previousCoverageAbsolute||descriptor.unionPass!==true)fail('area/sign/sum descriptor correspondence');
  return {pass:areaDifference<=AUDIT_LIMITS.previousCoverageAbsolute,definition:'abs(Kahan(sum(cell polygon area)) - (source old-parent area + signed pinned repair delta))',units:'degrees squared',sourceArea,cellAreaSum:sumArea,numericalRepairAreaDelta:delta,expectedCellArea:expected,areaDifference,tolerance:AUDIT_LIMITS.previousCoverageAbsolute,repairs:entries};
}
export function certifyPreviousDifferenceLocations(parent,gap,outside,evidence){
  const id=evidence.oldTerritoryId,index=sourceBoundaryIndex({type:'FeatureCollection',features:[{properties:{countryId:id},geometry:parent}]}),accepted=[],policy=evidence.approval.policy;
  for(const witness of evidence.boundaryRepairs??[]){
    const fail=message=>{throw Error(`Invalid previous-boundary repair: ${message}`);};
    const repair=evidence.ledger.find(r=>r.ledger==='protected'&&r.kind==='collapsed-protected-fragment-union'&&r.geometryHash===witness.repairGeometryHash&&r.afterGeometryHash===witness.repairAfterGeometryHash&&r.area===witness.repairArea&&r.sourceOldTerritoryId===witness.sourceOldTerritoryId&&r.assignedOldTerritoryId===witness.assignedOldTerritoryId);
    const owner=witness.ownerCell,other=witness.oppositeCell;
    if(!repair||witness.kind!=='protected-fragment-transfer-boundary'||!other||!owner||owner.sourceCountryId!==evidence.countryId||other.sourceCountryId!==evidence.countryId||owner.ordinal!==witness.owner||other.ordinal!==witness.otherOwner||owner.oldTerritoryId!==witness.ownerOldTerritoryId||owner.sourceComponentHash!==witness.ownerSourceComponentHash||other.sourceComponentHash!==witness.oppositeSourceComponentHash||new Set([owner.oldTerritoryId,other.oldTerritoryId]).size!==2||![owner.oldTerritoryId,other.oldTerritoryId].every(old=>[repair.sourceOldTerritoryId,repair.assignedOldTerritoryId].includes(old)))fail('owner/parent/geometry hash/area correspondence');
    const chain=cell=>{const hashes=new Set([cell.sourceComponentHash]);let changed=true;while(changed){changed=false;for(const r of evidence.ledger)if(r.assignedOldTerritoryId===cell.oldTerritoryId&&hashes.has(r.afterGeometryHash)&&!hashes.has(r.beforeGeometryHash)){hashes.add(r.beforeGeometryHash);changed=true;}}return hashes;};
    if(!(witness.lineage==='owner-component-chain'&&chain(owner).has(repair.afterGeometryHash)||witness.lineage==='opposite-component-chain'&&chain(other).has(repair.afterGeometryHash)))fail('source component chain');
    const sources=witness.protectedSources;if(!Array.isArray(sources)||sources.length!==2||!sources.every(f=>f.properties.sourceCountryId===evidence.countryId)||!sources.some(f=>f.properties.territoryId===repair.sourceOldTerritoryId)||!sources.some(f=>f.properties.territoryId===repair.assignedOldTerritoryId))fail('protected source identities');
    const sourceIndex=sourceBoundaryIndex({type:'FeatureCollection',features:sources},f=>f.properties.territoryId),[a,b]=witness.segment,options={distanceTolerance:policy.numericalRepairBoundaryToleranceDegrees,gapTolerance:policy.numericalRepairBoundaryToleranceDegrees};
    const source=sourceBoundaryMatch(a,b,repair.sourceOldTerritoryId,sourceIndex,options),assigned=sourceBoundaryMatch(a,b,repair.assignedOldTerritoryId,sourceIndex,options);
    if(!source.pass||!assigned.pass||witness.assignedPass!==true||!Number.isFinite(witness.maximumDistanceDegrees)||witness.maximumDistanceDegrees!==Math.max(source.maximumDistance,assigned.maximumDistance)||witness.sourceGapDegrees!==source.gapDegrees||witness.assignedGapDegrees!==assigned.gapDegrees||witness.maximumDistanceDegrees>policy.numericalRepairBoundaryToleranceDegrees)fail('approved local boundary displacement');
    accepted.push({a,b,repairGeometryHash:repair.geometryHash,maximumDistanceDegrees:Math.max(source.maximumDistance,assigned.maximumDistance)});
  }
  const inspect=geometry=>{
    let segments=0,ordinary=0,repaired=0,maximumDistance=0,maximumGap=0;const failures=[],localRepairs=[];
    for(const [componentIndex,p] of overlayPolygons(geometry).entries())for(const [ringIndex,ring] of p.entries())for(let i=1;i<ring.length;i++){
      const segment=canonicalSegment(ring[i-1],ring[i]);if(!segment)continue;segments++;
      const match=sourceBoundaryMatch(segment.a,segment.b,id,index);if(match.pass){ordinary++;maximumDistance=Math.max(maximumDistance,match.maximumDistance);maximumGap=Math.max(maximumGap,match.gapDegrees);continue;}
      const repair=accepted.find(r=>boundaryMatch(segment.a,segment.b,[{a:r.a,b:r.b}],{record:false}));
      if(repair){repaired++;localRepairs.push({componentIndex,ringIndex,edgeIndex:i-1,a:segment.a,b:segment.b,repairGeometryHash:repair.repairGeometryHash,approvedMaximumDistanceDegrees:repair.maximumDistanceDegrees});}
      else failures.push({componentIndex,ringIndex,edgeIndex:i-1,a:segment.a,b:segment.b,maximumDistance:match.maximumDistance,gapDegrees:match.gapDegrees});
    }
    return {pass:failures.length===0,segments,ordinary,repaired,maximumOrdinaryDistanceDegrees:maximumDistance,maximumOrdinaryGapDegrees:maximumGap,localRepairs,failures};
  };
  return {definition:'Every gap/outside edge must independently match the original source within the unchanged ordinary bound, or a specific pinned V20 repair segment with complete local lineage. No net-area cancellation is used.',coordinateToleranceDegrees:AUDIT_LIMITS.boundaryDegrees,fixedGridCoverageToleranceDegrees:AUDIT_LIMITS.boundaryGapDegrees,gap:inspect(gap),outside:inspect(outside)};
}
function setDifference(expected,actual){return [...expected].filter(value=>!actual.has(value)).sort(compareText);}
export function auditIdentitySet(expected,actual){
  const expectedSet=new Set(expected),actualSet=new Set(actual),counts=new Map();for(const value of actual)counts.set(value,(counts.get(value)??0)+1);const missing=setDifference(expectedSet,actualSet),additional=setDifference(actualSet,expectedSet),duplicates=[...counts].filter(([,count])=>count>1).map(([value])=>value).sort(compareText);
  return {pass:expectedSet.size===expected.length&&!missing.length&&!additional.length&&!duplicates.length,expectedCount:expected.length,actualCount:actual.length,missing,additional,duplicates};
}
export function auditMembership(cells,parents,entries,keyForCell,keyForParent){
  const byOrdinal=new Map(cells.map(cell=>[cell.ordinal,cell])),expectedParents=new Map(parents.map(parent=>[keyForParent(parent),parent])),seen=new Set(),seenParents=new Set(),errors=[];
  for(const entry of entries){const key=keyForParent(entry);if(!expectedParents.has(key)||seenParents.has(key))errors.push({code:'unknown-or-duplicate-parent',key});seenParents.add(key);
    if(!entry.cellOrdinals.length)errors.push({code:'empty-membership',key});
    for(const ordinal of entry.cellOrdinals){const cell=byOrdinal.get(ordinal);if(!cell||keyForCell(cell)!==key||seen.has(ordinal))errors.push({code:'shared-wrong-or-unknown-cell',key,ordinal});seen.add(ordinal);}
  }
  const missingCells=cells.filter(cell=>!seen.has(cell.ordinal)).map(cell=>cell.ordinal),missingParents=setDifference(new Set(expectedParents.keys()),seenParents);
  return {pass:!errors.length&&!missingCells.length&&!missingParents.length,errors,missingCells,missingParents,cellCount:cells.length,parentCount:parents.length};
}
function positiveGeometry(geometry){
  if(geometry.type!=='Polygon'||polygons(geometry).length!==1||!geometry.coordinates.length)return false;
  for(const [i,ring] of geometry.coordinates.entries())if(ring.length<4||ring.some(p=>p.length!==2||!p.every(Number.isFinite)||Math.abs(p[0])>180||Math.abs(p[1])>90)||ring[0][0]!==ring.at(-1)[0]||ring[0][1]!==ring.at(-1)[1]||!(i===0?ringArea(ring)>0:ringArea(ring)<0))return false;
  return new IsValidOp(reader.read(geometry)).isValid();
}
const segmentPoints=(a,b)=>a[0]===180&&b[0]===180?[[-180,a[1]],[-180,b[1]]]:[a,b];
export function boundarySegments(geometry){
  const segments=[];for(const p of polygons(geometry))for(const ring of p)for(let i=1;i<ring.length;i++){
    const originalA=ring[i-1],originalB=ring[i],[a,b]=segmentPoints(originalA,originalB),mapCut=originalA[0]===originalB[0]&&Math.abs(originalA[0])===180||originalA[1]===originalB[1]&&Math.abs(originalA[1])===90;
    if(a[0]!==b[0]||a[1]!==b[1])segments.push({a,b,mapCut,intervals:[]});
  }return segments;
}
export function boundaryMatch(a,b,segments,{record=true}={}){
  [a,b]=segmentPoints(a,b);const dx=b[0]-a[0],dy=b[1]-a[1],length=Math.hypot(dx,dy),intervals=[];if(!length)return false;
  for(const segment of segments){const sx=segment.b[0]-segment.a[0],sy=segment.b[1]-segment.a[1],den=sx*sx+sy*sy,len=Math.sqrt(den);
    if(Math.max(Math.abs((a[0]-segment.a[0])*sy-(a[1]-segment.a[1])*sx),Math.abs((b[0]-segment.a[0])*sy-(b[1]-segment.a[1])*sx))/len>AUDIT_LIMITS.boundaryDegrees)continue;
    const t=p=>((p[0]-a[0])*dx+(p[1]-a[1])*dy)/(length*length),lo=Math.max(0,Math.min(t(segment.a),t(segment.b))),hi=Math.min(1,Math.max(t(segment.a),t(segment.b)));if(hi<=lo)continue;intervals.push([lo,hi]);
    if(record){const u=p=>((p[0]-segment.a[0])*sx+(p[1]-segment.a[1])*sy)/den;segment.intervals.push([Math.max(0,Math.min(u(a),u(b))),Math.min(1,Math.max(u(a),u(b)))]);}
  }
  intervals.sort((a,b)=>a[0]-b[0]);let end=0,gap=0;for(const [lo,hi] of intervals){gap+=Math.max(0,lo-end);end=Math.max(end,hi);}gap+=Math.max(0,1-end);return intervals.length>0&&gap*length<=AUDIT_LIMITS.boundaryGapDegrees;
}
export function uncoveredBoundary(segments){
  let count=0,mapCutClosures=0;for(const segment of segments){if(segment.mapCut){mapCutClosures++;continue;}let end=0,gap=0;for(const [lo,hi] of segment.intervals.sort((a,b)=>a[0]-b[0])){gap+=Math.max(0,lo-end);end=Math.max(end,hi);}gap+=Math.max(0,1-end);if(gap*Math.hypot(segment.b[0]-segment.a[0],segment.b[1]-segment.a[1])>AUDIT_LIMITS.boundaryGapDegrees)count++;}return {count,mapCutClosures};
}

export function auditCountryData(input){
  const {countryId,cells,parents,previousParents,envelope,expectedCells,sourceIdentities,administrativeMembership,previousMembership,incidentEdges,cellMeta,adjacency}=input;
  const errors=[],reject=(code,detail)=>{errors.push({code,detail});},capture=(code,fn)=>{try{return fn();}catch(error){reject(code,{name:error.name,message:error.message});return null;}};
  const expectedAdministrative=parents.filter(parent=>parent.adminId!==null),identities=auditIdentitySet(sourceIdentities,expectedAdministrative.map(parent=>String(parent.adminId)));if(!identities.pass)reject('source-identity-preservation',identities);
  const ids=auditIdentitySet(expectedCells.map(cell=>cell.id),cells.map(cell=>cell.id));if(!ids.pass)reject('cell-identity',ids);
  const ordinalSet=new Set(cells.map(cell=>cell.ordinal));if(ordinalSet.size!==cells.length||cells.some(cell=>!Number.isSafeInteger(cell.ordinal)||cell.ordinal<1))reject('cell-ordinal','duplicate or invalid');
  const membership=auditMembership(cells,parents,administrativeMembership,c=>c.parentKey,p=>p.parentKey);if(!membership.pass)reject('administrative-membership',membership);
  const previous=auditMembership(cells,previousParents,previousMembership,c=>c.oldTerritoryId,p=>p.oldTerritoryId);if(!previous.pass)reject('previous-membership',previous);
  const expectedById=new Map(expectedCells.map(cell=>[cell.id,cell])),parentByKey=new Map(parents.map(parent=>[parent.parentKey,parent])),groups=new Map(),oldGroups=new Map(),boundary=new Map(),metrics=[];
  for(const cell of cells){
    const expected=expectedById.get(cell.id),parent=parentByKey.get(cell.parentKey);
    if(cell.sourceCountryId!==countryId||!parent||cell.adminId!==parent.adminId||!expected||expected.parentKey!==cell.parentKey||expected.oldTerritoryId!==cell.oldTerritoryId||expected.ordinal!==cell.ordinal)reject('cell-lineage',cell.id);
    if(!capture('invalid-cell-geometry',()=>positiveGeometry(cell.geometry)))reject('positive-valid-single-component',cell.id);
    if(expected?.geometryHash&&capture('cell-geometry-hash',()=>geometryHash(cell.geometry))!==expected.geometryHash)reject('source-cell-geometry-changed',cell.id);
    const measured=capture('physical-metrics',()=>physicalMetrics(cell.geometry));if(measured){
      metrics.push({...measured,cellId:cell.id,sourceTiny:Boolean(cell.sourceTiny)});
      if(measured.diameterKm>(cell.refined?POLICY.boundaryMaximumDiameterKm:POLICY.interiorMaximumDiameterKm)||measured.areaKm2>(cell.refined?POLICY.boundaryMaximumAreaKm2:POLICY.interiorMaximumAreaKm2))reject('physical-resolution',cell.id);
      if(expected&&(cell.refined!==expected.refined||cell.sourceTiny!==expected.sourceTiny||Math.abs(measured.areaKm2-expected.areaKm2)>Math.max(1e-9,measured.areaKm2*1e-9)||Math.abs(measured.diameterKm-expected.diameterKm)>1e-9))reject('metric-or-classification-mismatch',cell.id);
      if(cell.sourceTiny&&!input.tinySourceComponents.has(`${cell.parentKey}:${cell.componentIndex}`))reject('unproven-tiny-source-exception',cell.id);
    }
    const group=groups.get(cell.parentKey)??[];group.push(cell.geometry);groups.set(cell.parentKey,group);const old=oldGroups.get(cell.oldTerritoryId)??[];old.push(cell.geometry);oldGroups.set(cell.oldTerritoryId,old);
    capture('cell-boundary-index',()=>boundary.set(cell.ordinal,boundarySegments(cell.geometry)));
  }
  const coverages=[];for(const parent of parents){const result=capture('parent-union-error',()=>partitionCoverage(parent.geometry,groups.get(parent.parentKey)??[]));coverages.push({parentKey:parent.parentKey,...result});if(!result?.pass)reject('parent-geometry-conservation',parent.parentKey);}
  const oldCoverage=[];for(const parent of previousParents){const result=capture('previous-union-error',()=>partitionCoverage(parent.geometry,oldGroups.get(parent.oldTerritoryId)??[],{absolute:AUDIT_LIMITS.previousCoverageAbsolute,relative:0,previousEvidence:input.previousMetricEvidence?.get(parent.oldTerritoryId)}));oldCoverage.push({oldTerritoryId:parent.oldTerritoryId,...result});if(!result?.pass)reject('previous-geometry-conservation',parent.oldTerritoryId);}
  const countryCoverage=capture('country-union-error',()=>partitionCoverage(envelope,cells.map(cell=>cell.geometry)));if(!countryCoverage?.pass)reject('country-geometry-conservation',countryId);
  const edgesSeen=new Set(),neighbors=new Map(cells.map(cell=>[cell.ordinal,new Set()]));let ownedEdges=0;
  for(const edge of incidentEdges){
    const left=cellMeta(edge.left),right=edge.right?cellMeta(edge.right):null,coordinates=edge.geometry?.coordinates;
    if(edgesSeen.has(edge.ordinal)||!left||edge.right&&!right||edge.left===edge.right||edge.geometry?.type!=='LineString'||coordinates?.length!==2){reject('edge-incidence',edge.ordinal);continue;}edgesSeen.add(edge.ordinal);if(left.sourceCountryId===countryId)ownedEdges++;
    const cls=!right?'coast':left.sourceCountryId!==right.sourceCountryId?'country':left.parentKey===right.parentKey?'operational':left.adminId===null||right.adminId===null?'residual':'administrative',flags={positiveAdjacency:Boolean(right),country:cls==='country',administrative:Boolean(right)&&left.parentKey!==right.parentKey&&left.adminId!==null&&right.adminId!==null,residual:Boolean(right)&&left.parentKey!==right.parentKey&&(left.adminId===null||right.adminId===null),previous:!right||left.oldTerritoryId!==right.oldTerritoryId};
    if(edge.boundaryClass!==cls||JSON.stringify(Object.entries(edge.flags).sort())!==JSON.stringify(Object.entries(flags).sort()))reject('edge-class-flags',edge.ordinal);
    const id=`edge:operational:${hashCanonical('prompt15-task-15-20-edge.v1',{leftCellId:left.id,rightCellId:right?.id??null,boundaryClass:cls,flags,geometry:edge.geometry})}`;if(id!==edge.id)reject('canonical-edge-id',edge.ordinal);
    for(const [owner,other] of [[edge.left,edge.right],[edge.right,edge.left]])if(ordinalSet.has(owner)){
      if(!boundaryMatch(coordinates[0],coordinates[1],boundary.get(owner)??[]))reject('nonpositive-or-nonshared-edge',{edge:edge.ordinal,cell:owner});
      if(other)neighbors.get(owner).add(other);
    }
  }
  let mapCutClosures=0;for(const cell of cells){const uncovered=uncoveredBoundary(boundary.get(cell.ordinal)??[]);mapCutClosures+=uncovered.mapCutClosures;if(uncovered.count)reject('missing-cell-boundary',{cell:cell.id,count:uncovered.count});const expected=[...(adjacency.get(cell.ordinal)??[])].sort((a,b)=>a-b),actual=[...neighbors.get(cell.ordinal)].sort((a,b)=>a-b);if(JSON.stringify(expected)!==JSON.stringify(actual)||new Set(expected).size!==expected.length||expected.includes(cell.ordinal))reject('adjacency-edge-mismatch',cell.ordinal);}
  const sliverEvaluation=capture('sliver-source-proof',()=>evaluateCellSlivers(cells,parents)),sliverFraction=sliverEvaluation?.legacy.count.ratio??null,sliverAreaFraction=sliverEvaluation?.legacy.area.ratio??null,vertices=metrics.reduce((sum,m)=>sum+m.vertices,0);
  if(sliverEvaluation?.errors.length)reject('sliver-source-proof',sliverEvaluation.errors);
  if(cells.length>POLICY.budgets.countryCells)reject('country-cell-cap',cells.length);
  if(sliverEvaluation&&!sliverEvaluation.legacy.pass)reject('sliver-budget',{sliverFraction,sliverAreaFraction});
  return {task:'15-22',schemaVersion:AUDIT_VERSION,countryId,status:errors.length?'FAIL':'PASS',checks:{identities,membership,previousMembership:previous,parentCoverage:coverages,previousCoverage:oldCoverage,countryCoverage},counts:{cells:cells.length,vertices,administrativeParents:expectedAdministrative.length,residualParents:parents.length-expectedAdministrative.length,previousParents:previousParents.length,incidentEdges:edgesSeen.size,ownedEdges,mapCutClosures},metrics:{maximumDiameterKm:metrics.reduce((max,m)=>Math.max(max,m.diameterKm),0),maximumAreaKm2:metrics.reduce((max,m)=>Math.max(max,m.areaKm2),0),sliverFraction,sliverAreaFraction},cellOrdinals:cells.map(c=>c.ordinal).sort((a,b)=>a-b),ownedEdgeOrdinals:incidentEdges.filter(e=>cellMeta(e.left)?.sourceCountryId===countryId).map(e=>e.ordinal).sort((a,b)=>a-b),errors};
}

export function joinCountryAudits(countryOrder,reports,expectedCounts){
  const errors=[],byCountry=new Map(),cellOwners=new Map(),edgeOwners=new Map();let vertices=0;
  for(const report of reports){
    const check=report.checks,complete=check?.identities?.pass===true&&check?.membership?.pass===true&&check?.previousMembership?.pass===true&&check?.countryCoverage?.pass===true&&Array.isArray(check?.parentCoverage)&&check.parentCoverage.length===report.counts?.administrativeParents+report.counts?.residualParents&&check.parentCoverage.every(p=>p.pass===true)&&Array.isArray(check?.previousCoverage)&&check.previousCoverage.length===report.counts?.previousParents&&check.previousCoverage.every(p=>p.pass===true);
    if(report.schemaVersion!==AUDIT_VERSION||report.status!=='PASS'||!Array.isArray(report.errors)||report.errors.length||!complete||byCountry.has(report.countryId)||!countryOrder.includes(report.countryId)){errors.push({code:'country-verdict',countryId:report.countryId});continue;}byCountry.set(report.countryId,report);
    if(report.counts?.cells!==report.cellOrdinals?.length||report.counts?.ownedEdges!==report.ownedEdgeOrdinals?.length||!Number.isSafeInteger(report.counts?.vertices)||report.counts.vertices<0){errors.push({code:'country-counts',countryId:report.countryId});continue;}vertices+=report.counts.vertices;
    for(const [ordinals,owners,limit,kind] of [[report.cellOrdinals,cellOwners,expectedCounts.cells,'cell'],[report.ownedEdgeOrdinals,edgeOwners,expectedCounts.edges,'edge']])for(const ordinal of ordinals){if(!Number.isSafeInteger(ordinal)||ordinal<1||ordinal>limit||owners.has(ordinal))errors.push({code:`${kind}-duplicate-or-range`,ordinal,countryId:report.countryId});owners.set(ordinal,report.countryId);}
  }
  const missingCountries=countryOrder.filter(countryId=>!byCountry.has(countryId));if(missingCountries.length)errors.push({code:'missing-countries',countries:missingCountries});
  if(cellOwners.size!==expectedCounts.cells)errors.push({code:'cell-universe',expected:expectedCounts.cells,actual:cellOwners.size});if(edgeOwners.size!==expectedCounts.edges)errors.push({code:'edge-universe',expected:expectedCounts.edges,actual:edgeOwners.size});
  for(const [name,count,cap] of [['cells',cellOwners.size,POLICY.budgets.worldCells],['vertices',vertices,POLICY.budgets.worldVertices],['edges',edgeOwners.size,POLICY.budgets.worldEdges]])if(count>cap)errors.push({code:'world-cap',name,count,cap});
  return {task:'15-22',schemaVersion:AUDIT_VERSION,status:errors.length?'FAIL':'PASS',counts:{countries:byCountry.size,cells:cellOwners.size,vertices,edges:edgeOwners.size},errors};
}
