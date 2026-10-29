// Task 15-21 transport rules. No runtime imports or mutable world state.
import fs from 'node:fs';
import path from 'node:path';
import {gzipSync,gunzipSync} from 'node:zlib';
import {compareText,digest,hashCanonical,jsonBytes} from './prompt14-catalog-core.mjs';

export const VERSION='prompt15-task-15-21-world-delivery-v1';
export const WORLD_ROOT='data/derived/prompt15/15-19-operational-catalog-v3-ae59d85d8dedbafc44f6';
export const INDICES_ROOT='data/derived/prompt15/15-20-topology-membership-v1-22406931e1665b6ede05';
export const INPUT_PINS=[
  {root:WORLD_ROOT,byteLength:118820,sha256:'8540ff202fedd34edda2633680750937483296e22ad75e6bb9b58ed6cac37bdc'},
  {root:INDICES_ROOT,byteLength:39753,sha256:'0aaa5a800c4ab0a55dd4bf34cccd5161c5042ab2ffcbd7af7d6b0007f53e710e'},
];
export const CLASSES=['coast','country','administrative','operational','residual'];
export const POLICY=Object.freeze({
  version:VERSION,minZoom:0,maxZoom:6,administrativeMinZoom:4,operationalMinZoom:8,
  tileOptions:{maxZoom:6,indexMaxZoom:5,indexMaxPoints:100000,tolerance:3,extent:4096,buffer:64,promoteId:null,generateId:false},
  tileTransport:{compression:'gzip',level:9,contentType:'application/gzip',httpContentEncoding:null,decodedContentType:'application/vnd.mapbox-vector-tile',meaning:'Verify compressed artifact identity, then decompress before supplying PBF bytes to MapLibre.'},
  edgeIncidence:{path:'metadata/edge-incidence.bin.gz',compression:'gzip',format:'uint32-le-pairs',recordBytes:8,index:'(edgeOrdinal - 1) * 8',meaning:'Complete left/right cell ordinals, fetched once; tile feature.id selects the record. Index zero on the right denotes coast.'},
  topologyDetailOmittedDerivedFields:['lengthKm'],
  renderByteBudget:512*1024**2,initialMetadataByteBudget:220*1024**2,
  layers:{territories:'Stable cell ordinal; country and parent identities live in country metadata.',
    edges:'All surviving positive topology segments with c/a classes; feature.id resolves l/r cell ordinals in the complete edge incidence index. No static controller or occupation.',
    administrative:'Real administrative edges only, absent at z<4. Synthetic cell lines never enter this layer.'},
  transport:'Positive numeric feature.id ordinals. String canonical cell/edge IDs are resolved through indexed metadata, never generated in the browser.',
  lod:'Overview tiles simplify/cull subpixel polygons and segments. Missing overview ordinals are explicitly listed. Exact indexed country geometry and topology shards preserve EVERY source geometry including holes and tiny faces; load on demand for detail/changed-cell projection. Never stretch or invent tiny geometry.',
  frontier:'right > 0 && controller[left] !== controller[right]. Source border and administrative flags are independent of current owner/controller.',
  style:{country:{sourceLayer:'edges',classes:[0,1],minzoom:0},administrative:{sourceLayer:'administrative',minzoom:4},
    operational:{sourceLayer:'edges',minzoom:8,defaultVisibility:'none'},frontier:{sourceLayer:'edges',minzoom:0,dynamic:true}},
});
export const slash=value=>String(value).replaceAll('\\','/');
export const readJSON=file=>JSON.parse(fs.readFileSync(file,'utf8'));
export const readGzipJSON=file=>JSON.parse(gunzipSync(fs.readFileSync(file),{maxOutputLength:768*1024**2}).toString('utf8'));
export const identity=file=>{const bytes=fs.readFileSync(file);return {path:slash(file),sha256:digest(bytes),byteLength:bytes.length};};
export const sameIdentity=(a,b)=>a.sha256===b.sha256&&a.byteLength===b.byteLength;
export const safeRelative=value=>typeof value==='string'&&value.length>0&&!value.includes('\\')&&!path.posix.isAbsolute(value)&&!value.includes(':')&&!value.split('/').some(part=>!part||part==='.'||part==='..');
export function filesBelow(root,current=root,result=[]){
  for(const entry of fs.readdirSync(current,{withFileTypes:true}).sort((a,b)=>compareText(a.name,b.name))){
    const file=path.join(current,entry.name);
    if(entry.isSymbolicLink())throw Error(`Symbolic links are not delivery artifacts: ${file}`);
    if(entry.isDirectory())filesBelow(root,file,result);
    else if(entry.isFile())result.push(slash(path.relative(root,file)));
    else throw Error(`Unsupported artifact: ${file}`);
  }return result;
}
export function verifyTree(root,pin){
  const indexFile=path.join(root,'artifact-index.json');
  if(pin&&!sameIdentity(identity(indexFile),pin))throw Error(`Pinned input index changed: ${root}`);
  const index=readJSON(indexFile),artifacts=index.artifacts;
  if(!Array.isArray(artifacts)||!artifacts.length)throw Error('Empty artifact index');
  const names=artifacts.map(a=>a.path),sorted=names.slice().sort(compareText);
  if(new Set(names).size!==names.length||names.some((name,i)=>!safeRelative(name)||name!==sorted[i]))throw Error('Unsafe, duplicate or unsorted artifact index');
  const disk=filesBelow(root).filter(name=>name!=='artifact-index.json').sort(compareText);
  if(JSON.stringify(disk)!==JSON.stringify(sorted))throw Error(`Artifact disk set mismatch: ${root}`);
  let total=0;for(const artifact of artifacts){if(!sameIdentity(identity(path.join(root,artifact.path)),artifact))throw Error(`Artifact bytes mismatch: ${artifact.path}`);total+=artifact.byteLength;}
  if(total!==index.totalByteLength)throw Error('Artifact byte total mismatch');
  return {index,identity:identity(indexFile)};
}
export function writeArtifact(root,name,value,{compressed=false,raw=false}={}){
  if(!safeRelative(name))throw Error(`Unsafe output path: ${name}`);
  const bytes=raw?Buffer.from(value):compressed?gzipSync(jsonBytes(value),{level:9,mtime:0}):jsonBytes(value),file=path.join(root,...name.split('/'));
  fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,bytes,{flag:'wx'});
  return {path:name,sha256:digest(bytes),byteLength:bytes.length};
}
export function* tileCoordinates(){for(let z=0;z<=POLICY.maxZoom;z++)for(let x=0;x<2**z;x++)for(let y=0;y<2**z;y++)yield {z,x,y,path:`tiles/${z}/${x}/${y}.pbf.gz`};}
export const decodeTilePayload=bytes=>gunzipSync(bytes,{maxOutputLength:128*1024**2});
export function encodeEdgeIncidence(left,right){
  if(left.length!==right.length||left.length<2)throw Error('Invalid incidence arrays');
  const bytes=Buffer.alloc((left.length-1)*POLICY.edgeIncidence.recordBytes);
  for(let ordinal=1;ordinal<left.length;ordinal++){
    if(!Number.isInteger(left[ordinal])||left[ordinal]<1||!Number.isInteger(right[ordinal])||right[ordinal]<0||left[ordinal]===right[ordinal])throw Error('Invalid incidence record');
    bytes.writeUInt32LE(left[ordinal],(ordinal-1)*8);bytes.writeUInt32LE(right[ordinal],(ordinal-1)*8+4);
  }return bytes;
}
export const artifactRoot=(domain,artifacts)=>hashCanonical(domain,artifacts.slice().sort((a,b)=>compareText(a.path,b.path)));
// Partition work, not geography: every exact edge is assigned once and is still
// clipped normally into every intersected overview tile, including map wraps.
export function edgeTileBucket(feature){
  const coordinates=feature.geometry.coordinates;
  const x=coordinates.reduce((sum,point)=>sum+point[0],0)/coordinates.length;
  const y=coordinates.reduce((sum,point)=>sum+point[1],0)/coordinates.length;
  return Math.max(0,Math.min(3,Math.floor((y+90)/45)))*4+Math.max(0,Math.min(3,Math.floor((x+180)/90)));
}
const pointXY=point=>Array.isArray(point)?point:[point.x,point.y];
const ringArea=ring=>{let area=0;for(let i=0,j=ring.length-1;i<ring.length;j=i++){const a=pointXY(ring[j]),b=pointXY(ring[i]);area+=a[0]*b[1]-b[0]*a[1];}return area;};
const positiveLine=line=>line.some((point,i)=>i>0&&pointXY(point).some((v,axis)=>v!==pointXY(line[i-1])[axis]));
export function nondegenerateTileFeature(feature){
  const geometry=feature.geometry.filter(ring=>feature.type===3?ringArea(ring)!==0:positiveLine(ring));
  if(!geometry.length||feature.type===3&&geometry.reduce((sum,ring)=>sum+ringArea(ring),0)<=0)return null;
  return {...feature,geometry};
}
export function edgeFeature(edge){
  const c=CLASSES.indexOf(edge.boundaryClass);
  if(c<0||!Number.isSafeInteger(edge.ordinal)||edge.ordinal<1||!Number.isSafeInteger(edge.left)||edge.left<1||!Number.isSafeInteger(edge.right)||edge.right<0||edge.left===edge.right||edge.geometry?.type!=='LineString')throw Error('Invalid topology transport edge');
  return {type:'Feature',id:edge.ordinal,properties:{c,a:Number(edge.flags.administrative)},geometry:edge.geometry};
}
export function checkTransportFeature(layer,feature,cellCount,edgeCount,zoom){
  if(!Number.isSafeInteger(feature.id)||feature.id<1||feature.id>(layer==='territories'?cellCount:edgeCount))throw Error('Invalid canonical transport ordinal');
  const geometry=feature.loadGeometry();
  if(!geometry.length||geometry.some(ring=>feature.type===3?ringArea(ring)===0:!positiveLine(ring))||feature.type===3&&geometry.reduce((sum,ring)=>sum+ringArea(ring),0)<=0)throw Error('Degenerate overview geometry');
  if(layer==='territories'){if(feature.type!==3)throw Error('Cell tile feature must be polygon');return;}
  if(!['edges','administrative'].includes(layer)||feature.type!==2)throw Error('Unexpected tile layer/geometry');
  const {c,a}=feature.properties;
  if(Object.keys(feature.properties).length!==2||!Number.isInteger(c)||c<0||c>=CLASSES.length||![0,1].includes(a))throw Error('Invalid tile edge classes');
  if(layer==='administrative'&&(zoom<POLICY.administrativeMinZoom||a!==1))throw Error('Administrative LOD visibility violation');
}
