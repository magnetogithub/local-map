// Supported CHN adapter + active-catalog coordinator. Never rebuilds non-target countries.
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {digest, jsonBytes, hashCanonical} from '../prompt14-catalog-core.mjs';

const arg=(name,fallback)=>{const i=process.argv.indexOf(name);if(i<0)return fallback;const v=process.argv[i+1];if(!v||v.startsWith('--'))throw Error(`MISSING_ARGUMENT:${name}`);return v;};
const read=file=>JSON.parse(fs.readFileSync(file));
const pin=file=>{const bytes=fs.readFileSync(file);return {path:file,sha256:digest(bytes),byteLength:bytes.length};};
const verify=a=>{const now=pin(a.path);if(now.sha256!==a.sha256||now.byteLength!==a.byteLength)throw Error(`PIN_CHANGED:${a.path}`);};
const checked=a=>{verify(a);return read(a.path);};
const immutable=(file,value)=>{const bytes=jsonBytes(value);fs.mkdirSync(path.dirname(file),{recursive:true});if(fs.existsSync(file)){if(!fs.readFileSync(file).equals(bytes))throw Error(`IMMUTABLE_CHANGED:${file}`);}else fs.writeFileSync(file,bytes,{flag:'wx'});return pin(file);};

const pointerPath='reports/chn-2020/baseline-runtime-pointer.json';
if(!fs.existsSync(pointerPath)){
  fs.mkdirSync(path.dirname(pointerPath),{recursive:true});
  fs.copyFileSync('data/runtime/operational-catalog/current.json',pointerPath,fs.constants.COPYFILE_EXCL);
}
const pointer=read(pointerPath),provenance=read(`${pointer.root}/provenance.json`);
const index=checked({path:`${pointer.root}/artifact-index.json`,...pointer.index});
for(const a of index.artifacts)verify({...a,path:`${pointer.root}/${a.path}`});
const baselinePin=provenance.inputs.find(a=>a.sha256===provenance.inputRoot);
if(!baselinePin)throw Error('ACTIVE_BASELINE_INPUT_NOT_FOUND');
const baseline=checked(baselinePin),geometryPath=arg('--geometry','data/derived/chn-2020/geometry-v1/geometry.json');
if(!fs.existsSync(geometryPath)){
  const env={...process.env,PYTHONPATH:path.resolve('.tmp/chn-python'),PYTHONUTF8:'1'};
  const result=spawnSync('python',['scripts/chn-2020/prepare-china.py','--output',path.dirname(geometryPath)],{stdio:'inherit',env});
  if(result.status!==0)throw Error('CHN_ADAPTER_FAILED');
}
const replayGeometry=arg('--geometry-replay',geometryPath);
if(pin(replayGeometry).sha256!==pin(geometryPath).sha256||pin(replayGeometry).byteLength!==pin(geometryPath).byteLength)throw Error('CHN_RAW_REPLAY_DIFFERS');
const result=read(replayGeometry),lock=checked(result.sourceLock),hierarchyPath='data/source-locks/chn-2020/CHN-hierarchy.json',hierarchy=read(hierarchyPath);
if(!result.baseline||result.baseline.sha256!==baselinePin.sha256||result.baseline.byteLength!==baselinePin.byteLength)throw Error('CHN_GEOMETRY_BASELINE_MISMATCH');
verify(result.baseline);verify(result.sourceDecision);
const normalized=checked(lock.normalizedInput),sourceIds=new Set(normalized.features.map(f=>f.properties.sourceFeatureId));
if(lock.countryId!=='CHN'||result.schemaVersion!=='chn-incremental-geometry-v1'||sourceIds.size!==2864)throw Error('UNSUPPORTED_CHN_SOURCE');
for(const s of lock.sources)checked(s.artifact);
for(const c of lock.preprocessing.code)verify(c);
const groups=new Map(hierarchy.macroGroups.map(g=>[g.macroId,g])),assignments=new Map(hierarchy.assignments.map(a=>[a.sourceFeatureId,a]));
const unresolved=new Set(hierarchy.unresolved.map(a=>a.sourceFeatureId));
if([...sourceIds].some(id=>assignments.has(id)===unresolved.has(id)))throw Error('INCOMPLETE_OR_DUPLICATE_HIERARCHY');
const recordsBefore=new Map(baseline.records.map(r=>[r.id,r]));
const previousBefore=new Map(baseline.parents.previous.map(p=>[p.oldTerritoryId,p]));
const chineseBefore=new Set(baseline.records.filter(r=>r.countryId==='CHN').map(r=>r.id));
const nodedNeighbors=new Map(result.neighborFeatures.map(f=>[f.id,f]));
if([...nodedNeighbors.keys()].some(id=>!recordsBefore.has(id)||chineseBefore.has(id)))throw Error('INVALID_NEIGHBOR_SCOPE');
const features=baseline.features.filter(f=>!chineseBefore.has(f.id)).map(f=>nodedNeighbors.get(f.id)??f);
const records=baseline.records.filter(r=>r.countryId!=='CHN');
const administrative=baseline.parents.administrative.filter(p=>p.sourceCountryId!=='CHN');
const previous=baseline.parents.previous.filter(p=>p.sourceCountryId!=='CHN');
const usedMacros=new Set(),seedGroups=new Map(),regionNames={...baseline.regionNames};
const fallbackKey='fine-macro-residual:CHN';
const residualLedger=[];
for(const f of result.cells){
  const p=f.properties,assignment=p.fineSourceIdentity?assignments.get(p.sourceFeatureId):null;
  if(p.fineSourceIdentity&&!sourceIds.has(p.sourceFeatureId))throw Error('UNKNOWN_CHN_SOURCE_ID');
  const macroId=assignment?.macroId??null;
  const parentKey=macroId?`fine-macro:CHN:${macroId}`:fallbackKey;
  if(macroId)usedMacros.add(macroId);
  const baselineCellIds=p.baselineCellIds;
  if(!Array.isArray(baselineCellIds)||!baselineCellIds.length||baselineCellIds.some(id=>!chineseBefore.has(id)))throw Error('INVALID_CHN_BASELINE_LINEAGE');
  const seedParentIds=[...new Set(baselineCellIds.flatMap(id=>{
    const r=recordsBefore.get(id),previous=previousBefore.get(r.previousParentId);
    if(!previous||previous.sourceCountryId!=='CHN')throw Error('INVALID_CHN_TRANSITIVE_SEED');
    return previous.seedParentIds??r.seedParentIds??[r.previousParentId];
  }))].sort();
  // The runtime representative must itself be a real canonical seed. Every
  // grouped predecessor is retained and must agree on owner AND controller.
  const previousParentId=seedParentIds[0];
  seedGroups.set(previousParentId,[...new Set([...(seedGroups.get(previousParentId)??[]),...seedParentIds])].sort());
  const properties={...p,sourceParentId:macroId,administrativeParentKey:parentKey,seedParentIds,
    hierarchyBasis:macroId?assignment.method:'explicit-unconfirmed-source-parent; country-envelope-residual contract'};
  features.push({...f,properties});
  records.push({id:f.id,countryId:'CHN',administrativeParentKey:parentKey,previousParentId,seedParentIds});
  if(!p.fineSourceIdentity)residualLedger.push({cellId:f.id,reason:'Baseline source-free detached island or bounded contact remainder; no invented administrative family',
    disposition:'preserved-baseline-land-with-country-envelope-residual-parent',geometryHash:hashCanonical('chn-residual.v1',f.geometry)});
}
for(const macroId of [...usedMacros].sort()){
  const g=groups.get(macroId),parentKey=`fine-macro:CHN:${macroId}`;
  if(!g)throw Error('UNKNOWN_CHN_MACRO');
  administrative.push({parentKey,sourceCountryId:'CHN',kind:'administrative',adminId:parentKey,name:g.name,
    sourceFeatureId:`CHN:${g.sourceFeatureId}`,sourceVersion:g.sourceVersion,restorationId:null,residualId:null,start:0,count:0,
    boundaryBasis:'union-of-whole-fine-families-with-source-containment-evidence',macroId});
  regionNames[`CHN:${g.sourceFeatureId}`]={name:g.name,name_en:g.name,name_ko:g.nameKo};
}
if(records.some(r=>r.countryId==='CHN'&&r.administrativeParentKey===fallbackKey))administrative.push({parentKey:fallbackKey,sourceCountryId:'CHN',kind:'country-envelope-residual',adminId:null,
  name:'CHN administrative parent unconfirmed / source-free baseline land',sourceFeatureId:null,sourceVersion:null,restorationId:null,
  residualId:hashCanonical('chn-parent-unconfirmed.v1','CHN'),start:0,count:0});
for(const [oldTerritoryId,seedParentIds]of [...seedGroups].sort(([a],[b])=>a.localeCompare(b)))previous.push({oldTerritoryId,sourceCountryId:'CHN',seedParentIds,start:0,count:0});
const nextRecords=new Map(records.map(r=>[r.id,r]));
const edges=baseline.edges.filter(e=>!chineseBefore.has(e.leftTerritoryId)&&!chineseBefore.has(e.rightTerritoryId));
for(const e of result.edges){
  const l=nextRecords.get(e.leftTerritoryId),r=e.rightTerritoryId?nextRecords.get(e.rightTerritoryId):null;
  if(!l||(e.rightTerritoryId&&!r)||l.countryId!=='CHN'&&r?.countryId!=='CHN')throw Error('INVALID_INCREMENTAL_EDGE');
  const boundaryClass=!r?'coast':l.countryId!==r.countryId?'country':l.administrativeParentKey===fallbackKey||r.administrativeParentKey===fallbackKey?'residual':l.administrativeParentKey===r.administrativeParentKey?'operational':'administrative';
  edges.push({...e,boundaryClass});
}
const codeArtifacts=['scripts/chn-2020/prepare-china.py','scripts/chn-2020/incremental-coordinator.mjs','scripts/chn-2020/requirements.txt'].map(pin);
const incremental={countryId:'CHN',scenarioDate:'2020-01-01',fineCountries:['CHN','KOR','PRK'],
  baseline:{pointer:pin(pointerPath),bundle:baselinePin,cells:pin('reports/maintenance/prompt19-C/western-sector-2020-joint-arrangement-cells.geojson'),nationalBoundaryVerification:provenance.nationalBoundaryVerification},
  sourceDecision:pin('reports/chn-2020/source-decision.json'),macroSource:pin('data/raw/chn-2020/references/gb3-CHN-ADM1.geojson'),
  geometry:pin(geometryPath),numericExceptions:pin(path.join(path.dirname(geometryPath),'numeric-exceptions.json').replaceAll('\\','/')),
  codeArtifacts,residualLedger,residualGainLedger:pin(geometryPath),sourceTrace:result.sourceTrace,
  method:'Replace only active CHN cells. Preserve all other IDs, records, macro and seed lineage. GEOS common offline source/residual/baseline-neighbor partition; boundaries and adjacency from these exact fills. Source-free gameplay gains are separately contact-ledgered, not administrative facts.',
  geometryAdjusted:true,rawSourceArtifactGeometryUnmodified:true,administrativeTruthClaim:false,
  evidence:result.evidence};
const summary={countryId:'CHN',cells:result.cells.length,fineCells:result.cells.length-residualLedger.length,coarseResidualCells:residualLedger.length,
  sourceFeatures:sourceIds.size,confirmedMacroFamilies:hierarchy.assignments.length,unconfirmedMacroFamilies:hierarchy.unresolved.length,
  sourceVintage:'Metadata 2017 with source processing in 2021; not certified exact 2020'};
const bundle={schemaVersion:'prompt19-joined-world-input-v1',features:features.sort((a,b)=>a.id.localeCompare(b.id)),records:records.sort((a,b)=>a.id.localeCompare(b.id)),
  edges:edges.sort((a,b)=>a.id.localeCompare(b.id)),parents:{...baseline.parents,administrative,previous},regionNames,
  report:{...baseline.report,invalid:[],unresolved:[],incremental,
    summary:[...baseline.report.summary.filter(s=>s.countryId!=='CHN'),summary],
    sourceLockArtifacts:[...baseline.report.sourceLockArtifacts,{countryId:'CHN',...result.sourceLock}],
    hierarchyArtifacts:[...baseline.report.hierarchyArtifacts,{countryId:'CHN',...pin(hierarchyPath)}],
    topology:{pass:true,method:'Same offline common polygon partition generates CHN fills, country/coast/macro edges and neighboring collinear nodes; independent acceptance required before packaging.',edges:edges.length}}};
const key=digest(jsonBytes(bundle)).slice(0,20),root=`data/derived/chn-2020/candidate-${key}`;
const out=immutable(`${root}/joined-world-input.json`,bundle);
immutable(`${root}/cells.geojson`,{type:'FeatureCollection',features:bundle.features.filter(f=>nextRecords.get(f.id).countryId==='CHN')});
immutable(`${root}/numeric-exceptions.json`,result.numericExceptions);
if(arg('--replay-output',null))immutable(arg('--replay-output'),bundle);
console.log(JSON.stringify({output:out,root,summary,counts:{cells:records.length,edges:edges.length},geometry:incremental.geometry}));
