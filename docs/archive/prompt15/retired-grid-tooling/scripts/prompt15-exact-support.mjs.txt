// Exact set-support certificate for parent preparation. The rational bands
// are evidence, never generated source geometry or an ownership fallback.
import {finiteDoubleInteger} from './prompt14-exact-ring.mjs';
import {normalizeGeometry,polygons,digest,jsonBytes} from './prompt14-catalog-core.mjs';
import GeoJSONReader from 'jsts/org/locationtech/jts/io/GeoJSONReader.js';
import IsValidOp from 'jsts/org/locationtech/jts/operation/valid/IsValidOp.js';
const abs=n=>n<0n?-n:n,gcd=(a,b)=>{a=abs(a);b=abs(b);while(b){[a,b]=[b,a%b];}return a;};
const rat=(n,d=1n)=>{if(!d)throw Error('zero denominator');if(d<0n){n=-n;d=-d;}const g=gcd(n,d);return {n:n/g,d:d/g};};
const add=(a,b)=>rat(a.n*b.d+b.n*a.d,a.d*b.d),sub=(a,b)=>rat(a.n*b.d-b.n*a.d,a.d*b.d),mul=(a,b)=>rat(a.n*b.n,a.d*b.d),compare=(a,b)=>a.n*b.d<b.n*a.d?-1:a.n*b.d>b.n*a.d?1:0;
const key=a=>`${a.n}/${a.d}`,cross=(a,b)=>a[0]*b[1]-a[1]*b[0],delta=(a,b)=>a.map((v,i)=>v-b[i]),serial=r=>({numerator:String(r.n),denominator:String(r.d)});
function approx(r){const bits=n=>abs(n).toString(2).length,ns=Math.max(0,bits(r.n)-53),ds=Math.max(0,bits(r.d)-53);return Number(r.n>>BigInt(ns))/Number(r.d>>BigInt(ds))*2**(ns-ds);}
export function exactSupportPartition(named,{domainNames=Object.keys(named),keepBands=()=>false}={}){
 const reader=new GeoJSONReader(),normalized=Object.fromEntries(Object.entries(named).map(([name,g])=>{const canonical=normalizeGeometry(g);if(!new IsValidOp(reader.read(canonical)).isValid())throw Error(`Invalid exact support input: ${name}`);return [name,canonical];})),all=Object.values(normalized).flatMap(g=>polygons(g).flat(2).flat()),integers=all.map(finiteDoubleInteger);
 if(!domainNames.length||domainNames.some(n=>!normalized[n]))throw Error('Explicit nonempty support domain required');
 const shift=Math.min(...integers.filter(n=>n!==0n).map(n=>{const s=abs(n).toString(2);return s.length-s.lastIndexOf('1')-1;})),power=shift-1074,integer=v=>finiteDoubleInteger(v)>>BigInt(shift),segments=[];
 let minX=null,maxX=null;
 for(const name of domainNames)for(const p of polygons(normalized[name]).flat(2)){const x=integer(p[0]);if(minX===null||x<minX)minX=x;if(maxX===null||x>maxX)maxX=x;}
 for(const [name,g] of Object.entries(normalized))for(const [component,p] of polygons(g).entries())for(const [ring,r] of p.entries())for(let index=1;index<r.length;index++){
  const a=r[index-1].map(integer),b=r[index].map(integer);if(a.every((v,i)=>v===b[i]))continue;
  const lo=a[0]<b[0]?a[0]:b[0],hi=a[0]>b[0]?a[0]:b[0];if(hi<minX||lo>maxX)continue;
  segments.push({name,component,ring,index:index-1,a,b,lo,hi,ylo:a[1]<b[1]?a[1]:b[1],yhi:a[1]>b[1]?a[1]:b[1],dx:b[0]-a[0],dy:b[1]-a[1]});
 }
 const events=new Map(),insert=x=>{if(compare(x,rat(minX))>=0&&compare(x,rat(maxX))<=0)events.set(key(x),x);};insert(rat(minX));insert(rat(maxX));for(const s of segments){insert(rat(s.a[0]));insert(rat(s.b[0]));}
 let candidatePairs=0,properIntersections=0;
 for(let i=0;i<segments.length;i++)for(let j=0;j<i;j++){
  const a=segments[i],b=segments[j];if(a.hi<b.lo||b.hi<a.lo||a.yhi<b.ylo||b.yhi<a.ylo)continue;candidatePairs++;
  const r=[a.dx,a.dy],s=[b.dx,b.dy],q=delta(b.a,a.a);let d=cross(r,s),t=cross(q,s),u=cross(q,r);if(!d)continue;if(d<0n){d=-d;t=-t;u=-u;}if(t<0n||t>d||u<0n||u>d)continue;
  insert(rat(a.a[0]*d+a.dx*t,d));if(t>0n&&t<d&&u>0n&&u<d)properIntersections++;
 }
 const xs=[...events.values()].sort(compare),sums=new Map(),bands=[],names=Object.keys(named);let positiveBands=0;
 const yAt=(s,x)=>rat(s.a[1]*s.dx*x.d+s.dy*(x.n-s.a[0]*x.d),s.dx*x.d);
 for(let index=1;index<xs.length;index++){
  const left=xs[index-1],right=xs[index],mid=mul(add(left,right),rat(1n,2n)),width=sub(right,left),active=segments.filter(s=>s.dx&&compare(rat(s.lo),mid)<0&&compare(mid,rat(s.hi))<0).map(s=>({s,y:yAt(s,mid)})).sort((a,b)=>compare(a.y,b.y)),winding=Object.fromEntries(names.map(n=>[n,0])),groups=[];
  for(const e of active){if(groups.length&&compare(groups.at(-1)[0].y,e.y)===0)groups.at(-1).push(e);else groups.push([e]);}
  for(let k=0;k<groups.length;k++){
   for(const {s} of groups[k])winding[s.name]+=s.dx>0n?1:-1;
   if(k===groups.length-1)break;
   const mask=names.filter(n=>winding[n]!==0),lower=groups[k][0].s,upper=groups[k+1][0].s,yl=[yAt(lower,left),yAt(lower,right)],yu=[yAt(upper,left),yAt(upper,right)],height=add(sub(yu[0],yl[0]),sub(yu[1],yl[1])),area=mul(mul(width,height),rat(1n,2n));
   if(area.n<0n)throw Error('Unsplit exact crossing in slab');if(!area.n)continue;positiveBands++;
   const maskKey=mask.join('|');sums.set(maskKey,add(sums.get(maskKey)??rat(0n),area));
   if(keepBands(mask))bands.push({mask,left:serial(left),right:serial(right),lower:{name:lower.name,component:lower.component,ring:lower.ring,index:lower.index},upper:{name:upper.name,component:upper.component,ring:upper.ring,index:upper.index},corners:[[left,yl[0]],[right,yl[1]],[right,yu[1]],[left,yu[0]]].map(p=>p.map(serial)),area:serial(area),areaDegrees2:approx(area)*2**(2*power)});
  }
  if(Object.values(winding).some(v=>v!==0))throw Error('Unbalanced polygon winding in exact sweep');
 }
 return {method:'Exact rational vertical decomposition: all input vertices and pairwise boundary intersections are slab events; winding constant in every positive open band. No area epsilon or sampled expectation.',coordinatePowerOfTwo:power,names,segments:segments.length,candidatePairs,properIntersections,slabs:xs.length-1,positiveBands,sums:[...sums].map(([mask,area])=>({mask:mask.split('|').filter(Boolean),area:serial(area),areaDegrees2:approx(area)*2**(2*power)})),bands};
}

export function certifyPreparedIntersection(source,country,prepared){
 const hasPrepared=polygons(prepared).length>0,named={source,country,...hasPrepared?{prepared}:{}},isMissing=mask=>mask.includes('source')&&mask.includes('country')&&!mask.includes('prepared'),isOutside=mask=>mask.includes('prepared')&&(!mask.includes('source')||!mask.includes('country'));
 const partition=exactSupportPartition(named,{domainNames:hasPrepared?['source','prepared']:['source'],keepBands:mask=>isMissing(mask)||isOutside(mask)}),missing=partition.sums.filter(s=>isMissing(s.mask)),outside=partition.sums.filter(s=>isOutside(s.mask));
 return {pass:missing.length===0&&outside.length===0,missing,outside,partition,criterion:'Exact positive set support; no net-area cancellation, sampling exemption or numerical tolerance substitution. A rejection is not a claim that the approved source is defective.'};
}

// This certifies the complete exact open support of a fixed face; the output
// rational bands must not be mistaken for native GeoJSON cells. In particular
// it cannot make an unrepresentable positive piece disappear or approve its
// independently rounded polygon proxy.
export function certifyExactFaceSupport(face,country,parents,oldTerritories){
 if(!Array.isArray(parents)||!parents.length||!Array.isArray(oldTerritories)||!oldTerritories.length||new Set(parents.map(p=>p.id)).size!==parents.length||new Set(oldTerritories.map(p=>p.id)).size!==oldTerritories.length)throw Error('Explicit distinct source and previous-territory identities required');
 const names={face,country},parentNames=new Map(),oldNames=new Map();
 for(const [i,p] of parents.entries()){
  if(!new IsValidOp(new GeoJSONReader().read(normalizeGeometry(p.geometry))).isValid())throw Error('Invalid original parent support');
  for(const [componentIndex,coordinates] of polygons(p.geometry).entries()){const name=`parent${i}component${componentIndex}`,geometry={type:'Polygon',coordinates};parentNames.set(name,{id:p.id,componentIndex,sourceComponentHash:digest(jsonBytes(normalizeGeometry(geometry)))});names[name]=geometry;}
 }
 for(const [i,p] of oldTerritories.entries()){const name=`old${i}`;oldNames.set(name,p.id);names[name]=p.geometry;}
 const partition=exactSupportPartition(names,{domainNames:['face'],keepBands:mask=>mask.includes('face')}),errors=[],pieces=[];
 for(const band of partition.bands){const sourceComponents=band.mask.filter(n=>parentNames.has(n)).map(n=>parentNames.get(n)),oldIds=band.mask.filter(n=>oldNames.has(n)).map(n=>oldNames.get(n));if(!band.mask.includes('country')||sourceComponents.length!==1||oldIds.length!==1)errors.push({kind:'non-unique-or-unsupported-exact-face',band,sourceComponents,oldIds});else pieces.push({parentId:sourceComponents[0].id,componentIndex:sourceComponents[0].componentIndex,sourceComponentHash:sourceComponents[0].sourceComponentHash,oldTerritoryId:oldIds[0],...band});}
 return {pass:errors.length===0&&pieces.length>0,scope:'Exact source support certificate; rational bands are not generated native cells',pieces,errors,partition};
}
