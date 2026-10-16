import {polygons} from './partition-prototype.mjs';
import {policy} from './policy-validation.mjs';
import {geometryMetrics,segmentDistance} from './metric-chart.mjs';
const key=p=>JSON.stringify(p);
class Heap {
  a=[];
  push(v){let i=this.a.length;this.a.push(v);while(i){const p=(i-1)>>1;if(this.a[p][0]<=v[0])break;this.a[i]=this.a[p];i=p;}this.a[i]=v;}
  pop(){const first=this.a[0],last=this.a.pop();if(this.a.length){let i=0;while(2*i+1<this.a.length){let j=2*i+1;if(j+1<this.a.length&&this.a[j+1][0]<this.a[j][0])j++;if(this.a[j][0]>=last[0])break;this.a[i]=this.a[j];i=j;}this.a[i]=last;}return first;}
}
const connected=(adj,seeds,allowed)=>{
  const seen=new Set(seeds.filter(i=>allowed.has(i))),queue=[...seen];
  for(let i=0;i<queue.length;i++)for(const n of adj.get(queue[i])??[])if(allowed.has(n)&&!seen.has(n)){seen.add(n);queue.push(n);}return seen;
};
const contiguous=edges=>{
  if(!edges.length)return false;
  const at=new Map();edges.forEach((e,i)=>e.coordinates.forEach(p=>{const k=key(p);if(!at.has(k))at.set(k,[]);at.get(k).push(i);}));
  const seen=new Set([0]),queue=[0];for(let i=0;i<queue.length;i++)for(const p of edges[queue[i]].coordinates)for(const n of at.get(key(p)))if(!seen.has(n)){seen.add(n);queue.push(n);}
  return seen.size===edges.length;
};
const vertexDistances=(edges,starts)=>{
  const adj=new Map();for(const e of edges){const[a,b]=e.coordinates.map(key);for(const[x,y]of[[a,b],[b,a]]){if(!adj.has(x))adj.set(x,[]);adj.get(x).push([y,e.lengthMetres]);}}
  const d=new Map(),h=new Heap();for(const p of starts){d.set(p,0);h.push([0,p]);}
  while(h.a.length){const[v,p]=h.pop();if(v!==d.get(p))continue;for(const[n,w]of adj.get(p)??[])if(v+w<(d.get(n)??Infinity)){d.set(n,v+w);h.push([v+w,n]);}}return d;
};
function contactChain(frontier,offsetMetres=0) {
  const at=new Map();frontier.forEach((e,i)=>e.coordinates.forEach(p=>{const k=key(p);if(!at.has(k))at.set(k,[]);at.get(k).push(i);}));
  let node=[...at].filter(([,e])=>e.length===1).map(([k])=>k).sort()[0]??[...at.keys()].sort()[0];
  const seen=new Set(),selected=[];let length=0,traversed=0;
  while(node){const i=(at.get(node)??[]).find(i=>!seen.has(i));if(i===undefined)break;seen.add(i);
    traversed+=frontier[i].lengthMetres;if(traversed>offsetMetres){selected.push(frontier[i]);length+=frontier[i].lengthMetres;}
    node=frontier[i].coordinates.map(key).find(k=>k!==node);if(length>=30000)break;}return selected;
}
/** Offline geometry probe only, no production tool/authority/controller API.
 * Deterministically choose the SHALLOWEST connected near band meeting unchanged
 * physical limits. Search changes the requested scope, never the policy limits.
 * Every retained inland square metre comes from an untouched meshed cell. */
function probeNearWindow(result,parents,projection,occupied,windowOffsetMetres) {
  const target=new Set(result.cells.filter(c=>!occupied.has(c.ordinal)).map(c=>c.ordinal));
  const adj=new Map(result.cells.map(c=>[c.ordinal,[]]));
  for(const e of result.edges)if(e.sides.length===2){const[a,b]=e.sides.map(s=>s.ordinal);adj.get(a).push(b);adj.get(b).push(a);}
  const frontier=result.edges.filter(e=>e.sides.length===2&&e.sides.some(s=>occupied.has(s.ordinal))&&e.sides.some(s=>target.has(s.ordinal)));
  const seeds=contactChain(frontier,windowOffsetMetres);
  if(!seeds.length)return {status:'infeasible',failures:['NO_POSITIVE_CURRENT_FRONTIER'],selected:[]};
  const mesh=result.edges.filter(e=>e.sides.some(s=>target.has(s.ordinal))),vertices=edges=>new Set(edges.flatMap(e=>e.coordinates.map(key)));
  const allD=vertexDistances(mesh,vertices(frontier)),seedD=vertexDistances(mesh,vertices(seeds)),bounds=new Map();
  for(const c of result.cells)if(target.has(c.ordinal)) {
    const points=polygons(c.geometry).flat(2),metrics=geometryMetrics(c.geometry,projection);
    const d=points.map(p=>Math.min(...frontier.map(e=>segmentDistance(p,e.coordinates)))/projection.scaleMax/1000);
    const upper=dist=>Math.max(...points.map(p=>dist.get(key(p))??Infinity))/projection.scaleMin/1000+metrics.diameterUpperKm;
    bounds.set(c.ordinal,{metrics,lower:Math.max(...d),minLower:Math.min(...d),upper:upper(allD),seedUpper:upper(seedD)});
  }
  const seedCells=seeds.flatMap(e=>e.sides.filter(s=>target.has(s.ordinal)).map(s=>s.ordinal)),component=connected(adj,seedCells,target),limits=policy.extent.near;
  const attempts=[];
  for(let threshold=limits.minDepthKm;threshold<=limits.maxDepthKm;threshold++) {
    const allowed=new Set([...target].filter(id=>bounds.get(id).seedUpper<=threshold)),chosen=connected(adj,seedCells,allowed);
    if(!chosen.size)continue;
    const selected=[...chosen].sort((a,b)=>a-b),touched=frontier.filter(e=>e.sides.some(s=>chosen.has(s.ordinal)));
    const lower=Math.max(...selected.map(i=>bounds.get(i).lower)),upper=Math.max(...selected.map(i=>bounds.get(i).upper));
    const width=touched.reduce((s,e)=>s+e.lengthMetres,0)/1000,area=selected.reduce((s,i)=>s+bounds.get(i).metrics.areaUpperKm2,0);
    const failures=[],check=(name,ok)=>{if(!ok)failures.push(name);};
    check('depth.minimum',lower>=limits.minDepthKm);check('depth.maximum',upper<=limits.maxDepthKm);
    check('width.minimum',width/projection.scaleMax>=limits.minWidthKm);check('width.maximum',width/projection.scaleMin<=limits.maxWidthKm);
    check('width.contiguous',contiguous(touched));
    check('aggregate.cap',selected.length<=policy.budget.aggregateChangedCells);check('area.maximum',area<=limits.maxAreaKm2);
    check('connected',connected(adj,[selected[0]],chosen).size===selected.length);
    const perParent=[];
    for(const p of parents){const cells=result.cells.filter(c=>c.parentKey===p.key),selectedCells=cells.filter(c=>chosen.has(c.ordinal));if(!selectedCells.length)continue;
      const metrics=geometryMetrics(p.geometry,projection),occupiedArea=selectedCells.reduce((s,c)=>s+bounds.get(c.ordinal).metrics.areaUpperKm2,0);
      const untouched=cells.filter(c=>component.has(c.ordinal)&&!chosen.has(c.ordinal)&&bounds.get(c.ordinal).minLower>lower);
      const retained=untouched.reduce((s,c)=>s+bounds.get(c.ordinal).metrics.areaLowerKm2,0);
      const areaFraction=occupiedArea/metrics.areaLowerKm2,retainedFraction=retained/metrics.areaUpperKm2;
      check(`${p.key}:area-fraction`,areaFraction<=limits.maxAdminAreaFraction);check(`${p.key}:retained-interior`,retainedFraction>=limits.minRetainedInteriorFraction);
      check(`${p.key}:whole-membership`,selectedCells.length<cells.length);
      perParent.push({parentKey:p.key,selectedCells:selectedCells.length,totalCells:cells.length,areaFraction,retainedInteriorFraction:retainedFraction,retainedMeshedCells:untouched.length});
    }
    const attempt={status:failures.length?'rejected':'eligible',failures,selected,depthLowerKm:lower,depthUpperKm:upper,
      widthLowerKm:width/projection.scaleMax,widthUpperKm:width/projection.scaleMin,areaUpperKm2:area,perParent,thresholdKm:threshold};
    if(!failures.length)return {...attempt,windowOffsetMetres,attemptedScopes:attempts.length+1,frontier:frontier.map(e=>e.coordinates),scope:'offline current-controller positive-edge graph; conservative metric bounds'};
    attempts.push(attempt);
  }
  return {...attempts[0],status:'infeasible',attemptedScopes:attempts.length,attemptFailures:attempts.map(a=>({thresholdKm:a.thresholdKm,failures:a.failures,perParent:a.perParent})),selected:[]};
}
export function probeNear(result,parents,projection,occupied) {
  const attempts=[];
  // A bounded set of contiguous contact windows on the same actual frontier.
  // Prefer the candidate retaining most real inland geometry; never remote
  // cells, a source-border reset after occupation, or a relaxed policy limit.
  for(let offset=0;offset<=policy.extent.near.maxWidthKm*1000;offset+=15000) attempts.push(probeNearWindow(result,parents,projection,occupied,offset));
  const eligible=attempts.filter(a=>a.status==='eligible').sort((a,b)=>
    Math.min(...b.perParent.map(p=>p.retainedInteriorFraction))-Math.min(...a.perParent.map(p=>p.retainedInteriorFraction))||a.areaUpperKm2-b.areaUpperKm2||a.windowOffsetMetres-b.windowOffsetMetres);
  return eligible[0]??{...attempts[0],windowFailures:attempts.map(a=>({failures:a.failures,attemptedScopes:a.attemptedScopes}))};
}
export function probeTwoAdvances(sample,result) {
  if(!sample.actor)throw new Error('EXPLICIT_OFFLINE_ACTOR_REQUIRED');
  const before=new Set(result.cells.filter(c=>c.sourceCountryId===sample.actor).map(c=>c.ordinal));
  const initial=probeNear(result,sample.parents,sample.projection,before);
  if(initial.status!=='eligible')return {initial,subsequent:null,continuationPerformed:false};
  const after=new Set([...before,...initial.selected]),subsequent=probeNear(result,sample.parents,sample.projection,after);
  return {initial,subsequent,continuationPerformed:true,ownerChanged:false,productionToolOrMigration:false};
}
