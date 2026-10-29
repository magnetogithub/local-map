// Offline task 15-21. Generates a new immutable draft; never publishes it.
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {gzipSync} from 'node:zlib';
import geojsonVt from 'geojson-vt';
import {fromGeojsonVt} from '@maplibre/vt-pbf';
import {VectorTile} from '@mapbox/vector-tile';
import {PbfReader} from 'pbf';
import {compareText,digest,hashCanonical,jsonBytes} from './prompt14-catalog-core.mjs';
import {VERSION,WORLD_ROOT,INDICES_ROOT,INPUT_PINS,POLICY,slash,identity,readJSON,readGzipJSON,verifyTree,writeArtifact,tileCoordinates,artifactRoot,edgeFeature,checkTransportFeature,nondegenerateTileFeature,edgeTileBucket,encodeEdgeIncidence} from './prompt15-world-delivery-core.mjs';

const SOURCE_FILES=['scripts/prompt15-world-delivery.mjs','scripts/prompt15-world-delivery-core.mjs','scripts/prompt15-cell-policy.mjs','scripts/prompt14-catalog-core.mjs','package.json','package-lock.json',
  'node_modules/geojson-vt/package.json','node_modules/@maplibre/vt-pbf/package.json','node_modules/@mapbox/vector-tile/package.json','node_modules/pbf/package.json'];
const collection=features=>({type:'FeatureCollection',features});

export function assertDeliveryInputs(){
  const trees=INPUT_PINS.map(pin=>verifyTree(pin.root,pin)),world=readJSON(`${WORLD_ROOT}/summary.json`),indices=readJSON(`${INDICES_ROOT}/summary.json`),indexRoot=readJSON(`${INDICES_ROOT}/index-root.json`);
  if(world.status!=='pass'||indices.status!=='pass'||!Object.values(world.checks).every(Boolean)||!Object.values(indices.checks).every(Boolean)||indexRoot.sourceCatalogRoot!==WORLD_ROOT||indices.counts.cells!==world.counts.cells)throw Error('15-21 requires matching all-check PASS input drafts');
  const dependencyFiles=['reports/prompt15/15-19-v19-topology-source-repair-v2.json','reports/prompt15/15-20-v20.json'];
  const upstreamVerification=dependencyFiles.map(file=>({path:file,present:fs.existsSync(file),...(fs.existsSync(file)?{identity:identity(file),reportedStatus:readJSON(file).status}:{} )}));
  return {trees,world,indices,indexRoot,upstreamVerification};
}

export function generateWorldDelivery({outputBase='data/derived/prompt15',onProgress=console.log}={}){
  const started=performance.now(),inputs=assertDeliveryInputs(),generatorInputs=SOURCE_FILES.map(identity),runtime={node:process.version,v8:process.versions.v8,zlib:process.versions.zlib,platform:process.platform,arch:process.arch};
  const sourceIdentity={policy:POLICY,inputs:inputs.trees.map(tree=>tree.identity),generatorInputs,runtime,upstreamVerification:inputs.upstreamVerification},key=hashCanonical('prompt15-15-21-build.v1',sourceIdentity).slice(0,20);
  const root=path.join(outputBase,`15-21-world-delivery-v1-${key}`),staging=path.join(outputBase,`.15-21-staging-${key}-${process.pid}`);
  if(fs.existsSync(root)||fs.existsSync(staging))throw Error(`Refusing to overwrite 15-21 output: ${root}`);
  fs.mkdirSync(staging,{recursive:true});
  const artifacts=[],payload=[],write=(name,value,options)=>{const artifact=writeArtifact(staging,name,value,options);artifacts.push(artifact);return artifact;},deliver=(name,value,options)=>{const artifact=write(name,value,options);payload.push(artifact);return artifact;};
  const worldRoot=readJSON(`${WORLD_ROOT}/catalog-root.json`),order=readGzipJSON(`${INDICES_ROOT}/catalog-order.json.gz`),cellCount=order.cells.length,edgeCount=inputs.indices.counts.edges;
  if(cellCount!==inputs.world.counts.cells)throw Error('Input cell census mismatch');
  const ordinalById=new Map(order.cells.map((cell,i)=>[cell.id,i+1])),cellRoot=digest(jsonBytes(order.cells.map(cell=>cell.id)));
  if(cellRoot!==inputs.indexRoot.roots.catalogOrder)throw Error('Input catalog-order root mismatch');
  const admin=readGzipJSON(`${INDICES_ROOT}/administrative-membership.json.gz`),previous=readGzipJSON(`${INDICES_ROOT}/previous-parent-index.json.gz`),adminOrdinals=new Map(admin.parents.map((parent,i)=>[parent.parentKey,i+1])),previousOrdinals=new Map(previous.parents.map((parent,i)=>[parent.oldTerritoryId,i+1]));
  // Only one country or spatial edge bucket is indexed, not the whole world.
  const work=path.join(staging,'.work');fs.mkdirSync(work);
  const appendTiles=(features,layer)=>{
    const index=geojsonVt(collection(features),POLICY.tileOptions);
    for(const {z,x,y} of tileCoordinates()){
      if(layer==='administrative'&&z<POLICY.administrativeMinZoom)continue;
      const tile=index.getTile(z,x,y);if(!tile?.features.length)continue;
      const file=path.join(work,`${z}-${x}-${y}-${layer}.ndjson`);
      const surviving=tile.features.map(nondegenerateTileFeature).filter(Boolean);if(!surviving.length)continue;
      fs.appendFileSync(file,surviving.map(feature=>JSON.stringify(feature)+'\n').join(''));
      if(layer==='edges'&&z>=POLICY.administrativeMinZoom){
        const administrative=surviving.filter(feature=>feature.tags.a===1);
        if(administrative.length)fs.appendFileSync(path.join(work,`${z}-${x}-${y}-administrative.ndjson`),administrative.map(feature=>JSON.stringify(feature)+'\n').join(''));
      }
    }
  };
  const countries=[],edgeDetails=[],cellSeen=new Uint8Array(cellCount+1),edgeSeen=new Uint8Array(edgeCount+1),exactCellSeen=new Uint8Array(cellCount+1),exactEdgeSeen=new Uint8Array(edgeCount+1);
  const edgeLeft=new Uint32Array(edgeCount+1),edgeRight=new Uint32Array(edgeCount+1),edgeClass=new Uint8Array(edgeCount+1),edgeAdmin=new Uint8Array(edgeCount+1);
  for(const [countryIndex,countryId] of worldRoot.countryOrder.entries()){
    onProgress(`[country ${countryIndex+1}/${worldRoot.countryOrder.length}] ${countryId}`);
    const prefix=`${WORLD_ROOT}/countries/${countryId}`,catalog=readGzipJSON(`${prefix}/catalog.json.gz`),geometry=readGzipJSON(`${prefix}/geometry.geojson.gz`),metadataRows=[];
    const features=geometry.features.map(feature=>{
      const ordinal=ordinalById.get(feature.properties.cellId),cell=order.cells[ordinal-1];
      if(!cell||exactCellSeen[ordinal]||cell.sourceCountryId!==countryId)throw Error('Unknown, duplicated or wrong-country exact cell');
      exactCellSeen[ordinal]=1;return {type:'Feature',id:ordinal,properties:{},geometry:feature.geometry};
    }).sort((a,b)=>a.id-b.id);
    for(const entry of catalog.entries){
      const ordinal=ordinalById.get(entry.id),a=adminOrdinals.get(entry.parentKey),p=previousOrdinals.get(entry.oldTerritoryId);
      if(!ordinal||!a||!p)throw Error('Unmapped metadata identity');metadataRows.push([ordinal,entry.id,a,p]);
    }metadataRows.sort((a,b)=>a[0]-b[0]);
    const detail=deliver(`detail/countries/${countryId}.geojson.gz`,collection(features),{compressed:true});
    const metadata=deliver(`metadata/countries/${countryId}.json.gz`,{countryId,columns:['cellOrdinal','cellId','administrativeOrdinal','previousParentOrdinal'],rows:metadataRows},{compressed:true});
    countries.push({countryId,cellCount:features.length,detail,metadata});appendTiles(features,'territories');global.gc?.();
  }
  const edgeWork=path.join(staging,'.edge-work');fs.mkdirSync(edgeWork);
  for(const [shardIndex,shard] of inputs.indexRoot.topologyShards.entries()){
    onProgress(`[edges ${shardIndex+1}/${inputs.indexRoot.topologyShards.length}] ${shard}`);
    const source=readGzipJSON(`${INDICES_ROOT}/${shard}`),features=[];
    for(const edge of source.edges){
      if(edge.ordinal>edgeCount||exactEdgeSeen[edge.ordinal]||edge.left>cellCount||edge.right>cellCount)throw Error('Duplicate or out-of-range exact edge');
      exactEdgeSeen[edge.ordinal]=1;edgeLeft[edge.ordinal]=edge.left;edgeRight[edge.ordinal]=edge.right;edgeClass[edge.ordinal]=['coast','country','administrative','operational','residual'].indexOf(edge.boundaryClass);edgeAdmin[edge.ordinal]=Number(edge.flags.administrative);features.push(edgeFeature(edge));
    }
    const transport={...source,schemaVersion:VERSION,sourceSchemaVersion:source.schemaVersion,edges:source.edges.map(edge=>{const copy={...edge};delete copy.lengthKm;return copy;})};
    const detail=deliver(`detail/${shard}`,transport,{compressed:true});edgeDetails.push({shard,firstOrdinal:source.edges[0]?.ordinal??null,count:source.edges.length,artifact:detail});
    const spatial=Array.from({length:16},()=>[]);
    for(const feature of features)spatial[edgeTileBucket(feature)].push(JSON.stringify(feature)+'\n');
    for(const [bucket,lines] of spatial.entries())if(lines.length)fs.appendFileSync(path.join(edgeWork,`${bucket}.ndjson`),lines.join(''));
    global.gc?.();
  }
  for(let bucket=0;bucket<16;bucket++){
    const file=path.join(edgeWork,`${bucket}.ndjson`);if(!fs.existsSync(file))continue;
    onProgress(`[edge tiles ${bucket+1}/16]`);
    const features=fs.readFileSync(file,'utf8').trimEnd().split('\n').map(line=>JSON.parse(line));
    appendTiles(features,'edges');fs.unlinkSync(file);global.gc?.();
  }
  fs.rmdirSync(edgeWork);
  const edgeIncidence=deliver(POLICY.edgeIncidence.path,gzipSync(encodeEdgeIncidence(edgeLeft,edgeRight),{level:9,mtime:0}),{raw:true});
  const missing=seen=>Array.from({length:seen.length-1},(_,i)=>i+1).filter(i=>!seen[i]);
  if(missing(exactCellSeen).length||missing(exactEdgeSeen).length)throw Error('Exact delivery lost canonical source records');
  const tiles=[],tileCountsByZoom=[];
  for(const {z,x,y,path:tilePath} of tileCoordinates()){
    if(x===0&&y===0)onProgress(`[encode z${z}]`);
    const layers={};
    for(const name of ['territories','edges','administrative']){
      const file=path.join(work,`${z}-${x}-${y}-${name}.ndjson`);if(!fs.existsSync(file))continue;
      layers[name]={features:fs.readFileSync(file,'utf8').trimEnd().split('\n').map(line=>JSON.parse(line)).sort((a,b)=>a.id-b.id)};
      // Fragments are private, single-use staging files under the checked staging root.
      fs.unlinkSync(file);
    }
    const bytes=Buffer.from(fromGeojsonVt(layers,{version:2,extent:POLICY.tileOptions.extent})),decoded=new VectorTile(new PbfReader(bytes));
    for(const [name,layer] of Object.entries(decoded.layers))for(let i=0;i<layer.length;i++){
      const feature=layer.feature(i);checkTransportFeature(name,feature,cellCount,edgeCount,z);
      if(name==='territories')cellSeen[feature.id]=1;
      else{const p=feature.properties;if(p.c!==edgeClass[feature.id]||p.a!==edgeAdmin[feature.id])throw Error('PBF lost exact edge classes');edgeSeen[feature.id]=1;}
    }
    const artifact=deliver(tilePath,gzipSync(bytes,{level:9,mtime:0}),{raw:true});tiles.push(artifact);
    const counts=tileCountsByZoom[z]??={zoom:z,tiles:0,nonempty:0,byteLength:0,decodedByteLength:0};counts.tiles++;counts.nonempty+=Number(bytes.length>0);counts.byteLength+=artifact.byteLength;counts.decodedByteLength+=bytes.length;
  }
  if(fs.readdirSync(work).length)throw Error('Unconsumed tile fragments');fs.rmdirSync(work);
  const coverage={schemaVersion:VERSION,cellCount,edgeCount,exactCells:cellCount,exactEdges:edgeCount,overviewCells:cellSeen.reduce((a,b)=>a+b,0),overviewEdges:edgeSeen.reduce((a,b)=>a+b,0),missingOverviewCellOrdinals:missing(cellSeen),missingOverviewEdgeOrdinals:missing(edgeSeen),policy:POLICY.lod};
  deliver('lod-coverage.json.gz',coverage,{compressed:true});
  deliver('metadata/parents.json.gz',{administrative:admin.parents,previous:previous.parents},{compressed:true});
  const roots={geometry:artifactRoot('prompt15-15-21-source-geometry.v1',inputs.trees[0].index.artifacts.filter(a=>a.path.endsWith('/geometry.geojson.gz'))),...inputs.indexRoot.roots};
  const renderArtifactRoot=artifactRoot('prompt15-15-21-render.v1',payload),catalogVersion=`catalog-v3-${key}`,ref={catalogVersion,sourceCatalogRoot:WORLD_ROOT,sourceIndicesRoot:INDICES_ROOT,geometryRoot:roots.geometry,topologyRoot:roots.topology,catalogOrderRoot:cellRoot,administrativeMembershipRoot:roots.administrativeMembership,previousParentRoot:roots.previousParent,renderArtifactRoot};
  const tileIndex=write('tile-index.json',{schemaVersion:VERSION,ref,artifacts:tiles,tileCountsByZoom}),detailIndex=write('detail-index.json',{schemaVersion:VERSION,ref,countries,edgeDetails,omittedDerivedEdgeFields:POLICY.topologyDetailOmittedDerivedFields,parents:'metadata/parents.json.gz',lodCoverage:'lod-coverage.json.gz',lazy:true});
  const manifest=write('manifest.json',{schemaVersion:VERSION,ref,counts:{countries:countries.length,cells:cellCount,edges:edgeCount,administrativeParents:admin.parents.length,previousParents:previous.parents.length},
    sourceId:'world-operational-catalog',tileTemplate:'tiles/{z}/{x}/{y}.pbf.gz',minZoom:0,maxZoom:6,promoteId:null,policy:POLICY,tileIndex,detailIndex,
    edgeIncidence:{...POLICY.edgeIncidence,artifact:edgeIncidence,recordCount:edgeCount,decodedByteLength:edgeCount*8},
    initialAssets:['manifest.json','tile-index.json','detail-index.json',POLICY.edgeIncidence.path],exactDetailRequired:true,runtimeRegeneration:false,productionPublication:false,
    integration:'Candidate assets only. Runtime/protocol/feature-state integration belongs to 15-37/15-38. No API, migration or browser PASS is asserted.',
    attribution:'Natural Earth (public domain), repository-pinned restored administrative boundaries and synthetic operational cells.'});
  const deliveryArtifacts=[...payload,tileIndex,detailIndex,manifest].sort((a,b)=>compareText(a.path,b.path)),deliveryRoot=artifactRoot('prompt15-15-21-delivery.v1',deliveryArtifacts),deliveryIndex=write('delivery-index.json',{schemaVersion:VERSION,ref,deliveryRoot,artifacts:deliveryArtifacts,totalByteLength:deliveryArtifacts.reduce((sum,a)=>sum+a.byteLength,0)});
  const deliveredBytes=deliveryArtifacts.reduce((sum,a)=>sum+a.byteLength,0)+deliveryIndex.byteLength,initialMetadataBytes=manifest.byteLength+tileIndex.byteLength+detailIndex.byteLength+deliveryIndex.byteLength+edgeIncidence.byteLength;
  const checks={exactCellCoverage:true,exactEdgeCoverage:true,canonicalTileOrdinals:true,administrativeZoomPolicy:true,completeTilePyramid:tiles.length===5461,renderByteBudget:deliveredBytes<=POLICY.renderByteBudget,initialMetadataByteBudget:initialMetadataBytes<=POLICY.initialMetadataByteBudget};
  const summary={task:'15-21',schemaVersion:VERSION,status:Object.values(checks).every(Boolean)?'pass':'fail',root:slash(root),ref,deliveryRoot,checks,counts:{countries:countries.length,cells:cellCount,edges:edgeCount,tiles:tiles.length,overviewCells:coverage.overviewCells,overviewEdges:coverage.overviewEdges,missingOverviewCells:coverage.missingOverviewCellOrdinals.length,missingOverviewEdges:coverage.missingOverviewEdgeOrdinals.length},
    bytes:{tiles:tiles.reduce((sum,a)=>sum+a.byteLength,0),exactAndMetadata:payload.filter(a=>!a.path.endsWith('.pbf.gz')).reduce((sum,a)=>sum+a.byteLength,0),delivered:deliveredBytes,initialMetadata:initialMetadataBytes},budgets:{renderBytes:POLICY.renderByteBudget,initialMetadataBytes:POLICY.initialMetadataByteBudget},tileCountsByZoom,
    upstreamVerification:inputs.upstreamVerification,formalDependencyAcceptance:inputs.upstreamVerification.every(item=>item.present&&item.reportedStatus==='pass')?'reports-present-not-reverified':'missing-independent-reports',
    productionPublication:false,next:'15-21 independent verification; 15-22 and REVIEW C not executed'};
  write('summary.json',summary);write('provenance.json',{task:'15-21',schemaVersion:VERSION,...sourceIdentity,upstreamVerification:inputs.upstreamVerification,runtimeRegeneration:false,productionPublication:false,command:'node --expose-gc --max-old-space-size=8192 scripts/prompt15-world-delivery.mjs'});
  writeArtifact(staging,'artifact-index.json',{schemaVersion:VERSION,ref,deliveryRoot,artifacts:artifacts.slice().sort((a,b)=>compareText(a.path,b.path)),totalByteLength:artifacts.reduce((sum,a)=>sum+a.byteLength,0)});
  if(summary.status!=='pass')throw Object.assign(Error('15-21 delivery budget failed'),{summary,staging});fs.renameSync(staging,root);
  return {root:slash(root),summary,artifactIndex:identity(path.join(root,'artifact-index.json')),elapsedMs:performance.now()-started,peakRssBytes:process.resourceUsage().maxRSS*1024};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){try{const result=generateWorldDelivery();console.log(JSON.stringify(result));}catch(error){console.error(JSON.stringify({status:'fail',message:error.message,staging:error.staging??null,checks:error.summary?.checks??null}));process.exitCode=1;}}
