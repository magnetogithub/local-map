// Re-read delivered bytes, compare exact detail to immutable upstream geometry,
// then decode every PBF. Never trust the generator's summary assertions.
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {gunzipSync} from 'node:zlib';
import {VectorTile} from '@mapbox/vector-tile';
import {PbfReader} from 'pbf';
import {compareText,digest,hashCanonical,jsonBytes} from './prompt14-catalog-core.mjs';
import {VERSION,WORLD_ROOT,INDICES_ROOT,INPUT_PINS,POLICY,CLASSES,identity,sameIdentity,readJSON,readGzipJSON,verifyTree,tileCoordinates,artifactRoot,checkTransportFeature,writeArtifact,decodeTilePayload} from './prompt15-world-delivery-core.mjs';

const equal=(a,b,message)=>{if(digest(jsonBytes(a))!==digest(jsonBytes(b)))throw Error(message);};
const missing=seen=>Array.from({length:seen.length-1},(_,i)=>i+1).filter(ordinal=>!seen[ordinal]);
export function verifyWorldDelivery(root,{onProgress=console.log}={}){
  const started=performance.now(),tree=verifyTree(root),inputTrees=INPUT_PINS.map(pin=>verifyTree(pin.root,pin)),manifest=readJSON(path.join(root,'manifest.json')),delivery=readJSON(path.join(root,'delivery-index.json')),tileIndex=readJSON(path.join(root,'tile-index.json')),detailIndex=readJSON(path.join(root,'detail-index.json')),summary=readJSON(path.join(root,'summary.json')),provenance=readJSON(path.join(root,'provenance.json'));
  if(manifest.schemaVersion!==VERSION||delivery.schemaVersion!==VERSION||tileIndex.schemaVersion!==VERSION||detailIndex.schemaVersion!==VERSION||manifest.productionPublication!==false||manifest.runtimeRegeneration!==false||manifest.exactDetailRequired!==true)throw Error('Wrong delivery version/lifecycle');
  equal(manifest.policy,POLICY,'LOD policy changed');
  equal(provenance.inputs,inputTrees.map(input=>input.identity),'Provenance upstream identity changed');
  for(const artifact of provenance.generatorInputs)if(!sameIdentity(identity(artifact.path),artifact))throw Error(`Generator input changed: ${artifact.path}`);
  const buildKey=hashCanonical('prompt15-15-21-build.v1',{policy:POLICY,inputs:provenance.inputs,generatorInputs:provenance.generatorInputs,runtime:provenance.runtime,upstreamVerification:provenance.upstreamVerification}).slice(0,20);
  if(manifest.ref.catalogVersion!==`catalog-v3-${buildKey}`)throw Error('Catalog version is not input-derived');
  for(const ref of [tree.index.ref,delivery.ref,tileIndex.ref,detailIndex.ref,summary.ref])equal(ref,manifest.ref,'Cross-index catalog ref mismatch');
  const expectedDelivery=tree.index.artifacts.filter(a=>!['summary.json','provenance.json','delivery-index.json'].includes(a.path));
  equal(delivery.artifacts,expectedDelivery,'Delivery disk/index mismatch');
  if(delivery.totalByteLength!==delivery.artifacts.reduce((sum,a)=>sum+a.byteLength,0)||delivery.deliveryRoot!==artifactRoot('prompt15-15-21-delivery.v1',delivery.artifacts)||delivery.deliveryRoot!==tree.index.deliveryRoot||delivery.deliveryRoot!==summary.deliveryRoot)throw Error('Delivery root/total mismatch');
  const payload=delivery.artifacts.filter(a=>!['manifest.json','tile-index.json','detail-index.json'].includes(a.path));
  if(manifest.ref.renderArtifactRoot!==artifactRoot('prompt15-15-21-render.v1',payload))throw Error('Render root mismatch');
  for(const descriptor of [manifest.tileIndex,manifest.detailIndex])equal(descriptor,tree.index.artifacts.find(a=>a.path===descriptor.path),'Manifest asset descriptor mismatch');
  const expectedTiles=[...tileCoordinates()].map(tile=>tile.path);
  equal(tileIndex.artifacts.map(a=>a.path),expectedTiles,'Incomplete tile pyramid');
  equal(tileIndex.artifacts.slice().sort((a,b)=>compareText(a.path,b.path)),delivery.artifacts.filter(a=>a.path.endsWith('.pbf.gz')),'Tile identities not bound to delivery');
  const indices=readJSON(`${INDICES_ROOT}/index-root.json`),world=readJSON(`${WORLD_ROOT}/catalog-root.json`),order=readGzipJSON(`${INDICES_ROOT}/catalog-order.json.gz`),cellCount=order.cells.length,edgeCount=indices.counts.edges;
  const geometryRoot=artifactRoot('prompt15-15-21-source-geometry.v1',inputTrees[0].index.artifacts.filter(a=>a.path.endsWith('/geometry.geojson.gz')));
  if(manifest.ref.geometryRoot!==geometryRoot||manifest.ref.topologyRoot!==indices.roots.topology||manifest.ref.catalogOrderRoot!==indices.roots.catalogOrder||manifest.ref.administrativeMembershipRoot!==indices.roots.administrativeMembership||manifest.ref.previousParentRoot!==indices.roots.previousParent||manifest.ref.sourceCatalogRoot!==WORLD_ROOT||manifest.ref.sourceIndicesRoot!==INDICES_ROOT)throw Error('Catalog source root mismatch');
  const admin=readGzipJSON(`${INDICES_ROOT}/administrative-membership.json.gz`),previous=readGzipJSON(`${INDICES_ROOT}/previous-parent-index.json.gz`);
  equal(readGzipJSON(path.join(root,detailIndex.parents)),{administrative:admin.parents,previous:previous.parents},'Parent metadata lost identity/membership');
  equal(detailIndex.countries.map(c=>c.countryId),world.countryOrder,'Country delivery directory incomplete');
  equal(detailIndex.edgeDetails.map(d=>d.shard),indices.topologyShards,'Topology delivery directory incomplete');
  equal(detailIndex.omittedDerivedEdgeFields,['lengthKm'],'Unexpected omitted topology fields');
  const exactCells=new Uint8Array(cellCount+1),exactEdges=new Uint8Array(edgeCount+1),seenCells=new Uint8Array(cellCount+1),seenEdges=new Uint8Array(edgeCount+1),edgeLeft=new Uint32Array(edgeCount+1),edgeRight=new Uint32Array(edgeCount+1),edgeClass=new Uint8Array(edgeCount+1),edgeAdmin=new Uint8Array(edgeCount+1),adminByKey=new Map(admin.parents.map((p,i)=>[p.parentKey,i+1])),previousById=new Map(previous.parents.map((p,i)=>[p.oldTerritoryId,i+1]));
  for(const country of detailIndex.countries){
    const countryId=country.countryId;onProgress(`[verify country] ${countryId}`);
    if(country.detail.path!==`detail/countries/${countryId}.geojson.gz`||country.metadata.path!==`metadata/countries/${countryId}.json.gz`)throw Error('Country detail path mismatch');
    for(const descriptor of [country.detail,country.metadata])equal(descriptor,delivery.artifacts.find(a=>a.path===descriptor.path),'Country detail identity mismatch');
    const source=readGzipJSON(`${WORLD_ROOT}/countries/${countryId}/geometry.geojson.gz`),sourceById=new Map(source.features.map(f=>[f.properties.cellId,f.geometry])),detail=readGzipJSON(path.join(root,country.detail.path)),metadata=readGzipJSON(path.join(root,country.metadata.path));
    equal(metadata.columns,['cellOrdinal','cellId','administrativeOrdinal','previousParentOrdinal'],'Metadata columns changed');
    if(metadata.countryId!==countryId||detail.type!=='FeatureCollection'||country.cellCount!==detail.features.length||source.features.length!==detail.features.length||metadata.rows.length!==detail.features.length)throw Error('Country exact/metadata census mismatch');
    let last=0;for(const [index,feature] of detail.features.entries()){
      const ordinal=feature.id,cell=order.cells[ordinal-1];
      if(!Number.isInteger(ordinal)||ordinal<=last||!cell||cell.sourceCountryId!==countryId||exactCells[ordinal])throw Error('Exact cell identity duplicated or substituted');last=ordinal;exactCells[ordinal]=1;
      equal(feature.geometry,sourceById.get(cell.id),'Exact source polygon/component/hole changed');equal(feature.properties,{},'Unexpected mutable cell state');
      equal(metadata.rows[index],[ordinal,cell.id,adminByKey.get(cell.parentKey),previousById.get(cell.oldTerritoryId)],'Cell metadata parent/canonical ID mismatch');
    }global.gc?.();
  }
  for(const descriptor of detailIndex.edgeDetails){
    if(descriptor.artifact.path!==`detail/${descriptor.shard}`)throw Error('Exact topology path mismatch');
    equal(descriptor.artifact,delivery.artifacts.find(a=>a.path===descriptor.artifact.path),'Exact topology descriptor mismatch');
    const exact=readGzipJSON(path.join(root,descriptor.artifact.path)),source=readGzipJSON(`${INDICES_ROOT}/${descriptor.shard}`);
    equal(exact,{...source,schemaVersion:VERSION,sourceSchemaVersion:source.schemaVersion,edges:source.edges.map(edge=>{const copy={...edge};delete copy.lengthKm;return copy;})},'Exact topology lost geometry, incidence or canonical IDs');
    if(descriptor.count!==exact.edges.length||descriptor.firstOrdinal!==(exact.edges[0]?.ordinal??null))throw Error('Topology directory ordinal mismatch');
    for(const edge of exact.edges){if(!Number.isInteger(edge.ordinal)||edge.ordinal<1||edge.ordinal>edgeCount||exactEdges[edge.ordinal])throw Error('Exact edge ordinal duplicated');exactEdges[edge.ordinal]=1;edgeLeft[edge.ordinal]=edge.left;edgeRight[edge.ordinal]=edge.right;edgeClass[edge.ordinal]=CLASSES.indexOf(edge.boundaryClass);edgeAdmin[edge.ordinal]=Number(edge.flags.administrative);}
  }
  if(missing(exactCells).length||missing(exactEdges).length)throw Error('Incomplete exact source coverage');
  const incidenceDescriptor=manifest.edgeIncidence;
  equal(incidenceDescriptor,{...POLICY.edgeIncidence,artifact:delivery.artifacts.find(a=>a.path===POLICY.edgeIncidence.path),recordCount:edgeCount,decodedByteLength:edgeCount*8},'Edge incidence descriptor mismatch');
  const incidence=gunzipSync(fs.readFileSync(path.join(root,incidenceDescriptor.artifact.path)),{maxOutputLength:edgeCount*8});
  if(incidence.length!==edgeCount*8)throw Error('Incomplete edge incidence');
  for(let ordinal=1;ordinal<=edgeCount;ordinal++)if(incidence.readUInt32LE((ordinal-1)*8)!==edgeLeft[ordinal]||incidence.readUInt32LE((ordinal-1)*8+4)!==edgeRight[ordinal])throw Error(`Edge incidence record differs: ${ordinal}`);
  const byZoom=[];
  for(const {z,path:tilePath} of tileCoordinates()){
    const compressed=fs.readFileSync(path.join(root,tilePath)),bytes=decodeTilePayload(compressed),tile=new VectorTile(new PbfReader(bytes));
    for(const [name,layer] of Object.entries(tile.layers))for(let i=0;i<layer.length;i++){
      const feature=layer.feature(i);checkTransportFeature(name,feature,cellCount,edgeCount,z);
      if(name==='territories')seenCells[feature.id]=1;
      else{const p=feature.properties;if(p.c!==edgeClass[feature.id]||p.a!==edgeAdmin[feature.id])throw Error('Tile edge classes differ from exact source');seenEdges[feature.id]=1;}
    }
    const counts=byZoom[z]??={zoom:z,tiles:0,nonempty:0,byteLength:0,decodedByteLength:0};counts.tiles++;counts.nonempty+=Number(bytes.length>0);counts.byteLength+=compressed.length;counts.decodedByteLength+=bytes.length;
  }
  equal(byZoom,tileIndex.tileCountsByZoom,'Per-zoom byte census differs');equal(byZoom,summary.tileCountsByZoom,'Summary zoom census differs');
  const coverage=readGzipJSON(path.join(root,detailIndex.lodCoverage)),missingCells=missing(seenCells),missingEdges=missing(seenEdges);
  equal(coverage,{schemaVersion:VERSION,cellCount,edgeCount,exactCells:cellCount,exactEdges:edgeCount,overviewCells:cellCount-missingCells.length,overviewEdges:edgeCount-missingEdges.length,missingOverviewCellOrdinals:missingCells,missingOverviewEdgeOrdinals:missingEdges,policy:POLICY.lod},'LOD omission evidence does not match decoded PBFs');
  const deliveredBytes=delivery.totalByteLength+identity(path.join(root,'delivery-index.json')).byteLength,initialMetadataBytes=['manifest.json','tile-index.json','detail-index.json','delivery-index.json',POLICY.edgeIncidence.path].reduce((sum,name)=>sum+identity(path.join(root,name)).byteLength,0);
  if(deliveredBytes>POLICY.renderByteBudget||initialMetadataBytes>POLICY.initialMetadataByteBudget)throw Error('Actual delivery bytes exceed frozen budget');
  const actualCounts={countries:detailIndex.countries.length,cells:cellCount,edges:edgeCount,tiles:expectedTiles.length,overviewCells:coverage.overviewCells,overviewEdges:coverage.overviewEdges,missingOverviewCells:missingCells.length,missingOverviewEdges:missingEdges.length};
  equal(summary.counts,actualCounts,'Summary source/delivery counts differ');
  equal(summary.bytes,{tiles:tileIndex.artifacts.reduce((sum,a)=>sum+a.byteLength,0),exactAndMetadata:payload.filter(a=>!a.path.endsWith('.pbf.gz')).reduce((sum,a)=>sum+a.byteLength,0),delivered:deliveredBytes,initialMetadata:initialMetadataBytes},'Summary byte census differs');
  if(summary.status!=='pass'||!Object.values(summary.checks).every(Boolean))throw Error('Draft summary is not PASS');
  return {task:'15-21',status:'pass',scope:'Current-byte delivery verification only; no runtime, browser, API, migration or REVIEW C acceptance.',root,ref:manifest.ref,deliveryRoot:delivery.deliveryRoot,artifactIndex:tree.identity,counts:actualCounts,bytes:{delivered:deliveredBytes,initialMetadata:initialMetadataBytes},upstreamVerification:summary.upstreamVerification,formalDependencyAcceptance:summary.formalDependencyAcceptance,elapsedMs:performance.now()-started,peakRssBytes:process.resourceUsage().maxRSS*1024};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  if(!process.argv[2]){console.error('Usage: node --expose-gc --max-old-space-size=8192 scripts/verify-prompt15-world-delivery.mjs <delivery-root> [report-path]');process.exitCode=2;}
  else try{const report=verifyWorldDelivery(process.argv[2]);if(process.argv[3]){const file=path.resolve(process.argv[3]);writeArtifact(path.dirname(file),path.basename(file),report);}console.log(JSON.stringify(report));}
  catch(error){console.error(JSON.stringify({status:'fail',message:error.message}));process.exitCode=1;}
}
