import fs from "node:fs";
import path from "node:path";
import polygonClipping from "polygon-clipping";
import GeoJSONReader from "jsts/org/locationtech/jts/io/GeoJSONReader.js";
import OverlayOp from "jsts/org/locationtech/jts/operation/overlay/OverlayOp.js";
import DistanceOp from "jsts/org/locationtech/jts/operation/distance/DistanceOp.js";
import GeoJSONWriter from "jsts/org/locationtech/jts/io/GeoJSONWriter.js";
import Polygonizer from "jsts/org/locationtech/jts/operation/polygonize/Polygonizer.js";
import UnaryUnionOp from "jsts/org/locationtech/jts/operation/union/UnaryUnionOp.js";
import LineMerger from "jsts/org/locationtech/jts/operation/linemerge/LineMerger.js";
import {normalizeCollection} from "./prompt14-repair.mjs";
import {CANONICAL_P0_VALIDATOR_POLICY,validatePolygonFeatureCollection,validatePartitionCoverage,sha256} from "./prompt14-source-gate.mjs";

export const GAME_SELECTION_POLICY = Object.freeze({
  version:"prompt14-game-p0-p1-alignment-v2",
  p0:"Bounded derived P0 from pinned unsimplified Admin0 shared boundaries; original seed bytes preserved. Derived P0 is the new catalog authority.",
  p1CoordinatePrecision:"preserve source doubles; no independent rounding or simplification",
  maximumRoundingDisplacementDegrees:0,
  operations:["intersect each P1 with shared-source derived P0", "split multi-adjacent residual by bounded continuation of actual shared P1 terminal boundary segments, polygonize and require unique boundary contact for every face", "attach an actual P0 residual polygon only to its unique positive-length adjacent P1"],
  residualExtensionPolicy:"Actual shared P1 boundary terminal direction only; movement bounded by the existing seed's .0015 degree thinning plus 5-place rounding radius. This preserves the prior .00151 degree ceiling, not a widened coverage tolerance. No centroid, nearest territory, ID order, filler or inferred ownership. Unattached faces and ambiguous contacts remain blocked.",
  maximumAlignmentAreaFraction:0.001,
  maximumResidualBoundaryDistanceDegrees:0.0015+Math.SQRT2*0.000005,
  residualBoundaryVerification:"Adaptive continuous segment certificate against the actual source P1 boundary; vertex-only checks cannot pass a long bridge. Spatial indexing changes lookup cost only; JSTS distances remain for rejected/borderline cases.",
  numericalBoundaryContactToleranceDegrees:1e-12,
  sourceCoordinateCoincidenceRadiusDegrees:Math.SQRT2*0.000001,
  boundaryContactPolicy:"Exact positive-length contact, or positive projected segment overlap with both endpoints inside the two 6-place source coordinate rounding radii; excludes mere point proximity. This establishes source boundary correspondence, never nearest-territory assignment. Final partition equality tolerance remains unchanged.",
  coverageAbsoluteToleranceDegreesSquared:1e-9,
  coverageRelativeTolerance:1e-9,
  fallback:"Any invalid P1, empty clipped feature, excessive adjustment, ambiguous/unattached residual, failed overlay, invalid result or failed equality replaces the entire country's P1 selection with its unchanged P0 as ONE territory. Record every excluded source identity. Never delete an error within a selected partition.",
  fallbackLimitation:"Country remains selectable with the same owner and outline, but occupation is whole-country only; no partial occupation inside that country.",
  locks:"P0 is fixed before alignment. Final P1 boundaries are locked only after successful alignment and verification. No later merges/cap avoidance across either lock.",
  noFiller:"Residuals are exact P0-minus-P1 geometry, not invented polygons. Ambiguous coastal fragments must not become filler territories. Only the separately defined exact disconnected SOURCE component policy may preserve an existing island as a territory; otherwise unresolved alignment remains a whole-country fallback candidate and cannot bypass readiness gates.",
  disconnectedSourceComponentPolicy:"An exact ENTIRE disconnected derived P0 component with zero P1 intersection may remain a source-backed P0 component territory. Require pinned Admin0 feature IDs, full component equality and no positive boundary contact; never turn a coastal residual/sliver into a territory. Keep all valid P1 identities. Component ID is country plus SHA-256 of the actual source component geometry. No guessed administrative assignment; partial occupation within that island component is unavailable.",
});
const reader = new GeoJSONReader();
const mp=g=>g.type==="Polygon"?[g.coordinates]:g.coordinates;
const geometry=coordinates=>({type:"MultiPolygon",coordinates});
const featureId=(f,i)=>String(f.properties.ne_id??f.properties.NE_ID??f.properties.countryId??i);
const gc=features=>({type:"FeatureCollection",features});
const area=g=>reader.read(g).getArea();
const writer=new GeoJSONWriter();
const segmentCache=new WeakMap();
const sharedLineCache=new WeakMap();
const boundaryIndexCell=.02,boundaryGeometryCache=new WeakMap();
function indexedBoundary(g){const cell=boundaryIndexCell;if(segmentCache.has(g))return segmentCache.get(g);const out=[],buckets=new Map();for(const p of mp(g))for(const r of p)for(let i=1;i<r.length;i++){const a=r[i-1],b=r[i],index=out.length;out.push([a,b]);for(let x=Math.floor(Math.min(a[0],b[0])/cell);x<=Math.floor(Math.max(a[0],b[0])/cell);x++)for(let y=Math.floor(Math.min(a[1],b[1])/cell);y<=Math.floor(Math.max(a[1],b[1])/cell);y++){const key=x+','+y,values=buckets.get(key)??[];values.push(index);buckets.set(key,values);}}const result={out,buckets};segmentCache.set(g,result);return result;}
function nearestIndexedBoundary(p,candidate){
  const index=indexedBoundary(candidate),x=Math.floor(p[0]/boundaryIndexCell),y=Math.floor(p[1]/boundaryIndexCell),indices=new Set();let distance=Infinity,segment=null;
  for(let dx=-1;dx<=1;dx++)for(let dy=-1;dy<=1;dy++)for(const i of index.buckets.get((x+dx)+','+(y+dy))??[])indices.add(i);
  for(const i of indices){const candidateSegment=index.out[i],value=distanceToSegment(p,candidateSegment);if(value<distance){distance=value;segment=candidateSegment;}}
  return {distance,segment};
}
function distanceToSegment(p,[a,b]){const vx=b[0]-a[0],vy=b[1]-a[1],t=Math.max(0,Math.min(1,((p[0]-a[0])*vx+(p[1]-a[1])*vy)/(vx*vx+vy*vy||1)));return Math.hypot(p[0]-a[0]-t*vx,p[1]-a[1]-t*vy);}
export function sourceBoundaryDistance(p,candidate){
  const {distance}=nearestIndexedBoundary(p,candidate);
  // Every segment within the fixed movement ceiling is present in this neighborhood.
  // Keep independent JSTS distance for rejected or numerically borderline cases.
  if(distance<GAME_SELECTION_POLICY.maximumResidualBoundaryDistanceDegrees*(1-1e-9))return distance;
  if(!boundaryGeometryCache.has(candidate))boundaryGeometryCache.set(candidate,reader.read(candidate).getBoundary());
  return DistanceOp.distance(reader.read({type:"Point",coordinates:p}),boundaryGeometryCache.get(candidate));
}
export function certifyResidualBoundary(fragment,candidate){
  const limit=GAME_SELECTION_POLICY.maximumResidualBoundaryDistanceDegrees;let pass=true,maximumUpperBound=0;
  const certify=(p,q,depth=0)=>{const middle=[(p[0]+q[0])/2,(p[1]+q[1])/2],n=nearestIndexedBoundary(middle,candidate);if(!n.segment||n.distance>limit){pass=false;return;}const bound=Math.max(distanceToSegment(p,n.segment),distanceToSegment(q,n.segment),n.distance);if(bound<=limit){maximumUpperBound=Math.max(maximumUpperBound,bound);return;}if(depth>=24){pass=false;return;}certify(p,middle,depth+1);certify(middle,q,depth+1);};
  for(const p of mp(fragment))for(const r of p)for(let i=1;i<r.length;i++)certify(r[i-1],r[i]);
  return {pass,continuousBoundaryCertified:pass,maximumBoundaryDisplacementUpperBoundDegrees:pass?maximumUpperBound:null};
}
export function hasSourceBoundaryContact(fragment,candidate){
  const cell=boundaryIndexCell;
  const epsilon=GAME_SELECTION_POLICY.sourceCoordinateCoincidenceRadiusDegrees;
  const indexed=indexedBoundary(candidate);
  for(const polygon of mp(fragment))for(const ring of polygon)for(let ri=1;ri<ring.length;ri++){const a=ring[ri-1],b=ring[ri];
    const possible=new Set();
    for(let x=Math.floor((Math.min(a[0],b[0])-epsilon)/cell);x<=Math.floor((Math.max(a[0],b[0])+epsilon)/cell);x++)for(let y=Math.floor((Math.min(a[1],b[1])-epsilon)/cell);y<=Math.floor((Math.max(a[1],b[1])+epsilon)/cell);y++)for(const i of indexed.buckets.get(x+','+y)??[])possible.add(i);
    for(const i of possible){const [c,d]=indexed.out[i];
    if(Math.max(a[0],b[0])+epsilon<Math.min(c[0],d[0])||Math.max(c[0],d[0])+epsilon<Math.min(a[0],b[0])||Math.max(a[1],b[1])+epsilon<Math.min(c[1],d[1])||Math.max(c[1],d[1])+epsilon<Math.min(a[1],b[1]))continue;
    const vx=b[0]-a[0],vy=b[1]-a[1],length=Math.hypot(vx,vy);if(!length)continue;
    const distance=p=>Math.abs((p[0]-a[0])*vy-(p[1]-a[1])*vx)/length;
    const dc=distance(c),dd=distance(d);if(dc>epsilon||dd>epsilon)continue;
    const project=p=>((p[0]-a[0])*vx+(p[1]-a[1])*vy)/length,t0=project(c),t1=project(d);
    const minimumContact=dc<=1e-12&&dd<=1e-12?GAME_SELECTION_POLICY.numericalBoundaryContactToleranceDegrees:2*epsilon;
    if(Math.min(length,Math.max(t0,t1))-Math.max(0,Math.min(t0,t1))>minimumContact)return true;
    }
  }
  return false;
}

export function splitResidualBySharedBoundaries(fragment,selected,adjacent){
  const lines=[fragment];let sharedBoundaryCount=0;
  const positions=mp(fragment).flat(2),box=[Infinity,Infinity,-Infinity,-Infinity];for(const [x,y]of positions){box[0]=Math.min(box[0],x);box[1]=Math.min(box[1],y);box[2]=Math.max(box[2],x);box[3]=Math.max(box[3],y);}
  const envelope=GAME_SELECTION_POLICY.maximumResidualBoundaryDistanceDegrees;
  const local=(a,b)=>Math.max(a[0],b[0])+envelope>=box[0]&&Math.min(a[0],b[0])-envelope<=box[2]&&Math.max(a[1],b[1])+envelope>=box[1]&&Math.min(a[1],b[1])-envelope<=box[3];
  for(let a=0;a<adjacent.length;a++)for(let b=a+1;b<adjacent.length;b++){
    const left=selected[adjacent[a]].geometry,right=selected[adjacent[b]].geometry,pairs=sharedLineCache.get(left)??new WeakMap();sharedLineCache.set(left,pairs);
    let chains=pairs.get(right);
    if(!chains){const common=OverlayOp.intersection(reader.read(left).getBoundary(),reader.read(right).getBoundary()),merger=new LineMerger();merger.add(common);chains=[];for(const iterator=merger.getMergedLineStrings().iterator();iterator.hasNext();)chains.push(writer.write(iterator.next()).coordinates);pairs.set(right,chains);}
    const extend=(p,q)=>{const d=Math.hypot(p[0]-q[0],p[1]-q[1]);return d?[p[0]+(p[0]-q[0])/d*envelope,p[1]+(p[1]-q[1])/d*envelope]:p;};
    for(const c of chains){const closed=JSON.stringify(c[0])===JSON.stringify(c.at(-1)),extended=closed?c:[extend(c[0],c[1]),...c,extend(c.at(-1),c.at(-2))];for(let i=1;i<extended.length;i++)if(local(extended[i-1],extended[i])){lines.push({type:"LineString",coordinates:[extended[i-1],extended[i]]});sharedBoundaryCount++;}}
  }
  if(!sharedBoundaryCount)throw new Error("ambiguous residual has no actual shared administrative boundary to continue");
  const linework=reader.read({type:"GeometryCollection",geometries:[writer.write(reader.read(fragment).getBoundary()),...lines.slice(1)]});
  const polygonizer=new Polygonizer();polygonizer.add(UnaryUnionOp.union(linework));
  const fragments=[];
  for(const iterator=polygonizer.getPolygons().iterator();iterator.hasNext();){const face=writer.write(iterator.next()),inside=polygonClipping.intersection(mp(fragment),mp(face));if(inside.length&&area(geometry(inside))>1e-15)fragments.push(geometry(inside));}
  if(!fragments.length)throw new Error("shared-boundary residual polygonization yielded no faces");
  const equality=validatePartitionCoverage(fragment,fragments);if(!equality.pass)throw new Error("shared-boundary residual split changed coverage");
  return {fragments,sharedBoundaryCount};
}

export function selectGameInputs(p0,p1,parents,metadata,sourceFeatureIds={},onCountry=null) {
  const features=[],countries=[],fallbackCountries=[];
  const ids=metadata.map(c=>c.id).sort();
  if(new Set(ids).size!==ids.length) throw new Error("duplicate metadata ID");
  if(JSON.stringify(p0.features.map(f=>f.properties.countryId).sort())!==JSON.stringify(ids))throw new Error("P0 and metadata country sets differ");
  for(const countryId of ids) {
    onCountry?.({phase:"start",countryId,processed:countries.length});
    const base=p0.features.find(f=>f.properties.countryId===countryId);
    const sources=p1.features.flatMap((f,i)=>parents.entries[i]?.normalizedParentCountryId===countryId&&!parents.entries[i]?.excluded?[{f,index:i,sourceFeatureId:featureId(f,i)}]:[]).sort((a,b)=>a.sourceFeatureId<b.sourceFeatureId?-1:a.sourceFeatureId>b.sourceFeatureId?1:0);
    if(new Set(sources.map(s=>s.sourceFeatureId)).size!==sources.length)throw new Error(`duplicate P1 identity ${countryId}`);
    const p0Validity=validatePolygonFeatureCollection(gc([base]),"P0",CANONICAL_P0_VALIDATOR_POLICY);
    if(!p0Validity.pass)throw new Error(`invalid production P0 ${countryId}: ${p0Validity.errors.join("; ")}`);
    const before=validatePartitionCoverage(base.geometry,sources.map(s=>s.f.geometry));
    let reason=null,selected=[],alignedResiduals=[],alignmentArea=0,residualDiagnostics=[],sourceComponentFallbacks=[];
    const p0Area=area(base.geometry);
    try {
      if(!sources.length)throw new Error("no selected P1 source");
      const originalValid=validatePolygonFeatureCollection(normalizeCollection(gc(sources.map(s=>s.f)),CANONICAL_P0_VALIDATOR_POLICY),"P1",CANONICAL_P0_VALIDATOR_POLICY);
      if(!originalValid.pass)throw new Error(`invalid original P1: ${originalValid.errors.join("; ")}`);
      selected=sources.map(s=>{
        const coords=polygonClipping.intersection(mp(s.f.geometry),mp(base.geometry));
        if(!coords.length)throw new Error(`empty clipped P1 ${s.sourceFeatureId}`);
        return {type:"Feature",properties:{countryId,sourceCountryId:countryId,sourceFeatureId:s.sourceFeatureId,inputRole:"P1"},geometry:geometry(coords)};
      });
      const union=polygonClipping.union(...selected.map(f=>mp(f.geometry)));
      const residual=polygonClipping.difference(mp(base.geometry),union);
      const tolerance=Math.max(1e-9,p0Area*1e-9);
      const residualArea=residual.length?area(geometry(residual)):0;
      const removedArea=sources.reduce((s,source,i)=>s+Math.max(0,area(source.f.geometry)-area(selected[i].geometry)),0);
      const uncoveredSourceComponents=sourceFeatureIds[countryId]?.length?mp(base.geometry).filter(p=>!polygonClipping.intersection([p],union).length):[];
      const unchangedComponentArea=uncoveredSourceComponents.reduce((sum,p)=>sum+area(geometry([p])),0);
      if((Math.max(0,residualArea-unchangedComponentArea)+removedArea)/p0Area>GAME_SELECTION_POLICY.maximumAlignmentAreaFraction)throw new Error("P0/P1 adjustment exceeds 0.1% country area policy (unchanged complete source components are not alignment changes)");
      const alignmentReferences=structuredClone(selected);
      const queue=residual.map((polygon,index)=>({polygon,index,split:false}));
      for(let qi=0;qi<queue.length;qi++) {const {polygon,index,split}=queue[qi];
        const fragment=geometry([polygon]),fragmentArea=area(fragment);
        // Tiny numerical debris may remain within the explicitly reported equality tolerance.
        if(fragmentArea<=tolerance/Math.max(1,residual.length))continue;
        const adjacent=alignmentReferences.flatMap((f,i)=>{
          return hasSourceBoundaryContact(fragment,f.geometry)?[i]:[];
        });
        residualDiagnostics.push({index,split,areaDegreesSquared:fragmentArea,geometry:fragment,adjacentSourceFeatureIds:adjacent.map(i=>alignmentReferences[i].properties.sourceFeatureId)});
        if(adjacent.length===0&&sourceFeatureIds[countryId]?.length){
          const component=uncoveredSourceComponents.find(p=>{
            const componentGeometry=geometry([p]);if(Math.abs(area(componentGeometry)-fragmentArea)>1e-12)return false;
            const missing=polygonClipping.difference([p],mp(fragment)),extra=polygonClipping.difference(mp(fragment),[p]);
            if((missing.length?area(geometry(missing)):0)+(extra.length?area(geometry(extra)):0)>1e-12)return false;
            return alignmentReferences.every(f=>{const intersection=polygonClipping.intersection([p],mp(f.geometry));return !intersection.length||area(geometry(intersection))===0;});
          });
          if(component){const componentGeometry=geometry([component]),sourceFeatureId=`P0-component:${countryId}:${sha256(Buffer.from(JSON.stringify(component)))}`;
            selected.push({type:"Feature",properties:{countryId,sourceCountryId:countryId,sourceFeatureId,inputRole:"P0-source-component",rawSourceFeatureIds:sourceFeatureIds[countryId]},geometry:componentGeometry});
            sourceComponentFallbacks.push({sourceFeatureId,rawSourceFeatureIds:sourceFeatureIds[countryId],areaDegreesSquared:area(componentGeometry),geometry:componentGeometry,reason:"complete disconnected Admin0 source component absent from P1; no administrative assignment guessed",limitation:"No partial occupation inside this source component; country retains its actual administrative P1 territories."});continue;
          }
        }
        if(adjacent.length>1&&!split){const partition=splitResidualBySharedBoundaries(fragment,alignmentReferences,adjacent);queue.push(...partition.fragments.flatMap(g=>mp(g).map(p=>({polygon:p,index,split:true}))));continue;}
        if(adjacent.length!==1)throw new Error(`residual ${index} has ${adjacent.length} adjacent P1 candidates${split?" after actual shared-boundary continuation":""}`);
        const target=adjacent[0],targetReference=alignmentReferences[target].geometry;
        let maximumDistance=0;
        for(const r of polygon)for(const coordinate of r) {
          const distance=sourceBoundaryDistance(coordinate,targetReference);
          maximumDistance=Math.max(maximumDistance,distance);
        }
        residualDiagnostics.at(-1).maximumBoundaryDistanceDegrees=maximumDistance;
        if(maximumDistance>GAME_SELECTION_POLICY.maximumResidualBoundaryDistanceDegrees)throw new Error(`residual boundary distance ${maximumDistance} exceeds fixed seed displacement envelope ${GAME_SELECTION_POLICY.maximumResidualBoundaryDistanceDegrees}`);
        const continuous=certifyResidualBoundary(fragment,targetReference);residualDiagnostics.at(-1).continuousBoundary=continuous;
        if(!continuous.pass)throw new Error("residual continuous boundary cannot be certified within the fixed seed displacement envelope");
        selected[target].geometry=geometry(polygonClipping.union(mp(selected[target].geometry),[polygon]));
        alignmentArea+=fragmentArea;
        alignedResiduals.push({index,sourceFeatureId:selected[target].properties.sourceFeatureId,areaDegreesSquared:fragmentArea,maximumBoundaryDistanceDegrees:maximumDistance,...continuous});
      }
      selected=normalizeCollection(gc(selected),CANONICAL_P0_VALIDATOR_POLICY).features;
      const validity=validatePolygonFeatureCollection(gc(selected),"selected",CANONICAL_P0_VALIDATOR_POLICY);
      if(!validity.pass)throw new Error(`aligned P1 invalid: ${validity.errors.join("; ")}`);
      const equality=validatePartitionCoverage(base.geometry,selected.map(f=>f.geometry));
      if(!equality.pass)throw new Error(`aligned coverage mismatch: ${JSON.stringify(equality)}`);
    } catch(error) {
      reason=error.message;
      selected=[{...structuredClone(base),properties:{...base.properties,sourceCountryId:countryId,sourceFeatureId:`P0:${countryId}`,inputRole:"P0-fallback"}}];
      fallbackCountries.push(countryId);
    }
    const after=validatePartitionCoverage(base.geometry,selected.map(f=>f.geometry));
    if(!after.pass)throw new Error(`fallback or selected coverage failed ${countryId}`);
    countries.push({countryId,selection:reason?"P0-fallback":"aligned-P1",reason,originalP1FeatureCount:sources.length,selectedFeatureCount:selected.length,maintainedP1SourceFeatureIds:reason?[]:sources.map(s=>s.sourceFeatureId),excludedP1SourceFeatureIds:reason?sources.map(s=>s.sourceFeatureId):[],sourceComponentFallbacks:reason?[]:sourceComponentFallbacks,residualDiagnostics,alternativesReviewed:reason?["Pinned source shared P0 instead of independent seed simplification","Exact source P1 clipping without rounding","Actual shared administrative boundary continuation with unique contact and bounded distance","Complete disconnected source-component retention with pinned Admin0 identity (never a residual filler)","No unsupported ownership assignment; country remains an unapproved fallback candidate when required gates fail"]:[],before,after,alignedResiduals:reason?[]:alignedResiduals,alignmentAreaDegreesSquared:reason?0:alignmentArea,limitation:reason?GAME_SELECTION_POLICY.fallbackLimitation:sourceComponentFallbacks.length?"Partial occupation unavailable inside retained standalone source components; administrative P1 territories remain usable.":null});
    features.push(...selected);
    onCountry?.({phase:"complete",countryId,processed:countries.length,territories:selected.length,fallback:reason});
  }
  const selected=gc(features);
  const validation=validatePolygonFeatureCollection(selected,"game-input",CANONICAL_P0_VALIDATOR_POLICY);
  return {collection:selected,policy:GAME_SELECTION_POLICY,countries,fallbackCountries,validation,pass:validation.pass&&countries.every(c=>c.after.pass)};
}

export function writeAtomicDerived(root,repositoryPath,bytes) {
  const target=path.resolve(root,repositoryPath);
  if(!target.startsWith(path.resolve(root,"data/derived/prompt14")+path.sep))throw new Error("derived target outside permitted input directory");
  fs.mkdirSync(path.dirname(target),{recursive:true});
  const temporary=`${target}.${process.pid}.tmp`;
  fs.writeFileSync(temporary,bytes);fs.renameSync(temporary,target);
  return {repositoryPath,sha256:sha256(bytes),byteLength:bytes.length};
}

export function validateP0CountryOwnership(p0) {
  const bounds=g=>{
    const result=[Infinity,Infinity,-Infinity,-Infinity];
    for(const polygon of mp(g))for(const ring of polygon)for(const [x,y] of ring){result[0]=Math.min(result[0],x);result[1]=Math.min(result[1],y);result[2]=Math.max(result[2],x);result[3]=Math.max(result[3],y);}
    return result;
  };
  const boxes=p0.features.map(f=>bounds(f.geometry)),overlaps=[],errors=[];
  for(let i=0;i<p0.features.length;i++)for(let j=i+1;j<p0.features.length;j++){
    const a=boxes[i],b=boxes[j];if(a[2]<b[0]||b[2]<a[0]||a[3]<b[1]||b[3]<a[1])continue;
    const left=p0.features[i],right=p0.features[j];
    try {
      const intersection=polygonClipping.intersection(mp(left.geometry),mp(right.geometry));
      const overlapArea=intersection.length?area(geometry(intersection)):0;
      if(overlapArea>1e-9)overlaps.push({countryIds:[left.properties.countryId,right.properties.countryId].sort(),sourceFeatureIds:[left.properties.sourceFeatureIds??left.properties.sourceFeatureId??`P0:${left.properties.countryId}`,right.properties.sourceFeatureIds??right.properties.sourceFeatureId??`P0:${right.properties.countryId}`],overlapAreaDegreesSquared:overlapArea,intersectionGeometry:geometry(intersection)});
    }catch(error){errors.push({countryIds:[left.properties.countryId,right.properties.countryId],error:error.message});}
  }
  overlaps.sort((a,b)=>a.countryIds.join("|")<b.countryIds.join("|")?-1:1);
  return {pass:!overlaps.length&&!errors.length,absoluteToleranceDegreesSquared:1e-9,overlapPairCount:overlaps.length,affectedCountryIds:[...new Set(overlaps.flatMap(e=>e.countryIds))].sort(),overlaps,errors,policy:"Finite point touching is allowed; positive intersection area above tolerance blocks unambiguous country ownership. No P0 subtraction or winner-country assignment is authorized by this validator."};
}
