// Prompt 15 V20 independent verifier. This module deliberately does not
// import the 15-20 generator, its topology core, or its noding wrapper.
// Immutable source pins and every topology/membership rule are owned here.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {gzipSync,gunzipSync} from 'node:zlib';
import {pathToFileURL} from 'node:url';
import polygonClipping from 'polygon-clipping';
import GeoJSONReader from 'jsts/org/locationtech/jts/io/GeoJSONReader.js';
import GeoJSONWriter from 'jsts/org/locationtech/jts/io/GeoJSONWriter.js';
import OverlayOp from 'jsts/org/locationtech/jts/operation/overlay/OverlayOp.js';
import STRtree from 'jsts/org/locationtech/jts/index/strtree/STRtree.js';
import Envelope from 'jsts/org/locationtech/jts/geom/Envelope.js';
import Coordinate from 'jsts/org/locationtech/jts/geom/Coordinate.js';
import PrecisionModel from 'jsts/org/locationtech/jts/geom/PrecisionModel.js';
import MCIndexSnapRounder from 'jsts/org/locationtech/jts/noding/snapround/MCIndexSnapRounder.js';
import NodedSegmentString from 'jsts/org/locationtech/jts/noding/NodedSegmentString.js';
import ArrayList from 'jsts/java/util/ArrayList.js';
import {
  compareText,
  digest,
  hashCanonical,
  jsonBytes,
  normalizeGeometry,
  polygons,
} from './prompt14-catalog-core.mjs';

const TASK_15_20_VERSION='prompt15-task-15-20-world-indices-v1';
const TOPOLOGY_BUCKETS=256;
const WORLD_EDGE_BUDGET=4_000_000;
const EARTH_RADIUS_KM=6371.0088;
const PRECISION_SCALE=1e12;
const BOUNDARY_DISTANCE_TOLERANCE_DEGREES=1e-12;
const FIXED_GRID_COVERAGE_TOLERANCE_DEGREES=Math.SQRT2*1e-12+1e-15;
const NUMERICAL_REPAIR_BOUNDARY_TOLERANCE_DEGREES=2e-6;
const DISPLACEMENT_LIMIT_DEGREES=1e-12;
const MAX_INDEXED_TOTAL_BYTES=512*1024*1024;
const MAX_INDEXED_ARTIFACT_BYTES=128*1024*1024;
const OUTPUT_GZIP_LIMITS=new Map([
  ['catalog-order.json.gz',{compressed:128*1024*1024,uncompressed:384*1024*1024}],
  ['adjacency.json.gz',{compressed:32*1024*1024,uncompressed:128*1024*1024}],
  ['administrative-membership.json.gz',{compressed:16*1024*1024,uncompressed:64*1024*1024}],
  ['previous-parent-index.json.gz',{compressed:16*1024*1024,uncompressed:64*1024*1024}],
]);

const WORLD_CATALOG_ROOT='data/derived/prompt15/15-19-operational-catalog-v3-ae59d85d8dedbafc44f6';
const ADMINISTRATIVE_ROOT='data/derived/prompt15/15-18-administrative-input-v1-161260049c9100b09cb5';
const WORLD_CATALOG_INDEX={
  path:`${WORLD_CATALOG_ROOT}/artifact-index.json`,
  byteLength:118820,
  sha256:'8540ff202fedd34edda2633680750937483296e22ad75e6bb9b58ed6cac37bdc',
};
const V19_REPORT={
  path:'reports/prompt15/15-19-v19-topology-source-repair-v2.json',
  byteLength:54334,
  sha256:'783ef29a8e65036f257c7ef0e6844f308a3551c8f0736245d553ed48957e6923',
};
const ADMINISTRATIVE_INDEX={
  path:`${ADMINISTRATIVE_ROOT}/artifact-index.json`,
  byteLength:1981,
  sha256:'bb977fd802809430ee07b240cb68aa61299701f30a762c987d1890767d226256',
};
const ADMINISTRATIVE_ARTIFACTS=[
  'administrative-restoration.geojson','audit.json','build-summary.json','contract.json',
  'country-summary.json','excluded-source-trace.json','fallbacks.json','loss-audit-resolution.json',
  'protected-overlay-trace.json','protected-overlay.geojson','provenance.json','residuals.geojson',
  'source-identity-trace.json',
].sort(compareText);
const REQUIRED_INPUT_PATHS=[
  WORLD_CATALOG_INDEX.path,
  V19_REPORT.path,
  ADMINISTRATIVE_INDEX.path,
  `${ADMINISTRATIVE_ROOT}/administrative-restoration.geojson`,
  `${ADMINISTRATIVE_ROOT}/residuals.geojson`,
  `${ADMINISTRATIVE_ROOT}/protected-overlay.geojson`,
  'data/derived/prompt14/shared-game-p0.geojson',
  'package.json',
  'package-lock.json',
  'node_modules/jsts/package.json',
  'node_modules/jsts/org/locationtech/jts/geom/Envelope.js',
  'node_modules/jsts/org/locationtech/jts/geom/PrecisionModel.js',
  'node_modules/jsts/org/locationtech/jts/index/strtree/STRtree.js',
  'node_modules/jsts/org/locationtech/jts/noding/snapround/MCIndexSnapRounder.js',
  'node_modules/jsts/org/locationtech/jts/noding/NodedSegmentString.js',
  'scripts/prompt15-world-indices.mjs',
  'scripts/prompt15-cell-policy.mjs',
  'scripts/prompt15-world-indices-core.mjs',
  'scripts/prompt15-r3-edge-noding.mjs',
  'scripts/prompt15-world-catalog.mjs',
  'scripts/prompt15-cell-core.mjs',
  'scripts/prompt15-world-preflight.mjs',
  'scripts/prompt14-catalog-core.mjs',
  'scripts/prompt14-boundary-arrangement.mjs',
  'scripts/prompt14-catalog-topology.mjs',
  'scripts/prompt14-source-gate.mjs',
];
const V20_ARTIFACTS=[
  'adjacency.json.gz','administrative-membership.json.gz','catalog-order.json.gz',
  'index-root.json','previous-parent-index.json.gz','provenance.json','summary.json',
  'topology-validation.json',
  ...Array.from({length:TOPOLOGY_BUCKETS},(_,index)=>`topology/${String(index).padStart(3,'0')}.json.gz`),
].sort(compareText);

const slash=value=>String(value).replaceAll('\\','/');
const readJSON=file=>JSON.parse(fs.readFileSync(file,'utf8'));
const readGzipJSON=file=>JSON.parse(gunzipSync(fs.readFileSync(file)).toString('utf8'));
const identityForBytes=(file,bytes)=>({path:slash(file),sha256:digest(bytes),byteLength:bytes.length});
const fileIdentity=file=>identityForBytes(file,fs.readFileSync(file));
const sameIdentity=(actual,expected)=>actual?.byteLength===expected?.byteLength&&actual?.sha256===expected?.sha256;
const sameValue=(actual,expected)=>hashCanonical('prompt15-v20-independent-equality.v1',actual)===hashCanonical('prompt15-v20-independent-equality.v1',expected);
const exactArray=(actual,expected)=>Array.isArray(actual)&&actual.length===expected.length&&actual.every((value,index)=>Object.is(value,expected[index]));
const exactKeySet=(actual,expected)=>actual&&typeof actual==='object'&&exactArray(Object.keys(actual).sort(compareText),expected.slice().sort(compareText));
const safeRelative=value=>typeof value==='string'&&value.length>0&&!value.includes('\\')&&!value.includes(':')&&!path.posix.isAbsolute(value)&&!path.win32.isAbsolute(value)&&!value.split('/').some(part=>!part||part==='.'||part==='..');
const runtimeIdentity=()=>({node:process.version,v8:process.versions.v8,zlib:process.versions.zlib,platform:process.platform,arch:process.arch,jsts:readJSON('node_modules/jsts/package.json').version});
const kahanAdd=(map,key,value)=>{const state=map.get(key)??{sum:0,correction:0},adjusted=value-state.correction,next=state.sum+adjusted;state.correction=(next-state.sum)-adjusted;state.sum=next;map.set(key,state);};
const kahanValue=(map,key)=>map.get(key)?.sum??0;
const setEquals=(first,second)=>first.size===second.size&&[...first].every(value=>second.has(value));
const reportDetail=value=>{const serialized=JSON.stringify(value,(_key,item)=>item===undefined?null:typeof item==='number'&&!Number.isFinite(item)?String(item):item);return serialized===undefined?null:JSON.parse(serialized);};

function resolveBelow(root,relative){
  if(!safeRelative(relative))throw Error(`Unsafe relative artifact path: ${relative}`);
  const base=path.resolve(root),target=path.resolve(base,...relative.split('/'));
  if(target===base||!target.startsWith(`${base}${path.sep}`))throw Error(`Artifact path escaped its root: ${relative}`);
  return target;
}

function filesBelow(root,current=root,result=[]){
  for(const entry of fs.readdirSync(current,{withFileTypes:true}).sort((first,second)=>compareText(first.name,second.name))){
    const target=path.join(current,entry.name),relative=slash(path.relative(root,target));
    if(entry.isDirectory())filesBelow(root,target,result);
    else if(entry.isFile())result.push(relative);
    else result.push(`unsupported:${relative}`);
  }
  return result;
}

function validIndexedArtifact(artifact,compressionRequired){
  const protectedOverlayImport=!compressionRequired&&artifact?.path==='protected-overlay.geojson',required=compressionRequired?['byteLength','compression','path','sha256']:protectedOverlayImport?['byteLength','path','role','sha256']:['byteLength','path','sha256'];
  return exactKeySet(artifact,required)&&(!protectedOverlayImport||artifact.role==='byte-exact import of frozen previous territory geometry')&&safeRelative(artifact.path)&&Number.isSafeInteger(artifact.byteLength)&&artifact.byteLength>=0&&/^[a-f0-9]{64}$/.test(artifact.sha256)&&(!compressionRequired||artifact.compression===(artifact.path.endsWith('.gz')?'gzip':null));
}

function verifyIndexedTree(root,pin,kind){
  const identity=fileIdentity(pin.path);
  if(!sameIdentity(identity,pin))throw Error(`Pinned ${kind} artifact index changed`);
  const index=readJSON(pin.path),artifacts=index.artifacts??[],paths=artifacts.map(artifact=>artifact.path),sorted=paths.slice().sort(compareText);
  if(!exactArray(paths,sorted)||new Set(paths).size!==paths.length||artifacts.some(artifact=>!validIndexedArtifact(artifact,kind==='15-19')))throw Error(`Unsafe or non-canonical ${kind} artifact index`);
  const expectedCount=kind==='15-19'?744:13,expectedTotal=kind==='15-19'?220373318:68375007;
  if(artifacts.length!==expectedCount||index.totalByteLength!==expectedTotal||slash(index.root)!==slash(root))throw Error(`${kind} artifact-index contract changed`);
  const expectedPaths=kind==='15-19'?(()=>{
    const catalogRoot=readJSON(path.join(root,'catalog-root.json')),countries=catalogRoot.countryOrder??[];
    if(countries.length!==247||new Set(countries).size!==countries.length||!exactArray(countries,countries.slice().sort(compareText)))throw Error('15-19 country order changed');
    return ['catalog-root.json','provenance.json','summary.json',...countries.flatMap(countryId=>[`countries/${countryId}/catalog.json.gz`,`countries/${countryId}/generation.json.gz`,`countries/${countryId}/geometry.geojson.gz`])].sort(compareText);
  })():ADMINISTRATIVE_ARTIFACTS;
  if(!exactArray(paths,expectedPaths))throw Error(`${kind} indexed path set changed`);
  const disk=filesBelow(root).sort(compareText),expectedDisk=['artifact-index.json',...paths].sort(compareText);
  if(!exactArray(disk,expectedDisk))throw Error(`${kind} current-byte tree changed`);
  let total=0;
  for(const artifact of artifacts){
    const actual=fileIdentity(resolveBelow(root,artifact.path));
    if(!sameIdentity(actual,artifact))throw Error(`${kind} artifact changed: ${artifact.path}`);
    total+=actual.byteLength;
  }
  if(total!==index.totalByteLength)throw Error(`${kind} artifact byte total changed`);
  return {index,identity,catalogRoot:kind==='15-19'?readJSON(path.join(root,'catalog-root.json')):null};
}

const comparePoint=(a,b)=>a[0]-b[0]||a[1]-b[1];
const segmentKey=(a,b)=>`${a[0]},${a[1]};${b[0]},${b[1]}`;
const segmentBucket=value=>{let hash=2166136261;for(let index=0;index<value.length;index++)hash=Math.imul(hash^value.charCodeAt(index),16777619);return hash&(TOPOLOGY_BUCKETS-1);};

function canonicalSegment(sourceA,sourceB){
  let a=sourceA,b=sourceB;
  if(a[0]===180&&b[0]===180){a=[-180,a[1]];b=[-180,b[1]];}
  if(comparePoint(a,b)===0)return null;
  const side=comparePoint(a,b)<0?0:1;
  if(side)[a,b]=[b,a];
  return {a,b,side,key:segmentKey(a,b)};
}

function geometrySegmentRecords(feature,ordinal){
  const records=[];
  for(const polygon of polygons(feature.geometry))for(const ring of polygon)for(let index=1;index<ring.length;index++){
    const sourceA=ring[index-1],sourceB=ring[index],segment=canonicalSegment(sourceA,sourceB);
    if(!segment)continue;
    const mapCut=sourceA[0]===sourceB[0]&&(sourceA[0]===-180||sourceA[0]===180)?String(sourceA[0]):sourceA[1]===sourceB[1]&&(sourceA[1]===-90||sourceA[1]===90)?`pole:${sourceA[1]}`:null;
    records.push(mapCut?[segment.a,segment.b,ordinal,segment.side,mapCut]:[segment.a,segment.b,ordinal,segment.side]);
  }
  return records;
}

function planarArea(geometry){
  let total=0;
  for(const polygon of polygons(geometry))for(const [ringIndex,ring] of polygon.entries()){
    let twiceArea=0;
    const [originX,originY]=ring[0];
    for(let index=1;index<ring.length;index++)twiceArea+=(ring[index-1][0]-originX)*(ring[index][1]-originY)-(ring[index][0]-originX)*(ring[index-1][1]-originY);
    total+=(ringIndex===0?1:-1)*Math.abs(twiceArea)/2;
  }
  return Math.max(0,total);
}

function distanceKm(a,b){
  const radians=Math.PI/180,lat1=a[1]*radians,lat2=b[1]*radians,deltaLongitude=(b[0]-a[0])*radians,deltaLatitude=lat2-lat1;
  return 2*EARTH_RADIUS_KM*Math.asin(Math.sqrt(Math.min(1,Math.sin(deltaLatitude/2)**2+Math.cos(lat1)*Math.cos(lat2)*Math.sin(deltaLongitude/2)**2)));
}

const geoReader=new GeoJSONReader(),geoWriter=new GeoJSONWriter();
function intersectionGeometry(first,second){
  try{return {type:'MultiPolygon',coordinates:polygonClipping.intersection(polygons(first),polygons(second))};}
  catch(error){
    const result=geoWriter.write(OverlayOp.intersection(geoReader.read(first),geoReader.read(second)));
    if(result.type==='GeometryCollection'&&result.geometries.some(item=>item.type==='Polygon'||item.type==='MultiPolygon'))throw Error(`Positive polygon collection was not representable: ${error.message}`);
    const coordinates=result.type==='Polygon'?[result.coordinates]:result.type==='MultiPolygon'?result.coordinates:[];
    return {type:'MultiPolygon',coordinates};
  }
}

function loadPinnedSources(){
  const p0=readJSON('data/derived/prompt14/shared-game-p0.geojson');
  const administrative=readJSON(`${ADMINISTRATIVE_ROOT}/administrative-restoration.geojson`);
  const residuals=readJSON(`${ADMINISTRATIVE_ROOT}/residuals.geojson`);
  const protectedOverlay=readJSON(`${ADMINISTRATIVE_ROOT}/protected-overlay.geojson`);
  for(const [name,collection] of [['P0',p0],['administrative',administrative],['residuals',residuals],['protected',protectedOverlay]])if(collection?.type!=='FeatureCollection'||!Array.isArray(collection.features))throw Error(`Invalid pinned ${name} FeatureCollection`);
  const envelopes=new Map(p0.features.map(feature=>[feature.properties.countryId,feature.geometry])),selected=[];
  for(const feature of administrative.features){
    const countryId=feature.properties.sourceCountryId,envelope=envelopes.get(countryId);
    if(!envelope)throw Error(`Administrative source lacks P0 envelope: ${countryId}`);
    const coordinates=polygons(intersectionGeometry(feature.geometry,envelope));
    if(!coordinates.length)throw Error(`Administrative source is outside P0: ${countryId}:${feature.properties.sourceFeatureId}`);
    selected.push({type:'Feature',properties:{...feature.properties,countryId,inputRole:'P1'},geometry:normalizeGeometry({type:'MultiPolygon',coordinates})});
  }
  for(const feature of residuals.features){
    const countryId=feature.properties.countryId;
    selected.push({type:'Feature',properties:{...feature.properties,countryId,sourceFeatureId:`country-envelope:${feature.properties.residualId}`,inputRole:'P0R'},geometry:normalizeGeometry(feature.geometry)});
  }
  selected.sort((first,second)=>compareText(first.properties.countryId,second.properties.countryId)||compareText(String(first.properties.sourceFeatureId),String(second.properties.sourceFeatureId)));
  return {p0,protectedOverlay,selected:{type:'FeatureCollection',features:selected}};
}

function boundaryIndex(collection,idForFeature=feature=>feature.properties.countryId){
  const byIdentity=new Map(),segments=new Map(),globalTree=new STRtree();
  for(const feature of collection.features){
    const identity=idForFeature(feature);
    if(typeof identity!=='string'||!identity)throw Error('Boundary feature is missing an immutable identity');
    const tree=byIdentity.get(identity)??new STRtree();
    byIdentity.set(identity,tree);
    for(const polygon of polygons(feature.geometry))for(const ring of polygon)for(let index=1;index<ring.length;index++){
      const sourceA=ring[index-1],sourceB=ring[index],canonical=canonicalSegment(sourceA,sourceB);
      if(!canonical)continue;
      const {a,b,key,side}=canonical,segment=segments.get(key)??{a,b,identities:[],intervalsByIdentity:new Map(),periodicIntervalsByIdentity:new Map(),ordinaryIdentities:new Set(),sidesByIdentity:new Map(),mapCutsByIdentity:new Map()};
      const mapCut=sourceA[0]===sourceB[0]&&(sourceA[0]===-180||sourceA[0]===180)?String(sourceA[0]):sourceA[1]===sourceB[1]&&(sourceA[1]===-90||sourceA[1]===90)?`pole:${sourceA[1]}`:null;
      if(!segment.identities.includes(identity)){
        segment.identities.push(identity);
        segment.intervalsByIdentity.set(identity,[]);
        segment.periodicIntervalsByIdentity.set(identity,new Map());
        segment.sidesByIdentity.set(identity,new Set());
        segment.mapCutsByIdentity.set(identity,new Set());
        segments.set(key,segment);
        const item={identity,segment},envelope=new Envelope(a[0],b[0],Math.min(a[1],b[1]),Math.max(a[1],b[1]));
        tree.insert(envelope,item);
        globalTree.insert(envelope,item);
      }
      segment.sidesByIdentity.get(identity).add(side);
      if(mapCut){
        segment.mapCutsByIdentity.get(identity).add(mapCut);
        const periodic=segment.periodicIntervalsByIdentity.get(identity);
        if(!periodic.has(mapCut))periodic.set(mapCut,[]);
      }else segment.ordinaryIdentities.add(identity);
    }
  }
  return {byIdentity,segments,globalTree};
}

function boundaryMatch(a,b,identity,index,{distanceTolerance=BOUNDARY_DISTANCE_TOLERANCE_DEGREES,gapTolerance=FIXED_GRID_COVERAGE_TOLERANCE_DEGREES}={}){
  const tree=index.byIdentity.get(identity);
  if(!tree)return {pass:false,matches:[],maximumDistance:Infinity,gapDegrees:Math.hypot(b[0]-a[0],b[1]-a[1]),neighbors:[],sourceSides:[],mapCuts:[]};
  const box=new Envelope(Math.min(a[0],b[0]),Math.max(a[0],b[0]),Math.min(a[1],b[1]),Math.max(a[1],b[1]));
  box.expandBy(distanceTolerance);
  const intervals=[],matches=[],dx=b[0]-a[0],dy=b[1]-a[1],denominator=dx*dx+dy*dy,length=Math.sqrt(denominator);
  let maximumDistance=0;
  for(const iterator=tree.query(box).iterator();iterator.hasNext();){
    const indexed=iterator.next(),segment=indexed.segment,sx=segment.b[0]-segment.a[0],sy=segment.b[1]-segment.a[1],sourceDenominator=sx*sx+sy*sy;
    const distance=point=>Math.abs((point[0]-segment.a[0])*sy-(point[1]-segment.a[1])*sx)/Math.sqrt(sourceDenominator),candidateDistance=Math.max(distance(a),distance(b));
    if(candidateDistance>distanceTolerance)continue;
    const t=point=>((point[0]-a[0])*dx+(point[1]-a[1])*dy)/denominator,low=Math.max(0,Math.min(t(segment.a),t(segment.b))),high=Math.min(1,Math.max(t(segment.a),t(segment.b)));
    if(high<=low)continue;
    const u=point=>((point[0]-segment.a[0])*sx+(point[1]-segment.a[1])*sy)/sourceDenominator;
    matches.push({identity:indexed.identity,segment,low:Math.max(0,Math.min(u(a),u(b))),high:Math.min(1,Math.max(u(a),u(b)))});
    intervals.push([low,high]);
    maximumDistance=Math.max(maximumDistance,candidateDistance);
  }
  intervals.sort((first,second)=>first[0]-second[0]);
  let end=0,gap=0;
  for(const [low,high] of intervals){gap+=Math.max(0,low-end);end=Math.max(end,high);}
  gap+=Math.max(0,1-end);
  return {
    pass:gap*length<=gapTolerance&&matches.length>0,
    matches,
    maximumDistance,
    gapDegrees:gap*length,
    neighbors:[...new Set(matches.flatMap(match=>match.segment.identities).filter(candidate=>candidate!==identity))].sort(compareText),
    sourceSides:[...new Set(matches.flatMap(match=>[...(match.segment.sidesByIdentity.get(identity)??[])]))].sort((first,second)=>first-second),
    mapCuts:[...new Set(matches.flatMap(match=>[...(match.segment.mapCutsByIdentity.get(identity)??[])]))].sort(compareText),
  };
}

function boundaryMatches(a,b,index,options={}){
  const {distanceTolerance=BOUNDARY_DISTANCE_TOLERANCE_DEGREES}=options,box=new Envelope(Math.min(a[0],b[0]),Math.max(a[0],b[0]),Math.min(a[1],b[1]),Math.max(a[1],b[1]));
  box.expandBy(distanceTolerance);
  const identities=new Set();
  for(const iterator=index.globalTree.query(box).iterator();iterator.hasNext();)identities.add(iterator.next().identity);
  return [...identities].sort(compareText).map(identity=>({identity,...boundaryMatch(a,b,identity,index,options)})).filter(match=>match.matches.length>0);
}

function recordBoundaryCoverage(match,mapCut){
  let recorded=0;
  for(const item of match.matches){
    const {segment,identity}=item;
    if(mapCut===undefined||mapCut===null){
      if(!segment.ordinaryIdentities.has(identity))continue;
      segment.intervalsByIdentity.get(identity).push([item.low,item.high]);
    }else{
      if(typeof mapCut!=='string'||!mapCut)throw Error('Boundary coverage map-cut marker must be a non-empty string');
      const intervals=segment.periodicIntervalsByIdentity.get(identity)?.get(mapCut);
      if(!intervals)continue;
      intervals.push([item.low,item.high]);
    }
    recorded++;
  }
  return recorded;
}

const intervalGapDegrees=(segment,intervals)=>{const ordered=intervals.slice().sort((first,second)=>first[0]-second[0]||first[1]-second[1]);let end=0,gap=0;for(const [low,high] of ordered){gap+=Math.max(0,low-end);end=Math.max(end,high);}gap+=Math.max(0,1-end);return gap*Math.hypot(segment.b[0]-segment.a[0],segment.b[1]-segment.a[1]);};
const emptyCoverage=()=>({count:0,maximumGapDegrees:0,segments:0,degrees:0,gaps:[]});
const recordGap=(coverage,gapDegrees,length,detail)=>{coverage.segments++;coverage.degrees+=length;coverage.maximumGapDegrees=Math.max(coverage.maximumGapDegrees,gapDegrees);if(gapDegrees>FIXED_GRID_COVERAGE_TOLERANCE_DEGREES){coverage.count++;if(coverage.gaps.length<100)coverage.gaps.push({...detail,gapDegrees,length});}};

function uncoveredBoundaryCount(index){
  const ordinary=emptyCoverage(),periodic=emptyCoverage(),byMarker=new Map();
  for(const segment of index.segments.values()){
    const length=Math.hypot(segment.b[0]-segment.a[0],segment.b[1]-segment.a[1]);
    for(const identity of segment.identities){
      if(segment.ordinaryIdentities.has(identity))recordGap(ordinary,intervalGapDegrees(segment,segment.intervalsByIdentity.get(identity)),length,{identity,segment:[segment.a,segment.b]});
      for(const [mapCut,intervals] of segment.periodicIntervalsByIdentity.get(identity)){
        const gapDegrees=intervalGapDegrees(segment,intervals),detail={identity,mapCut,segment:[segment.a,segment.b]},coverage=byMarker.get(mapCut)??emptyCoverage();
        recordGap(coverage,gapDegrees,length,detail);
        byMarker.set(mapCut,coverage);
        recordGap(periodic,gapDegrees,length,detail);
      }
    }
  }
  const markers=[...byMarker].sort(([first],[second])=>compareText(first,second)).map(([mapCut,coverage])=>({mapCut,...coverage})),count=ordinary.count+periodic.count,maximumGapDegrees=Math.max(ordinary.maximumGapDegrees,periodic.maximumGapDegrees);
  return {count,maximumGapDegrees,ordinary,periodic:{...periodic,markers},mapCutSegments:periodic.segments,mapCutDegrees:periodic.degrees};
}

function classifyCells(left,right){
  if(!right)return 'coast';
  if(left.sourceCountryId!==right.sourceCountryId)return 'country';
  if(left.parentKey!==right.parentKey)return left.adminId===null||right.adminId===null?'residual':'administrative';
  return 'operational';
}

function edgeFlags(left,right,boundaryClass){
  return {
    positiveAdjacency:Boolean(right),
    country:boundaryClass==='country',
    administrative:Boolean(right)&&left.parentKey!==right.parentKey&&left.adminId!==null&&right.adminId!==null,
    residual:Boolean(right)&&left.parentKey!==right.parentKey&&(left.adminId===null||right.adminId===null),
    previous:!right||left.oldTerritoryId!==right.oldTerritoryId,
  };
}

function makeEdge(cells,leftOrdinal,rightOrdinal,a,b,ordinal){
  if(!Number.isInteger(leftOrdinal)||leftOrdinal<1||leftOrdinal>cells.length)throw Error('Invalid left cell ordinal');
  if(rightOrdinal!==0&&(!Number.isInteger(rightOrdinal)||rightOrdinal<1||rightOrdinal>cells.length||rightOrdinal===leftOrdinal))throw Error('Invalid right cell ordinal');
  const left=cells[leftOrdinal-1],right=rightOrdinal?cells[rightOrdinal-1]:null,boundaryClass=classifyCells(left,right),flags=edgeFlags(left,right,boundaryClass),geometry={type:'LineString',coordinates:[a,b]},lengthKm=distanceKm(a,b);
  if(!(lengthKm>0))throw Error('Topology edge is not a positive-length shared segment');
  const identity={leftCellId:left.id,rightCellId:right?.id??null,boundaryClass,flags,geometry};
  return {id:`edge:operational:${hashCanonical('prompt15-task-15-20-edge.v1',identity)}`,ordinal,left:leftOrdinal,right:rightOrdinal,boundaryClass,flags,geometry,lengthKm};
}

const perpendicularDistance=(point,[a,b])=>{const deltaX=b[0]-a[0],deltaY=b[1]-a[1],length=Math.hypot(deltaX,deltaY);return length?Math.abs((point[0]-a[0])*deltaY-(point[1]-a[1])*deltaX)/length:Math.hypot(point[0]-a[0],point[1]-a[1]);};

function validateSegmentRecord(record,cellCount){
  if(!Array.isArray(record)||record.length<4)throw Error('Malformed segment record');
  const [a,b,ordinal,side,mapCut=null]=record;
  if(!Array.isArray(a)||a.length!==2||!Array.isArray(b)||b.length!==2||[...a,...b].some(value=>!Number.isFinite(value))||comparePoint(a,b)>=0)throw Error('Segment record is not a finite canonical positive-length segment');
  if(!Number.isInteger(ordinal)||ordinal<1||ordinal>cellCount||!Number.isInteger(side)||![-0,0,1].includes(side))throw Error('Segment record has an invalid owner or side');
  if(mapCut!==null&&!['-180','180','pole:-90','pole:90'].includes(mapCut))throw Error('Segment record has an invalid map-cut marker');
  if((mapCut==='-180'||mapCut==='180')&&(a[0]!==-180||b[0]!==-180))throw Error('Longitude marker is not on the canonical antimeridian');
  if(mapCut?.startsWith('pole:')&&(a[1]!==Number(mapCut.slice(5))||b[1]!==Number(mapCut.slice(5))))throw Error('Pole marker is not on its named latitude');
}

function nodeReplayBuckets(input,output,cellCount){
  fs.mkdirSync(output,{recursive:true});
  const descriptors=Array.from({length:TOPOLOGY_BUCKETS},(_,index)=>fs.openSync(path.join(output,`${index}.ndjson`),'w')),unpaired=new ArrayList(),precisionModel=new PrecisionModel(PRECISION_SCALE);
  let occurrences=0,pairedOccurrences=0,endpointOccurrences=0,roundedEndpointOccurrences=0,maximumEndpointRoundingDisplacement=0;
  const emitRecord=record=>fs.writeSync(descriptors[segmentBucket(segmentKey(record[0],record[1]))],`${JSON.stringify(record)}\n`);
  try{
    for(let bucketIndex=0;bucketIndex<TOPOLOGY_BUCKETS;bucketIndex++){
      const groups=new Map(),file=path.join(input,`${bucketIndex}.ndjson`);
      for(const line of fs.readFileSync(file,'utf8').split('\n'))if(line){
        const record=JSON.parse(line);
        validateSegmentRecord(record,cellCount);
        const key=segmentKey(record[0],record[1]);
        if(segmentBucket(key)!==bucketIndex)throw Error('Raw segment record is in the wrong deterministic bucket');
        const list=groups.get(key)??[];
        list.push(record);
        groups.set(key,list);
        occurrences++;
      }
      for(const list of groups.values()){
        if(list.length===2&&list[0][3]!==list[1][3]){
          for(const record of list)emitRecord(record);
          pairedOccurrences+=2;
          continue;
        }
        for(const record of list){
          const originalSegment=[record[0],record[1]],roundedSegment=originalSegment.map(([x,y])=>{
            const coordinate=new Coordinate(x,y);
            precisionModel.makePrecise(coordinate);
            const displacement=Math.hypot(coordinate.x-x,coordinate.y-y);
            endpointOccurrences++;
            if(displacement)roundedEndpointOccurrences++;
            maximumEndpointRoundingDisplacement=Math.max(maximumEndpointRoundingDisplacement,displacement);
            return coordinate;
          });
          unpaired.add(new NodedSegmentString(roundedSegment,{record,originalSegment}));
        }
      }
    }
    const noder=new MCIndexSnapRounder(precisionModel);
    noder.computeNodes(unpaired);
    const nodedSubstrings=noder.getNodedSubstrings();
    let outputOccurrences=pairedOccurrences,insertedNodeOccurrences=0,maximumInsertedNodePerpendicularDisplacement=0;
    for(const iterator=unpaired.iterator();iterator.hasNext();){
      const segmentString=iterator.next(),{originalSegment}=segmentString.getData();
      for(const nodes=segmentString.getNodeList().iterator();nodes.hasNext();){
        const node=nodes.next();
        if(!node.isInterior())continue;
        const displacement=perpendicularDistance([node.coord.x,node.coord.y],originalSegment);
        insertedNodeOccurrences++;
        maximumInsertedNodePerpendicularDisplacement=Math.max(maximumInsertedNodePerpendicularDisplacement,displacement);
      }
    }
    for(const iterator=nodedSubstrings.iterator();iterator.hasNext();){
      const segmentString=iterator.next(),coordinates=segmentString.getCoordinates(),{record}=segmentString.getData();
      for(let index=1;index<coordinates.length;index++){
        let a=[coordinates[index-1].x,coordinates[index-1].y],b=[coordinates[index].x,coordinates[index].y],side=record[3];
        if(comparePoint(a,b)===0)continue;
        if(comparePoint(a,b)>0){[a,b]=[b,a];side=1-side;}
        const outputRecord=record.slice();
        outputRecord[0]=a;
        outputRecord[1]=b;
        outputRecord[3]=side;
        if(!sameValue(outputRecord.slice(4),record.slice(4)))throw Error('Snap-round replay did not preserve record metadata');
        emitRecord(outputRecord);
        outputOccurrences++;
      }
    }
    const endpointRoundingPass=maximumEndpointRoundingDisplacement<=DISPLACEMENT_LIMIT_DEGREES,insertedNodePerpendicularPass=maximumInsertedNodePerpendicularDisplacement<=DISPLACEMENT_LIMIT_DEGREES,maximumDisplacement=Math.max(maximumEndpointRoundingDisplacement,maximumInsertedNodePerpendicularDisplacement);
    return {
      occurrences,
      pairedOccurrences,
      unpairedOccurrences:unpaired.size(),
      outputOccurrences,
      maximumDisplacement,
      maximumEndpointRoundingDisplacement,
      maximumInsertedNodePerpendicularDisplacement,
      pass:endpointRoundingPass&&insertedNodePerpendicularPass,
      algorithm:'Exact already-paired records are emitted unchanged. Unmatched endpoints are rounded by a fixed scale-1e12 PrecisionModel and commonly noded by MCIndexSnapRounder; split records retain every input metadata field.',
      evidence:{
        precisionModel:{type:'fixed',scale:PRECISION_SCALE},
        maximumAllowedDisplacementDegrees:DISPLACEMENT_LIMIT_DEGREES,
        originalEndpointRounding:{occurrences:endpointOccurrences,changedOccurrences:roundedEndpointOccurrences,maximumDisplacementDegrees:maximumEndpointRoundingDisplacement,pass:endpointRoundingPass},
        insertedNodeTrace:{occurrences:insertedNodeOccurrences,metric:'perpendicular distance to the original unrounded input segment',maximumDisplacementDegrees:maximumInsertedNodePerpendicularDisplacement,pass:insertedNodePerpendicularPass},
        recordPreservation:'Only split endpoints and the canonical-direction side field may change; ordinal and every additional input record field are emitted unchanged.',
      },
    };
  }finally{
    for(const descriptor of descriptors)fs.closeSync(descriptor);
  }
}

function csrEntries(groups,metadataForKey){
  const cellOrdinals=[],entries=[];
  for(const key of [...groups.keys()].sort(compareText)){
    const ordinals=groups.get(key).slice().sort((first,second)=>first-second),metadata=metadataForKey(key);
    entries.push({...metadata,start:cellOrdinals.length,count:ordinals.length});
    cellOrdinals.push(...ordinals);
  }
  return {entries,cellOrdinals};
}

function validateMembershipIndexes(cells,administrative,previous){
  const errors=[],administrativeSeen=new Uint8Array(cells.length+1),previousSeen=new Uint8Array(cells.length+1),parentKeys=new Set(),oldIds=new Set();
  if(administrative?.cellCount!==cells.length||previous?.cellCount!==cells.length)errors.push('cell-count');
  const administrativeParents=Array.isArray(administrative?.parents)?administrative.parents:[],administrativeOrdinals=Array.isArray(administrative?.cellOrdinals)?administrative.cellOrdinals:[],previousParents=Array.isArray(previous?.parents)?previous.parents:[],previousOrdinals=Array.isArray(previous?.cellOrdinals)?previous.cellOrdinals:[],previousForward=Array.isArray(previous?.oldParentOrdinalByCell)?previous.oldParentOrdinalByCell:[];
  const boundedShape=Array.isArray(administrative?.parents)&&Array.isArray(administrative?.cellOrdinals)&&Array.isArray(previous?.parents)&&Array.isArray(previous?.cellOrdinals)&&Array.isArray(previous?.oldParentOrdinalByCell)&&administrativeParents.length<=cells.length&&previousParents.length<=cells.length&&administrativeOrdinals.length===cells.length&&previousOrdinals.length===cells.length&&previousForward.length===cells.length;
  if(!boundedShape){
    errors.push('csr-shape');
    if(administrativeOrdinals.length!==cells.length)errors.push('administrative-csr-length');
    if(previousOrdinals.length!==cells.length)errors.push('previous-csr-length');
    if(previousForward.length!==cells.length)errors.push('previous-forward-count');
    return {pass:false,errors:[...new Set(errors)].sort(compareText),counts:{cells:cells.length,administrativeParents:0,previousParents:0,administrativeMemberships:0,previousMemberships:0}};
  }
  let cursor=0,priorKey=null;
  for(const parent of administrativeParents){
    const end=parent.start+parent.count,rangeValid=Number.isSafeInteger(parent.start)&&parent.start>=0&&Number.isSafeInteger(parent.count)&&parent.count>0&&Number.isSafeInteger(end)&&end<=administrativeOrdinals.length;
    if(typeof parent.parentKey!=='string'||parentKeys.has(parent.parentKey)||!rangeValid||parent.start!==cursor||priorKey!==null&&compareText(priorKey,parent.parentKey)>=0)errors.push('administrative-parent-contract');
    priorKey=parent.parentKey;
    parentKeys.add(parent.parentKey);
    if(!rangeValid)continue;
    let priorOrdinal=0;
    for(let index=parent.start;index<end;index++){
      const ordinal=administrativeOrdinals[index],cell=Number.isInteger(ordinal)&&ordinal>=1&&ordinal<=cells.length?cells[ordinal-1]:null;
      if(!cell||administrativeSeen[ordinal]||ordinal<=priorOrdinal||cell.parentKey!==parent.parentKey||cell.sourceCountryId!==parent.sourceCountryId||cell.adminId!==parent.adminId)errors.push('administrative-membership');
      if(cell)administrativeSeen[ordinal]=1;
      priorOrdinal=ordinal;
    }
    cursor=end;
  }
  if(cursor!==administrativeOrdinals.length)errors.push('administrative-csr-length');
  for(let ordinal=1;ordinal<=cells.length;ordinal++)if(administrativeSeen[ordinal]!==1)errors.push('administrative-omission');
  cursor=0;
  priorKey=null;
  for(const parent of previousParents){
    const end=parent.start+parent.count,rangeValid=Number.isSafeInteger(parent.start)&&parent.start>=0&&Number.isSafeInteger(parent.count)&&parent.count>0&&Number.isSafeInteger(end)&&end<=previousOrdinals.length;
    if(typeof parent.oldTerritoryId!=='string'||oldIds.has(parent.oldTerritoryId)||!rangeValid||parent.start!==cursor||priorKey!==null&&compareText(priorKey,parent.oldTerritoryId)>=0)errors.push('previous-parent-contract');
    priorKey=parent.oldTerritoryId;
    oldIds.add(parent.oldTerritoryId);
    if(!rangeValid)continue;
    let priorOrdinal=0;
    for(let index=parent.start;index<end;index++){
      const ordinal=previousOrdinals[index],cell=Number.isInteger(ordinal)&&ordinal>=1&&ordinal<=cells.length?cells[ordinal-1]:null;
      if(!cell||previousSeen[ordinal]||ordinal<=priorOrdinal||cell.oldTerritoryId!==parent.oldTerritoryId||cell.sourceCountryId!==parent.sourceCountryId)errors.push('previous-parent-membership');
      if(cell)previousSeen[ordinal]=1;
      priorOrdinal=ordinal;
    }
    cursor=end;
  }
  if(cursor!==previousOrdinals.length)errors.push('previous-csr-length');
  for(let ordinal=1;ordinal<=cells.length;ordinal++){
    const parentOrdinal=previousForward[ordinal-1],parent=Number.isInteger(parentOrdinal)&&parentOrdinal>=1&&parentOrdinal<=previousParents.length?previousParents[parentOrdinal-1]:null;
    if(!parent||parent.oldTerritoryId!==cells[ordinal-1].oldTerritoryId)errors.push('previous-forward-mapping');
  }
  for(let ordinal=1;ordinal<=cells.length;ordinal++)if(previousSeen[ordinal]!==1)errors.push('previous-parent-omission');
  return {pass:errors.length===0,errors:[...new Set(errors)].sort(compareText),counts:{cells:cells.length,administrativeParents:parentKeys.size,previousParents:oldIds.size,administrativeMemberships:administrativeSeen.reduce((sum,value)=>sum+value,0),previousMemberships:previousSeen.reduce((sum,value)=>sum+value,0)}};
}

function buildArtifactReplay(root,index,fail){
  const indexed=new Map(),indexPaths=[];
  const artifacts=Array.isArray(index?.artifacts)?index.artifacts:[];
  if(!Array.isArray(index?.artifacts))fail('artifact-index-shape','artifacts must be an array');
  if(artifacts.length>V20_ARTIFACTS.length)fail('artifact-index-count-limit',{actual:artifacts.length,maximum:V20_ARTIFACTS.length});
  const indexedTotalValid=Number.isSafeInteger(index?.totalByteLength)&&index.totalByteLength>=0&&index.totalByteLength<=MAX_INDEXED_TOTAL_BYTES;
  if(!indexedTotalValid)fail('artifact-index-total-limit',{actual:index?.totalByteLength,maximum:MAX_INDEXED_TOTAL_BYTES});
  for(const artifact of artifacts.slice(0,V20_ARTIFACTS.length)){
    if(!validIndexedArtifact(artifact,true)){fail('invalid-artifact-record',artifact?.path);continue;}
    if(indexed.has(artifact.path)){fail('duplicate-artifact-path',artifact.path);continue;}
    indexed.set(artifact.path,artifact);
    indexPaths.push(artifact.path);
    if(artifact.byteLength>MAX_INDEXED_ARTIFACT_BYTES){fail('artifact-byte-limit',{path:artifact.path,actual:artifact.byteLength,maximum:MAX_INDEXED_ARTIFACT_BYTES});continue;}
    try{
      const target=resolveBelow(root,artifact.path),size=fs.statSync(target).size;
      if(size!==artifact.byteLength)fail('artifact-byte-length',{path:artifact.path,actual:size,expected:artifact.byteLength});
      else if(!sameIdentity(fileIdentity(target),artifact))fail('artifact-identity',artifact.path);
    }catch(error){fail('artifact-readable',{path:artifact.path,message:error.message});}
  }
  const disk=(()=>{try{return filesBelow(root).filter(file=>file!=='artifact-index.json').sort(compareText);}catch(error){fail('artifact-tree-readable',error.message);return [];}})();
  const artifactSet=exactArray(indexPaths,indexPaths.slice().sort(compareText))&&exactArray(indexPaths,V20_ARTIFACTS)&&exactArray(disk,V20_ARTIFACTS),artifactBytes=indexedTotalValid&&[...indexed.values()].every(artifact=>artifact.byteLength<=MAX_INDEXED_ARTIFACT_BYTES)&&[...indexed.values()].reduce((sum,artifact)=>sum+artifact.byteLength,0)===index.totalByteLength;
  const expected=new Map();
  const readGzip=(relative)=>{
    const limits=OUTPUT_GZIP_LIMITS.get(relative),record=indexed.get(relative);
    if(!limits)throw Error(`No bounded gzip contract for ${relative}`);
    if(!record||record.compression!=='gzip')throw Error(`Missing indexed gzip artifact ${relative}`);
    if(record.byteLength>limits.compressed)throw Error(`Indexed gzip artifact exceeds its compressed-byte limit: ${relative}`);
    const target=resolveBelow(root,relative),size=fs.statSync(target).size;
    if(size!==record.byteLength)throw Error(`Indexed gzip byte length changed: ${relative}`);
    const compressed=fs.readFileSync(target);
    if(digest(compressed)!==record.sha256)throw Error(`Indexed gzip digest changed: ${relative}`);
    return JSON.parse(gunzipSync(compressed,{maxOutputLength:limits.uncompressed}).toString('utf8'));
  };
  const replay=(relative,value,compressed=false)=>{
    const bytes=compressed?gzipSync(jsonBytes(value),{level:9,mtime:0}):jsonBytes(value),identity=identityForBytes(relative,bytes),record={path:relative,sha256:identity.sha256,byteLength:identity.byteLength,compression:compressed?'gzip':null};
    expected.set(relative,record);
    const indexedRecord=indexed.get(relative);
    if(!indexedRecord||!sameValue(indexedRecord,record))fail('artifact-index-replay',{path:relative,actual:indexedRecord,expected:record});
    try{
      const actual=fs.readFileSync(resolveBelow(root,relative));
      if(!actual.equals(bytes))fail('artifact-byte-replay',{path:relative,actual:fileIdentity(resolveBelow(root,relative)),expected:identity});
    }catch(error){fail('artifact-byte-readable',{path:relative,message:error.message});}
    return record;
  };
  const finish=(expectedRoot,command)=>{
    const artifacts=[...expected.values()].sort((first,second)=>compareText(first.path,second.path)),expectedIndex={schemaVersion:TASK_15_20_VERSION,root:expectedRoot,artifacts,totalByteLength:artifacts.reduce((sum,artifact)=>sum+artifact.byteLength,0),command};
    if(!exactArray(artifacts.map(artifact=>artifact.path),V20_ARTIFACTS))fail('expected-artifact-set',artifacts.map(artifact=>artifact.path));
    const bytes=jsonBytes(expectedIndex);
    try{if(!fs.readFileSync(path.join(root,'artifact-index.json')).equals(bytes))fail('artifact-index-byte-replay',{actual:fileIdentity(path.join(root,'artifact-index.json')),expected:identityForBytes('artifact-index.json',bytes)});}catch(error){fail('artifact-index-byte-readable',error.message);}
    return {artifacts,expectedIndex};
  };
  return {indexed,indexPaths,artifactSet,artifactBytes,readGzip,replay,finish,expected};
}

function collectCatalogEvidence(countryOrder,fail){
  const cells=[],parentEvidence=new Map(),protectedRepairNet=new Map(),administrativeRepairNet=new Map(),geometryRepairLedger=[],protectedBoundaryRepairs=[],administrativeBoundaryRepairs=[],geometryProperties=new Map(),generationComponents=new Map();
  for(const countryId of countryOrder){
    const prefix=`${WORLD_CATALOG_ROOT}/countries/${countryId}`,catalog=readGzipJSON(`${prefix}/catalog.json.gz`),generation=readGzipJSON(`${prefix}/generation.json.gz`);
    if(generation.countryId!==countryId||generation.status!=='pass'||!Object.values(generation.checks??{}).every(Boolean))fail('country-generation-status',countryId);
    if((generation.numericalGapRepairs??[]).length)fail('unsupported-gap-repair-ledger',{countryId,count:generation.numericalGapRepairs.length});
    for(const parent of generation.parents??[]){
      if(parentEvidence.has(parent.parentKey))fail('duplicate-parent-evidence',parent.parentKey);
      parentEvidence.set(parent.parentKey,parent);
    }
    for(const component of generation.sourceComponents??[]){
      const key=`${component.parentKey}:${component.componentIndex}`;
      if(generationComponents.has(key))fail('duplicate-source-component',key);
      generationComponents.set(key,component.sourceHash);
    }
    for(const repair of generation.numericalProtectedFragmentRepairs??[]){
      const common=Number.isFinite(repair.area)&&repair.area>0&&repair.area<=1e-12&&typeof repair.geometryHash==='string'&&typeof repair.assignedOldTerritoryId==='string'&&typeof repair.sourceOldTerritoryId==='string',kindSpecific=repair.kind==='uncovered-numerical-component-assignment'?repair.sourceOldTerritoryId==='numerical-unassigned'&&Number.isFinite(repair.distance)&&repair.distance<=1e-12:repair.kind==='collapsed-protected-fragment-union'&&typeof repair.beforeGeometryHash==='string'&&typeof repair.afterGeometryHash==='string';
      if(!common||!kindSpecific)fail('protected-repair-ledger',{countryId,repair});
      const evidence={countryId,ledger:'protected',...repair};
      geometryRepairLedger.push(evidence);
      if(repair.kind==='collapsed-protected-fragment-union')protectedBoundaryRepairs.push(evidence);
      kahanAdd(protectedRepairNet,repair.assignedOldTerritoryId,repair.area);
      if(repair.sourceOldTerritoryId!=='numerical-unassigned')kahanAdd(protectedRepairNet,repair.sourceOldTerritoryId,-repair.area);
    }
    const allowedCellRepairKinds=new Set(['lost-source-face-union','pre-noding-collapsed-ring-union','collapsed-component-ledger']);
    for(const repair of generation.numericalCellRepairs??[]){
      const valid=allowedCellRepairKinds.has(repair.kind)&&Number.isFinite(repair.area)&&repair.area>0&&repair.area<=1e-12&&typeof repair.assignedOldTerritoryId==='string'&&typeof repair.sourceOldTerritoryId==='string'&&typeof repair.parentKey==='string'&&typeof repair.lostGeometryHash==='string'&&typeof repair.lostSourceFeatureId==='string'&&typeof repair.beforeTargetSourceFeatureId==='string'&&typeof repair.afterTargetSourceFeatureId==='string';
      if(!valid)fail('cell-repair-ledger',{countryId,repair});
      const evidence={countryId,ledger:'cell',...repair};
      geometryRepairLedger.push(evidence);
      administrativeBoundaryRepairs.push(evidence);
      if(repair.kind==='collapsed-component-ledger'){
        kahanAdd(protectedRepairNet,repair.assignedOldTerritoryId,-repair.area);
        kahanAdd(administrativeRepairNet,repair.parentKey,-repair.area);
      }else if(repair.sourceOldTerritoryId!==repair.assignedOldTerritoryId){
        kahanAdd(protectedRepairNet,repair.assignedOldTerritoryId,repair.area);
        kahanAdd(protectedRepairNet,repair.sourceOldTerritoryId,-repair.area);
      }
    }
    for(const repair of generation.topologySourceRepairs??[]){
      const valid=repair.kind==='fixed-p0-overlap-wedge-removal'&&repair.countryId===countryId&&Number.isFinite(repair.removedAreaDegrees)&&repair.removedAreaDegrees>0&&typeof repair.oldTerritoryId==='string'&&typeof repair.parentKey==='string';
      if(!valid)fail('topology-source-repair-ledger',{countryId,repair});
      const evidence={countryId,ledger:'topology-source',...repair};
      geometryRepairLedger.push(evidence);
      kahanAdd(protectedRepairNet,repair.oldTerritoryId,-repair.removedAreaDegrees);
      kahanAdd(administrativeRepairNet,repair.parentKey,-repair.removedAreaDegrees);
    }
    for(const entry of catalog.entries??[]){
      const cell={id:entry.id,sourceCountryId:entry.sourceCountryId,parentKey:entry.parentKey,parentSourceFeatureId:String(entry.parentSourceFeatureId),adminId:entry.adminId===null?null:String(entry.adminId),oldTerritoryId:entry.oldTerritoryId,sourceComponentHash:entry.sourceComponentHash,componentIndex:entry.componentIndex};
      cells.push(cell);
      geometryProperties.set(entry.id,{cellId:entry.id,sourceCountryId:entry.sourceCountryId,oldTerritoryId:entry.oldTerritoryId,adminId:entry.adminId,parentKey:entry.parentKey,parentSourceFeatureId:entry.parentSourceFeatureId,componentIndex:entry.componentIndex,refined:entry.refined});
    }
  }
  cells.sort((first,second)=>compareText(first.id,second.id));
  if(new Set(cells.map(cell=>cell.id)).size!==cells.length)fail('duplicate-cell-id',cells.length);
  return {cells,parentEvidence,protectedRepairNet,administrativeRepairNet,geometryRepairLedger,protectedBoundaryRepairs,administrativeBoundaryRepairs,geometryProperties,generationComponents};
}

function buildExpectedMemberships(cells,sources,parentEvidence,generationComponents,fail){
  const sourceParentByKey=new Map(),sourceComponentHashes=new Map(),reconstructedComponentKeys=new Set(),referencedComponentKeys=new Set();
  for(const feature of sources.selected.features){
    const parentKey=`${feature.properties.countryId}:${feature.properties.sourceFeatureId}`;
    if(sourceParentByKey.has(parentKey))fail('duplicate-administrative-source',parentKey);
    sourceParentByKey.set(parentKey,feature);
    const componentHashes=polygons(feature.geometry).map((coordinates,componentIndex)=>{reconstructedComponentKeys.add(`${parentKey}:${componentIndex}`);return digest(jsonBytes(normalizeGeometry({type:'Polygon',coordinates})));});
    sourceComponentHashes.set(parentKey,componentHashes);
  }
  const protectedById=new Map();
  for(const feature of sources.protectedOverlay.features){
    const id=feature.properties.territoryId;
    if(protectedById.has(id))fail('duplicate-previous-source',id);
    protectedById.set(id,feature);
  }
  const administrativeGroups=new Map(),previousGroups=new Map();
  for(const [index,cell] of cells.entries()){
    const ordinal=index+1,administrative=administrativeGroups.get(cell.parentKey)??[],previous=previousGroups.get(cell.oldTerritoryId)??[];
    administrative.push(ordinal);
    administrativeGroups.set(cell.parentKey,administrative);
    previous.push(ordinal);
    previousGroups.set(cell.oldTerritoryId,previous);
    const componentKey=`${cell.parentKey}:${cell.componentIndex}`,componentHashes=sourceComponentHashes.get(cell.parentKey),expectedHash=Number.isInteger(cell.componentIndex)?componentHashes?.[cell.componentIndex]:null,generationHash=generationComponents.get(componentKey);
    referencedComponentKeys.add(componentKey);
    if(typeof cell.sourceComponentHash!=='string'||!cell.sourceComponentHash||cell.sourceComponentHash!==expectedHash||cell.sourceComponentHash!==generationHash)fail('source-component-lineage',{cellId:cell.id,parentKey:cell.parentKey,componentIndex:cell.componentIndex,actual:cell.sourceComponentHash,source:expectedHash,generation:generationHash});
  }
  const generationComponentKeys=new Set(generationComponents.keys());
  if(!setEquals(reconstructedComponentKeys,generationComponentKeys)||[...referencedComponentKeys].some(key=>!generationComponentKeys.has(key)))fail('source-component-correspondence',{referenced:referencedComponentKeys.size,reconstructed:reconstructedComponentKeys.size,generation:generationComponents.size});
  const administrativeKeys=new Set(administrativeGroups.keys()),sourceKeys=new Set(sourceParentByKey.keys()),evidenceKeys=new Set(parentEvidence.keys());
  if(!setEquals(administrativeKeys,sourceKeys)||!setEquals(administrativeKeys,evidenceKeys))fail('administrative-source-correspondence',{membership:administrativeKeys.size,source:sourceKeys.size,evidence:evidenceKeys.size});
  const previousKeys=new Set(previousGroups.keys()),protectedKeys=new Set(protectedById.keys());
  if(!setEquals(previousKeys,protectedKeys))fail('previous-source-correspondence',{membership:previousKeys.size,source:protectedKeys.size});
  const administrativeCsr=csrEntries(administrativeGroups,parentKey=>{
    const source=sourceParentByKey.get(parentKey),evidence=parentEvidence.get(parentKey);
    if(!source||!evidence)throw Error(`Unknown administrative source ${parentKey}`);
    const geometryHash=digest(jsonBytes(normalizeGeometry(source.geometry)));
    if(geometryHash!==evidence.parentHash)fail('administrative-parent-hash',{parentKey,source:geometryHash,generation:evidence.parentHash});
    const properties=source.properties,kind=evidence.inputRole==='P1'?'administrative':'country-envelope-residual';
    return {parentKey,sourceCountryId:properties.countryId,sourceFeatureId:String(properties.sourceFeatureId),adminId:evidence.adminId===null?null:String(evidence.adminId),kind,name:properties.name??null,sourceVersion:properties.sourceVersion??null,restorationId:properties.restorationId??null,residualId:properties.residualId??null,parentGeometryHash:geometryHash,inputRole:evidence.inputRole};
  });
  const administrative={schemaVersion:TASK_15_20_VERSION,cellCount:cells.length,parents:administrativeCsr.entries,cellOrdinals:administrativeCsr.cellOrdinals,contract:'Complete untruncated same-level administrative or explicit country-envelope-residual membership. Ordinals address catalog-order.json.gz.'};
  const previousCsr=csrEntries(previousGroups,oldTerritoryId=>{
    const source=protectedById.get(oldTerritoryId);
    if(!source)throw Error(`Unknown previous source ${oldTerritoryId}`);
    return {oldTerritoryId,sourceCountryId:source.properties.sourceCountryId,geometryHash:digest(jsonBytes(normalizeGeometry(source.geometry)))};
  });
  const oldOrdinalById=new Map(previousCsr.entries.map((entry,index)=>[entry.oldTerritoryId,index+1])),previous={schemaVersion:TASK_15_20_VERSION,cellCount:cells.length,parents:previousCsr.entries,cellOrdinals:previousCsr.cellOrdinals,oldParentOrdinalByCell:cells.map(cell=>oldOrdinalById.get(cell.oldTerritoryId)),contract:'Every cell has exactly one protected previous-geometry parent; reverse membership is complete and untruncated.'};
  return {administrative,previous,sourceParentByKey,protectedById};
}

function sameFlatObject(actual,expected){
  return actual&&expected&&exactKeySet(actual,Object.keys(expected))&&Object.keys(expected).every(key=>Object.is(actual[key],expected[key]));
}

function validNodedOccurrence(record,cellCount,bucketIndex){
  try{
    validateSegmentRecord(record,cellCount);
    return segmentBucket(segmentKey(record[0],record[1]))===bucketIndex;
  }catch{return false;}
}

function replayWorldTopology({cells,countryOrder,geometryProperties,sources,protectedBoundaryRepairs,administrativeBoundaryRepairs,artifactReplay,fail}){
  const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'prompt15-v20-independent-')),rawBuckets=path.join(temporary,'raw'),nodedBuckets=path.join(temporary,'noded'),administrativeArea=new Map(),previousArea=new Map(),geometrySeen=new Uint8Array(cells.length+1),byId=new Map(cells.map((cell,index)=>[cell.id,index+1]));
  fs.mkdirSync(rawBuckets,{recursive:true});
  const descriptors=Array.from({length:TOPOLOGY_BUCKETS},(_,index)=>fs.openSync(path.join(rawBuckets,`${index}.ndjson`),'w'));
  try{
    try{
      for(const countryId of countryOrder){
        const geometry=readGzipJSON(`${WORLD_CATALOG_ROOT}/countries/${countryId}/geometry.geojson.gz`),buffers=Array.from({length:TOPOLOGY_BUCKETS},()=>[]);
        if(geometry?.type!=='FeatureCollection'||!Array.isArray(geometry.features))throw Error(`Invalid geometry collection ${countryId}`);
        for(const feature of geometry.features){
          const cellId=feature.properties?.cellId,ordinal=byId.get(cellId),expectedProperties=geometryProperties.get(cellId);
          if(!ordinal||geometrySeen[ordinal])throw Error(`Unknown or duplicate geometry cell ${cellId}`);
          if(!sameFlatObject(feature.properties,expectedProperties))throw Error(`Geometry source metadata changed: ${cellId}`);
          if(feature.geometry?.type!=='Polygon'||polygons(feature.geometry).length!==1)throw Error(`Operational cell is not exactly one Polygon component: ${cellId}`);
          const cell=cells[ordinal-1];
          if(typeof cell.sourceComponentHash!=='string'||!cell.sourceComponentHash)throw Error(`Cell lacks source-component lineage: ${cell.id}`);
          geometrySeen[ordinal]=1;
          const area=planarArea(feature.geometry);
          kahanAdd(administrativeArea,cell.parentKey,area);
          kahanAdd(previousArea,cell.oldTerritoryId,area);
          for(const record of geometrySegmentRecords(feature,ordinal)){
            validateSegmentRecord(record,cells.length);
            const bucket=segmentBucket(segmentKey(record[0],record[1]));
            buffers[bucket].push(`${JSON.stringify(record)}\n`);
          }
        }
        for(let index=0;index<TOPOLOGY_BUCKETS;index++)if(buffers[index].length)fs.writeSync(descriptors[index],buffers[index].join(''));
      }
    }finally{
      for(const descriptor of descriptors)fs.closeSync(descriptor);
    }
    if(geometrySeen.reduce((sum,value)=>sum+value,0)!==cells.length)throw Error('Geometry census did not see every catalog cell exactly once');

    const globalNoding=nodeReplayBuckets(rawBuckets,nodedBuckets,cells.length),p0Index=boundaryIndex(sources.p0),protectedIndex=boundaryIndex(sources.protectedOverlay,feature=>feature.properties.territoryId),parentIndex=boundaryIndex(sources.selected,feature=>`${feature.properties.countryId}:${feature.properties.sourceFeatureId}`),sourceParentByKey=new Map(sources.selected.features.map(feature=>[`${feature.properties.countryId}:${feature.properties.sourceFeatureId}`,feature])),adjacency=Array.from({length:cells.length},()=>[]),errors=[],numericalBoundaryRepairs=[],protectedRepairCache=new Map(),topologyArtifacts=[],adjacencyWitnesses=new Map();
    let errorCount=0,edgeCount=0,adjacentSegmentCount=0,maximumBoundaryDisplacement=0,maximumNumericalRepairBoundaryDisplacement=0,sameDirectionPairs=0,duplicateOccurrences=0;
    const classCounts={coast:0,country:0,administrative:0,residual:0,operational:0},mapCutEvidence={longitudeAdjacency:0,longitudeSelfClosure:0,longitudeOpenClosure:0,polarClosure:0,validatedOwnerMarkers:0},parentCoverageEvidence={ordinaryQueries:0,periodicQueries:0,additionalIdentities:0,recordedIntervals:0,maximumAdditionalIdentitiesPerQuery:0},p0SideRepairs=[];
    const reject=(kind,detail)=>{const safeDetail=reportDetail(detail);errorCount++;if(errors.length<100)errors.push({kind,detail:safeDetail});fail(`topology-${kind}`,safeDetail);};
    if(!globalNoding.pass)reject('global-noding-displacement-limit',globalNoding);
    const acceptCoverage=(match,mapCut=null,numericalRepair=false)=>{
      if(match.matches.length)recordBoundaryCoverage(match,mapCut);
      if(Number.isFinite(match.maximumDistance)){
        if(numericalRepair)maximumNumericalRepairBoundaryDisplacement=Math.max(maximumNumericalRepairBoundaryDisplacement,match.maximumDistance);
        else maximumBoundaryDisplacement=Math.max(maximumBoundaryDisplacement,match.maximumDistance);
      }
    };
    const acceptCorrespondingParentCoverage=(a,b,owners,mapCut=null)=>{
      const ownerCells=owners.map(owner=>cells[owner-1]),ownerParentKeys=new Set(ownerCells.map(cell=>cell.parentKey)),ownerCountries=new Set(ownerCells.map(cell=>cell.sourceCountryId));
      if(mapCut===null)parentCoverageEvidence.ordinaryQueries++;
      else parentCoverageEvidence.periodicQueries++;
      let additionalIdentities=0;
      for(const match of boundaryMatches(a,b,parentIndex)){
        if(ownerParentKeys.has(match.identity))continue;
        const source=sourceParentByKey.get(match.identity);
        if(!source||!ownerCountries.has(source.properties.countryId)||mapCut!==null&&!match.mapCuts.includes(mapCut))continue;
        const recorded=recordBoundaryCoverage(match,mapCut);
        if(!recorded)continue;
        additionalIdentities++;
        parentCoverageEvidence.recordedIntervals+=recorded;
        if(Number.isFinite(match.maximumDistance))maximumBoundaryDisplacement=Math.max(maximumBoundaryDisplacement,match.maximumDistance);
      }
      parentCoverageEvidence.additionalIdentities+=additionalIdentities;
      parentCoverageEvidence.maximumAdditionalIdentitiesPerQuery=Math.max(parentCoverageEvidence.maximumAdditionalIdentitiesPerQuery,additionalIdentities);
    };
    const validateMapCutOwner=(a,b,ordinal,mapCut)=>{
      const cell=cells[ordinal-1],matches=[[cell.sourceCountryId,p0Index],[cell.oldTerritoryId,protectedIndex],[cell.parentKey,parentIndex]];
      let valid=true;
      for(const [identity,index] of matches){
        const match=boundaryMatch(a,b,identity,index);
        if(!match.pass||!match.mapCuts.includes(mapCut)){reject('invalid-map-cut-closure',{segment:[a,b],owner:ordinal,identity,mapCut,gapDegrees:match.gapDegrees});valid=false;}
        else{acceptCoverage(match,mapCut);mapCutEvidence.validatedOwnerMarkers++;}
      }
      return valid;
    };
    const protectedRepairsForCell=cell=>{
      if(protectedRepairCache.has(cell.id))return protectedRepairCache.get(cell.id);
      const candidates=protectedBoundaryRepairs.filter(repair=>repair.countryId===cell.sourceCountryId&&repair.assignedOldTerritoryId===cell.oldTerritoryId),targets=new Set([cell.sourceComponentHash]),result=[];
      let changed=true;
      while(changed){
        changed=false;
        for(const repair of candidates)if(!result.includes(repair)&&targets.has(repair.afterGeometryHash)){result.push(repair);targets.add(repair.beforeGeometryHash);changed=true;}
      }
      protectedRepairCache.set(cell.id,result);
      return result;
    };
    const admitProtectedRepair=(a,b,owner,otherOwner)=>{
      const cell=cells[owner-1],other=otherOwner?cells[otherOwner-1]:null,options={distanceTolerance:NUMERICAL_REPAIR_BOUNDARY_TOLERANCE_DEGREES,gapTolerance:NUMERICAL_REPAIR_BOUNDARY_TOLERANCE_DEGREES},cellLineage=new Set(protectedRepairsForCell(cell)),otherLineage=new Set(other?protectedRepairsForCell(other):[]),candidates=protectedBoundaryRepairs.filter(repair=>repair.countryId===cell.sourceCountryId&&repair.sourceOldTerritoryId!=='numerical-unassigned'&&repair.sourceOldTerritoryId!==repair.assignedOldTerritoryId&&(!other?repair.assignedOldTerritoryId===cell.oldTerritoryId:new Set([repair.sourceOldTerritoryId,repair.assignedOldTerritoryId]).size===2&&[repair.sourceOldTerritoryId,repair.assignedOldTerritoryId].includes(cell.oldTerritoryId)&&[repair.sourceOldTerritoryId,repair.assignedOldTerritoryId].includes(other.oldTerritoryId)));
      for(const repair of candidates){
        const strictSource=boundaryMatch(a,b,repair.sourceOldTerritoryId,protectedIndex),assignedMatch=boundaryMatch(a,b,repair.assignedOldTerritoryId,protectedIndex,options),sourceMatch=boundaryMatch(a,b,repair.sourceOldTerritoryId,protectedIndex,options),lineage=cellLineage.has(repair)?'owner-component-chain':otherLineage.has(repair)?'opposite-component-chain':!other&&strictSource.pass?'strict-source-coast':null;
        if(!lineage||!sourceMatch.pass||other&&!assignedMatch.pass)continue;
        if(assignedMatch.pass)acceptCoverage(assignedMatch,null,true);
        acceptCoverage(sourceMatch,null,true);
        numericalBoundaryRepairs.push({kind:'protected-fragment-transfer-boundary',segment:[a,b],owner,otherOwner:otherOwner??null,ownerOldTerritoryId:cell.oldTerritoryId,lineage,assignedOldTerritoryId:repair.assignedOldTerritoryId,sourceOldTerritoryId:repair.sourceOldTerritoryId,ownerSourceComponentHash:cell.sourceComponentHash,oppositeSourceComponentHash:other?.sourceComponentHash??null,repairGeometryHash:repair.geometryHash,repairAfterGeometryHash:repair.afterGeometryHash,repairArea:repair.area,assignedPass:assignedMatch.pass,assignedGapDegrees:assignedMatch.gapDegrees,sourceGapDegrees:sourceMatch.gapDegrees,maximumDistanceDegrees:Math.max(assignedMatch.maximumDistance,sourceMatch.maximumDistance)});
        return true;
      }
      return false;
    };
    const admitAdministrativeRepair=(a,b,owner,otherOwner)=>{
      const cell=cells[owner-1],repairs=administrativeBoundaryRepairs.filter(repair=>repair.countryId===cell.sourceCountryId&&repair.parentKey===cell.parentKey&&repair.assignedOldTerritoryId===cell.oldTerritoryId);
      if(!repairs.length)return false;
      const options={distanceTolerance:NUMERICAL_REPAIR_BOUNDARY_TOLERANCE_DEGREES,gapTolerance:NUMERICAL_REPAIR_BOUNDARY_TOLERANCE_DEGREES},match=boundaryMatch(a,b,cell.parentKey,parentIndex,options);
      if(!match.pass)return false;
      const p0Anchor=boundaryMatch(a,b,cell.sourceCountryId,p0Index).pass,protectedAnchor=boundaryMatch(a,b,cell.oldTerritoryId,protectedIndex).pass,other=otherOwner?cells[otherOwner-1]:null,administrativeAnchor=Boolean(other&&other.sourceCountryId===cell.sourceCountryId&&other.parentKey!==cell.parentKey);
      if(!p0Anchor&&!protectedAnchor&&!administrativeAnchor)return false;
      acceptCoverage(match,null,true);
      numericalBoundaryRepairs.push({kind:'administrative-cell-repair-boundary',segment:[a,b],owner,otherOwner:otherOwner??null,parentKey:cell.parentKey,ownerOldTerritoryId:cell.oldTerritoryId,anchor:p0Anchor?'p0':protectedAnchor?'protected':'opposite-administrative-parent',repairEvidence:repairs.map(repair=>({kind:repair.kind,area:repair.area,lostGeometryHash:repair.lostGeometryHash,afterTargetSourceFeatureId:repair.afterTargetSourceFeatureId,assignedOldTerritoryId:repair.assignedOldTerritoryId,sourceOldTerritoryId:repair.sourceOldTerritoryId})),gapDegrees:match.gapDegrees,maximumDistanceDegrees:match.maximumDistance});
      return true;
    };

    for(let bucketIndex=0;bucketIndex<TOPOLOGY_BUCKETS;bucketIndex++){
      const groups=new Map(),file=path.join(nodedBuckets,`${bucketIndex}.ndjson`);
      for(const line of fs.readFileSync(file,'utf8').split('\n'))if(line){
        const record=JSON.parse(line);
        if(!validNodedOccurrence(record,cells.length,bucketIndex)){reject('invalid-noded-record',{bucketIndex,record});continue;}
        const [a,b,ordinal,side,mapCut=null]=record,key=segmentKey(a,b),group=groups.get(key)??{a,b,occurrences:[]};
        group.occurrences.push({ordinal,side,mapCut});
        groups.set(key,group);
      }
      const edges=[];
      for(const group of [...groups.values()].sort((first,second)=>comparePoint(first.a,second.a)||comparePoint(first.b,second.b))){
        const uniqueOccurrences=[...new Map(group.occurrences.map(item=>[`${item.ordinal}:${item.side}:${item.mapCut??''}`,item])).values()],polar=group.a[1]===group.b[1]&&(group.a[1]===-90||group.a[1]===90),longitude=group.a[0]===-180&&group.b[0]===-180;
        if(uniqueOccurrences.length!==group.occurrences.length){duplicateOccurrences+=group.occurrences.length-uniqueOccurrences.length;reject('duplicate-edge-occurrence',{segment:[group.a,group.b],occurrences:group.occurrences});}
        if(polar){
          const marker=`pole:${group.a[1]}`;
          if(uniqueOccurrences.some(item=>item.mapCut!==marker))reject('invalid-polar-map-cut-marker',{segment:[group.a,group.b],occurrences:uniqueOccurrences});
          else{
            const valid=uniqueOccurrences.map(item=>validateMapCutOwner(group.a,group.b,item.ordinal,marker)).every(Boolean);
            if(valid)acceptCorrespondingParentCoverage(group.a,group.b,[...new Set(uniqueOccurrences.map(item=>item.ordinal))],marker);
            mapCutEvidence.polarClosure++;
          }
          continue;
        }
        let periodicAdjacency=false,occurrences=uniqueOccurrences;
        if(longitude){
          const negative=occurrences.filter(item=>item.mapCut==='-180'),positive=occurrences.filter(item=>item.mapCut==='180');
          if(occurrences.some(item=>item.mapCut!=='-180'&&item.mapCut!=='180')){reject('invalid-longitude-map-cut-marker',{segment:[group.a,group.b],occurrences});continue;}
          if(!negative.length||!positive.length){
            if(occurrences.length!==1){reject('ambiguous-periodic-open-closure',{segment:[group.a,group.b],occurrences});continue;}
            const item=occurrences[0];
            if(validateMapCutOwner(group.a,group.b,item.ordinal,item.mapCut))acceptCorrespondingParentCoverage(group.a,group.b,[item.ordinal],item.mapCut);
            mapCutEvidence.longitudeOpenClosure++;
            continue;
          }
          if(negative.length!==1||positive.length!==1){reject('ambiguous-periodic-pairing',{segment:[group.a,group.b],negative,positive});continue;}
          const periodicOwners=[negative[0].ordinal,positive[0].ordinal];
          if(negative[0].ordinal===positive[0].ordinal){
            if(validateMapCutOwner(group.a,group.b,negative[0].ordinal,'-180'))acceptCorrespondingParentCoverage(group.a,group.b,periodicOwners,'-180');
            if(validateMapCutOwner(group.a,group.b,positive[0].ordinal,'180'))acceptCorrespondingParentCoverage(group.a,group.b,periodicOwners,'180');
            mapCutEvidence.longitudeSelfClosure++;
            continue;
          }
          const negativeValid=validateMapCutOwner(group.a,group.b,negative[0].ordinal,'-180'),positiveValid=validateMapCutOwner(group.a,group.b,positive[0].ordinal,'180');
          if(negativeValid)acceptCorrespondingParentCoverage(group.a,group.b,periodicOwners,'-180');
          if(positiveValid)acceptCorrespondingParentCoverage(group.a,group.b,periodicOwners,'180');
          occurrences=[{ordinal:negative[0].ordinal,side:0,mapCut:'-180'},{ordinal:positive[0].ordinal,side:1,mapCut:'180'}];
          periodicAdjacency=true;
          mapCutEvidence.longitudeAdjacency++;
        }else if(occurrences.some(item=>item.mapCut!==null))reject('map-cut-marker-off-cut',{segment:[group.a,group.b],occurrences});
        let left=[...new Set(occurrences.filter(item=>item.side===0).map(item=>item.ordinal))],right=[...new Set(occurrences.filter(item=>item.side===1).map(item=>item.ordinal))],owners=[...new Set([...left,...right])];
        if(owners.length>2){
          const kept=[],discarded=[];
          for(const item of occurrences){
            const cell=cells[item.ordinal-1],match=boundaryMatch(group.a,group.b,cell.sourceCountryId,p0Index);
            if(!match.pass||match.sourceSides.length!==1){kept.length=0;discarded.length=0;break;}
            (match.sourceSides[0]===item.side?kept:discarded).push({...item,countryId:cell.sourceCountryId,sourceSide:match.sourceSides[0]});
          }
          const keptLeft=[...new Set(kept.filter(item=>item.side===0).map(item=>item.ordinal))],keptRight=[...new Set(kept.filter(item=>item.side===1).map(item=>item.ordinal))],keptOwners=[...new Set([...keptLeft,...keptRight])],keptCountries=keptOwners.map(owner=>cells[owner-1].sourceCountryId);
          if(discarded.length&&keptOwners.length===2&&keptLeft.length===1&&keptRight.length===1&&new Set(keptCountries).size===2&&discarded.every(item=>keptCountries.includes(item.countryId))){
            p0SideRepairs.push({segment:[group.a,group.b],discarded:discarded.map(({ordinal,side,countryId,sourceSide})=>({ordinal,side,countryId,sourceSide})),retained:keptOwners});
            occurrences=kept;
            left=keptLeft;
            right=keptRight;
            owners=keptOwners;
          }
        }
        if(owners.length===0||owners.length>2||owners.some(owner=>left.includes(owner)&&right.includes(owner))){reject('ambiguous-edge-pairing',{segment:[group.a,group.b],left,right});continue;}
        let leftOrdinal=0,rightOrdinal=0,edgeA=group.a,edgeB=group.b;
        if(owners.length===2){
          if(left.length===1&&right.length===1){leftOrdinal=left[0];rightOrdinal=right[0];}
          else{sameDirectionPairs++;reject('same-direction-edge-pairing',{segment:[group.a,group.b],left,right});continue;}
        }else{
          leftOrdinal=owners[0];
          if(right.includes(leftOrdinal))[edgeA,edgeB]=[edgeB,edgeA];
        }
        const edge=makeEdge(cells,leftOrdinal,rightOrdinal,edgeA,edgeB,++edgeCount);
        classCounts[edge.boundaryClass]++;
        if(rightOrdinal){
          adjacency[leftOrdinal-1].push(rightOrdinal);
          adjacency[rightOrdinal-1].push(leftOrdinal);
          adjacentSegmentCount++;
          const pair=`${Math.min(leftOrdinal,rightOrdinal)}:${Math.max(leftOrdinal,rightOrdinal)}`,witness=adjacencyWitnesses.get(pair)??{segments:0,lengthKm:0};
          witness.segments++;
          witness.lengthKm+=edge.lengthKm;
          adjacencyWitnesses.set(pair,witness);
        }
        if(!periodicAdjacency&&(!rightOrdinal||edge.boundaryClass==='country'))for(const owner of owners){
          const cell=cells[owner-1],otherOwner=owners.find(candidate=>candidate!==owner),expectedNeighbor=otherOwner?cells[otherOwner-1].sourceCountryId:null,match=boundaryMatch(group.a,group.b,cell.sourceCountryId,p0Index);
          if(!match.pass||!rightOrdinal&&match.neighbors.length||expectedNeighbor&&!match.neighbors.includes(expectedNeighbor))reject(!rightOrdinal&&match.neighbors.length?'unpaired-land-border':'boundary-outside-fixed-p0',{segment:[group.a,group.b],owner,match:{pass:match.pass,gapDegrees:match.gapDegrees,neighbors:match.neighbors},expectedNeighbor});
          else acceptCoverage(match);
        }
        if(edge.flags.previous)for(const owner of owners){
          const cell=cells[owner-1],otherOwner=owners.find(candidate=>candidate!==owner),match=boundaryMatch(group.a,group.b,cell.oldTerritoryId,protectedIndex);
          if(match.pass)acceptCoverage(match);
          else if(!admitProtectedRepair(group.a,group.b,owner,otherOwner))reject('protected-parent-boundary-intrusion',{segment:[group.a,group.b],owner,oldTerritoryId:cell.oldTerritoryId,gapDegrees:match.gapDegrees});
        }
        const parentBoundary=!rightOrdinal||['country','administrative','residual'].includes(edge.boundaryClass);
        let parentBoundaryAccepted=true,strictParentAnchor=false;
        if(parentBoundary)for(const owner of owners){
          const cell=cells[owner-1],otherOwner=owners.find(candidate=>candidate!==owner),match=boundaryMatch(group.a,group.b,cell.parentKey,parentIndex);
          if(match.pass){acceptCoverage(match);strictParentAnchor=true;}
          else if(!admitAdministrativeRepair(group.a,group.b,owner,otherOwner)){reject('administrative-parent-boundary-intrusion',{segment:[group.a,group.b],owner,parentKey:cell.parentKey,gapDegrees:match.gapDegrees});parentBoundaryAccepted=false;}
        }
        if(parentBoundary&&!periodicAdjacency&&parentBoundaryAccepted&&strictParentAnchor)acceptCorrespondingParentCoverage(group.a,group.b,owners);
        edges.push(edge);
      }
      const relative=`topology/${String(bucketIndex).padStart(3,'0')}.json.gz`,identity=artifactReplay(relative,{schemaVersion:TASK_15_20_VERSION,bucket:bucketIndex,edges},true);
      topologyArtifacts.push({path:relative,sha256:identity.sha256,byteLength:identity.byteLength});
    }
    const p0Coverage=uncoveredBoundaryCount(p0Index),protectedCoverage=uncoveredBoundaryCount(protectedIndex),parentCoverage=uncoveredBoundaryCount(parentIndex);
    if(p0Coverage.count)reject('uncovered-p0-boundary',p0Coverage);
    if(protectedCoverage.count)reject('uncovered-protected-boundary',protectedCoverage);
    if(parentCoverage.count)reject('uncovered-parent-boundary',parentCoverage);
    const offsets=[0],neighbors=[];
    let isolatedCells=0;
    for(const list of adjacency){
      const unique=[...new Set(list)].sort((first,second)=>first-second);
      if(!unique.length)isolatedCells++;
      neighbors.push(...unique);
      offsets.push(neighbors.length);
    }
    const adjacencyPairs=neighbors.length/2;
    if(adjacencyPairs!==adjacencyWitnesses.size||[...adjacencyWitnesses.values()].some(witness=>!(witness.segments>0&&witness.lengthKm>0)))fail('adjacency-positive-witness',{pairs:adjacencyPairs,witnesses:adjacencyWitnesses.size});
    return {administrativeArea,previousArea,globalNoding,edgeCount,adjacentSegmentCount,adjacencyPairs,offsets,neighbors,isolatedCells,classCounts,errorCount,errors,maximumBoundaryDisplacement,maximumNumericalRepairBoundaryDisplacement,parentCoverageEvidence,mapCutEvidence,sameDirectionPairs,duplicateOccurrences,p0SideRepairs,numericalBoundaryRepairs,p0Coverage,protectedCoverage,parentCoverage,topologyArtifacts,adjacencyWitnesses};
  }finally{
    fs.rmSync(temporary,{recursive:true,force:true});
  }
}

function reportFailureCodes(errors,prefix){
  return errors.some(error=>String(error.code).startsWith(prefix));
}

export function verifyWorldIndices(root){
  const errors=[];
  let failureCount=0;
  const fail=(code,detail)=>{failureCount++;if(errors.length<200)errors.push({code,detail:reportDetail(detail)});};
  const safe=(code,reader)=>{try{return reader();}catch(error){fail(code,error.message);return null;}};
  const index=safe('artifact-index-readable',()=>readJSON(path.join(root,'artifact-index.json'))),summary=safe('summary-readable',()=>readJSON(path.join(root,'summary.json'))),provenance=safe('provenance-readable',()=>readJSON(path.join(root,'provenance.json'))),indexRoot=safe('index-root-readable',()=>readJSON(path.join(root,'index-root.json'))),validation=safe('topology-validation-readable',()=>readJSON(path.join(root,'topology-validation.json')));
  if(!index||!summary||!provenance||!indexRoot||!validation)return {task:'V20',status:'fail',root:slash(root),generatorVersion:TASK_15_20_VERSION,checks:{documentsReadable:false},failureCount,errors};

  const checks={
    documentsReadable:true,
    schema:[index.schemaVersion,summary.schemaVersion,indexRoot.schemaVersion,validation.schemaVersion,provenance.generatorVersion].every(version=>version===TASK_15_20_VERSION),
    generatedPass:summary.status==='pass'&&validation.status==='pass',
    immutableOffline:provenance.runtimeRegeneration===false&&provenance.productionPublication===false&&provenance.migration===false,
    sourceCatalog:[indexRoot.sourceCatalogRoot,summary.sourceCatalogRoot,provenance.sourceCatalogRoot].every(value=>slash(value)===WORLD_CATALOG_ROOT),
  };
  const artifactReplay=buildArtifactReplay(root,index,fail);
  checks.artifactSet=artifactReplay.artifactSet;
  checks.artifactCount=artifactReplay.indexed.size===TOPOLOGY_BUCKETS+8;
  checks.artifactBytes=artifactReplay.artifactBytes;

  const worldTree=safe('15-19-current-tree',()=>verifyIndexedTree(WORLD_CATALOG_ROOT,WORLD_CATALOG_INDEX,'15-19')),administrativeTree=safe('15-18-current-tree',()=>verifyIndexedTree(ADMINISTRATIVE_ROOT,ADMINISTRATIVE_INDEX,'15-18')),v19Report=safe('15-19-report-pin',()=>{
    const identity=fileIdentity(V19_REPORT.path),report=readJSON(V19_REPORT.path);
    if(!sameIdentity(identity,V19_REPORT)||report.status!=='pass'||slash(report.root)!==WORLD_CATALOG_ROOT)throw Error('Pinned V19 repair-v2 report changed or is not a PASS for the current catalog root');
    return report;
  });
  checks.sourceArtifactTrees=Boolean(worldTree&&administrativeTree&&v19Report);
  if(!checks.sourceArtifactTrees){
    for(const [name,pass] of Object.entries(checks))if(!pass)fail(`check-${name}`,pass);
    return {task:'V20',status:'fail',root:slash(root),generatorVersion:TASK_15_20_VERSION,checks,failureCount,errors};
  }

  const worldSummary=safe('15-19-summary-readable',()=>readJSON(`${WORLD_CATALOG_ROOT}/summary.json`)),requiredInputs=safe('input-identities-readable',()=>REQUIRED_INPUT_PATHS.map(fileIdentity)),currentRuntime=runtimeIdentity(),generator=fileIdentity('scripts/prompt15-world-indices.mjs');
  if(!worldSummary||!requiredInputs)return {task:'V20',status:'fail',root:slash(root),generatorVersion:TASK_15_20_VERSION,checks,failureCount,errors};
  checks.sourceCatalogPass=worldSummary.status==='pass'&&Object.values(worldSummary.checks??{}).every(Boolean);
  checks.inputPins=exactArray((provenance.inputs??[]).map(input=>input.path),REQUIRED_INPUT_PATHS)&&sameValue(provenance.inputs,requiredInputs)&&sameValue(provenance.generator,generator);
  checks.runtime=sameValue(provenance.runtime,currentRuntime);
  const rootKey=hashCanonical('prompt15-task-15-20-root.v1',{version:TASK_15_20_VERSION,inputs:requiredInputs,runtime:currentRuntime}).slice(0,20),expectedBasename=`15-20-topology-membership-v1-${rootKey}`,expectedRoot=`data/derived/prompt15/${expectedBasename}`;
  checks.rootKey=path.basename(path.resolve(root))===expectedBasename&&slash(index.root)===expectedRoot&&slash(summary.root)===expectedRoot;

  const order=safe('catalog-order-readable',()=>artifactReplay.readGzip('catalog-order.json.gz')),actualAdministrative=safe('administrative-membership-readable',()=>artifactReplay.readGzip('administrative-membership.json.gz')),actualPrevious=safe('previous-parent-readable',()=>artifactReplay.readGzip('previous-parent-index.json.gz')),actualAdjacency=safe('adjacency-readable',()=>artifactReplay.readGzip('adjacency.json.gz'));
  if(!order||!actualAdministrative||!actualPrevious||!actualAdjacency)return {task:'V20',status:'fail',root:slash(root),generatorVersion:TASK_15_20_VERSION,checks,failureCount,errors};
  const countryOrder=worldTree.catalogRoot.countryOrder,catalogEvidence=safe('catalog-evidence-replay',()=>collectCatalogEvidence(countryOrder,fail)),sources=safe('pinned-source-replay',loadPinnedSources);
  if(!catalogEvidence||!sources)return {task:'V20',status:'fail',root:slash(root),generatorVersion:TASK_15_20_VERSION,checks,failureCount,errors};
  const {cells,parentEvidence,protectedRepairNet,administrativeRepairNet,geometryRepairLedger,protectedBoundaryRepairs,administrativeBoundaryRepairs,geometryProperties,generationComponents}=catalogEvidence;
  checks.catalogCellCount=cells.length===worldSummary.counts?.cells&&cells.length===923443;
  const expectedOrder={schemaVersion:TASK_15_20_VERSION,cells,cellRoot:digest(jsonBytes(cells.map(cell=>cell.id)))};
  artifactReplay.replay('catalog-order.json.gz',expectedOrder,true);
  checks.catalogOrder=sameValue(order,expectedOrder)&&exactKeySet(order,['cellRoot','cells','schemaVersion']);

  const expectedMembership=safe('membership-source-replay',()=>buildExpectedMemberships(cells,sources,parentEvidence,generationComponents,fail));
  if(!expectedMembership)return {task:'V20',status:'fail',root:slash(root),generatorVersion:TASK_15_20_VERSION,checks,failureCount,errors};
  for(const oldTerritoryId of protectedRepairNet.keys())if(!expectedMembership.protectedById.has(oldTerritoryId))fail('unknown-previous-repair-parent',oldTerritoryId);
  for(const parentKey of administrativeRepairNet.keys())if(!expectedMembership.sourceParentByKey.has(parentKey))fail('unknown-administrative-repair-parent',parentKey);
  const actualMembershipAudit=safe('membership-csr-audit',()=>validateMembershipIndexes(cells,actualAdministrative,actualPrevious))??{pass:false,errors:['unreadable'],counts:{}};
  checks.membershipPartition=actualMembershipAudit.pass;
  checks.sourceCorrespondence=expectedMembership.sourceParentByKey.size===4761&&expectedMembership.protectedById.size===4231&&expectedMembership.administrative.parents.filter(parent=>parent.kind==='administrative').length===4591&&expectedMembership.administrative.parents.filter(parent=>parent.kind==='country-envelope-residual').length===170;
  checks.sourceComponentLineage=!reportFailureCodes(errors,'source-component-');

  const topology=safe('independent-topology-replay',()=>replayWorldTopology({cells,countryOrder,geometryProperties,sources,protectedBoundaryRepairs,administrativeBoundaryRepairs,artifactReplay:artifactReplay.replay,fail}));
  if(!topology)return {task:'V20',status:'fail',root:slash(root),generatorVersion:TASK_15_20_VERSION,checks,failureCount,errors};

  let administrativeAreaFailures=0,previousAreaFailures=0,maximumAdministrativeAreaDifference=0,maximumPreviousAreaDifference=0;
  for(const parent of expectedMembership.administrative.parents){
    const source=expectedMembership.sourceParentByKey.get(parent.parentKey),sourceArea=planarArea(source.geometry),numericalRepairAreaDelta=kahanValue(administrativeRepairNet,parent.parentKey),expectedCellUnionArea=sourceArea+numericalRepairAreaDelta,cellUnionArea=kahanValue(topology.administrativeArea,parent.parentKey),tolerance=Math.max(1e-9,sourceArea*1e-9),areaDifference=Math.abs(cellUnionArea-expectedCellUnionArea);
    Object.assign(parent,{sourceArea,numericalRepairAreaDelta,expectedCellUnionArea,cellUnionArea,areaDifference,tolerance,unionPass:areaDifference<=tolerance});
    maximumAdministrativeAreaDifference=Math.max(maximumAdministrativeAreaDifference,areaDifference);
    if(!parent.unionPass)administrativeAreaFailures++;
  }
  for(const parent of expectedMembership.previous.parents){
    const source=expectedMembership.protectedById.get(parent.oldTerritoryId),sourceGeometryArea=planarArea(source.geometry),numericalRepairAreaDelta=kahanValue(protectedRepairNet,parent.oldTerritoryId),expectedCellUnionArea=sourceGeometryArea+numericalRepairAreaDelta,cellUnionArea=kahanValue(topology.previousArea,parent.oldTerritoryId),tolerance=2e-11,areaDifference=Math.abs(cellUnionArea-expectedCellUnionArea);
    Object.assign(parent,{sourceGeometryArea,numericalRepairAreaDelta,expectedCellUnionArea,cellUnionArea,areaDifference,tolerance,unionPass:areaDifference<=tolerance});
    maximumPreviousAreaDifference=Math.max(maximumPreviousAreaDifference,areaDifference);
    if(!parent.unionPass)previousAreaFailures++;
  }
  const membershipAudit=validateMembershipIndexes(cells,expectedMembership.administrative,expectedMembership.previous),administrativeIdentity=artifactReplay.replay('administrative-membership.json.gz',expectedMembership.administrative,true),previousIdentity=artifactReplay.replay('previous-parent-index.json.gz',expectedMembership.previous,true);
  checks.membershipBytes=sameValue(actualAdministrative,expectedMembership.administrative)&&sameValue(actualPrevious,expectedMembership.previous);
  checks.parentUnions=administrativeAreaFailures===0&&previousAreaFailures===0;

  const expectedAdjacency={schemaVersion:TASK_15_20_VERSION,cellCount:cells.length,offsets:topology.offsets,neighbors:topology.neighbors,adjacencyPairs:topology.adjacencyPairs,contract:'Symmetric sorted unique positive-length adjacency. Coast, point-only, sea-gap and remote-component contacts are absent.'},adjacencyIdentity=artifactReplay.replay('adjacency.json.gz',expectedAdjacency,true);
  checks.adjacency=sameValue(actualAdjacency,expectedAdjacency)&&topology.adjacencyPairs===topology.adjacencyWitnesses.size;
  const administrativeAbove512=expectedMembership.administrative.parents.filter(parent=>parent.count>512),previousAbove512=expectedMembership.previous.parents.filter(parent=>parent.count>512),largestAdministrative=expectedMembership.administrative.parents.reduce((largest,parent)=>parent.count>largest.count?parent:largest,{count:0}),largestPrevious=expectedMembership.previous.parents.reduce((largest,parent)=>parent.count>largest.count?parent:largest,{count:0}),svnParents=expectedMembership.administrative.parents.filter(parent=>parent.sourceCountryId==='SVN'&&parent.kind==='administrative');
  const recomputedCounts={cells:cells.length,edges:topology.edgeCount,adjacentSegments:topology.adjacentSegmentCount,adjacencyPairs:topology.adjacencyPairs,isolatedCells:topology.isolatedCells,...topology.classCounts,administrativeParents:expectedMembership.administrative.parents.length,previousParents:expectedMembership.previous.parents.length};
  const expectedChecks={
    globalNoding:topology.globalNoding.pass,
    edgePairing:topology.errorCount===0,
    uniqueSegmentOccurrences:topology.duplicateOccurrences===0,
    oppositeDirectionPairing:topology.sameDirectionPairs===0,
    ordinaryBoundaryDisplacement:topology.maximumBoundaryDisplacement<=BOUNDARY_DISTANCE_TOLERANCE_DEGREES,
    numericalRepairBoundaryDisplacement:topology.maximumNumericalRepairBoundaryDisplacement<=NUMERICAL_REPAIR_BOUNDARY_TOLERANCE_DEGREES,
    fixedP0BoundaryCoverage:topology.p0Coverage.count===0,
    previousParentBoundaryCoverage:topology.protectedCoverage.count===0,
    administrativeParentBoundaryCoverage:topology.parentCoverage.count===0,
    periodicBoundaryCoverage:topology.p0Coverage.periodic.count===0&&topology.protectedCoverage.periodic.count===0&&topology.parentCoverage.periodic.count===0,
    administrativeParentUnion:administrativeAreaFailures===0,
    previousGeometryParentUnion:previousAreaFailures===0,
    worldEdgeBudget:topology.edgeCount<=WORLD_EDGE_BUDGET,
    cellCount:cells.length===worldSummary.counts.cells,
    administrativeMembership:membershipAudit.pass&&expectedMembership.administrative.parents.length===4761,
    administrativeIdentity:expectedMembership.administrative.parents.filter(parent=>parent.kind==='administrative').length===4591,
    residualIdentity:expectedMembership.administrative.parents.filter(parent=>parent.kind==='country-envelope-residual').length===170,
    previousParents:expectedMembership.previous.parents.length===4231,
    svn193:svnParents.length===193&&svnParents.every(parent=>parent.count>0&&parent.unionPass),
    untruncatedMembership:largestAdministrative.count>512&&expectedMembership.administrative.cellOrdinals.length===cells.length,
    untruncatedPreviousParent:largestPrevious.count>512&&expectedMembership.previous.cellOrdinals.length===cells.length,
  };
  const unionEvidence={administrativeAreaFailures,previousAreaFailures,maximumAdministrativeAreaDifference,maximumPreviousAreaDifference,geometryRepairCount:geometryRepairLedger.length,geometryRepairRoot:hashCanonical('prompt15-task-15-20-geometry-repair-ledger.v1',geometryRepairLedger)},expectedMembershipEvidence={audit:membershipAudit,administrativeAbove512:administrativeAbove512.length,previousAbove512:previousAbove512.length,largestAdministrative,largestPrevious,svnAdministrativeParents:svnParents.length,unionEvidence};
  const expectedValidation={
    schemaVersion:TASK_15_20_VERSION,
    status:Object.values(expectedChecks).every(Boolean)?'pass':'fail',
    checks:expectedChecks,
    errors:topology.errors,
    errorCount:topology.errorCount,
    globalNoding:topology.globalNoding,
    maximumBoundaryDisplacement:topology.maximumBoundaryDisplacement,
    maximumNumericalRepairBoundaryDisplacement:topology.maximumNumericalRepairBoundaryDisplacement,
    boundaryCoverage:{p0:topology.p0Coverage,protected:topology.protectedCoverage,administrative:topology.parentCoverage},
    parentCoverageEvidence:topology.parentCoverageEvidence,
    mapCutEvidence:topology.mapCutEvidence,
    sameDirectionPairs:topology.sameDirectionPairs,
    duplicateOccurrences:topology.duplicateOccurrences,
    p0SideRepairs:{count:topology.p0SideRepairs.length,root:hashCanonical('prompt15-task-15-20-p0-side-repairs.v1',topology.p0SideRepairs),items:topology.p0SideRepairs},
    numericalBoundaryRepairs:{count:topology.numericalBoundaryRepairs.length,root:hashCanonical('prompt15-task-15-20-numerical-boundary-repairs.v1',topology.numericalBoundaryRepairs),items:topology.numericalBoundaryRepairs},
    counts:recomputedCounts,
    membership:expectedMembershipEvidence,
    policy:{worldEdges:WORLD_EDGE_BUDGET,coordinateToleranceDegrees:BOUNDARY_DISTANCE_TOLERANCE_DEGREES,fixedGridCoverageToleranceDegrees:FIXED_GRID_COVERAGE_TOLERANCE_DEGREES,numericalRepairBoundaryToleranceDegrees:NUMERICAL_REPAIR_BOUNDARY_TOLERANCE_DEGREES,administrativeAreaAbsoluteTolerance:1e-9,administrativeAreaRelativeTolerance:1e-9,previousAreaAbsoluteTolerance:2e-11,mapCuts:'Longitude +/-180 and latitude +/-90 planar closure segments are audited by marker and source identity; open and self closures are never emitted as topology edges.'},
  };
  artifactReplay.replay('topology-validation.json',expectedValidation);
  checks.topologyContract=topology.errorCount===0&&topology.globalNoding.pass&&topology.duplicateOccurrences===0&&topology.sameDirectionPairs===0;
  checks.boundaryCorrespondence=topology.p0Coverage.count===0&&topology.protectedCoverage.count===0&&topology.parentCoverage.count===0&&topology.maximumBoundaryDisplacement<=BOUNDARY_DISTANCE_TOLERANCE_DEGREES&&topology.maximumNumericalRepairBoundaryDisplacement<=NUMERICAL_REPAIR_BOUNDARY_TOLERANCE_DEGREES;
  checks.parentCoverageEvidence=sameValue(validation.parentCoverageEvidence,topology.parentCoverageEvidence)&&sameValue(summary.boundaryCoverageEvidence,topology.parentCoverageEvidence);
  checks.mapCuts=sameValue(validation.mapCutEvidence,topology.mapCutEvidence)&&topology.p0Coverage.periodic.count===0&&topology.protectedCoverage.periodic.count===0&&topology.parentCoverage.periodic.count===0;
  checks.repairEvidence=sameValue(validation.p0SideRepairs,expectedValidation.p0SideRepairs)&&sameValue(validation.numericalBoundaryRepairs,expectedValidation.numericalBoundaryRepairs)&&sameValue(validation.membership?.unionEvidence,unionEvidence);
  checks.worldEdgeBudget=topology.edgeCount<=WORLD_EDGE_BUDGET;
  checks.counts=sameValue(summary.counts,recomputedCounts)&&sameValue(validation.counts,recomputedCounts)&&sameValue(indexRoot.counts,recomputedCounts);

  const roots={catalogOrder:expectedOrder.cellRoot,topology:hashCanonical('prompt15-task-15-20-topology-root.v1',topology.topologyArtifacts),adjacency:adjacencyIdentity.sha256,administrativeMembership:administrativeIdentity.sha256,previousParent:previousIdentity.sha256},expectedIndexRoot={schemaVersion:TASK_15_20_VERSION,sourceCatalogRoot:WORLD_CATALOG_ROOT,roots,counts:recomputedCounts,topologyShards:topology.topologyArtifacts.map(artifact=>artifact.path),catalogOrder:'catalog-order.json.gz',adjacency:'adjacency.json.gz',administrativeMembership:'administrative-membership.json.gz',previousParentIndex:'previous-parent-index.json.gz'};
  artifactReplay.replay('index-root.json',expectedIndexRoot);
  const expectedSummary={task:'15-20',schemaVersion:TASK_15_20_VERSION,status:Object.values(expectedChecks).every(Boolean)?'pass':'fail',root:expectedRoot,sourceCatalogRoot:WORLD_CATALOG_ROOT,checks:expectedChecks,roots,counts:recomputedCounts,membership:expectedMembershipEvidence,boundaryCoverageEvidence:topology.parentCoverageEvidence,budgets:{worldEdges:WORLD_EDGE_BUDGET},next:Object.values(expectedChecks).every(Boolean)?'15-21 (not executed)':'15-20 repair; no immutable indices admitted'};
  artifactReplay.replay('summary.json',expectedSummary);
  const expectedProvenance={task:'15-20',generatorVersion:TASK_15_20_VERSION,generator,command:'node --expose-gc --max-old-space-size=8192 scripts/prompt15-world-indices.mjs',inputs:requiredInputs,runtime:currentRuntime,sourceCatalogRoot:WORLD_CATALOG_ROOT,runtimeRegeneration:false,productionPublication:false,migration:false,scope:'Offline immutable topology, complete administrative membership, and previous-geometry parent indices only. Render/delivery, runtime lookup, migration and production cutover are not executed.',topologyPolicy:'Exact opposite-direction pairs retain source coordinates. Every other occurrence is common-noded once by JSTS MCIndexSnapRounder with a fixed scale-1e12 PrecisionModel; adjacency requires a positive-length two-owner segment. Marker-specific longitude/pole closures are independently audited.',membershipPolicy:'Complete CSR-style ordinal membership. The 512 action/request cap never truncates stored catalog membership. Administrative and previous-parent area sums include only exact pinned 15-19 protected-fragment, cell, and topology-source repair deltas. Owner-specific intrusion checks precede any additive same-country coincident-parent coverage; numerical boundary exceptions require local repair lineage and bounded source correspondence.'};
  artifactReplay.replay('provenance.json',expectedProvenance);
  artifactReplay.finish(expectedRoot,expectedProvenance.command);
  checks.roots=sameValue(indexRoot.roots,roots)&&sameValue(summary.roots,roots);
  checks.validationEvidence=sameValue(validation,expectedValidation)&&sameValue(summary,expectedSummary)&&sameValue(indexRoot,expectedIndexRoot)&&sameValue(provenance,expectedProvenance);
  checks.completeByteReplay=artifactReplay.expected.size===V20_ARTIFACTS.length&&!reportFailureCodes(errors,'artifact-');
  for(const [name,pass] of Object.entries(checks))if(!pass)fail(`check-${name}`,pass);
  return {
    task:'V20',
    status:failureCount?'fail':'pass',
    root:slash(root),
    generatorVersion:TASK_15_20_VERSION,
    checks,
    counts:{...recomputedCounts,directedAdjacency:topology.neighbors.length},
    membership:{administrativeAbove512:administrativeAbove512.length,previousAbove512:previousAbove512.length,largestAdministrative,largestPrevious,unionEvidence},
    boundaryCoverage:{p0:topology.p0Coverage,protected:topology.protectedCoverage,administrative:topology.parentCoverage,maximumBoundaryDisplacement:topology.maximumBoundaryDisplacement,maximumNumericalRepairBoundaryDisplacement:topology.maximumNumericalRepairBoundaryDisplacement,parentCoverageEvidence:topology.parentCoverageEvidence,mapCutEvidence:topology.mapCutEvidence},
    repairs:{p0SideRepairs:expectedValidation.p0SideRepairs,numericalBoundaryRepairs:expectedValidation.numericalBoundaryRepairs},
    byteReplay:{artifactCount:artifactReplay.expected.size,topologyShards:topology.topologyArtifacts.length,root:roots},
    diagnostics:{membershipAudit:actualMembershipAudit,independentMembershipAudit:membershipAudit,globalNoding:topology.globalNoding,topologyErrors:topology.errorCount},
    failureCount,
    errors,
  };
}

export function runV20VerifierSelfCheck(){
  const protectedOverlayRecord={byteLength:1,path:'protected-overlay.geojson',role:'byte-exact import of frozen previous territory geometry',sha256:'0'.repeat(64)};
  if(!validIndexedArtifact(protectedOverlayRecord,false)||validIndexedArtifact({...protectedOverlayRecord,role:'unexpected'},false)||validIndexedArtifact({...protectedOverlayRecord,path:'residuals.geojson'},false))throw Error('15-18 protected-overlay artifact-index exception self-check failed');
  const marked=geometrySegmentRecords({geometry:{type:'Polygon',coordinates:[[[180,0],[180,1],[179,1],[179,0],[180,0]]]}},1).find(record=>record[4]==='180');
  if(!marked||marked[0][0]!==-180||marked[1][0]!==-180)throw Error('Antimeridian marker self-check failed');
  const cells=[
    {id:'a',parentKey:'A:1',sourceCountryId:'A',adminId:'1',oldTerritoryId:'old-a'},
    {id:'b',parentKey:'A:2',sourceCountryId:'A',adminId:'2',oldTerritoryId:'old-b'},
  ],administrative={cellCount:2,parents:[{parentKey:'A:1',sourceCountryId:'A',adminId:'1',start:0,count:1},{parentKey:'A:2',sourceCountryId:'A',adminId:'2',start:1,count:1}],cellOrdinals:[1,2]},previous={cellCount:2,parents:[{oldTerritoryId:'old-a',sourceCountryId:'A',start:0,count:1},{oldTerritoryId:'old-b',sourceCountryId:'A',start:1,count:1}],cellOrdinals:[1,2],oldParentOrdinalByCell:[1,2]};
  const membership=validateMembershipIndexes(cells,administrative,previous);
  if(!membership.pass)throw Error(`CSR self-check failed: ${membership.errors.join(',')}`);
  const unboundedMembership=validateMembershipIndexes(cells,{...administrative,parents:[{...administrative.parents[0],count:Number.MAX_SAFE_INTEGER}]},previous);
  if(unboundedMembership.pass||!unboundedMembership.errors.includes('administrative-parent-contract'))throw Error('CSR range guard self-check failed');
  const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'prompt15-v20-self-')),raw=path.join(temporary,'raw'),noded=path.join(temporary,'noded');
  try{
    fs.mkdirSync(raw,{recursive:true});
    for(let index=0;index<TOPOLOGY_BUCKETS;index++)fs.writeFileSync(path.join(raw,`${index}.ndjson`),'');
    const records=[[[0,0],[2,2],1,0,null,{tag:'first'}],[[0,2],[2,0],2,1,null,{tag:'second'}]];
    for(const record of records){const bucket=segmentBucket(segmentKey(record[0],record[1]));fs.appendFileSync(path.join(raw,`${bucket}.ndjson`),`${JSON.stringify(record)}\n`);}
    const evidence=nodeReplayBuckets(raw,noded,2),output=[];
    for(let index=0;index<TOPOLOGY_BUCKETS;index++)for(const line of fs.readFileSync(path.join(noded,`${index}.ndjson`),'utf8').split('\n'))if(line)output.push(JSON.parse(line));
    if(!evidence.pass||output.length!==4||output.some(record=>!['first','second'].includes(record[5]?.tag)))throw Error('Independent snap-round/metadata self-check failed');
    const first=gzipSync(jsonBytes({stable:true}),{level:9,mtime:0}),second=gzipSync(jsonBytes({stable:true}),{level:9,mtime:0});
    if(!first.equals(second))throw Error('Deterministic gzip self-check failed');
    return {status:'pass',mapCut:marked[4],membership:membership.counts,noding:evidence,outputOccurrences:output.length};
  }finally{
    fs.rmSync(temporary,{recursive:true,force:true});
  }
}

export function writeV20Report(root,reportPath='reports/prompt15/15-20-v20.json'){
  const report=verifyWorldIndices(root);
  report.verifier=fileIdentity('scripts/verify-prompt15-world-indices.mjs');
  fs.writeFileSync(reportPath,jsonBytes(report),{flag:'wx'});
  if(report.status!=='pass')throw Object.assign(Error(`V20 failed with ${report.failureCount} errors`),{report});
  return {report,identity:fileIdentity(reportPath)};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  if(process.argv[2]==='--self-test'){
    try{console.log(JSON.stringify(runV20VerifierSelfCheck()));}
    catch(error){console.error(JSON.stringify({status:'fail',message:error.message}));process.exitCode=1;}
  }else{
    const root=process.argv[2];
    if(!root){console.error('Usage: node --expose-gc --max-old-space-size=8192 scripts/verify-prompt15-world-indices.mjs <indices-root> [report-path] | --self-test');process.exitCode=2;}
    else try{
      const result=writeV20Report(root,process.argv[3]);
      console.log(JSON.stringify({status:result.report.status,root:result.report.root,counts:result.report.counts,report:result.identity,next:'15-21 (not executed)'}));
    }catch(error){
      console.error(JSON.stringify({status:'fail',message:error.message,errors:error.report?.errors?.slice(0,20)??[]}));
      process.exitCode=1;
    }
  }
}
