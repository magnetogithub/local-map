import {polygons} from '../partition-prototype.mjs';
import {searchNear} from './near-search.mjs';
import {policy} from '../policy-validation.mjs';
import {geometryMetrics,segmentDistance} from './metric.mjs';

const key=p=>JSON.stringify(p);
class Heap {
  a=[];
  push(v){let i=this.a.length;this.a.push(v);while(i){const j=(i-1)>>1;if(this.a[j][0]<=v[0])break;this.a[i]=this.a[j];i=j;}this.a[i]=v;}
  pop(){const first=this.a[0],v=this.a.pop();if(this.a.length){let i=0;while(2*i+1<this.a.length){let j=2*i+1;if(j+1<this.a.length&&this.a[j+1][0]<this.a[j][0])j++;if(this.a[j][0]>=v[0])break;this.a[i]=this.a[j];i=j;}this.a[i]=v;}return first;}
}
function distances(edges,starts){
  const adj=new Map();for(const e of edges){const [a,b]=e.coordinates.map(key);for(const [x,y]of[[a,b],[b,a]]){if(!adj.has(x))adj.set(x,[]);adj.get(x).push([y,e.lengthMetres]);}}
  const d=new Map(),h=new Heap();for(const s of starts){d.set(s,0);h.push([0,s]);}
  while(h.a.length){const [v,k]=h.pop();if(d.get(k)!==v)continue;for(const [next,w]of adj.get(k)??[]){if(v+w<(d.get(next)??Infinity)){d.set(next,v+w);h.push([v+w,next]);}}}return d;
}
export function frontierEdges(result,occupied,target){return result.edges.filter(e=>e.sides.length===2&&e.lengthMetres>0&&e.sides.some(s=>occupied.has(s.ordinal))&&e.sides.some(s=>target.has(s.ordinal)));}
function chainComponents(edges){
  const at=new Map();edges.forEach((e,i)=>e.coordinates.forEach(p=>{const k=key(p);if(!at.has(k))at.set(k,[]);at.get(k).push(i);}));
  const todo=new Set(edges.map((_,i)=>i)),out=[];
  while(todo.size){const q=[todo.values().next().value],group=[];todo.delete(q[0]);for(let j=0;j<q.length;j++){const i=q[j];group.push(edges[i]);for(const p of edges[i].coordinates)for(const n of at.get(key(p))){if(todo.delete(n))q.push(n);}}out.push(group);}return out.sort((a,b)=>b.reduce((s,e)=>s+e.lengthMetres,0)-a.reduce((s,e)=>s+e.lengthMetres,0));
}
function seedChain(edges){
  const group=chainComponents(edges)[0]??[],at=new Map();group.forEach((e,i)=>e.coordinates.forEach(p=>{const k=key(p);if(!at.has(k))at.set(k,[]);at.get(k).push(i);}));
  let node=[...at].filter(([,v])=>v.length===1).map(([k])=>k).sort()[0]??[...at.keys()].sort()[0];
  const seen=new Set(),chosen=[];let length=0;
  while(node){const i=(at.get(node)??[]).find(i=>!seen.has(i));if(i===undefined)break;seen.add(i);chosen.push(group[i]);length+=group[i].lengthMetres;node=group[i].coordinates.map(key).find(k=>k!==node);if(length>=30000)break;}return chosen;
}
export function buildGraph(result){
  const adj=new Map(result.cells.map(c=>[c.ordinal,[]]));
  if(adj.size!==result.cells.length)throw new Error('DUPLICATE_CELL');
  const edgeKey=(a,b)=>JSON.stringify(a[0]<b[0]||(a[0]===b[0]&&a[1]<b[1])?[a,b]:[b,a]);
  const boundaries=new Map(result.cells.map(c=>[c.ordinal,new Set(polygons(c.geometry).flatMap(poly=>poly.flatMap(r=>r.slice(1).map((b,i)=>edgeKey(r[i],b)))))]));
  for(const e of result.edges){
    const length=Math.hypot(e.coordinates[1][0]-e.coordinates[0][0],e.coordinates[1][1]-e.coordinates[0][1]);
    if(!(length>0)||length!==e.lengthMetres)throw new Error('NON_LAND_EDGE');
    if(!e.sides.length||e.sides.length>2||new Set(e.sides.map(s=>s.ordinal)).size!==e.sides.length)throw new Error('INVALID_EDGE_SIDES');
    for(const s of e.sides)if(!boundaries.get(s.ordinal)?.has(edgeKey(...e.coordinates)))throw new Error('REMOTE_OR_UNKNOWN_EDGE');
    if(e.sides.length===2&&e.sides[0].direction+e.sides[1].direction!==0)throw new Error('UNPAIRED_EDGE');
  }
  for(const e of result.edges)if(e.sides.length===2){if(!(e.lengthMetres>0))throw new Error('NON_LAND_EDGE');const[a,b]=e.sides.map(s=>s.ordinal);adj.get(a).push(b);adj.get(b).push(a);}return adj;
}
const reachable=(adj,seeds,allowed)=>{const seen=new Set(seeds.filter(i=>allowed.has(i))),q=[...seen];for(let j=0;j<q.length;j++)for(const n of adj.get(q[j])??[])if(allowed.has(n)&&!seen.has(n)){seen.add(n);q.push(n);}return seen;};

/** Offline graph approximation. Distances are NOT hops: lower bounds use
 * point-to-frontier segment distances; upper bounds use real boundary-edge
 * paths plus a cell diameter. Every interior point sees a boundary vertex,
 * giving a conservative upper bound even in nonconvex cells with holes.
 * Width is contiguous actual frontier contact arclength, with scale bounds.
 * The output explicitly describes this graph-band definition, not a precise
 * ellipsoidal buffer. No runtime selection/token or authority code is added.
 */
export function selectAdvance(result,parents,projection,{occupied,target,extent},memo={}){
  if(!Object.hasOwn(policy.extent,extent))throw new Error('UNKNOWN_EXTENT');
  const known=new Set(result.cells.map(c=>c.ordinal));
  if([...occupied,...target].some(id=>!known.has(id)))throw new Error('UNKNOWN_CELL');
  if([...target].some(id=>occupied.has(id)))throw new Error('OVERLAPPING_SCOPE');
  const scope=JSON.stringify([[...occupied].sort((a,b)=>a-b),[...target].sort((a,b)=>a-b)]);
  if(memo.scope&&memo.scope!==scope)throw new Error('STALE_EXPERIMENT_SCOPE');memo.scope=scope;
  const adj=memo.adj??buildGraph(result),frontier=memo.frontier??frontierEdges(result,occupied,target),seeds=memo.seeds??seedChain(frontier);
  if(!seeds.length)return {extent,status:'infeasible',failures:['NO_POSITIVE_LAND_FRONTIER'],selected:[],frontierEdges:0,perAdmin:[]};
  const mesh=result.edges.filter(e=>e.sides.some(s=>target.has(s.ordinal))),starts=es=>new Set(es.flatMap(e=>e.coordinates.map(key)));
  const allD=memo.allD??distances(mesh,starts(frontier)),seedD=memo.seedD??distances(mesh,starts(seeds));
  const limits=policy.extent[extent],threshold={near:30,limited:70,deeper:110}[extent],byId=new Map(result.cells.map(c=>[c.ordinal,c]));
  const bounds=memo.bounds??new Map();
  if(!memo.bounds)for(const id of target){const c=byId.get(id),p=polygons(c.geometry).flat(2),m=geometryMetrics(c.geometry,projection);
    const low=p.map(v=>Math.min(...frontier.map(e=>segmentDistance(v,e.coordinates)))) .map(d=>d/projection.scaleMax/1000);
    const upper=d=>Math.max(...p.map(v=>d.get(key(v))??Infinity))/projection.scaleMin/1000+m.diameterUpperKm;
    bounds.set(id,{lower:Math.max(...low),minLower:Math.min(...low),upper:upper(allD),seedUpper:upper(seedD),metrics:m});}
  Object.assign(memo,{adj,frontier,seeds,allD,seedD,bounds});
  const allowed=new Set([...target].filter(id=>bounds.get(id).seedUpper<=threshold)),seedIds=seeds.flatMap(e=>e.sides.filter(s=>target.has(s.ordinal)).map(s=>s.ordinal));
  // Reuse the repaired prerequisite's bounded search for the SHALLOWEST
  // qualifying near scope and contiguous contact window. Thresholds stay fixed.
  const near=extent==='near'?searchNear(result,parents,projection,occupied,target,{adj,frontier,bounds,distances}):null;
  const selected=near?.status==='eligible'?new Set(near.selected):reachable(adj,seedIds,allowed),sorted=[...selected].sort((a,b)=>a-b);
  if(!sorted.length)return {extent,status:'infeasible',failures:['SMALLER_SCOPE_REQUIRED'],selected:[],frontierEdges:frontier.length,perAdmin:[]};
  const touched=frontier.filter(e=>e.sides.some(s=>selected.has(s.ordinal))),width=touched.reduce((s,e)=>s+e.lengthMetres,0)/1000;
  const lower=Math.max(...sorted.map(id=>bounds.get(id).lower)),upper=Math.max(...sorted.map(id=>bounds.get(id).upper));
  const connected=reachable(adj,[sorted[0]],selected).size===selected.size,failures=[];
  const check=(name,ok)=>{if(!ok)failures.push(name);};
  check('depth.minimum',lower>=limits.minDepthKm);check('depth.maximum',upper<=limits.maxDepthKm);
  check('width.minimum',width/projection.scaleMax>=limits.minWidthKm);check('width.maximum',width/projection.scaleMin<=limits.maxWidthKm);
  check('width.contiguous',chainComponents(touched).length===1);check('connected',connected);
  check('aggregate.cap',selected.size<=policy.budget.aggregateChangedCells);
  const totalArea=sorted.reduce((s,id)=>s+bounds.get(id).metrics.areaUpperKm2,0);check('area.maximum',totalArea<=limits.maxAreaKm2);
  const component=reachable(adj,near?.status==='eligible'?near.selected:seedIds,target),remaining=new Set([...component].filter(id=>!selected.has(id))),perAdmin=[];
  for(const parent of parents){const member=result.cells.filter(c=>c.parentKey===parent.key),ids=member.filter(c=>selected.has(c.ordinal)).map(c=>c.ordinal);if(!ids.length)continue;
    const m=geometryMetrics(parent.geometry,projection),area=ids.reduce((s,id)=>s+bounds.get(id).metrics.areaUpperKm2,0);
    // Only inward, untouched land on the starting land-connected component;
    // offshore islands cannot be used as a retained-interior remainder.
    const inward=member.filter(c=>remaining.has(c.ordinal)&&bounds.get(c.ordinal).minLower>lower);
    const retained=inward.reduce((s,c)=>s+bounds.get(c.ordinal).metrics.areaLowerKm2,0),fraction=area/m.areaLowerKm2,retainedFraction=retained/m.areaUpperKm2;
    const f=[];if(fraction>limits.maxAdminAreaFraction)f.push('admin.area-fraction');if(retainedFraction<limits.minRetainedInteriorFraction)f.push('admin.retained-interior');if(ids.length===member.length)f.push('admin.whole-membership');
    failures.push(...f.map(s=>`${parent.key}:${s}`));perAdmin.push({parentKey:parent.key,selectedCells:ids.length,totalCells:member.length,areaUpperKm2:area,adminMetrics:m,areaFractionUpper:fraction,retainedInteriorAreaLowerKm2:retained,retainedInteriorFractionLower:retainedFraction,retainedInteriorOrdinals:inward.map(c=>c.ordinal).sort((a,b)=>a-b),failures:f});
  }
  // Return no actionable IDs for a disconnected scope, including rejected
  // diagnostic scopes. Preserve the COMPLETE candidate as explicit evidence;
  // never pick/truncate a component or advance the next controller frontier.
  if(!connected)return {extent,status:'infeasible',failures:[...failures,'DISCONNECTED_SELECTION'],selected:[],frontierEdges:frontier.length,
    perAdmin:[],depthStagesWithinW:[],rejectedScope:{selected:sorted,failures,connected:false,
      startingFrontier:frontier.map(e=>e.coordinates),contactFrontier:touched.map(e=>e.coordinates),
      depthLowerKm:lower,depthUpperKm:upper,widthLowerKm:width/projection.scaleMax,widthUpperKm:width/projection.scaleMin,areaUpperKm2:totalArea,perAdmin}};
  return {extent,status:failures.length?'rejected':'eligible',failures,selected:sorted,frontierEdges:frontier.length,
    startingFrontier:frontier.map(e=>e.coordinates),contactFrontier:touched.map(e=>e.coordinates),connected,
    depthLowerKm:lower,depthUpperKm:upper,widthLowerKm:width/projection.scaleMax,widthUpperKm:width/projection.scaleMin,areaUpperKm2:totalArea,
    depthStagesWithinW:[...new Set([...bounds].filter(([id,b])=>component.has(id)&&b.upper<=policy.physical.representativeAdvanceWKm).map(([,b])=>Math.floor(b.lower/5)))].sort((a,b)=>a-b),
    perAdmin,nearScopeSearch:near?{status:near.status,attemptedScopes:near.attemptedScopes,windowOffsetMetres:near.windowOffsetMetres}:null,approximation:'Positive land-edge graph band; depth bounded by Euclidean lower / mesh-boundary path upper; width is contiguous occupied contact arclength on the starting frontier. No geodesic-buffer claim.'};
}

export function compareAdvances(result,parents,projection,actorCountry){
  const adj=buildGraph(result);let occupied;
  if(actorCountry)occupied=new Set(result.cells.filter(c=>c.sourceCountryId===actorCountry).map(c=>c.ordinal));
  else {
    // A generic offline pre-existing controller boundary inside a real source
    // region. This is explicitly not a coast or a fictitious foreign border.
    const remaining=new Set(result.cells.map(c=>c.ordinal)),components=[];
    while(remaining.size){const group=reachable(adj,[remaining.values().next().value],remaining);components.push(group);for(const id of group)remaining.delete(id);}
    const largest=components.sort((a,b)=>b.size-a.size)[0]??new Set(),cells=result.cells.filter(c=>largest.has(c.ordinal));
    const centre=c=>{const p=polygons(c.geometry).flat(2);return p.reduce((s,p)=>s+p[0],0)/p.length;};
    const xs=cells.map(centre).sort((a,b)=>a-b),cut=xs[Math.floor(xs.length*.05)];
    const possible=new Set(cells.filter(c=>Math.max(...polygons(c.geometry).flat(2).map(p=>p[0]))<=cut).map(c=>c.ordinal));
    if(!possible.size&&cells.length>1)possible.add([...cells].sort((a,b)=>centre(a)-centre(b)||a.ordinal-b.ordinal)[0].ordinal);
    occupied=possible.size?reachable(adj,[Math.min(...possible)],possible):new Set();
  }
  const target=new Set(result.cells.filter(c=>!occupied.has(c.ordinal)).map(c=>c.ordinal));
  const initialMemo={},subsequentMemo={};
  const initial=Object.keys(policy.extent).map(extent=>selectAdvance(result,parents,projection,{occupied,target,extent},initialMemo));
  const first=initial.find(a=>a.extent==='near'),after=new Set([...occupied,...first.selected]),nextTarget=new Set([...target].filter(id=>!after.has(id)));
  const subsequent=Object.keys(policy.extent).map(extent=>selectAdvance(result,parents,projection,{occupied:after,target:nextTarget,extent},subsequentMemo));
  return {initialFrontier:actorCountry?'source-country-land-border':'offline-current-control-interior',initialOccupied:[...occupied].sort((a,b)=>a-b),initial,
    subsequentFrontier:'current-control-after-initial-near-experiment',subsequent,firstAdvanceEligible:first.status==='eligible',
    continuationIsDiagnostic:first.status!=='eligible',ownerState:'immutable source parent; only offline controller set changes',
    noProductionToolOrE2E:true};
}
