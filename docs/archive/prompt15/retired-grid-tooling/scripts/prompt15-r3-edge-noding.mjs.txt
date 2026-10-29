import fs from 'node:fs';
import Coordinate from 'jsts/org/locationtech/jts/geom/Coordinate.js';
import PrecisionModel from 'jsts/org/locationtech/jts/geom/PrecisionModel.js';
import MCIndexSnapRounder from 'jsts/org/locationtech/jts/noding/snapround/MCIndexSnapRounder.js';
import NodedSegmentString from 'jsts/org/locationtech/jts/noding/NodedSegmentString.js';
import ArrayList from 'jsts/java/util/ArrayList.js';

const PRECISION_SCALE=1e12,DISPLACEMENT_LIMIT_DEGREES=1e-12;
const cmp=(a,b)=>a[0]-b[0]||a[1]-b[1],key=(a,b)=>`${a[0]},${a[1]};${b[0]},${b[1]}`;
const bucket=s=>{let h=2166136261;for(let i=0;i<s.length;i++)h=Math.imul(h^s.charCodeAt(i),16777619);return h&255;};
const perpendicularDistance=(p,[a,b])=>{const dx=b[0]-a[0],dy=b[1]-a[1],length=Math.hypot(dx,dy);return length?Math.abs((p[0]-a[0])*dy-(p[1]-a[1])*dx)/length:Math.hypot(p[0]-a[0],p[1]-a[1]);};

// Exact pairs need no refinement and retain their source coordinates. Every
// other occurrence enters one fixed-grid snap-rounding pass, so endpoints and
// inserted nodes have separate, auditable displacement gates.
export function nodeUnpairedBuckets(input,output){
 fs.mkdirSync(output,{recursive:true});
 const fds=Array.from({length:256},(_,i)=>fs.openSync(`${output}/${i}.ndjson`,'w')),unpaired=new ArrayList(),precisionModel=new PrecisionModel(PRECISION_SCALE);
 let occurrences=0,pairedOccurrences=0,endpointOccurrences=0,roundedEndpointOccurrences=0,maximumEndpointRoundingDisplacement=0;
 const emitRecord=record=>{fs.writeSync(fds[bucket(key(record[0],record[1]))],JSON.stringify(record)+'\n');};
 const emitSegment=(record,a,b,side)=>{const outputRecord=record.slice();outputRecord[0]=a;outputRecord[1]=b;outputRecord[3]=side;emitRecord(outputRecord);};
 for(let bi=0;bi<256;bi++){
  const groups=new Map();
  for(const line of fs.readFileSync(`${input}/${bi}.ndjson`,'utf8').split('\n'))if(line){const record=JSON.parse(line),k=key(record[0],record[1]),list=groups.get(k)??[];list.push(record);groups.set(k,list);occurrences++;}
  for(const list of groups.values()){
   if(list.length===2&&list[0][3]!==list[1][3]){for(const record of list)emitRecord(record);pairedOccurrences+=2;continue;}
   for(const record of list){
    const originalSegment=[record[0],record[1]],roundedSegment=originalSegment.map(([x,y])=>{const coordinate=new Coordinate(x,y);precisionModel.makePrecise(coordinate);const displacement=Math.hypot(coordinate.x-x,coordinate.y-y);endpointOccurrences++;if(displacement)roundedEndpointOccurrences++;maximumEndpointRoundingDisplacement=Math.max(maximumEndpointRoundingDisplacement,displacement);return coordinate;});
    unpaired.add(new NodedSegmentString(roundedSegment,{record,originalSegment}));
   }
  }
 }
 console.log(`World edge refinement: ${pairedOccurrences} already paired occurrences, ${unpaired.size()} snap-rounded occurrences`);
 const noder=new MCIndexSnapRounder(precisionModel);noder.computeNodes(unpaired);const nodedSubstrings=noder.getNodedSubstrings();
 let outputOccurrences=pairedOccurrences,insertedNodeOccurrences=0,maximumInsertedNodePerpendicularDisplacement=0;
 for(const it=unpaired.iterator();it.hasNext();){const ss=it.next(),{originalSegment}=ss.getData();for(const nodes=ss.getNodeList().iterator();nodes.hasNext();){const node=nodes.next();if(!node.isInterior())continue;const displacement=perpendicularDistance([node.coord.x,node.coord.y],originalSegment);insertedNodeOccurrences++;maximumInsertedNodePerpendicularDisplacement=Math.max(maximumInsertedNodePerpendicularDisplacement,displacement);}}
 for(const it=nodedSubstrings.iterator();it.hasNext();){const ss=it.next(),coords=ss.getCoordinates(),{record}=ss.getData();for(let i=1;i<coords.length;i++){let a=[coords[i-1].x,coords[i-1].y],b=[coords[i].x,coords[i].y],direction=record[3];if(cmp(a,b)===0)continue;if(cmp(a,b)>0){[a,b]=[b,a];direction=1-direction;}emitSegment(record,a,b,direction);outputOccurrences++;}}
 fds.forEach(fd=>fs.closeSync(fd));
 const endpointRoundingPass=maximumEndpointRoundingDisplacement<=DISPLACEMENT_LIMIT_DEGREES,insertedNodePerpendicularPass=maximumInsertedNodePerpendicularDisplacement<=DISPLACEMENT_LIMIT_DEGREES,maximumDisplacement=Math.max(maximumEndpointRoundingDisplacement,maximumInsertedNodePerpendicularDisplacement);
 return {occurrences,pairedOccurrences,unpairedOccurrences:unpaired.size(),outputOccurrences,maximumDisplacement,maximumEndpointRoundingDisplacement,maximumInsertedNodePerpendicularDisplacement,pass:endpointRoundingPass&&insertedNodePerpendicularPass,
  algorithm:'Exact already-paired records are emitted unchanged. Unmatched endpoints are rounded by a fixed scale-1e12 PrecisionModel and commonly noded by MCIndexSnapRounder; split records retain every input metadata field.',
  evidence:{precisionModel:{type:'fixed',scale:PRECISION_SCALE},maximumAllowedDisplacementDegrees:DISPLACEMENT_LIMIT_DEGREES,
   originalEndpointRounding:{occurrences:endpointOccurrences,changedOccurrences:roundedEndpointOccurrences,maximumDisplacementDegrees:maximumEndpointRoundingDisplacement,pass:endpointRoundingPass},
   insertedNodeTrace:{occurrences:insertedNodeOccurrences,metric:'perpendicular distance to the original unrounded input segment',maximumDisplacementDegrees:maximumInsertedNodePerpendicularDisplacement,pass:insertedNodePerpendicularPass},
   recordPreservation:'Only split endpoints and the canonical-direction side field may change; ordinal and every additional input record field are emitted unchanged.'}};
}
