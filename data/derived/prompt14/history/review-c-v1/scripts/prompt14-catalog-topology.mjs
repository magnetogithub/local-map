import Coordinate from 'jsts/org/locationtech/jts/geom/Coordinate.js';
import RobustLineIntersector from 'jsts/org/locationtech/jts/algorithm/RobustLineIntersector.js';
import MCIndexNoder from 'jsts/org/locationtech/jts/noding/MCIndexNoder.js';
import IntersectionAdder from 'jsts/org/locationtech/jts/noding/IntersectionAdder.js';
import NodedSegmentString from 'jsts/org/locationtech/jts/noding/NodedSegmentString.js';
import ArrayList from 'jsts/java/util/ArrayList.js';
import STRtree from 'jsts/org/locationtech/jts/index/strtree/STRtree.js';
import Envelope from 'jsts/org/locationtech/jts/geom/Envelope.js';
import {canonical, compareText, hashCanonical, normalizeGeometry, polygons} from './prompt14-catalog-core.mjs';

const pointKey=p=>`${p[0]},${p[1]}`;
const pointCompare=(a,b)=>a[0]-b[0]||a[1]-b[1];
const segmentKey=(a,b)=>`${pointKey(a)};${pointKey(b)}`;
export const territoryIdForAtom=key=>`territory:catalog:${hashCanonical('catalog-territory-id.v1',{canonicalAtomKey:key})}`;

// Robust indexed noding changes only the offline line decomposition, never atom coordinates.
// P0 coast/country rings are noded in the same pass, providing an independent boundary certificate.
export function buildCatalogTopology(atoms,p0,onProgress=()=>{}) {
  const strings=new ArrayList(); let sourceSegments=0;
  const add=(geometry,data)=>{for(const polygon of polygons(geometry))for(const ring of polygon){
    strings.add(new NodedSegmentString(ring.map(([x,y])=>new Coordinate(x,y)),data));sourceSegments+=ring.length-1;
  }};
  atoms.forEach((a,i)=>add(a.geometry,{territory:i,country:a.identity.sourceCountryId}));
  p0.features.forEach(f=>add(normalizeGeometry(f.geometry),{p0:f.properties.countryId}));
  const intersector=new IntersectionAdder(new RobustLineIntersector()), noder=new MCIndexNoder(intersector);
  onProgress(`noding ${sourceSegments} territory/P0 boundary segments`); noder.computeNodes(strings);
  onProgress('collecting noded boundary sides');
  const segments=new Map(); let occurrences=0;
  for(const it=noder.getNodedSubstrings().iterator();it.hasNext();){
    const ss=it.next(), coordinates=ss.getCoordinates(),data=ss.getData();
    for(let j=1;j<coordinates.length;j++){
      let a=[coordinates[j-1].x,coordinates[j-1].y],b=[coordinates[j].x,coordinates[j].y];
      if(pointCompare(a,b)===0)continue;
      // The +/-180 meridian is a single physical seam; other source doubles remain exact.
      if(a[0]===180&&b[0]===180){a=[-180,a[1]];b=[-180,b[1]];}
      const forward=pointCompare(a,b)<0;if(!forward)[a,b]=[b,a];
      const key=segmentKey(a,b),entry=segments.get(key)??{a,b,left:[],right:[],p0:[]};
      if(data.p0){if(!entry.p0.includes(data.p0))entry.p0.push(data.p0);}
      else {const sides=forward?entry.left:entry.right;if(!sides.includes(data.territory))sides.push(data.territory);occurrences++;}
      segments.set(key,entry);
    }
  }
  const groups=new Map(), errors=[];let territorySegments=0,coastSegments=0,countrySegments=0,administrativeSegments=0,p0OnlySegments=0;
  for(const e of segments.values()){
    const owners=[...new Set([...e.left,...e.right])].sort((a,b)=>a-b);
    if(!owners.length){p0OnlySegments++;continue;}
    territorySegments++;
    if(owners.length>2||e.left.length>1||e.right.length>1||owners.some(o=>e.left.includes(o)&&e.right.includes(o))){errors.push({kind:'ambiguous-side',segment:[e.a,e.b],owners});continue;}
    const countries=owners.map(i=>atoms[i].identity.sourceCountryId);
    const boundaryClass=owners.length===1?'coast':countries[0]===countries[1]?'administrative':'country';
    if(boundaryClass==='coast'){coastSegments++;if(!e.p0.includes(countries[0]))errors.push({kind:'unpaired-interior-boundary',segment:[e.a,e.b],country:countries[0],p0:e.p0});}
    else if(boundaryClass==='country'){countrySegments++;if(!countries.every(c=>e.p0.includes(c)))errors.push({kind:'country-boundary-outside-P0',segment:[e.a,e.b],countries,p0:e.p0});}
    else administrativeSegments++;
    const key=`${owners.join(',')}:${boundaryClass}`,group=groups.get(key)??{owners,boundaryClass,segments:[]};group.segments.push(e);groups.set(key,group);
  }
  if(errors.length||p0OnlySegments){
    const index=new STRtree();for(const e of segments.values())index.insert(new Envelope(e.a[0],e.b[0],Math.min(e.a[1],e.b[1]),Math.max(e.a[1],e.b[1])),e);
    const numericalDiagnostics=errors.slice(0,50).map(error=>{
      const [a,b]=error.segment,dx=b[0]-a[0],dy=b[1]-a[1],length=Math.hypot(dx,dy),radius=0.0000014142135623730952;
      const box=new Envelope(a[0]-radius,b[0]+radius,Math.min(a[1],b[1])-radius,Math.max(a[1],b[1])+radius);
      const candidates=[];
      for(const it=index.query(box).iterator();it.hasNext();){const e=it.next();if(segmentKey(e.a,e.b)===segmentKey(a,b))continue;
        const t=p=>((p[0]-a[0])*dx+(p[1]-a[1])*dy)/(length*length),lo=Math.max(0,Math.min(t(e.a),t(e.b))),hi=Math.min(1,Math.max(t(e.a),t(e.b)));
        if(hi<=lo)continue;
        const distance=Math.max(...[e.a,e.b].map(p=>Math.abs((p[0]-a[0])*dy-(p[1]-a[1])*dx)/length));
        if(distance>radius)continue;
        candidates.push({segment:[e.a,e.b],maximumLineDistance:distance,projectedOverlapFraction:hi-lo,territories:[...e.left,...e.right].map(i=>atoms[i].identity.sourceCountryId+':'+atoms[i].identity.sourceFeatureId),p0:e.p0});
      }
      return {...error,candidates:candidates.sort((a,b)=>a.maximumLineDistance-b.maximumLineDistance).slice(0,6)};
    });
    const failure={errors:errors.slice(0,20),errorCount:errors.length,p0OnlySegments,territorySegments,numericalDiagnostics};
    const error=new Error(`Topology boundary certification failed: ${canonical({errorCount:errors.length,p0OnlySegments,territorySegments})}`);error.evidence=failure;throw error;
  }
  const edges=[],adjacency=Object.fromEntries(atoms.map(a=>[territoryIdForAtom(a.canonicalAtomKey),[]]));
  for(const group of groups.values()){
    const byPoint=new Map(),seen=new Set();
    group.segments.sort((a,b)=>pointCompare(a.a,b.a)||pointCompare(a.b,b.b));
    group.segments.forEach((e,i)=>{for(const p of [e.a,e.b]){const key=pointKey(p),list=byPoint.get(key)??[];list.push(i);byPoint.set(key,list);}});
    const walk=(start,index)=>{
      const path=[start];let current=start,first=null;
      while(!seen.has(index)){
        seen.add(index);const e=group.segments[index],forward=pointCompare(current,e.a)===0,next=forward?e.b:e.a;
        const left=(forward?e.left:e.right)[0]??null,right=(forward?e.right:e.left)[0]??null;
        if(!first)first={left,right};else if(first.left!==left||first.right!==right)throw new Error('Inconsistent chain side orientation');
        path.push(next);current=next;const incident=byPoint.get(pointKey(current));
        if(incident.length!==2)break;
        const candidate=incident.find(i=>!seen.has(i));if(candidate===undefined)break;index=candidate;
      }
      if(first.left===null){path.reverse();[first.left,first.right]=[first.right,first.left];}
      const leftTerritoryId=territoryIdForAtom(atoms[first.left].canonicalAtomKey),rightTerritoryId=first.right===null?null:territoryIdForAtom(atoms[first.right].canonicalAtomKey);
      const geometry={type:'LineString',coordinates:path};
      const identity={leftTerritoryId,rightTerritoryId,boundaryClass:group.boundaryClass,geometry};
      const id=`edge:catalog:${hashCanonical('catalog-edge-id.v1',identity)}`;
      edges.push({id,...identity});
      if(rightTerritoryId){adjacency[leftTerritoryId].push(rightTerritoryId);adjacency[rightTerritoryId].push(leftTerritoryId);}
    };
    const endpoints=[...byPoint].filter(([,list])=>list.length!==2).map(([key])=>key.split(',').map(Number)).sort(pointCompare);
    for(const p of endpoints)for(const i of byPoint.get(pointKey(p)))if(!seen.has(i))walk(p,i);
    for(let i=0;i<group.segments.length;i++)if(!seen.has(i))walk(group.segments[i].a,i);
  }
  edges.sort((a,b)=>compareText(a.id,b.id));
  if(new Set(edges.map(e=>e.id)).size!==edges.length)throw new Error('Duplicate edge identity');
  for(const id of Object.keys(adjacency))adjacency[id]=[...new Set(adjacency[id])].sort(compareText);
  for(const [id,list]of Object.entries(adjacency))for(const neighbor of list)if(id===neighbor||!adjacency[neighbor]?.includes(id))throw new Error('Asymmetric/self adjacency');
  const evidence={pass:true,sourceSegments,nodedTerritoryOccurrences:occurrences,territorySegments,coastSegments,countrySegments,administrativeSegments,p0OnlySegments,
    edges:edges.length,adjacencyPairs:Object.values(adjacency).reduce((n,a)=>n+a.length,0)/2,ambiguousSides:0,unpairedInteriorBoundaries:0,
    completeBoundaryCoverage:true,symmetricAdjacency:true,noding:'JSTS 2.12.1 MCIndexNoder + RobustLineIntersector; exact source doubles, no snap/round/buffer',properIntersections:intersector.numProperIntersections};
  return {edges,adjacency,evidence};
}
