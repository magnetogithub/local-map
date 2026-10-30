// Prompt 19-02 C: package the verified joint country arrangement with unchanged other countries.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {gzipSync, gunzipSync} from 'node:zlib';
import {geometryMetadata, digest, jsonBytes} from './prompt14-catalog-core.mjs';
import geojsonvt from 'geojson-vt';
import {fromGeojsonVt} from '@maplibre/vt-pbf';

const inputArg=process.argv.indexOf('--input');
if(inputArg>=0&&(!process.argv[inputArg+1]||process.argv[inputArg+1].startsWith('--')))throw Error('MISSING_ARGUMENT:--input');
const inputPath=inputArg<0?'reports/maintenance/prompt19-C/joined-world-input.json':process.argv[inputArg+1];
const inputBytes=fs.readFileSync(inputPath), bundle=JSON.parse(inputBytes);
if(bundle.report.invalid.length || bundle.report.unresolved.length || !bundle.report.topology?.pass)throw Error('UNVERIFIED_JOINED_INPUT');
const verificationArg=process.argv.indexOf('--national-verification');
let nationalBoundaryVerification=null;
if(bundle.report.nationalBoundaryReconciliation){
  const file=verificationArg<0?null:process.argv[verificationArg+1];
  if(!file||file.startsWith('--'))throw Error('MISSING_ARGUMENT:--national-verification');
  const bytes=fs.readFileSync(file), verification=JSON.parse(bytes);
  if(verification.pass!==true||verification.after?.sha256!==digest(inputBytes)||verification.after?.byteLength!==inputBytes.length||verification.before?.sha256!==bundle.report.nationalBoundaryInput?.bundle.sha256)throw Error('UNVERIFIED_NATIONAL_BOUNDARY_INPUT');
  if(bundle.report.nationalBoundaryReconciliation.cleanupBoundarySlivers&&verification.cleanupAcceptance?.pass!==true)throw Error('UNVERIFIED_BOUNDARY_CLEANUP');
  if(bundle.report.westernSectorReconciliation&&(!verification.westernAcceptance?.pass||!verification.westernIsolation?.pass||!verification.westernContactEvidence?.pass||!verification.reproducibility?.pass))throw Error('UNVERIFIED_WESTERN_SECTOR');
  nationalBoundaryVerification={path:file,sha256:digest(bytes),byteLength:bytes.length};
}
// Runtime version depends on geometry, topology, source locks and code, not probe timing/RSS.
const codeInputs=['scripts/prepare-prompt19-joined-candidates.mjs','scripts/prompt19-source-arrangement.mjs','scripts/prompt19-joined-topology.mjs','scripts/prepare-prompt19-mixed-world.mjs',...(bundle.report.fineMacro?['scripts/prepare-prompt19-fine-macro-world.mjs','scripts/prompt19-fine-macro-topology.mjs']:[]),...(bundle.report.nationalBoundaryReconciliation?['scripts/prepare-prompt19-national-boundary-world.mjs','scripts/prompt19-national-boundary-reconciliation.mjs','scripts/prompt14-boundary-arrangement.mjs','scripts/prompt14-catalog-topology.mjs','scripts/prompt14-catalog-core.mjs']:[])].map(file=>({path:file,sha256:digest(fs.readFileSync(file))}));
const sourceLockArtifacts=bundle.report.sourceLockArtifacts??['KOR','PRK'].map(countryId=>({countryId,path:`data/source-locks/prompt19/${countryId}.json`}));
if(bundle.report.nationalBoundaryReconciliation?.cleanupBoundarySlivers)codeInputs.push({path:'scripts/prepare-prompt19-boundary-cleanup-world.mjs',sha256:digest(fs.readFileSync('scripts/prepare-prompt19-boundary-cleanup-world.mjs'))});
if(bundle.report.westernSectorReconciliation)for(const file of ['scripts/prepare-prompt19-western-sector-world.mjs','scripts/prompt19-western-sector-reconciliation.mjs'])codeInputs.push({path:file,sha256:digest(fs.readFileSync(file))});
if(sourceLockArtifacts.length!==2||new Set(sourceLockArtifacts.map(a=>a.countryId)).size!==2||!sourceLockArtifacts.every(a=>['KOR','PRK'].includes(a.countryId)))throw Error('SOURCE_LOCK_SCOPE');
const sourceLocks=sourceLockArtifacts.map(a=>{const bytes=fs.readFileSync(a.path);if(a.sha256&&(digest(bytes)!==a.sha256||bytes.length!==a.byteLength))throw Error('SOURCE_LOCK_CHANGED');const lock=JSON.parse(bytes);if(lock.countryId!==a.countryId)throw Error('SOURCE_LOCK_COUNTRY');return lock;});
for(const a of bundle.report.hierarchyArtifacts??[]){const bytes=fs.readFileSync(a.path);if(bytes.length!==a.byteLength||digest(bytes)!==a.sha256)throw Error('HIERARCHY_LOCK_CHANGED');}
for(const a of Object.values(bundle.report.nationalBoundaryInput??{})){const bytes=fs.readFileSync(a.path);if(bytes.length!==a.byteLength||digest(bytes)!==a.sha256)throw Error('NATIONAL_BOUNDARY_INPUT_CHANGED');}
for(const a of Object.values(bundle.report.westernSectorInput??{})){const bytes=fs.readFileSync(a.path);if(bytes.length!==a.byteLength||digest(bytes)!==a.sha256)throw Error('WESTERN_SECTOR_INPUT_CHANGED');}
const key=digest(jsonBytes({features:bundle.features,records:bundle.records,edges:bundle.edges,parents:bundle.parents,regionNames:bundle.regionNames??null,hierarchyArtifacts:bundle.report.hierarchyArtifacts??[],nationalBoundaryInput:bundle.report.nationalBoundaryInput??null,nationalBoundaryReconciliation:bundle.report.nationalBoundaryReconciliation??null,westernSectorInput:bundle.report.westernSectorInput??null,westernSectorReconciliation:bundle.report.westernSectorReconciliation??null,nationalBoundaryVerification,sourceLocks,codeInputs})).slice(0,20), version=`catalog-v3-prompt19-korea-${key}`;
const schemaVersion='operational-world-delivery-v2';
const output=`data/derived/prompt19/mixed-world-v2-${key}`;
const json=value=>Buffer.from(`${JSON.stringify(value)}\n`);
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const inputRoot=digest(inputBytes), identities=[{path:inputPath,sha256:inputRoot,byteLength:inputBytes.length},...(bundle.report.hierarchyArtifacts??[]),...Object.values(bundle.report.nationalBoundaryInput??{}),...Object.values(bundle.report.westernSectorInput??{})];
if(fs.existsSync(output)) {
  const index=fs.readFileSync(`${output}/artifact-index.json`);
  for(const a of JSON.parse(index).artifacts){const bytes=fs.readFileSync(path.join(output,a.path));if(bytes.length!==a.byteLength||sha(bytes)!==a.sha256)throw Error(`IMMUTABLE_ARTIFACT_CHANGED:${a.path}`);}
  const pointer={catalogVersion:version,root:output,index:{sha256:sha(index),byteLength:index.length}};
  fs.writeFileSync('data/runtime/operational-catalog/current.json',json(pointer));console.log(JSON.stringify(pointer));process.exit(0);
}
const artifacts = [];
function write(file, value, raw = false) {
  let bytes = raw ? value : json(value);
  if (file.endsWith('.gz')) bytes = gzipSync(bytes, {level: 9});
  const target = path.join(output, file);
  fs.mkdirSync(path.dirname(target), {recursive: true}); fs.writeFileSync(target, bytes, {flag: 'wx'});
  const identity = {path: file, sha256: sha(bytes), byteLength: bytes.length}; artifacts.push(identity); return identity;
}
const records=[...bundle.records].sort((a,b)=>a.id.localeCompare(b.id));
const catalog={territoryOrder:records.map(r=>r.id)};
const ordinal=new Map(catalog.territoryOrder.map((id,i)=>[id,i+1]));
const entries=new Map(records.map(r=>[r.id,{...r,sourceCountryId:r.countryId}]));
const countryOrder=[...new Set(records.map(r=>r.countryId))].sort();
const featureById=new Map(bundle.features.map(f=>[f.id,f]));
const features=records.map((r,i)=>({type:'Feature',id:i+1,properties:{},geometry:featureById.get(r.id).geometry}));
const names=new Map([...Object.entries(JSON.parse(gunzipSync(fs.readFileSync('data/derived/prompt19/coarse-world-v1/region-names.json.gz')))),...Object.entries(bundle.regionNames??{})]);
const administrative=bundle.parents.administrative.map(p=>({...p,start:0,count:0}));
const previous=bundle.parents.previous.map(p=>({...p,start:0,count:0}));
const adminOrdinal=new Map(administrative.map((p,i)=>[p.parentKey,i+1]));
const prevOrdinal=new Map(previous.map((p,i)=>[p.oldTerritoryId,i+1]));
const rows=[],metrics=[];
for(const [i,r]of records.entries()) {
  const a=adminOrdinal.get(r.administrativeParentKey),p=prevOrdinal.get(r.previousParentId);
  if(!a||!p)throw Error('UNKNOWN_MIXED_PARENT');
  for(const parent of[administrative[a-1],previous[p-1]]){if(!parent.count)parent.start=i;parent.count++;}
  rows.push([i+1,r.id,a,p]);
  const g=features[i].geometry,m=geometryMetadata(g),[west,south,east,north]=m.bbox;
  const diameterKm=Math.max(0.001,Math.hypot((east-west)*Math.cos(m.centroid[1]*Math.PI/180),north-south)*111.195);
  const ps=g.type==='Polygon'?[g.coordinates]:g.coordinates;
  const ringArea=ring=>Math.abs(ring.slice(1).reduce((sum,b,j)=>{const a=ring[j];return sum+(b[0]-a[0])*Math.PI/180*(2+Math.sin(a[1]*Math.PI/180)+Math.sin(b[1]*Math.PI/180));},0)*6371.0088**2/2);
  const areaKm2=Math.max(0,ps.reduce((sum,p)=>sum+ringArea(p[0])-p.slice(1).reduce((n,r)=>n+ringArea(r),0),0));
  metrics.push({id:r.id,sourceCountryId:r.countryId,centroid:m.centroid,areaKm2,diameterKm});
}
if(administrative.some(p=>!p.count)||previous.some(p=>!p.count))throw Error('EMPTY_MIXED_PARENT');
const topology={edges:bundle.edges};
const distances = coordinates => coordinates.slice(1).reduce((sum, b, i) => {
  const a = coordinates[i], rad = Math.PI / 180, dy = (b[1] - a[1]) * rad, dx = (b[0] - a[0]) * rad;
  const h = Math.sin(dy / 2) ** 2 + Math.cos(a[1] * rad) * Math.cos(b[1] * rad) * Math.sin(dx / 2) ** 2;
  return sum + 2 * 6371.0088 * Math.asin(Math.min(1, Math.sqrt(h)));
}, 0);
const edges = topology.edges.map((e, i) => {
  const left = ordinal.get(e.leftTerritoryId), right = ordinal.get(e.rightTerritoryId) ?? 0;
  const country = right > 0 && entries.get(e.leftTerritoryId).sourceCountryId !== entries.get(e.rightTerritoryId).sourceCountryId;
  const boundaryClass = !right ? 'coast' : country ? 'country' : ['administrative','operational','residual'].includes(e.boundaryClass) ? e.boundaryClass : 'residual';
  return {id: e.id, ordinal: i + 1, left, right,
    lengthKm: distances(e.geometry.coordinates), boundaryClass,
    flags: {positiveAdjacency: right > 0, country, administrative: boundaryClass === 'administrative', previous: right > 0 && entries.get(e.leftTerritoryId).previousParentId!==entries.get(e.rightTerritoryId).previousParentId, residual: boundaryClass === 'residual'}, geometry: e.geometry};
});
if (edges.some(e => !e.left || e.left === e.right || !(e.lengthKm > 0))) throw Error('Invalid coarse edge');
const counts = {countries: countryOrder.length, cells: rows.length, edges: edges.length, administrativeParents: administrative.length, previousParents: previous.length};
const adjacency = Array.from({length: rows.length}, () => new Set());
for (const e of edges) if (e.right) {adjacency[e.left - 1].add(e.right); adjacency[e.right - 1].add(e.left);}
const offsets = [0], neighbors = [];
for (const values of adjacency) {neighbors.push(...[...values].sort((a, b) => a - b)); offsets.push(neighbors.length);}
write('adjacency.json.gz', {cellCount: rows.length, offsets, neighbors});
write('metrics.json.gz', metrics);
write('region-names.json.gz', Object.fromEntries([...new Set(administrative.map(p => p.sourceFeatureId).filter(Boolean))].map(id => [id, names.get(id)])));
write('metadata/parents.json.gz', {administrative, previous});
const countries = [];
for (const countryId of countryOrder) {
  const countryRows = rows.filter(r => entries.get(r[1]).sourceCountryId === countryId);
  const ids = new Set(countryRows.map(r => r[0]));
  const metadata = write(`metadata/countries/${countryId}.json.gz`, {countryId, columns: ['cellOrdinal', 'cellId', 'administrativeOrdinal', 'previousParentOrdinal'], rows: countryRows});
  const detail = write(`detail/countries/${countryId}.geojson.gz`, {type: 'FeatureCollection', features: features.filter(f => ids.has(f.id))});
  countries.push({countryId, cellCount: countryRows.length, metadata, detail});
}
const edgeDetails = [];
for (let start = 0; start < edges.length; start += 2048) {
  const shard = `topology/${String(edgeDetails.length).padStart(3, '0')}.json.gz`, selected = edges.slice(start, start + 2048);
  const artifact = write(`detail/${shard}`, {schemaVersion, edges: selected});
  edgeDetails.push({shard, firstOrdinal: start + 1, count: selected.length, artifact});
}
const incidence = Buffer.alloc(edges.length * 8);
edges.forEach((e, i) => {incidence.writeUInt32LE(e.left, i * 8); incidence.writeUInt32LE(e.right, i * 8 + 4);});
const edgeIncidence = write('metadata/edge-incidence.bin.gz', incidence, true);
const options = {maxZoom: 6, indexMaxZoom: 4, indexMaxPoints: 100000, tolerance: 1, extent: 4096, buffer: 64, generateId: false};
const fc = values => ({type: 'FeatureCollection', features: values});
const classes = ['coast', 'country', 'administrative', 'operational', 'residual'];
const isKoreaOrdinal=n=>n>0&&['KOR','PRK'].includes(records[n-1].countryId);
const exactOverviewCells=new Set(features.filter(f=>isKoreaOrdinal(f.id)).map(f=>f.id));
for(const e of edges)if(e.flags.country&&(isKoreaOrdinal(e.left)||isKoreaOrdinal(e.right))){exactOverviewCells.add(e.left);exactOverviewCells.add(e.right);}
const cellIndex=geojsonvt(fc(features.filter(f=>!exactOverviewCells.has(f.id))),options);
const koreaIndex=geojsonvt(fc(features.filter(f=>exactOverviewCells.has(f.id))),{...options,tolerance:0});
const edgeFeature=e=>({type:'Feature',id:e.ordinal,properties:{c:classes.indexOf(e.boundaryClass),a:Number(e.flags.administrative)},geometry:e.geometry});
const exactEdge=e=>isKoreaOrdinal(e.left)||isKoreaOrdinal(e.right);
const edgeIndex=geojsonvt(fc(edges.filter(e=>!exactEdge(e)).map(edgeFeature)),options);
const koreaEdgeIndex=geojsonvt(fc(edges.filter(exactEdge).map(edgeFeature)),{...options,tolerance:0});
const tiles = [], seenCells = new Set(), seenEdges = new Set();
for (let z = 0; z <= 6; z++) {
  console.log(`Packaging mixed tiles z${z}`);
  for (let x = 0; x < 2 ** z; x++) for (let y = 0; y < 2 ** z; y++) {
    const coarse=cellIndex.getTile(z,x,y),fine=koreaIndex.getTile(z,x,y);
    const cells={features:[...(coarse?.features??[]),...(fine?.features??[])]},coarseLines=edgeIndex.getTile(z,x,y),fineLines=koreaEdgeIndex.getTile(z,x,y),lines={features:[...(coarseLines?.features??[]),...(fineLines?.features??[])]},layers={};
    if (cells?.features.length) {layers.territories = cells; cells.features.forEach(f => seenCells.add(f.id));}
    if (lines?.features.length) {
      layers.edges = lines; lines.features.forEach(f => seenEdges.add(f.id));
      const admin = lines.features.filter(f => f.tags.a === 1);
      if (z >= 4 && admin.length) layers.administrative = {features: admin};
    }
    tiles.push(write(`tiles/${z}/${x}/${y}.pbf.gz`, Buffer.from(fromGeojsonVt(layers, {version: 2, extent: 4096})), true));
  }
}
write('lod-coverage.json.gz', {schemaVersion, cellCount: rows.length, edgeCount: edges.length, exactCells: rows.length, exactEdges: edges.length,
  missingOverviewCellOrdinals: rows.map(r => r[0]).filter(n => !seenCells.has(n)), missingOverviewEdgeOrdinals: edges.map(e => e.ordinal).filter(n => !seenEdges.has(n))});
const ref = {catalogVersion: version, geometryRoot: sha(json(features)), topologyRoot: sha(json(edges)),
  renderArtifactRoot: sha(json(artifacts)), catalogOrderRoot: sha(json(catalog.territoryOrder)),
  administrativeMembershipRoot: sha(json(administrative)), previousParentRoot: sha(json(previous))};
const descriptor = {schemaVersion: 'operational-catalog-v1', catalogRef: {catalogVersion: version, geometryRoot: ref.geometryRoot,
  topologyRoot: ref.topologyRoot, renderArtifactRoot: ref.renderArtifactRoot, manifestPath: `/data/territory-catalog/${version}/manifest.json`},
  indexRoots: {catalogOrder: ref.catalogOrderRoot, administrativeMembership: ref.administrativeMembershipRoot, previousParent: ref.previousParentRoot}, counts, countryOrder};
const tileIndex = write('tile-index.json', {schemaVersion, ref, artifacts: tiles});
const detailIndex = write('detail-index.json', {schemaVersion, ref, countries, edgeDetails, parents: 'metadata/parents.json.gz', lodCoverage: 'lod-coverage.json.gz', lazy: true});
write('manifest.json', {schemaVersion, ref, counts, sourceId: 'world-operational-catalog', minZoom: 0, maxZoom: 6, promoteId: null,
  tileTemplate: 'tiles/{z}/{x}/{y}.pbf.gz', tileIndex, detailIndex, policy: {tileTransport: {compression: 'gzip', httpContentEncoding: null}, administrativeMinZoom: 4, operationalMinZoom: 8},
  edgeIncidence: {format: 'uint32-le-pairs', recordBytes: 8, recordCount: edges.length, decodedByteLength: incidence.length, artifact: edgeIncidence},
  runtimeRegeneration: false, attribution: `Natural Earth (public domain). ${sourceLocks.flatMap(lock=>lock.sources.map(s=>`${lock.countryId} ADM${s.adminLevel}: ${s.license.attribution} (${s.license.name}).`)).join(' ')} Source properties normalized, boundaries noded and limited to fixed project envelopes. ${bundle.report.nationalBoundaryReconciliation ? "Fine gameplay outlines include documented country/coast residual-strip reconciliation; unchanged raw sources remain independent evidence. Remaining residuals have no fine administrative attribution." : "Coarse residuals have no fine administrative attribution."}`});
write('catalog.json', descriptor);
write('provenance.json',{stage:bundle.report.westernSectorReconciliation?'fine-western-sector-complete':bundle.report.nationalBoundaryReconciliation?.cleanupBoundarySlivers?'fine-boundary-sliver-cleanup':bundle.report.nationalBoundaryReconciliation?'fine-national-coast-reconciled':bundle.report.fineMacro?'fine-derived-macro':'19-02-C',inputRoot,inputs:identities,sourceLocks,sourceLockArtifacts,codeInputs,summary:bundle.report.summary,topology:bundle.report.topology,fineMacro:bundle.report.fineMacro??null,hierarchyArtifacts:bundle.report.hierarchyArtifacts??[],nationalBoundaryInput:bundle.report.nationalBoundaryInput??null,nationalBoundaryReconciliation:bundle.report.nationalBoundaryReconciliation??null,westernSectorInput:bundle.report.westernSectorInput??null,westernSectorReconciliation:bundle.report.westernSectorReconciliation??null,nationalBoundaryVerification,method:bundle.report.nationalBoundaryReconciliation?.policy??bundle.report.fineMacro?.method??'Joint exact source/coarse/P0 arrangement. Zero source coordinates moved; no extrapolated lines; unmatched fixed P0 land explicitly retains coarse provenance. Other 245 countries unchanged.',worldCoverageComplete:true,fineAssignmentComplete:false,compatibility:'New games only; previous catalog sessions are rejected.'});
artifacts.sort((a, b) => a.path.localeCompare(b.path));
const indexBytes = json({schemaVersion, artifacts: [...artifacts], totalByteLength: artifacts.reduce((n, a) => n + a.byteLength, 0)});
fs.writeFileSync(path.join(output, 'artifact-index.json'), indexBytes, {flag: 'wx'});
const pointer = {catalogVersion: version, root: output, index: {sha256: sha(indexBytes), byteLength: indexBytes.length}};
fs.mkdirSync('data/runtime/operational-catalog', {recursive: true});
fs.writeFileSync('data/runtime/operational-catalog/current.json', json(pointer));
console.log(JSON.stringify({output, ...pointer, counts, deliveredBytes: artifacts.reduce((n, a) => n + a.byteLength, 0)}));
