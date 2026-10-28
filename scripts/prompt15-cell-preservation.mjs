import Coordinate from 'jsts/org/locationtech/jts/geom/Coordinate.js';
import IteratedNoder from 'jsts/org/locationtech/jts/noding/IteratedNoder.js';
import NodedSegmentString from 'jsts/org/locationtech/jts/noding/NodedSegmentString.js';
import ArrayList from 'jsts/java/util/ArrayList.js';
import PrecisionModel from 'jsts/org/locationtech/jts/geom/PrecisionModel.js';
import MCIndexSnapRounder from 'jsts/org/locationtech/jts/noding/snapround/MCIndexSnapRounder.js';
import Polygonizer from 'jsts/org/locationtech/jts/operation/polygonize/Polygonizer.js';
import GeoJSONReader from 'jsts/org/locationtech/jts/io/GeoJSONReader.js';
import GeoJSONWriter from 'jsts/org/locationtech/jts/io/GeoJSONWriter.js';
import RelateOp from 'jsts/org/locationtech/jts/operation/relate/RelateOp.js';
import OverlayOp from 'jsts/org/locationtech/jts/operation/overlay/OverlayOp.js';
import {normalizeGeometry,polygons,digest,jsonBytes} from './prompt14-catalog-core.mjs';
import {partitionCoverage,overlayArea,intersection,geometryHash,union,physicalMetrics,overlayPolygons} from './prompt15-preservation-audit-core.mjs';
import {CELL_EXPERIMENT_POLICY as POLICY} from './prompt15-cell-policy.mjs';
import IsValidOp from 'jsts/org/locationtech/jts/operation/valid/IsValidOp.js';
import {buildCatalogTopology} from './prompt14-catalog-topology.mjs';
import {boundaryIndex,boundaryMatch,canonicalSegment} from './prompt15-world-indices-core.mjs';
import STRtree from 'jsts/org/locationtech/jts/index/strtree/STRtree.js';
import Envelope from 'jsts/org/locationtech/jts/geom/Envelope.js';
import {finiteDoubleInteger as integer,exactRingNumerator,exactRingSign,positivePolygonAreaAtMost} from './prompt14-exact-ring.mjs';
export {exactRingNumerator,exactRingSign} from './prompt14-exact-ring.mjs';
const same=(a,b)=>a[0]===b[0]&&a[1]===b[1];
const pointKey=p=>`${p[0]},${p[1]}`,compare=(a,b)=>a[0]-b[0]||a[1]-b[1],edgeKey=(a,b)=>JSON.stringify(compare(a,b)<0?[a,b]:[b,a]);
const certifiedContainmentViews=new WeakSet();
const distance=(p,a,b)=>{const dx=b[0]-a[0],dy=b[1]-a[1],den=dx*dx+dy*dy,t=den?Math.max(0,Math.min(1,((p[0]-a[0])*dx+(p[1]-a[1])*dy)/den)):0;return Math.hypot(p[0]-a[0]-t*dx,p[1]-a[1]-t*dy);};
// Exact sign for the actual finite IEEE-754 input doubles. A rounded area of
// zero is never permission to erase a source ring.
const exactGeometryArea=geometry=>polygons(normalizeGeometry(geometry)).reduce((sum,p)=>sum+p.reduce((n,r)=>n+exactRingNumerator(r),0n),0n);
export function orderedSourceRingCertificate(source,noded){
 if(!same(source[0],noded[0])||!same(source.at(-1),noded.at(-1)))return {pass:false,reason:'source endpoints changed'};
 let segment=0,previous=0n,maximumDistance=0;const exact=source.map(p=>p.map(integer));
 for(const point of noded.slice(1)){
  if(segment>=source.length-1)return {pass:false,reason:'nodes after source closure'};
  const a=exact[segment],b=exact[segment+1],p=point.map(integer),dx=b[0]-a[0],dy=b[1]-a[1],den=dx*dx+dy*dy,numerator=(p[0]-a[0])*dx+(p[1]-a[1])*dy,displacement=distance(point,source[segment],source[segment+1]);
  maximumDistance=Math.max(maximumDistance,displacement);
  if(!den||numerator<previous||numerator<0n||numerator>den||displacement>1e-12)return {pass:false,reason:'nonmonotone or displaced source subdivision',segment,point,displacement};
  if(same(point,source[segment+1])){segment++;previous=0n;}else previous=numerator;
 }
 return {pass:segment===source.length-1,originalSegments:source.length-1,representedSegments:noded.length-1,maximumDistance,distanceBoundDegrees:1e-12,exactMonotoneProjection:true,allOriginalVerticesInOrder:segment===source.length-1,sourceIntervalGaps:0,meaning:'Each continuous chain retains both original endpoints, covers the entire exact projection interval monotonically, and remains within the unchanged distance bound. Both directions are covered without extrapolating short segment lines.'};
}
export function positiveIntersectionSupport(a,b){
 if(overlayArea(intersection(a,b))>0)return true;
 // A valid positive face can be omitted by polygon-clipping without throwing.
 // The independent exact-input overlay must actually return positive polygons;
 // errors, empty outputs and line/point contacts remain failures.
 const reader=new GeoJSONReader(),writer=new GeoJSONWriter(),result=writer.write(OverlayOp.intersection(reader.read(a),reader.read(b)));if(overlayArea(result)>0)return true;
 // A proper crossing of two valid polygon boundaries proves an open positive
 // intersection even when both overlays collapse a sub-ULP face to lines.
 // Exact integer orientation uses the input doubles, with no area tolerance.
 // This is lineage support only, never permission to allocate a whole face.
 if(!new IsValidOp(reader.read(a)).isValid()||!new IsValidOp(reader.read(b)).isValid())return false;
 const edges=g=>polygons(g).flatMap(p=>p.flatMap(r=>r.slice(1).map((v,i)=>[r[i],v].map(q=>q.map(integer))))),cross=(p,q,r)=>(q[0]-p[0])*(r[1]-p[1])-(q[1]-p[1])*(r[0]-p[0]),opposite=(x,y)=>x<0n&&y>0n||x>0n&&y<0n;
 for(const [p,q] of edges(a))for(const [r,s] of edges(b))if(opposite(cross(p,q,r),cross(p,q,s))&&opposite(cross(r,s,p),cross(r,s,q)))return true;
 return false;
}
export function buildPreservedCellTopology(atoms,fixedP0,onProgress=()=>{}){
 try{return buildCatalogTopology(atoms,fixedP0,onProgress);}catch(error){
  if(!error.evidence||!error.evidence.errors?.every(e=>e.kind==='unpaired-interior-boundary'))throw error;
  const countryId=fixedP0.features[0].properties.countryId;if(fixedP0.features.length!==1||atoms.some(a=>a.identity.sourceCountryId!==countryId))throw error;
  const represented=normalizeGeometry({type:'MultiPolygon',coordinates:overlayPolygons(union(atoms.map(a=>a.geometry)))}),coverage=partitionCoverage(fixedP0.features[0].geometry,atoms.map(a=>a.geometry));if(!coverage.pass)throw Object.assign(Error('Topology representation fails original fixed envelope preservation'),{evidence:{originalTopologyFailure:error.evidence,coverage}});
  const representation={type:'FeatureCollection',features:[{type:'Feature',properties:{countryId},geometry:represented}]},fixedIndex=boundaryIndex(fixedP0),representedIndex=boundaryIndex(representation);
  const inspect=(collection,index)=>{const failures=[];let segments=0,maximumDistance=0,maximumGap=0;for(const f of collection.features)for(const p of polygons(f.geometry))for(const ring of p)for(let i=1;i<ring.length;i++){const segment=canonicalSegment(ring[i-1],ring[i]);if(!segment)continue;segments++;const match=boundaryMatch(segment.a,segment.b,countryId,index);if(!match.pass)failures.push({a:segment.a,b:segment.b,match});maximumDistance=Math.max(maximumDistance,match.maximumDistance);maximumGap=Math.max(maximumGap,match.gapDegrees);}return {pass:failures.length===0,segments,maximumDistance,maximumGap,failures};};
  const sourceToRepresentation=inspect(fixedP0,representedIndex),representationToSource=inspect(representation,fixedIndex);if(!sourceToRepresentation.pass||!representationToSource.pass)throw Object.assign(Error('Computed coast has no complete bidirectional original boundary certificate'),{evidence:{sourceToRepresentation,representationToSource,originalTopologyFailure:error.evidence}});
  const topology=buildCatalogTopology(atoms,representation,onProgress);topology.evidence.fixedEnvelopeCertificate={scope:'Topology representation only; fixed source remains independent and unchanged',fixedGeometryHash:geometryHash(fixedP0.features[0].geometry),representationGeometryHash:geometryHash(represented),coverage,sourceToRepresentation,representationToSource,distanceBoundDegrees:1e-12,intervalBoundDegrees:Math.SQRT2*1e-12+1e-15};return topology;
 }
}
export function componentBoundaryCorrespondence(source,cells){
 const incidence=new Map(),invalid=[];for(const cell of cells)for(const p of polygons(cell.geometry))for(const ring of p)for(let i=1;i<ring.length;i++){const a=ring[i-1],b=ring[i],key=edgeKey(a,b),list=incidence.get(key)??[];list.push({a,b,direction:compare(a,b)<0?1:-1});incidence.set(key,list);}
 const external=[];for(const [key,list] of incidence){if(list.length===1)external.push(list[0]);else if(list.length!==2||list[0].direction===list[1].direction)invalid.push({key,incidence:list.length});}
 const expected=polygons(source).flatMap(p=>p.flatMap(r=>r.slice(1).map((b,i)=>({a:r[i],b}))));
 const index=segments=>{const tree=new STRtree();for(const segment of segments){const {a,b}=segment;if(same(a,b))continue;tree.insert(new Envelope(Math.min(a[0],b[0]),Math.max(a[0],b[0]),Math.min(a[1],b[1]),Math.max(a[1],b[1])),segment);}return tree;};
 const inspect=(segments,tree)=>{const failures=[];let maximumDistance=0,maximumGap=0;for(const {a,b} of segments){
   const dx=b[0]-a[0],dy=b[1]-a[1],den=dx*dx+dy*dy,length=Math.sqrt(den);if(!den)continue;
   const box=new Envelope(Math.min(a[0],b[0]),Math.max(a[0],b[0]),Math.min(a[1],b[1]),Math.max(a[1],b[1]));box.expandBy(1e-12);const intervals=[];
   for(const it=tree.query(box).iterator();it.hasNext();){const {a:c,b:d}=it.next(),project=p=>((p[0]-a[0])*dx+(p[1]-a[1])*dy)/den,low=Math.max(0,Math.min(project(c),project(d))),high=Math.min(1,Math.max(project(c),project(d)));if(high<=low)continue;
    // Compare only the actual overlap, not a short segment's extended line
    // at distant query endpoints. Preserve doubles and both existing bounds.
    const measured=Math.max(...[low,high].map(t=>distance([a[0]+t*dx,a[1]+t*dy],c,d)));if(measured>1e-12)continue;maximumDistance=Math.max(maximumDistance,measured);intervals.push([low,high]);
   }
   intervals.sort((a,b)=>a[0]-b[0]);let end=0,gap=0;for(const [low,high] of intervals){gap+=Math.max(0,low-end);end=Math.max(end,high);}gap=(gap+Math.max(0,1-end))*length;maximumGap=Math.max(maximumGap,gap);if(!intervals.length||gap>Math.SQRT2*1e-12+1e-15)failures.push({a,b,gapDegrees:gap});
  }return {pass:failures.length===0,segments:segments.length,maximumDistance,maximumGap,failures};};
 const sourceToCells=inspect(expected,index(external)),cellsToSource=inspect(external,index(expected));return {pass:!invalid.length&&sourceToCells.pass&&cellsToSource.pass,sourceToCells,cellsToSource,invalidIncidence:invalid,distanceBoundDegrees:1e-12,intervalBoundDegrees:Math.SQRT2*1e-12+1e-15,meaning:'Internal fully noded opposite cell edges cancel; every original and external cell boundary interval is independently checked over actual overlapping intervals. No temporary polygon union proves its own source.'};
}
export function mergePrecisionFragileCells(features,scale,idForGeometry){
 if(!scale)return {features,repairs:[]};const pm=new PrecisionModel(scale),reader=new GeoJSONReader(),output=structuredClone(features),repairs=[];
 const survives=geometry=>polygons(geometry).every(p=>p.every(r=>{const rounded=r.map(([x,y])=>[pm.makePrecise(x),pm.makePrecise(y)]);return exactRingSign(rounded)===exactRingSign(r);}));
 for(let attempt=0;attempt<features.length;attempt++){let merged=false;for(let i=0;i<output.length;i++){const lost=output[i];if(survives(lost.geometry))continue;
   for(let j=0;j<output.length;j++){const target=output[j];if(i===j||['parentKey','parentHash','sourceComponentHash','componentIndex','oldTerritoryId'].some(k=>target.properties[k]!==lost.properties[k]))continue;
    const a=reader.read(lost.geometry),b=reader.read(target.geometry);if(!a.getEnvelopeInternal().intersects(b.getEnvelopeInternal()))continue;const shared=OverlayOp.intersection(a.getBoundary(),b.getBoundary()),length=shared.getLength();if(!(length>0))continue;
    const geometry=normalizeGeometry(union([lost.geometry,target.geometry]));if(geometry.type!=='Polygon'||exactGeometryArea(geometry)!==exactGeometryArea(lost.geometry)+exactGeometryArea(target.geometry))continue;
    const measured=physicalMetrics(geometry),refined=Boolean(lost.properties.refined||target.properties.refined);if(measured.areaKm2>(refined?POLICY.boundaryMaximumAreaKm2:POLICY.interiorMaximumAreaKm2)||measured.diameterKm>(refined?POLICY.boundaryMaximumDiameterKm:POLICY.interiorMaximumDiameterKm))continue;
    const before=[{sourceFeatureId:lost.properties.sourceFeatureId,geometryHash:geometryHash(lost.geometry)},{sourceFeatureId:target.properties.sourceFeatureId,geometryHash:geometryHash(target.geometry)}];target.properties.gridBoundsList=[...(target.properties.gridBoundsList??(target.properties.gridBounds?[target.properties.gridBounds]:[])),...(lost.properties.gridBoundsList??(lost.properties.gridBounds?[lost.properties.gridBounds]:[]))];target.geometry=geometry;target.properties.refined=refined;target.properties.sourceFeatureId=idForGeometry(target);output.splice(i,1);repairs.push({kind:'same-owner-positive-edge-exact-area-union',scale,parentKey:target.properties.parentKey,sourceComponentHash:target.properties.sourceComponentHash,componentIndex:target.properties.componentIndex,oldTerritoryId:target.properties.oldTerritoryId,before,afterSourceFeatureId:target.properties.sourceFeatureId,afterGeometryHash:geometryHash(geometry),sharedBoundaryLengthDegrees:length,exactAreaEquality:true,physical:measured});merged=true;break;
   }if(merged)break;
  }if(!merged)break;
 }
 return {features:output,repairs};
}
export function nodePreservingCellRings(p0,selected,onProgress=()=>{},scale,sourceConstraints={type:'FeatureCollection',features:[]}){
 const strings=new ArrayList(),outP0=structuredClone(p0),outSelected=structuredClone(selected),outConstraints=structuredClone(sourceConstraints);
 const pm=scale?new PrecisionModel(scale):null,changes=[];
 for(const [role,collection,out] of [['P0',p0,outP0],['P1',selected,outSelected],['SOURCE',sourceConstraints,outConstraints]])for(const [featureIndex,f] of collection.features.entries())for(const [componentIndex,p] of polygons(f.geometry).entries())for(const [ringIndex,ring] of p.entries()){
  if(!exactRingSign(ring))throw Error('Degenerate input ring; no positive geometry may be inferred');
  const coordinates=ring.map((p,i)=>{const c=new Coordinate(...p);if(pm)pm.makePrecise(c);const displacement=Math.hypot(c.x-p[0],c.y-p[1]);if(displacement>1e-12)throw Error('Precision candidate exceeds fixed displacement bound');if(displacement)changes.push({role,featureIndex,componentIndex,ringIndex,positionIndex:i,before:p,after:[c.x,c.y],displacement});return c;});
  strings.add(new NodedSegmentString(coordinates,{role,featureIndex,componentIndex,ringIndex,ring,target:polygons(out.features[featureIndex].geometry)[componentIndex]}));
 }
 onProgress(`preservation-gated common noding: ${strings.size()} rings; precision ${scale??'source doubles'}`);
 const noder=pm?new MCIndexSnapRounder(pm):new IteratedNoder(new PrecisionModel());noder.computeNodes(strings);let maximumNodedSegmentDisplacement=0,insertedNodes=0;const traces=[],edges=new Map(),iteratedCoordinates=new Map(),sourceRingCertificates=[];
 if(!pm)for(const it=noder.getNodedSubstrings().iterator();it.hasNext();){const segment=it.next(),data=segment.getData(),points=segment.getCoordinates().map(c=>[c.x,c.y]),list=iteratedCoordinates.get(data)??[];if(list.length&&!same(list.at(-1),points[0]))throw Error('Iterated noding changed source ring traversal order');list.push(...(list.length?points.slice(1):points));iteratedCoordinates.set(data,list);}
 for(const it=strings.iterator();it.hasNext();){const ss=it.next(),data=ss.getData(),coordinates=(pm?ss.getNodeList().getSplitCoordinates().map(c=>[pm.makePrecise(c.x),pm.makePrecise(c.y)]):iteratedCoordinates.get(data)).filter((p,i,list)=>!i||!same(p,list[i-1]));
  if(!pm)for(const point of data.ring)if(!coordinates.some(p=>same(p,point)))throw Error('Common noding lost an original source vertex');
  insertedNodes+=coordinates.length-data.ring.length;
  for(const nodes=ss.getNodeList().iterator();nodes.hasNext();){const node=nodes.next(),i=Math.min(node.segmentIndex,data.ring.length-2),point=pm?[pm.makePrecise(node.coord.x),pm.makePrecise(node.coord.y)]:[node.coord.x,node.coord.y],displacement=distance(point,data.ring[i],data.ring[i+1]);maximumNodedSegmentDisplacement=Math.max(maximumNodedSegmentDisplacement,displacement);if(displacement>1e-12)throw Object.assign(Error('Source-preserving node exceeds existing 1e-12 displacement bound'),{evidence:{...data,target:undefined,point,segmentIndex:i,displacement}});if(!data.ring.some(p=>same(p,point)))traces.push({role:data.role,featureIndex:data.featureIndex,componentIndex:data.componentIndex,ringIndex:data.ringIndex,segmentIndex:i,point,displacement});}
  if(!pm){let sourceIndex=0;for(const point of coordinates){if(sourceIndex<data.ring.length-1&&same(point,data.ring[sourceIndex+1]))sourceIndex++;const i=Math.min(sourceIndex,data.ring.length-2),displacement=distance(point,data.ring[i],data.ring[i+1]);maximumNodedSegmentDisplacement=Math.max(maximumNodedSegmentDisplacement,displacement);if(displacement>1e-12)throw Object.assign(Error('Iterated node exceeds existing source segment displacement bound'),{evidence:{point,sourceSegment:[data.ring[i],data.ring[i+1]],displacement}});if(!data.ring.some(p=>same(p,point)))traces.push({role:data.role,featureIndex:data.featureIndex,componentIndex:data.componentIndex,ringIndex:data.ringIndex,segmentIndex:i,point,displacement,phase:'iterated-final'});}}
  if(!pm&&sourceConstraints.features.length&&data.role!=='P1'){const certificate=orderedSourceRingCertificate(data.ring,coordinates),identity={role:data.role,featureIndex:data.featureIndex,componentIndex:data.componentIndex,ringIndex:data.ringIndex};if(!certificate.pass)throw Object.assign(Error('Common source noding fails ordered original segment correspondence'),{evidence:{...identity,...certificate}});sourceRingCertificates.push({...identity,...certificate});}
  if(exactRingSign(coordinates)!==exactRingSign(data.ring))throw Object.assign(Error('Common noding changed source ring orientation or positive area'),{evidence:{scale:scale??null,role:data.role,featureIndex:data.featureIndex,componentIndex:data.componentIndex,ringIndex:data.ringIndex,beforeRing:data.ring,afterRing:coordinates,beforeExactNumerator:exactRingNumerator(coordinates).toString(16),afterExactNumerator:exactRingNumerator(coordinates).toString(16),areaDenominatorPowerOfTwo:2149}});data.target[data.ringIndex]=coordinates;
  for(let i=1;i<coordinates.length;i++){const a=coordinates[i-1],b=coordinates[i],key=edgeKey(a,b),edge=edges.get(key)??{a:compare(a,b)<0?a:b,b:compare(a,b)<0?b:a,contexts:[]};edge.contexts.push({role:data.role,featureIndex:data.featureIndex,direction:compare(a,b)<0?1:-1});edges.set(key,edge);}
 }
 for(const f of [...outP0.features,...outSelected.features,...outConstraints.features])f.geometry=normalizeGeometry(f.geometry);
 return {p0:outP0,selected:outSelected,sourceConstraints:outConstraints,edges,evidence:{method:pm?'Common precision candidate; no geometry deletion; accepted only after original component/interior and topology gates':'IteratedNoder with RobustLineIntersector; original source vertices preserved and every final inserted node traced',scale:scale??null,maximumRoundedDisplacement:changes.reduce((m,c)=>Math.max(m,c.displacement),0),roundedPositions:changes.length,coordinateChanges:changes,maximumNodedSegmentDisplacement,insertedNodes,traces,sourceRingCertificates}};
}
function geometryFromSides(segments){
 const outgoing=new Map(),seen=new Set(),cycles=[];
 for(const [i,[a]] of segments.entries()){const list=outgoing.get(pointKey(a))??[];list.push(i);outgoing.set(pointKey(a),list);}
 const next=(a,b)=>{const candidates=outgoing.get(pointKey(b))??[],reverse=Math.atan2(a[1]-b[1],a[0]-b[0]);if(!candidates.length)throw Error('Open common face boundary');return candidates.slice().sort((i,j)=>{const turn=k=>{const c=segments[k][1];return (reverse-Math.atan2(c[1]-b[1],c[0]-b[0])+2*Math.PI)%(2*Math.PI);};return turn(i)-turn(j)||i-j;})[0];};
 for(let start=0;start<segments.length;start++)if(!seen.has(start)){let i=start;const path=[];do{if(seen.has(i))throw Error('Boundary joins another common cycle');seen.add(i);const [a,b]=segments[i];path.push(a);i=next(a,b);}while(i!==start);path.push(path[0]);const stack=[],positions=new Map();for(const p of path){const key=pointKey(p);if(positions.has(key)){const k=positions.get(key),ring=[...stack.slice(k),p];if(ring.length<4||!exactRingSign(ring))throw Error('Positive common face collapsed; do not delete');cycles.push(ring);for(const q of stack.splice(k+1))positions.delete(pointKey(q));}else{positions.set(key,stack.length);stack.push(p);}}}
 const shells=cycles.filter(r=>exactRingSign(r)>0).map(r=>[r]),holes=cycles.filter(r=>exactRingSign(r)<0),reader=new GeoJSONReader();
 for(const hole of holes){const containing=shells.filter(p=>overlayArea(intersection({type:'Polygon',coordinates:[p[0]]},{type:'Polygon',coordinates:[hole]}))>0);if(containing.length!==1)throw Error('Ambiguous actual hole owner');containing[0].push(hole);}
 if(!shells.length)throw Error('Lost all positive common faces');reader.read({type:'MultiPolygon',coordinates:shells});return normalizeGeometry({type:'MultiPolygon',coordinates:shells});
}
export function originalGridFaceOwner(geometry,features,parents,oldTerritories,containmentSources){
 if(containmentSources&&!certifiedContainmentViews.has(containmentSources))throw Error('Uncertified source containment representation');
 const reader=new GeoJSONReader(),face=reader.read(geometry),box=face.getEnvelopeInternal(),owners=[];
 for(const [index,f] of features.entries()){const boundsList=f.properties.gridBoundsList??(f.properties.gridBounds?[f.properties.gridBounds]:[]);if(!boundsList.some(bounds=>box.getMinX()>=bounds[0]&&box.getMaxX()<=bounds[2]&&box.getMinY()>=bounds[1]&&box.getMaxY()<=bounds[3]))continue;
  const parent=parents.get(f.properties.parentKey),old=oldTerritories.get(f.properties.oldTerritoryId),component=parent&&polygons(parent.geometry)[f.properties.componentIndex];if(!component||!old)continue;
  // Whole-face containment in immutable source component, protected owner and
  // the actual generating rectangle. No centroid, nearest owner or ID tie.
  const source=containmentSources?.parents.get(f.properties.parentKey)?.[f.properties.componentIndex]??{type:'Polygon',coordinates:component},protectedSource=containmentSources?.olds.get(f.properties.oldTerritoryId)??old;
  if(RelateOp.covers(reader.read(source),face)&&RelateOp.covers(reader.read(protectedSource),face))owners.push(index);
 }
 if(owners.length!==1)return null;return {owner:owners[0],proof:{kind:'unique-whole-face-source-protected-grid-containment',parentKey:features[owners[0]].properties.parentKey,oldTerritoryId:features[owners[0]].properties.oldTerritoryId,sourceComponentHash:features[owners[0]].properties.sourceComponentHash,gridBounds:features[owners[0]].properties.gridBounds,geometryHash:geometryHash(geometry),containmentModel:containmentSources?'common-noded-immutable-boundaries-with-independent-fixed-bound-certificates':'original-input-doubles'}};
}
export function certifiedSourceGapFace(geometry,parents,oldTerritories,envelope,refined,idForGeometry,containmentSources){
 if(containmentSources&&!certifiedContainmentViews.has(containmentSources))throw Error('Uncertified source containment representation');
 const reader=new GeoJSONReader(),face=reader.read(geometry),area=overlayArea(geometry);if(geometry.type!=='Polygon'||!new IsValidOp(face).isValid()||!positivePolygonAreaAtMost(geometry.coordinates,1e-12)||!RelateOp.covers(reader.read(containmentSources?.envelope??envelope),face))return null;
 const metrics=physicalMetrics(geometry);if(metrics.diameterKm>(refined?POLICY.boundaryMaximumDiameterKm:POLICY.interiorMaximumDiameterKm)||metrics.areaKm2>(refined?POLICY.boundaryMaximumAreaKm2:POLICY.interiorMaximumAreaKm2))return null;
 const sourceOwners=[];for(const [key,parent] of parents)for(const [componentIndex,coordinates] of polygons(parent.geometry).entries()){const source={type:'Polygon',coordinates},represented=containmentSources?.parents.get(key)?.[componentIndex]??source;if(!RelateOp.covers(reader.read(represented),face))continue;for(const [oldTerritoryId,old] of oldTerritories)if(RelateOp.covers(reader.read(containmentSources?.olds.get(oldTerritoryId)??old),face))sourceOwners.push({key,parent,componentIndex,source,oldTerritoryId,old});}
 if(sourceOwners.length!==1)return null;const owner=sourceOwners[0],p=owner.parent.properties,sourceMetrics=physicalMetrics(owner.source),properties={countryId:p.countryId,sourceCountryId:p.countryId,oldTerritoryId:owner.oldTerritoryId,adminId:p.inputRole==='P1'?String(p.sourceFeatureId):null,parentSourceFeatureId:p.sourceFeatureId,parentKey:owner.key,parentHash:geometryHash(owner.parent.geometry),sourceComponentHash:geometryHash(owner.source),componentIndex:owner.componentIndex,sourceTiny:sourceMetrics.areaKm2<=POLICY.tinySourceComponent.maximumAreaKm2&&sourceMetrics.diameterKm<=POLICY.tinySourceComponent.maximumDiameterKm,refined,inputRole:'P1',gridRow:null,gridColumn:null,construction:'source-certified-positive-gap-face'},feature={type:'Feature',properties,geometry};properties.sourceFeatureId=idForGeometry(feature);
 return {feature,proof:{kind:'source-certified-positive-gap-face-cell',parentKey:owner.key,sourceComponentHash:properties.sourceComponentHash,componentIndex:owner.componentIndex,oldTerritoryId:owner.oldTerritoryId,oldGeometryHash:geometryHash(owner.old),parentGeometryHash:properties.parentHash,fixedEnvelopeGeometryHash:geometryHash(envelope),geometryHash:geometryHash(geometry),areaDegrees2:area,maximumGapAreaDegrees2:1e-12,wholeSourceAndOldAndEnvelopeContainment:true,wholeOriginalDoubleContainment:RelateOp.covers(reader.read(owner.source),face)&&RelateOp.covers(reader.read(owner.old),face)&&RelateOp.covers(reader.read(envelope),face),containmentModel:containmentSources?'common-noded-immutable-boundaries-with-independent-fixed-bound-certificates':'original-input-doubles',physical:metrics,refined}};
}
// Immutable parent and protected boundaries must participate in the SAME noder
// as the country and cells. Independently rounded intersections cannot label
// faces of a different arrangement. This does not substitute generated cells
// for a source: every source ring/vertex and both directions of its boundary
// are checked against the independent original using the existing bounds.
export function certifySourceConstraint(original,represented,identity,role,featureIndex,sourceRingCertificates){
 const reader=new GeoJSONReader(),a=polygons(original),b=polygons(represented),originalGeometryHash=geometryHash(original),representedGeometryHash=geometryHash(represented),ringCertificates=sourceRingCertificates.filter(c=>c.role===role&&c.featureIndex===featureIndex),correspondence=[],intervalBoundDegrees=Math.SQRT2*1e-12+1e-15;
 const reject=(reason,detail={})=>{throw Object.assign(Error('Common source constraint has no independent original boundary certificate'),{evidence:{identity,originalGeometryHash,representedGeometryHash,reason,...detail,correspondence}});};
 if(!a.length||a.length!==b.length)reject('component-count-mismatch',{originalComponents:a.length,representedComponents:b.length});
 if(ringCertificates.length!==a.reduce((n,p)=>n+p.length,0))reject('source-ring-lineage-count-mismatch');
 const savedByRing=new Map();
 for(const c of ringCertificates){
  if(!Number.isInteger(c.componentIndex)||!Number.isInteger(c.ringIndex)||!a[c.componentIndex]?.[c.ringIndex])reject('invalid-source-ring-lineage',{record:c});
  const key=`${c.componentIndex}:${c.ringIndex}`;if(savedByRing.has(key))reject('ambiguous-source-ring-lineage',{key});
  const ring=a[c.componentIndex][c.ringIndex],hash=digest(jsonBytes(ring));
  if(c.pass!==true||c.distanceBoundDegrees!==1e-12||c.intervalBoundDegrees!==undefined&&c.intervalBoundDegrees!==intervalBoundDegrees||c.exactMonotoneProjection!==true||c.allOriginalVerticesInOrder!==true||c.sourceIntervalGaps!==0||!Number.isFinite(c.maximumDistance)||c.maximumDistance<0||c.maximumDistance>1e-12||c.originalSegments!==ring.length-1)reject('invalid-ordered-source-ring-certificate',{key,record:c});
  if(c.originalRingHash!==undefined&&c.originalRingHash!==hash||c.originalGeometryHash!==undefined&&c.originalGeometryHash!==originalGeometryHash)reject('source-ring-hash-mismatch',{key});
  savedByRing.set(key,c);
 }
 // Stored lineage identifies ORIGINAL rings, before canonical component/hole
 // sorting. Match each shell and its own holes separately and recompute the
 // ordered segment certificate on the actual represented ring. A set of all
 // geometry vertices or equal aggregate counts cannot establish this mapping.
 const prepared=b.map(p=>p.map(r=>({ring:r,vertices:new Set(r.slice(0,-1).map(pointKey))})));
 const matchRing=(source,target,saved)=>{
  if(source.length<4||target.ring.length<4||!same(source[0],source.at(-1))||!same(target.ring[0],target.ring.at(-1))||!source.every(p=>target.vertices.has(pointKey(p))))return null;
  const open=target.ring.slice(0,-1),starts=open.flatMap((p,i)=>same(p,source[0])?[i]:[]);if(starts.length!==1)return null;
  const start=starts[0],aligned=[...open.slice(start),...open.slice(0,start),open[start]];
  if(!exactRingSign(source)||exactRingSign(source)!==exactRingSign(aligned))return null;
  const boundary=orderedSourceRingCertificate(source,aligned),representedRingHash=digest(jsonBytes(aligned));
  if(!boundary.pass||saved.representedSegments!==aligned.length-1||saved.maximumDistance!==boundary.maximumDistance||saved.representedRingHash!==undefined&&saved.representedRingHash!==representedRingHash)return null;
  return {originalRingHash:digest(jsonBytes(source)),representedRingHash,boundary,intervalBoundDegrees};
 };
 const usedComponents=new Set();
 for(const [originalComponentIndex,component] of a.entries()){
  const candidates=[];
  for(const [representedComponentIndex,target] of prepared.entries()){
   if(component.length!==target.length)continue;
   const shell=matchRing(component[0],target[0],savedByRing.get(`${originalComponentIndex}:0`));if(!shell)continue;
   const rings=[{originalRingIndex:0,representedRingIndex:0,role:'shell',...shell}],usedHoles=new Set();let complete=true;
   for(let originalRingIndex=1;originalRingIndex<component.length;originalRingIndex++){
    const matches=[];for(let representedRingIndex=1;representedRingIndex<target.length;representedRingIndex++){const match=matchRing(component[originalRingIndex],target[representedRingIndex],savedByRing.get(`${originalComponentIndex}:${originalRingIndex}`));if(match)matches.push({originalRingIndex,representedRingIndex,role:'hole',...match});}
    if(matches.length>1)reject('ambiguous-hole-ring-correspondence',{originalComponentIndex,representedComponentIndex,originalRingIndex,candidateRepresentedRingIndices:matches.map(m=>m.representedRingIndex)});
    if(matches.length===1&&usedHoles.has(matches[0].representedRingIndex))reject('represented-hole-ring-reused',{originalComponentIndex,representedComponentIndex,originalRingIndex});
    if(!matches.length){complete=false;break;}usedHoles.add(matches[0].representedRingIndex);rings.push(matches[0]);
   }
   if(complete&&usedHoles.size===target.length-1)candidates.push({originalComponentIndex,representedComponentIndex,originalComponentHash:geometryHash({type:'Polygon',coordinates:component}),representedComponentHash:geometryHash({type:'Polygon',coordinates:b[representedComponentIndex]}),originalHoleCount:component.length-1,representedHoleCount:target.length-1,rings});
  }
  if(candidates.length!==1)reject(candidates.length?'ambiguous-component-ring-correspondence':'missing-component-ring-correspondence',{originalComponentIndex,candidateRepresentedIndices:candidates.map(c=>c.representedComponentIndex)});
  const match=candidates[0];if(usedComponents.has(match.representedComponentIndex))reject('represented-component-reused',{originalComponentIndex,representedComponentIndex:match.representedComponentIndex});usedComponents.add(match.representedComponentIndex);correspondence.push(match);
 }
 if(usedComponents.size!==b.length)reject('unmatched-represented-component');
 if(!new IsValidOp(reader.read(original)).isValid()||!new IsValidOp(reader.read(represented)).isValid())reject('invalid-original-or-represented-geometry');
 return {identity,originalGeometryHash,representedGeometryHash,sameComponentAndHoleCounts:true,allOriginalVertices:true,ringCertificates,correspondence,distanceBoundDegrees:1e-12,intervalBoundDegrees,matching:'Unique original shell and per-component hole lineage; original vertices in order and every source boundary interval recertified against the actual represented ring'};
}
export function arrangeCountrySourceFaces(p0,selected,parents,olds,idForGeometry,onProgress=()=>{},scale=null,onNoded){
 if(scale!==null)throw Error('Source-constrained arrangement requires the explicit source-double model');
 const constraints={type:'FeatureCollection',features:[]};
 for(const [parentKey,parent] of parents)for(const [componentIndex,coordinates] of polygons(parent.geometry).entries())constraints.features.push({type:'Feature',properties:{kind:'parent',parentKey,componentIndex},geometry:{type:'Polygon',coordinates}});
 for(const [oldTerritoryId,geometry] of olds)constraints.features.push({type:'Feature',properties:{kind:'old',oldTerritoryId},geometry});
 let view;
 const constrained=common=>{
  if(view)return view;
  const certificates=[],parentViews=new Map(),oldViews=new Map();
  const certify=(original,represented,identity,role,featureIndex)=>{
   certificates.push(certifySourceConstraint(original,represented,identity,role,featureIndex,common.evidence.sourceRingCertificates));
  };
  if(p0.features.length!==1)throw Error('Exactly one immutable country envelope required');
  certify(p0.features[0].geometry,common.p0.features[0].geometry,{kind:'country'},'P0',0);
  for(const [i,f] of constraints.features.entries()){
   const represented=common.sourceConstraints.features[i].geometry;certify(f.geometry,represented,f.properties,'SOURCE',i);
   if(f.properties.kind==='parent'){const list=parentViews.get(f.properties.parentKey)??[];list[f.properties.componentIndex]=represented;parentViews.set(f.properties.parentKey,list);}else oldViews.set(f.properties.oldTerritoryId,represented);
  }
  common.evidence.sourceConstraintCertificates=certificates;
  view={envelope:common.p0.features[0].geometry,parents:parentViews,olds:oldViews};certifiedContainmentViews.add(view);return view;
 };
 return arrangePreservingCellFaces(p0,selected,onProgress,scale,(g,common)=>originalGridFaceOwner(g,selected.features,parents,olds,constrained(common)),(collection,evidence,common)=>onNoded?.(collection,{...evidence,sourceConstraints:{original:constraints,noded:common.sourceConstraints},nodedCountry:common.p0}),(g,refined,common)=>certifiedSourceGapFace(g,parents,olds,p0.features[0].geometry,refined,idForGeometry,constrained(common)),constraints);
}
export function arrangePreservingCellFaces(p0,selected,onProgress,scale,resolveOwner,onNoded,createSourceGapFace,sourceConstraints){
 const common=nodePreservingCellRings(p0,selected,onProgress,scale,sourceConstraints);onNoded?.(common.selected,common.evidence,common);const reader=new GeoJSONReader(),writer=new GeoJSONWriter(),polygonizer=new Polygonizer();for(const edge of common.edges.values())polygonizer.add(reader.read({type:'LineString',coordinates:[edge.a,edge.b]}));
 const faces=[],sourceFaceProofs=[];for(const it=polygonizer.getPolygons().iterator();it.hasNext();){const geometry=normalizeGeometry(writer.write(it.next())),owners=new Set(),countrySides=new Set(),contacts=new Set();for(const p of polygons(geometry))for(const ring of p)for(let i=1;i<ring.length;i++){const a=ring[i-1],b=ring[i],direction=compare(a,b)<0?1:-1;for(const c of common.edges.get(edgeKey(a,b))?.contexts??[]){if(c.role==='P1')contacts.add(c.featureIndex);if(c.direction!==direction)continue;if(c.role==='P1')owners.add(c.featureIndex);else if(c.role==='P0')countrySides.add(c.featureIndex);}}
  if(owners.size===0){const source=resolveOwner?.(geometry,common);if(source){owners.add(source.owner);sourceFaceProofs.push(source.proof);}}
  if(owners.size===0){const source=createSourceGapFace?.(geometry,[...contacts].some(i=>common.selected.features[i].properties.refined),common);if(source){const owner=common.selected.features.length;common.selected.features.push(source.feature);owners.add(owner);sourceFaceProofs.push(source.proof);}}
  if(owners.size!==1){if(owners.size||countrySides.size)throw Object.assign(Error('Common face has no unique oriented/source-constrained owner; no distance/centroid/ID allocation'),{evidence:{geometry,owners:[...owners],countrySides:[...countrySides]}});continue;}faces.push({owner:[...owners][0],geometry});
 }
 const sideGroups=new Map();for(const face of faces)for(const p of polygons(face.geometry))for(const ring of p)for(let i=1;i<ring.length;i++){const a=ring[i-1],b=ring[i],key=edgeKey(a,b),list=sideGroups.get(key)??[];list.push({owner:face.owner,a,b});sideGroups.set(key,list);}
 const byOwner=new Map();for(const sides of sideGroups.values()){if(sides.length>2)throw Error('More than two common face sides');if(sides.length===2&&sides[0].owner===sides[1].owner)continue;for(const s of sides){const list=byOwner.get(s.owner)??[];list.push([s.a,s.b]);byOwner.set(s.owner,list);}}
 common.selected={type:'FeatureCollection',features:common.selected.features.map((f,i)=>{if(!byOwner.has(i))throw Error(`Lost positive cell source ${f.properties.sourceFeatureId}`);return {...f,geometry:geometryFromSides(byOwner.get(i))};})};common.evidence.faceCount=faces.length;common.evidence.sourceFaceProofs=sourceFaceProofs;common.evidence.faceAssignments=faces.map(f=>({geometryHash:geometryHash(f.geometry),sourceFeatureId:common.selected.features[f.owner].properties.sourceFeatureId,owner:f.owner}));common.evidence.ownership='Unique oriented cell boundary or whole-face containment in independently bounded source constraints';return common;
}
export function cellPreservationGate(parents,features,oldTerritories,{checkBoundaries=true}={}){
 const expected=new Map(parents.map(f=>[`${f.properties.countryId}:${f.properties.sourceFeatureId}`,f])),errors=[],groups=new Map();
 for(const f of features){const p=f.properties,parent=expected.get(p.parentKey),components=parent?polygons(parent.geometry):[],coordinates=components[p.componentIndex],component=coordinates?{type:'Polygon',coordinates}:null;
  if(!parent||p.parentHash!==geometryHash(parent.geometry)||!component||p.sourceComponentHash!==geometryHash(component)||!positiveIntersectionSupport(f.geometry,component))errors.push({kind:'invalid-component-lineage',sourceFeatureId:p.sourceFeatureId,parentKey:p.parentKey,componentIndex:p.componentIndex});
  if(oldTerritories){const old=oldTerritories.get(p.oldTerritoryId);if(!old||!positiveIntersectionSupport(f.geometry,old))errors.push({kind:'invalid-protected-owner',sourceFeatureId:p.sourceFeatureId,oldTerritoryId:p.oldTerritoryId});}
  const list=groups.get(p.parentKey)??[];list.push(f);groups.set(p.parentKey,list);
 }
 const coverage=[],correspondence=[];
 for(const [key,parent] of expected){const cells=groups.get(key)??[],result=partitionCoverage(parent.geometry,cells.map(f=>f.geometry));coverage.push({parentKey:key,...result});if(!result.pass)errors.push({kind:'actual-parent-preservation',parentKey:key,checks:result.checks});
  for(const [index,coordinates] of polygons(parent.geometry).entries()){const source={type:'Polygon',coordinates},hash=geometryHash(source),support=cells.filter(c=>c.properties.componentIndex===index&&c.properties.sourceComponentHash===hash&&positiveIntersectionSupport(c.geometry,source)),componentCoverage=partitionCoverage(source,support.map(c=>c.geometry)),boundaryCertificate=checkBoundaries?componentBoundaryCorrespondence(source,support):null;correspondence.push({parentKey:key,componentIndex:index,geometryHash:hash,exactPositive:exactRingSign(coordinates[0])!==0,sourceFeatureIds:support.map(c=>c.properties.sourceFeatureId),coverage:componentCoverage,boundaryCertificate});if(!support.length)errors.push({kind:'unsupported-positive-component',parentKey:key,componentIndex:index,geometryHash:hash});if(!componentCoverage.pass)errors.push({kind:'individual-source-component-conservation',parentKey:key,componentIndex:index,checks:componentCoverage.checks});if(boundaryCertificate&&!boundaryCertificate.pass)errors.push({kind:'original-source-boundary-correspondence',parentKey:key,componentIndex:index,boundaryCertificate});}
 }
 return {pass:errors.length===0,coverage,correspondence,errors,geometryRoot:digest(jsonBytes(features.map(f=>({properties:f.properties,geometry:f.geometry}))))};
}
