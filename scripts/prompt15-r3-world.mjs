import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import geojsonVt from 'geojson-vt';
import {fromGeojsonVt} from '@maplibre/vt-pbf';
import {VectorTile} from '@mapbox/vector-tile';
import {PbfReader} from 'pbf';
import STRtree from 'jsts/org/locationtech/jts/index/strtree/STRtree.js';
import Envelope from 'jsts/org/locationtech/jts/geom/Envelope.js';
import {polygons,jsonBytes,hashCanonical,compareText} from './prompt14-catalog-core.mjs';
import {readJSON,fileIdentity,distanceKm} from './prompt15-cell-core.mjs';
import {CELL_EXPERIMENT_POLICY as P} from './prompt15-cell-policy.mjs';
import {REVISION_POLICY as Q} from './prompt15-r3-policy.mjs';
import {DELIVERY_POLICY} from './prompt14-source-gate.mjs';
const cmp=(a,b)=>a[0]-b[0]||a[1]-b[1];
const key=(a,b)=>`${a[0]},${a[1]};${b[0]},${b[1]}`;
const bucket=s=>{let h=2166136261;for(let i=0;i<s.length;i++)h=Math.imul(h^s.charCodeAt(i),16777619);return h&255;};
export function boundaryIndex(p0){
 const byCountry=new Map(),segments=new Map();
 for(const f of p0.features){const tree=new STRtree(),country=f.properties.countryId;byCountry.set(country,tree);
  for(const p of polygons(f.geometry))for(const r of p)for(let i=1;i<r.length;i++){
   let a=r[i-1],b=r[i];if(cmp(a,b)===0)continue;if(a[0]===180&&b[0]===180){a=[-180,a[1]];b=[-180,b[1]];}if(cmp(a,b)>0)[a,b]=[b,a];
   const k=key(a,b),s=segments.get(k)??{a,b,countries:[],intervals:[]};if(!s.countries.includes(country))s.countries.push(country);segments.set(k,s);tree.insert(new Envelope(a[0],b[0],Math.min(a[1],b[1]),Math.max(a[1],b[1])),s);
  }
 }
 return {byCountry,segments};
}
export function boundaryMatch(a,b,country,index){
 const tree=index.byCountry.get(country),box=new Envelope(Math.min(a[0],b[0]),Math.max(a[0],b[0]),Math.min(a[1],b[1]),Math.max(a[1],b[1]));box.expandBy(1e-12);
 const intervals=[],matches=[],dx=b[0]-a[0],dy=b[1]-a[1],den=dx*dx+dy*dy,length=Math.sqrt(den);let maxDistance=0;
 for(const it=tree.query(box).iterator();it.hasNext();){const s=it.next(),sx=s.b[0]-s.a[0],sy=s.b[1]-s.a[1],sd=sx*sx+sy*sy;
  const distance=p=>Math.abs((p[0]-s.a[0])*sy-(p[1]-s.a[1])*sx)/Math.sqrt(sd);
  const d=Math.max(distance(a),distance(b));if(d>1e-12)continue;
  const t=p=>((p[0]-a[0])*dx+(p[1]-a[1])*dy)/den,lo=Math.max(0,Math.min(t(s.a),t(s.b))),hi=Math.min(1,Math.max(t(s.a),t(s.b)));if(hi<=lo)continue;
  const u=p=>((p[0]-s.a[0])*sx+(p[1]-s.a[1])*sy)/sd;matches.push({s,lo:Math.max(0,Math.min(u(a),u(b))),hi:Math.min(1,Math.max(u(a),u(b)))});intervals.push([lo,hi]);maxDistance=Math.max(maxDistance,d);
 }
 intervals.sort((a,b)=>a[0]-b[0]);let end=0,gap=0;for(const [lo,hi]of intervals){gap+=Math.max(0,lo-end);end=Math.max(end,hi);}gap+=Math.max(0,1-end);
 return {pass:gap*length<=1e-12&&matches.length>0,matches,maxDistance,gapDegrees:gap*length,neighbors:[...new Set(matches.flatMap(m=>m.s.countries).filter(c=>c!==country))]};
}
export function buildWorld(output){
 const start=performance.now(),input=readJSON(`${output}/input-summary.json`),countries=input.countries.map(c=>c.countryId),chunks=[],meshSummaries=[];
 for(const country of countries){const s=readJSON(`${output}/mesh/${country}/summary.json`);meshSummaries.push(s);chunks.push(...s.chunks);}
 const cells=[];for(const chunk of chunks)for(const c of readJSON(`${output}/${chunk.path}`))cells.push({...c,geometry:undefined,chunk:chunk.path});cells.sort((a,b)=>compareText(a.id,b.id));
 if(new Set(cells.map(c=>c.id)).size!==cells.length)throw Error('Duplicate stable cell ID');
 const byId=new Map(cells.map((c,i)=>[c.id,i+1])),ordCountry=cells.map(c=>c.sourceCountryId),artifacts=[];
 const write=(name,value)=>{const p=`${output}/${name}`;fs.mkdirSync(path.dirname(p),{recursive:true});fs.writeFileSync(p,jsonBytes(value));const a={...fileIdentity(p),path:name};artifacts.push(a);return a;};
 const metadata=write('world/metadata.json',{territories:cells.map(c=>({id:c.id,sourceCountryId:c.sourceCountryId,bbox:c.metrics.bbox,anchor:c.metrics.centroid,area:c.metrics.planarArea}))});
 const freeze=readJSON('data/catalogs/prompt14/frozen-catalog-ref.json'),oldPair=readJSON(`${path.dirname(freeze.artifactIndex.path)}/migration-pair.json`);
 const state=write('world/inheritance-state-fixture.json',{territoryOrder:cells.map(c=>c.id),territoriesById:Object.fromEntries(cells.map(c=>{const old=oldPair.world.territoriesById[c.oldTerritoryId];if(!old)throw Error('Unknown old mutable-state parent');return [c.id,{id:c.id,sourceCountryId:c.sourceCountryId,ownerCountryId:old.ownerCountryId,controllerCountryId:old.controllerCountryId}];}))});
 const ordinals=write('world/catalog.json',{policy:Q.version,cells:cells.map(c=>({id:c.id,sourceCountryId:c.sourceCountryId,adminId:c.adminId,oldTerritoryId:c.oldTerritoryId,geometryShard:c.chunk,sourceTinyProof:c.sourceTinyProof})),geometryArtifacts:chunks.map(c=>({path:c.path,sha256:c.sha256,byteLength:c.byteLength}))});
 const membersByKey=new Map();cells.forEach((c,i)=>{const k=`${c.sourceCountryId}:${c.adminId??'residual'}`,list=membersByKey.get(k)??[];list.push(i+1);membersByKey.set(k,list);});
 const membership=[];for(const country of countries){const regions=readJSON(`${output}/inputs/${country}.json`).gameRegions;for(const r of regions)membership.push({countryId:country,adminId:r.id,name:r.name,active:r.active,sourceGeometryHash:r.sourceGeometryHash,gameGeometryHash:r.gameGeometryHash,cellOrdinals:membersByKey.get(`${country}:${r.id}`)??[]});}
 const membershipArtifact=write('world/membership.json',membership);
 const residualArtifact=write('world/residual-membership.json',countries.map(country=>({sourceCountryId:country,administrativeIdentity:null,cellOrdinals:membersByKey.get(`${country}:residual`)??[]})));
 const temp=`${output}/segment-buckets`;fs.mkdirSync(temp,{recursive:true});const fds=Array.from({length:256},(_,i)=>fs.openSync(`${temp}/${i}.ndjson`,'w'));
 for(const chunk of chunks){const buffers=Array.from({length:256},()=>[]);for(const c of readJSON(`${output}/${chunk.path}`))for(const p of polygons(c.geometry))for(const r of p)for(let i=1;i<r.length;i++){
  let a=r[i-1],b=r[i];if(cmp(a,b)===0)continue;if(a[0]===180&&b[0]===180){a=[-180,a[1]];b=[-180,b[1]];}const side=cmp(a,b)<0?0:1;if(side)[a,b]=[b,a];const k=key(a,b);buffers[bucket(k)].push(JSON.stringify([a,b,byId.get(c.id),side])+'\n');
 }for(let i=0;i<256;i++)if(buffers[i].length)fs.writeSync(fds[i],buffers[i].join(''));}fds.forEach(fd=>fs.closeSync(fd));
 const index=boundaryIndex(readJSON(`${output}/fixed-p0.geojson`)),errors=[],topologyShards=[],borderOrdinals=new Set();let edgeCount=0,maximumBoundaryDisplacement=0;
 for(let bi=0;bi<256;bi++){
  const groups=new Map();for(const line of fs.readFileSync(`${temp}/${bi}.ndjson`,'utf8').split('\n'))if(line){const [a,b,ordinal,side]=JSON.parse(line),k=key(a,b),g=groups.get(k)??{a,b,sides:[[],[]]};g.sides[side].push(ordinal);groups.set(k,g);}
  const edges=[];for(const g of [...groups.values()].sort((a,b)=>cmp(a.a,b.a)||cmp(a.b,b.b))){const left=[...new Set(g.sides[0])],right=[...new Set(g.sides[1])],owners=[...new Set([...left,...right])];
   if(owners.length===1&&left.length&&right.length&&g.a[0]===-180&&g.b[0]===-180)continue;
   if(left.length>1||right.length>1||owners.length>2||!owners.length||owners.some(o=>left.includes(o)&&right.includes(o))){errors.push({kind:'ambiguous-edge-pairing',segment:[g.a,g.b],left,right});continue;}
   let l=left[0]??0,r=right[0]??0;if(!l){[l,r]=[r,l];[g.a,g.b]=[g.b,g.a];}
   let boundaryClass=r?(ordCountry[l-1]!==ordCountry[r-1]?'country':cells[l-1].adminId!==cells[r-1].adminId?(cells[l-1].adminId===null||cells[r-1].adminId===null?'residual':'administrative'):'operational'):'coast';
   if(!r||boundaryClass==='country')for(const o of owners){const m=boundaryMatch(g.a,g.b,ordCountry[o-1],index);if(!m.pass||(!r&&m.neighbors.length))errors.push({kind:!r&&m.neighbors.length?'unpaired-land-border':'boundary-outside-fixed-p0',segment:[g.a,g.b],owners,match:{pass:m.pass,gapDegrees:m.gapDegrees,neighbors:m.neighbors}});else{maximumBoundaryDisplacement=Math.max(maximumBoundaryDisplacement,m.maxDistance);for(const p of m.matches)p.s.intervals.push([p.lo,p.hi]);}}
   if(boundaryClass==='country'){borderOrdinals.add(l);borderOrdinals.add(r);}
   const id=`edge:catalog:${hashCanonical('prompt15-edge-r3.v1',{left:cells[l-1].id,right:r?cells[r-1].id:null,boundaryClass,geometry:[g.a,g.b]})}`;
   edges.push({id,ordinal:++edgeCount,left:l,right:r,boundaryClass,protectedBoundary:r>0&&cells[l-1].oldTerritoryId!==cells[r-1].oldTerritoryId,geometry:{type:'LineString',coordinates:[g.a,g.b]},lengthKm:distanceKm(g.a,g.b)});
  }
  topologyShards.push(write(`world/topology/${bi}.json`,edges));console.log(`topology bucket ${bi}: ${edges.length} edges, ${errors.length} errors`);
 }
 let uncoveredP0Segments=0;for(const s of index.segments.values()){
  if(s.a[0]===-180&&s.b[0]===-180)continue;s.intervals.sort((a,b)=>a[0]-b[0]);let end=0,gap=0;for(const [lo,hi]of s.intervals){gap+=Math.max(0,lo-end);end=Math.max(end,hi);}gap+=Math.max(0,1-end);if(gap*Math.hypot(s.b[0]-s.a[0],s.b[1]-s.a[1])>1e-12)uncoveredP0Segments++;
 }
 const border=cells.filter((_,i)=>borderOrdinals.has(i+1)),max=(list,k)=>list.reduce((n,c)=>Math.max(n,c.metrics[k]),0),physical={cells:cells.length,vertices:meshSummaries.reduce((n,s)=>n+s.chunks.reduce((v,c)=>v+c.vertices,0),0),edges:edgeCount,maxBorderDiameterKm:max(border,'diameterKm'),maxBorderAreaKm2:max(border,'areaKm2'),maxInteriorDiameterKm:max(cells,'diameterKm'),maxInteriorAreaKm2:max(cells,'areaKm2')};
 write('world/topology-validation.json',{pass:!errors.length&&!uncoveredP0Segments,errors,uncoveredP0Segments,maximumBoundaryDisplacement,physical});
 const tileFragments=`${output}/tile-fragments`;fs.mkdirSync(tileFragments,{recursive:true});
 const tileOptions={...DELIVERY_POLICY.tileOptions,promoteId:null,generateId:false,maxZoom:6},transportLayers=['territories','edges'];
 const makeTiles=(features,layer)=>{const vt=geojsonVt({type:'FeatureCollection',features},tileOptions);for(let z=0;z<=6;z++)for(let x=0;x<2**z;x++)for(let y=0;y<2**z;y++){const tile=vt.getTile(z,x,y);if(!tile?.features.length)continue;const p=`${tileFragments}/${z}-${x}-${y}-${layer}.ndjson`;fs.appendFileSync(p,tile.features.map(f=>JSON.stringify(f)+'\n').join(''));}};
 for(const chunk of chunks){makeTiles(readJSON(`${output}/${chunk.path}`).map(c=>({type:'Feature',id:byId.get(c.id),properties:{},geometry:c.geometry})),'territories');}
 for(const shard of topologyShards){makeTiles(readJSON(`${output}/${shard.path}`).map(e=>({type:'Feature',id:e.ordinal,properties:{l:e.left,r:e.right,c:['coast','country','administrative','operational','residual'].indexOf(e.boundaryClass)},geometry:e.geometry})),'edges');}
 const seen=new Set(),seenEdges=new Set(),tiles=[];let renderBytes=0;
 for(let z=0;z<=6;z++)for(let x=0;x<2**z;x++)for(let y=0;y<2**z;y++){
  const layers={};for(const layer of transportLayers){const p=`${tileFragments}/${z}-${x}-${y}-${layer}.ndjson`;if(fs.existsSync(p))layers[layer]={features:fs.readFileSync(p,'utf8').trim().split('\n').map(l=>JSON.parse(l)).sort((a,b)=>a.id-b.id)};}
  const bytes=Buffer.from(fromGeojsonVt(layers,{version:2,extent:tileOptions.extent})),p=`world/tiles/${z}/${x}/${y}.pbf`;fs.mkdirSync(path.dirname(`${output}/${p}`),{recursive:true});fs.writeFileSync(`${output}/${p}`,bytes);const a={...fileIdentity(`${output}/${p}`),path:p};tiles.push(a);renderBytes+=bytes.length;
  const decoded=new VectorTile(new PbfReader(bytes));for(const [layer,data]of Object.entries(decoded.layers))for(let i=0;i<data.length;i++){const f=data.feature(i);if(!Number.isInteger(f.id)||f.id<1||f.id>(layer==='territories'?cells.length:edgeCount))throw Error('Invalid render ordinal');(layer==='territories'?seen:seenEdges).add(f.id);if(layer==='edges'&&(f.properties.l<1||f.properties.l>cells.length||f.properties.r<0||f.properties.r>cells.length))throw Error('Invalid PBF side ordinal');}
 }artifacts.push(...tiles);
 const tileIndex=write('world/tile-index.json',{tiles,renderBytes,territoryOrderArtifact:ordinals.path,edgeOrderShards:topologyShards.map(s=>s.path),tileOptions,decodedCells:seen.size,decodedEdges:seenEdges.size});
 const checks={countryMeshBudgets:meshSummaries.every(s=>s.status==='pass'),edgePairing:!errors.length,fixedP0BoundaryCoverage:!uncoveredP0Segments,worldCells:physical.cells<=P.budgets.worldCells,worldVertices:physical.vertices<=P.budgets.worldVertices,worldEdges:edgeCount<=P.budgets.worldEdges,renderBytes:renderBytes<=P.budgets.renderBytes,metadataBytes:metadata.byteLength<=P.budgets.initialMetadataBytes,stateBytes:state.byteLength<=P.budgets.initialStateBytes,borderDiameter:physical.maxBorderDiameterKm<=P.boundaryMaximumDiameterKm,borderArea:physical.maxBorderAreaKm2<=P.boundaryMaximumAreaKm2,renderOrdinals:seen.size===cells.length&&seenEdges.size===edgeCount};
 const roots={geometry:hashCanonical('r3-geometry-root',chunks.map(c=>({path:c.path,sha256:c.sha256,byteLength:c.byteLength}))),topology:hashCanonical('r3-topology-root',topologyShards),membership:membershipArtifact.sha256,residualMembership:residualArtifact.sha256,render:hashCanonical('r3-render-root',tiles)};
 const version=`catalog-v2-${hashCanonical('prompt15-r3-catalog-version',{policy:Q,roots}).slice(0,32)}`;
 const manifest=write('world/manifest.json',{version,roots,counts:physical,sourceArchive:'source-original.geojson',sourceRecords:'source-records.json',originalCatalogRef:input.oldCatalogRef,geometryShards:chunks.map(c=>c.path),topologyShards:topologyShards.map(s=>s.path),membership:membershipArtifact.path,residualMembership:residualArtifact.path,tileIndex:tileIndex.path,metadata:metadata.path,transport:'Fixed positive feature.id ordinals, no generated IDs; source and active-game layers are distinct',productionCutover:false});
 const artifactIndex=write('artifact-index.json',{version,roots,artifacts:[...input.artifacts,...chunks.map(c=>({path:c.path,sha256:c.sha256,byteLength:c.byteLength})),...artifacts],manifest});
 const result={status:Object.values(checks).every(Boolean)?'pass':'fail',checks,version,roots,physical,renderBytes,decodedCells:seen.size,decodedEdges:seenEdges.size,metadataBytes:metadata.byteLength,elapsedMs:performance.now()-start,peakMemory:process.memoryUsage(),artifactIndex,command:'node --max-old-space-size=16384 scripts/prompt15-r3-world.mjs <output>',tools:{node:process.version},productionCutover:false};write('world-summary.json',result);return result;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){const r=buildWorld(process.argv[2]);console.log(JSON.stringify({status:r.status,checks:r.checks,physical:r.physical}));if(r.status!=='pass')process.exitCode=1;}
