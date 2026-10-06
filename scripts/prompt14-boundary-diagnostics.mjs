import STRtree from 'jsts/org/locationtech/jts/index/strtree/STRtree.js';
import Envelope from 'jsts/org/locationtech/jts/geom/Envelope.js';
import {canonical,hashCanonical,compareText} from './prompt14-catalog-core.mjs';
import {nodeCatalogBoundarySegments} from './prompt14-catalog-topology.mjs';

export const NUMERICAL_CONTACT=1e-12;
export function segmentCorrespondence(a,b,c,d,tolerance=NUMERICAL_CONTACT){
  const dx=b[0]-a[0],dy=b[1]-a[1],den=dx*dx+dy*dy;if(!den)return null;
  const t=p=>((p[0]-a[0])*dx+(p[1]-a[1])*dy)/den;
  const tc=t(c),td=t(d),lo=Math.max(0,Math.min(tc,td)),hi=Math.min(1,Math.max(tc,td));if(!(hi>lo)||td===tc)return null;
  const separation=u=>{const v=(u-tc)/(td-tc);return Math.hypot(a[0]+u*dx-c[0]-v*(d[0]-c[0]),a[1]+u*dy-c[1]-v*(d[1]-c[1]));};
  const maximumDistance=Math.max(separation(lo),separation(hi));
  if(maximumDistance>tolerance)return null;
  return {interval:[lo,hi],maximumDistance,positiveLength:(hi-lo)*Math.sqrt(den)};
}
function covers(intervals,length){
  let end=0;for(const [lo,hi]of intervals.slice().sort((a,b)=>a[0]-b[0])){if((lo-end)*length>NUMERICAL_CONTACT)return false;end=Math.max(end,hi);}return (1-end)*length<=NUMERICAL_CONTACT;
}
export function diagnoseAllBoundaries(atoms,p0,onProgress=()=>{}){
  const {segments,sourceSegments,occurrences,intersector}=nodeCatalogBoundarySegments(atoms,p0,onProgress),index=new STRtree();
  for(const e of segments.values())index.insert(new Envelope(e.a[0],e.b[0],Math.min(e.a[1],e.b[1]),Math.max(e.a[1],e.b[1])),e);
  const observations=[];
  const identity=i=>({sourceCountryId:atoms[i].identity.sourceCountryId,sourceFeatureId:atoms[i].identity.sourceFeatureId,inputRole:atoms[i].identity.inputRole,originalFeatureIndex:atoms[i].members[0].featureIndex});
  for(const e of segments.values()){
    const owners=[...new Set([...e.left,...e.right])],countries=owners.map(i=>atoms[i].identity.sourceCountryId);
    const ambiguous=owners.length>2||e.left.length>1||e.right.length>1||owners.some(i=>e.left.includes(i)&&e.right.includes(i));
    const missingP0=owners.length===2&&countries[0]!==countries[1]&&!countries.every(c=>e.p0.includes(c));
    const unpaired=owners.length===1&&!e.p0.includes(countries[0]),p0Only=!owners.length;
    if(!ambiguous&&!missingP0&&!unpaired&&!p0Only)continue;
    const kind=ambiguous?'ambiguous-side':p0Only?'P0-only':missingP0?'country-boundary-mismatch':'unpaired-interior';
    const radius=0.0000014142135623730952,length=Math.hypot(e.b[0]-e.a[0],e.b[1]-e.a[1]),matches=[];
    const box=new Envelope(e.a[0]-radius,e.b[0]+radius,Math.min(e.a[1],e.b[1])-radius,Math.max(e.a[1],e.b[1])+radius);
    for(const it=index.query(box).iterator();it.hasNext();){const other=it.next();if(other===e)continue;
      const otherOwners=[...new Set([...other.left,...other.right])];
      const relevant=p0Only?otherOwners.some(i=>e.p0.includes(atoms[i].identity.sourceCountryId)):
        other.p0.some(c=>countries.includes(c))||otherOwners.some(i=>!owners.includes(i));
      if(!relevant)continue;
      const correspondence=segmentCorrespondence(e.a,e.b,other.a,other.b,radius);if(!correspondence)continue;
      matches.push({segment:[other.a,other.b],territories:otherOwners.map(identity),p0Countries:other.p0,...correspondence,
        numericalEquivalent:correspondence.maximumDistance<=NUMERICAL_CONTACT});
    }
    matches.sort((a,b)=>compareText(canonical(a.segment),canonical(b.segment)));
    const numerical=matches.filter(m=>m.numericalEquivalent);
    const numericalEquivalent=!ambiguous&&covers(numerical.map(m=>m.interval),length);
    const record={observationId:hashCanonical('boundary-observation.v1',{segment:[e.a,e.b],kind,territories:owners.map(identity),p0:e.p0}),kind,
      segment:[e.a,e.b],length,territories:owners.map(identity),p0Countries:e.p0,
      classification:ambiguous&&owners.length===1&&e.a[0]===-180&&e.b[0]===-180&&e.p0.includes(countries[0])?'paired-periodic-map-cut':ambiguous?'overlapping-or-inconsistent-sides':numericalEquivalent?'floating-point-collinearity-or-noding':matches.length?'actual-gap-overlap-or-P0-P1-mismatch':'unexplained-boundary',
      completeNumericalCorrespondence:numericalEquivalent,matches};
    observations.push(record);
  }
  observations.sort((a,b)=>compareText(a.observationId,b.observationId));
  const byCountry={},byFeature={};for(const o of observations){for(const c of new Set([...o.p0Countries,...o.territories.map(t=>t.sourceCountryId)])){const a=byCountry[c]??{observations:0,classifications:{}};a.observations++;a.classifications[o.classification]=(a.classifications[o.classification]??0)+1;byCountry[c]=a;}
    for(const t of o.territories){const key=`${t.sourceCountryId}:${t.sourceFeatureId}`,a=byFeature[key]??{observations:0,classifications:{}};a.observations++;a.classifications[o.classification]=(a.classifications[o.classification]??0)+1;byFeature[key]=a;}}
  const classifications={};for(const o of observations)classifications[o.classification]=(classifications[o.classification]??0)+1;
  return {scope:'Every noded segment from the complete 247-country locked P0/P1 input',sourceSegments,nodedOccurrences:occurrences,uniqueNodedSegments:segments.size,
    observationCount:observations.length,uniqueObservationCount:new Set(observations.map(o=>o.observationId)).size,uniqueObservedPhysicalSegments:new Set(observations.map(o=>canonical(o.segment))).size,
    duplicateObservations:observations.length-new Set(observations.map(o=>o.observationId)).size,countsAreDefectCounts:false,
    classifications,byCountry,byFeature,properIntersectionObservations:intersector.numProperIntersections,numericalContactTolerance:NUMERICAL_CONTACT,observations};
}
