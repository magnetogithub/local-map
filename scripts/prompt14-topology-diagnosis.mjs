import booleanDisjoint from "@turf/boolean-disjoint";
import booleanCrosses from "@turf/boolean-crosses";
import polygonClipping from "polygon-clipping";

const area = mp => mp.reduce((s,p)=>s+p.reduce((t,r,k)=>t+(k===0?1:-1)*Math.abs(r.slice(0,-1).reduce((v,a,i)=>v+a[0]*r[i+1][1]-r[i+1][0]*a[1],0)/2),0),0);
const segments = p => p.flatMap(r=>r.slice(1).map((b,i)=>[r[i],b]));
export function diagnoseRejectedFeature(feature) {
  const ps = feature.geometry.type === "Polygon" ? [feature.geometry.coordinates] : feature.geometry.coordinates;
  // Replicate the installed Turf spike predicate exactly, with a bounding-box prefilter.
  for (const [polygonIndex,p] of ps.entries()) for (const [ringIndex,r] of p.entries()) {
    for (let i=0;i<r.length-1;i++) for(let j=i+1;j<r.length-2;j++) {
      const pt=r[i],a=r[j],b=r[j+1];
      if (pt[0]<Math.min(a[0],b[0])||pt[0]>Math.max(a[0],b[0])||pt[1]<Math.min(a[1],b[1])||pt[1]>Math.max(a[1],b[1])) continue;
      if ((pt[0]-a[0])*(b[1]-a[1])-(pt[1]-a[1])*(b[0]-a[0]) !== 0) continue;
      return {classification:"ring-spike-or-puncture-defect",polygonIndex,ringIndex,vertexIndex:i,segmentIndices:[j,j+1],coordinate:pt,segment:[a,b],decision:"blocked: topology change requires justification"};
    }
  }
  for(let i=0;i<ps.length;i++) for(let j=i+1;j<ps.length;j++) {
    if (booleanDisjoint({type:"Polygon",coordinates:ps[i]},{type:"Polygon",coordinates:ps[j]})) continue;
    if (!booleanCrosses({type:"Polygon",coordinates:ps[i]},{type:"LineString",coordinates:ps[j][0]})) continue;
    const intersection=polygonClipping.intersection(ps[i],ps[j]);
    let boundaryContact=null;
    outer: for(const [a,b] of segments(ps[i])) for(const [c,d] of segments(ps[j])) {
      const dx=b[0]-a[0],dy=b[1]-a[1];
      if(dx===0&&dy===0)continue;
      if((c[0]-a[0])*dy-(c[1]-a[1])*dx!==0||(d[0]-a[0])*dy-(d[1]-a[1])*dx!==0)continue;
      const axis=Math.abs(dx)>=Math.abs(dy)?0:1;
      const overlap=Math.min(Math.max(a[axis],b[axis]),Math.max(c[axis],d[axis]))-Math.max(Math.min(a[axis],b[axis]),Math.min(c[axis],d[axis]));
      if(overlap>0) {boundaryContact={segments:[[a,b],[c,d]],overlap};break outer;}
    }
    const intersectionArea=area(intersection);
    return {classification: intersectionArea>0 || boundaryContact ? "component-overlap-or-shared-edge-defect" : "validator-component-crossing-rejection-not-proven-area-overlap", componentIndices:[i,j],intersectionAreaDegreesSquared:intersectionArea,sharedBoundarySegment:boundaryContact, decision:"blocked pending independent OGC topology verification; zero clipped area is not proof of complete validity", standard:"OGC allows disjoint interiors and finite point boundary contacts; Turf rejection is not alone proof of an OGC defect", standardReference:"https://locationtech.github.io/jts/javadoc/org/locationtech/jts/geom/MultiPolygon.html"};
  }
  return {classification:"unresolved-validator-rejection",decision:"blocked pending independent topology verification"};
}
