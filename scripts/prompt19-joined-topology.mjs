import GeoJSONReader from 'jsts/org/locationtech/jts/io/GeoJSONReader.js';
import InteriorPointArea from 'jsts/org/locationtech/jts/algorithm/InteriorPointArea.js';
import PointLocator from 'jsts/org/locationtech/jts/algorithm/PointLocator.js';
import {canonical, hashCanonical, polygons} from './prompt14-catalog-core.mjs';

const cmp = (a,b) => a[0]-b[0] || a[1]-b[1];
const pk = p => `${p[0]},${p[1]}`;
const ek = (a,b) => cmp(a,b)<0 ? `${pk(a)};${pk(b)}` : `${pk(b)};${pk(a)}`;
export const globalCellId = cell => `territory:catalog:${hashCanonical('prompt19-global-cell.v1', cell.id)}`;
export function joinedTopology(result) {
  const reader = new GeoJSONReader(), locator = new PointLocator(), groups = new Map(), segments = new Map();
  for (const cell of result.cells) {
    const list = groups.get(cell.properties.arrangementGroup) ?? [];
    list.push({cell, g: reader.read(cell.geometry)}); groups.set(cell.properties.arrangementGroup,list);
  }
  let faceCount=0;
  for (const face of result.faces) {
    let id;
    if (face.neighbor) id=face.parent.feature.properties.coarseTerritoryId;
    else {
      const point=face.point ?? InteriorPointArea.getInteriorPoint(face.polygon);
      const matches=(groups.get(face.group) ?? []).filter(c=>locator.locate(point,c.g)===0);
      if(matches.length!==1) throw Error(`FACE_CELL_MEMBERSHIP:${face.countryId}:${matches.length}`);
      id=globalCellId(matches[0].cell); faceCount++;
    }
    for(const poly of polygons(face.geometry)) for(const ring of poly) for(let i=1;i<ring.length;i++) {
      const a=ring[i-1],b=ring[i],key=ek(a,b),e=segments.get(key)??{a:cmp(a,b)<0?a:b,b:cmp(a,b)<0?b:a,left:[],right:[],countries:new Set()};
      const side=cmp(a,b)<0?e.left:e.right; if(!side.includes(id))side.push(id);
      e.countries.add(face.countryId);segments.set(key,e);
    }
  }
  const byCell=new Map(result.cells.map(c=>[globalCellId(c),c.properties.countryId]));
  const groupsByPair=new Map(); let p0Segments=0,coveredP0Segments=0,unusedSourceSegments=0;
  for(const [key,e]of result.segments) if(e.p0.length){p0Segments++;if(segments.has(key))coveredP0Segments++;}
  if(p0Segments!==coveredP0Segments)throw Error(`P0_COVERAGE:${coveredP0Segments}/${p0Segments}`);
  for(const e of segments.values()) {
    if(e.left.length>1||e.right.length>1)throw Error('AMBIGUOUS_FACE_EDGE');
    let left=e.left[0]??null,right=e.right[0]??null;
    if(left===right)continue;
    if(!byCell.has(left)&&!byCell.has(right)){unusedSourceSegments++;continue;}
    // Every one-sided edge of the joint face partition must be an immutable P0 coastline.
    const original=result.segments.get(ek(e.a,e.b));
    if((!left||!right)&&!original?.p0.length)throw Error('UNPAIRED_INTERIOR_FACE_EDGE');
    const countries=[...e.countries];
    const boundaryClass=!left||!right?'coast':countries.length>1?'country':'administrative';
    if(!left){[left,right]=[right,left];[e.a,e.b]=[e.b,e.a];}
    const key=canonical([[left,right].sort(),boundaryClass]);
    const group=groupsByPair.get(key)??{boundaryClass,segments:[]};group.segments.push({...e,left,right});groupsByPair.set(key,group);
  }
  const edges=[];
  for(const group of groupsByPair.values()) {
    const byPoint=new Map(),seen=new Set();
    group.segments.forEach((e,i)=>{for(const p of[e.a,e.b]){const list=byPoint.get(pk(p))??[];list.push(i);byPoint.set(pk(p),list);}});
    const walk=(start,index)=>{
      const coordinates=[start];let current=start,first=null;
      while(!seen.has(index)) {
        seen.add(index);const e=group.segments[index],forward=cmp(current,e.a)===0,next=forward?e.b:e.a;
        const sides=forward?[e.left,e.right]:[e.right,e.left];
        if(!first)first=sides;else if(first[0]!==sides[0]||first[1]!==sides[1])throw Error('INCONSISTENT_FACE_CHAIN');
        coordinates.push(next);current=next;const incident=byPoint.get(pk(current));if(incident.length!==2)break;
        const nextIndex=incident.find(i=>!seen.has(i));if(nextIndex===undefined)break;index=nextIndex;
      }
      if(!first[0]){coordinates.reverse();first.reverse();}
      const geometry={type:'LineString',coordinates};
      const record={leftTerritoryId:first[0],rightTerritoryId:first[1],boundaryClass:group.boundaryClass,geometry};
      edges.push({id:`edge:operational:${hashCanonical('prompt19-joined-edge.v1',record)}`,...record});
    };
    for(const[key,indices]of byPoint)if(indices.length!==2)for(const i of indices)if(!seen.has(i))walk(key.split(',').map(Number),i);
    for(let i=0;i<group.segments.length;i++)if(!seen.has(i))walk(group.segments[i].a,i);
  }
  edges.sort((a,b)=>a.id.localeCompare(b.id));
  return {edges,evidence:{pass:true,faceCount,p0Segments,coveredP0Segments,unusedNeighborSegments:unusedSourceSegments,
    edges:edges.length,ambiguousSides:0,unpairedInteriorBoundaries:0,completeBoundaryCoverage:true,
    method:'Edges from the same exact polygonized faces as country cells; no independent clipping or global union.'}};
}
