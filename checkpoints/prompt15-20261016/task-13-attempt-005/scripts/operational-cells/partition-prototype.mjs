import clipping from 'polygon-clipping';
import GeoJSONReader from 'jsts/org/locationtech/jts/io/GeoJSONReader.js';
import IsValidOp from 'jsts/org/locationtech/jts/operation/valid/IsValidOp.js';
import Coordinate from 'jsts/org/locationtech/jts/geom/Coordinate.js';
import NodedSegmentString from 'jsts/org/locationtech/jts/noding/NodedSegmentString.js';
import ArrayList from 'jsts/java/util/ArrayList.js';
import PrecisionModel from 'jsts/org/locationtech/jts/geom/PrecisionModel.js';
import MCIndexSnapRounder from 'jsts/org/locationtech/jts/noding/snapround/MCIndexSnapRounder.js';
import Polygonizer from 'jsts/org/locationtech/jts/operation/polygonize/Polygonizer.js';
import GeoJSONWriter from 'jsts/org/locationtech/jts/io/GeoJSONWriter.js';
import InteriorPointArea from 'jsts/org/locationtech/jts/algorithm/InteriorPointArea.js';
import PointLocator from 'jsts/org/locationtech/jts/algorithm/PointLocator.js';
import {policy, policyIdentity} from './policy-validation.mjs';

// Offline experiment only. Local ordinals are NOT production territory/stable IDs.
export const PROTOTYPE_VERSION = 'prompt15-common-noded-partition-v3';
export const CANDIDATES = Object.freeze(['grid', 'adaptive', 'partition']);
// Fixed before source comparison: sub-nanometre numerical representation only.
// No restoration displacement policy or scoring threshold is changed.
export const NUMERICAL_GRID_METRES = 1e-10;
const chartFor = items => {
  const bounds=[Infinity,Infinity,-Infinity,-Infinity];
  for(const item of items) for(const poly of polygons(item.geometry)) for(const ring of poly) for(const p of ring) {
    bounds[0]=Math.min(bounds[0],p[0]);bounds[1]=Math.min(bounds[1],p[1]);bounds[2]=Math.max(bounds[2],p[0]);bounds[3]=Math.max(bounds[3],p[1]);
  }
  if(!Number.isFinite(bounds[0])) return {origin:[0,0],gridMetres:NUMERICAL_GRID_METRES};
  // Translation is representation only; no source clipping/window. Use a
  // deterministic metre origin. A power-of-two precision scales to the ENTIRE
  // chart extent while keeping every scaled coordinate below 2^48.
  const extent=Math.max(bounds[2]-bounds[0],bounds[3]-bounds[1]);
  const absoluteMagnitude=Math.max(...bounds.map(Math.abs));
  const origin=extent<100000&&absoluteMagnitude<100000?[0,0]:[Math.floor((bounds[0]+bounds[2])/2),Math.floor((bounds[1]+bounds[3])/2)];
  const magnitude=Math.max(Math.abs(bounds[0]-origin[0]),Math.abs(bounds[2]-origin[0]),Math.abs(bounds[1]-origin[1]),Math.abs(bounds[3]-origin[1]),1);
  const globalUlp=absoluteMagnitude?2**(Math.ceil(Math.log2(absoluteMagnitude))-52):0;
  const required=Math.max(magnitude/2**48,2*globalUlp);
  const gridMetres=required<=NUMERICAL_GRID_METRES?NUMERICAL_GRID_METRES:2**Math.ceil(Math.log2(required));
  return {origin,gridMetres};
};
const reader = new GeoJSONReader();
const fail = (code, detail) => { throw new Error(`${code}: ${detail}`); };
export const polygons = g => g.type === 'Polygon' ? [g.coordinates] : g.coordinates;
const multi = c => ({type: 'MultiPolygon', coordinates: c});
const cmp = (a, b) => a[0] - b[0] || a[1] - b[1];
const key = p => JSON.stringify(p);
const edgeKey = (a, b) => JSON.stringify(cmp(a, b) < 0 ? [a, b] : [b, a]);
const box = g => {
  const p = polygons(g).flat(2);
  return [Math.min(...p.map(v => v[0])), Math.min(...p.map(v => v[1])),
    Math.max(...p.map(v => v[0])), Math.max(...p.map(v => v[1]))];
};
const intersects = (a, b) => a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];
const rectangle = (x, y, w, h) => [[[x, y], [x+w, y], [x+w, y+h], [x, y+h], [x, y]]];
const union = gs => gs.length ? clipping.union(...gs.map(polygons)) : [];
const ringArea = r => {
  const [ox, oy] = r[0];
  let a = 0;
  for (let i = 1; i < r.length; i++) a += (r[i-1][0]-ox)*(r[i][1]-oy)-(r[i][0]-ox)*(r[i-1][1]-oy);
  return Math.abs(a)/2;
};
export const area = c => c.reduce((s, p) => s + ringArea(p[0]) - p.slice(1).reduce((a, h) => a + ringArea(h), 0), 0);
const valid = g => {
  if (!g || !['Polygon', 'MultiPolygon'].includes(g.type)) fail('INVALID_GEOMETRY', 'polygon required');
  for (const p of polygons(g)) for (const r of p) {
    if (r.length < 4 || r.some(v => v.length !== 2 || v.some(n => !Number.isFinite(n))) || cmp(r[0], r.at(-1))) {
      fail('INVALID_GEOMETRY', 'finite closed 2D rings required');
    }
  }
  const j = reader.read(g);
  if (j.isEmpty() || !new IsValidOp(j).isValid() || !(j.getArea() > 0)) fail('INVALID_GEOMETRY', 'invalid/empty source or cell');
};

/** Fixed floating arithmetic allowance, derived ONLY from input magnitude and
 * vertex count (64 IEEE-754 eps operations per vertex). No fitted tolerance,
 * residual allocation, simplified source, or sliver deletion. */
export function numericalAreaBound(parents) {
  const {origin}=chartFor(parents);
  let magnitude = 1, vertices = 0;
  for (const p of parents) for (const poly of polygons(p.geometry)) for (const ring of poly) for (const v of ring) {
    magnitude = Math.max(magnitude, Math.abs(v[0]-origin[0]), Math.abs(v[1]-origin[1])); vertices++;
  }
  return 64 * Number.EPSILON * magnitude * magnitude * vertices;
}

/** Convex-hull diameter/minimum width. Conservative for nonconvex cells/holes. */
export function shapeMetrics(geometry) {
  const points=[...new Map(polygons(geometry).flat(2).map(p=>[key(p),p])).values()].sort(cmp);
  const cross=(a,b,c)=>(b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0]);
  const half=ps=>{const out=[];for(const p of ps){while(out.length>1&&cross(out.at(-2),out.at(-1),p)<=0)out.pop();out.push(p);}return out;};
  const hull=[...half(points).slice(0,-1),...half([...points].reverse()).slice(0,-1)];
  let diameter=0,width=Infinity;
  for(let i=0;i<hull.length;i++) {
    const a=hull[i],b=hull[(i+1)%hull.length],length=Math.hypot(b[0]-a[0],b[1]-a[1]);
    let w=0;for(const p of hull){diameter=Math.max(diameter,Math.hypot(p[0]-a[0],p[1]-a[1]));w=Math.max(w,Math.abs(cross(a,b,p))/length);}width=Math.min(width,w);
  }
  return {areaKm2:area(polygons(geometry))/1e6,diameterKm:diameter/1000,aspectRatio:diameter/width};
}

// Immutable AABB hierarchy. Nearest queries are exact (box distances only prune
// branches whose lower bound already exceeds an actual segment distance).
const distanceToSegment=(p,[a,b])=>{
  const dx=b[0]-a[0],dy=b[1]-a[1],d=dx*dx+dy*dy;
  const t=d?Math.max(0,Math.min(1,((p[0]-a[0])*dx+(p[1]-a[1])*dy)/d)):0;
  return Math.hypot(p[0]-a[0]-t*dx,p[1]-a[1]-t*dy);
};
export function segmentIndex(segments) {
  const build=items=>{
    const bounds=[Infinity,Infinity,-Infinity,-Infinity];
    for(const item of items)for(const p of item) {bounds[0]=Math.min(bounds[0],p[0]);bounds[1]=Math.min(bounds[1],p[1]);bounds[2]=Math.max(bounds[2],p[0]);bounds[3]=Math.max(bounds[3],p[1]);}
    if(items.length<=12)return {bounds,items};
    const axis=bounds[2]-bounds[0]>=bounds[3]-bounds[1]?0:1;
    items.sort((a,b)=>a[0][axis]+a[1][axis]-b[0][axis]-b[1][axis]);
    const mid=items.length>>1;return {bounds,left:build(items.slice(0,mid)),right:build(items.slice(mid))};
  };
  const tree=build([...segments]);
  const lower=(p,b)=>Math.hypot(Math.max(b[0]-p[0],0,p[0]-b[2]),Math.max(b[1]-p[1],0,p[1]-b[3]));
  return {distance(p){
    let best=Infinity;
    const visit=node=>{
      if(lower(p,node.bounds)>best)return;
      if(node.items){for(const s of node.items)best=Math.min(best,distanceToSegment(p,s));return;}
      const a=lower(p,node.left.bounds),b=lower(p,node.right.bounds);
      if(a<=b){visit(node.left);visit(node.right);}else{visit(node.right);visit(node.left);}
    };visit(tree);return best;
  }};
}

function mergeBoundarySlivers(parents,common,{reconstruct=false}={}) {
  const cells=new Map(common.cells.map(c=>[c.ordinal,c])),adj=new Map(common.cells.map(c=>[c.ordinal,new Map()]));
  for(const e of common.edges) if(e.sides.length===2) {
    const [a,b]=e.sides.map(s=>s.ordinal);
    if(cells.get(a).parentKey!==cells.get(b).parentKey) continue;
    adj.get(a).set(b,(adj.get(a).get(b)??0)+e.lengthMetres);adj.get(b).set(a,(adj.get(b).get(a)??0)+e.lengthMetres);
  }
  const metrics=new Map([...cells].map(([i,c])=>[i,shapeMetrics(c.geometry)]));
  const bad=m=>m.areaKm2<policy.physical.sliverAreaBelowKm2||m.aspectRatio>policy.physical.maxAspectRatio*(reconstruct?.99:1);
  const trace=[];
  for(const id of [...cells.keys()]) {
    if(!cells.has(id)||!bad(metrics.get(id))) continue;
    const choices=[...adj.get(id)].filter(([j])=>cells.has(j)).sort((a,b)=>b[1]-a[1]||a[0]-b[0]);
    for(const [other,sharedLengthMetres] of choices) {
      const geometry=multi(clipping.union(polygons(cells.get(id).geometry),polygons(cells.get(other).geometry))),m=shapeMetrics(geometry);
      // 0.5% metric-error guard, never an increase in the immutable 15-12 limits.
      if(m.areaKm2>policy.physical.interior.maxAreaKm2*.99||m.diameterKm>policy.physical.interior.maxDiameterKm*.995||
        m.aspectRatio>policy.physical.maxAspectRatio*.99||polygons(geometry).length!==1) continue;
      const target=Math.min(id,other),removed=Math.max(id,other),a=cells.get(id),b=cells.get(other);
      cells.set(target,{...cells.get(target),geometry});cells.delete(removed);metrics.set(target,m);metrics.delete(removed);
      const neighbours=new Map();
      for(const current of [id,other]) for(const [n,len] of adj.get(current)) if(n!==id&&n!==other&&cells.has(n)) neighbours.set(n,(neighbours.get(n)??0)+len);
      for(const n of neighbours.keys()){adj.get(n).delete(id);adj.get(n).delete(other);adj.get(n).set(target,neighbours.get(n));}
      adj.set(target,neighbours);adj.delete(removed);
      trace.push({kept:target,removed,sharedLengthMetres,parentKey:a.parentKey,beforeAreaKm2:metrics.get(removed)?.areaKm2??area(polygons(b.geometry))/1e6,after:m});
      break;
    }
  }
  if(reconstruct) {
    // A merge alone cannot rescue a boundary fragment beside a full-sized
    // neighbour. Reconstruct their complete local union, moving ONLY internal
    // edges. Both output pieces must satisfy every unchanged physical bound.
    // No parent/component/hole boundary is moved or residual area assigned.
    let next=Math.max(...cells.keys())+1;
    const good=g=>{const m=shapeMetrics(g);return polygons(g).length===1&&m.areaKm2>=policy.physical.sliverAreaBelowKm2&&
      m.areaKm2<=policy.physical.interior.maxAreaKm2*.99&&m.diameterKm<=policy.physical.interior.maxDiameterKm*.995&&m.aspectRatio<=policy.physical.maxAspectRatio*.99;};
    for(let pass=0;pass<2;pass++) {
      if(![...cells].some(([id,c])=>bad(metrics.get(id)??shapeMetrics(c.geometry))))break;
      const topology=nodeCommonBoundaries(parents,[...cells.values()]);
      const neighbours=new Map([...cells.keys()].map(i=>[i,new Map()]));
      for(const e of topology.edges)if(e.sides.length===2){const[a,b]=e.sides.map(s=>s.ordinal);
        if(cells.get(a).parentKey!==cells.get(b).parentKey)continue;
        neighbours.get(a).set(b,(neighbours.get(a).get(b)??0)+e.lengthMetres);neighbours.get(b).set(a,(neighbours.get(b).get(a)??0)+e.lengthMetres);}
      for(const id of [...cells.keys()]) {
        if(!cells.has(id)||!bad(shapeMetrics(cells.get(id).geometry)))continue;
        const ns=[...neighbours.get(id)].filter(([j])=>cells.has(j)).sort((a,b)=>b[1]-a[1]||a[0]-b[0]);
        let replacement=null;
        const patches=[];
        for(const [other]of ns.slice(0,6)) {
          patches.push([id,other]);
          for(const [extra]of ns.slice(0,6))if(extra>other)patches.push([id,other,extra]);
        }
        for(const patchIds of patches) {
          const patch=multi(union(patchIds.map(i=>cells.get(i).geometry)));
          const bounds=box(patch),pad=1+Math.max(bounds[2]-bounds[0],bounds[3]-bounds[1]);
          for(const axis of [0,1])for(const ratio of [.5,.35,.65,.25,.75]) {
            const cut=bounds[axis]+(bounds[axis+2]-bounds[axis])*ratio;
            const rect=axis===0?rectangle(bounds[0]-pad,bounds[1]-pad,cut-bounds[0]+pad,bounds[3]-bounds[1]+2*pad):
              rectangle(bounds[0]-pad,bounds[1]-pad,bounds[2]-bounds[0]+2*pad,cut-bounds[1]+pad);
            const left=clipping.intersection(polygons(patch),[rect]),right=clipping.difference(polygons(patch),[rect]);
            const pieces=[...left,...right].map(p=>({type:'Polygon',coordinates:p}));
            if(pieces.length<2||pieces.length>3||!pieces.every(good))continue;
            // Independently certify the local replacement before publishing it.
            if(area(clipping.xor(polygons(patch),union(pieces)))>numericalAreaBound(parents))continue;
            const score=Math.max(...pieces.map(g=>shapeMetrics(g).aspectRatio));
            if(!replacement||score<replacement.score)replacement={patchIds,pieces,score,axis,ratio};
          }
          if(replacement)break;
        }
        if(!replacement)continue;
        const template=cells.get(id);for(const removed of replacement.patchIds){cells.delete(removed);metrics.delete(removed);}
        for(const geometry of replacement.pieces){metrics.set(next,shapeMetrics(geometry));cells.set(next,{...template,ordinal:next++,geometry});}
        trace.push({treatment:'same-parent-local-repartition',removed:replacement.patchIds,parentKey:template.parentKey,
          axis:replacement.axis,ratio:replacement.ratio,pieces:replacement.pieces.length,maxAspect:replacement.score});
      }
    }
  }
  const normalized=[...cells.values()].sort((a,b)=>a.ordinal-b.ordinal).map((c,ordinal)=>({...c,ordinal}));
  return {...nodeCommonBoundaries(parents,normalized),mergeTrace:trace};
}

/** Bounded local reconstruction experiment for an already complete protected
 * arrangement. This entry point also permits independent negative fixtures;
 * the input and output unions are audited, not trusted from supplied metrics. */
export function reconstructBoundaryCells(parents,cells) {
  auditPartition(parents,cells);
  const result=mergeBoundarySlivers(parents,nodeCommonBoundaries(parents,cells),{reconstruct:true});
  return {...result,audit:auditPartition(parents,result.cells)};
}

function checkParents(parents) {
  if (!Array.isArray(parents) || !parents.length || parents.length > 4096) fail('INPUT_LIMIT', '1..4096 protected faces required');
  const keys = new Set();
  for (const p of parents) {
    if (typeof p.key !== 'string' || !p.key || keys.has(p.key) || !/^[A-Z][A-Z0-9]{2}$/.test(p.sourceCountryId) ||
      !p.administrativeParent || !p.previousGeometryParent) fail('INVALID_PARENT', 'unique face key and both immutable parents required');
    keys.add(p.key); valid(p.geometry);
  }
  const eps = numericalAreaBound(parents);
  for (let i = 0; i < parents.length; i++) for (let j = 0; j < i; j++) {
    if (area(clipping.intersection(polygons(parents[i].geometry), polygons(parents[j].geometry))) > eps) {
      fail('AMBIGUOUS_PARENT', `${parents[i].key}/${parents[j].key}`);
    }
  }
}

/** Checks candidate geometry independently of its claimed metrics/edge index.
 * Works on arbitrary candidate cells, including deliberately corrupted outputs. */
export function auditPartition(parents, cells) {
  checkParents(parents);
  if (!Array.isArray(cells) || !cells.length || cells.length > policy.budget.countryCells) fail('INPUT_LIMIT', 'country cell budget exceeded; no truncation');
  // Reject malformed coordinates before they reach the numerical noder; a
  // NaN must remain INVALID_GEOMETRY, not an unrelated topology exception.
  for(const c of cells)valid(c.geometry);
  // Compare on the SAME numerical arrangement. Independently overlaying almost
  // coincident unsplit source edges reintroduces a floating micro-gap. Certify
  // every noded source position continuously against its original segment.
  const originalParents=parents;
  const originalAreaBound=numericalAreaBound(parents);
  const normalized=nodeCommonBoundaries(parents,cells,{linesOnly:true});
  parents=normalized.parents; cells=normalized.cells;
  let maximumSourceSegmentDisplacementMetres=0;
  for(let i=0;i<parents.length;i++) for(let p=0;p<polygons(parents[i].geometry).length;p++) {
    for(let r=0;r<polygons(parents[i].geometry)[p].length;r++) {
      const originalRing=polygons(originalParents[i].geometry)[p][r],nodedRing=polygons(parents[i].geometry)[p][r];
      for(const [positions,raw] of [[nodedRing,originalRing],[originalRing,nodedRing]]) {
        const index=segmentIndex(raw.slice(1).map((p,i)=>[raw[i],p]));
        for(const point of positions) {
        const distance=index.distance(point);
        maximumSourceSegmentDisplacementMetres=Math.max(maximumSourceSegmentDisplacementMetres,distance);
        }
      }
    }
  }
  if(maximumSourceSegmentDisplacementMetres>4*normalized.numericalModel.gridMetres) fail('SOURCE_BOUNDARY_MOVED','numerical segment correspondence exceeded');
  const eps = originalAreaBound, byKey = new Map(parents.map(p => [p.key, p]));
  const componentBoxes=new Map(parents.map(p=>[p.key,polygons(p.geometry).map(poly=>({poly,bounds:box({type:'Polygon',coordinates:poly})}))]));
  const bands=new Map(),windows=new Map(),parentBounds=new Map(parents.map(p=>[p.key,box(p.geometry)]));
  const sourceWindow=(parent,bounds)=>{
    const unit=10000,x0=Math.floor(bounds[0]/unit)*unit,y0=Math.floor(bounds[1]/unit)*unit;
    const x1=(Math.floor(bounds[2]/unit)+1)*unit,y1=(Math.floor(bounds[3]/unit)+1)*unit;
    const wk=JSON.stringify([parent.key,x0,y0,x1,y1]);if(windows.has(wk))return windows.get(wk);
    const bk=JSON.stringify([parent.key,y0,y1]);
    if(!bands.has(bk)){
      const pb=parentBounds.get(parent.key),input=componentBoxes.get(parent.key).filter(c=>c.bounds[1]<=y1&&c.bounds[3]>=y0).map(c=>c.poly);
      bands.set(bk,input.length?clipping.intersection(input,[rectangle(pb[0]-1,y0,pb[2]-pb[0]+2,y1-y0)]):[]);
    }
    const band=bands.get(bk),value=band.length?clipping.intersection(band,[rectangle(x0,y0,x1-x0,y1-y0)]):[];
    windows.set(wk,value);return value;
  };
  const ordinals = new Set(), boxes = [];
  for (const c of cells) {
    valid(c.geometry);
    const p = byKey.get(c.parentKey);
    if (!p || ordinals.has(c.ordinal)) fail('UNKNOWN_OR_DUPLICATE_CELL', String(c.ordinal));
    ordinals.add(c.ordinal);
    if (c.sourceCountryId !== p.sourceCountryId || JSON.stringify(c.administrativeParent) !== JSON.stringify(p.administrativeParent) ||
      JSON.stringify(c.previousGeometryParent) !== JSON.stringify(p.previousGeometryParent)) fail('PARENT_SUBSTITUTION', c.parentKey);
    const bounds=box(c.geometry),near=sourceWindow(p,bounds);
    if (area(clipping.difference(polygons(c.geometry), near)) > eps) fail('CROSS_BORDER_OR_HOLE', c.parentKey);
    boxes.push(bounds);
  }
  const sweep=cells.map((c,i)=>i).sort((i,j)=>boxes[i][0]-boxes[j][0]||i-j);
  for (let a = 0; a < sweep.length; a++) for (let b = a+1; b < sweep.length && boxes[sweep[b]][0]<boxes[sweep[a]][2]; b++) {
    const i=sweep[a],j=sweep[b];
    if (intersects(boxes[i], boxes[j]) && area(clipping.intersection(polygons(cells[i].geometry), polygons(cells[j].geometry))) > eps) {
      fail('OVERLAP', `${cells[i].ordinal}/${cells[j].ordinal}`);
    }
  }
  const correspondence = [];
  const cellBoxes=new Map(cells.map((c,i)=>[c,boxes[i]]));
  for (const p of parents) {
    const children = cells.filter(c => c.parentKey === p.key);
    if (!children.length) fail('COMPONENT_LOSS', p.key);
    const merged = union(children.map(c => c.geometry));
    // Explicit per-component witness prevents even a tiny disconnected island
    // from disappearing inside a global area allowance.
    for (const [i, component] of polygons(p.geometry).entries()) {
      const cb=componentBoxes.get(p.key)[i].bounds;
      if (!children.some(c => intersects(cellBoxes.get(c),cb)&&area(clipping.intersection(polygons(c.geometry), [component])) > 0)) fail('COMPONENT_LOSS', `${p.key}/${i}`);
    }
    const gap = area(clipping.difference(polygons(p.geometry), merged));
    const excess = area(clipping.difference(merged, polygons(p.geometry)));
    if (gap > eps) fail('GAP', p.key);
    if (excess > eps) fail('CROSS_BORDER_OR_HOLE', p.key);
    const holes = polygons(p.geometry).reduce((n, poly) => n + poly.length - 1, 0);
    // Union must reconstruct source topology, not merely its area/count of IDs.
    if (merged.length !== polygons(p.geometry).length) fail('COMPONENT_LOSS', p.key);
    if (merged.reduce((n, poly) => n + poly.length - 1, 0) !== holes) fail('HOLE_LOSS', p.key);
    correspondence.push({parentKey: p.key, components: merged.length, holes, cells: children.length, gapAreaM2: gap, excessAreaM2: excess});
  }
  return {numericalAreaBoundM2: eps,maximumSourceSegmentDisplacementMetres, correspondence};
}

/** Node ALL cell rings and protected parent rings together on one fixed
 * numerical grid, with original input geometry independently rechecked.
 * JTS inserts T-junctions and overlapping collinear endpoints into both sides.
 * Both sides then reference precisely the same positive-length edge bytes. */
export function nodeCommonBoundaries(parents, candidateCells, {linesOnly = false} = {}) {
  const cells = structuredClone(candidateCells), nodedParents = structuredClone(parents);
  // Overlay unions and polygonizer rings use different winding conventions.
  // Normalize winding before pairing directed half-edges; geometry is unchanged.
  for(const cell of cells) for(const poly of polygons(cell.geometry)) for(let r=0;r<poly.length;r++) {
    const ring=poly[r],base=ring[0];let signed=0;
    for(let i=1;i<ring.length;i++) signed+=(ring[i-1][0]-base[0])*(ring[i][1]-base[1])-(ring[i][0]-base[0])*(ring[i-1][1]-base[1]);
    if((r===0&&signed<0)||(r>0&&signed>0)) poly[r].reverse();
  }
  const strings = new ArrayList();
  const chart=chartFor([...parents,...candidateCells]);
  const pm = new PrecisionModel(1/chart.gridMetres);
  let maximumRoundedDisplacementMetres = 0;
  for (const [role, items] of [['parent', nodedParents], ['cell', cells]]) for (const [index, item] of items.entries()) {
    for (const poly of polygons(item.geometry)) for (let r = 0; r < poly.length; r++) {
      const coordinates = poly[r].map(v => {
        const c = new Coordinate(v[0]-chart.origin[0],v[1]-chart.origin[1]); pm.makePrecise(c);
        maximumRoundedDisplacementMetres = Math.max(maximumRoundedDisplacementMetres,Math.hypot(c.x+chart.origin[0]-v[0],c.y+chart.origin[1]-v[1]));
        return c;
      });
      strings.add(new NodedSegmentString(coordinates, {role, index, poly, r}));
    }
  }
  const noder = new MCIndexSnapRounder(pm);
  noder.computeNodes(strings);
  for (const it = strings.iterator(); it.hasNext();) {
    const ss = it.next(), d = ss.getData();
    d.poly[d.r] = ss.getNodeList().getSplitCoordinates().map(c => [pm.makePrecise(c.x)+chart.origin[0], pm.makePrecise(c.y)+chart.origin[1]])
      .filter((p,i,a)=>i===0||cmp(p,a[i-1])!==0);
  }
  const numericalModel={gridMetres:chart.gridMetres,chartOriginMetres:chart.origin,
    maximumRoundedDisplacementMetres,maximumCoordinateMagnitudeMetres:2**48*chart.gridMetres,
    scope:'numerical representation only; original parent unions are independently audited'};
  if(linesOnly) return {parents:nodedParents,cells,numericalModel};
  const edges = new Map();
  for (const [i, c] of cells.entries()) for (const poly of polygons(c.geometry)) for (const ring of poly) {
    for (let j = 1; j < ring.length; j++) {
      const a = ring[j-1], b = ring[j];
      if (!cmp(a, b)) continue;
      const k = edgeKey(a, b), e = edges.get(k) ?? {coordinates: cmp(a,b)<0 ? [a,b] : [b,a], sides: []};
      e.sides.push({ordinal: c.ordinal, direction: cmp(a,b)<0 ? 1 : -1, cellIndex: i}); edges.set(k,e);
    }
  }
  const result = [...edges.entries()].sort(([a],[b]) => a < b ? -1 : a > b ? 1 : 0).map(([,e]) => {
    if (e.sides.length > 2 || (e.sides.length === 2 && e.sides[0].direction === e.sides[1].direction)) fail('UNPAIRED_EDGE', key(e.coordinates));
    const [a,b] = e.coordinates;
    return {...e, lengthMetres: Math.hypot(a[0]-b[0],a[1]-b[1]), boundary: e.sides.length === 2 ? {
      country: cells[e.sides[0].cellIndex].sourceCountryId !== cells[e.sides[1].cellIndex].sourceCountryId,
      administrative: JSON.stringify(cells[e.sides[0].cellIndex].administrativeParent) !== JSON.stringify(cells[e.sides[1].cellIndex].administrativeParent),
      previous: JSON.stringify(cells[e.sides[0].cellIndex].previousGeometryParent) !== JSON.stringify(cells[e.sides[1].cellIndex].previousGeometryParent),
    } : {external: true}};
  });
  return {parents: nodedParents, cells, edges: result,numericalModel};
}

function polygonizeCommonArrangement(parents,cutters) {
  const noded=nodeCommonBoundaries(parents,cutters,{linesOnly:true});
  const segments=new Map(),polygonizer=new Polygonizer(),writer=new GeoJSONWriter(),locator=new PointLocator();
  for(const item of [...noded.parents,...noded.cells]) for(const poly of polygons(item.geometry)) for(const ring of poly) {
    for(let i=1;i<ring.length;i++) if(cmp(ring[i-1],ring[i])) segments.set(edgeKey(ring[i-1],ring[i]),[ring[i-1],ring[i]]);
  }
  for(const [,coordinates] of [...segments.entries()].sort(([a],[b])=>a<b?-1:a>b?1:0)) {
    polygonizer.add(reader.read({type:'LineString',coordinates}));
  }
  const source=noded.parents.map(p=>({p,geometry:reader.read(p.geometry)})),cells=[];
  for(const it=polygonizer.getPolygons().iterator();it.hasNext();) {
    const face=it.next(),point=InteriorPointArea.getInteriorPoint(face);
    const members=source.filter(s=>locator.locate(point,s.geometry)!==2);
    if(!members.length) continue; // outside all protected polygons, including source holes
    if(members.length!==1) fail('AMBIGUOUS_FACE','no residual/nearest-parent assignment permitted');
    const parent=members[0].p;
    cells.push({ordinal:cells.length,parentKey:parent.key,sourceCountryId:parent.sourceCountryId,
      administrativeParent:parent.administrativeParent,previousGeometryParent:parent.previousGeometryParent,
      geometry:writer.write(face)});
  }
  if(!polygonizer.getInvalidRingLines().isEmpty()) fail('UNRESOLVED_ARRANGEMENT','invalid common face ring');
  // Reintroduce every original source vertex as a protected node, including
  // collinear degree-two vertices that polygonization may omit from face rings.
  const result=nodeCommonBoundaries(parents,cells);
  result.numericalModel.maximumRoundedDisplacementMetres=Math.max(result.numericalModel.maximumRoundedDisplacementMetres,noded.numericalModel.maximumRoundedDisplacementMetres);
  return result;
}

export function generatePartition(parents, {candidate = 'grid', sizeMetres = 5000, origin = [0,0],boundaryBandMetres=5000,
  implementation='indexed-reconstruction',onStage=()=>{}} = {}) {
  let started=performance.now();
  const stage=(name,counts={})=>{const now=performance.now();onStage({name,elapsedMs:now-started,...counts});started=now;};
  checkParents(parents);
  stage('validate-parents');
  if (!CANDIDATES.includes(candidate) || !Number.isFinite(sizeMetres) || sizeMetres < 100 || sizeMetres > 5000 ||
    !Array.isArray(origin) || origin.length !== 2 || origin.some(n => !Number.isFinite(n)) || !Number.isFinite(boundaryBandMetres)||boundaryBandMetres<0||boundaryBandMetres>15000) fail('INVALID_CANDIDATE', 'bounded metric lattice required');
  const sorted = structuredClone(parents).sort((a,b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
  if(!['indexed-reconstruction','reference-v2'].includes(implementation))fail('INVALID_CANDIDATE','unknown implementation');
  const reference=implementation==='reference-v2',cutters = new Map();
  let attempted = 0;
  for (const parent of sorted) {
    const b = box(parent.geometry), coarse = candidate === 'adaptive' ? sizeMetres*2 : sizeMetres;
    const sourceSegments=polygons(parent.geometry).flatMap(p=>p.flatMap(r=>r.slice(1).map((v,i)=>[r[i],v])));
    const boundaryIndex=reference?null:segmentIndex(sourceSegments);
    const nearBoundary=(x,y,w,h)=>!reference?boundaryIndex.distance([x+w/2,y+h/2])<=boundaryBandMetres+Math.hypot(w,h)/2:sourceSegments.some(([a,b])=>{
      const p=[x+w/2,y+h/2],dx=b[0]-a[0],dy=b[1]-a[1],d=dx*dx+dy*dy,t=d?Math.max(0,Math.min(1,((p[0]-a[0])*dx+(p[1]-a[1])*dy)/d)):0;
      return Math.hypot(p[0]-a[0]-t*dx,p[1]-a[1]-t*dy)<=boundaryBandMetres+Math.hypot(w,h)/2;
    });
    const visit = (x,y,w,h,level=0,input=polygons(parent.geometry)) => {
      if (++attempted > policy.budget.countryCells*8) fail('PROTOTYPE_LIMIT', 'country budget exceeded; no truncation');
      const rect = rectangle(x,y,w,h), clipped = clipping.intersection(reference?polygons(parent.geometry):input, [rect]);
      if (!clipped.length) return;
      // Deterministic quadtree: refine every coarse square to physical maximum,
      // and boundary squares one extra level. Common noding resolves T-junctions.
      if ((candidate === 'adaptive' && (w > sizeMetres || (level === 1 && area(clipped) < w*h))) ||
        (candidate === 'partition'&&w>sizeMetres/2&&nearBoundary(x,y,w,h))) {
        for (const [dx,dy] of [[0,0],[1,0],[0,1],[1,1]]) visit(x+dx*w/2,y+dy*h/2,w/2,h/2,level+1,clipped);
        return;
      }
      // Clipping above decides deterministic refinement only. Candidate cells
      // are extracted ONCE from the complete common line arrangement below.
      cutters.set(JSON.stringify(rect),{geometry:{type:'Polygon',coordinates:rect}});
    };
    // Partition refines a metric boundary band and later merges only within a
    // protected parent. Interior grid squares retain the lower decode cost.
    const height = coarse;
    for (let y = Math.floor((b[1]-origin[1])/height)*height+origin[1]; y < b[3]; y += height) {
      // Clip a whole row once, then reuse that immutable intermediate for all
      // its tiles and recursively pass only the clipped local parent pieces.
      const row=reference?null:clipping.intersection(polygons(parent.geometry),[rectangle(b[0]-1,y,b[2]-b[0]+2,height)]);
      if(!reference&&!row.length)continue;
      for (let x = Math.floor((b[0]-origin[0])/coarse)*coarse+origin[0]; x < b[2]; x += coarse) visit(x,y,coarse,height,0,row??polygons(parent.geometry));
    }
  }
  stage('local-clipping',{attempted,cutters:cutters.size});
  // Extract faces in the shared arrangement. Publishing independently clipped
  // tile polygons creates opposite one-ulp cuts at source crossings; those are
  // rejected rather than hidden by widening numerical tolerances.
  const initial = polygonizeCommonArrangement(sorted,[...cutters.values()]);
  stage('common-arrangement',{cells:initial.cells.length,edges:initial.edges.length});
  const common = candidate==='partition'?mergeBoundarySlivers(sorted,initial,{reconstruct:!reference}):initial;
  stage('boundary-quality',{cells:common.cells.length,reconstructions:common.mergeTrace?.filter(t=>t.treatment).length??0});
  const audit = auditPartition(sorted, common.cells); // original parents, never self-certified moved boundaries
  stage('independent-audit');
  const areas = common.cells.map(c => area(polygons(c.geometry))/1e6);
  const small = areas.filter(a => a < policy.physical.sliverAreaBelowKm2);
  const total = areas.reduce((a,b)=>a+b,0);
  const slivers = {treatment:candidate==='partition'?'positive-edge same-parent bounded merge; unresolved cells retained and rejected':'retain-and-reject-policy-excess; no merge, drop or residual assignment',
    ordinals:common.cells.filter((c,i)=>areas[i]<policy.physical.sliverAreaBelowKm2).map(c=>c.ordinal),
    countFraction:small.length/areas.length, areaFraction:small.reduce((a,b)=>a+b,0)/total};
  slivers.eligible = slivers.countFraction <= policy.physical.maxSliverCountFraction && slivers.areaFraction <= policy.physical.maxSliverAreaFraction;
  const result={version:1,kind:'offline-partition-prototype',generator:PROTOTYPE_VERSION,policyIdentity,candidate,
    lattice:{unit:'metre',sizeMetres,origin,boundaryBandMetres:candidate==='partition'?boundaryBandMetres:0},...common,audit,slivers,
    physicalUpperBounds:candidate==='partition'?{diameterKm:Math.max(...common.cells.map(c=>shapeMetrics(c.geometry).diameterKm)),areaKm2:Math.max(...areas)}:
      {diameterKm:Math.hypot(sizeMetres,sizeMetres)/1000,areaKm2:sizeMetres*sizeMetres/1e6},
    approval:'none; representative comparison, stable IDs and production generation are later tasks'};
  stage('physical-metrics');return result;
}
