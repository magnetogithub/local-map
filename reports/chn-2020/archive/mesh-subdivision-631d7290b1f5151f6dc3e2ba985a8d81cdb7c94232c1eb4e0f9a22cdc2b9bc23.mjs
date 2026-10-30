import {normalizeGeometry,polygons} from '../prompt14-catalog-core.mjs';

// Existing repository representation policy. This accepts only subdivision:
// every old vertex remains individually bounded and in cyclic order, every
// new point lies on its original finite segment within the existing bound.
// It never compares a rounded short segment's extrapolated heading.
export function certifySubdivision(before,after) {
  const original=polygons(normalizeGeometry(before)),actual=polygons(normalizeGeometry(after));
  const witnesses=[],used=new Set(),equal=(a,b)=>a[0]===b[0]&&a[1]===b[1],distance=(a,b)=>Math.hypot(a[0]-b[0],a[1]-b[1]),near=(a,b)=>distance(a,b)<=1e-12;
  if(original.length!==actual.length)throw Error('SUBDIVISION_COMPONENT_COUNT');
  function ring(oldRing,newRing){
    const old=oldRing.slice(0,-1),next=newRing.slice(0,-1),exactAnchor=next.findIndex(p=>equal(p,old[0])),anchor=exactAnchor>=0?exactAnchor:next.findIndex(p=>near(p,old[0]));
    if(anchor<0)throw Error('SUBDIVISION_OLD_VERTEX_MISSING');
    const ordered=[...next.slice(anchor),...next.slice(0,anchor),next[anchor]];
    let cursor=0;
    for(let i=0;i<old.length;i++){
      const a=old[i],b=old[(i+1)%old.length],dx=b[0]-a[0],dy=b[1]-a[1],den=dx*dx+dy*dy;
      if(!near(ordered[cursor],a)||!den)throw Error('SUBDIVISION_OLD_VERTEX_ORDER');
      if(!equal(ordered[cursor],a))witnesses.push({kind:'original-vertex-representation',originalCoordinate:a,coordinate:ordered[cursor],maximumDeviationDegrees:distance(a,ordered[cursor]),existingRepresentationPolicyDegrees:1e-12});
      if(Math.sqrt(den)<=1e-12&&near(ordered[cursor],b)){
        witnesses.push({kind:'original-microscopic-segment',originalSegment:[a,b],coordinate:ordered[cursor],maximumDeviationDegrees:Math.max(distance(a,ordered[cursor]),distance(b,ordered[cursor])),lengthDegrees:Math.sqrt(den),existingRepresentationPolicyDegrees:1e-12});continue;
      }
      let previousT=0;
      while(++cursor<ordered.length&&!near(ordered[cursor],b)){
        const p=ordered[cursor],t=((p[0]-a[0])*dx+(p[1]-a[1])*dy)/den;
        const clipped=Math.max(0,Math.min(1,t)),distance=Math.hypot(p[0]-(a[0]+clipped*dx),p[1]-(a[1]+clipped*dy));
        const reverseDistance=Math.max(0,previousT-t)*Math.sqrt(den);
        if(distance>1e-12||reverseDistance>1e-12)throw Error(`SUBDIVISION_POINT_OUTSIDE_ORIGINAL_FINITE_SEGMENT:${JSON.stringify({coordinate:p,originalSegment:[a,b],distance,t,previousT,reverseDistance})}`);
        witnesses.push({coordinate:p,originalSegment:[a,b],maximumDeviationDegrees:distance,projection:t,reverseDistanceDegrees:reverseDistance,existingRepresentationPolicyDegrees:1e-12});previousT=t;
      }
      if(cursor>=ordered.length)throw Error('SUBDIVISION_OLD_VERTEX_MISSING');
    }
    while(cursor<ordered.length-1){const p=ordered[++cursor];if(!near(p,old[0]))throw Error('SUBDIVISION_EXTRA_BOUNDARY');witnesses.push({kind:'closure-representation',coordinate:p,originalCoordinate:old[0],maximumDeviationDegrees:distance(p,old[0]),existingRepresentationPolicyDegrees:1e-12});}
  }
  for(const poly of original){
    const matches=actual.flatMap((p,index)=>!used.has(index)&&p[0].some(q=>near(q,poly[0][0]))?[index]:[]);
    if(matches.length!==1)throw Error('SUBDIVISION_COMPONENT_IDENTITY');
    const index=matches[0],candidate=actual[index];used.add(index);
    if(candidate.length!==poly.length)throw Error('SUBDIVISION_HOLE_COUNT');
    ring(poly[0],candidate[0]);const usedHoles=new Set();
    for(const hole of poly.slice(1)){
      const holes=candidate.flatMap((h,i)=>i>0&&!usedHoles.has(i)&&h.some(q=>near(q,hole[0]))?[i]:[]);
      if(holes.length!==1)throw Error('SUBDIVISION_HOLE_IDENTITY');
      usedHoles.add(holes[0]);ring(hole,candidate[holes[0]]);
    }
  }
  return {pass:true,allOriginalVerticesIndividuallyBounded:true,cyclicOrderAndFiniteSegmentCoverage:true,addedNodes:witnesses.filter(w=>!w.kind).length,representedOriginalVertices:witnesses.filter(w=>w.kind==='original-vertex-representation').length,maximumDeviationDegrees:Math.max(0,...witnesses.map(w=>w.maximumDeviationDegrees)),existingRepresentationPolicyDegrees:1e-12,witnesses};
}
