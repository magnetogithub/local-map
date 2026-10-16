import {policy} from '../policy-validation.mjs';
import {polygons} from '../partition-prototype.mjs';
import {geometryMetrics} from './metric.mjs';
const key=p=>JSON.stringify(p);
const connected=(adj,seeds,allowed)=>{const seen=new Set(seeds.filter(i=>allowed.has(i))),q=[...seen];for(let i=0;i<q.length;i++)for(const n of adj.get(q[i])??[])if(allowed.has(n)&&!seen.has(n)){seen.add(n);q.push(n);}return seen;};
function contactChain(frontier,offset){
  const at=new Map();frontier.forEach((e,i)=>e.coordinates.forEach(p=>{const k=key(p);if(!at.has(k))at.set(k,[]);at.get(k).push(i);}));
  let node=[...at].filter(([,es])=>es.length===1).map(([k])=>k).sort()[0]??[...at.keys()].sort()[0],traversed=0,length=0;
  const seen=new Set(),out=[];
  while(node){const i=(at.get(node)??[]).find(i=>!seen.has(i));if(i===undefined)break;seen.add(i);traversed+=frontier[i].lengthMetres;if(traversed>offset){out.push(frontier[i]);length+=frontier[i].lengthMetres;}node=frontier[i].coordinates.map(key).find(k=>k!==node);if(length>=30000)break;}return out;
}
const contiguous=edges=>{
  if(!edges.length)return false;const at=new Map();edges.forEach((e,i)=>e.coordinates.forEach(p=>{const k=key(p);if(!at.has(k))at.set(k,[]);at.get(k).push(i);}));
  const seen=new Set([0]),q=[0];for(let i=0;i<q.length;i++)for(const p of edges[q[i]].coordinates)for(const n of at.get(key(p)))if(!seen.has(n)){seen.add(n);q.push(n);}return seen.size===edges.length;
};
// Same shallow-scope/contact-window experiment as the pinned prerequisite,
// sharing invariant current-frontier geometry metrics between windows. No
// global cache: different experiments, controllers and games cannot mix.
export function searchNear(result,parents,projection,occupied,target,{adj,frontier,bounds,distances}){
  const limits=policy.extent.near,mesh=result.edges.filter(e=>e.sides.some(s=>target.has(s.ordinal))),parentMetrics=new Map(parents.map(p=>[p.key,geometryMetrics(p.geometry,projection)]));
  const cellsByParent=new Map(parents.map(p=>[p.key,result.cells.filter(c=>c.parentKey===p.key)]));
  const candidates=[];let attemptedScopes=0;
  for(let offset=0;offset<=limits.maxWidthKm*1000;offset+=15000){
    const seeds=contactChain(frontier,offset);if(!seeds.length)continue;
    const seedIds=seeds.flatMap(e=>e.sides.filter(s=>target.has(s.ordinal)).map(s=>s.ordinal)),component=connected(adj,seedIds,target);
    const d=distances(mesh,new Set(seeds.flatMap(e=>e.coordinates.map(key)))),upper=new Map();
    for(const c of result.cells)if(target.has(c.ordinal))upper.set(c.ordinal,Math.max(...polygons(c.geometry).flat(2).map(p=>d.get(key(p))??Infinity))/projection.scaleMin/1000+bounds.get(c.ordinal).metrics.diameterUpperKm);
    for(let threshold=limits.minDepthKm;threshold<=limits.maxDepthKm;threshold++){
      const allowed=new Set([...target].filter(id=>upper.get(id)<=threshold)),selected=connected(adj,seedIds,allowed);if(!selected.size)continue;attemptedScopes++;
      // A shared occupied-side frontier can touch disconnected target pockets.
      // Multi-source reachability is not a connectivity certificate for their
      // union: reject this entire candidate before ranking a near scope.
      const ids=[...selected];
      if(connected(adj,[ids[0]],selected).size!==selected.size)continue;
      const touched=frontier.filter(e=>e.sides.some(s=>selected.has(s.ordinal)));
      const low=Math.max(...ids.map(id=>bounds.get(id).lower)),high=Math.max(...ids.map(id=>bounds.get(id).upper)),width=touched.reduce((s,e)=>s+e.lengthMetres,0)/1000,area=ids.reduce((s,id)=>s+bounds.get(id).metrics.areaUpperKm2,0);
      if(low<limits.minDepthKm||high>limits.maxDepthKm||width/projection.scaleMax<limits.minWidthKm||width/projection.scaleMin>limits.maxWidthKm||!contiguous(touched)||ids.length>policy.budget.aggregateChangedCells||area>limits.maxAreaKm2)continue;
      let valid=true;const retainedFractions=[];
      for(const [parentKey,cells]of cellsByParent){const chosen=cells.filter(c=>selected.has(c.ordinal));if(!chosen.length)continue;
        const pm=parentMetrics.get(parentKey),occupiedArea=chosen.reduce((s,c)=>s+bounds.get(c.ordinal).metrics.areaUpperKm2,0);
        const inward=cells.filter(c=>component.has(c.ordinal)&&!selected.has(c.ordinal)&&bounds.get(c.ordinal).minLower>low),retained=inward.reduce((s,c)=>s+bounds.get(c.ordinal).metrics.areaLowerKm2,0)/pm.areaUpperKm2;
        retainedFractions.push(retained);if(occupiedArea/pm.areaLowerKm2>limits.maxAdminAreaFraction||retained<limits.minRetainedInteriorFraction||chosen.length===cells.length)valid=false;
      }
      if(valid){candidates.push({status:'eligible',selected:ids.sort((a,b)=>a-b),retainedMinimum:Math.min(...retainedFractions),areaUpperKm2:area,windowOffsetMetres:offset,thresholdKm:threshold});break;}
    }
  }
  candidates.sort((a,b)=>b.retainedMinimum-a.retainedMinimum||a.areaUpperKm2-b.areaUpperKm2||a.windowOffsetMetres-b.windowOffsetMetres);
  return {...(candidates[0]??{status:'infeasible',selected:[]}),attemptedScopes};
}
