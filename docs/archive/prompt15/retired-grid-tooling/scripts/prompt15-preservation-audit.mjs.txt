// Task 15-22: explicit country batches. No default whole-world audit command.
import fs from 'node:fs';
import path from 'node:path';
import {gunzipSync} from 'node:zlib';
import {spawnSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {AUDIT_VERSION,AUDIT_LIMITS,auditCountryData,auditIdentitySet,geometryHash,intersection,physicalMetrics,shape,previousRepairLedgerRoot} from './prompt15-preservation-audit-core.mjs';
import {CELL_EXPERIMENT_POLICY as POLICY} from './prompt15-cell-policy.mjs';
import {normalizeGeometry,polygons,digest,jsonBytes,hashCanonical} from './prompt14-catalog-core.mjs';
import {identity,sameIdentity,safeRelative,WORLD_ROOT,INDICES_ROOT,INPUT_PINS} from './prompt15-world-delivery-core.mjs';

export const DELIVERY_ROOT='data/derived/prompt15/15-21-world-delivery-v1-56fc6c79c216e6bd1a11';
export const ADMIN_ROOT='data/derived/prompt15/15-18-administrative-input-v1-161260049c9100b09cb5';
export const ADMISSION_POINTER='reports/prompt15/15-21-final-join/20261027T122926152KST-receipt-intake/final-admission.json';
const ADMISSION_VERDICT='reports/prompt15/15-21-final-join/20261027T122926152KST-receipt-intake/admitted/verdict.json';
const ADMISSION_PIN={byteLength:11202,sha256:'27fdba30c3b8077d1ddb3c18f3c9067eff5b51b2730fc21e6bdad9599f4d027e'};
const DELIVERY_PIN={byteLength:787488,sha256:'6cb42a0bf5bcad829a024c503fab130192b778f69e00cfab878da48c37288e8a'};
const ADMIN_PIN={byteLength:1981,sha256:'bb977fd802809430ee07b240cb68aa61299701f30a762c987d1890767d226256'};
const SOURCE_FILES=['scripts/prompt15-preservation-audit.mjs','scripts/prompt15-preservation-audit-core.mjs','scripts/prompt15-preservation-audit.node-test.mjs','scripts/prompt15-preservation-join.mjs','scripts/prompt15-cell-policy.mjs','scripts/prompt15-sliver-core.mjs','scripts/prompt15-cell-physical.mjs','scripts/prompt14-exact-ring.mjs','scripts/prompt15-world-delivery-core.mjs','scripts/prompt15-world-indices-core.mjs','scripts/prompt15-cell-core.mjs','scripts/prompt14-catalog-core.mjs','package-lock.json','node_modules/jsts/package.json','node_modules/polygon-clipping/package.json'];
const slash=value=>String(value).replaceAll('\\','/');
const sameJSON=(a,b)=>digest(jsonBytes(a))===digest(jsonBytes(b));

export function selectCountries(order,batch){
  if(order.length!==247||new Set(order).size!==247||order.some(id=>!/^([A-Z0-9]{3})$/.test(id)))throw Error('Pinned 247-country directory is invalid');
  if(!Number.isInteger(batch)||batch<1||batch>5)throw Error('Batch must be 1..5; no implicit full-world audit');
  return order.slice((batch-1)*50,Math.min(batch*50,247));
}
function ensureOutput(output){
  const resolved=path.resolve(output),workspace=path.resolve('.'),relative=path.relative(workspace,resolved);
  if(!relative||relative.startsWith(`..${path.sep}`)||path.isAbsolute(relative)||!slash(relative).startsWith('reports/prompt15/'))throw Error('Audit outputs must be new directories under reports/prompt15/');
  for(let current=path.dirname(resolved);current!==workspace;current=path.dirname(current))if(fs.existsSync(current)&&fs.lstatSync(current).isSymbolicLink())throw Error('Audit output parent cannot be a symbolic link/junction');
  if(fs.existsSync(resolved))throw Error(`Preserve existing audit output: ${output}`);fs.mkdirSync(resolved,{recursive:true});return resolved;
}
const write=(root,name,value)=>fs.writeFileSync(path.join(root,name),jsonBytes(value),{flag:'wx'});

export function openAuditInputs({preparedEvidenceMap}={}){
  const used=new Map(),readFile=(file,pin)=>{
    const bytes=fs.readFileSync(file),actual={path:slash(file),sha256:digest(bytes),byteLength:bytes.length};if(pin&&!sameIdentity(actual,pin))throw Error(`Input identity changed: ${file}`);
    const previous=used.get(actual.path);if(previous&&!sameIdentity(actual,previous))throw Error(`Input mutated during audit: ${file}`);used.set(actual.path,actual);return bytes;
  };
  const pointer=JSON.parse(readFile(ADMISSION_POINTER)),admission=JSON.parse(readFile(ADMISSION_VERDICT,ADMISSION_PIN));
  if(pointer.authoritativeVerdict!==ADMISSION_VERDICT||pointer.task15_21!=='PASS'||pointer.task15_22Allowed!==true||admission.task15_21!=='PASS'||admission.upstreamVerification!=='VERIFIED'||admission.assetVerification!=='PASS'||admission.candidate!==DELIVERY_ROOT||admission.next?.task15_22Allowed!==true||admission.issues?.length||admission.unmetRequirements?.length)throw Error('15-21 authoritative final admission does not permit 15-22');
  const command=JSON.parse(readFile(pointer.nativeCommand));if(command.exitCode!==0)throw Error('15-21 admitted command did not finish successfully');
  const indexes=new Map();for(const {root,pin} of [{root:ADMIN_ROOT,pin:ADMIN_PIN},{root:WORLD_ROOT,pin:INPUT_PINS[0]},{root:INDICES_ROOT,pin:INPUT_PINS[1]},{root:DELIVERY_ROOT,pin:DELIVERY_PIN}]){
    const index=JSON.parse(readFile(`${root}/artifact-index.json`,pin)),map=new Map();for(const artifact of index.artifacts){if(!safeRelative(artifact.path)||map.has(artifact.path))throw Error(`Unsafe/duplicate index entry: ${root}`);map.set(artifact.path,artifact);}indexes.set(root,map);
  }
  const bytes=(root,name)=>{const expected=indexes.get(root)?.get(name);if(!expected)throw Error(`Unindexed audit input: ${root}/${name}`);return readFile(`${root}/${name}`,expected);};
  const read=(root,name)=>{const data=bytes(root,name);return JSON.parse(name.endsWith('.gz')?gunzipSync(data,{maxOutputLength:768*1024**2}).toString('utf8'):data.toString('utf8'));};
  for(const file of SOURCE_FILES)readFile(file);
  const policyPin=read(WORLD_ROOT,'provenance.json').inputs.find(input=>slash(input.path)==='scripts/prompt15-cell-policy.mjs');
  if(!policyPin)throw Error('Approved source catalog omitted its physical policy identity');readFile(policyPin.path,policyPin);
  const countryRoot=read(WORLD_ROOT,'catalog-root.json'),manifest=read(DELIVERY_ROOT,'manifest.json'),sourceIndex=read(INDICES_ROOT,'index-root.json');
  if(manifest.ref.sourceCatalogRoot!==WORLD_ROOT||manifest.ref.sourceIndicesRoot!==INDICES_ROOT||sourceIndex.sourceCatalogRoot!==WORLD_ROOT||!sameJSON(manifest.ref,admission.ref??read(DELIVERY_ROOT,'summary.json').ref)||manifest.ref.catalogOrderRoot!==sourceIndex.roots.catalogOrder||manifest.ref.topologyRoot!==sourceIndex.roots.topology)throw Error('15-22 input catalogs disagree');
  const verifyStable=()=>{const changed=[];for(const expected of used.values())try{if(!sameIdentity(identity(expected.path),expected))changed.push(expected.path);}catch{changed.push(expected.path);}return changed;};
  return {read,readFile,bytes,used,countryRoot,manifest,sourceIndex,admission,verifyStable,preparedEvidenceMap};
}

export function prepareAudit(output){
  const inputs=openAuditInputs(),root=ensureOutput(output),batches=Array.from({length:5},(_,i)=>({batch:i+1,countries:selectCountries(inputs.countryRoot.countryOrder,i+1)}));
  for(const item of batches)write(root,`batch-${String(item.batch).padStart(2,'0')}.json`,{task:'15-22',schemaVersion:AUDIT_VERSION,candidate:DELIVERY_ROOT,candidateArtifactIndex:DELIVERY_PIN,...item,scope:'country-preservation-geometry-topology',command:`node --expose-gc --max-old-space-size=4096 scripts/prompt15-preservation-audit.mjs --batch ${item.batch} --out reports/prompt15/15-22-country-batches/batch-${String(item.batch).padStart(2,'0')}/<unique-run-id>`});
  const changed=inputs.verifyStable();if(changed.length)throw Error(`Preparation inputs changed: ${changed.join(',')}`);
  const result={task:'15-22',status:'READY_FOR_COUNTRY_AUDIT',schemaVersion:AUDIT_VERSION,candidate:DELIVERY_ROOT,candidateArtifactIndex:DELIVERY_PIN,authoritativePredecessor:{path:ADMISSION_VERDICT,...ADMISSION_PIN,status:'PASS'},batches,limits:{...AUDIT_LIMITS,physicalPolicy:POLICY},inputManifest:[...inputs.used.values()],auditExecuted:false,wholeWorldExecuted:false,taskAcceptance:'NOT_EVALUATED',next:'Stop before country audits; user runs five country batches manually. No 15-23 or REVIEW C.'};write(root,'preparation.json',result);return result;
}

function buildContext(inputs,countries,onProgress,cacheRoot){
  const selected=new Set(countries),admin=inputs.read(INDICES_ROOT,'administrative-membership.json.gz'),previous=inputs.read(INDICES_ROOT,'previous-parent-index.json.gz');
  const strings=new Map(),intern=value=>{if(value===null)return null;if(!strings.has(value))strings.set(value,value);return strings.get(value);};
  const order=inputs.read(INDICES_ROOT,'catalog-order.json.gz').cells.map(cell=>({id:cell.id,sourceCountryId:intern(cell.sourceCountryId),parentKey:intern(cell.parentKey),adminId:intern(cell.adminId),oldTerritoryId:intern(cell.oldTerritoryId)}));global.gc?.();
  if(digest(jsonBytes(order.map(cell=>cell.id)))!==inputs.sourceIndex.roots.catalogOrder)throw Error('Catalog ordinal root changed');
  const ordinalById=new Map(order.map((cell,i)=>[cell.id,i+1])),ownOrdinals=new Set(),edgeFiles=new Map(countries.map(country=>[country,path.join(cacheRoot,`${country}.ndjson`)]));
  fs.mkdirSync(cacheRoot);for(const file of edgeFiles.values())fs.writeFileSync(file,'',{flag:'wx'});
  order.forEach((cell,i)=>{if(selected.has(cell.sourceCountryId))ownOrdinals.add(i+1);});
  const cellMeta=ordinal=>Number.isInteger(ordinal)&&ordinal>=1?order[ordinal-1]:undefined;
  const edgeCount=inputs.sourceIndex.counts.edges,incidence=gunzipSync(inputs.bytes(DELIVERY_ROOT,'metadata/edge-incidence.bin.gz'),{maxOutputLength:edgeCount*8});
  if(incidence.length!==edgeCount*8||inputs.manifest.edgeIncidence.recordCount!==edgeCount||inputs.manifest.edgeIncidence.recordBytes!==8||inputs.manifest.edgeIncidence.format!=='uint32-le-pairs')throw Error('Delivered incidence contract changed');
  for(const [i,shard] of inputs.sourceIndex.topologyShards.entries()){
    if(i%32===0)onProgress(`[topology input ${i+1}/${inputs.sourceIndex.topologyShards.length}]`);
    const source=inputs.read(INDICES_ROOT,shard),detail=inputs.read(DELIVERY_ROOT,`detail/${shard}`);
    const buffered=new Map(countries.map(country=>[country,[]]));
    if(detail.schemaVersion!==inputs.manifest.schemaVersion||detail.sourceSchemaVersion!==source.schemaVersion||detail.edges.length!==source.edges.length)throw Error(`Topology transport mismatch: ${shard}`);
    for(let index=0;index<source.edges.length;index++){
      const edge=source.edges[index],left=cellMeta(edge.left),right=edge.right?cellMeta(edge.right):null;
      if(!left||edge.right&&!right)throw Error('Unknown topology owner');
      const relevant=[...new Set([left.sourceCountryId,right?.sourceCountryId].filter(country=>selected.has(country)))];if(!relevant.length)continue;
      if(incidence.readUInt32LE((edge.ordinal-1)*8)!==edge.left||incidence.readUInt32LE((edge.ordinal-1)*8+4)!==edge.right)throw Error(`Binary edge incidence changed: ${edge.ordinal}`);
      const expected={...edge};delete expected.lengthKm;if(!sameJSON(expected,detail.edges[index]))throw Error(`Changed topology edge: ${edge.ordinal}`);
      const line=JSON.stringify(edge)+'\n';for(const country of relevant)buffered.get(country).push(line);
    }
    for(const [country,lines] of buffered)if(lines.length)fs.appendFileSync(edgeFiles.get(country),lines.join(''));
  }
  const edgePins=new Map([...edgeFiles].map(([country,file])=>[country,identity(file)]));
  const csr=inputs.read(INDICES_ROOT,'adjacency.json.gz'),adjacency=new Map();if(csr.cellCount!==order.length||csr.offsets.length!==order.length+1)throw Error('Invalid adjacency CSR');
  for(const ordinal of ownOrdinals)adjacency.set(ordinal,csr.neighbors.slice(csr.offsets[ordinal-1],csr.offsets[ordinal]));
  const provenance=inputs.read(ADMIN_ROOT,'provenance.json'),external=name=>{const pin=provenance.inputs.find(input=>slash(input.path)===name);if(!pin)throw Error(`Unpinned administrative source: ${name}`);return JSON.parse(inputs.readFile(name,pin));};
  const raw=external('data/raw/ne_10m_admin_1_states_provinces.geojson'),prepared=external('data/derived/prompt14/shared-admin1-input.geojson'),envelopes=external('data/derived/prompt14/shared-game-p0.geojson');
  const traces=inputs.read(ADMIN_ROOT,'source-identity-trace.json').filter(t=>selected.has(t.sourceCountryId)),sourceIds=new Set(traces.map(t=>t.source.identity));
  const preparedById=resolvePreparedSources(inputs,provenance,prepared.features,traces);
  const previousMetricApproval=inputs.read(INDICES_ROOT,'topology-validation.json'),indexProvenance=inputs.read(INDICES_ROOT,'provenance.json'),verificationPin=inputs.admission.upstreamReceipts?.v20;
  if(!verificationPin)throw Error('Missing admitted independent V20 receipt for previous-area correspondence');
  const independent=JSON.parse(inputs.readFile(verificationPin.path,verificationPin));
  if(independent.task!=='V20'||independent.status!=='pass'||independent.root!==INDICES_ROOT||independent.failureCount!==0||independent.errors?.length||!sameJSON(independent.membership?.unionEvidence,previousMetricApproval.membership.unionEvidence))throw Error('Independent V20 previous-area/repair evidence does not match pinned indices');
  // This consumes the admitted historical V20 receipt; it does not execute
  // today's verifier. Its historical code pin stays in that immutable receipt.
  previousMetricApproval.independent={status:independent.status,checks:independent.checks};
  for(const file of ['scripts/prompt15-world-indices-core.mjs','scripts/prompt15-cell-core.mjs']){const pin=indexProvenance.inputs.find(p=>slash(p.path)===file);if(!pin)throw Error(`Missing pinned V20 boundary implementation: ${file}`);inputs.readFile(file,pin);}
  return {admin,previous,order,ordinalById,cellMeta,edgeFiles,edgePins,adjacency,previousMetricApproval,rawById:new Map(raw.features.filter(f=>sourceIds.has(String(f.properties.ne_id))).map(f=>[String(f.properties.ne_id),f])),preparedById,envelopeById:new Map(envelopes.features.filter(f=>selected.has(f.properties.countryId)).map(f=>[f.properties.countryId,f.geometry])),traces,restored:inputs.read(ADMIN_ROOT,'administrative-restoration.geojson').features.filter(f=>selected.has(f.properties.sourceCountryId)),residuals:inputs.read(ADMIN_ROOT,'residuals.geojson').features.filter(f=>selected.has(f.properties.countryId)),protected:inputs.read(ADMIN_ROOT,'protected-overlay.geojson').features.filter(f=>selected.has(f.properties.sourceCountryId)),protectedTraces:inputs.read(ADMIN_ROOT,'protected-overlay-trace.json').filter(t=>selected.has(t.sourceCountryId)),deliveryParents:inputs.read(DELIVERY_ROOT,'metadata/parents.json.gz')};
}
export function resolvePreparedSources(inputs,provenance,sharedFeatures,traces){
  const preparedById=new Map(sharedFeatures.map(f=>[String(f.properties.ne_id),f]));
  if(traces.every(trace=>{const feature=preparedById.get(trace.source.identity);return feature&&digest(jsonBytes(feature.geometry))===trace.source.preparedGeometrySha256;}))return preparedById;
  const approval=provenance.restoration15_09;
  const blocked=message=>{const error=Error(`BLOCKED prepared-source evidence: ${message}`);error.code='missing-or-invalid-prepared-source-evidence';throw error;};
  if(!approval||approval.status!=='pass'||!approval.checks||!Object.keys(approval.checks).length||!Object.values(approval.checks).every(value=>value===true))blocked(`${ADMIN_ROOT}/provenance.json restoration15_09 approval/checks`);
  let relocated;
  try{relocated=inputs.preparedEvidenceMap?readPreparedEvidenceMap(inputs,provenance):null;}catch(error){blocked(`${inputs.preparedEvidenceMap}: ${error.message}`);}
  const candidates=[];
  for(const name of ['first','second']){
    const pin=approval.evidence?.[name],file=pin&&slash(pin.path),input=provenance.inputs.find(p=>slash(p.path)===file);
    if(!pin||!safeRelative(file)||file.startsWith(`${ADMIN_ROOT}/`)||file.startsWith(`${DELIVERY_ROOT}/`)||!input||!sameIdentity(input,pin))blocked(`${file??`${ADMIN_ROOT}/provenance.json restoration15_09.evidence.${name}`} missing independent input pin`);
    const actual=relocated?.get(name)??pin;
    try{candidates.push(JSON.parse(inputs.readFile(actual.path,actual)));}catch(error){blocked(`${file} via ${actual.path}: ${error.message}`);}
  }
  const [candidate,second]=candidates;
  if(!sameJSON(candidate,second)||candidate.status!=='pass'||candidate.geometrySha256!==approval.geometrySha256||digest(jsonBytes(candidate.selected))!==approval.geometrySha256||candidate.topologySha256!==approval.topologySha256||candidate.sourceIdentityCount!==approval.sourceIdentityCount||!candidate.checks||!Object.keys(candidate.checks).length||!Object.values(candidate.checks).every(value=>value===true)||!Object.keys(approval.checks).every(key=>candidate.checks[key]===true)||candidate.evidence?.policy?.version!==approval.policyVersion||candidate.evidence?.policy?.taskId!=='15-08'||candidate.evidence?.unresolved?.length!==0||candidate.selected?.features?.length!==approval.sourceIdentityCount)blocked(`${approval.evidence.first.path}: restoration identity/status/checks/policy`);
  const features=candidate.selected.features,ids=features.map(f=>String(f.properties.sourceFeatureId)),selectedTraces=traces.filter(t=>t.sourceCountryId===candidate.countryId);
  if(new Set(ids).size!==ids.length||features.some(f=>f.properties.sourceCountryId!==candidate.countryId))blocked(`${approval.evidence.first.path}: duplicate or wrong-country identities`);
  if(selectedTraces.length){
    const identitySet=auditIdentitySet(ids,selectedTraces.map(t=>t.source.identity));if(!identitySet.pass)blocked(`${approval.evidence.first.path}: source identity set ${JSON.stringify(identitySet)}`);
    for(const feature of features)preparedById.set(String(feature.properties.sourceFeatureId),feature);
  }
  for(const trace of traces){const feature=preparedById.get(trace.source.identity);if(!feature||digest(jsonBytes(feature.geometry))!==trace.source.preparedGeometrySha256)throw Error(`Raw/prepared/restored lineage changed: ${trace.source.identity} (approved prepared source hash)`);}
  return preparedById;
}

// A receipt relocates exact approved bytes; it never changes the logical pin.
// New replays must retain two independently completed native process receipts.
export function readPreparedEvidenceMap(inputs,provenance){
  const read=(file,pin)=>JSON.parse(inputs.readFile(file,pin)),fail=message=>{throw Error(`Invalid prepared evidence map: ${message}`);};
  const mapFile=inputs.preparedEvidenceMap;if(!safeRelative(mapFile)||!mapFile.startsWith('reports/prompt15/'))fail('unsafe map path');
  const receipt=read(mapFile),approval=provenance.restoration15_09;
  if(receipt.schemaVersion!=='prompt15-prepared-source-evidence-map-v1'||receipt.countryId!=='SVN'||receipt.provenance?.path!==`${ADMIN_ROOT}/provenance.json`||!sameJSON(read(receipt.provenance.path,receipt.provenance),provenance)||receipt.entries?.length!==2)fail('schema/provenance/complete pair');
  const mapped=new Map(),paths=new Set(),pids=new Set(),executions=new Set(),commands=new Set();
  const independentPath=file=>safeRelative(file)&&file.startsWith('reports/prompt15/')&&!file.startsWith(`${ADMIN_ROOT}/`)&&!file.startsWith(`${DELIVERY_ROOT}/`);
  for(const entry of receipt.entries){
    const expected=approval.evidence[entry.name],actual=entry.actual,origin=entry.origin;
    if(!['first','second'].includes(entry.name)||mapped.has(entry.name)||!expected||!entry.approvedPin||!actual||entry.logicalPath!==expected.path||!sameIdentity(entry.approvedPin,expected)||!sameIdentity(actual,expected)||!independentPath(actual.path)||paths.has(path.resolve(actual.path)))fail('logical pin, output identity or independent path');
    if(origin?.kind!=='new-independent-replay'||![origin.execution?.path,origin.command?.path,origin.wrapper?.path].every(independentPath)||executions.has(origin.execution.path)||commands.has(origin.command.path))fail('missing independent execution evidence');
    const execution=read(origin.execution.path,origin.execution),command=read(origin.command.path,origin.command);
    inputs.readFile(origin.wrapper.path,origin.wrapper);
    if(command.exitCode!==0||command.signal!==null||command.error||!command.started||!command.finished||!Array.isArray(command.args)||!sameJSON(command.args.slice(-2),[origin.wrapper.path,entry.name])||execution.label!==entry.name||!Number.isSafeInteger(execution.pid)||execution.pid<=0||pids.has(execution.pid)||execution.error||execution.inputsUnchanged!==true||execution.expectedExitCode!==0||!execution.started||!execution.finished||execution.output?.path!==actual.path||!sameIdentity(execution.output,actual)||!Array.isArray(execution.inputsBefore)||!execution.inputsBefore.length||!sameJSON(execution.inputsBefore,execution.inputsAfter))fail('unsuccessful/incomplete/non-independent native replay');
    if(execution.versions?.node!==provenance.dependencies.node||execution.versions.packages?.find(p=>p.name==='jsts')?.version!==provenance.dependencies.jsts||execution.versions.packages?.find(p=>p.name==='polygon-clipping')?.version!==provenance.dependencies.polygonClipping)fail('replay tool versions');
    const replayInputs=new Map();for(const input of execution.inputsBefore){if(!safeRelative(input.path)||replayInputs.has(input.path))fail('invalid replay input identity');replayInputs.set(input.path,input);inputs.readFile(input.path,input);}
    for(const file of ['scripts/prompt15-recovery-candidate.mjs','package-lock.json','data/derived/prompt14/shared-game-p0.geojson','data/derived/prompt14/shared-admin1-input.geojson','data/raw/ne_10m_admin_1_states_provinces.geojson','src/data/countries-2020.json','data/source-locks/prompt14-derived-game-input-lock.json']){
      const approved=provenance.inputs.find(input=>slash(input.path)===file);if(!approved||!replayInputs.has(file)||!sameIdentity(replayInputs.get(file),approved))fail(`missing approved replay input: ${file}`);
    }
    mapped.set(entry.name,actual);paths.add(path.resolve(actual.path));pids.add(execution.pid);executions.add(origin.execution.path);commands.add(origin.command.path);
  }
  if(mapped.size!==2)fail('incomplete independent pair');return mapped;
}
export function assembleCountryAuditInput(inputs,context,countryId){
  const envelope=context.envelopeById.get(countryId),restored=context.restored.filter(f=>f.properties.sourceCountryId===countryId),traces=context.traces.filter(t=>t.sourceCountryId===countryId),parents=[],tinySourceComponents=new Set();
  const lineage=auditIdentitySet(traces.map(t=>t.source.identity),restored.map(f=>String(f.properties.sourceFeatureId)));if(!lineage.pass)throw Error(`Restoration identity mismatch: ${JSON.stringify(lineage)}`);
  for(const trace of traces){
    const source=context.rawById.get(trace.source.identity),prepared=context.preparedById.get(trace.source.identity),result=restored.find(f=>String(f.properties.sourceFeatureId)===trace.source.identity);
    if(!source||!prepared||!result||digest(jsonBytes(source.geometry))!==trace.source.geometrySha256||digest(jsonBytes(prepared.geometry))!==trace.source.preparedGeometrySha256||digest(jsonBytes(result.geometry))!==trace.result.geometrySha256||!sameJSON(shape(source.geometry),trace.source.shape)||!sameJSON(shape(result.geometry),trace.result.shape)||trace.components.length!==shape(result.geometry).components)throw Error(`Raw/prepared/restored lineage changed: ${trace.source.identity}`);
    for(const component of trace.components){const coordinates=polygons(result.geometry)[component.resultComponentIndex];if(!coordinates||geometryHash({type:'Polygon',coordinates})!==component.resultGeometrySha256||coordinates.length-1!==component.resultHoles||component.sourceHoles>component.resultHoles)throw Error(`Component/hole lineage changed: ${trace.source.identity}`);}
    const geometry=normalizeGeometry(intersection(result.geometry,envelope)),parentKey=`${countryId}:${trace.source.identity}`;parents.push({parentKey,adminId:trace.source.identity,geometry});
  }
  for(const f of context.residuals.filter(f=>f.properties.countryId===countryId))parents.push({parentKey:`${countryId}:country-envelope:${f.properties.residualId}`,adminId:null,geometry:normalizeGeometry(f.geometry)});
  for(const parent of parents){const descriptor=context.admin.parents.find(p=>p.parentKey===parent.parentKey);if(!descriptor||descriptor.parentGeometryHash!==geometryHash(parent.geometry))throw Error(`Parent source correspondence changed: ${parent.parentKey}`);
    for(const [index,coordinates] of polygons(parent.geometry).entries()){const m=physicalMetrics({type:'Polygon',coordinates});if(m.areaKm2<=POLICY.tinySourceComponent.maximumAreaKm2&&m.diameterKm<=POLICY.tinySourceComponent.maximumDiameterKm)tinySourceComponents.add(`${parent.parentKey}:${index}`);}
  }
  const previousParents=context.protected.filter(f=>f.properties.sourceCountryId===countryId).map(f=>{
    const oldTerritoryId=f.properties.territoryId,trace=context.protectedTraces.find(t=>t.previousTerritoryId===oldTerritoryId);if(!trace||trace.geometrySha256!==digest(jsonBytes(f.geometry))||!sameJSON(trace.shape,shape(f.geometry)))throw Error(`Protected geometry trace changed: ${oldTerritoryId}`);return {oldTerritoryId,geometry:f.geometry};
  });
  const adminDescriptors=context.admin.parents.filter(p=>p.sourceCountryId===countryId),oldDescriptors=context.previous.parents.filter(p=>p.sourceCountryId===countryId);
  if(!sameJSON(context.deliveryParents.administrative.filter(p=>p.sourceCountryId===countryId),adminDescriptors)||!sameJSON(context.deliveryParents.previous.filter(p=>p.sourceCountryId===countryId),oldDescriptors))throw Error('Delivered parent metadata changed');
  const membership=(descriptors,csr)=>descriptors.map(p=>({...p,cellOrdinals:csr.cellOrdinals.slice(p.start,p.start+p.count)}));
  const catalog=inputs.read(WORLD_ROOT,`countries/${countryId}/catalog.json.gz`),original=inputs.read(WORLD_ROOT,`countries/${countryId}/geometry.geojson.gz`),byId=new Map(original.features.map(f=>[f.properties.cellId,f])),detail=inputs.read(DELIVERY_ROOT,`detail/countries/${countryId}.geojson.gz`),metadata=inputs.read(DELIVERY_ROOT,`metadata/countries/${countryId}.json.gz`);
  const adminOrdinal=new Map(context.admin.parents.map((p,i)=>[p.parentKey,i+1])),oldOrdinal=new Map(context.previous.parents.map((p,i)=>[p.oldTerritoryId,i+1])),entries=new Map(catalog.entries.map(entry=>[entry.id,entry]));
  if(detail.features.length!==metadata.rows.length||detail.features.length!==catalog.entries.length||original.features.length!==catalog.entries.length||metadata.countryId!==countryId||!sameJSON(metadata.columns,['cellOrdinal','cellId','administrativeOrdinal','previousParentOrdinal']))throw Error('Cell geometry/metadata census mismatch');
  const cells=detail.features.map((feature,i)=>{
    const meta=context.cellMeta(feature.id),entry=entries.get(meta?.id),row=metadata.rows[i];if(!entry||meta.sourceCountryId!==countryId||!sameJSON(row,[feature.id,entry.id,adminOrdinal.get(entry.parentKey),oldOrdinal.get(entry.oldTerritoryId)]))throw Error('Delivered cell ordinal/parent metadata mismatch');
    return {...entry,ordinal:feature.id,geometry:feature.geometry};
  });
  const expectedCells=catalog.entries.map(entry=>{const source=byId.get(entry.id);if(!source)throw Error('Missing source geometry');return {...entry,ordinal:context.ordinalById.get(entry.id),geometryHash:geometryHash(source.geometry)};});
  const previousMetricEvidence=context.previousMetricApproval?assemblePreviousMetricEvidence(inputs,context,countryId,catalog.entries,oldDescriptors):undefined;
  const incidentEdges=inputs.readFile(context.edgeFiles.get(countryId),context.edgePins.get(countryId)).toString('utf8').trimEnd().split('\n').filter(Boolean).map(line=>JSON.parse(line));
  return {countryId,envelope,parents,previousParents,cells,expectedCells,sourceIdentities:traces.map(t=>t.source.identity),administrativeMembership:membership(adminDescriptors,context.admin),previousMembership:membership(oldDescriptors,context.previous),incidentEdges,cellMeta:context.cellMeta,adjacency:context.adjacency,tinySourceComponents,previousMetricEvidence};
}

export function assemblePreviousMetricEvidence(inputs,context,countryId,entries,descriptors){
  const generation=inputs.read(WORLD_ROOT,`countries/${countryId}/generation.json.gz`),approval=context.previousMetricApproval,repairs=approval.numericalBoundaryRepairs;
  if(repairs.count!==repairs.items.length||hashCanonical('prompt15-task-15-20-numerical-boundary-repairs.v1',repairs.items)!==repairs.root)throw Error('Pinned V20 numerical boundary repair root mismatch');
  const ledger=[...(generation.numericalProtectedFragmentRepairs??[]).map(r=>({countryId,ledger:'protected',...r})),...(generation.numericalCellRepairs??[]).map(r=>({countryId,ledger:'cell',...r})),...(generation.topologySourceRepairs??[]).map(r=>({countryId,ledger:'topology-source',...r}))];
  const byId=new Map(entries.map(e=>[e.id,e])),protectedById=new Map(context.protected.map(f=>[f.properties.territoryId,f]));
  const cellAt=ordinal=>{const meta=context.cellMeta(ordinal),entry=byId.get(meta?.id);if(!entry||entry.sourceCountryId!==countryId||entry.oldTerritoryId!==meta.oldTerritoryId)throw Error(`Repair owner source correspondence changed: ${ordinal}`);return {ordinal,id:entry.id,sourceCountryId:entry.sourceCountryId,oldTerritoryId:entry.oldTerritoryId,parentKey:entry.parentKey,sourceComponentHash:entry.sourceComponentHash};};
  const result=new Map();
  for(const descriptor of descriptors){
    const id=descriptor.oldTerritoryId,relevant=ledger.filter(r=>[r.oldTerritoryId,r.sourceOldTerritoryId,r.assignedOldTerritoryId].includes(id));
    const boundaryRepairs=repairs.items.filter(w=>w.kind==='protected-fragment-transfer-boundary'&&w.otherOwner&&w.assignedPass&&[w.sourceOldTerritoryId,w.assignedOldTerritoryId].includes(id)).map(w=>({ ...w,ownerCell:cellAt(w.owner),oppositeCell:cellAt(w.otherOwner),protectedSources:[protectedById.get(w.sourceOldTerritoryId),protectedById.get(w.assignedOldTerritoryId)]}));
    result.set(id,{countryId,oldTerritoryId:id,descriptor,ledger:relevant,ledgerRoot:previousRepairLedgerRoot(relevant),approval:{status:approval.status,checks:approval.checks,policy:approval.policy,independent:approval.independent},generation:{status:generation.status,checks:generation.checks,maximumNodedSegmentDisplacement:generation.numericalNoding?.maximumNodedSegmentDisplacement},boundaryRepairs});
  }
  return result;
}

export function runAudit({batch,country,output,preparedEvidenceMap,onProgress=console.log}){
  if(preparedEvidenceMap&&(country!=='SVN'||batch!==undefined))throw Error('Prepared evidence relocation is restricted to --country SVN');
  const started=performance.now(),inputs=openAuditInputs({preparedEvidenceMap}),countries=country?[country]:selectCountries(inputs.countryRoot.countryOrder,batch);
  if(country&&!inputs.countryRoot.countryOrder.includes(country))throw Error('Unknown country');const root=ensureOutput(output);
  const test=spawnSync(process.execPath,['--test','scripts/prompt15-preservation-audit.node-test.mjs'],{encoding:'utf8',maxBuffer:256*1024});write(root,'fixture-execution.json',{command:[process.execPath,'--test','scripts/prompt15-preservation-audit.node-test.mjs'],exitCode:test.status,error:test.error?.message??null,stdout:test.stdout??'',stderr:test.stderr??''});
  if(test.status!==0)throw Error('15-22 negative fixtures did not pass');
  let context,fatalError=null;try{context=buildContext(inputs,countries,onProgress,path.join(root,'topology-inputs'));}catch(error){fatalError={code:error.code??'shared-input-context-failed',name:error.name,message:error.message,stack:error.stack,blocked:error.code==='missing-or-invalid-prepared-source-evidence'};}
  const results=[];
  for(const countryId of countries){
    onProgress(`[country ${results.length+1}/${countries.length}] ${countryId}`);let result;try{if(fatalError)throw Error(fatalError.message);result=auditCountryData(assembleCountryAuditInput(inputs,context,countryId));}catch(error){result={task:'15-22',schemaVersion:AUDIT_VERSION,countryId,status:fatalError?.blocked?'BLOCKED':'FAIL',errors:[{code:fatalError?.code??'country-input-or-audit-exception',name:error.name,message:error.message,stack:fatalError?.stack??error.stack}]};}
    write(root,`${countryId}.json`,result);results.push({countryId,status:result.status,report:{...identity(path.join(root,`${countryId}.json`)),path:`${countryId}.json`},counts:result.counts??null});global.gc?.();
  }
  const changed=inputs.verifyStable(),status=results.every(r=>r.status==='PASS')&&!changed.length?'PASS':'FAIL',report={task:'15-22',schemaVersion:AUDIT_VERSION,scope:country?'single-country-smoke':'assigned-country-preservation-audit',status,candidate:DELIVERY_ROOT,candidateArtifactIndex:DELIVERY_PIN,admission:{path:ADMISSION_VERDICT,...ADMISSION_PIN},batch:batch??null,countries,results,fatalError,inputChanges:changed,inputs:[...inputs.used.values()],limits:{...AUDIT_LIMITS,policyVersion:POLICY.version,budgets:POLICY.budgets},fixtureExecution:{...identity(path.join(root,'fixture-execution.json')),path:'fixture-execution.json'},elapsedMs:performance.now()-started,peakRssBytes:process.resourceUsage().maxRSS*1024,worldAuditComplete:false,taskAcceptance:'NOT_EVALUATED',next:'Manual batch result review and explicit five-batch join. No 15-23/REVIEW C or production publication.'};write(root,'verdict.json',report);return report;
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  const args=process.argv.slice(2),outIndex=args.indexOf('--out'),output=outIndex>=0?args[outIndex+1]:null;
  try{
    if(!output)throw Error('Required --out <new reports/prompt15/... directory>');
    let result;
    if(args[0]==='--prepare'&&args.length===3)result=prepareAudit(output);
    else if(args[0]==='--batch'&&args.length===4&&outIndex===2)result=runAudit({batch:Number(args[1]),output});
    else if(args[0]==='--country'&&args.length===4&&outIndex===2)result=runAudit({country:args[1],output});
    else if(args[0]==='--country'&&args[1]==='SVN'&&args[2]==='--prepared-evidence-map'&&args.length===6&&outIndex===4)result=runAudit({country:args[1],preparedEvidenceMap:args[3],output});
    else throw Error('Use --prepare, --batch 1..5, or --country ID, followed by --out <new directory>. SVN alone may add --prepared-evidence-map <receipt> before --out. No default world audit.');
    console.log(JSON.stringify({task:'15-22',status:result.status,output,countries:result.countries??result.batches?.map(b=>b.countries.length),countryResults:result.results?.map(r=>({countryId:r.countryId,status:r.status})),worldAuditExecuted:result.worldAuditComplete??false}));if(result.status==='FAIL')process.exitCode=1;
  }catch(error){console.error(JSON.stringify({task:'15-22',status:'FAIL',message:error.message}));process.exitCode=1;}
}
