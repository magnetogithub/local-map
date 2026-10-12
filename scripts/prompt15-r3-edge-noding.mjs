import fs from 'node:fs';
import Coordinate from 'jsts/org/locationtech/jts/geom/Coordinate.js';
import RobustLineIntersector from 'jsts/org/locationtech/jts/algorithm/RobustLineIntersector.js';
import MCIndexNoder from 'jsts/org/locationtech/jts/noding/MCIndexNoder.js';
import IntersectionAdder from 'jsts/org/locationtech/jts/noding/IntersectionAdder.js';
import NodedSegmentString from 'jsts/org/locationtech/jts/noding/NodedSegmentString.js';
import ArrayList from 'jsts/java/util/ArrayList.js';
const cmp=(a,b)=>a[0]-b[0]||a[1]-b[1],key=(a,b)=>`${a[0]},${a[1]};${b[0]},${b[1]}`;
const bucket=s=>{let h=2166136261;for(let i=0;i<s.length;i++)h=Math.imul(h^s.charCodeAt(i),16777619);return h&255;};
// The common world refinement must split one country's edge at vertices introduced
// by the other country. This decomposes existing linework; it translates no source.
export function nodeUnpairedBuckets(input,output){
 fs.mkdirSync(output,{recursive:true});const fds=Array.from({length:256},(_,i)=>fs.openSync(`${output}/${i}.ndjson`,'w')),unpaired=new ArrayList();let occurrences=0,pairedOccurrences=0;
 const emit=(a,b,ordinal,side)=>{fs.writeSync(fds[bucket(key(a,b))],JSON.stringify([a,b,ordinal,side])+'\n');};
 for(let bi=0;bi<256;bi++){
  const groups=new Map();for(const line of fs.readFileSync(`${input}/${bi}.ndjson`,'utf8').split('\n'))if(line){const record=JSON.parse(line),k=key(record[0],record[1]),list=groups.get(k)??[];list.push(record);groups.set(k,list);occurrences++;}
  for(const list of groups.values()){
   if(list.length===2&&list[0][3]!==list[1][3]){for(const r of list)emit(...r);pairedOccurrences+=2;}
   else for(const [a,b,ordinal,side]of list)unpaired.add(new NodedSegmentString([new Coordinate(...a),new Coordinate(...b)],{ordinal,side}));
  }
 }
 console.log(`World edge refinement: ${pairedOccurrences} already paired occurrences, ${unpaired.size()} remaining occurrences`);
 const noder=new MCIndexNoder(new IntersectionAdder(new RobustLineIntersector()));noder.computeNodes(unpaired);let outputOccurrences=pairedOccurrences,maximumDisplacement=0;
 for(const it=unpaired.iterator();it.hasNext();){const ss=it.next(),source=ss.getCoordinates(),dx=source[1].x-source[0].x,dy=source[1].y-source[0].y,len=Math.hypot(dx,dy);for(const nodes=ss.getNodeList().iterator();nodes.hasNext();){const p=nodes.next().coord;maximumDisplacement=Math.max(maximumDisplacement,Math.abs((p.x-source[0].x)*dy-(p.y-source[0].y)*dx)/len);}}
 for(const it=noder.getNodedSubstrings().iterator();it.hasNext();){const ss=it.next(),coords=ss.getCoordinates(),{ordinal,side}=ss.getData();for(let i=1;i<coords.length;i++){let a=[coords[i-1].x,coords[i-1].y],b=[coords[i].x,coords[i].y],direction=side;if(cmp(a,b)===0)continue;if(cmp(a,b)>0){[a,b]=[b,a];direction=1-direction;}emit(a,b,ordinal,direction);outputOccurrences++;}}
 fds.forEach(fd=>fs.closeSync(fd));return {occurrences,pairedOccurrences,unpairedOccurrences:unpaired.size(),outputOccurrences,maximumDisplacement,pass:maximumDisplacement<=1e-12,algorithm:'Exact robust MCIndexNoder on unmatched linework; original coordinates and canonical cell IDs retained'};
}
