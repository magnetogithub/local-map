import GeoJSONReader from 'jsts/org/locationtech/jts/io/GeoJSONReader.js';
import IsValidOp from 'jsts/org/locationtech/jts/operation/valid/IsValidOp.js';
import {normalizeGeometry,polygons,jsonBytes,digest} from './prompt14-catalog-core.mjs';
import {finiteDoubleInteger,exactRingNumerator} from './prompt14-exact-ring.mjs';
import {union} from './prompt15-preservation-audit-core.mjs';
import {physicalMetrics} from './prompt15-cell-physical.mjs';
import {CELL_EXPERIMENT_POLICY as POLICY} from './prompt15-cell-policy.mjs';
const pointKey=p=>JSON.stringify(p),compare=(a,b)=>a[0]-b[0]||a[1]-b[1],edgeKey=(a,b)=>JSON.stringify(compare(a,b)<0?[a,b]:[b,a]);
const signedAreaNumerator=g=>polygons(normalizeGeometry(g)).reduce((n,p)=>n+p.reduce((a,r)=>a+exactRingNumerator(r),0n),0n);
export function externalCellBoundary(cells){
 const edges=new Map();for(const c of cells)for(const p of polygons(normalizeGeometry(c.geometry)))for(const r of p)for(let i=1;i<r.length;i++){const a=r[i-1],b=r[i],key=edgeKey(a,b),list=edges.get(key)??[];list.push({a,b,direction:compare(a,b)<0?1:-1});edges.set(key,list);}
 const external=new Map();for(const [key,list] of edges){if(list.length===1)external.set(key,list[0]);else if(list.length!==2||list[0].direction===list[1].direction)throw Error('Overlapping or unpaired directed source cell sides');}return external;
}
function insertCollinearBoundaryVertices(geometry,points){
 const on=(p,a,b)=>{const [P,A,B]=[p,a,b].map(v=>v.map(finiteDoubleInteger)),dx=B[0]-A[0],dy=B[1]-A[1];return dx*(P[1]-A[1])-dy*(P[0]-A[0])===0n&&P[0]>=(A[0]<B[0]?A[0]:B[0])&&P[0]<=(A[0]>B[0]?A[0]:B[0])&&P[1]>=(A[1]<B[1]?A[1]:B[1])&&P[1]<=(A[1]>B[1]?A[1]:B[1]);};
 return normalizeGeometry({type:'MultiPolygon',coordinates:polygons(geometry).map(p=>p.map(r=>{const out=[];for(let i=1;i<r.length;i++){const a=r[i-1],b=r[i],axis=Math.abs(b[0]-a[0])>=Math.abs(b[1]-a[1])?0:1,inside=points.filter(v=>on(v,a,b)).sort((x,y)=>(x[axis]-y[axis])*Math.sign(b[axis]-a[axis]));out.push(...inside.slice(0,-1));}out.push(out[0]);return out;}))});
}
export function mergeSliverPair(a,b){
 for(const k of ['sourceCountryId','parentKey','adminId','oldTerritoryId','componentIndex','sourceComponentHash'])if(a[k]!==b[k]||a[k]===undefined)throw Error(`Merge ownership mismatch: ${k}`);
 const shared=[];for(const p of polygons(a.geometry))for(const r of p)for(let i=1;i<r.length;i++)for(const q of polygons(b.geometry))for(const s of q)for(let j=1;j<s.length;j++)if(edgeKey(r[i-1],r[i])===edgeKey(s[j-1],s[j]))shared.push([r[i-1],r[i]]);
 if(!shared.length)throw Error('Merge requires an exact positive-length shared boundary; no remote or point-only merge');
 const expected=externalCellBoundary([a,b]),points=[...new Map([...expected.values()].flatMap(e=>[e.a,e.b]).map(p=>[pointKey(p),p])).values()],joined=normalizeGeometry(union([a.geometry,b.geometry]));
 if(joined.type!=='Polygon')throw Error('Merge may not join separate components');
 const geometry=insertCollinearBoundaryVertices(joined,points),actual=externalCellBoundary([{geometry}]);
 if(actual.size!==expected.size||[...expected].some(([key,v])=>actual.get(key)?.direction!==v.direction))throw Error('Merge changed the original external boundary');
 if(signedAreaNumerator(geometry)!==signedAreaNumerator(a.geometry)+signedAreaNumerator(b.geometry))throw Error('Merge lost positive exact area');
 if(!new IsValidOp(new GeoJSONReader().read(geometry)).isValid())throw Error('Invalid merged polygon');
 const metrics=physicalMetrics(geometry),refined=Boolean(a.refined||b.refined);if(metrics.areaKm2>(refined?POLICY.boundaryMaximumAreaKm2:POLICY.interiorMaximumAreaKm2)||metrics.diameterKm>(refined?POLICY.boundaryMaximumDiameterKm:POLICY.interiorMaximumDiameterKm))throw Error('Merge exceeds frozen physical area/diameter cap');
 return {cell:{...a,geometry,refined,mergedFrom:[...(a.mergedFrom??[a.id]),...(b.mergedFrom??[b.id])].sort()},proof:{kind:'same-owner-exact-shared-edge-union',before:[a.id,b.id],sharedSegments:shared,externalBoundaryHash:digest(jsonBytes([...expected.keys()].sort())),exactAreaEquality:true,allOutputPositionsFromOriginalInput:true,physical:metrics}};
}
