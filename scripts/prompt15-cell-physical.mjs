import {polygons} from './prompt14-catalog-core.mjs';
import {CELL_EXPERIMENT_POLICY as POLICY} from './prompt15-cell-policy.mjs';
const rad=Math.PI/180,R=POLICY.earthRadiusKm;
// Moved without arithmetic changes from the preservation audit. Shared by
// sliver measurement and the audit; no source/cell geometry is modified.
export function physicalMetrics(geometry){
 let areaKm2=0,vertices=0,w=Infinity,s=Infinity,e=-Infinity,n=-Infinity;
 for(const polygon of polygons(geometry))for(const [i,ring] of polygon.entries()){
  let a=0,winding=0;for(let j=0;j<ring.length;j++){const [x,y]=ring[j];w=Math.min(w,x);e=Math.max(e,x);s=Math.min(s,y);n=Math.max(n,y);vertices++;if(!j)continue;let d=(x-ring[j-1][0])*rad;if(d>Math.PI)d-=2*Math.PI;if(d< -Math.PI)d+=2*Math.PI;winding+=d;a+=d*(Math.sin(y*rad)+Math.sin(ring[j-1][1]*rad));}
  if(Math.abs(winding)>Math.PI)a+=2*winding;let area=Math.abs(a*R*R/2);if(area>2*Math.PI*R*R)area=4*Math.PI*R*R-area;areaKm2+=(i===0?1:-1)*area;
 }
 const minAbs=s<=0&&n>=0?0:Math.min(Math.abs(s),Math.abs(n)),width=(e-w)*rad*R*Math.cos(minAbs*rad),height=(n-s)*rad*R;
 return {areaKm2:Math.max(0,areaKm2),diameterKm:Math.hypot(width,height),aspectRatio:Math.max(width,height)/Math.max(1e-12,Math.min(width,height)),vertices};
}
