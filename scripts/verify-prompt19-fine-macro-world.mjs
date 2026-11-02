// Independent geometry, lineage and decoded-tile checks for the fine-derived macro world.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import {gunzipSync} from 'node:zlib';
import crypto from 'node:crypto';
import polygonClipping from 'polygon-clipping';
import GeoJSONReader from 'jsts/org/locationtech/jts/io/GeoJSONReader.js';
import IsValidOp from 'jsts/org/locationtech/jts/operation/valid/IsValidOp.js';
import RelateOp from 'jsts/org/locationtech/jts/operation/relate/RelateOp.js';
import OverlayOp from 'jsts/org/locationtech/jts/operation/overlay/OverlayOp.js';
import CommonBitsOp from 'jsts/org/locationtech/jts/precision/CommonBitsOp.js';
import {VectorTile} from '@mapbox/vector-tile';
import {PbfReader} from 'pbf';
import {geometryMetadata,polygons,canonical} from './prompt14-catalog-core.mjs';

const read=p=>JSON.parse(fs.readFileSync(p));
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const checked=a=>{const b=fs.readFileSync(a.path);assert.equal(b.length,a.byteLength,a.path);assert.equal(sha(b),a.sha256,a.path);return JSON.parse(b);};
const pointer=read('data/runtime/operational-catalog/current.json');
const gz=p=>JSON.parse(gunzipSync(fs.readFileSync(`${pointer.root}/${p}`)));
const artifactIndex=checked({path:`${pointer.root}/artifact-index.json`,...pointer.index});
const provenancePin=artifactIndex.artifacts.find(a=>a.path==='provenance.json');assert.ok(provenancePin,'The catalog must pin its provenance');
const provenance=checked({...provenancePin,path:`${pointer.root}/${provenancePin.path}`});
const inputPin=provenance.inputs.find(a=>a.sha256===provenance.inputRoot);assert.ok(inputPin,'The catalog must pin its joined input');
const bundlePath=inputPin.path,bundle=checked(inputPin);
assert.ok(bundle.report.fineMacro,'This verifier requires a fine-derived macro input');
const reconciliation=bundle.report.nationalBoundaryReconciliation??null;
let nationalVerification=null,nationalVerificationPin=null;
if(reconciliation){
  assert.equal(reconciliation.schemaVersion,'prompt19-national-boundary-reconciliation-v1');
  assert.equal(reconciliation.basis,'game-boundary-reconciliation');
  assert.equal(reconciliation.geometryAdjusted,true);assert.equal(reconciliation.rawSourceArtifactGeometryUnmodified,true);
  for(const flag of ['administrativeTruthClaim','countryEnvelopeGeometryChanged','nationalBoundaryGeometryChanged','otherCountryGeometryChanged'])assert.equal(reconciliation[flag],false,flag);
  assert.deepEqual(provenance.nationalBoundaryReconciliation,reconciliation);
  assert.deepEqual(provenance.nationalBoundaryInput,bundle.report.nationalBoundaryInput);
  assert.ok(bundle.report.nationalBoundaryInput?.bundle&&bundle.report.nationalBoundaryInput?.cells,'Reconciliation must pin its pre-adjustment mesh and cells');
  checked(bundle.report.nationalBoundaryInput.cells);
  nationalVerificationPin=provenance.nationalBoundaryVerification;
  assert.ok(nationalVerificationPin,'Adjusted geometry requires the pinned independent national verification');
  nationalVerification=checked(nationalVerificationPin);assert.equal(nationalVerification.pass,true);assert.deepEqual(nationalVerification.failures,[]);
  const identity=a=>({path:a.path,sha256:a.sha256,byteLength:a.byteLength});
  assert.deepEqual(nationalVerification.after,identity(inputPin),'Independent national verification must inspect this exact active input');
  assert.deepEqual(nationalVerification.before,identity(bundle.report.nationalBoundaryInput.bundle));
  assert.equal(nationalVerification.unchangedOtherCountries,245);assert.equal(nationalVerification.changedOtherFeatures,0);
  assert.ok(nationalVerification.countries.every(c=>c.removedFineAreaDegreesSquared<=1e-10&&c.unprovenAddedFineAreaDegreesSquared<=1e-10&&Math.abs(c.residualAccountingErrorDegreesSquared)<=1e-10&&typeof c.residualOnlyGainProof==='string'&&c.residualOnlyGainProof.length>0&&c.invalid===0&&c.interiorOverlaps===0&&c.positiveAreaOverlaps===0&&c.predicateErrors===0));
  assert.ok(nationalVerification.sources.every(s=>s.removedAreaDegreesSquared<=1e-10&&s.unprovedGainAreaDegreesSquared<=1e-10&&s.overclaimedAssignmentAreaDegreesSquared<=1e-10&&s.macroMismatch===0&&s.provenanceFailures===0));
}else{
  assert.equal(provenance.nationalBoundaryReconciliation??null,null,'A non-adjusted input cannot claim reconciliation in provenance');
}
const before=checked(reconciliation?bundle.report.nationalBoundaryInput.bundle:bundle.report.fineMacroInput.bundle);
if(reconciliation){
  const expectedFamilies=new Set(before.features.filter(f=>f.properties?.fineSourceIdentity).map(f=>`${f.properties.countryId}|${f.properties.fineSourceIdentity.sourceId}|${f.properties.fineSourceIdentity.sourceFeatureId}`));
  assert.equal(new Set(nationalVerification.sources.map(s=>s.source)).size,nationalVerification.sources.length,'National audit source families must be unique');
  assert.deepEqual(new Set(nationalVerification.sources.map(s=>s.source)),expectedFamilies,'National audit must cover every pre-adjustment fine family');
  assert.deepEqual(new Set(nationalVerification.countries.map(c=>c.country)),new Set(['KOR','PRK']));
  assert.ok(nationalVerification.numericalAreaToleranceDegreesSquared>0&&nationalVerification.numericalAreaToleranceDegreesSquared<=1e-10);
  if(nationalVerification.comparisonPrecisionNormalization){
    assert.ok(nationalVerification.comparisonPrecisionNormalization.maximumVertexDisplacementDegrees<=1e-12);
    assert.ok(nationalVerification.comparisonPrecisionNormalization.maximumSymmetricDifferenceAreaBoundDegreesSquared<=1e-10);
  }
  for(const key of ['missingEdgeSides','nationalBoundaryNotMesh','coastBoundaryNotMesh','invalidInteriorEdges'])assert.equal(nationalVerification.topology[key],0,key);
  assert.ok(nationalVerification.topology.crossCountryOverlapAreaDegreesSquared<=1e-10);
}
const records=new Map(bundle.records.map(r=>[r.id,r])),features=new Map(bundle.features.map(f=>[f.id,f]));
const beforeRecords=new Map(before.records.map(r=>[r.id,r]));
const beforeFeatures=new Map(before.features.map(f=>[f.id,f]));
const descriptor=read(`${pointer.root}/catalog.json`),detail=read(`${pointer.root}/detail-index.json`),parents=gz('metadata/parents.json.gz');
const rows=detail.countries.flatMap(c=>gz(c.metadata.path).rows.map(r=>({country:c.countryId,row:r})));
const byOrdinal=new Map(rows.map(v=>[v.row[0],v]));
const edges=detail.edgeDetails.flatMap(s=>gz(s.artifact.path).edges);
const edgeByOrdinal=new Map(edges.map(e=>[e.ordinal,e]));
const adjacency=gz('adjacency.json.gz'),reader=new GeoJSONReader();
const selected=c=>c==='KOR'||c==='PRK';
const area=coords=>coords.length?geometryMetadata({type:'MultiPolygon',coordinates:coords}).area:0;
const overlayFallbacks={jsts:0,commonBits:0};
const differenceArea=(a,b)=>{try{return area(polygonClipping.difference(polygons(a),polygons(b)));}catch(original){try{const n=OverlayOp.difference(reader.read(a),reader.read(b)).getArea();overlayFallbacks.jsts++;return n;}catch{try{const n=new CommonBitsOp(true).difference(reader.read(a),reader.read(b)).getArea();overlayFallbacks.commonBits++;return n;}catch{throw original;}}}};
const tolerance=1e-10;
const envelopes=new Map(read('data/derived/prompt19/baseline-v1/country-envelopes.geojson').features.map(f=>[f.properties.countryId,f.geometry]));
const failures=[];
const fail=(condition,message,data)=>{if(!condition)failures.push({message,...data});};
const countryReports=[];
const runtimeCells=new Map();
const pointKey=p=>`${p[0]},${p[1]}`;
const segmentKey=(a,b)=>{const x=pointKey(a),y=pointKey(b);return x<y?`${x};${y}`:`${y};${x}`;};
const segmentSet=g=>{const result=new Set();for(const poly of polygons(g))for(const ring of poly)for(let i=1;i<ring.length;i++)result.add(segmentKey(ring[i-1],ring[i]));return result;};
for(const country of ['KOR','PRK']){
  const hierarchyPin=provenance.hierarchyArtifacts.find(a=>a.countryId===country);assert.ok(hierarchyPin,'A macro catalog must pin both hierarchy crosswalks');
  assert.deepEqual(hierarchyPin,bundle.report.hierarchyArtifacts.find(a=>a.countryId===country));
  const hierarchy=checked(hierarchyPin);
  const sourceLock=checked(hierarchy.fineSourceLock),source=checked(sourceLock.normalizedInput);
  for(const a of [...hierarchy.artifacts,...hierarchy.preprocessing?.code??[]]){const bytes=fs.readFileSync(a.path);assert.equal(bytes.length,a.byteLength);assert.equal(sha(bytes),a.sha256);}
  fail(hierarchy.verification.complete===true&&hierarchy.verification.unresolved.length===0,'Incomplete macro source crosswalk',{country});
  const macroBySource=new Map(hierarchy.members.map(m=>[m.sourceFeatureId,m.macroId]));
  const sourceById=new Map(source.features.map(f=>[f.properties.sourceFeatureId,f.geometry]));
  const fc=gz(`detail/countries/${country}.geojson.gz`);
  const shapes=fc.features.map(f=>{const id=byOrdinal.get(f.id).row[1],p=features.get(id).properties,g=reader.read(f.geometry);const metadata=geometryMetadata(f.geometry);return {id,ordinal:f.id,p,geometry:f.geometry,g,...metadata};});
  let invalid=0,duplicates=0,candidates=0,interiorIntersections=0,pairClipPositive=0,pairErrors=0,boundaryContacts=0;
  let sourceOutsideMax=0,unadjustedSourceOutsideMax=0,countryOutsideMax=0,sourceChecks=0,hierarchyMismatches=0,residualsChanged=0,adjustedFineCells=0;
  const hashes=new Set();
  for(const f of shapes){
    const valid=new IsValidOp(f.g);if(!valid.isValid()){invalid++;failures.push({message:'Invalid polygon',country,id:f.id,error:valid.getValidationError()?.getMessage()});}
    const hash=sha(Buffer.from(canonical(f.geometry)));if(hashes.has(hash))duplicates++;hashes.add(hash);
    runtimeCells.set(f.ordinal,{...f,segments:segmentSet(f.geometry)});
    const outside=differenceArea(f.geometry,envelopes.get(country));countryOutsideMax=Math.max(countryOutsideMax,outside);
    if(f.p.fineSourceIdentity){
      sourceChecks++;const sourceId=f.p.fineSourceIdentity.sourceFeatureId;
      const original=sourceById.get(sourceId);fail(!!original,'Unknown original fine identity',{country,id:f.id});
      const escaped=differenceArea(f.geometry,original);sourceOutsideMax=Math.max(sourceOutsideMax,escaped);
      const adjustment=f.p.boundaryAdjustment;
      if(adjustment){
        adjustedFineCells++;assert.ok(reconciliation,'Raw-source mode cannot accept adjusted geometry');
        assert.equal(adjustment.basis,'game-boundary-reconciliation');assert.equal(adjustment.rawSourceArtifactGeometryUnmodified,true);assert.equal(adjustment.administrativeTruthClaim,false);
        assert.equal(f.p.boundaryBasis,'game-boundary-reconciliation');assert.equal(f.p.geometryBasis,'gameplay-national-boundary-reconciled');
        const audited=nationalVerification.sources.find(s=>s.source===`${country}|${f.p.fineSourceIdentity.sourceId}|${sourceId}`);
        assert.ok(audited,'Every adjusted family must appear in the pinned independent audit');
        if(escaped>tolerance){assert.equal(f.p.geometryAdjusted,true);assert.ok(audited.addedAreaDegreesSquared>tolerance);}
      }else unadjustedSourceOutsideMax=Math.max(unadjustedSourceOutsideMax,escaped);
      const row=byOrdinal.get(f.ordinal).row,parent=parents.administrative[row[2]-1];
      if(parent.macroId!==macroBySource.get(sourceId)||f.p.sourceParentId!==macroBySource.get(sourceId))hierarchyMismatches++;
    }else if(!beforeFeatures.has(f.id)||canonical(beforeFeatures.get(f.id).geometry)!==canonical(f.geometry))residualsChanged++;
  }
  const sorted=[...shapes].sort((a,b)=>a.bbox[0]-b.bbox[0]);
  for(let i=0;i<sorted.length;i++)for(let j=i+1;j<sorted.length&&sorted[j].bbox[0]<sorted[i].bbox[2];j++){
    const a=sorted[i],b=sorted[j];if(b.bbox[1]>=a.bbox[3]||b.bbox[3]<=a.bbox[1])continue;candidates++;
    try{const relation=RelateOp.relate(a.g,b.g);if(relation.get(0,0)>=0)interiorIntersections++;else if(!relation.isDisjoint())boundaryContacts++;
      const intersect=area(polygonClipping.intersection(polygons(a.geometry),polygons(b.geometry)));if(intersect>tolerance)pairClipPositive++;
    }catch(e){pairErrors++;failures.push({message:'Pair predicate error',country,a:a.ordinal,b:b.ordinal,error:e.message});}
  }
  const union=polygonClipping.union(...shapes.map(f=>polygons(f.geometry))),missing=area(polygonClipping.difference(polygons(envelopes.get(country)),union)),extra=area(polygonClipping.difference(union,polygons(envelopes.get(country))));
  const actual=geometryMetadata({type:'MultiPolygon',coordinates:union}),expected=geometryMetadata(envelopes.get(country));
  const summedArea=shapes.reduce((n,f)=>n+f.area,0);
  const report={country,cells:shapes.length,fineCells:sourceChecks,residualCells:shapes.length-sourceChecks,macroGroups:hierarchy.macroGroups.length,invalid,duplicates,bboxCandidatePairs:candidates,interiorIntersections,pairClipPositive,pairErrors,boundaryContacts,sourceContainmentContract:reconciliation?'unchanged original source plus independently verified former-residual additions':'strict original-source containment',sourceOutsideMaximumDegreesSquared:sourceOutsideMax,unadjustedSourceOutsideMaximumDegreesSquared:unadjustedSourceOutsideMax,adjustedFineCells,countryOutsideMaximumDegreesSquared:countryOutsideMax,hierarchyMismatches,residualsChanged,residualIdentityContract:reconciliation?'remaining residual area audited against the pinned pre-adjustment mesh':'unchanged residual IDs and geometry',unionMissingAreaDegreesSquared:missing,unionExtraAreaDegreesSquared:extra,unionComponents:actual.components,unionHoles:actual.holes,expectedComponents:expected.components,expectedHoles:expected.holes,summedAreaMinusEnvelopeDegreesSquared:summedArea-expected.area};
  fail(invalid===0&&duplicates===0&&interiorIntersections===0&&pairClipPositive===0&&pairErrors===0,'Geometry partition failed',{country});
  fail((reconciliation?unadjustedSourceOutsideMax:sourceOutsideMax)<=tolerance&&countryOutsideMax<=tolerance&&missing<=tolerance&&extra<=tolerance,'Coverage or source containment contract failed',{country});
  fail(actual.components===expected.components&&actual.holes===expected.holes&&hierarchyMismatches===0&&(reconciliation||residualsChanged===0),'Macro lineage or fixed shape changed',{country});
  countryReports.push(report);
}
let unchangedCountries=0;
for(const c of detail.countries.filter(c=>!selected(c.countryId))){
  const oldRoot='data/derived/prompt19/coarse-world-v1';
  const oldRows=JSON.parse(gunzipSync(fs.readFileSync(`${oldRoot}/${c.metadata.path}`))).rows;
  const old=JSON.parse(gunzipSync(fs.readFileSync(`${oldRoot}/${c.detail.path}`))).features;
  const now=gz(c.detail.path).features,nowRows=gz(c.metadata.path).rows;
  const oldMap=new Map(old.map((f,i)=>[oldRows[i][1],canonical(f.geometry)])),nowMap=new Map(now.map((f,i)=>[nowRows[i][1],canonical(f.geometry)]));
  assert.deepEqual(nowMap,oldMap);unchangedCountries++;
}
const national=(value,rs)=>value.edges.filter(e=>e.rightTerritoryId&&rs.get(e.leftTerritoryId).countryId!==rs.get(e.rightTerritoryId).countryId&&(selected(rs.get(e.leftTerritoryId).countryId)||selected(rs.get(e.rightTerritoryId).countryId))).map(e=>({pair:[rs.get(e.leftTerritoryId).countryId,rs.get(e.rightTerritoryId).countryId].sort().join('|'),geometry:canonical(e.geometry)})).sort((a,b)=>a.pair.localeCompare(b.pair)||a.geometry.localeCompare(b.geometry));
const nationalBefore=national(before,beforeRecords),nationalAfter=national(bundle,records);
const nationalEdgesByteExact=canonical(nationalAfter)===canonical(nationalBefore);
if(reconciliation){
  assert.ok(nationalVerification.countries.every(c=>c.oldOutlineUncoveredSegments===0&&c.newOutlineUncoveredSegments===0),'National linework may change only by proven collinear noding');
  assert.equal(nationalVerification.topology.nationalBoundaryNotMesh,0);assert.equal(nationalVerification.topology.coastBoundaryNotMesh,0);
}else assert.deepEqual(nationalAfter,nationalBefore);
const nationalCounts={};for(const e of nationalAfter)nationalCounts[e.pair]=(nationalCounts[e.pair]??0)+1;
let missingAdjacency=0,phantomAdjacency=0,macroEdges=0,macroNotFineBoundary=0,macroSameSourceSeams=0,macroLabelsEqual=0;
const expectedAdjacency=Array.from({length:rows.length},()=>new Set());
for(const e of edges){
  if(e.right){expectedAdjacency[e.left-1].add(e.right);expectedAdjacency[e.right-1].add(e.left);}
  const left=runtimeCells.get(e.left),right=runtimeCells.get(e.right);
  if(left&&right&&byOrdinal.get(e.left).country===byOrdinal.get(e.right).country&&left.p.fineSourceIdentity&&right.p.fineSourceIdentity&&left.p.sourceFeatureId===right.p.sourceFeatureId)macroSameSourceSeams++;
  if(e.boundaryClass!=='administrative'||!left||!right||!selected(byOrdinal.get(e.left).country)||byOrdinal.get(e.left).country!==byOrdinal.get(e.right).country)continue;
  macroEdges++;
  if(!left.p.fineSourceIdentity||!right.p.fineSourceIdentity)macroNotFineBoundary++;
  const a=parents.administrative[byOrdinal.get(e.left).row[2]-1],b=parents.administrative[byOrdinal.get(e.right).row[2]-1];if(a.macroId===b.macroId)macroLabelsEqual++;
  for(let i=1;i<e.geometry.coordinates.length;i++){const k=segmentKey(e.geometry.coordinates[i-1],e.geometry.coordinates[i]);if(!left.segments.has(k)||!right.segments.has(k)){macroNotFineBoundary++;break;}}
}
for(let n=1;n<=rows.length;n++){const actual=new Set(adjacency.neighbors.slice(adjacency.offsets[n-1],adjacency.offsets[n]));for(const x of expectedAdjacency[n-1])if(!actual.has(x))missingAdjacency++;for(const x of actual)if(!expectedAdjacency[n-1].has(x))phantomAdjacency++;}
fail(unchangedCountries===245&&missingAdjacency===0&&phantomAdjacency===0,'Other countries or adjacency changed',{});
fail(macroEdges>0&&macroNotFineBoundary===0&&macroSameSourceSeams===0&&macroLabelsEqual===0,'Promoted macro boundaries are not a quotient of fine boundaries',{});

const tileChecks={tiles:0,koreaEdges:0,samples:0,maximumBoundaryDistanceQuantizationUnits:0,strictThresholdQuantizationUnits:1.01,overOneUnit:0,certifiedCollinearRoundingCorners:0,uncertifiedThresholdExceedances:0,missingAdjacentFeature:0,examples:[],cornerCertificates:[]};
const distance=(p,a,b)=>{const dx=b.x-a.x,dy=b.y-a.y,d=dx*dx+dy*dy,t=d?Math.max(0,Math.min(1,((p.x-a.x)*dx+(p.y-a.y)*dy)/d)):0;return Math.hypot(p.x-a.x-t*dx,p.y-a.y-t*dy);};
const projectToTile=([longitude,latitude],z,x,y)=>{const sin=Math.sin(latitude*Math.PI/180);return {x:4096*((longitude/360+.5)*2**z-x),y:4096*(Math.max(0,Math.min(1,.5-.25*Math.log((1+sin)/(1-sin))/Math.PI))*2**z-y)};};
const rawCountryCells=new Map();
const rawGeometryFor=ordinal=>{const country=byOrdinal.get(ordinal).country;if(!rawCountryCells.has(country))rawCountryCells.set(country,new Map(gz(`detail/countries/${country}.geojson.gz`).features.map(f=>[f.id,f.geometry])));return rawCountryCells.get(country).get(ordinal);};
const cornerCertificate=({point,decodedSegment,edge,cell,z,x,y,observed})=>{
  if(!decodedSegment||!Number.isInteger(point.x)||!Number.isInteger(point.y))return null;
  const [decodedA,decodedB]=decodedSegment,project=v=>projectToTile(v,z,x,y),roundsTo=(v,q)=>Math.round(v.x)===q.x&&Math.round(v.y)===q.y;
  const norm=(a,b)=>Math.hypot(a.x-b.x,a.y-b.y),rounding=v=>norm(v,{x:Math.round(v.x),y:Math.round(v.y)});
  for(const worldPoint of edge.geometry.coordinates){
    const projectedPoint=project(worldPoint);if(!roundsTo(projectedPoint,point))continue;
    for(const poly of polygons(rawGeometryFor(cell)))for(const ring of poly)for(let i=1;i<ring.length;i++){
      let worldA=ring[i-1],worldB=ring[i],projectedA=project(worldA),projectedB=project(worldB);
      if(roundsTo(projectedA,decodedB)&&roundsTo(projectedB,decodedA)){[worldA,worldB]=[worldB,worldA];[projectedA,projectedB]=[projectedB,projectedA];}
      if(!roundsTo(projectedA,decodedA)||!roundsTo(projectedB,decodedB))continue;
      const dx=worldB[0]-worldA[0],dy=worldB[1]-worldA[1],length2=dx*dx+dy*dy;if(!length2)continue;
      const t=((worldPoint[0]-worldA[0])*dx+(worldPoint[1]-worldA[1])*dy)/length2;
      const worldDistance=Math.hypot(worldPoint[0]-worldA[0]-t*dx,worldPoint[1]-worldA[1]-t*dy);
      if(t<0||t>1||worldDistance>1e-12)continue;
      const chord={x:projectedA.x+t*(projectedB.x-projectedA.x),y:projectedA.y+t*(projectedB.y-projectedA.y)};
      const errors={edgeVertex:rounding(projectedPoint),polygonA:rounding(projectedA),polygonB:rounding(projectedB)};
      if([errors.edgeVertex,errors.polygonA,errors.polygonB].some(n=>n>Math.SQRT2/2+1e-10))continue;
      const projectionDeviation=norm(projectedPoint,chord),weightedPolygonError=(1-t)*errors.polygonA+t*errors.polygonB;
      const bound=errors.edgeVertex+projectionDeviation+weightedPolygonError;
      if(observed>bound+1e-9)continue;
      return {z,x,y,edge:edge.ordinal,cell,decodedPoint:point,decodedPolygonSegment:decodedSegment,worldPoint,worldPolygonSegment:[worldA,worldB],worldSegmentParameter:t,worldSegmentDistanceDegrees:worldDistance,projectedPoint,projectedPolygonSegment:[projectedA,projectedB],roundingErrors:errors,mercatorCollinearSubdivisionDeviationQuantizationUnits:projectionDeviation,weightedPolygonRoundingErrorBound:weightedPolygonError,triangleInequalityBoundQuantizationUnits:bound,observedBoundaryDistanceQuantizationUnits:observed,native512PixelTileDeviation:observed*512/4096,theoreticalIndependentRoundingBoundQuantizationUnits:Math.SQRT2,proof:'The raw edge endpoint lies on this raw adjacent polygon segment within 1e-12 degrees; the decoded points are their exact independent nearest-integer roundings. Triangle inequality bounds the observed mismatch by the edge rounding, measured Mercator subdivision curvature, and weighted polygon endpoint rounding. No global threshold is enlarged.'};
    }
  }
  return null;
};
const mercatorY=lat=>(1-Math.log(Math.tan(Math.PI/4+lat*Math.PI/360))/Math.PI)/2;
const allBoxes=countryReports.map(r=>geometryMetadata(envelopes.get(r.country)).bbox),bbox=[Math.min(...allBoxes.map(b=>b[0])),Math.min(...allBoxes.map(b=>b[1])),Math.max(...allBoxes.map(b=>b[2])),Math.max(...allBoxes.map(b=>b[3]))];
for(let z=0;z<=6;z++){
  const n=2**z,minX=Math.max(0,Math.floor((bbox[0]+180)/360*n)-1),maxX=Math.min(n-1,Math.floor((bbox[2]+180)/360*n)+1),minY=Math.max(0,Math.floor(mercatorY(bbox[3])*n)-1),maxY=Math.min(n-1,Math.floor(mercatorY(bbox[1])*n)+1);
  for(let x=minX;x<=maxX;x++)for(let y=minY;y<=maxY;y++){
    const tile=new VectorTile(new PbfReader(gunzipSync(fs.readFileSync(`${pointer.root}/tiles/${z}/${x}/${y}.pbf.gz`))));
    const edgeLayer=tile.layers.edges,cellLayer=tile.layers.territories;if(!edgeLayer||!cellLayer)continue;
    const cells=new Map();for(let i=0;i<cellLayer.length;i++){const f=cellLayer.feature(i);cells.set(f.id,f.loadGeometry());}
    const selectedEdges=[];for(let i=0;i<edgeLayer.length;i++){const f=edgeLayer.feature(i),e=edgeByOrdinal.get(f.id);if(selected(byOrdinal.get(e.left).country)||e.right&&selected(byOrdinal.get(e.right).country))selectedEdges.push({f,e});}
    if(!selectedEdges.length)continue;tileChecks.tiles++;
    for(const {f,e}of selectedEdges){tileChecks.koreaEdges++;for(const line of f.loadGeometry())for(let i=1;i<line.length;i++){
      const a=line[i-1],b=line[i];if(a.x===b.x&&a.y===b.y)continue;const mid={x:(a.x+b.x)/2,y:(a.y+b.y)/2};if(mid.x<0||mid.x>4096||mid.y<0||mid.y>4096)continue;
      for(const cellId of[e.left,e.right].filter(Boolean)){
        const rings=cells.get(cellId);if(!rings){tileChecks.missingAdjacentFeature++;continue;}
        for(const p of [a,mid,b]){let best=Infinity,decodedSegment=null;for(const ring of rings)for(let j=0;j<ring.length;j++){const candidate=distance(p,ring[j],ring[(j+1)%ring.length]);if(candidate<best){best=candidate;decodedSegment=[ring[j],ring[(j+1)%ring.length]];}if(best===0)break;}
          tileChecks.samples++;tileChecks.maximumBoundaryDistanceQuantizationUnits=Math.max(tileChecks.maximumBoundaryDistanceQuantizationUnits,best);if(best>tileChecks.strictThresholdQuantizationUnits){
            tileChecks.overOneUnit++;const certificate=cornerCertificate({point:p,decodedSegment,edge:e,cell:cellId,z,x,y,observed:best});
            if(certificate){tileChecks.certifiedCollinearRoundingCorners++;tileChecks.cornerCertificates.push(certificate);}else tileChecks.uncertifiedThresholdExceedances++;
            if(tileChecks.examples.length<10)tileChecks.examples.push({z,x,y,edge:f.id,cell:cellId,distance:best,point:p,certified:certificate!==null});
          }
        }
      }
    }}
  }
}
fail(tileChecks.uncertifiedThresholdExceedances===0,'Decoded vector edge/cell boundary misalignment exceeds the strict threshold without an exact shared-segment rounding certificate',{});
const result={date:'2026-10-30',catalogVersion:pointer.catalogVersion,bundlePath,inputPin,pass:failures.length===0,counts:descriptor.counts,countries:countryReports,unchangedCountries,nationalEdgesByteExact,nationalBoundaryContract:reconciliation?'gameplay reconciliation with independently verified source-family inclusion and residual-only additions':'strict unchanged source geometry and residual identities',nationalBoundaryVerification:nationalVerificationPin,nationalCounts,adjacency:{missingAdjacency,phantomAdjacency},macro:{macroEdges,macroNotFineBoundary,macroSameSourceSeams,macroLabelsEqual},decodedTileAlignment:tileChecks,overlayFallbacks,numericalAreaToleranceDegreesSquared:tolerance,failures,conclusion:failures.length?'Independent verification found failures.':'KOR/PRK macro boundaries are existing fine shared edges with no overlapping territory or changed fixed national outline. Source containment is evaluated under the explicit pinned strict or gameplay-reconciliation contract.',limits:['The crosswalk must remain complete and pinned. Missing, ambiguous or unverified fine-to-macro membership must fail publication rather than selecting a majority-overlap or nearest parent.',reconciliation?'Adjusted gameplay outlines include only independently verified prior residual additions; these outlines are explicitly not unchanged raw administrative-source geometry. Unassigned residuals remain explicit.':'Source-free fixed-envelope residuals remain explicitly unassigned to a macro and keep their prior IDs/geometry; no historical macro attribution is inferred.','Fine-derived macro outlines follow the pinned fine-source distribution and do not certify all legal administrative boundaries as of 2020-01-01.','Decoded tile alignment retains the strict 1.01-unit threshold. Every exceedance requires its own raw shared-segment, Mercator-subdivision and independent integer-rounding triangle certificate; uncertified exceedances fail. Zero-area quantized tiny adjacent polygons may be absent and are counted separately.']};
fs.writeFileSync('reports/maintenance/20261030-fine-macro-independent-verification.json',JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify({catalogVersion:result.catalogVersion,pass:result.pass,countries:countryReports,unchangedCountries,nationalCounts,macro:result.macro,adjacency:result.adjacency,decodedTileAlignment:{...tileChecks,examples:undefined},failures:failures.length}));
if(!result.pass)process.exitCode=2;
