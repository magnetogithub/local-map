import {polygons, area} from './partition-prototype.mjs';

const a=6378137, e2=6.6943799901413165e-3, e=Math.sqrt(e2), rad=Math.PI/180;
const m=p=>Math.cos(p)/Math.sqrt(1-e2*Math.sin(p)**2);
const t=p=>Math.tan(Math.PI/4-p/2)/((1-e*Math.sin(p))/(1+e*Math.sin(p)))**(e/2);
export const unwrap=(x,centre)=>centre+((x-centre+540)%360)-180;
const mapGeometry=(g,fn)=>({type:g.type,coordinates:g.type==='Polygon'?g.coordinates.map(r=>r.map(fn)):g.coordinates.map(p=>p.map(r=>r.map(fn)))});

/** WGS84 tangent Lambert conformal conic (ellipsoidal Mercator at equator).
 * Conformal scale is analytic: |n*rho/(a*m(phi))|. Its only interior
 * stationary latitude is the tangent latitude. Bounds include the complete
 * inverse-image of every straight projected cell edge, not just source vertices.
 * Longitude is unwrapped around the first source vertex; dateline parts stay
 * neighbours. No polygon simplification, source repair or ownership inference.
 */
export function projectFeatures(features) {
  const points=features.flatMap(f=>polygons(f.geometry).flat(2)), centre=points[0][0];
  const xs=points.map(p=>unwrap(p[0],centre)), ys=points.map(p=>p[1]);
  const lo=Math.min(...ys)*rad, hi=Math.max(...ys)*rad;
  if(hi>=89*rad||lo<=-89*rad||Math.max(...xs)-Math.min(...xs)>25) throw new Error('CHART_DOMAIN');
  const lat0=(lo+hi)/2,lon0=(Math.min(...xs)+Math.max(...xs))/2,n=Math.sin(lat0),merc=Math.abs(n)<1e-4;
  const F=merc?0:m(lat0)/(n*t(lat0)**n),rho0=merc?0:a*F*t(lat0)**n;
  const forward=([lon,lat])=>{
    const dl=(unwrap(lon,lon0)-lon0)*rad,p=lat*rad;
    if(merc) return [a*m(lat0)*dl,-a*m(lat0)*Math.log(t(p))];
    const rho=a*F*t(p)**n; return [rho*Math.sin(n*dl),rho0-rho*Math.cos(n*dl)];
  };
  const preliminary=features.map(f=>({...structuredClone(f),geometry:mapGeometry(f.geometry,forward)}));
  const pp=preliminary.flatMap(f=>polygons(f.geometry).flat(2));
  const box=[Math.min(...pp.map(p=>p[0])),Math.min(...pp.map(p=>p[1])),Math.max(...pp.map(p=>p[0])),Math.max(...pp.map(p=>p[1]))];
  // Inverse latitude monotone in signed radius. A rectangle encloses all
  // polygon/cell interiors. Radial extrema are distance to / farthest corner
  // from the conic apex, so their inverse latitudes enclose complete geometry.
  const inverseT=q=>{let p=Math.PI/2-2*Math.atan(q);for(let i=0;i<15;i++)p=Math.PI/2-2*Math.atan(q*((1-e*Math.sin(p))/(1+e*Math.sin(p)))**(e/2));return p;};
  let bounds;
  if(merc) bounds=[inverseT(Math.exp(-box[3]/(a*m(lat0)))),inverseT(Math.exp(-box[1]/(a*m(lat0))))];
  else {
    const dx=box[0]>0?box[0]:box[2]<0?-box[2]:0,dy=box[1]>rho0?box[1]-rho0:box[3]<rho0?rho0-box[3]:0;
    const rmin=Math.hypot(dx,dy),rmax=Math.max(...[box[0],box[2]].flatMap(x=>[box[1],box[3]].map(y=>Math.hypot(x,y-rho0))));
    bounds=[rmin,rmax].map(r=>inverseT((Math.sign(n)*r/(a*F))**(1/n))).sort((x,y)=>x-y);
  }
  const scale=p=>merc?m(lat0)/m(p):Math.abs(n*F*t(p)**n/m(p));
  const scales=[...bounds,...(lat0>=bounds[0]&&lat0<=bounds[1]?[lat0]:[])].map(scale);
  const scaleMin=Math.min(...scales)*(1-1e-12),scaleMax=Math.max(...scales)*(1+1e-12);
  const relativeErrorBound=Math.max(Math.abs(scaleMin-1),Math.abs(scaleMax-1));
  const shift=[(box[0]+box[2])/2,(box[1]+box[3])/2];
  return {features:preliminary.map(f=>({...f,geometry:mapGeometry(f.geometry,p=>p.map((v,i)=>v-shift[i]))})),
    projection:{id:'WGS84-ellipsoidal-tangent-conic-v1',unit:'metre',a,e2,lon0,lat0Degrees:lat0/rad,
      scaleMin,scaleMax,relativeErrorBound,inverseLatitudeBoundsDegrees:bounds.map(p=>p/rad),shift,
      handlesHighLatitude:true,handlesAntimeridian:true,
      boundaryModel:'Original source vertices transformed without simplification; straight projected chords. Not an administrative restoration certificate.'}};
}

export function convexHull(points) {
  const sorted=[...new Map(points.map(p=>[JSON.stringify(p),p])).values()].sort((a,b)=>a[0]-b[0]||a[1]-b[1]);
  if(sorted.length<3)return sorted;
  const cross=(a,b,c)=>(b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0]);
  const half=ps=>{const h=[];for(const p of ps){while(h.length>1&&cross(h.at(-2),h.at(-1),p)<=0)h.pop();h.push(p);}return h;};
  return [...half(sorted).slice(0,-1),...half([...sorted].reverse()).slice(0,-1)];
}
export function geometryMetrics(geometry,projection) {
  const hull=convexHull(polygons(geometry).flat(2));let diameter=0,width=Infinity;
  for(let i=0;i<hull.length;i++) {
    const a=hull[i],b=hull[(i+1)%hull.length],len=Math.hypot(b[0]-a[0],b[1]-a[1]);
    let w=0;for(const p of hull){diameter=Math.max(diameter,Math.hypot(p[0]-a[0],p[1]-a[1]));w=Math.max(w,Math.abs((b[0]-a[0])*(p[1]-a[1])-(b[1]-a[1])*(p[0]-a[0]))/len);}width=Math.min(width,w);
  }
  const planarArea=area(polygons(geometry))/1e6;
  return {diameterLowerKm:diameter/projection.scaleMax/1000,diameterUpperKm:diameter/projection.scaleMin/1000,
    areaLowerKm2:planarArea/projection.scaleMax**2,areaUpperKm2:planarArea/projection.scaleMin**2,
    aspectUpper:diameter/width*projection.scaleMax/projection.scaleMin,
    components:polygons(geometry).length,holes:polygons(geometry).reduce((n,p)=>n+p.length-1,0)};
}

export const segmentDistance=(p,[a,b])=>{
  const dx=b[0]-a[0],dy=b[1]-a[1],d=dx*dx+dy*dy;
  const t=d?Math.max(0,Math.min(1,((p[0]-a[0])*dx+(p[1]-a[1])*dy)/d)):0;
  return Math.hypot(p[0]-a[0]-t*dx,p[1]-a[1]-t*dy);
};
