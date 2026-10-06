import Coordinate from 'jsts/org/locationtech/jts/geom/Coordinate.js';
import PrecisionModel from 'jsts/org/locationtech/jts/geom/PrecisionModel.js';
import MCIndexSnapRounder from 'jsts/org/locationtech/jts/noding/snapround/MCIndexSnapRounder.js';
import NodedSegmentString from 'jsts/org/locationtech/jts/noding/NodedSegmentString.js';
import ArrayList from 'jsts/java/util/ArrayList.js';
import GeoJSONReader from 'jsts/org/locationtech/jts/io/GeoJSONReader.js';
import GeoJSONWriter from 'jsts/org/locationtech/jts/io/GeoJSONWriter.js';
import PointLocator from 'jsts/org/locationtech/jts/algorithm/PointLocator.js';
import InteriorPointArea from 'jsts/org/locationtech/jts/algorithm/InteriorPointArea.js';
import OverlayOp from 'jsts/org/locationtech/jts/operation/overlay/OverlayOp.js';
import Polygonizer from 'jsts/org/locationtech/jts/operation/polygonize/Polygonizer.js';
import STRtree from 'jsts/org/locationtech/jts/index/strtree/STRtree.js';
import Envelope from 'jsts/org/locationtech/jts/geom/Envelope.js';
import {canonical,compareText,normalizeGeometry,polygons,signedArea,hashCanonical} from './prompt14-catalog-core.mjs';

export const ARRANGEMENT_POLICY=Object.freeze({
  version:'prompt14-source-common-arrangement-v1',stage:'14-2 derived inputs only',tools:{jsts:'2.12.1'},
  numericalModel:{scale:1e12,maximumNumericalDisplacementDegrees:1e-12,meaning:'Common hot-pixel noding within the EXISTING 1e-12 representation policy; never equate an actual wider gap with a numerical difference.'},
  priority:['original source country P0 assignment','unique selected P1 face membership','oriented pinned shared P1 chain-terminal continuation within its recorded residual face','unique pinned original P1 face membership for residual/overlap','unique positive-length selected P1 contact for an actual P0 residual'],
  geometry:'All countries and selected feature rings enter one common node/segment arrangement before final P0/P1 locks. Preserve source identities and all positive components/holes. Extract labeled face boundaries without subsequent polygon simplification/independent overlay.',
  actualResidual:'Explicit existing P0-minus-P1 face only. Record complete geometry, area and source contacts. Ambiguous contacts require a real shared P1 chain terminal, with oriented left/right source identities (pinned original preferred), continued by at most the existing bound. A terminal exactly on a residual vertex may supply its source side. Never extend internal nodes, allocate by distance/ID, or invent a filler identity. Fail competing side assignments.',
  maximumActualAlignmentDisplacementDegrees:0.0015+Math.SQRT2*0.000005,maximumActualAlignmentAreaFraction:0.001,
  originalAssets:'Raw upstream, original game seed, metadata and prior evidence byte-preserved in history.',
  fallback:'Fail ambiguous face/source loss; individually reviewed whole-country P0 only if alternatives fail. Required USA/CHN/KOR/GBR/FRA must retain administrative partitions; never world-wide fallback.',
  failureConditions:['unknown/multiple source-country face membership','ambiguous residual/overlap ownership','missing source feature/component/hole','numerical displacement above 1e-12','actual displacement/area above existing bound','invalid final geometry','unexplained boundary sides','nonidentical independent generation','cap exceeded'],
});
const reader=new GeoJSONReader(),writer=new GeoJSONWriter(),locator=new PointLocator();
const pointKey=p=>`${p[0]},${p[1]}`,cmp=(a,b)=>a[0]-b[0]||a[1]-b[1];
const edgeKey=(a,b)=>cmp(a,b)<0?`${pointKey(a)};${pointKey(b)}`:`${pointKey(b)};${pointKey(a)}`;
const inside=(point,g)=>locator.locate(point,g)!==2;
const segmentDistance=(p,a,b)=>{const dx=b[0]-a[0],dy=b[1]-a[1],den=dx*dx+dy*dy;if(!den)return Math.hypot(p[0]-a[0],p[1]-a[1]);const t=((p[0]-a[0])*dx+(p[1]-a[1])*dy)/den;if(t<=0)return Math.hypot(p[0]-a[0],p[1]-a[1]);if(t>=1)return Math.hypot(p[0]-b[0],p[1]-b[1]);return Math.abs((p[0]-a[0])*dy-(p[1]-a[1])*dx)/Math.sqrt(den);};
export function commonNodeRings(p0,selected,onProgress=()=>{},extensions=[]){
  const strings=new ArrayList(),pm=new PrecisionModel(ARRANGEMENT_POLICY.numericalModel.scale),outP0=structuredClone(p0),outSelected=structuredClone(selected);
  let maximumRoundedDisplacement=0,roundedPositions=0;const coordinateChanges=[];
  for(const [role,collection,out]of [['P0',p0,outP0],['P1',selected,outSelected]])for(const [featureIndex,f]of collection.features.entries())for(const [componentIndex,p]of polygons(f.geometry).entries())for(const [ringIndex,ring]of p.entries()){
    const coordinates=ring.map(([x,y],positionIndex)=>{const c=new Coordinate(x,y);pm.makePrecise(c);const displacement=Math.hypot(c.x-x,c.y-y);maximumRoundedDisplacement=Math.max(maximumRoundedDisplacement,displacement);if(displacement){roundedPositions++;coordinateChanges.push({role,featureIndex,componentIndex,ringIndex,positionIndex,before:[x,y],after:[c.x,c.y],displacement});}return c;});
    const target=polygons(out.features[featureIndex].geometry)[componentIndex];
    strings.add(new NodedSegmentString(coordinates,{role,featureIndex,componentIndex,ringIndex,target,sourceRing:ring,countryId:f.properties.countryId,sourceFeatureId:f.properties.sourceFeatureId??`P0:${f.properties.countryId}`}));
  }
  for(const extension of extensions)strings.add(new NodedSegmentString(extension.coordinates.map(([x,y])=>{const c=new Coordinate(x,y);pm.makePrecise(c);return c;}),{role:'P1-extension',...extension}));
  if(maximumRoundedDisplacement>1e-12)throw new Error('Numerical representation displacement exceeds existing 1e-12 policy');
  onProgress(`common noding ${strings.size()} source rings at scale 1e12`);
  const noder=new MCIndexSnapRounder(pm);noder.computeNodes(strings);
  const edges=new Map();let insertedNodes=0,traceNodeCount=0,maximumNodedSegmentDisplacement=0;const numericalTraceFailures=[],roleDisplacements={P0:0,P1:0};
  for(const it=strings.iterator();it.hasNext();){const ss=it.next(),data=ss.getData(),coords=ss.getNodeList().getSplitCoordinates().map(c=>[pm.makePrecise(c.x),pm.makePrecise(c.y)]).filter((p,i,a)=>!i||cmp(p,a[i-1])!==0);
    insertedNodes+=coords.length-ss.getCoordinates().length;if(data.target)data.target[data.ringIndex]=coords;
    if(data.sourceRing)for(const nodes=ss.getNodeList().iterator();nodes.hasNext();){const node=nodes.next(),i=Math.min(node.segmentIndex,data.sourceRing.length-2),point=[pm.makePrecise(node.coord.x),pm.makePrecise(node.coord.y)],distance=segmentDistance(point,data.sourceRing[i],data.sourceRing[i+1]);traceNodeCount++;maximumNodedSegmentDisplacement=Math.max(maximumNodedSegmentDisplacement,distance);roleDisplacements[data.role]=Math.max(roleDisplacements[data.role],distance);if(distance>1e-12)numericalTraceFailures.push({role:data.role,sourceFeatureId:data.sourceFeatureId,featureIndex:data.featureIndex,componentIndex:data.componentIndex,ringIndex:data.ringIndex,segmentIndex:i,point,originalSegment:[data.sourceRing[i],data.sourceRing[i+1]],distance});}
    for(let i=1;i<coords.length;i++){const a=coords[i-1],b=coords[i];if(cmp(a,b)===0)continue;const key=edgeKey(a,b),e=edges.get(key)??{a:cmp(a,b)<0?a:b,b:cmp(a,b)<0?b:a,contexts:[]};e.contexts.push({role:data.role,featureIndex:data.featureIndex,countryId:data.countryId,sourceFeatureId:data.sourceFeatureId,componentIndex:data.componentIndex,ringIndex:data.ringIndex,direction:cmp(a,b)<0?1:-1});edges.set(key,e);}
  }
  if(numericalTraceFailures.length){const error=new Error(`Common numerical node displacement exceeds 1e-12: ${numericalTraceFailures.length}`);error.evidence={numericalTraceFailures,maximumNodedSegmentDisplacement};throw error;}
  return {p0:outP0,selected:outSelected,edges,evidence:{maximumRoundedDisplacement,roundedPositions,coordinateChanges,insertedNodes,uniqueSegments:edges.size,
    traceNodeCount,maximumNodedSegmentDisplacement,roleDisplacements,numericalTraceFailures,continuousNumericalBoundaryCertificate:'Every inserted/rounded node is traced to its original source segment with distance <=1e-12. Source segment order/endpoints are retained; convex distance to that segment bounds every intervening subsegment. No actual wider gap is closed by this numerical equivalence.'}};
}
function ringsFromSegments(segments){
  const outgoing=new Map(),seen=new Set(),cycles=[];
  for(const [i,e]of segments.entries()){const key=pointKey(e[0]),list=outgoing.get(key)??[];list.push(i);outgoing.set(key,list);}
  const nextFor=(a,b)=>{const list=outgoing.get(pointKey(b))??[];if(!list.length)throw new Error('Open arrangement boundary');const reverse=Math.atan2(a[1]-b[1],a[0]-b[0]);return list.slice().sort((i,j)=>{const turn=k=>{const c=segments[k][1];return (reverse-Math.atan2(c[1]-b[1],c[0]-b[0])+2*Math.PI)%(2*Math.PI);};return turn(i)-turn(j)||i-j;})[0];};
  for(let start=0;start<segments.length;start++)if(!seen.has(start)){
    let index=start;const path=[];
    do{if(seen.has(index))throw new Error('Boundary joins another cycle');seen.add(index);const [a,b]=segments[index];path.push(a);index=nextFor(a,b);}while(index!==start);
    path.push(path[0]);
    // Split exact point-touch cycles, preserving every edge and source component.
    const stack=[],positions=new Map();for(const p of path){const key=pointKey(p);if(positions.has(key)){const k=positions.get(key),ring=[...stack.slice(k),p];if(ring.length>=4&&signedArea(ring)!==0)cycles.push(ring);else throw new Error('Collapsed positive source face');for(const q of stack.splice(k+1))positions.delete(pointKey(q));}else{positions.set(key,stack.length);stack.push(p);}}
  }
  const shells=cycles.filter(r=>signedArea(r)>0).map(r=>[r]),holes=cycles.filter(r=>signedArea(r)<0);
  for(const hole of holes){const pt=new Coordinate(...hole[0]),candidates=shells.filter(p=>inside(pt,reader.read({type:'Polygon',coordinates:[p[0]]})));if(candidates.length!==1)throw new Error('Ambiguous hole parent');candidates[0].push(hole);}
  if(!shells.length)throw new Error('Source identity lost all positive components');return normalizeGeometry({type:'MultiPolygon',coordinates:shells});
}
export function arrangeSourcePartitions(p0,selected,rawP1,onProgress=()=>{},extensions=[],iteration=0){
  const common=commonNodeRings(p0,selected,onProgress,extensions),countryGeometries=new Map(common.p0.features.map(f=>[f.properties.countryId,reader.read(f.geometry)]));
  const selectedGeometries=common.selected.features.map(f=>reader.read(f.geometry)),selectedIndex=new STRtree(),countryIndex=new STRtree(),rawIndex=new STRtree();
  selectedGeometries.forEach((g,i)=>selectedIndex.insert(g.getEnvelopeInternal(),i));for(const [id,g]of countryGeometries)countryIndex.insert(g.getEnvelopeInternal(),id);
  const rawMap=new Map();for(const f of rawP1.features){const id=String(f.properties.ne_id??f.properties.NE_ID??f.properties.sourceFeatureId);rawMap.set(id,f);}
  common.selected.features.forEach((f,i)=>{const raw=rawMap.get(f.properties.sourceFeatureId);if(raw){const g=reader.read(raw.geometry);rawIndex.insert(g.getEnvelopeInternal(),{index:i,geometry:g});}});
  const polygonizer=new Polygonizer();let lineCount=0;
  for(const e of common.edges.values()){polygonizer.add(reader.read({type:'LineString',coordinates:[e.a,e.b]}));lineCount++;}
  onProgress(`polygonizing complete common arrangement: ${lineCount} unique segments`);
  const faces=[],unresolved=[],changes=[];
  for(const it=polygonizer.getPolygons().iterator();it.hasNext();){const polygon=it.next(),point=InteriorPointArea.getInteriorPoint(polygon),box=new Envelope(point),countries=[];
    for(const c=countryIndex.query(box).iterator();c.hasNext();){const id=c.next();if(inside(point,countryGeometries.get(id)))countries.push(id);}
    if(!countries.length)continue;if(countries.length!==1){unresolved.push({kind:'source-country-overlap',countries,geometry:writer.write(polygon)});continue;}
    const countryId=countries[0],members=[];
    for(const c=selectedIndex.query(box).iterator();c.hasNext();){const i=c.next();if(common.selected.features[i].properties.countryId===countryId&&inside(point,selectedGeometries[i]))members.push(i);}
    let owner=members.length===1?members[0]:null,decision='unique-selected-membership';
    const geometry=normalizeGeometry(writer.write(polygon)),contacts=new Set();
    if(owner===null){
      const sourceSides=new Set();
      for(const e of extensions)if(e.countryId===countryId&&e.leftSourceFeatureId&&inside(point,reader.read(e.residualGeometry))){
        const [a,b]=e.coordinates,cross=(b[0]-a[0])*(point.y-a[1])-(b[1]-a[1])*(point.x-a[0]);
        if(cross!==0){const id=cross>0?e.leftSourceFeatureId:e.rightSourceFeatureId;const i=selected.features.findIndex(f=>f.properties.countryId===countryId&&f.properties.sourceFeatureId===id);if(i>=0)sourceSides.add(i);}
      }
      if(sourceSides.size===1){owner=[...sourceSides][0];decision='oriented-pinned-shared-P1-terminal-boundary';}
      const original=[];for(const c=rawIndex.query(box).iterator();c.hasNext();){const r=c.next();if(common.selected.features[r.index].properties.countryId===countryId&&inside(point,r.geometry))original.push(r.index);}
      if(owner===null&&original.length===1){owner=original[0];decision='unique-pinned-original-P1-membership';}
      else if(owner===null&&!members.length){for(const p of polygons(geometry))for(const ring of p)for(let i=1;i<ring.length;i++)for(const c of common.edges.get(edgeKey(ring[i-1],ring[i]))?.contexts??[])if(c.role==='P1'&&c.countryId===countryId)contacts.add(c.featureIndex);
        if(contacts.size===1){owner=[...contacts][0];decision='unique-positive-length-selected-P1-contact';}}
      if(owner===null){unresolved.push({kind:members.length?'ambiguous-overlap':'ambiguous-gap',countryId,members:members.map(i=>selected.features[i].properties.sourceFeatureId),contacts:[...contacts].map(i=>selected.features[i].properties.sourceFeatureId),original:original.map(i=>selected.features[i].properties.sourceFeatureId),sourceSides:[...sourceSides].map(i=>selected.features[i].properties.sourceFeatureId),geometry,area:polygon.getArea()});continue;}
      changes.push({countryId,sourceFeatureId:selected.features[owner].properties.sourceFeatureId,kind:members.length?'overlap-correction':'actual-gap-fill-by-source-face',decision,area:polygon.getArea(),geometry,contacts:[...contacts].map(i=>selected.features[i].properties.sourceFeatureId)});
    }
    faces.push({owner,countryId,geometry});
  }
  const failures={dangles:polygonizer.getDangles().size(),cutEdges:polygonizer.getCutEdges().size(),invalidRingLines:polygonizer.getInvalidRingLines().size()};
  onProgress(`faces ${faces.length}; unresolved ${unresolved.length}; ${JSON.stringify(failures)}`);
  if(unresolved.length&&iteration<3){
    const additions=[],pairCache=new Map(),commonPairs=new Map();
    for(const e of common.edges.values()){
      const owners=[...new Set(e.contexts.filter(c=>c.role==='P1').map(c=>c.featureIndex))];if(owners.length!==2)continue;
      const key=owners.map(i=>selected.features[i].properties.sourceFeatureId).sort().join('|'),list=commonPairs.get(key)??[];
      const left=e.contexts.find(c=>c.role==='P1'&&c.direction===1),right=e.contexts.find(c=>c.role==='P1'&&c.direction===-1);
      if(left&&right&&left.featureIndex!==right.featureIndex)list.push({a:e.a,b:e.b,leftSourceFeatureId:left.sourceFeatureId,rightSourceFeatureId:right.sourceFeatureId});commonPairs.set(key,list);
    }
    const markTerminals=list=>{const degrees=new Map();for(const {a,b}of list)for(const p of [a,b])degrees.set(pointKey(p),(degrees.get(pointKey(p))??0)+1);return list.map(e=>({...e,aTerminal:degrees.get(pointKey(e.a))===1,bTerminal:degrees.get(pointKey(e.b))===1}));};
    for(const [key,list]of commonPairs)commonPairs.set(key,markTerminals(list));
    const originalShared=(contacts)=>{
      const key=contacts.slice().sort().join('|');if(pairCache.has(key))return pairCache.get(key);
      const [left,right]=contacts.map(id=>rawMap.get(id));if(!left||!right){pairCache.set(key,[]);return [];}
      const first=new Map();for(const p of polygons(normalizeGeometry(left.geometry)))for(const r of p)for(let i=1;i<r.length;i++)first.set(edgeKey(r[i-1],r[i]),[r[i-1],r[i]]);
      const matches=[];for(const p of polygons(normalizeGeometry(right.geometry)))for(const r of p)for(let i=1;i<r.length;i++){const e=first.get(edgeKey(r[i-1],r[i]));if(e&&cmp(e[0],r[i])===0&&cmp(e[1],r[i-1])===0)matches.push({a:e[0],b:e[1],leftSourceFeatureId:contacts[0],rightSourceFeatureId:contacts[1]});}
      const result=markTerminals(matches);pairCache.set(key,result);return result;
    };
    for(const face of unresolved.filter(f=>f.kind==='ambiguous-gap')){
      const box=reader.read(face.geometry).getEnvelopeInternal(),limit=ARRANGEMENT_POLICY.maximumActualAlignmentDisplacementDegrees;
      const residualVertices=new Set(polygons(face.geometry).flat(2).map(pointKey));
      for(let i=0;i<face.contacts.length;i++)for(let j=i+1;j<face.contacts.length;j++){
        const contacts=[face.contacts[i],face.contacts[j]],pair=contacts.slice().sort().join('|');
        const rawShared=originalShared(contacts),candidates=rawShared.length?rawShared:commonPairs.get(pair)??[];
        for(const shared of candidates){const {a,b}=shared;
          const envelope=new Envelope(new Coordinate(...a),new Coordinate(...b));envelope.expandBy(limit);if(!envelope.intersects(box))continue;
          for(const [terminal,other]of [[a,b],[b,a]]){
          if(cmp(terminal,a)===0?!shared.aTerminal:!shared.bTerminal)continue;
          if(terminal[0]<box.getMinX()-limit||terminal[0]>box.getMaxX()+limit||terminal[1]<box.getMinY()-limit||terminal[1]>box.getMaxY()+limit)continue;
          const length=Math.hypot(terminal[0]-other[0],terminal[1]-other[1]);
          const end=terminal.map((v,i)=>v+(v-other[i])/length*limit),coordinates=[terminal,end];
          const intersection=OverlayOp.intersection(reader.read({type:'LineString',coordinates}),reader.read(face.geometry));
          const terminalInResidualVertices=residualVertices.has(pointKey(terminal));
          if(intersection.getLength()<=1e-12&&!terminalInResidualVertices)continue;
          const reversed=cmp(terminal,a)===0;
          const extension={coordinates,countryId:face.countryId,sourceFeatureId:pair,sourceSegment:[other,terminal],maximumExtensionDegrees:limit,
            leftSourceFeatureId:reversed?shared.rightSourceFeatureId:shared.leftSourceFeatureId,rightSourceFeatureId:reversed?shared.leftSourceFeatureId:shared.rightSourceFeatureId,
            residualGeometry:face.geometry,terminalInResidualVertices,positiveResidualIntersectionLength:intersection.getLength(),actualResidualGeometryHash:hashCanonical('source-residual.v1',face.geometry)};
          if(![...extensions,...additions].some(x=>canonical(x.coordinates)===canonical(coordinates)))additions.push(extension);
          }
        }
      }
    }
    if(additions.length){onProgress(`adding ${additions.length} actual shared P1 terminal continuations into residual faces`);return arrangeSourcePartitions(p0,selected,rawP1,onProgress,[...extensions,...additions],iteration+1);}
  }
  if(unresolved.length||failures.invalidRingLines){const error=new Error(`Unresolved source arrangement: ${unresolved.length} faces`);error.evidence={unresolved,changes,failures,common:common.evidence};throw error;}
  const boundaries=new Map();for(const face of faces)for(const p of polygons(face.geometry))for(const ring of p)for(let i=1;i<ring.length;i++){
    const a=ring[i-1],b=ring[i],key=edgeKey(a,b),sides=boundaries.get(key)??[];sides.push({owner:face.owner,a,b});boundaries.set(key,sides);
  }
  const byOwner=new Map();for(const sides of boundaries.values()){
    if(sides.length>2)throw new Error('Ambiguous arrangement face sides');if(sides.length===2&&sides[0].owner===sides[1].owner)continue;
    for(const {owner,a,b}of sides){const list=byOwner.get(owner)??[];list.push([a,b]);byOwner.set(owner,list);}
  }
  const output={type:'FeatureCollection',features:common.selected.features.map((f,i)=>{const list=byOwner.get(i);if(!list)throw new Error(`Lost source identity ${f.properties.sourceFeatureId}`);list.sort((a,b)=>compareText(canonical(a),canonical(b)));return {...f,geometry:ringsFromSegments(list)};})};
  return {p0:common.p0,selected:output,evidence:{policy:ARRANGEMENT_POLICY,common:common.evidence,faceCount:faces.length,changes,failures,unresolved,sourceIdentitiesPreserved:true,
    sharedBoundaryExtensions:extensions,segmentOwnershipRoot:hashCanonical('source-face-ownership.v1',faces.map(f=>({owner:selected.features[f.owner].properties.sourceFeatureId,countryId:f.countryId,geometry:f.geometry})))} };
}
