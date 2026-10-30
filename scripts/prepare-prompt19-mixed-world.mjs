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
const option=name=>{const i=process.argv.indexOf(name);if(i<0)return null;const value=process.argv[i+1];if(!value||value.startsWith('--'))throw Error(`MISSING_ARGUMENT:${name}`);return value;};
const incremental=bundle.report.incremental??null;
if(process.argv.includes('--activate')&&process.argv.includes('--no-activate'))throw Error('CONFLICTING_ACTIVATION_ARGUMENTS');
const activate=incremental?process.argv.includes('--activate'):!process.argv.includes('--no-activate');
const checkedPin=(a,label)=>{
  if(!a||typeof a.path!=='string'||!/^[a-f0-9]{64}$/.test(a.sha256)||!Number.isSafeInteger(a.byteLength)||a.byteLength<0)throw Error(`INVALID_PIN:${label}`);
  const physicalRoot=fs.realpathSync(process.cwd()),physical=fs.realpathSync(a.path),relative=path.relative(physicalRoot,physical);
  if(relative.startsWith('..')||path.isAbsolute(relative))throw Error(`PIN_OUTSIDE_WORKSPACE:${label}`);
  const bytes=fs.readFileSync(physical);if(bytes.length!==a.byteLength||digest(bytes)!==a.sha256)throw Error(`PIN_CHANGED:${label}`);return bytes;
};
let incrementalVerification=null,baselinePointer=null,baselineBundle=null;
if(incremental){
  if(incremental.countryId!=='CHN')throw Error('UNSUPPORTED_INCREMENTAL_ADAPTER');
  const file=option('--incremental-verification');if(!file)throw Error('MISSING_ARGUMENT:--incremental-verification');
  const bytes=fs.readFileSync(file),verification=JSON.parse(bytes),baseline=incremental.baseline;
  if(!baseline)throw Error('MISSING_INCREMENTAL_BASELINE');
  baselinePointer=JSON.parse(checkedPin(baseline.pointer,'baseline.pointer'));
  baselineBundle=JSON.parse(checkedPin(baseline.bundle,'baseline.bundle'));
  const proof=JSON.parse(checkedPin(baseline.nationalBoundaryVerification,'baseline.nationalBoundaryVerification'));
  if(!baselinePointer.root||!baselinePointer.catalogVersion||!baselinePointer.index)throw Error('INVALID_BASELINE_POINTER');
  const baselineIndex=JSON.parse(checkedPin({path:`${baselinePointer.root}/artifact-index.json`,...baselinePointer.index},'baseline.index'));
  const provenanceArtifact=baselineIndex.artifacts?.find(a=>a.path==='provenance.json');if(!provenanceArtifact)throw Error('BASELINE_PROVENANCE_NOT_INDEXED');
  const provenance=JSON.parse(checkedPin({...provenanceArtifact,path:`${baselinePointer.root}/provenance.json`},'baseline.provenance'));
  if(provenance.inputRoot!==baseline.bundle.sha256||!provenance.inputs?.some(a=>a.path===baseline.bundle.path&&a.sha256===baseline.bundle.sha256&&a.byteLength===baseline.bundle.byteLength))throw Error('BASELINE_INPUT_NOT_ACTIVE');
  if(provenance.nationalBoundaryVerification?.sha256!==baseline.nationalBoundaryVerification.sha256||provenance.nationalBoundaryVerification?.byteLength!==baseline.nationalBoundaryVerification.byteLength)throw Error('BASELINE_PROOF_NOT_ACTIVE');
  if(proof.pass!==true||proof.after?.sha256!==baseline.bundle.sha256||proof.after?.byteLength!==baseline.bundle.byteLength||proof.before?.sha256!==baselineBundle.report.nationalBoundaryInput?.bundle.sha256)throw Error('UNVERIFIED_BASELINE_NATIONAL_BOUNDARY');
  if(baselineBundle.report.nationalBoundaryReconciliation?.cleanupBoundarySlivers&&proof.cleanupAcceptance?.pass!==true)throw Error('UNVERIFIED_BASELINE_BOUNDARY_CLEANUP');
  if(baselineBundle.report.westernSectorReconciliation&&(!proof.westernAcceptance?.pass||!proof.westernIsolation?.pass||!proof.westernContactEvidence?.pass||!proof.reproducibility?.pass))throw Error('UNVERIFIED_BASELINE_WESTERN_SECTOR');
  if(verification.pass!==true||verification.after?.sha256!==digest(inputBytes)||verification.after?.byteLength!==inputBytes.length||verification.before?.sha256!==baseline.bundle.sha256||verification.before?.byteLength!==baseline.bundle.byteLength||verification.baselinePointer?.sha256!==baseline.pointer.sha256||verification.baselinePointer?.byteLength!==baseline.pointer.byteLength)throw Error('UNVERIFIED_INCREMENTAL_INPUT');
  for(const check of ['nonTargetPreservation','sourcePins','hierarchy','topology','coverage','residualAudit','reproducibility'])if(verification.checks?.[check]!==true)throw Error(`MISSING_INCREMENTAL_ACCEPTANCE:${check}`);
  incrementalVerification={path:file,sha256:digest(bytes),byteLength:bytes.length};
}
const verificationArg=process.argv.indexOf('--national-verification');
let nationalBoundaryVerification=null;
if(incremental)nationalBoundaryVerification=incremental.baseline.nationalBoundaryVerification;
else if(bundle.report.nationalBoundaryReconciliation){
  const file=verificationArg<0?null:process.argv[verificationArg+1];
  if(!file||file.startsWith('--'))throw Error('MISSING_ARGUMENT:--national-verification');
  const bytes=fs.readFileSync(file), verification=JSON.parse(bytes);
  if(verification.pass!==true||verification.after?.sha256!==digest(inputBytes)||verification.after?.byteLength!==inputBytes.length||verification.before?.sha256!==bundle.report.nationalBoundaryInput?.bundle.sha256)throw Error('UNVERIFIED_NATIONAL_BOUNDARY_INPUT');
  if(bundle.report.nationalBoundaryReconciliation.cleanupBoundarySlivers&&verification.cleanupAcceptance?.pass!==true)throw Error('UNVERIFIED_BOUNDARY_CLEANUP');
  if(bundle.report.westernSectorReconciliation&&(!verification.westernAcceptance?.pass||!verification.westernIsolation?.pass||!verification.westernContactEvidence?.pass||!verification.reproducibility?.pass))throw Error('UNVERIFIED_WESTERN_SECTOR');
  nationalBoundaryVerification={path:file,sha256:digest(bytes),byteLength:bytes.length};
}
// Runtime version depends on geometry, topology, source locks and code, not probe timing/RSS.
const codeInputs=(incremental?['scripts/chn-2020/prepare-china.py','scripts/chn-2020/incremental-coordinator.mjs','scripts/prepare-prompt19-mixed-world.mjs','scripts/prompt14-catalog-core.mjs']:['scripts/prepare-prompt19-joined-candidates.mjs','scripts/prompt19-source-arrangement.mjs','scripts/prompt19-joined-topology.mjs','scripts/prepare-prompt19-mixed-world.mjs',...(bundle.report.fineMacro?['scripts/prepare-prompt19-fine-macro-world.mjs','scripts/prompt19-fine-macro-topology.mjs']:[]),...(bundle.report.nationalBoundaryReconciliation?['scripts/prepare-prompt19-national-boundary-world.mjs','scripts/prompt19-national-boundary-reconciliation.mjs','scripts/prompt14-boundary-arrangement.mjs','scripts/prompt14-catalog-topology.mjs','scripts/prompt14-catalog-core.mjs']:[])]).map(file=>({path:file,sha256:digest(fs.readFileSync(file))}));
const sourceLockArtifacts=bundle.report.sourceLockArtifacts??['KOR','PRK'].map(countryId=>({countryId,path:`data/source-locks/prompt19/${countryId}.json`}));
if(!incremental&&bundle.report.nationalBoundaryReconciliation?.cleanupBoundarySlivers)codeInputs.push({path:'scripts/prepare-prompt19-boundary-cleanup-world.mjs',sha256:digest(fs.readFileSync('scripts/prepare-prompt19-boundary-cleanup-world.mjs'))});
if(!incremental&&bundle.report.westernSectorReconciliation)for(const file of ['scripts/prepare-prompt19-western-sector-world.mjs','scripts/prompt19-western-sector-reconciliation.mjs'])codeInputs.push({path:file,sha256:digest(fs.readFileSync(file))});
const fineCountries=incremental?incremental.fineCountries:['KOR','PRK'];
const expectedCountries=incremental?['CHN','KOR','PRK']:['KOR','PRK'];
if(!Array.isArray(fineCountries)||JSON.stringify([...fineCountries].sort())!==JSON.stringify(expectedCountries)||sourceLockArtifacts.length!==expectedCountries.length||new Set(sourceLockArtifacts.map(a=>a.countryId)).size!==expectedCountries.length||!sourceLockArtifacts.every(a=>expectedCountries.includes(a.countryId)))throw Error('SOURCE_LOCK_SCOPE');
const sourceLocks=sourceLockArtifacts.map(a=>{const bytes=fs.readFileSync(a.path);if(a.sha256&&(digest(bytes)!==a.sha256||bytes.length!==a.byteLength))throw Error('SOURCE_LOCK_CHANGED');const lock=JSON.parse(bytes);if(lock.countryId!==a.countryId)throw Error('SOURCE_LOCK_COUNTRY');return lock;});
if(incremental){
  for(const a of sourceLockArtifacts)checkedPin(a,`source-lock:${a.countryId}`);
  for(const old of baselineBundle.report.sourceLockArtifacts){const retained=sourceLockArtifacts.find(a=>a.countryId===old.countryId);if(!retained||retained.sha256!==old.sha256||retained.byteLength!==old.byteLength)throw Error('BASELINE_SOURCE_LOCK_REPLACED');}
  for(const old of baselineBundle.report.hierarchyArtifacts??[]){const retained=(bundle.report.hierarchyArtifacts??[]).find(a=>a.countryId===old.countryId);if(!retained||retained.sha256!==old.sha256||retained.byteLength!==old.byteLength)throw Error('BASELINE_HIERARCHY_REPLACED');}
  if(!Array.isArray(incremental.codeArtifacts)||!incremental.codeArtifacts.length)throw Error('MISSING_INCREMENTAL_CODE_PINS');
  for(const file of ['scripts/chn-2020/prepare-china.py','scripts/chn-2020/incremental-coordinator.mjs'])if(!incremental.codeArtifacts.some(a=>a.path===file))throw Error(`MISSING_INCREMENTAL_CODE_PIN:${file}`);
  for(const a of incremental.codeArtifacts){checkedPin(a,`code:${a.path}`);const existing=codeInputs.find(c=>c.path===a.path);if(existing&&existing.sha256!==a.sha256)throw Error(`CODE_PIN_CONFLICT:${a.path}`);if(!existing)codeInputs.push(a);}
  for(const lock of sourceLocks){for(const source of lock.sources){if(source.license?.redistributionAllowed!==true)throw Error('SOURCE_REDISTRIBUTION_NOT_AUTHORIZED');checkedPin(source.artifact,`raw:${lock.countryId}:${source.sourceId}`);}checkedPin(lock.normalizedInput,`normalized:${lock.countryId}`);for(const a of lock.preprocessing.code)checkedPin(a,`source-code:${lock.countryId}`);}
}
for(const a of bundle.report.hierarchyArtifacts??[]){const bytes=fs.readFileSync(a.path);if(bytes.length!==a.byteLength||digest(bytes)!==a.sha256)throw Error('HIERARCHY_LOCK_CHANGED');}
for(const a of Object.values(bundle.report.nationalBoundaryInput??{})){const bytes=fs.readFileSync(a.path);if(bytes.length!==a.byteLength||digest(bytes)!==a.sha256)throw Error('NATIONAL_BOUNDARY_INPUT_CHANGED');}
for(const a of Object.values(bundle.report.westernSectorInput??{})){const bytes=fs.readFileSync(a.path);if(bytes.length!==a.byteLength||digest(bytes)!==a.sha256)throw Error('WESTERN_SECTOR_INPUT_CHANGED');}
function assertActiveFineCountriesPreserved(){
  const currentFile='data/runtime/operational-catalog/current.json',currentBytes=fs.readFileSync(currentFile),current=JSON.parse(currentBytes);
  const index=JSON.parse(checkedPin({...current.index,path:`${current.root}/artifact-index.json`},'active.index'));
  const artifact=index.artifacts?.find(a=>a.path==='provenance.json');if(!artifact)throw Error('ACTIVE_FINE_COUNTRIES_UNVERIFIABLE');
  const provenance=JSON.parse(checkedPin({...artifact,path:`${current.root}/provenance.json`},'active.provenance'));
  const explicit=provenance.fineCountries,sourceCountries=provenance.sourceLockArtifacts?.map(a=>a.countryId)??provenance.sourceLocks?.map(a=>a.countryId);
  if((explicit!==undefined&&!Array.isArray(explicit))||!Array.isArray(sourceCountries))throw Error('ACTIVE_FINE_COUNTRIES_UNVERIFIABLE');
  const activeFineCountries=[...new Set([...(explicit??[]),...sourceCountries])].sort();
  if(activeFineCountries.some(countryId=>typeof countryId!=='string'||!/^[A-Z]{3}$/.test(countryId)))throw Error('ACTIVE_FINE_COUNTRIES_UNVERIFIABLE');
  for(const countryId of activeFineCountries)if(!fineCountries.includes(countryId))throw Error(`ACTIVE_FINE_COUNTRY_WOULD_BE_DROPPED:${countryId}`);
  return {activeFineCountries,candidateFineCountries:fineCountries,current:{sha256:digest(currentBytes),byteLength:currentBytes.length}};
}
if(process.argv.includes('--check-input')){
  const activationGuard=process.argv.includes('--check-activation')?assertActiveFineCountriesPreserved():null;
  console.log(JSON.stringify({pass:true,inputPath,incremental:!!incremental,fineCountries,activationRequested:activate,publicationGuard:activationGuard??'not-evaluated-by-input-only-check'}));process.exit(0);
}
if(activate)assertActiveFineCountriesPreserved();
const key=digest(jsonBytes({features:bundle.features,records:bundle.records,edges:bundle.edges,parents:bundle.parents,regionNames:bundle.regionNames??null,hierarchyArtifacts:bundle.report.hierarchyArtifacts??[],nationalBoundaryInput:bundle.report.nationalBoundaryInput??null,nationalBoundaryReconciliation:bundle.report.nationalBoundaryReconciliation??null,westernSectorInput:bundle.report.westernSectorInput??null,westernSectorReconciliation:bundle.report.westernSectorReconciliation??null,nationalBoundaryVerification,...(incremental?{incremental,incrementalVerification}:{}),sourceLocks,codeInputs})).slice(0,20), version=`catalog-v3-prompt19-${incremental?'incremental-CHN':'korea'}-${key}`;
const schemaVersion='operational-world-delivery-v2';
const output=`data/derived/prompt19/mixed-world-v2-${key}`;
const json=value=>Buffer.from(`${JSON.stringify(value)}\n`);
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const inputRoot=digest(inputBytes), identities=[{path:inputPath,sha256:inputRoot,byteLength:inputBytes.length},...(bundle.report.hierarchyArtifacts??[]),...Object.values(bundle.report.nationalBoundaryInput??{}),...Object.values(bundle.report.westernSectorInput??{}),...(incremental?[...Object.values(incremental.baseline),incrementalVerification]:[])];
function publishPointer(pointer){
  if(activate)assertActiveFineCountriesPreserved();
  const pointerFile=option('--pointer-output')??`${output}.pointer.json`,pointerBytes=json(pointer);
  fs.mkdirSync(path.dirname(pointerFile),{recursive:true});
  if(fs.existsSync(pointerFile)){if(!fs.readFileSync(pointerFile).equals(pointerBytes))throw Error('IMMUTABLE_POINTER_CHANGED');}else fs.writeFileSync(pointerFile,pointerBytes,{flag:'wx'});
  if(activate){
    const currentFile='data/runtime/operational-catalog/current.json';
    if(incremental&&digest(fs.readFileSync(currentFile))!==incremental.baseline.pointer.sha256)throw Error('CURRENT_CATALOG_CHANGED_SINCE_BASELINE');
    const temporary=`${currentFile}.${process.pid}.tmp`;fs.mkdirSync(path.dirname(currentFile),{recursive:true});fs.writeFileSync(temporary,pointerBytes,{flag:'wx'});
    try{assertActiveFineCountriesPreserved();if(incremental&&digest(fs.readFileSync(currentFile))!==incremental.baseline.pointer.sha256)throw Error('CURRENT_CATALOG_CHANGED_SINCE_BASELINE');}catch(error){fs.unlinkSync(temporary);throw error;}
    fs.renameSync(temporary,currentFile);
  }
  return pointerFile;
}
if(fs.existsSync(output)) {
  const index=fs.readFileSync(`${output}/artifact-index.json`);
  for(const a of JSON.parse(index).artifacts){const bytes=fs.readFileSync(path.join(output,a.path));if(bytes.length!==a.byteLength||sha(bytes)!==a.sha256)throw Error(`IMMUTABLE_ARTIFACT_CHANGED:${a.path}`);}
  const pointer={catalogVersion:version,root:output,index:{sha256:sha(index),byteLength:index.length}};
  const pointerFile=publishPointer(pointer);console.log(JSON.stringify({...pointer,pointerFile,activated:activate}));process.exit(0);
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
const names=new Map([...Object.entries(JSON.parse(gunzipSync(fs.readFileSync(`${incremental?baselinePointer.root:'data/derived/prompt19/coarse-world-v1'}/region-names.json.gz`)))),...Object.entries(bundle.regionNames??{})]);
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
const edgeCountryPair=e=>[entries.get(e.leftTerritoryId).sourceCountryId,e.rightTerritoryId?entries.get(e.rightTerritoryId).sourceCountryId:'~coast'].sort().join('|');
// Source-country grouping keeps a local frontier's geometry in few shards.
// IDs and coordinates are unchanged; each same-cell-pair tie retains edge-ID order.
const runtimeEdges=incremental?[...topology.edges].sort((a,b)=>edgeCountryPair(a).localeCompare(edgeCountryPair(b))||a.id.localeCompare(b.id)):topology.edges;
const edges = runtimeEdges.map((e, i) => {
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
const countries = [],cellDetails=[],cellDetailSharding={maximumCellsPerShard:64,targetDecodedBytes:2*1024*1024,shardedCountries:[],oversizeSingleCellOrdinals:[],maximumDecodedShardBytes:0};
// Morton order groups nearby centroids for transport only. Every exact feature
// remains intact; neither the gameplay partition nor any coordinate is changed.
const spatialOrder=([longitude,latitude])=>{
  const x=Math.max(0,Math.min(65535,Math.floor((longitude+180)/360*65535))),y=Math.max(0,Math.min(65535,Math.floor((latitude+90)/180*65535)));
  let value=0;for(let bit=0;bit<16;bit++){value+=(x>>bit&1)*2**(bit*2);value+=(y>>bit&1)*2**(bit*2+1);}return value;
};
for (const countryId of countryOrder) {
  const countryRows = rows.filter(r => entries.get(r[1]).sourceCountryId === countryId);
  const ids = new Set(countryRows.map(r => r[0]));
  const metadata = write(`metadata/countries/${countryId}.json.gz`, {countryId, columns: ['cellOrdinal', 'cellId', 'administrativeOrdinal', 'previousParentOrdinal'], rows: countryRows});
  const countryFeatures=features.filter(f=>ids.has(f.id)),fullDetail={type:'FeatureCollection',features:countryFeatures};
  const detail = write(`detail/countries/${countryId}.geojson.gz`, fullDetail);
  countries.push({countryId, cellCount: countryRows.length, metadata, detail});
  if(json(fullDetail).length>cellDetailSharding.targetDecodedBytes){
    const ordered=countryFeatures.map(feature=>({feature,bytes:json(feature).length,key:spatialOrder(metrics[feature.id-1].centroid)})).sort((a,b)=>a.key-b.key||a.feature.id-b.feature.id);
    let pending=[],estimatedBytes=json({type:'FeatureCollection',features:[]}).length,shardNumber=0;
    const flush=()=>{
      if(!pending.length)return;
      const selected=pending.map(p=>p.feature).sort((a,b)=>a.id-b.id),value={type:'FeatureCollection',features:selected},decodedBytes=json(value).length;
      if(decodedBytes>cellDetailSharding.targetDecodedBytes){if(selected.length!==1)throw Error('CELL_DETAIL_SHARD_TOO_LARGE');cellDetailSharding.oversizeSingleCellOrdinals.push(selected[0].id);}
      const bbox=selected.reduce((box,feature)=>{const b=geometryMetadata(feature.geometry).bbox;return [Math.min(box[0],b[0]),Math.min(box[1],b[1]),Math.max(box[2],b[2]),Math.max(box[3],b[3])];},[180,90,-180,-90]);
      const artifact=write(`detail/cells/${countryId}/${String(shardNumber++).padStart(4,'0')}.geojson.gz`,value);
      cellDetails.push({countryId,cellOrdinals:selected.map(f=>f.id),bbox,artifact});cellDetailSharding.maximumDecodedShardBytes=Math.max(cellDetailSharding.maximumDecodedShardBytes,decodedBytes);
      pending=[];estimatedBytes=json({type:'FeatureCollection',features:[]}).length;
    };
    for(const item of ordered){if(pending.length&&(pending.length>=cellDetailSharding.maximumCellsPerShard||estimatedBytes+item.bytes>cellDetailSharding.targetDecodedBytes))flush();pending.push(item);estimatedBytes+=item.bytes;}
    flush();cellDetailSharding.shardedCountries.push({countryId,cells:countryFeatures.length,shards:shardNumber,fullDecodedBytes:json(fullDetail).length});
  }
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
const isKoreaOrdinal=n=>n>0&&fineCountries.includes(records[n-1].countryId);
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
const detailIndex = write('detail-index.json', {schemaVersion, ref, countries, edgeDetails,...(cellDetails.length?{cellDetails}:{}),parents: 'metadata/parents.json.gz', lodCoverage: 'lod-coverage.json.gz', lazy: true});
write('manifest.json', {schemaVersion, ref, counts, sourceId: 'world-operational-catalog', minZoom: 0, maxZoom: 6, promoteId: null,
  tileTemplate: 'tiles/{z}/{x}/{y}.pbf.gz', tileIndex, detailIndex, policy: {tileTransport: {compression: 'gzip', httpContentEncoding: null}, administrativeMinZoom: 4, operationalMinZoom: 8},
  edgeIncidence: {format: 'uint32-le-pairs', recordBytes: 8, recordCount: edges.length, decodedByteLength: incidence.length, artifact: edgeIncidence},
  runtimeRegeneration: false, attribution: `Natural Earth (public domain). ${sourceLocks.flatMap(lock=>lock.sources.map(s=>`${lock.countryId} ADM${s.adminLevel}: ${s.license.attribution} (${s.license.name}).`)).join(' ')} Source properties normalized, boundaries noded and limited to fixed project envelopes. ${bundle.report.nationalBoundaryReconciliation ? "Fine gameplay outlines include documented country/coast residual-strip reconciliation; unchanged raw sources remain independent evidence. Remaining residuals have no fine administrative attribution." : "Coarse residuals have no fine administrative attribution."}`});
write('catalog.json', descriptor);
write('provenance.json',{stage:incremental?'incremental-country-CHN':bundle.report.westernSectorReconciliation?'fine-western-sector-complete':bundle.report.nationalBoundaryReconciliation?.cleanupBoundarySlivers?'fine-boundary-sliver-cleanup':bundle.report.nationalBoundaryReconciliation?'fine-national-coast-reconciled':bundle.report.fineMacro?'fine-derived-macro':'19-02-C',inputRoot,inputs:identities,sourceLocks,sourceLockArtifacts,codeInputs,summary:bundle.report.summary,topology:bundle.report.topology,fineMacro:bundle.report.fineMacro??null,hierarchyArtifacts:bundle.report.hierarchyArtifacts??[],nationalBoundaryInput:bundle.report.nationalBoundaryInput??null,nationalBoundaryReconciliation:bundle.report.nationalBoundaryReconciliation??null,westernSectorInput:bundle.report.westernSectorInput??null,westernSectorReconciliation:bundle.report.westernSectorReconciliation??null,nationalBoundaryVerification,...(incremental?{incremental,incrementalVerification,fineCountries}:{}),cellDetailSharding,edgeOrdinalPolicy:incremental?'source-country-pair-then-original-edge-id':'retained-input-order',method:incremental?.method??bundle.report.nationalBoundaryReconciliation?.policy??bundle.report.fineMacro?.method??'Joint exact source/coarse/P0 arrangement. Zero source coordinates moved; no extrapolated lines; unmatched fixed P0 land explicitly retains coarse provenance. Other 245 countries unchanged.',worldCoverageComplete:true,fineAssignmentComplete:false,compatibility:'New games only; previous catalog sessions are rejected.'});
artifacts.sort((a, b) => a.path.localeCompare(b.path));
const indexBytes = json({schemaVersion, artifacts: [...artifacts], totalByteLength: artifacts.reduce((n, a) => n + a.byteLength, 0)});
fs.writeFileSync(path.join(output, 'artifact-index.json'), indexBytes, {flag: 'wx'});
const pointer = {catalogVersion: version, root: output, index: {sha256: sha(indexBytes), byteLength: indexBytes.length}};
const pointerFile=publishPointer(pointer);
console.log(JSON.stringify({output, ...pointer, pointerFile,activated:activate,counts, deliveredBytes: artifacts.reduce((n, a) => n + a.byteLength, 0)}));
